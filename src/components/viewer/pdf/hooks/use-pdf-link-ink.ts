/**
 * Raw PDF fill for translated link tokens, plus the glyph runs that split
 * adjacent citations.
 *
 * The visible page is read once while idle, before translation starts, so the
 * overlay can paint link color with the first translated text. Further mounted
 * pages are read only after a translation block exists. Runs stay cached: a new
 * link map does not cancel an in-flight read or sample the page again. The hex
 * stays in PDF space; the overlay applies the paper tone. The dual-pane
 * companion reads the published result instead of sampling the PDF again.
 */

import type { PdfEngine, PdfLinkAnnoObject } from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import type { ScrollScope } from "@embedpdf/plugin-scroll";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { PdfTextLink } from "@/components/viewer/pdf/layers/citation-links";
import { scheduleIdle } from "@/lib/core/idle";
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
 * Pages whose text runs should be read, visible pages first.
 * A visible page is included before any translation block exists, so its fill
 * is cached when the overlay first paints. Other mounted pages wait until they
 * have both a block and a link.
 */
export function pagesToSampleInk(
	visiblePageIndexes: readonly number[],
	mountedPageIndexes: readonly number[],
	itemsByPage: ReadonlyMap<number, readonly LayoutTranslateItem[]>,
	citationLinks: ReadonlyMap<number, readonly PdfLinkAnnoObject[]>,
	textLinks: ReadonlyMap<number, readonly PdfTextLink[]>,
): number[] {
	const pages: number[] = [];
	const seen = new Set<number>();
	for (const pageIndex of visiblePageIndexes) {
		if (seen.has(pageIndex)) continue;
		seen.add(pageIndex);
		pages.push(pageIndex);
	}
	for (const pageIndex of mountedLinkPages(
		itemsByPage,
		citationLinks,
		textLinks,
		mountedPageIndexes,
	)) {
		if (seen.has(pageIndex)) continue;
		seen.add(pageIndex);
		pages.push(pageIndex);
	}
	return pages;
}

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

/** 0-based pages currently in the viewport. `visiblePages` is 1-based. */
function visiblePageIndexes(scope: ScrollScope): number[] {
	return scope.getMetrics().visiblePages.map((page) => page - 1);
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

function pageKeyOf(pages: readonly number[]): string {
	return pages.join(",");
}

function parsePageKey(key: string): number[] {
	return key ? key.split(",").map((value) => Number(value)) : [];
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
	const [cacheEpoch, setCacheEpoch] = useState(0);
	const [scrollPages, setScrollPages] = useState({ visible: "", mounted: "" });
	const runsCacheRef = useRef(new Map<string, CachedPage>());
	const queueRef = useRef<number[]>([]);
	const wantedRef = useRef(new Set<number>());
	const pumpingRef = useRef(false);
	const docIdRef = useRef(docId);
	const engineRef = useRef(engine);
	const aliveRef = useRef(true);
	const immediateRef = useRef(false);
	const idleCancelRef = useRef<(() => void) | null>(null);
	const signatureRef = useRef("");
	const stableRef = useRef(EMPTY_RESULT);
	docIdRef.current = docId;
	engineRef.current = engine;

	const samplePages = pagesToSampleInk(
		parsePageKey(scrollPages.visible),
		parsePageKey(scrollPages.mounted),
		itemsByPage,
		citationLinks,
		textLinks,
	);
	const sampleKey = pageKeyOf(samplePages);
	const immediate = samplePages.some((pageIndex) => itemsByPage.has(pageIndex));
	immediateRef.current = immediate;

	const pumpRef = useRef<(() => void) | null>(null);
	if (pumpRef.current == null) {
		pumpRef.current = () => {
			if (pumpingRef.current) return;
			const engineNow = engineRef.current;
			const docIdNow = docIdRef.current;
			if (!engineNow || !docIdNow) return;
			pumpingRef.current = true;
			void (async () => {
				let blocked = false;
				let readOne = false;
				try {
					while (queueRef.current.length > 0) {
						// Prefetch yields after one page so scrolling does not
						// queue the rest of the buffer behind the raster worker.
						if (readOne && !immediateRef.current) break;
						const pageIndex = queueRef.current.shift();
						if (pageIndex == null) break;
						const activeDocId = docIdRef.current;
						const activeEngine = engineRef.current;
						if (!activeEngine || activeDocId !== docIdNow) break;
						if (!wantedRef.current.has(pageIndex)) continue;
						const cacheKey = `${activeDocId}:${pageIndex}`;
						if (runsCacheRef.current.has(cacheKey)) continue;
						const doc = docCapRef.current?.getDocument(activeDocId);
						if (!doc) {
							queueRef.current.unshift(pageIndex);
							blocked = true;
							break;
						}
						const page = doc.pages[pageIndex];
						let cachedPage: CachedPage = { inkRuns: [], glyphs: [] };
						readOne = true;
						if (page && page.size.width > 0 && page.size.height > 0) {
							try {
								const pageRuns = await activeEngine
									.getPageTextRuns(doc, page)
									.toPromise();
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
						}
						if (docIdRef.current !== activeDocId) continue;
						runsCacheRef.current.set(cacheKey, cachedPage);
						if (aliveRef.current) setCacheEpoch((epoch) => epoch + 1);
					}
				} finally {
					pumpingRef.current = false;
					const pending = queueRef.current.some(
						(pageIndex) =>
							wantedRef.current.has(pageIndex) &&
							!runsCacheRef.current.has(`${docIdRef.current}:${pageIndex}`),
					);
					if (!blocked && pending) {
						if (immediateRef.current) pumpRef.current?.();
						else {
							idleCancelRef.current?.();
							idleCancelRef.current = scheduleIdle(() => {
								idleCancelRef.current = null;
								pumpRef.current?.();
							}, 1500);
						}
					}
				}
			})();
		};
	}

	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);

	useEffect(() => {
		if (!scrollReady || !docId) return;
		const scope = scrollRef.current;
		if (!scope) return;
		const read = () => {
			try {
				const visible = pageKeyOf(visiblePageIndexes(scope));
				const mounted = pageKeyOf(mountedPageIndexes(scope));
				setScrollPages((prev) =>
					prev.visible === visible && prev.mounted === mounted
						? prev
						: { visible, mounted },
				);
			} catch {
				// Metrics throw until this document has a scroll layout.
			}
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
		idleCancelRef.current?.();
		idleCancelRef.current = null;
		const pages = parsePageKey(sampleKey);
		wantedRef.current = new Set(pages);
		const cacheKey = (pageIndex: number) => `${docId}:${pageIndex}`;
		const ready = pages.some((pageIndex) =>
			runsCacheRef.current.has(cacheKey(pageIndex)),
		);
		queueRef.current = pages.filter(
			(pageIndex) => !runsCacheRef.current.has(cacheKey(pageIndex)),
		);
		// A read that finished between unmount and this effect still has to publish.
		if (ready) setCacheEpoch((epoch) => epoch + 1);
		if (!engine || queueRef.current.length === 0) return;
		if (immediate) {
			pumpRef.current?.();
		} else {
			idleCancelRef.current = scheduleIdle(() => {
				idleCancelRef.current = null;
				pumpRef.current?.();
			}, 1500);
		}
		return () => {
			idleCancelRef.current?.();
			idleCancelRef.current = null;
		};
	}, [docId, engine, immediate, sampleKey]);

	return useMemo(() => {
		// `cacheEpoch` is the signal that `runsCacheRef` gained a page.
		void cacheEpoch;
		const ink = new Map<string, string>();
		const glyphsByPage = new Map<number, readonly GlyphRun[]>();
		const cachedPages: number[] = [];
		for (const pageIndex of parsePageKey(sampleKey)) {
			const cached = runsCacheRef.current.get(`${docId}:${pageIndex}`);
			if (!cached) continue;
			cachedPages.push(pageIndex);
			if (cached.glyphs.length > 0) glyphsByPage.set(pageIndex, cached.glyphs);
			for (const [key, color] of inkForTargets(
				cached.inkRuns,
				targetsOnPage(pageIndex, citationLinks, textLinks),
			)) {
				ink.set(key, color);
			}
		}
		const signature = `${docId}\n${inkSignature(ink)}\n${pageKeyOf(cachedPages)}`;
		if (signature === signatureRef.current) return stableRef.current;
		signatureRef.current = signature;
		const next =
			cachedPages.length === 0
				? EMPTY_RESULT
				: { inkByKey: ink, runsByPage: glyphsByPage };
		stableRef.current = next;
		return next;
	}, [cacheEpoch, citationLinks, docId, sampleKey, textLinks]);
}
