import type { PdfLinkAnnoObject, Rect } from "@embedpdf/models";
import { describe, expect, it } from "vitest";
import { mountedLinkPages } from "@/components/viewer/pdf/hooks/use-pdf-link-ink";
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
