// A restart of the computer's Botkins that this phone started by installing an update
// ("app-update-v1"). For its first minutes the link's banner says the computer is restarting instead
// of that it can't be reached, and a tap still tries again; when the computer answers, the phone says
// how the install ended (`last`), wherever the person is in the app, and if it never does, it says
// that. Kept in memory only: a restart outlasts no app launch. The decisions are `restartStep` and
// `afterRestart` in src/features/settings/updates.ts (tested).
import { create } from "zustand";
import { afterRestart, gaveUpLine, type PendingRestart, type RestartStage, restartStep } from "@/features/settings/updates";
import { api } from "./link";
import { showToast, useApp } from "./store";

export const useUpdateRestart = create<{ pending: PendingRestart | null; stage: RestartStage }>(() => ({ pending: null, stage: "restarting" }));

let timer: ReturnType<typeof setInterval> | undefined;
/**
 * Called once the computer took the install: it restarts now. `before` is the `last.at` it showed
 * before. Until it has said how it ended, the phone looks every few seconds.
 */
export function markRestarting(serverId: string, from: string, to?: string, before?: string) {
  useUpdateRestart.setState({ pending: { serverId, since: Date.now(), from, ...(to && { to }), ...(before && { before }) }, stage: "restarting" });
  clearInterval(timer);
  timer = setInterval(() => void settle(), 5000);
}
function done() {
  clearInterval(timer);
  timer = undefined;
  useUpdateRestart.setState({ pending: null, stage: "restarting" });
}

/** The restart under way on the computer in use, if this phone started one, with what the banner says. */
export function useRestarting(): (PendingRestart & { stage: RestartStage }) | null {
  const pending = useUpdateRestart((state) => state.pending);
  const stage = useUpdateRestart((state) => state.stage);
  const serverId = useApp((state) => state.pairing?.serverId);
  return pending && pending.serverId === serverId ? { ...pending, stage } : null;
}

let asking = false;
/** Looks once: forgets the restart, gives up on it, or, while the link is up, asks how the install ended. */
async function settle() {
  const pending = useUpdateRestart.getState().pending;
  if (!pending) return;
  const state = useApp.getState();
  const step = restartStep(pending, state.pairing?.serverId, Date.now());
  if (step.kind === "drop") return done();
  if (step.kind === "gave-up") {
    done();
    return showToast(gaveUpLine(state.pairing?.name ?? "your computer", state.link === "online"), "error");
  }
  if (useUpdateRestart.getState().stage !== step.stage) useUpdateRestart.setState({ stage: step.stage });
  if (asking || state.link !== "online") return;
  asking = true;
  try {
    const update = await api.appUpdateStatus();
    const next = afterRestart(pending, update);
    if (!next.done || useUpdateRestart.getState().pending !== pending) return;
    done();
    if (next.text) showToast(next.text, next.ok ? "success" : "error");
  } catch {
    // Not answering yet: the next look asks again.
  } finally {
    asking = false;
  }
}

useApp.subscribe((state, before) => {
  if (state.link === "online" && before.link !== "online") void settle();
});
