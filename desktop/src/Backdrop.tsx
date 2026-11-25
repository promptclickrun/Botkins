import type { BackdropId } from "./types";

/**
 * Fixed, non-interactive backdrop layer rendered behind the main app shell whenever
 * the chosen Appearance backdrop is not `"clean"`.
 */
export function BackdropLayer({ backdrop }: { backdrop: BackdropId }) {
  if (backdrop === "clean") return null;
  return (
    <div className={"backdrop-layer backdrop-" + backdrop} aria-hidden="true">
      {backdrop === "mesh" && (
        <>
          <span className="bd-blob bd-mesh-red" />
          <span className="bd-blob bd-mesh-blue" />
          <span className="bd-blob bd-mesh-green" />
          <span className="bd-sheen" />
        </>
      )}
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
          <i className="bp-sheen" />
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
