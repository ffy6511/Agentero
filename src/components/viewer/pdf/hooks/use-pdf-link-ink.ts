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

function inkSignature(ink: ReadonlyMap<string, string>): string {
	const parts: string[] = [];
	for (const [key, color] of ink) parts.push(`${key}=${color}`);
	parts.sort();
	return parts.join("\n");
}

export function usePdfLinkInk({
	engine,
	docCapRef,
	docId,
	itemsByPage,
	citationLinks,
	textLinks,
}: UsePdfLinkInkOptions): ReadonlyMap<string, string> {
	const [ink, setInk] = useState(() => new Map<string, string>());
	const runsCacheRef = useRef(new Map<string, InkRun[]>());
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
				setInk(new Map());
			}
			return;
		}
		const doc = docCapRef.current?.getDocument(docId);
		if (!doc) return;

		let cancelled = false;
		void (async () => {
			const runsByPage = new Map<number, InkRun[]>();
			for (const pageIndex of pageIndexes) {
				if (cancelled) return;
				const cacheKey = `${docId}:${pageIndex}`;
				const cached = runsCacheRef.current.get(cacheKey);
				if (cached) {
					runsByPage.set(pageIndex, cached);
					continue;
				}
				const page = doc.pages[pageIndex];
				if (!page) continue;
				let runs: InkRun[] = [];
				try {
					const pageRuns = await engine.getPageTextRuns(doc, page).toPromise();
					runs = (pageRuns?.runs ?? []).map((run) => ({
						rect: run.rect,
						color: run.color,
					}));
				} catch {
					runs = [];
				}
				if (cancelled) return;
				runsCacheRef.current.set(cacheKey, runs);
				runsByPage.set(pageIndex, runs);
			}
			if (cancelled) return;
			const next = new Map<string, string>();
			for (const pageIndex of pageIndexes) {
				const runs = runsByPage.get(pageIndex);
				if (!runs) continue;
				for (const [key, color] of inkForTargets(
					runs,
					targetsOnPage(pageIndex, citationLinks, textLinks),
				)) {
					next.set(key, color);
				}
			}
			const signature = inkSignature(next);
			if (signature === signatureRef.current) return;
			signatureRef.current = signature;
			setInk(next);
		})();

		return () => {
			cancelled = true;
		};
	}, [citationLinks, docCapRef, docId, engine, pageKey, textLinks]);

	return ink;
}
