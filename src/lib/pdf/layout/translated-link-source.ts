/**
 * Link annotations resolved by the source PDF viewer, shared with the
 * dual-pane translation companion. That pane does not mount the annotation
 * plugin, so it cannot rebuild the map itself.
 */

import type { PdfLinkAnnoObject, Rect } from "@embedpdf/models";
import { layoutDocumentKey } from "@/lib/pdf/layout/store";
import type { GlyphRun } from "@/lib/pdf/layout/translated-links";

/** Bare URL hit box. Same shape as the viewer's text-link rect. */
export type TranslatedTextLink = {
	url: string;
	rect: Rect;
};

/** Lower-left of a page's visible box, in PDF user space. */
export type PageBoxOrigin = { x: number; y: number };

export type TranslatedLinkSource = {
	citationLinks: ReadonlyMap<number, PdfLinkAnnoObject[]>;
	textLinks: ReadonlyMap<number, TranslatedTextLink[]>;
	/** Empty until the source viewer has parsed the page boxes. */
	pageOrigins: readonly PageBoxOrigin[];
	/** Link ink and source glyphs for pages the source viewer has sampled. */
	inkByKey: ReadonlyMap<string, string>;
	glyphRunsByPage: ReadonlyMap<number, readonly GlyphRun[]>;
};

const EMPTY_PAGE_MAP = new Map();
const EMPTY_INK = new Map<string, string>();
const EMPTY_RUNS = new Map<number, readonly GlyphRun[]>();
const EMPTY_ORIGINS: readonly PageBoxOrigin[] = [];

const EMPTY_SOURCE: TranslatedLinkSource = {
	citationLinks: EMPTY_PAGE_MAP,
	textLinks: EMPTY_PAGE_MAP,
	pageOrigins: EMPTY_ORIGINS,
	inkByKey: EMPTY_INK,
	glyphRunsByPage: EMPTY_RUNS,
};

const sources = new Map<string, TranslatedLinkSource>();
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function publishTranslatedLinkSource(
	docId: string,
	source: TranslatedLinkSource,
): void {
	sources.set(layoutDocumentKey(docId), source);
	emit();
}

export function clearTranslatedLinkSource(docId: string): void {
	if (!sources.delete(layoutDocumentKey(docId))) return;
	emit();
}

export function subscribeTranslatedLinkSource(
	listener: () => void,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getTranslatedLinkSource(
	docId: string | null,
): TranslatedLinkSource {
	if (!docId) return EMPTY_SOURCE;
	return sources.get(layoutDocumentKey(docId)) ?? EMPTY_SOURCE;
}
