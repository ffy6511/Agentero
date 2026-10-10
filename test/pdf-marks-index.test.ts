import { describe, expect, it } from "vitest";

import { keepUnsavedVisualDrafts } from "@/components/viewer/pdf/hooks/use-pdf-marks-io";
import {
	askHighlightRects,
	buildMarksIndex,
	commentForVisibleTranslation,
	selectionPinForVisibleTranslation,
} from "@/components/viewer/pdf/marks-index";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";

function visualTrace(opts: {
	id: string;
	page: number;
	y: number;
	comment?: string;
	hasAgent?: boolean;
}): PdfVisualSessionTrace {
	return {
		version: 2,
		kind: "visual",
		id: opts.id,
		paperPath: "papers/test",
		page: opts.page,
		rects: [{ x: 0.1, y: opts.y, width: 0.2, height: 0.05 }],
		comment: opts.comment ?? "region note",
		image: { data: "base64", mimeType: "image/png" },
		...(opts.hasAgent
			? {
					agent: {
						agentId: "test-agent",
						runtimeSessionId: "rt-1",
						messageId: "msg-1",
						status: "completed" as const,
						messages: [
							{
								id: "m1",
								role: "user" as const,
								content: "explain",
								createdAt: "2026-09-02T00:00:00Z",
							},
						],
					},
				}
			: {}),
		createdAt: "2026-09-02T00:00:00Z",
		updatedAt: "2026-09-02T00:00:00Z",
	};
}

describe("keepUnsavedVisualDrafts", () => {
	it("keeps an in-memory crop that disk refresh has not written yet", () => {
		const draft = visualTrace({ id: "draft", page: 1, y: 0.2, comment: "" });
		const saved = visualTrace({ id: "saved", page: 1, y: 0.5 });
		expect(keepUnsavedVisualDrafts([draft], [saved])).toEqual([draft, saved]);
	});

	it("does not resurrect a draft that disk already has", () => {
		const draft = visualTrace({ id: "draft", page: 1, y: 0.2, comment: "" });
		const fromDisk = visualTrace({
			id: "draft",
			page: 1,
			y: 0.2,
			comment: "kept",
		});
		expect(keepUnsavedVisualDrafts([draft], [fromDisk])).toEqual([fromDisk]);
	});
});

describe("buildMarksIndex", () => {
	it("anchors a translation note to the translated boxes only while translation is showing", () => {
		const saved: PdfHighlight = {
			version: 1,
			kind: "highlight",
			id: "h1",
			paperPath: "papers/test",
			createdAt: "2026-09-30T00:00:00Z",
			updatedAt: "2026-09-30T00:00:00Z",
			page: 1,
			rects: [{ x: 0.1, y: 0.5, w: 0.4, h: 0.08 }],
			quote: "Our work has three contributions.",
			comment: "note",
			translatedRects: [{ x: 0.2, y: 0.3, w: 0.15, h: 0.02 }],
		};
		const index = buildMarksIndex({
			highlights: [saved],
			highlightAnchors: new Map([["h1", { x: 0.1, y: 0.5, w: 0.4, h: 0.08 }]]),
			askPinAnchors: [],
			translates: [],
			visualTraces: [],
			pageTextMap: new Map(),
			paperTitle: undefined,
		});
		const comment = index.commentsByPage.get(1)?.[0];
		if (!comment) throw new Error("missing comment");
		expect(comment.rects[0]?.y).toBe(0.5);
		expect(comment.translatedRects).toEqual([
			{ x: 0.2, y: 0.3, w: 0.15, h: 0.02 },
		]);
		const shown = commentForVisibleTranslation(comment, true);
		expect(shown.anchorY).toBe(0.3);
		expect(shown.rects).toEqual(comment.translatedRects);
		expect(commentForVisibleTranslation(comment, false).anchorY).toBe(0.5);
	});

	it("paints an ask selection from translated boxes and shifts the pin beside them", () => {
		const index = buildMarksIndex({
			highlights: [],
			highlightAnchors: new Map(),
			askPinAnchors: [
				{
					id: "ask-1",
					page: 1,
					rects: [{ x: 0.1, y: 0.5, w: 0.4, h: 0.04 }],
					translatedRects: [{ x: 0.2, y: 0.22, w: 0.3, h: 0.03 }],
					preview: "why",
					ended: false,
				},
			],
			translates: [],
			visualTraces: [],
			pageTextMap: new Map(),
			paperTitle: undefined,
		});
		const pin = index.pinsByPage.get(1)?.[0];
		if (!pin) throw new Error("missing pin");
		expect(pin.kind).toBe("ask");
		expect(askHighlightRects(pin, false)).toEqual(pin.rects);
		expect(askHighlightRects(pin, true)).toEqual(pin.translatedRects);
		const shown = selectionPinForVisibleTranslation(pin, true);
		expect(shown.y).toBe(0.22);
		expect(shown.x).toBe(pin.x);
		expect(selectionPinForVisibleTranslation(pin, false)).toBe(pin);
	});

	it("omits an uncommented crop until a note is saved", () => {
		const index = buildMarksIndex({
			highlights: [],
			highlightAnchors: new Map(),
			askPinAnchors: [],
			translates: [],
			visualTraces: [visualTrace({ id: "crop", page: 1, y: 0.4, comment: "" })],
			pageTextMap: new Map(),
			paperTitle: undefined,
		});
		expect(index.commentsByPage.get(1) ?? []).toHaveLength(0);
		expect(index.pinsByPage.get(1) ?? []).toHaveLength(0);
	});

	it("omits messages for visual comments without an agent conversation", () => {
		const index = buildMarksIndex({
			highlights: [],
			highlightAnchors: new Map(),
			askPinAnchors: [],
			translates: [],
			visualTraces: [visualTrace({ id: "v1", page: 1, y: 0.4 })],
			pageTextMap: new Map(),
			paperTitle: undefined,
		});
		const comments = index.commentsByPage.get(1) ?? [];
		expect(comments).toHaveLength(1);
		expect(comments[0]?.kind).toBe("visual");
		expect(comments[0]?.messages).toBeUndefined();
	});

	it("includes conversation messages for visual comments with an agent conversation", () => {
		const index = buildMarksIndex({
			highlights: [],
			highlightAnchors: new Map(),
			askPinAnchors: [],
			translates: [],
			visualTraces: [
				visualTrace({ id: "v1", page: 1, y: 0.4, hasAgent: true }),
			],
			pageTextMap: new Map(),
			paperTitle: undefined,
		});
		const comments = index.commentsByPage.get(1) ?? [];
		expect(comments).toHaveLength(1);
		expect(comments[0]?.kind).toBe("visual");
		expect(comments[0]?.messages).toHaveLength(1);
		expect(comments[0]?.messages?.[0]?.role).toBe("user");
		expect(comments[0]?.messages?.[0]?.content).toBe("explain");
	});

	it("skips the comment card for agent-only marks without a comment", () => {
		const index = buildMarksIndex({
			highlights: [],
			highlightAnchors: new Map(),
			askPinAnchors: [],
			translates: [],
			visualTraces: [
				visualTrace({
					id: "v1",
					page: 1,
					y: 0.4,
					comment: "",
					hasAgent: true,
				}),
			],
			pageTextMap: new Map(),
			paperTitle: undefined,
		});
		expect(index.commentsByPage.get(1) ?? []).toHaveLength(0);
		const pins = index.pinsByPage.get(1) ?? [];
		expect(pins).toHaveLength(1);
		expect(pins[0]?.kind).toBe("visual");
	});

	it("keeps a gutter pin for visual marks that have an agent conversation", () => {
		const index = buildMarksIndex({
			highlights: [],
			highlightAnchors: new Map(),
			askPinAnchors: [],
			translates: [],
			visualTraces: [
				visualTrace({ id: "v1", page: 1, y: 0.4, hasAgent: true }),
			],
			pageTextMap: new Map(),
			paperTitle: undefined,
		});
		const pins = index.pinsByPage.get(1) ?? [];
		expect(pins).toHaveLength(1);
		expect(pins[0]?.kind).toBe("visual");
	});
});
