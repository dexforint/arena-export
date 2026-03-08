(() => {
	if (window.__arenaExportPageBridgeInstalled) {
		return;
	}

	window.__arenaExportPageBridgeInstalled = true;

	function normalizeText(value) {
		return String(value || "")
			.toLowerCase()
			.replace(/\s+/g, " ")
			.replace(/[`*_#>\-\[\]()]/g, " ")
			.trim();
	}

	function looksLikeUtilityClassString(value) {
		const text = String(value || "").trim();

		return text.length > 20 && !text.includes("\n") && /^[a-z0-9:_./[\]()%#-]+(?:\s+[a-z0-9:_./[\]()%#-]+){3,}$/i.test(text);
	}

	function uniqueNonEmpty(parts) {
		const result = [];
		const seen = new Set();

		for (const part of parts) {
			const text = String(part || "").trim();
			if (!text) {
				continue;
			}

			if (seen.has(text)) {
				continue;
			}

			seen.add(text);
			result.push(text);
		}

		return result;
	}

	function joinBlocks(parts) {
		return uniqueNonEmpty(parts)
			.join("\n\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	function escapeInlineCode(text) {
		const value = String(text || "");
		const matches = value.match(/`+/g) || [];
		const longest = matches.reduce((max, item) => Math.max(max, item.length), 0);
		const fence = "`".repeat(Math.max(1, longest + 1));
		return `${fence}${value}${fence}`;
	}

	function normalizeLanguage(value) {
		const raw = String(value || "")
			.trim()
			.toLowerCase();

		const map = {
			javascript: "js",
			js: "js",
			typescript: "ts",
			ts: "ts",
			python: "python",
			py: "py",
			markdown: "markdown",
			md: "md",
			text: "text",
			plaintext: "text",
			txt: "text",
			shell: "bash",
			bash: "bash",
			sh: "bash",
			yml: "yaml",
		};

		return Object.prototype.hasOwnProperty.call(map, raw) ? map[raw] : raw;
	}

	function languageFromClassName(value) {
		const text = String(value || "");
		const match = text.match(/language-([\w#+-]+)/i) || text.match(/lang(?:uage)?-([\w#+-]+)/i);

		return match ? normalizeLanguage(match[1]) : "";
	}

	function isReactElementLike(value) {
		return value && typeof value === "object" && !Array.isArray(value) && "type" in value && "props" in value;
	}

	function extractInlineText(value, depth = 0) {
		if (depth > 14 || value == null) {
			return "";
		}

		if (typeof value === "string" || typeof value === "number") {
			return String(value);
		}

		if (Array.isArray(value)) {
			return value.map((item) => extractInlineText(item, depth + 1)).join("");
		}

		if (isReactElementLike(value)) {
			const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
			const props = value.props || {};

			if (type === "br") {
				return "\n";
			}

			return extractInlineText(props.children, depth + 1);
		}

		if (typeof value === "object") {
			const parts = [];

			if ("children" in value) parts.push(extractInlineText(value.children, depth + 1));
			if ("content" in value) parts.push(extractInlineText(value.content, depth + 1));
			if ("text" in value) parts.push(extractInlineText(value.text, depth + 1));
			if ("value" in value) parts.push(extractInlineText(value.value, depth + 1));

			return parts.join("");
		}

		return "";
	}

	function extractCodeText(value, depth = 0) {
		if (depth > 16 || value == null) {
			return "";
		}

		if (typeof value === "string" || typeof value === "number") {
			return String(value);
		}

		if (Array.isArray(value)) {
			const lineLike = value.filter((item) => {
				if (!isReactElementLike(item)) {
					return false;
				}

				const className = String(item.props?.className || "");
				return /\bline\b/.test(className);
			});

			if (lineLike.length > 0) {
				return value
					.map((item) => {
						if (isReactElementLike(item)) {
							const className = String(item.props?.className || "");
							if (/\bline\b/.test(className)) {
								return extractInlineText(item.props?.children, depth + 1);
							}
						}

						return extractCodeText(item, depth + 1);
					})
					.join("\n");
			}

			return value.map((item) => extractCodeText(item, depth + 1)).join("");
		}

		if (isReactElementLike(value)) {
			const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
			const props = value.props || {};
			const className = String(props.className || "");

			if (type === "br") {
				return "\n";
			}

			if (/\bline\b/.test(className)) {
				return extractInlineText(props.children, depth + 1);
			}

			return extractCodeText(props.children, depth + 1);
		}

		if (typeof value === "object") {
			if ("children" in value) return extractCodeText(value.children, depth + 1);
			if ("content" in value) return extractCodeText(value.content, depth + 1);
			if ("text" in value) return extractCodeText(value.text, depth + 1);
			if ("value" in value) return extractCodeText(value.value, depth + 1);
		}

		return "";
	}

	function serializeReactNode(value, mode = "block", depth = 0) {
		if (depth > 16 || value == null || value === false || value === true) {
			return "";
		}

		if (typeof value === "string" || typeof value === "number") {
			return String(value);
		}

		if (Array.isArray(value)) {
			const rendered = value.map((item) => serializeReactNode(item, mode, depth + 1)).filter(Boolean);

			if (mode === "inline") {
				return rendered.join("");
			}

			return joinBlocks(rendered);
		}

		if (isReactElementLike(value)) {
			const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
			const props = value.props || {};
			const children = props.children;

			if (type === "br") {
				return mode === "inline" ? "\n" : "";
			}

			if (/^h[1-6]$/.test(type)) {
				const level = Number(type.slice(1));
				const text = serializeReactNode(children, "inline", depth + 1).trim();
				return text ? `${"#".repeat(level)} ${text}` : "";
			}

			if (type === "p") {
				return serializeReactNode(children, "inline", depth + 1).trim();
			}

			if (type === "strong" || type === "b") {
				const text = serializeReactNode(children, "inline", depth + 1);
				return text ? `**${text}**` : "";
			}

			if (type === "em" || type === "i") {
				const text = serializeReactNode(children, "inline", depth + 1);
				return text ? `*${text}*` : "";
			}

			if (type === "a") {
				const href = props.href || "";
				const text = serializeReactNode(children, "inline", depth + 1).trim();

				const normalizedHref = href.replace(/\/+$/, "");
				const normalizedText = text.replace(/\/+$/, "");

				if (href && normalizedHref === normalizedText) {
					return href;
				}

				return href ? `[${text}](${href})` : text;
			}

			if (type === "code") {
				const className = props.className || "";
				const lang = languageFromClassName(className);
				const text = extractCodeText(children, depth + 1).replace(/\n+$/, "");

				if (mode === "codeblock") {
					return text;
				}

				if (lang && text.includes("\n")) {
					return `\`\`\`${lang}\n${text}\n\`\`\``;
				}

				return text ? escapeInlineCode(text) : "";
			}

			if (type === "pre") {
				const codeChild = Array.isArray(children) ? children.find((x) => isReactElementLike(x) && String(x.type).toLowerCase() === "code") : children;

				const className = (codeChild && codeChild.props && codeChild.props.className) || props.className || "";

				const lang = languageFromClassName(className);
				const text = extractCodeText(children, depth + 1).replace(/\n+$/, "");

				return text ? `\`\`\`${lang}\n${text}\n\`\`\`` : "";
			}

			if (type === "li") {
				const block = serializeReactNode(children, "block", depth + 1).trim();
				if (!block) {
					return "";
				}

				const lines = block.split("\n");
				if (lines.length === 1) {
					return `- ${lines[0]}`;
				}

				return `- ${lines[0]}\n${lines
					.slice(1)
					.map((line) => `  ${line}`)
					.join("\n")}`;
			}

			if (type === "ul") {
				const items = []
					.concat(children || [])
					.map((item) => serializeReactNode(item, "block", depth + 1))
					.filter(Boolean);

				return items.join("\n");
			}

			if (type === "ol") {
				const array = Array.isArray(children) ? children : [children];
				const items = [];

				for (let i = 0; i < array.length; i += 1) {
					const block = serializeReactNode(array[i], "block", depth + 1).trim();
					if (!block) {
						continue;
					}

					const lines = block.split("\n");
					if (lines.length === 1) {
						items.push(`${i + 1}. ${lines[0]}`);
					} else {
						items.push(
							`${i + 1}. ${lines[0]}\n${lines
								.slice(1)
								.map((line) => `   ${line}`)
								.join("\n")}`,
						);
					}
				}

				return items.join("\n");
			}

			if (type === "blockquote") {
				const text = serializeReactNode(children, "block", depth + 1).trim();
				if (!text) {
					return "";
				}

				return text
					.split("\n")
					.map((line) => (line ? `> ${line}` : ">"))
					.join("\n");
			}

			if (type === "hr") {
				return "---";
			}

			if (type === "div" || type === "section" || type === "article" || type === "main") {
				return serializeReactNode(children, "block", depth + 1);
			}

			return serializeReactNode(children, mode === "inline" ? "inline" : "block", depth + 1);
		}

		if (typeof value === "object") {
			const parts = [];

			if ("children" in value) {
				parts.push(serializeReactNode(value.children, "block", depth + 1));
			}

			if ("props" in value) {
				parts.push(serializeReactNode(value.props, "block", depth + 1));
			}

			if ("content" in value) {
				parts.push(serializeReactNode(value.content, "block", depth + 1));
			}

			if ("markdown" in value) {
				parts.push(serializeReactNode(value.markdown, "block", depth + 1));
			}

			if ("message" in value) {
				parts.push(serializeReactNode(value.message, "block", depth + 1));
			}

			if ("text" in value && typeof value.text === "string") {
				parts.push(value.text);
			}

			if ("value" in value) {
				parts.push(serializeReactNode(value.value, "block", depth + 1));
			}

			if ("prompt" in value) {
				parts.push(serializeReactNode(value.prompt, "block", depth + 1));
			}

			if ("input" in value) {
				parts.push(serializeReactNode(value.input, "block", depth + 1));
			}

			if ("question" in value) {
				parts.push(serializeReactNode(value.question, "block", depth + 1));
			}

			if ("response" in value) {
				parts.push(serializeReactNode(value.response, "block", depth + 1));
			}

			if ("output" in value) {
				parts.push(serializeReactNode(value.output, "block", depth + 1));
			}

			if ("answer" in value) {
				parts.push(serializeReactNode(value.answer, "block", depth + 1));
			}

			if ("raw" in value) {
				parts.push(serializeReactNode(value.raw, "block", depth + 1));
			}

			return joinBlocks(parts);
		}

		return "";
	}

	function scoreCandidate(text, visibleText, path) {
		const raw = String(text || "").trim();
		const pathLower = String(path || "").toLowerCase();
		const norm = normalizeText(raw);
		const target = normalizeText(visibleText);

		let score = 0;

		if (pathLower.endsWith(".children.props")) score += 320;
		if (pathLower.includes(".children.props.content")) score += 360;
		if (pathLower.includes(".props.content")) score += 260;
		if (pathLower.endsWith(".memoizedprops")) score += 40;
		if (pathLower.includes(".content")) score += 120;
		if (pathLower.includes(".markdown")) score += 140;
		if (pathLower.includes(".message")) score += 60;
		if (pathLower.includes(".text")) score += 30;

		if (/\.children\.\[\d+\]\.props/.test(pathLower)) score -= 260;
		if (/\.memoizedprops\.children\.\[\d+\]\.props/.test(pathLower)) score -= 260;
		if (pathLower.includes("classname")) score -= 250;
		if (pathLower.endsWith(".id")) score -= 120;
		if (pathLower.endsWith(".key")) score -= 120;
		if (pathLower.includes("style")) score -= 100;

		if (raw.includes("```")) score += 40;
		if (/^#{1,6}\s/m.test(raw)) score += 20;
		if (/^\s*[-*+]\s/m.test(raw) || /^\s*\d+\.\s/m.test(raw)) score += 20;
		if (/\n\n/.test(raw)) score += 10;

		if (looksLikeUtilityClassString(raw)) score -= 250;

		if (target) {
			if (norm === target) {
				score += 500;
			} else if (norm.includes(target)) {
				score += 350;
			} else if (target.includes(norm)) {
				score += 120;
			}

			const visibleLen = target.length;
			const candLen = norm.length;
			const ratio = visibleLen > 0 ? candLen / visibleLen : 0;

			if (ratio >= 0.9) score += 220;
			else if (ratio >= 0.75) score += 120;
			else if (ratio >= 0.55) score += 40;
			else score -= 220;

			const head = target.slice(0, Math.min(120, target.length));
			const tail = target.slice(-Math.min(120, target.length));

			if (head && norm.includes(head)) score += 100;
			if (tail && norm.includes(tail)) score += 100;

			const targetWords = new Set(target.split(" ").filter(Boolean));
			const candWords = new Set(norm.split(" ").filter(Boolean));
			let overlap = 0;

			for (const word of targetWords) {
				if (candWords.has(word)) {
					overlap += 1;
				}
			}

			score += Math.min(overlap, 120);
		}

		return score;
	}

	function getReactBags(node) {
		const bags = [];

		for (const key of Object.keys(node)) {
			if (key.startsWith("__reactProps$")) {
				bags.push({
					path: key,
					value: node[key],
				});
				continue;
			}

			if (key.startsWith("__reactFiber$")) {
				const fiber = node[key];
				if (fiber && typeof fiber === "object") {
					if (fiber.memoizedProps) {
						bags.push({
							path: `${key}.memoizedProps`,
							value: fiber.memoizedProps,
						});
					}

					if (fiber.pendingProps) {
						bags.push({
							path: `${key}.pendingProps`,
							value: fiber.pendingProps,
						});
					}
				}
			}
		}

		return bags;
	}

	function collectCandidates(rootEl) {
		const visibleText = (rootEl.innerText || rootEl.textContent || "").trim();
		const nodes = [rootEl, ...rootEl.querySelectorAll("*")];
		const candidates = [];
		const seenTexts = new Set();

		function addCandidate(path, text) {
			const value = String(text || "").trim();
			if (value.length < 20) {
				return;
			}

			if (seenTexts.has(value)) {
				return;
			}

			seenTexts.add(value);

			candidates.push({
				path,
				text: value,
				len: value.length,
				score: scoreCandidate(value, visibleText, path),
				preview: value.slice(0, 300),
			});
		}

		for (const node of nodes) {
			for (const bag of getReactBags(node)) {
				const rootSerialized = serializeReactNode(bag.value, "block", 0);
				addCandidate(bag.path, rootSerialized);

				if (bag.value && typeof bag.value === "object") {
					if ("children" in bag.value) {
						addCandidate(`${bag.path}.children`, serializeReactNode(bag.value.children, "block", 0));
					}

					if ("props" in bag.value) {
						addCandidate(`${bag.path}.props`, serializeReactNode(bag.value.props, "block", 0));
					}

					if (bag.value.children && typeof bag.value.children === "object" && "props" in bag.value.children) {
						addCandidate(`${bag.path}.children.props`, serializeReactNode(bag.value.children.props, "block", 0));

						if ("content" in bag.value.children.props) {
							addCandidate(`${bag.path}.children.props.content`, serializeReactNode(bag.value.children.props.content, "block", 0));
						}
					}
				}
			}
		}

		return candidates.sort((a, b) => b.score - a.score || b.len - a.len);
	}

	function extractBest(rootEl) {
		const candidates = collectCandidates(rootEl);
		const best = candidates[0];

		if (!best) {
			return {
				ok: false,
				top: [],
			};
		}

		if (best.score < 40) {
			return {
				ok: false,
				top: candidates.slice(0, 12).map((x) => ({
					path: x.path,
					score: x.score,
					len: x.len,
					preview: x.preview.replace(/\n/g, "\\n"),
				})),
			};
		}

		return {
			ok: true,
			text: best.text,
			path: best.path,
			score: best.score,
		};
	}

	window.addEventListener("message", (event) => {
		if (event.source !== window) {
			return;
		}

		const data = event.data;
		if (!data || data.source !== "arena-export-content" || data.type !== "EXTRACT_REACT_MARKDOWN") {
			return;
		}

		const items = Array.isArray(data.items) ? data.items : [];
		const results = {};

		for (const item of items) {
			const id = String(item?.id || "");
			if (!id) {
				continue;
			}

			const root = document.querySelector(`[data-arena-export-id="${CSS.escape(id)}"]`);
			if (!root) {
				results[id] = {
					ok: false,
					error: "Container not found",
				};
				continue;
			}

			results[id] = extractBest(root);
		}

		window.postMessage(
			{
				source: "arena-export-page",
				type: "EXTRACT_REACT_MARKDOWN_RESULT",
				requestId: data.requestId,
				results,
			},
			"*",
		);
	});
})();
