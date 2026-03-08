let exportInProgress = false;

chrome.runtime.onMessage.addListener((message) => {
	if (message?.type === "ARENA_EXPORT_START") {
		void runExport();
	}
});

function delay(ms) {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function sanitizeFileName(value) {
	return (
		String(value || "")
			.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
			.trim()
			.slice(0, 120) || "arena-dialog"
	);
}

function getConversationIdFromUrl() {
	const match = location.pathname.match(/\/c\/([^/]+)/i);
	if (match) {
		return match[1];
	}

	const parts = location.pathname.split("/").filter(Boolean);
	return parts[parts.length - 1] || "arena-dialog";
}

function buildFolderName() {
	return sanitizeFileName(getConversationIdFromUrl());
}

function normalizeMarkdown(text) {
	return `${String(text ?? "")
		.replace(/\r\n/g, "\n")
		.trimEnd()}\n`;
}

function showToast(text) {
	let toast = document.getElementById("__arena_export_toast__");

	if (!toast) {
		toast = document.createElement("div");
		toast.id = "__arena_export_toast__";

		Object.assign(toast.style, {
			position: "fixed",
			right: "16px",
			bottom: "16px",
			zIndex: "2147483647",
			maxWidth: "420px",
			background: "rgba(17, 24, 39, 0.95)",
			color: "#ffffff",
			padding: "10px 14px",
			borderRadius: "10px",
			fontSize: "13px",
			lineHeight: "1.4",
			fontFamily: "system-ui, sans-serif",
			boxShadow: "0 10px 30px rgba(0, 0, 0, 0.25)",
			transition: "opacity 0.2s ease",
			opacity: "0",
			pointerEvents: "none",
		});

		document.documentElement.appendChild(toast);
	}

	toast.textContent = text;
	toast.style.opacity = "1";

	window.clearTimeout(showToast._timer);
	showToast._timer = window.setTimeout(() => {
		toast.style.opacity = "0";
	}, 3000);
}

showToast._timer = 0;

function hasCopyIcon(button) {
	const paths = Array.from(button.querySelectorAll("svg path")).map((node) => node.getAttribute("d") || "");

	const hasFirstPath = paths.some((d) => d.includes("M19.4 20H9.6"));
	const hasSecondPath = paths.some((d) => d.includes("M15 9V4.6"));

	return hasFirstPath && hasSecondPath;
}

function classifyMessageCopyButton(button) {
	if (button.closest("[data-code-block='true']")) {
		return null;
	}

	const classText = button.getAttribute("class") || "";

	const isAssistantButton = button.getAttribute("data-slot") === "tooltip-trigger" && classText.includes("size-3") && hasCopyIcon(button);

	const isUserButton = classText.includes("group-hover:opacity-100") && classText.includes("size-6") && hasCopyIcon(button);

	if (isUserButton) {
		return "user";
	}

	if (isAssistantButton) {
		return "assistant";
	}

	return null;
}

function getMessageCopyButtons() {
	const root = document.querySelector("main") || document.body;
	const buttons = Array.from(root.querySelectorAll("button"));

	return buttons
		.map((button) => ({
			button,
			role: classifyMessageCopyButton(button),
		}))
		.filter((item) => item.role)
		.sort((a, b) => {
			const aRect = a.button.getBoundingClientRect();
			const bRect = b.button.getBoundingClientRect();

			if (Math.abs(aRect.top - bRect.top) > 4) {
				return aRect.top - bRect.top;
			}

			return aRect.left - bRect.left;
		});
}

function getElementCenter(element) {
	const rect = element.getBoundingClientRect();

	if (rect.width <= 0 || rect.height <= 0) {
		throw new Error("Element is not visible");
	}

	return {
		x: rect.left + rect.width / 2,
		y: rect.top + rect.height / 2,
	};
}

async function debuggerStart() {
	const result = await chrome.runtime.sendMessage({
		type: "ARENA_DEBUGGER_START",
	});

	if (!result?.ok) {
		throw new Error(result?.error || "Failed to attach debugger");
	}
}

async function debuggerEnd() {
	try {
		await chrome.runtime.sendMessage({
			type: "ARENA_DEBUGGER_END",
		});
	} catch (_error) {
		// ignore
	}
}

async function trustedMoveToElement(element) {
	const { x, y } = getElementCenter(element);

	const result = await chrome.runtime.sendMessage({
		type: "ARENA_DEBUGGER_TRUSTED_MOVE",
		x,
		y,
	});

	if (!result?.ok) {
		throw new Error(result?.error || "Trusted move failed");
	}
}

async function trustedClickElement(element) {
	const { x, y } = getElementCenter(element);

	const result = await chrome.runtime.sendMessage({
		type: "ARENA_DEBUGGER_TRUSTED_CLICK",
		x,
		y,
	});

	if (!result?.ok) {
		throw new Error(result?.error || "Trusted click failed");
	}
}

async function readClipboardPayload() {
	const result = await chrome.runtime.sendMessage({
		type: "ARENA_CLIPBOARD_READ",
	});

	if (!result?.ok) {
		throw new Error(result?.error || "Clipboard read failed");
	}

	return {
		text: String(result.text || ""),
		mime: String(result.mime || ""),
	};
}

function getSuccessSvg(button) {
	return (
		Array.from(button.querySelectorAll("svg")).find((svg) => {
			const paths = Array.from(svg.querySelectorAll("path"))
				.map((node) => node.getAttribute("d") || "")
				.join(" ");

			return paths.includes("M5 13L9 17L19 7");
		}) || null
	);
}

function isButtonShowingCopiedState(button) {
	const svg = getSuccessSvg(button);
	if (!svg) {
		return false;
	}

	const opacity = Number.parseFloat(getComputedStyle(svg).opacity || "0");
	return opacity > 0.5;
}

async function waitForClipboardAfterClick(previousText, button, timeoutMs = 7000) {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		try {
			const payload = await readClipboardPayload();
			const text = payload.text.trim();

			if (text) {
				if (text !== String(previousText || "").trim()) {
					return payload;
				}

				if (isButtonShowingCopiedState(button)) {
					return payload;
				}
			}
		} catch (_error) {
			// ignore and retry
		}

		await delay(150);
	}

	throw new Error("Clipboard timeout");
}

async function copyMessageFromButton(button, position) {
	let lastError = new Error("Unknown error");

	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			button.scrollIntoView({
				block: "center",
				inline: "nearest",
			});

			await delay(250);

			const hoverTarget = button.closest(".group") || button.parentElement || button;

			await trustedMoveToElement(hoverTarget);
			await delay(180);

			await trustedMoveToElement(button);
			await delay(120);

			let beforeText = "";
			try {
				const before = await readClipboardPayload();
				beforeText = before.text;
			} catch (_error) {
				beforeText = "";
			}

			await trustedClickElement(button);

			const after = await waitForClipboardAfterClick(beforeText, button, 7000);

			if (!after.text.trim()) {
				throw new Error("Empty copied text");
			}

			return after.text;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			await delay(300);
		}
	}

	throw new Error(`Message ${position}: ${lastError.message}`);
}

async function runExport() {
	if (exportInProgress) {
		showToast("Экспорт уже идет");
		return;
	}

	exportInProgress = true;

	try {
		const items = getMessageCopyButtons();
		if (items.length === 0) {
			throw new Error("Не нашел кнопки копирования сообщений");
		}

		showToast(`Найдено ${items.length} сообщений`);

		await debuggerStart();

		const files = [];

		for (let i = 0; i < items.length; i += 1) {
			showToast(`Копирую ${i + 1} / ${items.length}...`);

			const markdown = await copyMessageFromButton(items[i].button, i + 1);
			files.push({
				name: `${i + 1}.md`,
				text: normalizeMarkdown(markdown),
			});
		}

		const result = await chrome.runtime.sendMessage({
			type: "ARENA_EXPORT_DOWNLOAD",
			folderName: buildFolderName(),
			files,
		});

		if (!result?.ok) {
			throw new Error(result?.error || "Не удалось скачать файлы");
		}

		showToast(`Готово: ${files.length} файлов`);
	} catch (error) {
		console.error("[arena-export]", error);
		showToast(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		await debuggerEnd();
		exportInProgress = false;
	}
}
