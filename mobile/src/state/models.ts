// Reading model choices: names, thinking levels, and who a chat or bot inherits from.
import type { Bot, ChatSummary, ModelChoice, ModelInfo, Preferences } from "@/link/types";

const EFFORTS: Record<string, string> = { xhigh: "Extra high", max: "Max", none: "None", minimal: "Minimal" };
export const effortLabel = (effort: string) => EFFORTS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);

export const PROVIDER_NAMES: Record<string, string> = { copilot: "GitHub Copilot", codex: "ChatGPT", claude: "Claude", opencode: "OpenCode", grok: "Grok", kiro: "Kiro", antigravity: "Antigravity", fx: "fx", cursor: "Cursor", pi: "Pi", omp: "OMP" };
export const providerName = (id: string | undefined, models: ModelInfo[] = []) =>
  (id && (models.find((m) => m.provider === id)?.providerName ?? PROVIDER_NAMES[id])) || id || "";

/** Two providers can share a model id, so a model is known by both. */
export const modelKey = (model: { id: string; provider?: string }) => model.id + "\n" + (model.provider ?? "");

export function findModel(models: ModelInfo[], choice?: ModelChoice, defaultProvider?: string) {
  if (!choice) return undefined;
  const same = models.filter((m) => m.id === choice.model);
  const provider = choice.provider ?? defaultProvider;
  return provider ? (same.find((m) => m.provider === provider) ?? (choice.provider ? undefined : same[0])) : same[0];
}

export function modelName(choice: ModelChoice | undefined, models: ModelInfo[] = [], defaultProvider?: string) {
  if (!choice) return "Default";
  if (choice.model === "auto" && (choice.provider ?? defaultProvider ?? "copilot") === "copilot") return "Auto";
  return findModel(models, choice, defaultProvider)?.name ?? choice.model;
}

/** The choice in force for a chat: its own, else its bot's, else the computer's default. */
export function effectiveModel(settings: Preferences | undefined, bot?: Bot, chat?: ChatSummary): ModelChoice | undefined {
  if (chat?.model) return chat.model;
  return chat?.schedules?.some((entry) => entry.routine) ? routineDefault(settings, bot) : (bot?.model ?? settings?.model);
}

/** What a routine with no model of its own runs on: the Default routines model, then its bot's, then the default model (desktop/workspace.mjs). */
export function routineDefault(settings: Preferences | undefined, bot?: Bot): ModelChoice | undefined {
  return settings?.routineModel ?? bot?.model ?? settings?.model;
}

export type ModelGroup = { provider: string; name: string; sections: { title?: string; models: ModelInfo[] }[] };
/** Models by provider, in the computer's order. A provider with several services is split by service. */
export function groupModels(models: ModelInfo[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const model of models) {
    const provider = model.provider ?? "";
    let group = groups.find((g) => g.provider === provider);
    if (!group) groups.push((group = { provider, name: model.providerName ?? providerName(provider), sections: [] }));
    let section = group.sections.find((s) => s.title === model.group);
    if (!section) group.sections.push((section = { title: model.group, models: [] }));
    section.models.push(model);
  }
  return groups;
}

/** The choice to save when a person picks a model: the effort is kept only when the model takes it. */
export function chooseModel(model: ModelInfo, effort?: string): ModelChoice {
  return {
    model: model.id,
    ...(model.provider && { provider: model.provider }),
    ...(model.source && { source: model.source }),
    ...(effort && model.efforts.includes(effort) && { reasoningEffort: effort }),
  };
}
