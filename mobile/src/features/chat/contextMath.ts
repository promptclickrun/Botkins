// What the context meter and the context sheet show, worked out from a chat's measurement and its
// runs, as the desktop's panel does (src/ContextDetails.tsx). No React Native imports, so the tests
// can run it.
import type { ChatContext, RunSummary, Usage } from "@/link/types";
import { compactNumber } from "../../state/time";

export type ContextPart = { key: "system" | "tools" | "conversation" | "other"; label: string; value: number };
export type ContextTone = "success" | "warning" | "danger";

/** How much of the window is in use, 0 to 100. */
export const contextPercent = (context: ChatContext) => (context.limit > 0 ? Math.min(100, Math.round((context.current / context.limit) * 100)) : 0);

/** Calm while there is room, a warning past 70%, danger past 90%, when compacting is due. */
export const contextTone = (percent: number): ContextTone => (percent >= 90 ? "danger" : percent >= 70 ? "warning" : "success");

/** The known parts of what is in the window, then what the known parts don't cover ("Other"). */
export function contextParts(context: ChatContext): { parts: ContextPart[]; free: number; known: boolean } {
  const parts: ContextPart[] = [];
  if (context.system !== undefined) parts.push({ key: "system", label: "Instructions and system", value: context.system });
  if (context.tools !== undefined) parts.push({ key: "tools", label: "Tool definitions", value: context.tools });
  if (context.conversation !== undefined) parts.push({ key: "conversation", label: "Conversation", value: context.conversation });
  const known = parts.length > 0;
  const sum = parts.reduce((total, part) => total + part.value, 0);
  if (known && context.current > sum) parts.push({ key: "other", label: "Other", value: context.current - sum });
  return { parts, free: Math.max(0, context.limit - context.current), known };
}

/** A chat's runs from both places the phone has them, newest first, each once. */
export function chatRuns(chatId: string, recent: RunSummary[] | undefined, loaded: Record<string, RunSummary> | undefined): RunSummary[] {
  const byId = new Map<string, RunSummary>();
  for (const run of recent ?? []) if (run.chatId === chatId) byId.set(run.id, run);
  for (const run of Object.values(loaded ?? {})) byId.set(run.id, { ...byId.get(run.id), ...run, usage: run.usage ?? byId.get(run.id)?.usage });
  return [...byId.values()].sort((a, b) => b.time - a.time);
}

export type UsageSummary = { latest?: Usage; replies: number; input: number; output: number; cacheRead: number; cost: number };

/** The latest reply's tokens and the chat's totals, from the runs that carry usage. */
export function usageSummary(runs: RunSummary[]): UsageSummary {
  const used = runs.filter((run) => run.usage).sort((a, b) => b.time - a.time);
  const total = { replies: used.length, input: 0, output: 0, cacheRead: 0, cost: 0 };
  for (const run of used) {
    total.input += run.usage!.input || 0;
    total.output += run.usage!.output || 0;
    total.cacheRead += run.usage!.cacheRead || 0;
    total.cost += run.usage!.cost || 0;
  }
  return { latest: used[0]?.usage, ...total };
}

/** "84.2K", "200K", "1M": the app's compact numbers (`compactNumber`), without a trailing ".0". */
export const tokens = (value: number) => compactNumber(Math.max(0, value)).replace(/\.0(?=[KM]$)/, "");
