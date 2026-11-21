// What happened in a space, on the two-container host (docs/spaces.md, "Notifications").
//
// The app says what a person did with `Spaces.happened`, and on one process that reaches the
// link's `spaceEvent` straight away. Here the workspace's container has no link: the link is in
// the other container, which looks at this one every 750 ms. So the events wait in a short queue
// in memory, and each look takes the next few (`state` in workspace.mjs). They are never written to
// disk. An alert is not worth keeping across a restart.
//
// Both sides are safe beside an older one. An older workspace sends no `spaceEvents`, and an
// older link ignores the field. Either way there are no alerts for a person's note or change on
// a split host, and nothing else breaks.

/** The most events that wait for a look. When more come, the oldest go. */
export const QUEUE_LIMIT = 50;
/** The most events one look takes. The rest wait in the queue for the next look. */
export const LOOK_LIMIT = 20;

/** A queue of events: `add` keeps the newest `limit`, `take(most)` gives the oldest `most` of them once (all, without a number) and leaves the rest. */
export function spaceEventQueue(limit = QUEUE_LIMIT) {
  let events = [];
  return {
    add(event) {
      events.push(event);
      if (events.length > limit) events = events.slice(-limit);
    },
    take(most = Infinity) {
      return events.splice(0, most);
    },
  };
}

/**
 * Hands the events of one answer to `listener`, in order. The workspace sends at most `LOOK_LIMIT`;
 * an older one may send more, and the rest of those are dropped. Whatever is not a plain object is dropped; and a listener that fails for one
 * event (it throws, or it answers with a promise that fails) does not stop the next event.
 */
export function handSpaceEvents(events, listener) {
  if (!Array.isArray(events) || typeof listener !== "function") return;
  for (const event of events.slice(0, LOOK_LIMIT)) {
    if (!event || typeof event !== "object" || Array.isArray(event) || Object.getPrototypeOf(event) !== Object.prototype) continue;
    try {
      Promise.resolve(listener(event)).catch(() => {});
    } catch {}
  }
}
