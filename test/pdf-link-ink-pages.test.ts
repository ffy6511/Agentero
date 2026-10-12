import type { PdfLinkAnnoObject, Rect } from "@embedpdf/models";
import { describe, expect, it } from "vitest";
import {
	mountedLinkPages,
	pagesToSampleInk,
} from "@/components/viewer/pdf/hooks/use-pdf-link-ink";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";

const rect = {} as Rect;

describe("mountedLinkPages", () => {
	it("keeps mounted pages that have a translation block and a link", () => {
		const items = new Map<number, LayoutTranslateItem[]>([
			[0, []],
			[2, []],
			[9, []],
		]);
		const citations = new Map<number, PdfLinkAnnoObject[]>([
			[0, [{ id: "a" } as PdfLinkAnnoObject]],
			[9, [{ id: "b" } as PdfLinkAnnoObject]],
		]);
		const texts = new Map([[2, [{ url: "https://example.com", rect }]]]);
		expect(mountedLinkPages(items, citations, texts, [9, 0, 4, 9])).toEqual([
			9, 0,
		]);
	});
});

describe("pagesToSampleInk", () => {
	it("reads the visible page before a translation block exists", () => {
		const items = new Map<number, LayoutTranslateItem[]>();
		const citations = new Map<number, PdfLinkAnnoObject[]>([
			[1, [{ id: "a" } as PdfLinkAnnoObject]],
		]);
		expect(
			pagesToSampleInk([1], [0, 1, 2], items, citations, new Map()),
		).toEqual([1]);
	});

	it("adds mounted translation pages after the visible page", () => {
		const items = new Map<number, LayoutTranslateItem[]>([
			[1, []],
			[4, []],
		]);
		const citations = new Map<number, PdfLinkAnnoObject[]>([
			[1, [{ id: "a" } as PdfLinkAnnoObject]],
			[4, [{ id: "b" } as PdfLinkAnnoObject]],
		]);
		expect(
			pagesToSampleInk([1], [4, 1, 3], items, citations, new Map()),
		).toEqual([1, 4]);
	});
});
