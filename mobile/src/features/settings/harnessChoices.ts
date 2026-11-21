// The phone's plain logic for Settings › Harness, kept apart from the screen so it can be tested.
import type { HarnessStatus, Preferences } from "@/link/types";

export type Harness = NonNullable<Preferences["harness"]>;

// The same choices, names and words as Settings › General › Harness on the computer.
export const HARNESSES: { value: Harness; title: string; subtitle: string }[] = [
  { value: "copilot", title: "Copilot SDK", subtitle: "One harness for every model and plan" },
  { value: "provider", title: "Provider default", subtitle: "Codex for ChatGPT, Claude Code for Claude" },
  { value: "pi", title: "Pi", subtitle: "Pi for ChatGPT and Claude plans" },
];
export const harnessName = (value: Preferences["harness"]) => HARNESSES.find((harness) => harness.value === value)?.title;

/**
 * The choices this computer has. Pi is one only on a computer that knows it (harnesses() names it),
 * or one already set to it.
 */
export function harnessChoices(current: Preferences["harness"], pi: HarnessStatus | undefined) {
  return HARNESSES.filter((harness) => harness.value !== "pi" || !!pi || current === "pi");
}

/**
 * What the Pi row offers: an install the computer runs when Pi is missing and the computer can
 * install from a phone with a command; else its guide; else nothing.
 */
export function piAction(pi: HarnessStatus | undefined, capable: boolean): "install" | "guide" | null {
  if (!pi || pi.installed) return null;
  return capable && pi.install?.command ? "install" : pi.install?.url ? "guide" : null;
}
