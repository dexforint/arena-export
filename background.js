const DEBUGGER_VERSION = "1.3";
const OFFSCREEN_URL = "offscreen.html";
const attachedTabs = new Set();
let creatingOffscreen = null;

chrome.debugger.onDetach.addListener((source) => {
	if (source?.tabId != null) {
		attachedTabs.delete(source.tabId);
	}
});

chrome.action.onClicked.addListener(async (tab) => {
	if (!tab?.id || !tab.url) {
		return;
	}

	if (!/^https:\/\/([^/]+\.)?arena\.ai\//.test(tab.url)) {
		console.warn("[arena-export] Open an arena.ai dialog page first.");
		return;
	}

	try {
		await chrome.tabs.sendMessage(tab.id, {
			type: "ARENA_EXPORT_START",
		});
	} catch (error) {
		console.error("[arena-export] Failed to start export:", error);
	}
});

function sanitizeFileName(value) {
	return (
		String(value || "")
			.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
			.trim()
			.slice(0, 120) || "arena-export"
	);
}

function makeDataUrl(text) {
	return `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`;
}

async function ensureDebuggerAttached(tabId) {
	if (attachedTabs.has(tabId)) {
		return;
	}

	await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
	attachedTabs.add(tabId);
}

async function detachDebugger(tabId) {
	if (!attachedTabs.has(tabId)) {
		return;
	}

	try {
		await chrome.debugger.detach({ tabId });
	} catch (_error) {
		// ignore
	} finally {
		attachedTabs.delete(tabId);
	}
}

async function trustedMove(tabId, x, y) {
	await ensureDebuggerAttached(tabId);

	await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x,
		y,
		button: "none",
		buttons: 0,
		pointerType: "mouse",
	});
}

async function trustedClick(tabId, x, y) {
	await ensureDebuggerAttached(tabId);

	const target = { tabId };

	await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x,
		y,
		button: "none",
		buttons: 0,
		pointerType: "mouse",
	});

	await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
		type: "mousePressed",
		x,
		y,
		button: "left",
		buttons: 1,
		clickCount: 1,
		pointerType: "mouse",
	});

	await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x,
		y,
		button: "left",
		buttons: 0,
		clickCount: 1,
		pointerType: "mouse",
	});
}

async function hasOffscreenDocument() {
	const url = chrome.runtime.getURL(OFFSCREEN_URL);

	if (chrome.runtime.getContexts) {
		const contexts = await chrome.runtime.getContexts({
			contextTypes: ["OFFSCREEN_DOCUMENT"],
			documentUrls: [url],
		});

		return contexts.length > 0;
	}

	return false;
}

async function ensureOffscreenDocument() {
	if (await hasOffscreenDocument()) {
		return;
	}

	if (creatingOffscreen) {
		await creatingOffscreen;
		return;
	}

	creatingOffscreen = chrome.offscreen.createDocument({
		url: OFFSCREEN_URL,
		reasons: ["CLIPBOARD"],
		justification: "Read clipboard after trusted copy click on arena.ai",
	});

	try {
		await creatingOffscreen;
	} finally {
		creatingOffscreen = null;
	}
}

async function readClipboardFromOffscreen() {
	await ensureOffscreenDocument();

	const response = await chrome.runtime.sendMessage({
		type: "OFFSCREEN_READ_CLIPBOARD",
	});

	if (!response?.ok) {
		throw new Error(response?.error || "Failed to read clipboard");
	}

	return {
		text: String(response.text || ""),
		mime: String(response.mime || ""),
	};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	const tabId = sender.tab?.id;

	if (message?.type === "ARENA_DEBUGGER_START") {
		(async () => {
			if (!tabId) {
				throw new Error("No sender tab");
			}

			await ensureDebuggerAttached(tabId);
			sendResponse({ ok: true });
		})().catch((error) => {
			sendResponse({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return true;
	}

	if (message?.type === "ARENA_DEBUGGER_END") {
		(async () => {
			if (tabId) {
				await detachDebugger(tabId);
			}

			sendResponse({ ok: true });
		})().catch((error) => {
			sendResponse({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return true;
	}

	if (message?.type === "ARENA_DEBUGGER_TRUSTED_MOVE") {
		(async () => {
			if (!tabId) {
				throw new Error("No sender tab");
			}

			await trustedMove(tabId, Number(message.x), Number(message.y));
			sendResponse({ ok: true });
		})().catch((error) => {
			sendResponse({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return true;
	}

	if (message?.type === "ARENA_DEBUGGER_TRUSTED_CLICK") {
		(async () => {
			if (!tabId) {
				throw new Error("No sender tab");
			}

			await trustedClick(tabId, Number(message.x), Number(message.y));
			sendResponse({ ok: true });
		})().catch((error) => {
			sendResponse({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return true;
	}

	if (message?.type === "ARENA_CLIPBOARD_READ") {
		(async () => {
			if (!tabId) {
				throw new Error("No sender tab");
			}

			const payload = await readClipboardFromTab(tabId);

			sendResponse({
				ok: true,
				text: payload.text,
				mime: payload.mime,
			});
		})().catch((error) => {
			sendResponse({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		});

		return true;
	}

	if (message?.type === "ARENA_EXPORT_DOWNLOAD") {
		(async () => {
			const folderName = sanitizeFileName(message.folderName || "arena-export");
			const files = Array.isArray(message.files) ? message.files : [];

			for (const file of files) {
				const fileName = sanitizeFileName(file.name || "file.md");
				const text = String(file.text ?? "").replace(/\r\n/g, "\n");

				await chrome.downloads.download({
					url: makeDataUrl(text),
					filename: `${folderName}/${fileName}`,
					saveAs: false,
					conflictAction: "uniquify",
				});
			}

			sendResponse({ ok: true, count: files.length });
		})().catch((error) => {
			sendResponse({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return true;
	}
});

async function readClipboardFromTab(tabId) {
	await ensureDebuggerAttached(tabId);

	const target = { tabId };

	await chrome.debugger.sendCommand(target, "Page.bringToFront");

	const expression = `
    (async () => {
      try {
        window.focus();
        document.documentElement?.focus?.();
        document.body?.focus?.();
      } catch (_error) {
        // ignore
      }

      const preferredTypes = [
        "text/markdown",
        "text/x-markdown",
        "text/plain",
        "text/html"
      ];

      if (navigator.clipboard && typeof navigator.clipboard.read === "function") {
        try {
          const items = await navigator.clipboard.read();

          for (const preferredType of preferredTypes) {
            for (const item of items) {
              if (!item.types.includes(preferredType)) {
                continue;
              }

              const blob = await item.getType(preferredType);
              const text = await blob.text();

              return {
                ok: true,
                text,
                mime: preferredType
              };
            }
          }

          for (const item of items) {
            for (const type of item.types) {
              if (!String(type).toLowerCase().startsWith("text/")) {
                continue;
              }

              const blob = await item.getType(type);
              const text = await blob.text();

              return {
                ok: true,
                text,
                mime: type
              };
            }
          }
        } catch (_error) {
          // fallback below
        }
      }

      if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
        const text = await navigator.clipboard.readText();
        return {
          ok: true,
          text,
          mime: "text/plain"
        };
      }

      return {
        ok: false,
        error: "Clipboard API is unavailable"
      };
    })();
  `;

	const result = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
		userGesture: true,
	});

	if (result?.exceptionDetails) {
		throw new Error(result.exceptionDetails.text || "Clipboard evaluate failed");
	}

	const value = result?.result?.value;
	if (!value?.ok) {
		throw new Error(value?.error || "Clipboard read failed");
	}

	return {
		text: String(value.text || ""),
		mime: String(value.mime || ""),
	};
}
