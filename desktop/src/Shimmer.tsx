// A soft band of ink that sweeps across a muted line while the bot is on it, the way T3 Code marks
// the live row of a turn (ActivityShimmerOverlay in apps/web/src/components/chat/TimelineRowParts.tsx).
//
// How it stays cheap: the line is drawn twice. The second copy is in full ink, inside a window
// with soft edges (a mask) that slides across with `transform` only, and the copy inside slides
// back the same distance, so its text stays exactly over the first. Nothing is laid out or painted
// again per frame. The sweep moves in 30 steps per 2.2 s (about 14 frames a second, not 60), and
// `observeVisibleAnimation` pauses it whenever the line is off screen, the window is hidden or the
// person asked for less motion. With less motion the line is simply drawn in ink (canvas.css).
import type { ReactNode } from "react";
import { observeVisibleAnimation } from "./visibleAnimation";

/** `children`: the line. `on`: the bot is on it now. `className`: the host's own layout. */
export function Shimmer({ on, className, children }: { on: boolean; className?: string; children: ReactNode }) {
  return (
    <span className={"shimmer-host" + (on ? " shimmering" : "") + (className ? " " + className : "")} ref={on ? observeVisibleAnimation : undefined}>
      {children}
      {on && (
        <span className="live-shimmer" aria-hidden="true">
          <span className="live-shimmer-counter">
            <span className={"live-shimmer-copy" + (className ? " " + className : "")}>{children}</span>
          </span>
        </span>
      )}
    </span>
  );
}
