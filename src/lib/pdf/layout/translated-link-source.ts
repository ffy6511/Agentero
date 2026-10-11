/**
 * Link annotations resolved by the source PDF viewer, shared with the
 * dual-pane translation companion. That pane does not mount the annotation
 * plugin, so it cannot rebuild the map itself.
 */

import type { PdfLinkAnnoObject } from "@embedpdf/models";
import type { PdfTextLink } from "@/components/viewer/pdf/layers/citation-links";
import { layoutDocumentKey } from "@/lib/pdf/layout/store";

export type TranslatedLinkSource = {
	citationLinks: ReadonlyMap<number, PdfLinkAnnoObject[]>;
	textLinks: ReadonlyMap<number, PdfTextLink[]>;
};

const EMPTY_PAGE_MAP = new Map();

const EMPTY_SOURCE: TranslatedLinkSource = {
	citationLinks: EMPTY_PAGE_MAP,
	textLinks: EMPTY_PAGE_MAP,
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
