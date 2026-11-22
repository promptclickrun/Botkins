// Helpers for the tests of turns that sit quiet for a long time, with `setTimeout` faked
// (`t.mock.timers.enable({ apis: ["setTimeout"] })`). Only setTimeout is faked, so setImmediate
// still lets the promises a turn is waiting on settle.

/** Lets the work a turn is waiting on settle. */
export const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** Moves the faked clock forward by `ms`, a minute at a time, letting each step's checks finish. */
export async function pass(t, ms) {
  for (let left = ms; left > 0; left -= 60000) {
    t.mock.timers.tick(Math.min(60000, left));
    await settle();
  }
}

/** Starts `promise`, and says whether it is still waiting. */
export function watching(promise) {
  const seen = { state: "pending", value: undefined };
  const done = promise.then(
    (value) => Object.assign(seen, { state: "done", value }),
    (error) => Object.assign(seen, { state: "failed", value: error }),
  );
  return { seen, done };
}

/** Waits (in real time, turn by turn of the event loop) until `ready()` is true. */
export async function until(ready, what = "the condition") {
  for (const end = Date.now() + 5000; !ready() && Date.now() < end; ) await new Promise((resolve) => setImmediate(resolve));
  if (!ready()) throw new Error("Never happened: " + what);
}
