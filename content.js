let exportInProgress = false;
let requestCounter = 0;
const pendingRequests = new Map();

window.addEventListener("message", (event) => {
	if (event.source !== window) {
		return;
	}

	const data = event.data;
	if (!data || data.source !== "arena-export-page" || data.type !== "EXTRACT_REACT_MARKDOWN_RESULT") {
		return;
	}

	const requestId = data.requestId;
	const pending = pendingRequests.get(requestId);
	if (!pending) {
		return;
	}

	pendingRequests.delete(requestId);
	pending.resolve(data.results || {});
});

chrome.runtime.onMessage.addListener((message) => {
	if (message?.type === "ARENA_EXPORT_START") {
		void runExport();
	}
});

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
		.filter((item) => item.role);
}

function countMessageCopyButtonsInside(root) {
	let count = 0;

	for (const button of root.querySelectorAll("button")) {
		if (classifyMessageCopyButton(button)) {
			count += 1;
		}
	}

	return count;
}

function getNodeTextLength(node) {
	return String(node?.innerText || node?.textContent || "")
		.replace(/\s+/g, " ")
		.trim().length;
}

function findMessageContainer(button) {
	let node = button.parentElement;
	let best = null;

	while (node && node !== document.body && node !== document.documentElement) {
		const copyCount = countMessageCopyButtonsInside(node);
		const textLength = getNodeTextLength(node);

		if (copyCount === 1 && textLength > 0) {
			best = node;
		} else if (copyCount > 1 && best) {
			break;
		}

		node = node.parentElement;
	}

	return best;
}

function compareNodesInDocumentOrder(a, b) {
	if (a === b) {
		return 0;
	}

	const position = a.compareDocumentPosition(b);

	if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
		return -1;
	}

	if (position & Node.DOCUMENT_POSITION_PRECEDING) {
		return 1;
	}

	return 0;
}

function getVisualPosition(node) {
	const rect = node.getBoundingClientRect();

	return {
		top: rect.top + window.scrollY,
		left: rect.left + window.scrollX,
	};
}

function sortEntriesByVisualOrder(entries) {
	return entries.slice().sort((a, b) => {
		const aPos = getVisualPosition(a.root);
		const bPos = getVisualPosition(b.root);

		if (Math.abs(aPos.top - bPos.top) > 4) {
			return aPos.top - bPos.top;
		}

		if (Math.abs(aPos.left - bPos.left) > 4) {
			return aPos.left - bPos.left;
		}

		return compareNodesInDocumentOrder(a.root, b.root);
	});
}

function requestReactMarkdown(items) {
	const requestId = `arena-export-${Date.now()}-${++requestCounter}`;

	return new Promise((resolve, reject) => {
		const timeoutId = window.setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error("Page bridge timeout"));
		}, 5000);

		pendingRequests.set(requestId, {
			resolve: (result) => {
				window.clearTimeout(timeoutId);
				resolve(result);
			},
		});

		window.postMessage(
			{
				source: "arena-export-content",
				type: "EXTRACT_REACT_MARKDOWN",
				requestId,
				items,
			},
			"*",
		);
	});
}

async function runExport() {
	if (exportInProgress) {
		showToast("Export is already underway");
		return;
	}

	exportInProgress = true;

	try {
		const buttonItems = getMessageCopyButtons();
		if (buttonItems.length === 0) {
			throw new Error("Didn't find a copy message button");
		}

		const entries = [];
		const usedRoots = new Set();

		for (const item of buttonItems) {
			const root = findMessageContainer(item.button);

			if (!root || usedRoots.has(root)) {
				continue;
			}

			usedRoots.add(root);

			entries.push({
				root,
				role: item.role,
			});
		}

		const orderedEntries = sortEntriesByVisualOrder(entries);

		if (orderedEntries.length === 0) {
			throw new Error("Could not find message containers");
		}

		const requestItems = orderedEntries.map((entry, index) => {
			const id = `arena-export-msg-${index + 1}`;
			entry.root.setAttribute("data-arena-export-id", id);
			return { id };
		});

		showToast(`Exporting ${orderedEntries.length} messages...`);

		const results = await requestReactMarkdown(requestItems);
		const files = [];
		const debugRows = [];

		for (let i = 0; i < orderedEntries.length; i += 1) {
			const id = requestItems[i].id;
			const result = results[id];

			if (!result?.ok || !result.text) {
				console.log("[arena-export] Failed container:", orderedEntries[i].root);
				console.log("[arena-export] Top candidates:", result?.top || result);
				throw new Error(`Didn't find Markdown in React props for message ${i + 1}`);
			}

			files.push({
				name: `${i + 1}.md`,
				text: normalizeMarkdown(result.text),
			});

			debugRows.push({
				n: i + 1,
				role: orderedEntries[i].role,
				score: result.score,
				path: result.path,
				preview: String(result.text).slice(0, 140).replace(/\n/g, "\\n"),
			});
		}

		console.table(debugRows);

		const downloadResult = await chrome.runtime.sendMessage({
			type: "ARENA_EXPORT_DOWNLOAD",
			folderName: buildFolderName(),
			files,
		});

		if (!downloadResult?.ok) {
			throw new Error(downloadResult?.error || "Failed to download files");
		}

		showToast(`Done: ${files.length} files`);
	} catch (error) {
		console.error("[arena-export]", error);
		showToast(`Error: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		for (const node of document.querySelectorAll("[data-arena-export-id]")) {
			node.removeAttribute("data-arena-export-id");
		}

		exportInProgress = false;
	}
}
