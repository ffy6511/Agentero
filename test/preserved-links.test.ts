import { describe, expect, it } from "vitest";
import {
	assignmentsWithin,
	assignPreservedLinks,
	claimTranslateLinks,
	type TranslateLinkBox,
} from "@/lib/pdf/layout/translated-links";
import { maskInlineTokens, restoreInlineTokens } from "@/lib/translate/mask";
import { findPreservedLinkSpans } from "@/lib/translate/preserved-links";

describe("findPreservedLinkSpans", () => {
	it("keeps citations, cross-references, urls, and markdown links", () => {
		const text =
			"See [12] and [1, 3] in Fig. 3 and Section 2. Visit https://example.com/a. Also [label](https://example.com/b) and (Smith et al., 2020).";
		const kinds = findPreservedLinkSpans(text).map((span) => span.text);
		expect(kinds).toEqual([
			"[12]",
			"[1, 3]",
			"Fig. 3",
			"Section 2",
			"https://example.com/a",
			"[label](https://example.com/b)",
			"(Smith et al., 2020)",
		]);
	});

	it("does not treat batch markers as citations", () => {
		const spans = findPreservedLinkSpans("[[1]] first [2] [[3]]");
		expect(spans.map((span) => span.text)).toEqual(["[2]"]);
	});
});

describe("inline token masking of links", () => {
	it("restores citations and refs the engine would otherwise rewrite", () => {
		const source =
			"As shown in Fig. 3 and [12], see https://example.com/paper.";
		const masked = maskInlineTokens(source);
		expect(masked.text).not.toContain("Fig. 3");
		expect(masked.text).not.toContain("[12]");
		expect(masked.text).not.toContain("https://");
		expect(masked.text).toContain("⟦");
		const restored = restoreInlineTokens(masked.text, masked.tokens);
		expect(restored.missing).toBe(0);
		expect(restored.text).toBe(source);
	});

	it("leaves [[n]] batch markers intact", () => {
		const masked = maskInlineTokens("[[1]] first [2]\n\n[[3]] second");
		expect(masked.text).toContain("[[1]]");
		expect(masked.text).toContain("[[3]]");
		expect(masked.text).not.toContain("[2]");
	});
});

describe("assignPreservedLinks", () => {
	const block = { x: 0.1, y: 0.2, w: 0.4, h: 0.1 };

	function link(
		key: string,
		x: number,
		kind: TranslateLinkBox["kind"] = "goto",
		url?: string,
	): TranslateLinkBox {
		return {
			key,
			kind,
			url,
			box: { x, y: 0.22, w: 0.04, h: 0.02 },
		};
	}

	it("gives each link to the block that contains it and pairs tokens in order", () => {
		const items = [
			{ id: "a", bbox: block, readingOrder: 0 },
			{ id: "b", bbox: { x: 0.55, y: 0.2, w: 0.3, h: 0.1 }, readingOrder: 1 },
		];
		const claimed = claimTranslateLinks(items, [
			link("cite", 0.12),
			link("fig", 0.2),
			link("other", 0.6),
			link("url", 0.3, "url", "https://example.com/a"),
		]);
		expect(claimed.get("a")?.map((item) => item.key)).toEqual([
			"cite",
			"fig",
			"url",
		]);
		expect(claimed.get("b")?.map((item) => item.key)).toEqual(["other"]);
		const text = "See [12] and Fig. 3 at https://example.com/a.";
		const assigned = assignPreservedLinks(text, claimed.get("a") ?? []);
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["[12]", "cite"],
			["Fig. 3", "fig"],
			["https://example.com/a", "url"],
		]);
		const fig = assigned[1];
		if (!fig) throw new Error("missing fig assignment");
		expect(assignmentsWithin(assigned, fig.start, fig.end)).toEqual([
			{ ...fig, start: 0, end: fig.text.length },
		]);
	});

	it("opens a markdown link from its own url", () => {
		const text = "Read [paper](https://example.com/p).";
		const link = "[paper](https://example.com/p)";
		const start = text.indexOf(link);
		const assigned = assignPreservedLinks(text, []);
		expect(assigned).toEqual([
			{
				start,
				end: start + link.length,
				text: link,
				key: null,
				url: "https://example.com/p",
			},
		]);
	});
});
