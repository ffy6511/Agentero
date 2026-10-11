/**
 * Re-attach PDF link annotations to preserved tokens inside a translated block.
 *
 * English link rectangles stay under the translation glyphs so they do not
 * block selection. The tokens themselves (`[12]`, `Fig. 3`, a URL) are the
 * hit targets, matched in reading order to the links that overlap the block.
 */

import {
	findPreservedLinkSpans,
	type PreservedLinkSpan,
} from "@/lib/translate/preserved-links";

export type NormBox = {
	x: number;
	y: number;
	w: number;
	h: number;
};

export type TranslateLinkBox = {
	key: string;
	kind: "goto" | "url";
	box: NormBox;
	url?: string;
	/** Raw PDF fill `#rrggbb`. Omitted when the link has no chromatic ink. */
	color?: string;
};

export type PreservedLinkAssignment = {
	start: number;
	end: number;
	text: string;
	/** PDF annotation id, when this span drives an in-document link. */
	key: string | null;
	url?: string;
	/** Raw PDF fill `#rrggbb`, before paper-tone adjustment. */
	color?: string;
};

type LinkHost = {
	id: string;
	bbox: NormBox;
	readingOrder: number;
};

function contains(box: NormBox, x: number, y: number): boolean {
	return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

function intersectionArea(a: NormBox, b: NormBox): number {
	const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
	if (w <= 0 || h <= 0) return 0;
	return w * h;
}

function byReading(a: TranslateLinkBox, b: TranslateLinkBox): number {
	return a.box.y - b.box.y || a.box.x - b.box.x;
}

/** Same hit rectangle. EmbedPDF can list one PDF link many times. */
function sameRect(a: NormBox, b: NormBox): boolean {
	const close = (left: number, right: number) =>
		Math.abs(left - right) < 0.0005;
	return (
		close(a.x, b.x) && close(a.y, b.y) && close(a.w, b.w) && close(a.h, b.h)
	);
}

/**
 * One entry per rectangle. Repeated copies of the same link sit on top of
 * each other and would break the gap test that separates `[17,38]`.
 */
function dedupeTranslateLinks(
	links: readonly TranslateLinkBox[],
): TranslateLinkBox[] {
	const kept: TranslateLinkBox[] = [];
	for (const link of links) {
		const duplicate = kept.some(
			(prev) =>
				prev.kind === link.kind &&
				(prev.url ?? "") === (link.url ?? "") &&
				sameRect(prev.box, link.box),
		);
		if (!duplicate) kept.push(link);
	}
	return kept;
}

/**
 * Give each link to the translated block that contains its center, else the
 * block with the largest overlap. Each link is claimed once.
 */
export function claimTranslateLinks<T extends LinkHost>(
	items: readonly T[],
	links: readonly TranslateLinkBox[],
): Map<string, TranslateLinkBox[]> {
	const ordered = [...items].sort(
		(a, b) => a.readingOrder - b.readingOrder || a.bbox.y - b.bbox.y,
	);
	const map = new Map<string, TranslateLinkBox[]>();
	for (const item of ordered) map.set(item.id, []);
	for (const link of dedupeTranslateLinks(links)) {
		const cx = link.box.x + link.box.w / 2;
		const cy = link.box.y + link.box.h / 2;
		let host = ordered.find((item) => contains(item.bbox, cx, cy));
		if (!host) {
			let best = 0;
			for (const item of ordered) {
				const area = intersectionArea(item.bbox, link.box);
				if (area > best) {
					best = area;
					host = item;
				}
			}
		}
		if (!host) continue;
		map.get(host.id)?.push(link);
	}
	for (const list of map.values()) list.sort(byReading);
	return map;
}

function urlsMatch(a: string, b: string): boolean {
	const trim = (url: string) => url.replace(/[.,;:!?)]+$/, "").toLowerCase();
	return trim(a) === trim(b);
}

function withLinkColor(
	assignment: PreservedLinkAssignment,
	link: TranslateLinkBox | undefined,
): PreservedLinkAssignment {
	if (!link?.color) return assignment;
	return { ...assignment, color: link.color };
}

type TextPiece = { start: number; end: number; text: string };

/**
 * About 18 pt on an A4 page. Wider than a comma or hyphen inside `[17, 38]`,
 * narrower than the words that separate two citation groups.
 */
const CLUSTER_GAP = 0.03;

function numberPieces(span: PreservedLinkSpan): TextPiece[] {
	const pieces: TextPiece[] = [];
	for (const match of span.text.matchAll(/[0-9]+(?:\.[0-9]+)?[a-z]?/gi)) {
		const rel = match.index ?? 0;
		const text = match[0];
		pieces.push({
			start: span.start + rel,
			end: span.start + rel + text.length,
			text,
		});
	}
	return pieces;
}

function semicolonPieces(span: PreservedLinkSpan): TextPiece[] {
	const pieces: TextPiece[] = [];
	for (const match of span.text.matchAll(/[^;；]+/g)) {
		const raw = match[0];
		const rel = match.index ?? 0;
		let start = span.start + rel;
		let end = start + raw.length;
		let text = raw;
		const lead = text.match(/^[(（\s]+/);
		if (lead?.[0]) {
			start += lead[0].length;
			text = text.slice(lead[0].length);
		}
		const trail = text.match(/[\s)）]+$/);
		if (trail?.[0]) {
			end -= trail[0].length;
			text = text.slice(0, text.length - trail[0].length);
		}
		if (!text) continue;
		pieces.push({ start, end, text });
	}
	return pieces;
}

/**
 * A preserved token can hide several PDF links (`[17,38]`, `Fig. 1-2`,
 * two author-year cites). Each atom is a separate hit target.
 */
function splittablePieces(span: PreservedLinkSpan): TextPiece[] | null {
	if (span.kind === "citation" && /^[[［]/.test(span.text)) {
		const pieces = numberPieces(span);
		return pieces.length >= 2 ? pieces : null;
	}
	if (span.kind === "citation" && /[;；]/.test(span.text)) {
		const pieces = semicolonPieces(span);
		return pieces.length >= 2 ? pieces : null;
	}
	if (span.kind === "ref") {
		const pieces = numberPieces(span);
		return pieces.length >= 2 ? pieces : null;
	}
	return null;
}

function sameLinkCluster(a: TranslateLinkBox, b: TranslateLinkBox): boolean {
	const line = Math.max(a.box.h, b.box.h, 0.004);
	const dy = Math.abs(a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2));
	if (dy > Math.max(line * 0.9, 0.008)) return false;
	const gap = b.box.x - (a.box.x + a.box.w);
	return gap >= -0.008 && gap <= CLUSTER_GAP;
}

function adjacentGotos(
	gotos: readonly TranslateLinkBox[],
	start: number,
	limit: number,
	used: Set<string>,
): TranslateLinkBox[] {
	const first = gotos[start];
	if (!first || used.has(first.key) || limit < 2) return [];
	const group = [first];
	for (
		let index = start + 1;
		index < gotos.length && group.length < limit;
		index++
	) {
		const next = gotos[index];
		const prev = group[group.length - 1];
		if (!next || !prev || used.has(next.key) || !sameLinkCluster(prev, next)) {
			break;
		}
		group.push(next);
	}
	return group;
}

/**
 * Pair preserved tokens in `text` with `links` already claimed by this block.
 * URL tokens match by URL. Citation and ref tokens take the remaining GoTo
 * links in reading order. A bracket group with several numbers takes one
 * adjacent link per number, so `[17,38]` stays two targets.
 */
export function assignPreservedLinks(
	text: string,
	links: readonly TranslateLinkBox[],
): PreservedLinkAssignment[] {
	const unique = dedupeTranslateLinks(links);
	const spans = findPreservedLinkSpans(text);
	if (!spans.length || !unique.length) {
		return spans
			.filter((span) => span.url)
			.map((span) => ({
				start: span.start,
				end: span.end,
				text: span.text,
				key: null,
				url: span.url,
			}));
	}
	const used = new Set<string>();
	const gotos = unique.filter((link) => link.kind === "goto");
	let gotoIndex = 0;
	const assigned: PreservedLinkAssignment[] = [];
	for (const span of spans) {
		const pieces = splittablePieces(span);
		if (pieces) {
			const group = adjacentGotos(gotos, gotoIndex, pieces.length, used);
			if (group.length >= 2) {
				const count = Math.min(group.length, pieces.length);
				for (let index = 0; index < count; index++) {
					const piece = pieces[index];
					const goto = group[index];
					if (!piece || !goto) continue;
					used.add(goto.key);
					assigned.push(
						withLinkColor(
							{
								start: piece.start,
								end: piece.end,
								text: piece.text,
								key: goto.key,
							},
							goto,
						),
					);
				}
				gotoIndex += count;
				continue;
			}
		}
		const hit = matchSpan(span, unique, gotos, used, gotoIndex);
		if (hit.gotoIndex !== gotoIndex) gotoIndex = hit.gotoIndex;
		if (!hit.assignment) continue;
		assigned.push(hit.assignment);
	}
	return assigned;
}

function matchSpan(
	span: PreservedLinkSpan,
	links: readonly TranslateLinkBox[],
	gotos: readonly TranslateLinkBox[],
	used: Set<string>,
	gotoIndex: number,
): { assignment: PreservedLinkAssignment | null; gotoIndex: number } {
	if (span.url) {
		const byUrl = links.find(
			(link) =>
				link.kind === "url" &&
				link.url &&
				!used.has(link.key) &&
				urlsMatch(link.url, span.url ?? ""),
		);
		if (byUrl) {
			used.add(byUrl.key);
			return {
				gotoIndex,
				assignment: withLinkColor(
					{
						start: span.start,
						end: span.end,
						text: span.text,
						key: byUrl.key,
						url: byUrl.url,
					},
					byUrl,
				),
			};
		}
		return {
			gotoIndex,
			assignment: {
				start: span.start,
				end: span.end,
				text: span.text,
				key: null,
				url: span.url,
			},
		};
	}
	const goto = gotos[gotoIndex];
	if (!goto || used.has(goto.key)) {
		return { assignment: null, gotoIndex };
	}
	used.add(goto.key);
	return {
		gotoIndex: gotoIndex + 1,
		assignment: withLinkColor(
			{
				start: span.start,
				end: span.end,
				text: span.text,
				key: goto.key,
			},
			goto,
		),
	};
}

/** Assignments that sit entirely inside `[start, end)`, shifted to that slice. */
export function assignmentsWithin(
	assignments: readonly PreservedLinkAssignment[],
	start: number,
	end: number,
): PreservedLinkAssignment[] {
	const sliced: PreservedLinkAssignment[] = [];
	for (const assignment of assignments) {
		if (assignment.start < start || assignment.end > end) continue;
		sliced.push({
			...assignment,
			start: assignment.start - start,
			end: assignment.end - start,
		});
	}
	return sliced;
}
