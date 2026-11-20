// The computer's own Botkins and its updates, as the computer's page shows them ("app-update-v1";
// docs/link-contract.md). The words are the desktop app's own (Settings › About). Plain logic with no
// React Native imports: tests/app-update.test.ts runs it.
import type { AppUpdate } from "@/link/types";

export const UPDATE_CAPABILITY = "app-update-v1";
/**
 * How long the phone treats the computer as restarting for an update it started, at most. The
 * computer gives up on an install that never started after 10 minutes and says why; this is longer,
 * so the phone is still waiting when that sentence comes.
 */
export const RESTART_MS = 12 * 60_000;

/** The update is under way or being looked for: the buttons wait. */
export const updateBusy = (update: AppUpdate | undefined) => !!update && (update.status === "checking" || update.status === "downloading" || update.status === "restarting");

/** The line under "Updates": the computer's own sentence when it has one, else the desktop app's words. */
export function updateLine(update: AppUpdate | undefined): string {
  if (!update) return "";
  if (update.message && (update.status === "error" || update.status === "available" || update.status === "idle")) return update.message;
  switch (update.status) {
    case "current":
      return "You’re up to date.";
    case "available":
      return "Version " + update.latest + " is available.";
    case "checking":
      return "Checking GitHub…";
    case "downloading":
      return "Downloading update…";
    case "restarting":
      return "Restarting after the current request…";
    case "error":
      return "Botkins couldn't check for updates.";
    default:
      return "Botkins checks GitHub Releases automatically.";
  }
}

/** The page's button: install what is there when this copy can, else look for it. */
export function updateButton(update: AppUpdate | undefined): { kind: "install" | "check"; title: string; disabled: boolean } {
  const install = update?.status === "available" && update.canInstall;
  return { kind: install ? "install" : "check", title: install ? "Update and restart" : "Check for updates", disabled: !update || updateBusy(update) };
}

/** How the last install ended, in a sentence (`last`, kept across the restart). */
export function lastLine(last: AppUpdate["last"]): string | null {
  if (!last) return null;
  if (last.ok) return "Updated from " + last.from + " to " + last.to + ".";
  return last.message || "The update to " + last.to + " didn't finish, so " + last.from + " is back.";
}

/** The alert before installing: what happens, in one sentence. */
export const installQuestion = (name: string, latest: string | undefined) => ({
  title: "Update Botkins on " + name + "?",
  message: "Botkins on " + name + " restarts to install " + (latest ? "version " + latest : "the update") + ". Its bots stop for a moment and pick up where they were.",
});

/** A restart this phone started, for one computer. */
export type PendingRestart = { serverId: string; since: number; from: string; to?: string };

/** Whether a restart this phone started still counts: the same computer, and not too long ago. */
export const restartPending = (pending: PendingRestart | null | undefined, serverId: string | undefined, now: number) =>
  !!pending && !!serverId && pending.serverId === serverId && now - pending.since < RESTART_MS;

/**
 * What to tell the person once the computer answers again after a restart this phone started: how
 * the install ended (`last` names the version it went to), or that it hasn't ended yet.
 */
export function afterRestart(pending: PendingRestart, update: AppUpdate): { done: boolean; ok?: boolean; text?: string } {
  if (update.status === "downloading" || update.status === "restarting") return { done: false };
  const last = update.last;
  // A `last` from before this install says nothing about it.
  if (!last || Date.parse(last.at) < pending.since - 60_000) {
    if (update.current !== pending.from) return { done: true, ok: true, text: "Botkins is now " + update.current + "." };
    return { done: true, ok: false, text: update.message || "The update didn't finish." };
  }
  return { done: true, ok: last.ok, text: lastLine(last) ?? undefined };
}
