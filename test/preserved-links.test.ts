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

	it("keeps spaced PDF cites and translated author-year forms", () => {
		const text =
			"See ( Jimenez et al. , 2024 ; Merrill et al. , 2026 ) and （Jimenez et al.，2024 ;梅里尔et al.，2026） and （Pan等人，2024 ; Jain等人，2025）.";
		expect(findPreservedLinkSpans(text).map((span) => span.text)).toEqual([
			"( Jimenez et al. , 2024 ; Merrill et al. , 2026 )",
			"（Jimenez et al.，2024 ;梅里尔et al.，2026）",
			"（Pan等人，2024 ; Jain等人，2025）",
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

	it("splits a bracket group into one target per adjacent link", () => {
		const near = (key: string, x: number): TranslateLinkBox => ({
			key,
			kind: "goto",
			box: { x, y: 0.51, w: 0.022, h: 0.011 },
			color: key === "n38" ? "#ed028c" : "#00a3e3",
		});
		const text = "环境 [17,38]。随后 [46]。";
		const assigned = assignPreservedLinks(text, [
			near("n17", 0.39),
			near("n38", 0.418),
			near("n46", 0.7),
		]);
		expect(assigned.map((item) => [item.text, item.key, item.color])).toEqual([
			["17", "n17", "#00a3e3"],
			["38", "n38", "#ed028c"],
			["[46]", "n46", "#00a3e3"],
		]);
	});

	it("splits a bracket group when the same rect is listed many times", () => {
		const camel: TranslateLinkBox = {
			key: "n17",
			kind: "goto",
			box: { x: 0.389715, y: 0.51265, w: 0.021958, h: 0.010851 },
			color: "#00a3e3",
		};
		const autogen: TranslateLinkBox = {
			key: "n38",
			kind: "goto",
			box: { x: 0.418171, y: 0.51265, w: 0.021958, h: 0.010644 },
			color: "#00a3e3",
		};
		const text = "工具交互[17,38]。";
		const assigned = assignPreservedLinks(text, [
			camel,
			{ ...camel, key: "n17-dup" },
			{ ...camel, key: "n17-dup-2" },
			autogen,
			{ ...autogen, key: "n38-dup" },
		]);
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["17", "n17"],
			["38", "n38"],
		]);
	});

	it("keeps one bracket group when the next link is not beside it", () => {
		const text = "见 [17,38]，另见 [46]。";
		const assigned = assignPreservedLinks(text, [
			{
				key: "only",
				kind: "goto",
				box: { x: 0.39, y: 0.51, w: 0.022, h: 0.011 },
			},
			{
				key: "later",
				kind: "goto",
				box: { x: 0.7, y: 0.51, w: 0.022, h: 0.011 },
			},
		]);
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["[17,38]", "only"],
			["[46]", "later"],
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
