import { describe, expect, it } from "vitest";
import {
	type InkRun,
	inkForRect,
	isChromaticInk,
	type LinkInkTarget,
	linkColorOnPaper,
} from "@/lib/pdf/layout/link-ink";

function rect(
	x: number,
	y: number,
	width: number,
	height: number,
): InkRun["rect"] {
	return { origin: { x, y }, size: { width, height } };
}

function run(
	x: number,
	y: number,
	width: number,
	height: number,
	red: number,
	green: number,
	blue: number,
): InkRun {
	return {
		rect: rect(x, y, width, height),
		color: { red, green, blue, alpha: 255 },
	};
}

const cite = run(233, 427, 11, 16, 0, 163, 227);
const link: LinkInkTarget = {
	key: "cite",
	rect: rect(231.99, 431.6, 13.07, 9.14),
	strokeColor: "#00ff00",
	strokeWidth: 0,
};

describe("inkForRect", () => {
	it("uses the chromatic glyph on the link, not the invisible border color", () => {
		const body = run(200, 420, 80, 20, 0, 0, 0);
		expect(inkForRect([body, cite], link)).toBe("#00a3e3");
	});

	it("ignores near-black chart ink and a colored neighbor outside the link", () => {
		const chart = run(233, 427, 11, 16, 17, 24, 39);
		const neighbor = run(400, 500, 20, 10, 255, 0, 0);
		expect(inkForRect([chart, neighbor], link)).toBeNull();
		expect(isChromaticInk(17, 24, 39)).toBe(false);
	});

	it("falls back to a visible border when the glyphs are body ink", () => {
		const body = run(233, 427, 11, 16, 0, 0, 0);
		expect(
			inkForRect([body], {
				...link,
				strokeColor: "#0000EE",
				strokeWidth: 2,
			}),
		).toBe("#0000ee");
	});

	it("does not invent a color from a zero-width border", () => {
		expect(inkForRect([], link)).toBeNull();
	});
});

describe("linkColorOnPaper", () => {
	it("keeps the PDF fill on white paper", () => {
		expect(linkColorOnPaper("#00a3e3", "white")).toBe("#00a3e3");
	});

	it("multiplies sepia and green the same way the raster tint does", () => {
		expect(linkColorOnPaper("#00a3e3", "sepia")).toBe("#009fc6");
		expect(linkColorOnPaper("#00a3e3", "green")).toBe("#0097b6");
	});

	it("applies the dark raster filter so the translation matches inverted glyphs", () => {
		expect(linkColorOnPaper("#00a3e3", "dark")).toBe("#2b8fb6");
		expect(linkColorOnPaper("#000000", "dark")).toBe("#cecece");
	});
});
