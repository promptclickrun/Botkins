// The picture loop: ask the computer for its screen, show the picture, ask again for whatever
// changed after it. One loop at a time. Each picture goes into the image slot that is not on
// screen and takes the front only once it has been drawn, so the screen never flickers.
import { useEffect, useRef, useState } from "react";
import type { ScreenFrame } from "@/link/types";
import { api } from "@/state/link";

export type SlotName = "a" | "b";
export type Slot = { uri: string; id: number };
export type Pictures = { a: Slot | null; b: Slot | null; front: SlotName };

/** Tries in a row before the loop gives up and shows the error with Retry. */
const RETRIES = 5;
const RETRY_MS = 1000;
/** How long to wait for a picture to be drawn before asking for the next one anyway. */
const DRAW_WAIT_MS = 1500;

export type FeedState = "starting" | "live" | "retrying" | "failed";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown) => (error instanceof Error && error.message ? error.message : "Couldn't get the picture.");

/**
 * `gapMs` is the least time from one ask to the next (default 0: ask again as soon as an answer is
 * in, as Settings › Screen does). A screen card in a chat and the side pane ask more slowly.
 */
export function useFeed({ enabled, display, maxWidth, quality, gapMs = 0 }: { enabled: boolean; display: string | undefined; maxWidth: number; quality: number; gapMs?: number }) {
  const [pictures, setPictures] = useState<Pictures>({ a: null, b: null, front: "a" });
  /** The latest picture's size in pixels, and the display it shows. */
  const [size, setSize] = useState<{ width: number; height: number; display: string } | null>(null);
  const [state, setState] = useState<FeedState>("starting");
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const front = useRef<SlotName>("a");
  const waiting = useRef<{ id: number; finish: (promote: boolean) => void } | null>(null);
  const counter = useRef(0);
  const shown = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    const present = (frame: ScreenFrame) =>
      new Promise<void>((resolve) => {
        const slot: SlotName = front.current === "a" ? "b" : "a";
        const id = ++counter.current;
        const finish = (promote: boolean) => {
          clearTimeout(timer);
          if (waiting.current?.id !== id) return;
          waiting.current = null;
          if (promote && alive) {
            front.current = slot;
            setPictures((held) => ({ ...held, front: slot }));
          }
          resolve();
        };
        const timer = setTimeout(() => finish(true), DRAW_WAIT_MS);
        waiting.current?.finish(false);
        waiting.current = { id, finish };
        setPictures((held) => ({ ...held, [slot]: { uri: "data:image/jpeg;base64," + frame.jpeg, id } }));
        setSize((held) => (held && held.width === frame.width && held.height === frame.height && held.display === frame.display ? held : { width: frame.width, height: frame.height, display: frame.display }));
      });

    void (async () => {
      let after: number | undefined;
      let failures = 0;
      while (alive) {
        const asked = Date.now();
        try {
          const frame = await api["link.screen.frame"]({ display, maxWidth, quality, after });
          if (!alive) break;
          failures = 0;
          setError(null);
          if (frame.jpeg) {
            await present(frame);
            if (!alive) break;
            shown.current = true;
          } else if (Date.now() - asked < 100) {
            // Nothing changed and the computer answered at once: don't spin.
            await sleep(250);
          }
          if (shown.current) setState("live");
          after = frame.seq;
          const rest = gapMs - (Date.now() - asked);
          if (rest > 0) await sleep(rest);
        } catch (caught) {
          if (!alive) break;
          failures += 1;
          if (failures > RETRIES) {
            setError(messageOf(caught));
            setState("failed");
            break;
          }
          setState("retrying");
          await sleep(RETRY_MS);
        }
      }
    })();

    return () => {
      alive = false;
      waiting.current?.finish(false);
    };
  }, [enabled, display, maxWidth, quality, gapMs, run]);

  /** The image in `slot` was drawn (or failed to load, with `promote` false). */
  function drawn(slot: SlotName, id: number, promote = true) {
    const wait = waiting.current;
    const held = slot === "a" ? pictures.a : pictures.b;
    if (wait && wait.id === id && held?.id === id) wait.finish(promote);
  }

  function retry() {
    setError(null);
    setState((held) => (held === "failed" ? "retrying" : held));
    setRun((n) => n + 1);
  }

  const hasPicture = !!pictures[pictures.front];
  return { pictures, size, state, error, hasPicture, drawn, retry };
}
