/**
 * Raw PDF fill for each link that a translated page still has to paint.
 * Text runs are read once per page. The hex stays in PDF space; the overlay
 * applies the paper tone when it draws the token.
 */

import type { PdfEngine, PdfLinkAnnoObject } from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
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
};

function pagesToSample(
	itemsByPage: ReadonlyMap<number, readonly LayoutTranslateItem[]>,
	citationLinks: ReadonlyMap<number, readonly PdfLinkAnnoObject[]>,
	textLinks: ReadonlyMap<number, readonly PdfTextLink[]>,
): number[] {
	const pages: number[] = [];
	for (const pageIndex of itemsByPage.keys()) {
		const citations = citationLinks.get(pageIndex)?.length ?? 0;
		const texts = textLinks.get(pageIndex)?.length ?? 0;
		if (citations + texts === 0) continue;
		pages.push(pageIndex);
	}
	pages.sort((a, b) => a - b);
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
}: UsePdfLinkInkOptions): PdfLinkInkResult {
	const [result, setResult] = useState<PdfLinkInkResult>(EMPTY_RESULT);
	const runsCacheRef = useRef(new Map<string, CachedPage>());
	const signatureRef = useRef("");
	const pageKey = pagesToSample(itemsByPage, citationLinks, textLinks).join(
		",",
	);

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
		void (async () => {
			const runsByPage = new Map<number, CachedPage>();
			for (const pageIndex of pageIndexes) {
				if (cancelled) return;
				const cacheKey = `${docId}:${pageIndex}`;
				const cached = runsCacheRef.current.get(cacheKey);
				if (cached) {
					runsByPage.set(pageIndex, cached);
					continue;
				}
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
				if (cancelled) return;
				runsCacheRef.current.set(cacheKey, cachedPage);
				runsByPage.set(pageIndex, cachedPage);
			}
			if (cancelled) return;
			const next = new Map<string, string>();
			const glyphsByPage = new Map<number, readonly GlyphRun[]>();
			for (const pageIndex of pageIndexes) {
				const page = runsByPage.get(pageIndex);
				if (!page) continue;
				glyphsByPage.set(pageIndex, page.glyphs);
				for (const [key, color] of inkForTargets(
					page.inkRuns,
					targetsOnPage(pageIndex, citationLinks, textLinks),
				)) {
					next.set(key, color);
				}
			}
			const signature = `${inkSignature(next)}\n${pageIndexes.join(",")}`;
			if (signature === signatureRef.current) return;
			signatureRef.current = signature;
			setResult({ inkByKey: next, runsByPage: glyphsByPage });
		})();

		return () => {
			cancelled = true;
		};
	}, [citationLinks, docCapRef, docId, engine, pageKey, textLinks]);

	return result;
}
