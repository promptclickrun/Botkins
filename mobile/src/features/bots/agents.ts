// The plain logic of "Bring in your agents" (BringAgents.tsx): the agents a person already has in a
// provider's own tool, offered as bots. The words are the app's on the computer. No React Native
// imports, so the tests run it.
import type { ImportableAgent } from "@/link/types";

/** An agent that can become a bot now: it has no problem, and no bot was made from it yet. */
export const canAdd = (agent: ImportableAgent) => !agent.problem && !agent.added;
export const addable = (agents: ImportableAgent[]) => agents.filter(canAdd);

/** What is ticked when the list opens: every agent that can be added. */
export const firstPick = (agents: ImportableAgent[]) => addable(agents).map((agent) => agent.key);

/** The chosen keys in the order the agents are shown. Bots are made in that order, and the first is the primary bot. */
export const pickedKeys = (agents: ImportableAgent[], picked: readonly string[]) => agents.filter((agent) => canAdd(agent) && picked.includes(agent.key)).map((agent) => agent.key);

/** The button: how many bots it makes. */
export const addLabel = (count: number) => (count === 0 ? "Choose an agent" : count === 1 ? "Add 1 bot" : "Add " + count + " bots");

/** The line under the title. `provider` is the first agent's, as on the computer. */
export function foundLine(agents: ImportableAgent[]): string {
  const usable = agents.filter((agent) => !agent.problem);
  const provider = (usable[0] ?? agents[0])?.providerName ?? "your provider";
  return "Botkins found " + (usable.length === 1 ? "an agent" : usable.length + " agents") + " you already use with " + provider + ". Each one you choose becomes a bot with the same instructions.";
}

/** The line under an agent's name. */
export function agentLine(agent: ImportableAgent): string {
  if (agent.problem) return "Can't be added. " + agent.problem;
  if (agent.added) return "Already a bot";
  return agent.summary || agent.role;
}

/** What a person should know before adding an agent: its model is missing, or it sets its own tools. */
export function agentNotes(agent: ImportableAgent): string[] {
  if (agent.problem) return [];
  return [
    ...(agent.missingModel ? ["Its model, " + agent.missingModel + ", isn't on your account. The bot will use your default model."] : []),
    ...(agent.ownTools ? ["Sets its own tools in " + agent.providerName + ". As a bot it uses Botkins' Skills, MCP servers and approvals."] : []),
  ];
}

export const copyLine = (agents: ImportableAgent[]) => "Botkins copies each agent. Your " + (agents[0]?.providerName ?? "provider") + " files stay as they are.";
