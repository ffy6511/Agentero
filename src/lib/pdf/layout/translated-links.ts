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
};

export type PreservedLinkAssignment = {
	start: number;
	end: number;
	text: string;
	/** PDF annotation id, when this span drives an in-document link. */
	key: string | null;
	url?: string;
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
	for (const link of links) {
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

/**
 * Pair preserved tokens in `text` with `links` already claimed by this block.
 * URL tokens match by URL. Citation and ref tokens take the remaining GoTo
 * links in reading order.
 */
export function assignPreservedLinks(
	text: string,
	links: readonly TranslateLinkBox[],
): PreservedLinkAssignment[] {
	const spans = findPreservedLinkSpans(text);
	if (!spans.length || !links.length) {
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
	const gotos = links.filter((link) => link.kind === "goto");
	let gotoIndex = 0;
	const assigned: PreservedLinkAssignment[] = [];
	for (const span of spans) {
		const hit = matchSpan(span, links, gotos, used, gotoIndex);
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
				assignment: {
					start: span.start,
					end: span.end,
					text: span.text,
					key: byUrl.key,
					url: byUrl.url,
				},
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
		assignment: {
			start: span.start,
			end: span.end,
			text: span.text,
			key: goto.key,
		},
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
