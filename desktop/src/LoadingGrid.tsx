// A 3×3 Brady Bunch grid of tiny CSS-animated Botkin faces that glance, blink, wink, tilt, and
// bounce on independent rhythms on the compositor thread, so it keeps moving while React commits
// deferred content. Shown only after `delay` ms (default 120ms) so fast clicks never flash a loader.
import { useEffect, useState, type CSSProperties } from "react";
import "./loading-grid.css";

export const LOADING_GRID_DELAY_MS = 120;

const TILES = [
  { key: 0, l: "oval", r: "oval" },
  { key: 1, l: "round", r: "round" },
  { key: 2, l: "oval", r: "oval" },
  { key: 3, l: "oval", r: "oval" },
  { key: 4, l: "oval", r: "oval" },
  { key: 5, l: "oval", r: "oval" },
  { key: 6, l: "arc", r: "arc" },
  { key: 7, l: "round", r: "round" },
  { key: 8, l: "sleepy", r: "sleepy" },
] as const;

export type LoadingGridProps = {
  /** Milliseconds to wait before showing the grid. Set to 0 to show immediately. Defaults to 120ms. */
  delay?: number;
  /** Accessible name for the loading region. Defaults to "Loading". */
  label?: string;
  /** Optional visible caption below the grid. */
  caption?: string;
  /** Tighter vertical padding for side columns / inline sections. */
  compact?: boolean;
  /** Tile size in px (defaults to 15). */
  cellSize?: number;
  /** Gap between tiles in px (defaults to 4). */
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
          ...(cellSize
            ? {
                "--loading-grid-cell": `${cellSize}px`,
                "--loading-grid-radius": `${Math.max(3, +(cellSize * 0.3).toFixed(1))}px`,
              }
            : {}),
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
        {TILES.map((tile) => (
          <span key={tile.key} className="loading-grid-cell" data-i={tile.key}>
            <span className="loading-grid-eyes">
              <span className={"loading-grid-eye l " + tile.l} />
              <span className={"loading-grid-eye r " + tile.r} />
            </span>
          </span>
        ))}
      </div>
      {caption && <span className="loading-grid-label">{caption}</span>}
    </div>
  );
}

export default LoadingGrid;
