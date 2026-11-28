// What the app's window is sent when something changed.
//
// While a bot streams, the state changes every few milliseconds, but almost all of it is the live
// reply, its thinking and its steps. Sending the whole state each time (every chat, message and run)
// costs a copy of all of it in both processes and draws the whole page again. So the window gets two
// kinds of message:
//
//   "changed"      the whole state, numbered with `seq`. Sent when anything but the live parts changed,
//                  and always while nothing streams. Every whole state is complete: a window that has
//                  only this one is right.
//   "changed-hot"  only the live parts (HOT_FIELDS, and the steps of the turns that run, only the ones
//                  that changed), numbered with `seq` and `base`, the whole state it applies to.
//                  Reply and thinking text carry a UTF-16 cursor and suffix, or replace from zero. The
//                  window drops one whose `base` is not the whole state it holds (src/hotState.ts), so
//                  an old live part never lands on a newer state; both kinds come over one channel, in
//                  the order sent.
//
// Whether the rest changed is told in two ways: a cheap fingerprint of the state's shape (counts and
// the end of every chat), looked at on each push, and a full comparison of everything but the live
// parts, made now and then (it costs what writing the state does, so it waits longer the bigger the
// state is). The fingerprint catches the changes a person waits for at once, such as a message that
// was added; the comparison catches the rest within a moment.

/** The top-level fields of the state that change with every word of a reply. */
export const HOT_FIELDS = ["streams", "thinking", "intents", "speakers", "steerable", "queued", "requests", "typing"];

const BODY_FIELDS = ["streams", "thinking"];
const OTHER_FIELDS = HOT_FIELDS.filter(name => !BODY_FIELDS.includes(name));
const text = JSON.stringify;
const working = (run) => run.status === "Working";
const streaming = (state) => Object.keys(state.streams ?? {}).length > 0;

function restOf(run) {
  const { steps: _steps, ...rest } = run;
  return rest;
}

/** A short text that changes when the shape of the state does: what exists, and where each chat ends. */
export function shapeOf(state) {
  const runs = state.runs ?? [];
  const parts = [
    Object.keys(state.streams ?? {}).join(","),
    runs.filter(working).map((run) => run.id).join(","),
    runs.length,
    runs[0]?.id,
    state.wiki?.revision,
    state.artifacts?.revision,
    state.providers?.revision,
    state.phones?.revision,
    state.remote?.using?.id,
    state.remote?.using?.state,
    state.remote?.unified,
    state.remote?.settingsHost,
    state.remote?.unifiedHosts?.map((h) => h.id + ":" + h.state).join(","),
    state.remote?.hosts?.length,
    state.adminMode,
  ];
  for (const name of ["bots", "panels", "board", "tasks", "projects", "templates", "mcpServers", "plugins", "sections", "chatSections", "spaces"]) parts.push(state[name]?.length);
  for (const chat of state.chats ?? []) {
    const last = chat.messages?.at(-1);
    parts.push(chat.id, chat.title, chat.archived, chat.count, chat.loaded?.from, chat.loaded?.total, chat.messages?.length, last?.time, last?.text?.length);
  }
  return parts.join("|");
}

/** Everything the live parts are not, as text: the running turns are live, every other run is not. */
export function stillKey(state) {
  const still = { ...state, runs: (state.runs ?? []).filter((run) => !working(run)) };
  for (const name of HOT_FIELDS) delete still[name];
  return text(still);
}

// A step is a flat record, often with several large strings. Keep those immutable values
// so a later in-place edit can be detected without serializing every previous tool result.
// For an unfamiliar, nested step use the original value comparison.
function rememberStep(step) {
  return Object.values(step).some(value => value !== null && typeof value === "object") ? text(step) : { ...step };
}

function sameStep(before, step) {
  if (typeof before === "string") return before === text(step);
  if (!before) return false;
  const keys = Object.keys(step);
  return keys.length === Object.keys(before).length && keys.every(key => Object.hasOwn(before, key) && before[key] === step[key]);
}

function remembered(run) {
  return {
    rest: text(restOf(run)),
    order: run.steps ? run.steps.map((step) => step.id).join("\0") : null,
    steps: new Map((run.steps ?? []).map(step => [step.id, rememberStep(step)])),
  };
}

/**
 * @param options.snapshot  The window's whole state, as the owner is shown it (desktop/main.mjs, appSnapshot).
 * @param options.send      Sends a whole state. Returns false when there is no window to send to.
 * @param options.sendHot   Sends a hot message. Returns false when there is no window.
 * @param options.delay     The window hears of a change at most this often (ms).
 * @param options.every     How long to wait between two full comparisons while a bot streams (ms), at least.
 *                          A comparison that took t ms is followed by at least 20 t ms of not comparing.
 */
export function createWindowPush({ snapshot, send, sendHot, delay = 35, every = 750, now = Date.now, later = setTimeout, cancel = clearTimeout, visible = () => true }) {
  let seq = 0;
  // What the window was last sent: null when it holds nothing we can build on.
  let known = null;
  let timer = null;
  let wasVisible;
  // An unclassified change reconciles the entire projection. Classified changes retain only
  // the steps and reply boundaries touched before the next coalesced push.
  const clean = () => ({ steps: new Map(), streams: new Map() });
  let dirty = clean();
  const forget = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    known = null;
    dirty = clean();
  };

  /** The state as the window's new base: numbered, and remembered. `key` is stillKey(state) when it was just made. */
  function whole(state, key) {
    seq += 1;
    const live = streaming(state);
    known = {
      shape: shapeOf(state),
      // Only while a bot streams: the rest of the time every push is a whole state anyway.
      key: live ? (key ?? stillKey(state)) : null,
      checked: now(),
      cost: 0,
      fields: Object.fromEntries(OTHER_FIELDS.map((name) => [name, text(state[name])])),
      bodies: Object.fromEntries(BODY_FIELDS.map(name => [name, state[name] && { ...state[name] }])),
      runs: new Map((state.runs ?? []).filter(working).map((run) => [run.id, remembered(run)])),
      seq,
    };
    return { ...state, seq };
  }
  function sendWhole(state, key) {
    if (send(whole(state, key)) === false) known = null;
  }

  /** The hot message for what changed since the last message, or null when nothing did (or `false` when the whole state is needed). */
  function hot(state, changes) {
    const dirtySteps = changes?.steps;
    const textOnly = dirtySteps?.size === 0;
    const fields = {};
    const appends = [];
    for (const name of textOnly ? ["streams"] : BODY_FIELDS) {
      const before = known.bodies[name];
      const next = state[name];
      if (!before && !next) continue;
      // The set of running chats changed, or thinking started/ended. Replace the map.
      if (!before || !next || Object.keys(before).length !== Object.keys(next).length || Object.keys(next).some(id => !Object.hasOwn(before, id))) {
        fields[name] = next ?? null;
        known.bodies[name] = next && { ...next };
        continue;
      }
      for (const [chat, body] of Object.entries(next)) {
        const previous = before[chat];
        if (previous === body) continue;
        const hint = name === "streams" ? changes?.streams.get(chat) : undefined;
        // A normal provider append already knows where it began. Verify both ends against
        // the owner's visible snapshot. Replacements and paired hosts have the exact prefix fallback.
        const appended = (hint && hint.previous === previous && hint.body === body) || body.startsWith(previous);
        const from = appended ? previous.length : 0;
        appends.push({ name, chat, from, add: body.slice(from) });
        before[chat] = body;
      }
    }
    for (const name of textOnly ? [] : OTHER_FIELDS) {
      const value = text(state[name]);
      if (value === known.fields[name]) continue;
      fields[name] = state[name] === undefined ? null : state[name];
      known.fields[name] = value;
    }
    const runs = [];
    for (const run of textOnly ? [] : state.runs ?? []) {
      if (!working(run) || (dirtySteps && !dirtySteps.has(run.id))) continue;
      const before = known.runs.get(run.id);
      if (!before) return false;
      const patch = { id: run.id };
      const rest = restOf(run);
      const restText = text(rest);
      if (restText !== before.rest) {
        patch.rest = rest;
        before.rest = restText;
      }
      const order = run.steps ? run.steps.map((step) => step.id).join("\0") : null;
      if (order !== before.order) {
        patch.order = run.steps ? run.steps.map((step) => step.id) : null;
        before.order = order;
      }
      const changed = [];
      const touched = dirtySteps?.get(run.id);
      for (const step of run.steps ?? []) {
        if (touched && !touched.has(step.id) && before.steps.has(step.id)) continue;
        if (sameStep(before.steps.get(step.id), step)) continue;
        changed.push(step);
        before.steps.set(step.id, rememberStep(step));
      }
      if (patch.order !== undefined) before.steps = new Map((run.steps ?? []).map((step) => [step.id, before.steps.get(step.id)]));
      if (changed.length) patch.steps = changed;
      if (patch.rest || patch.order !== undefined || patch.steps) runs.push(patch);
    }
    if (!Object.keys(fields).length && !appends.length && !runs.length) return null;
    seq += 1;
    return { base: known.seq, seq, ...(Object.keys(fields).length && { fields }), ...(appends.length && { appends }), ...(runs.length && { runs }) };
  }

  function flush(changes = null) {
    timer = null;
    dirty = clean();
    if (!visible()) return forget();
    const state = snapshot();
    // Nothing streams (or the window has nothing to build on yet): the whole state, as it always was.
    if (!known || known.key === null || !streaming(state)) return sendWhole(state);
    if (shapeOf(state) !== known.shape) return sendWhole(state);
    const start = now();
    if (start - known.checked >= Math.max(every, known.cost * 20)) {
      changes = null;
      const key = stillKey(state);
      const done = now();
      known.cost = done - start;
      known.checked = done;
      if (key !== known.key) return sendWhole(state, key);
    }
    const message = hot(state, changes);
    if (message === false) return sendWhole(state);
    if (message && sendHot(message) === false) known = null;
  }

  return {
    /** Something changed: the window hears of it soon. */
    push(change) {
      if (!visible()) return;
      if (dirty) {
        if (change?.kind === "stream-append") {
          const earlier = dirty.streams.get(change.chatId);
          // A replacement between two appends breaks their common cursor; compare at flush.
          let previous = change.previous;
          if (earlier) previous = earlier.body === previous ? earlier.previous : undefined;
          dirty.streams.set(change.chatId, { previous, body: change.body });
        } else if (change?.kind === "tool-step") {
          const ids = dirty.steps.get(change.runId) ?? new Set();
          ids.add(change.stepId);
          dirty.steps.set(change.runId, ids);
        } else dirty = null;
      }
      if (timer === null) timer = later(() => flush(dirty), delay);
    },
    // On hide discard the incremental base. On show always send one current full snapshot.
    visibilityChanged() {
      const shown = visible();
      if (shown === wasVisible) return;
      wasVisible = shown;
      forget();
      if (shown) flush();
    },
    /** The whole state for a window that asked (it is now the window's base). */
    whole: () => whole(snapshot()),
    /** Sends now what a push would send soon. */
    flush,
  };
}
