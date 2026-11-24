// Marketplace › Agents, the plain logic: the chips, the lines under a template, the note Create a
// bot shows for a template someone else wrote, and the routes. No React Native imports.
// The contract is docs/agent-templates.md.
import type { Href } from "expo-router";
import type { MarketAgent, MarketAgentCategory } from "@/link/types";

export const AGENTS_CAPABILITY = "agent-templates-v1";

export type AgentChip = { key: string; label: string; category?: string; name?: string };

/** "All" first, then each category with how many templates it holds. A chosen one that emptied stays, at 0. */
export function agentChips(categories: MarketAgentCategory[], chosen?: { id: string; name: string }): AgentChip[] {
  const shown = chosen && !categories.some((item) => item.id === chosen.id) ? [...categories, { ...chosen, count: 0 }] : categories;
  return [{ key: "all", label: "All" }, ...shown.map((item) => ({ key: item.id, label: item.name + " " + item.count, category: item.id, name: item.name }))];
}

/** Under a template in the list: "Productivity · Botkins". */
export const listLine = (agent: MarketAgent) => [agent.categoryName, agent.marketplaceName].filter(Boolean).join(" · ");

/** On a template's page: "Productivity · Botkins · v1.0.0 · Botkins". */
export const pageLine = (agent: MarketAgent) => [agent.categoryName, agent.marketplaceName, agent.version && "v" + agent.version.replace(/^v/i, ""), agent.author].filter(Boolean).join(" · ");

/** Create a bot's one line for a template from a marketplace that doesn't come with Botkins. */
export const fromLine = (agent: Pick<MarketAgent, "builtIn" | "marketplaceName">) => (agent.builtIn ? undefined : "From " + agent.marketplaceName + ". Someone else wrote these instructions: read them first.");

// An id is opaque and may hold any character, so it travels as a query parameter.
export const agentHref = (id: string) => ("/market/agent?id=" + encodeURIComponent(id)) as unknown as Href;

/** A template's suggested pairing, as a title: "Routine · Weekdays at 8:00", or "Proactive". */
export function pairingTitle(pairing: NonNullable<MarketAgent["pairing"]>) {
  if (pairing.kind === "routine") return ["Routine", pairing.cadence].filter(Boolean).join(" · ");
  return "Proactive";
}

export function templateAvailability(supported: boolean, online: boolean) {
  if (!online) return "Connect to your computer";
  if (!supported) return "Update the app on your computer";
}
