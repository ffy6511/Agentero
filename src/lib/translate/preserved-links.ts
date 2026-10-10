/**
 * Citation, cross-reference, and link tokens that machine translation drops
 * or rewrites. Callers mask them before the request and, after restore, use
 * the same spans to put click targets back on the translated text.
 */

export type PreservedLinkKind = "markdown" | "url" | "citation" | "ref";

export type PreservedLinkSpan = {
	kind: PreservedLinkKind;
	start: number;
	end: number;
	text: string;
	/** Markdown or bare URL target. Citation and ref spans leave this empty. */
	url?: string;
};

const MARKDOWN_LINK = /\[([^\]\n]{1,240})\]\((https?:\/\/[^\s)]+)\)/gi;
const URL_LINK = /https?:\/\/[^\s、，。<>\]]+/gi;
const CITATION_LINK =
	/[[［][0-9]+[a-z]?(?:\s*[-–—~,，]\s*[0-9]+[a-z]?)*[\]］]/gi;
const REF_LINK =
	/\b(?:Figures?|Figs?\.|Tables?|Tabs?\.|Sections?|Secs?\.|Equations?|Eqs?\.|Eqn?\.|Algorithms?|Algs?\.|Theorems?|Lemmas?|Appendices|Appendix)\s+\(?\d+(?:\.\d+)?[a-z]?(?:\s*[-–—]\s*\(?\d+(?:\.\d+)?[a-z]?)?\)?/gi;
const AUTHOR_TAIL =
	"(?:\\s+et\\s+al\\.?|\\s+(?:and|&)\\s+[A-Z][A-Za-z'’-]{1,40})?";
const AUTHOR_YEAR = new RegExp(
	`\\([A-Z][A-Za-z'’-]{1,40}${AUTHOR_TAIL},\\s*\\d{4}[a-z]?(?:\\s*;\\s*[A-Z][A-Za-z'’-]{1,40}${AUTHOR_TAIL},\\s*\\d{4}[a-z]?)*\\)`,
	"g",
);

function isBatchMarker(text: string, start: number, end: number): boolean {
	return text[start - 1] === "[" && text[end] === "]";
}

function pushMatches(
	text: string,
	pattern: RegExp,
	kind: PreservedLinkKind,
	spans: PreservedLinkSpan[],
	accept?: (match: RegExpMatchArray) => PreservedLinkSpan | null,
): void {
	const flags = pattern.flags.includes("g")
		? pattern.flags
		: `${pattern.flags}g`;
	const re = new RegExp(pattern.source, flags);
	for (const match of text.matchAll(re)) {
		const start = match.index ?? 0;
		const span = accept
			? accept(match)
			: { kind, start, end: start + match[0].length, text: match[0] };
		if (!span || span.end <= span.start) continue;
		if (kind === "citation" && isBatchMarker(text, span.start, span.end)) {
			continue;
		}
		spans.push(span);
	}
}

/**
 * Non-overlapping link-like spans in reading order. Longer matches win when
 * two patterns cover the same characters, so a Markdown link is not also
 * reported as a bare URL.
 */
export function findPreservedLinkSpans(text: string): PreservedLinkSpan[] {
	if (!text) return [];
	const found: PreservedLinkSpan[] = [];
	pushMatches(text, MARKDOWN_LINK, "markdown", found, (match) => {
		const start = match.index ?? 0;
		const url = match[2]?.replace(/[.,;:!?]+$/, "");
		if (!url) return null;
		return {
			kind: "markdown",
			start,
			end: start + match[0].length,
			text: match[0],
			url,
		};
	});
	pushMatches(text, URL_LINK, "url", found, (match) => {
		const start = match.index ?? 0;
		const raw = match[0];
		const trimmed = raw.replace(/[.,;:!?)]+$/, "");
		if (!trimmed) return null;
		return {
			kind: "url",
			start,
			end: start + trimmed.length,
			text: trimmed,
			url: trimmed,
		};
	});
	pushMatches(text, CITATION_LINK, "citation", found);
	pushMatches(text, REF_LINK, "ref", found);
	pushMatches(text, AUTHOR_YEAR, "citation", found);
	found.sort((a, b) => a.start - b.start || b.end - a.end);
	const kept: PreservedLinkSpan[] = [];
	let cursor = 0;
	for (const span of found) {
		if (span.start < cursor) continue;
		kept.push(span);
		cursor = span.end;
	}
	return kept;
}
