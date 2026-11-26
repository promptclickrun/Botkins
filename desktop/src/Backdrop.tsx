import { useCallback, useState } from "react";
import { Hazeglow, type GradientConfig } from "hazeglow";
import type { BackdropId } from "./types";

/**
 * Hazeglow mesh config matching the approved grainy mesh backdrop.
 * Colors reference CSS custom properties defined on `.backdrop-mesh` in `glisse.css`,
 * so Hazeglow's `<html style/data-theme>` observer automatically re-renders on theme/mode switches.
 * `motion: "none"` avoids continuous 60fps WebGL + `backdrop-filter` recompositing while idle.
 */
const MESH_CONFIG: GradientConfig = {
  version: 1,
  seed: 7,
  shape: "mesh",
  center: [0.5, 0.5],
  size: [1, 1],
  roundness: 1,
  softness: 0.9,
  rotation: 0,
  rampDirection: 0,
  angle: 90,
  warp: 0.08,
  warpScale: 1,
  palette: ["#ff3b30", "#007aff", "#34c759"],
  background: "var(--canvas, #ffffff)",
  mesh: [
    [0.12, 0.1, "var(--bd-mesh-red, #ff3b30)"],
    [0.92, 0.5, "var(--bd-mesh-blue, #007aff)"],
    [0.34, 0.95, "var(--bd-mesh-green, #34c759)"],
    [0.62, 0.12, "var(--canvas, #ffffff)"],
    [0.05, 0.6, "var(--canvas, #ffffff)"],
    [0.95, 0.95, "var(--canvas, #ffffff)"],
    [0.55, 0.55, "var(--bd-mesh-mid, #f5f5f5)"],
  ],
  grain: 0.14,
  motion: "none",
  speed: 0,
  loop: 0,
  hover: 0,
  hoverMode: "pull",
  effect: "none",
  effectSize: 8,
  effectAmount: 0,
};

/**
 * Fixed, non-interactive backdrop layer rendered behind the main app shell whenever
 * the chosen Appearance backdrop is not `"clean"`.
 */
export function BackdropLayer({ backdrop }: { backdrop: BackdropId }) {
  const [meshFallback, setMeshFallback] = useState(false);
  const handleUnsupported = useCallback(() => setMeshFallback(true), []);

  if (backdrop === "clean") return null;
  return (
    <div className={"backdrop-layer backdrop-" + backdrop} aria-hidden="true">
      {backdrop === "mesh" &&
        (meshFallback ? (
          <>
            <span className="bd-blob bd-mesh-red" />
            <span className="bd-blob bd-mesh-blue" />
            <span className="bd-blob bd-mesh-green" />
          </>
        ) : (
          <Hazeglow config={MESH_CONFIG} onUnsupported={handleUnsupported} />
        ))}
      {backdrop === "botkins" && (
        <>
          <span className="bd-blob bd-botkins-indigo" />
          <span className="bd-blob bd-botkins-pink" />
          <span className="bd-blob bd-botkins-teal" />
        </>
      )}
      {backdrop === "grid" && <span className="bd-grid-pattern" />}
    </div>
  );
}

/** Miniature visual preview used in Settings › Appearance › Backdrop cards. */
export function BackdropPreview({ id }: { id: BackdropId }) {
  return (
    <span className={"backdrop-wire backdrop-preview-" + id} aria-hidden="true">
      {id === "mesh" && (
        <>
          <i className="bp-blob bp-mesh-red" />
          <i className="bp-blob bp-mesh-blue" />
          <i className="bp-blob bp-mesh-green" />
          <i className="bp-grain" />
        </>
      )}
      {id === "botkins" && (
        <>
          <i className="bp-blob bp-botkins-indigo" />
          <i className="bp-blob bp-botkins-pink" />
          <i className="bp-blob bp-botkins-teal" />
        </>
      )}
      {id === "grid" && <i className="bp-grid" />}
      <i className="bp-glass-pill" />
    </span>
  );
}
