/**
 * Raw PDF fill for each link that a translated page still has to paint.
 * Text runs are read once per mounted page and published as each page
 * finishes. The hex stays in PDF space; the overlay applies the paper tone
 * when it draws the token. The dual-pane companion reads the published
 * result instead of sampling the PDF a second time.
 */

import type { PdfEngine, PdfLinkAnnoObject } from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import type { ScrollScope } from "@embedpdf/plugin-scroll";
import { type RefObject, useEffect, useRef, useState } from "react";
import type { PdfTextLink } from "@/components/viewer/pdf/layers/citation-links";
import {
	type InkRun,
	inkForTargets,
	type LinkInkTarget,
	translatedTextLinkKey,
} from "@/lib/pdf/layout/link-ink";
import type { GlyphRun } from "@/lib/pdf/layout/translated-links";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

export type UsePdfLinkInkOptions = {
	engine: PdfEngine | null;
	docCapRef: RefObject<DocumentManagerCapability>;
	docId: string;
	itemsByPage: ReadonlyMap<number, readonly LayoutTranslateItem[]>;
	citationLinks: ReadonlyMap<number, readonly PdfLinkAnnoObject[]>;
	textLinks: ReadonlyMap<number, readonly PdfTextLink[]>;
	/** Source viewer scroll scope. A fresh object each render; read via ref. */
	scrollRef: RefObject<ScrollScope | null>;
	scrollReady: boolean;
};

/**
 * Mounted pages that still have a translation block and at least one link.
 * `mountedPageIndexes` is the scroll buffer (0-based), not every translated
 * page: a full-document job puts a pending item on each page immediately.
 * Order follows `mountedPageIndexes`, with duplicates dropped.
 */
export function mountedLinkPages(
	itemsByPage: ReadonlyMap<number, readonly LayoutTranslateItem[]>,
	citationLinks: ReadonlyMap<number, readonly PdfLinkAnnoObject[]>,
	textLinks: ReadonlyMap<number, readonly PdfTextLink[]>,
	mountedPageIndexes: readonly number[],
): number[] {
	const pages: number[] = [];
	const seen = new Set<number>();
	for (const pageIndex of mountedPageIndexes) {
		if (seen.has(pageIndex) || !itemsByPage.has(pageIndex)) continue;
		const citations = citationLinks.get(pageIndex)?.length ?? 0;
		const texts = textLinks.get(pageIndex)?.length ?? 0;
		if (citations + texts === 0) continue;
		seen.add(pageIndex);
		pages.push(pageIndex);
	}
	return pages;
}

/**
 * PDF page indexes currently mounted by the scroller.
 * `renderedPageIndexes` indexes virtual rows, not pages; a spread row holds
 * two pages. Visible pages come first so the open page is not stuck behind
 * the buffer.
 */
function mountedPageIndexes(scope: ScrollScope): number[] {
	const metrics = scope.getMetrics();
	const layout = scope.getLayout();
	const visible = new Set(metrics.visiblePages.map((page) => page - 1));
	const pages: number[] = [];
	const seen = new Set<number>();
	for (const itemIndex of metrics.renderedPageIndexes) {
		const item = layout.virtualItems[itemIndex];
		if (!item) continue;
		for (const page of item.pageLayouts) {
			if (seen.has(page.pageIndex)) continue;
			seen.add(page.pageIndex);
			pages.push(page.pageIndex);
		}
	}
	pages.sort(
		(a, b) => Number(visible.has(b)) - Number(visible.has(a)) || a - b,
	);
	return pages;
}

function targetsOnPage(
	pageIndex: number,
	citationLinks: ReadonlyMap<number, readonly PdfLinkAnnoObject[]>,
	textLinks: ReadonlyMap<number, readonly PdfTextLink[]>,
): LinkInkTarget[] {
	const targets: LinkInkTarget[] = [];
	for (const link of citationLinks.get(pageIndex) ?? []) {
		targets.push({
			key: link.id,
			rect: link.rect,
			strokeColor: link.strokeColor,
			strokeWidth: link.strokeWidth,
		});
	}
	for (const link of textLinks.get(pageIndex) ?? []) {
		targets.push({
			key: translatedTextLinkKey(link),
			rect: link.rect,
		});
	}
	return targets;
}

type CachedPage = {
	inkRuns: InkRun[];
	glyphs: GlyphRun[];
};

export type PdfLinkInkResult = {
	inkByKey: ReadonlyMap<string, string>;
	runsByPage: ReadonlyMap<number, readonly GlyphRun[]>;
};

const EMPTY_RESULT: PdfLinkInkResult = {
	inkByKey: new Map(),
	runsByPage: new Map(),
};

function inkSignature(ink: ReadonlyMap<string, string>): string {
	const parts: string[] = [];
	for (const [key, color] of ink) parts.push(`${key}=${color}`);
	parts.sort();
	return parts.join("\n");
}

function glyphRunsFrom(
	runs: readonly { text?: string; rect: InkRun["rect"] }[],
	pageWidth: number,
	pageHeight: number,
): GlyphRun[] {
	if (!(pageWidth > 0) || !(pageHeight > 0)) return [];
	const glyphs: GlyphRun[] = [];
	for (const run of runs) {
		const text = run.text ?? "";
		if (!text) continue;
		const w = run.rect.size.width / pageWidth;
		const h = run.rect.size.height / pageHeight;
		if (!(w > 0) || !(h > 0)) continue;
		glyphs.push({
			text,
			box: {
				x: run.rect.origin.x / pageWidth,
				y: run.rect.origin.y / pageHeight,
				w,
				h,
			},
		});
	}
	return glyphs;
}

export function usePdfLinkInk({
	engine,
	docCapRef,
	docId,
	itemsByPage,
	citationLinks,
	textLinks,
	scrollRef,
	scrollReady,
}: UsePdfLinkInkOptions): PdfLinkInkResult {
	const [result, setResult] = useState<PdfLinkInkResult>(EMPTY_RESULT);
	const [mountedKey, setMountedKey] = useState("");
	const runsCacheRef = useRef(new Map<string, CachedPage>());
	const signatureRef = useRef("");
	const pageKey = mountedLinkPages(
		itemsByPage,
		citationLinks,
		textLinks,
		mountedKey ? mountedKey.split(",").map((value) => Number(value)) : [],
	).join(",");

	useEffect(() => {
		if (!scrollReady || !docId) return;
		const scope = scrollRef.current;
		if (!scope) return;
		const read = () => {
			let next = "";
			try {
				next = mountedPageIndexes(scope).join(",");
			} catch {
				// Metrics throw until this document has a scroll layout.
				return;
			}
			setMountedKey((prev) => (prev === next ? prev : next));
		};
		read();
		const offScroll = scope.onScroll(() => read());
		const offLayout = scope.onLayoutChange(() => read());
		return () => {
			offScroll();
			offLayout();
		};
	}, [docId, scrollReady, scrollRef]);

	useEffect(() => {
		const pageIndexes = pageKey
			? pageKey.split(",").map((value) => Number(value))
			: [];
		if (!engine || pageIndexes.length === 0) {
			if (signatureRef.current !== "") {
				signatureRef.current = "";
				setResult(EMPTY_RESULT);
			}
			return;
		}
		const doc = docCapRef.current?.getDocument(docId);
		if (!doc) return;

		let cancelled = false;
		const publish = (
			ink: ReadonlyMap<string, string>,
			glyphsByPage: ReadonlyMap<number, readonly GlyphRun[]>,
		) => {
			if (cancelled) return;
			const signature = `${inkSignature(ink)}\n${pageIndexes.join(",")}`;
			if (signature === signatureRef.current) return;
			signatureRef.current = signature;
			setResult({
				inkByKey: new Map(ink),
				runsByPage: new Map(glyphsByPage),
			});
		};

		void (async () => {
			const ink = new Map<string, string>();
			const glyphsByPage = new Map<number, readonly GlyphRun[]>();
			const pending: number[] = [];
			const absorb = (pageIndex: number, page: CachedPage) => {
				glyphsByPage.set(pageIndex, page.glyphs);
				for (const [key, color] of inkForTargets(
					page.inkRuns,
					targetsOnPage(pageIndex, citationLinks, textLinks),
				)) {
					ink.set(key, color);
				}
			};
			for (const pageIndex of pageIndexes) {
				const cached = runsCacheRef.current.get(`${docId}:${pageIndex}`);
				if (cached) absorb(pageIndex, cached);
				else pending.push(pageIndex);
			}
			publish(ink, glyphsByPage);
			for (const pageIndex of pending) {
				if (cancelled) return;
				const page = doc.pages[pageIndex];
				if (!page || !(page.size.width > 0) || !(page.size.height > 0)) {
					continue;
				}
				let cachedPage: CachedPage = { inkRuns: [], glyphs: [] };
				try {
					const pageRuns = await engine.getPageTextRuns(doc, page).toPromise();
					const raw = pageRuns?.runs ?? [];
					cachedPage = {
						inkRuns: raw.map((run) => ({
							rect: run.rect,
							color: run.color,
						})),
						glyphs: glyphRunsFrom(raw, page.size.width, page.size.height),
					};
				} catch {
					cachedPage = { inkRuns: [], glyphs: [] };
				}
				runsCacheRef.current.set(`${docId}:${pageIndex}`, cachedPage);
				if (cancelled) return;
				absorb(pageIndex, cachedPage);
				publish(ink, glyphsByPage);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [citationLinks, docCapRef, docId, engine, pageKey, textLinks]);

	return result;
}
