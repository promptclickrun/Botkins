// What this phone notes while it watches a turn on a computer without "turn-timeline-v1": how long
// the reply so far was when each step, thought and steer first showed, and the last text it saw.
// The chat cuts the text there (src/features/chat/turn.ts), and keeps what a turn wrote before it
// ended without a reply, which such a computer drops. Kept in memory only, for the computer in use.
import { create } from "zustand";
import { markKeys, noteMarks, type RunMarks, TIMELINE_V1, underWay } from "@/features/chat/turn";
import { onComputerChange, useApp } from "./store";

/** The marks of the turns this phone watched, by run id. */
export const useTurnMarks = create<Record<string, RunMarks>>(() => ({}));

/** How many turns are remembered; the oldest go first. */
const KEEP = 24;

useApp.subscribe((state, before) => {
  if (state.texts === before.texts && state.parts.live?.streams === before.parts.live?.streams && state.running === before.running && state.chats === before.chats) return;
  const streams = state.parts.live?.streams;
  if (!streams || state.parts.meta?.capabilities.includes(TIMELINE_V1)) return;
  const held = useTurnMarks.getState();
  let next: Record<string, RunMarks> | null = null;
  for (const chatId of Object.keys(streams)) {
    const stream = state.texts[chatId]?.stream;
    if (stream === before.texts[chatId]?.stream && state.running[chatId] === before.running[chatId] &&
      state.chats[chatId] === before.chats[chatId] && before.parts.live?.streams[chatId] === streams[chatId]) continue;
    const run = underWay(state.running[chatId]);
    // A group chat's members take turns, each with a text of its own: nothing to cut.
    if (!run || run.speakers?.length) continue;
    const priorMarks = (next ?? held)[run.id];
    const beforeRun = before.running[chatId];
    const sameEntries = priorMarks && state.chats[chatId]?.messages === before.chats[chatId]?.messages &&
      run.id === beforeRun?.id && run.steps === beforeRun.steps && run.reasoning === beforeRun.reasoning;
    const keys = sameEntries ? [] : markKeys(run, state.chats[chatId]?.messages ?? []);
    const noted = noteMarks(priorMarks, stream ?? "", keys);
    if (noted === priorMarks) continue;
    next ??= { ...held };
    delete next[run.id];
    next[run.id] = noted;
  }
  if (!next) return;
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - KEEP))) delete next[id];
  useTurnMarks.setState(next, true);
});

onComputerChange(() => useTurnMarks.setState({}, true));
