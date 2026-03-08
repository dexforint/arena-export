let exportInProgress = false;
let turndownService = null;

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
	return String(text ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\u00A0/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
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
		.map((button, index) => ({
			button,
			role: classifyMessageCopyButton(button),
			domIndex: index,
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

function removeNodes(root, selector) {
	for (const node of root.querySelectorAll(selector)) {
		node.remove();
	}
}

function cleanClonedContainer(root) {
	const clone = root.cloneNode(true);

	removeNodes(
		clone,
		[
			"button",
			"svg",
			"script",
			"style",
			"noscript",
			"textarea",
			"input",
			"select",
			"[role='tooltip']",
			"[data-slot='tooltip-trigger']",
			"[data-slot='tooltip-content']",
		].join(", "),
	);

	for (const el of Array.from(clone.querySelectorAll("*"))) {
		const classText = el.getAttribute("class") || "";
		const ariaHidden = el.getAttribute("aria-hidden");
		const hidden = el.hasAttribute("hidden");

		if (ariaHidden === "true" || hidden) {
			el.remove();
			continue;
		}

		if (/sr-only|screen-reader/i.test(classText)) {
			el.remove();
			continue;
		}

		if (el.tagName === "IMG") {
			el.remove();
			continue;
		}
	}

	return clone;
}

function pickBestContentRoot(root) {
	const selectors = ["[class*='prose']", "[class*='markdown']", "article"];

	let best = null;
	let bestScore = -1;

	for (const selector of selectors) {
		for (const el of root.querySelectorAll(selector)) {
			const textLength = getNodeTextLength(el);
			const copyCount = countMessageCopyButtonsInside(el);

			if (copyCount === 0 && textLength > bestScore) {
				best = el;
				bestScore = textLength;
			}
		}
	}

	return best || root;
}

function serializeSimpleBreakBlock(node) {
	function walk(current) {
		let result = "";

		for (const child of Array.from(current.childNodes)) {
			if (child.nodeType === Node.TEXT_NODE) {
				const text = child.textContent || "";
				if (!text.trim()) {
					continue;
				}
				result += text;
				continue;
			}

			if (child.nodeType === Node.COMMENT_NODE) {
				continue;
			}

			if (child.nodeType !== Node.ELEMENT_NODE) {
				continue;
			}

			if (child.nodeName === "BR") {
				result += "\n";
				continue;
			}

			if (child.nodeName === "A") {
				const href = child.getAttribute("href") || "";
				const text = (child.textContent || "").trim();

				const normalizedHref = href.replace(/\/+$/, "");
				const normalizedText = text.replace(/\/+$/, "");

				if (href && normalizedHref === normalizedText) {
					result += href;
				} else {
					result += text;
				}

				continue;
			}

			if (child.nodeName === "CODE") {
				result += `\`${child.textContent || ""}\``;
				continue;
			}

			result += walk(child);
		}

		return result;
	}

	let text = walk(node)
		.replace(/\n[ \t]+/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{2,}/g, "\n")
		.trim();

	const lines = text.split("\n");
	if (lines.length > 1) {
		const stackLike = lines.slice(1).every((line) => {
			const trimmed = line.trimStart();
			return trimmed === "" || /^at\s+/.test(trimmed) || /^await in\b/.test(trimmed) || /^[A-Za-z_$][\w$]*\s+@ /.test(trimmed);
		});

		if (stackLike) {
			text = lines
				.map((line, index) => {
					if (index === 0) {
						return line.trim();
					}

					const trimmed = line.trim();
					if (!trimmed) {
						return "";
					}

					return /^at\s+/.test(trimmed) ? `    ${trimmed}` : trimmed;
				})
				.join("\n");
		}
	}

	return text;
}

function getTurndownService() {
	if (turndownService) {
		return turndownService;
	}

	if (typeof window.TurndownService !== "function") {
		throw new Error("Turndown is not loaded");
	}

	turndownService = new window.TurndownService({
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		emDelimiter: "*",
		strongDelimiter: "**",
		headingStyle: "atx",
	});

	if (window.turndownPluginGfm?.gfm) {
		turndownService.use(window.turndownPluginGfm.gfm);
	}

	turndownService.addRule("plainUrlLinks", {
		filter(node) {
			return node.nodeName === "A";
		},
		replacement(content, node) {
			const href = node.getAttribute("href") || "";
			const text = String(content || "").trim();

			const normalizedHref = href.replace(/\/+$/, "");
			const normalizedText = text.replace(/\/+$/, "");

			if (href && normalizedHref === normalizedText) {
				return href;
			}

			return href ? `[${content}](${href})` : content;
		},
	});

	turndownService.addRule("hardBreakAsNewline", {
		filter(node) {
			return node.nodeName === "BR";
		},
		replacement() {
			return "\n";
		},
	});

	turndownService.addRule("plainBreakParagraph", {
		filter(node) {
			return (node.nodeName === "P" || node.nodeName === "DIV") && node.querySelector("br") && !node.querySelector("pre, table, ul, ol, blockquote");
		},
		replacement(_content, node) {
			const text = serializeSimpleBreakBlock(node);
			return text ? `\n\n${text}\n\n` : "\n\n";
		},
	});

	turndownService.addRule("removeEmptyWrappers", {
		filter(node) {
			if (node.nodeType !== Node.ELEMENT_NODE) {
				return false;
			}

			if (["BR", "HR"].includes(node.nodeName)) {
				return false;
			}

			const text = String(node.textContent || "").trim();
			const hasStructuredChildren = node.querySelector("pre, code, table, ul, ol, blockquote");

			return !text && !hasStructuredChildren;
		},
		replacement() {
			return "";
		},
	});

	turndownService.addRule("hrAsDashes", {
		filter(node) {
			return node.nodeName === "HR";
		},
		replacement() {
			return "\n\n---\n\n";
		},
	});

	return turndownService;
}

function normalizeLanguageName(value) {
	const raw = String(value || "")
		.trim()
		.toLowerCase();

	const map = {
		plaintext: "text",
		text: "text",
		txt: "text",
		javascript: "javascript",
		js: "js",
		typescript: "typescript",
		ts: "ts",
		jsx: "jsx",
		tsx: "tsx",
		python: "python",
		py: "py",
		shell: "bash",
		bash: "bash",
		sh: "bash",
		zsh: "bash",
		powershell: "powershell",
		ps1: "powershell",
		yml: "yaml",
		yaml: "yaml",
		markdown: "markdown",
		md: "md",
		"c++": "cpp",
		"c#": "csharp",
	};

	return Object.prototype.hasOwnProperty.call(map, raw) ? map[raw] : raw;
}

function looksLikeLanguageLabel(text) {
	return /^(plaintext|text|txt|bash|shell|sh|zsh|powershell|ps1|json|yaml|yml|xml|html|css|scss|javascript|js|typescript|ts|tsx|jsx|python|py|java|c|cpp|c\+\+|c#|go|rust|sql|markdown|md)$/i.test(
		String(text || "").trim(),
	);
}

function getShortText(node) {
	return String(node?.innerText || node?.textContent || "")
		.replace(/\s+/g, " ")
		.trim();
}

function extractLanguageFromAttributes(el) {
	if (!el || el.nodeType !== Node.ELEMENT_NODE) {
		return "";
	}

	const values = [el.getAttribute("data-language"), el.getAttribute("data-lang"), el.getAttribute("lang"), el.getAttribute("class")].filter(Boolean);

	for (const value of values) {
		const text = String(value);
		const classMatch = text.match(/language-([\w#+-]+)/i) || text.match(/lang(?:uage)?-([\w#+-]+)/i);

		if (classMatch) {
			return normalizeLanguageName(classMatch[1]);
		}

		if (looksLikeLanguageLabel(text)) {
			return normalizeLanguageName(text);
		}
	}

	return "";
}

function extractLanguageFromBlock(block) {
	const attrLang =
		extractLanguageFromAttributes(block.querySelector("code")) ||
		extractLanguageFromAttributes(block.querySelector("pre")) ||
		extractLanguageFromAttributes(block);

	if (attrLang) {
		return attrLang;
	}

	const candidates = Array.from(block.querySelectorAll("span, div"));

	for (const el of candidates) {
		if (el.querySelector("pre, code")) {
			continue;
		}

		const text = getShortText(el);
		if (text && text.length <= 24 && looksLikeLanguageLabel(text)) {
			return normalizeLanguageName(text);
		}
	}

	return "";
}

function makeFence(text) {
	const matches = String(text || "").match(/`+/g) || [];
	const longest = matches.reduce((max, item) => Math.max(max, item.length), 0);
	return "`".repeat(Math.max(3, longest + 1));
}

function createSafePlaceholder(index) {
	return `ARENAEXPORTCODEBLOCKTOKEN${index}X${Math.random().toString(36).slice(2)}`;
}

function getCodeBlockEntries(root) {
	const entries = [];
	const seen = new Set();

	for (const block of Array.from(root.querySelectorAll("[data-code-block='true']"))) {
		let replaceNode = block;

		if (block.parentElement?.tagName === "PRE" && block.parentElement.childElementCount === 1) {
			replaceNode = block.parentElement;
		}

		if (seen.has(replaceNode)) {
			continue;
		}

		seen.add(replaceNode);
		entries.push({ block, replaceNode });
	}

	for (const pre of Array.from(root.querySelectorAll("pre"))) {
		if (pre.closest("[data-code-block='true']")) {
			continue;
		}

		const code = pre.querySelector("code");
		if (!code) {
			continue;
		}

		if (seen.has(pre)) {
			continue;
		}

		seen.add(pre);
		entries.push({ block: pre, replaceNode: pre });
	}

	return entries;
}

function protectCodeBlocks(root) {
	const replacements = [];
	const entries = getCodeBlockEntries(root);

	entries.forEach(({ block, replaceNode }, index) => {
		const codeNode = block.querySelector("pre code, code");
		const codeText = String(codeNode?.textContent || "")
			.replace(/\r\n/g, "\n")
			.replace(/\n+$/, "");

		if (!codeText.trim()) {
			return;
		}

		const lang = extractLanguageFromBlock(block);
		const fence = makeFence(codeText);
		const placeholder = createSafePlaceholder(index);

		replaceNode.replaceWith(root.ownerDocument.createTextNode(placeholder));

		replacements.push({
			placeholder,
			markdown: `\n\n${fence}${lang}\n${codeText}\n${fence}\n\n`,
		});
	});

	return replacements;
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function restoreProtectedCodeBlocks(markdown, replacements) {
	let result = String(markdown || "");

	for (const item of replacements) {
		result = result.replace(new RegExp(escapeRegExp(item.placeholder), "g"), () => item.markdown);
	}

	return result;
}

function buildReplacementMap(replacements) {
	const map = new Map();

	for (const item of replacements) {
		map.set(item.placeholder, item.markdown.trim());
	}

	return map;
}

function isWhitespaceTextNode(node) {
	return node && node.nodeType === Node.TEXT_NODE && !String(node.textContent || "").trim();
}

function isBlockElement(node) {
	return (
		node &&
		node.nodeType === Node.ELEMENT_NODE &&
		["P", "DIV", "SECTION", "ARTICLE", "MAIN", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "HR", "TABLE"].includes(node.nodeName)
	);
}

function makeInlineCode(text) {
	const value = String(text || "");
	const matches = value.match(/`+/g) || [];
	const longest = matches.reduce((max, part) => Math.max(max, part.length), 0);
	const fence = "`".repeat(Math.max(1, longest + 1));
	return `${fence}${value}${fence}`;
}

function serializeInlineChildren(node, replacementMap) {
	return Array.from(node.childNodes)
		.map((child) => serializeInlineNode(child, replacementMap))
		.join("");
}

function serializeInlineNode(node, replacementMap) {
	if (!node) {
		return "";
	}

	if (node.nodeType === Node.COMMENT_NODE) {
		return "";
	}

	if (node.nodeType === Node.TEXT_NODE) {
		const text = String(node.textContent || "");
		const trimmed = text.trim();

		if (replacementMap.has(trimmed)) {
			return replacementMap.get(trimmed) || "";
		}

		return text;
	}

	if (node.nodeType !== Node.ELEMENT_NODE) {
		return "";
	}

	const tag = node.nodeName;

	if (tag === "BR") {
		return "\n";
	}

	if (tag === "CODE") {
		return makeInlineCode(node.textContent || "");
	}

	if (tag === "A") {
		const href = node.getAttribute("href") || "";
		const text = serializeInlineChildren(node, replacementMap).trim();

		const normalizedHref = href.replace(/\/+$/, "");
		const normalizedText = text.replace(/\/+$/, "");

		if (href && normalizedHref === normalizedText) {
			return href;
		}

		return href ? `[${text}](${href})` : text;
	}

	if (tag === "STRONG" || tag === "B") {
		return `**${serializeInlineChildren(node, replacementMap)}**`;
	}

	if (tag === "EM" || tag === "I") {
		return `*${serializeInlineChildren(node, replacementMap)}*`;
	}

	if (tag === "DEL" || tag === "S" || tag === "STRIKE") {
		return `~~${serializeInlineChildren(node, replacementMap)}~~`;
	}

	return serializeInlineChildren(node, replacementMap);
}

function indentMarkdown(text, prefix = "    ") {
	return String(text || "")
		.split("\n")
		.map((line) => (line ? prefix + line : line))
		.join("\n");
}

function isMeaningfulNode(node) {
	if (!node) {
		return false;
	}

	if (node.nodeType === Node.COMMENT_NODE) {
		return false;
	}

	if (node.nodeType === Node.TEXT_NODE) {
		return Boolean(String(node.textContent || "").trim());
	}

	return node.nodeType === Node.ELEMENT_NODE;
}

function isBlockLikeNode(node) {
	return (
		node &&
		node.nodeType === Node.ELEMENT_NODE &&
		(["P", "DIV", "PRE", "UL", "OL", "BLOCKQUOTE", "TABLE", "HR"].includes(node.nodeName) || /^H[1-6]$/.test(node.nodeName))
	);
}

function serializeListItem(li, prefix, replacementMap) {
	const nodes = Array.from(li.childNodes).filter(isMeaningfulNode);

	let firstLine = "";
	const tailBlocks = [];
	let inlineBuffer = [];

	function flushInlineBuffer() {
		if (inlineBuffer.length === 0) {
			return;
		}

		const wrapper = document.createElement("span");
		for (const node of inlineBuffer) {
			wrapper.appendChild(node.cloneNode(true));
		}

		const text = serializeInlineChildren(wrapper, replacementMap).replace(/\s+/g, " ").trim();

		if (text) {
			if (!firstLine) {
				firstLine = text;
			} else {
				tailBlocks.push(text);
			}
		}

		inlineBuffer = [];
	}

	for (const node of nodes) {
		if (node.nodeType === Node.TEXT_NODE) {
			inlineBuffer.push(node);
			continue;
		}

		if (!isBlockLikeNode(node)) {
			inlineBuffer.push(node);
			continue;
		}

		flushInlineBuffer();

		const blockMarkdown = serializeBlockNode(node, replacementMap).trim();
		if (!blockMarkdown) {
			continue;
		}

		if (!firstLine) {
			if (node.nodeName === "P" || node.nodeName === "DIV") {
				firstLine = blockMarkdown;
			} else {
				tailBlocks.push(blockMarkdown);
			}
		} else {
			tailBlocks.push(blockMarkdown);
		}
	}

	flushInlineBuffer();

	let result = prefix + firstLine;

	if (tailBlocks.length > 0) {
		if (!firstLine) {
			result = prefix.trimEnd();
		}

		result += "\n" + tailBlocks.map((block) => indentMarkdown(block)).join("\n");
	}

	return result.trimEnd();
}

function serializeListNode(listNode, replacementMap) {
	const ordered = listNode.nodeName === "OL";
	const start = ordered ? Number.parseInt(listNode.getAttribute("start") || "1", 10) || 1 : 1;

	const items = Array.from(listNode.children).filter((el) => el.nodeName === "LI");

	return items
		.map((li, index) => {
			const prefix = ordered ? `${start + index}. ` : "- ";
			return serializeListItem(li, prefix, replacementMap);
		})
		.join("\n");
}

function serializeBlockNode(node, replacementMap) {
	if (!node) {
		return "";
	}

	if (node.nodeType === Node.COMMENT_NODE || isWhitespaceTextNode(node)) {
		return "";
	}

	if (node.nodeType === Node.TEXT_NODE) {
		const text = String(node.textContent || "");
		const trimmed = text.trim();

		if (replacementMap.has(trimmed)) {
			return replacementMap.get(trimmed) || "";
		}

		return trimmed;
	}

	if (node.nodeType !== Node.ELEMENT_NODE) {
		return "";
	}

	const tag = node.nodeName;

	if (tag === "P") {
		if (node.querySelector("br")) {
			return serializeSimpleBreakBlock(node);
		}
		return serializeInlineChildren(node, replacementMap).trim();
	}

	if (/^H[1-6]$/.test(tag)) {
		const level = Number(tag.slice(1));
		return `${"#".repeat(level)} ${serializeInlineChildren(node, replacementMap).trim()}`;
	}

	if (tag === "UL" || tag === "OL") {
		return serializeListNode(node, replacementMap);
	}

	if (tag === "BLOCKQUOTE") {
		const inner = serializeRootBlocks(node, replacementMap);
		return inner
			.split("\n")
			.map((line) => (line ? `> ${line}` : ">"))
			.join("\n");
	}

	if (tag === "HR") {
		return "---";
	}

	if (tag === "TABLE") {
		return getTurndownService().turndown(node).trim();
	}

	if (tag === "DIV" || tag === "SECTION" || tag === "ARTICLE" || tag === "MAIN") {
		const children = Array.from(node.childNodes).filter((child) => !(child.nodeType === Node.COMMENT_NODE || isWhitespaceTextNode(child)));

		const hasBlockChildren = children.some((child) => isBlockElement(child));

		if (hasBlockChildren) {
			return children
				.map((child) => serializeBlockNode(child, replacementMap))
				.filter(Boolean)
				.join("\n\n");
		}

		if (node.querySelector("br")) {
			return serializeSimpleBreakBlock(node);
		}

		return serializeInlineChildren(node, replacementMap).trim();
	}

	return serializeInlineChildren(node, replacementMap).trim();
}

function serializeRootBlocks(root, replacementMap) {
	return Array.from(root.childNodes)
		.map((child) => serializeBlockNode(child, replacementMap))
		.filter(Boolean)
		.join("\n\n");
}

function postProcessMarkdown(text) {
	const lines = String(text || "").split("\n");
	const out = [];
	let inFence = false;

	for (let i = 0; i < lines.length; i += 1) {
		let line = lines[i];

		if (/^\s*```+/.test(line)) {
			inFence = !inFence;
			out.push(line.trimEnd());
			continue;
		}

		if (!inFence) {
			line = line.replace(/^(\s*\d+\.)\s{2,}/, "$1 ");
			line = line.replace(/^(\s*[-+*])\s{2,}/, "$1 ");
			line = line.replace(/^(#+\s+\d+)\\\.(?=\s|$)/, "$1.");
		}

		out.push(line);
	}

	return out
		.join("\n")
		.replace(/:\n\n(?=```)/g, ":\n")
		.replace(/:\n\n(?=(?:- |\d+\. ))/g, ":\n")
		.replace(/\n{3,}/g, "\n\n");
}

function extractMarkdownFromContainer(container) {
	const cleaned = cleanClonedContainer(container);
	const replacements = protectCodeBlocks(cleaned);
	const replacementMap = buildReplacementMap(replacements);
	const contentRoot = pickBestContentRoot(cleaned);

	let markdown = serializeRootBlocks(contentRoot, replacementMap);

	if (!markdown.trim()) {
		const service = getTurndownService();
		markdown = service.turndown(contentRoot);
		markdown = restoreProtectedCodeBlocks(markdown, replacements);
	}

	markdown = postProcessMarkdown(markdown);
	return normalizeMarkdown(markdown);
}

function dedupeMessages(messages) {
	const result = [];

	for (const message of messages) {
		const prev = result[result.length - 1];

		if (prev && prev.role === message.role && prev.text === message.text) {
			continue;
		}

		result.push(message);
	}

	return result;
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

async function runExport() {
	if (exportInProgress) {
		showToast("Экспорт уже идет");
		return;
	}

	exportInProgress = true;

	try {
		await delay(150);

		const buttonItems = getMessageCopyButtons();
		if (buttonItems.length === 0) {
			throw new Error("Не нашел кнопки копирования сообщений");
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
				domIndex: item.domIndex,
			});
		}

		const orderedEntries = sortEntriesByVisualOrder(entries);

		const messages = orderedEntries
			.map((entry) => ({
				role: entry.role,
				text: extractMarkdownFromContainer(entry.root),
			}))
			.filter((item) => item.text);

		const finalMessages = dedupeMessages(messages);

		if (finalMessages.length === 0) {
			throw new Error("Не удалось извлечь сообщения из DOM");
		}

		const files = finalMessages.map((message, index) => ({
			name: `${index + 1}.md`,
			text: `${message.text}\n`,
		}));

		console.log(
			"[arena-export] Extracted messages:",
			finalMessages.map((item, index) => ({
				n: index + 1,
				role: item.role,
				preview: item.text.slice(0, 160),
			})),
		);

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
		exportInProgress = false;
	}
}
