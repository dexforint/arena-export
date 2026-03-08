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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.type !== "ARENA_EXPORT_DOWNLOAD") {
		return;
	}

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
		console.error("[arena-export] Download error:", error);
		sendResponse({
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
	});

	return true;
});
