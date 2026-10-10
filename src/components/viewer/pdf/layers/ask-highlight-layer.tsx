/**
 * Quick-chat selection. Same yellow as a saved annotation, and it stays after
 * the card closes. Only the open card's boxes accept hover, and only while the
 * translation overlay is hidden, so the highlight can keep that card open
 * without covering translated text or the link hits underneath.
 */

import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import { HIGHLIGHT_HEX, HIGHLIGHT_OPACITY } from "@/lib/pdf/highlight/palette";

export function AskHighlightLayer({
	paints,
	activeId,
	bridgeHover,
	onHoverEnter,
	onHoverLeave,
}: {
	paints: readonly { id: string; rects: readonly PdfAskNormalizedRect[] }[];
	activeId: string | null;
	bridgeHover: boolean;
	onHoverEnter: () => void;
	onHoverLeave: () => void;
}) {
	if (!paints.length) return null;
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-[5]"
			style={{ isolation: "isolate", mixBlendMode: "multiply" }}
		>
			{paints.flatMap((paint) =>
				paint.rects.map((rect) => {
					const bridge = bridgeHover && paint.id === activeId;
					return (
						<div
							key={`${paint.id}:${rect.x}:${rect.y}:${rect.w}:${rect.h}`}
							className={bridge ? "pointer-events-auto" : undefined}
							aria-hidden="true"
							style={{
								position: "absolute",
								left: `${rect.x * 100}%`,
								top: `${rect.y * 100}%`,
								width: `${rect.w * 100}%`,
								height: `${rect.h * 100}%`,
								backgroundColor: HIGHLIGHT_HEX.yellow,
								opacity: HIGHLIGHT_OPACITY,
							}}
							onMouseEnter={bridge ? onHoverEnter : undefined}
							onMouseLeave={bridge ? onHoverLeave : undefined}
						/>
					);
				}),
			)}
		</div>
	);
}
