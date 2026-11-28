// A quiet 3×3 CSS-animated grid of rounded squares that pulses in a diagonal wave on the
// compositor thread, so it keeps moving while React commits deferred content. Shown only after
// `delay` ms (default 120ms) so fast clicks never flash a loader.
import { useEffect, useState, type CSSProperties } from "react";
import "./loading-grid.css";

export const LOADING_GRID_DELAY_MS = 120;

const CELLS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const col = index % 3;
  // Diagonal phase in 0..1 from top-left to bottom-right.
  return { key: index, phase: (row + col) / 5 };
});

export type LoadingGridProps = {
  /** Milliseconds to wait before showing the grid. Set to 0 to show immediately. Defaults to 120ms. */
  delay?: number;
  /** Accessible name for the loading region. Defaults to "Loading". */
  label?: string;
  /** Optional visible caption below the grid. */
  caption?: string;
  /** Tighter vertical padding for side columns / inline sections. */
  compact?: boolean;
  /** Cell size in px (defaults to 7). */
  cellSize?: number;
  /** Gap between cells in px (defaults to 4). */
  gap?: number;
  className?: string;
};

export function LoadingGrid({
  delay = LOADING_GRID_DELAY_MS,
  label = "Loading",
  caption,
  compact,
  cellSize,
  gap,
  className,
}: LoadingGridProps) {
  const [shown, setShown] = useState(delay <= 0);

  useEffect(() => {
    if (delay <= 0) {
      setShown(true);
      return;
    }
    setShown(false);
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);

  if (!shown) return null;

  const gridStyle: CSSProperties | undefined =
    cellSize || gap
      ? ({
          ...(cellSize ? { "--loading-grid-cell": `${cellSize}px` } : {}),
          ...(gap ? { "--loading-grid-gap": `${gap}px` } : {}),
        } as CSSProperties)
      : undefined;

  return (
    <div
      className={"loading-grid-region" + (compact ? " compact" : "") + (className ? " " + className : "")}
      role="status"
      aria-label={label}
      aria-live="polite"
    >
      <div className="loading-grid" aria-hidden="true" style={gridStyle}>
        {CELLS.map((cell) => (
          <span
            key={cell.key}
            className="loading-grid-cell"
            style={{ "--cell-phase": cell.phase } as CSSProperties}
          />
        ))}
      </div>
      {caption && <span className="loading-grid-label">{caption}</span>}
    </div>
  );
}

export default LoadingGrid;
