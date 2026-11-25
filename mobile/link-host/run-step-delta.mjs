import { isDeepStrictEqual } from "node:util";
import { lightPart } from "./parts.mjs";

// A baseline comes only from the JSON that this device is already allowed to receive,
// including the person's role and the requested light-step projection.
function rowsById(values) {
  if (!Array.isArray(values)) return null;
  const rows = new Map();
  for (const row of values) {
    if (!row || typeof row.id !== "string" || !row.id || rows.has(row.id)) return null;
    rows.set(row.id, row);
  }
  return rows;
}

function runStepBaseline(run) {
  if (run?.status !== "Working" || typeof run.id !== "string") return null;
  const { steps, ...metadata } = run;
  const rows = rowsById(steps);
  return rows && { id: run.id, metadata, rows };
}

/** Keep the existing order on regular appends and edits. Send explicit order only for insertions or moves. */
function rowsDelta(previous, next) {
  const set = [];
  const removed = [];
  const resultingOrder = [];
  for (const id of previous.keys()) {
    if (next.has(id)) resultingOrder.push(id);
    else removed.push(id);
  }
  for (const [id, row] of next) {
    if (!isDeepStrictEqual(previous.get(id), row)) set.push(row);
    if (!previous.has(id)) resultingOrder.push(id);
  }
  const order = [...next.keys()];
  const reordered = order.some((id, index) => resultingOrder[index] !== id);
  return {
    ...(set.length && { set }),
    ...(removed.length && { remove: removed }),
    ...(reordered && { order }),
  };
}

function runStepDelta(previous, next, base) {
  if (!previous || !next || previous.id !== next.id) return null;
  return {
    patch: "steps", base, run: next.id,
    ...(!isDeepStrictEqual(previous.metadata, next.metadata) && { metadata: next.metadata }),
    ...rowsDelta(previous.rows, next.rows),
  };
}

function runSummaryDelta(previous, next, base) {
  return previous && next && { patch: "summaries", base, ...rowsDelta(previous, next) };
}

/** All caches belong to one authorized, versioned part. Sessions remember only the snapshot sent
 * to them. Two phones with the same view and base share the decoded projection and the wire patch. */
export function runRowsFor(part, summaries, previous, acknowledged) {
  if (!part.rowDelivery) {
    let value;
    if (summaries) value = JSON.parse(part.json);
    else if (part.light !== undefined) value = JSON.parse(part.light);
    else {
      value = lightPart(JSON.parse(part.json));
      part.light = JSON.stringify(value);
    }
    const baseline = summaries ? rowsById(value) : runStepBaseline(value);
    part.rowDelivery = {
      full: summaries ? part.json : part.light,
      snapshot: baseline && { version: part.v, baseline },
      patches: new WeakMap(),
    };
  }
  const { full, snapshot, patches } = part.rowDelivery;
  if (!snapshot || !previous || previous.version !== acknowledged) return { json: full, snapshot };
  let json = patches.get(previous);
  if (json === undefined) {
    const delta = summaries ? runSummaryDelta(previous.baseline, snapshot.baseline, acknowledged)
      : runStepDelta(previous.baseline, snapshot.baseline, acknowledged);
    const patch = delta && JSON.stringify(delta);
    json = patch && Buffer.byteLength(patch) < Buffer.byteLength(full) ? patch : full;
    patches.set(previous, json);
  }
  return { json, snapshot };
}
