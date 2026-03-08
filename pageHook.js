(() => {
	if (window.__arenaExportNetworkHookInstalled) {
		return;
	}

	window.__arenaExportNetworkHookInstalled = true;

	const captured = [];
	const MAX_CAPTURED = 200;

	function remember(entry) {
		captured.push(entry);

		if (captured.length > MAX_CAPTURED) {
			captured.shift();
		}

		window.postMessage(
			{
				source: "arena-export",
				type: "network-payload",
				payload: entry,
			},
			"*",
		);
	}

	function captureJsonText(source, url, text) {
		if (typeof text !== "string" || !text.trim()) {
			return;
		}

		try {
			const json = JSON.parse(text);

			remember({
				source,
				url: String(url || location.href),
				at: Date.now(),
				json,
			});
		} catch (_error) {
			// ignore non-JSON responses
		}
	}

	try {
		if (typeof window.fetch === "function") {
			const originalFetch = window.fetch;

			window.fetch = async function (...args) {
				const response = await originalFetch.apply(this, args);

				try {
					const url = response.url || (typeof args[0] === "string" ? args[0] : args[0]?.url) || location.href;

					const contentType = response.headers.get("content-type") || "";
					if (contentType.includes("json")) {
						response
							.clone()
							.text()
							.then((text) => captureJsonText("fetch", url, text))
							.catch(() => {});
					}
				} catch (_error) {
					// ignore
				}

				return response;
			};
		}
	} catch (_error) {
		// ignore
	}

	try {
		const originalOpen = XMLHttpRequest.prototype.open;
		const originalSend = XMLHttpRequest.prototype.send;

		XMLHttpRequest.prototype.open = function (method, url, ...rest) {
			this.__arenaExportUrl = url;
			return originalOpen.call(this, method, url, ...rest);
		};

		XMLHttpRequest.prototype.send = function (...args) {
			this.addEventListener(
				"load",
				function () {
					try {
						const contentType = this.getResponseHeader("content-type") || "";
						if (!contentType.includes("json")) {
							return;
						}

						const url = this.responseURL || this.__arenaExportUrl || location.href;
						const text = typeof this.responseText === "string" ? this.responseText : "";

						captureJsonText("xhr", url, text);
					} catch (_error) {
						// ignore
					}
				},
				{ once: true },
			);

			return originalSend.apply(this, args);
		};
	} catch (_error) {
		// ignore
	}

	window.addEventListener("message", (event) => {
		if (event.source !== window) {
			return;
		}

		const data = event.data;
		if (!data || data.source !== "arena-export") {
			return;
		}

		if (data.type === "dump-request") {
			window.postMessage(
				{
					source: "arena-export",
					type: "dump-response",
					payloads: captured.slice(),
				},
				"*",
			);
		}
	});
})();
