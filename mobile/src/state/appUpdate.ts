// A restart of the computer's Botkins that this phone started by installing an update
// ("app-update-v1"). While it lasts, the link's banner says the computer is restarting instead of
// that it can't be reached; when the computer answers again, the phone says how the install ended
// (`last`), wherever the person is in the app. Kept in memory only: a restart outlasts no app launch.
import { create } from "zustand";
import { afterRestart, type PendingRestart, restartPending } from "@/features/settings/updates";
import { api } from "./link";
import { showToast, useApp } from "./store";

export const useUpdateRestart = create<{ pending: PendingRestart | null }>(() => ({ pending: null }));

let timer: ReturnType<typeof setInterval> | undefined;
/** Called once the computer took the install: it restarts now. Until it has said how it ended, the phone asks every few seconds while it can reach it. */
export function markRestarting(serverId: string, from: string, to?: string) {
  useUpdateRestart.setState({ pending: { serverId, since: Date.now(), from, ...(to && { to }) } });
  clearInterval(timer);
  timer = setInterval(() => void settle(), 5000);
}
function done() {
  clearInterval(timer);
  timer = undefined;
  useUpdateRestart.setState({ pending: null });
}

/** The restart under way on the computer in use, if this phone started one. */
export function useRestarting(): PendingRestart | null {
  const pending = useUpdateRestart((state) => state.pending);
  const serverId = useApp((state) => state.pairing?.serverId);
  return restartPending(pending, serverId, Date.now()) ? pending : null;
}

let asking = false;
/** Once the link is back, asks the computer how the install ended, and says so. */
async function settle() {
  const pending = useUpdateRestart.getState().pending;
  const state = useApp.getState();
  if (!pending) return;
  // Another computer is in use now, or it has been too long: nothing more to say.
  if (!restartPending(pending, state.pairing?.serverId, Date.now())) return done();
  if (asking || state.link !== "online") return;
  asking = true;
  try {
    const update = await api.appUpdateStatus();
    const next = afterRestart(pending, update);
    if (!next.done) return;
    done();
    if (next.text) showToast(next.text, next.ok ? "success" : "error");
  } catch {
    // Not answering yet: the next change of the link asks again.
  } finally {
    asking = false;
  }
}

useApp.subscribe((state, before) => {
  if (state.link === "online" && before.link !== "online") void settle();
});
