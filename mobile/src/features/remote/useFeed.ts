// The picture loop: ask the computer for its screen, show the picture, ask again for whatever
// changed after it. One loop at a time. Each picture goes into the image slot that is not on
// screen and takes the front only once it has been drawn, so the screen never flickers.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenBotActivity, ScreenFrame } from "@/link/types";
import { AppState } from "react-native";
import { readScreenFrame } from "@/state/link";
import { useApp } from "@/state/store";
import { useAppActive } from "@/state/useAppActive";
import { holdScreen } from "@/features/pane/watching";
import { claimScreenFeed, type ScreenFeedOwner, whenScreenFeedFree } from "./feedRegistry";
import { type FeedState, runScreenFeed } from "./screenFeed";

export type SlotName = "a" | "b";
export type Slot = { uri: string; id: number; display: string; width: number; height: number };
export type Pictures = { a: Slot | null; b: Slot | null; front: SlotName };

/** A native load that never draws is retried with fresh bytes. */
const DRAW_WAIT_MS = 1500;

/**
 * `gapMs` is the least time from one ask to the next (default 0: ask again as soon as an answer is
 * in, as Settings › Screen does). The pane paces its samples, and a chat card takes just one.
 */
export function useFeed({ enabled, display, maxWidth, quality, gapMs = 0, once = false, owner = once ? "ScreenCard" : gapMs > 0 ? "PaneScreen" : "Remote" }: { enabled: boolean; display: string | undefined; maxWidth: number; quality: number; gapMs?: number; once?: boolean; owner?: ScreenFeedOwner }) {
  const [pictures, setPictures] = useState<Pictures>({ a: null, b: null, front: "a" });
  const [state, setState] = useState<FeedState>("starting");
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ScreenBotActivity | null>(null);
  const [run, setRun] = useState(0);
  const front = useRef<SlotName>("a");
  const waiting = useRef<{ id: number; finish: (promote: boolean) => void } | null>(null);
  const counter = useRef(0);
  const computer = useApp(state => state.pairing?.serverId);
  const active = useAppActive(enabled);

  useEffect(() => {
    if (!active || !computer) return;
    const controller = new AbortController();
    const { signal } = controller;
    // One feed per computer: a bigger view may hold it, or take it later. Either way this view
    // waits and starts again (a new `run`) when the slot is free.
    let unwait: (() => void) | undefined;
    const waitTurn = () => {
      unwait?.();
      unwait = whenScreenFeedFree(computer, () => setRun((n) => n + 1));
    };
    const releaseFeed = claimScreenFeed(computer, display, owner, () => {
      controller.abort();
      waitTurn();
    });
    if (!releaseFeed) {
      waitTurn();
      return () => unwait?.();
    }
    const release = holdScreen(computer);
    const stop = () => {
      releaseFeed();
      release(AppState.currentState !== "active");
    };
    setState("starting");
    setError(null);

    const present = (frame: ScreenFrame) =>
      new Promise<boolean>((resolve) => {
        const slot: SlotName = front.current === "a" ? "b" : "a";
        const id = ++counter.current;
        const finish = (promote: boolean) => {
          clearTimeout(timer);
          if (waiting.current?.id !== id) return;
          waiting.current = null;
          if (promote && !signal.aborted) {
            front.current = slot;
            setPictures((held) => ({ ...held, front: slot }));
          } else if (!signal.aborted) {
            // Remount the decoder on retry even if the host sends the same JPEG.
            setPictures((held) => ({ ...held, [slot]: null }));
          }
          resolve(promote);
        };
        const timer = setTimeout(() => finish(false), DRAW_WAIT_MS);
        waiting.current?.finish(false);
        waiting.current = { id, finish };
        setPictures((held) => ({ ...held, [slot]: { uri: "data:image/jpeg;base64," + frame.jpeg, id, display: frame.display, width: frame.width, height: frame.height } }));
      });

    void runScreenFeed({
      signal, once, gapMs, draw: present,
      read: after => readScreenFrame(computer, { display, maxWidth, quality, after, ...((once || gapMs > 0) && { wait: false }) }, signal),
      onActivity: (next) => {
        if (!signal.aborted) setActivity(next ?? null);
      },
      report: (value, error) => {
        setState(value);
        setError(error ?? null);
      },
    }).finally(stop);

    return () => {
      controller.abort();
      unwait?.();
      waiting.current?.finish(false);
      stop();
    };
  }, [active, computer, display, maxWidth, quality, gapMs, once, owner, run]);

  /** The image in `slot` was drawn (or failed to load, with `promote` false). */
  function drawn(slot: SlotName, id: number, promote = true) {
    const wait = waiting.current;
    const held = slot === "a" ? pictures.a : pictures.b;
    if (wait && wait.id === id && held?.id === id) wait.finish(promote);
  }

  const retry = useCallback(() => {
    setError(null);
    setState((held) => (held === "failed" ? "retrying" : held));
    setRun((n) => n + 1);
  }, []);

  // A pending image supplies the initial layout so it can decode. Keep the front image's
  // geometry until the swap, and never draw the previous display under the new display's controls.
  const a = !display || pictures.a?.display === display ? pictures.a : null;
  const b = !display || pictures.b?.display === display ? pictures.b : null;
  const visible = a === pictures.a && b === pictures.b ? pictures : { a, b, front: pictures.front };
  const picture = visible[visible.front];
  return { pictures: visible, size: picture ?? a ?? b, state, error, hasPicture: !!picture, activity, drawn, retry };
}
