// What the phone says about a model ("models-v2"), from what its provider reports. Each fact is
// shown only when it is known: nothing here is a guess, a zero or a placeholder. No React Native
// imports, so the tests can run it.
import type { ModelInfo } from "@/link/types";
import { tokens } from "../chat/contextMath";

const known = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** "1M context" for a model's row, or undefined when the window isn't known. */
export const contextFact = (model: Pick<ModelInfo, "contextWindow">) => (known(model.contextWindow) ? tokens(model.contextWindow) + " context" : undefined);

export type Fact = { key: string; label: string; value: string };

/** The facts list of the model's page, in order, each only when known. Thinking levels are listed apart (effortRows). */
export function modelFacts(model: ModelInfo): Fact[] {
  const facts: Fact[] = [];
  const count = (value: number) => tokens(value) + " tokens";
  if (known(model.contextWindow)) facts.push({ key: "context", label: "Context window", value: count(model.contextWindow) });
  if (known(model.maxOutput)) facts.push({ key: "output", label: "Max output", value: count(model.maxOutput) });
  if (known(model.maxPrompt)) facts.push({ key: "prompt", label: "Max prompt", value: count(model.maxPrompt) });
  if (typeof model.vision === "boolean") facts.push({ key: "vision", label: "Reads pictures", value: model.vision ? "Yes" : "No" });
  if (typeof model.tools === "boolean") facts.push({ key: "tools", label: "Uses tools", value: model.tools ? "Yes" : "No" });
  if (model.knowledge?.trim()) facts.push({ key: "knowledge", label: "Knowledge", value: model.knowledge.trim() });
  if (model.vendor?.trim()) facts.push({ key: "vendor", label: "Made by", value: model.vendor.trim() });
  if (model.tier?.trim()) facts.push({ key: "tier", label: "Tier", value: model.tier.trim() });
  return facts;
}

/** Each thinking level with the provider's note for it, where it gave one. */
export function effortRows(model: ModelInfo, effortLabel: (effort: string) => string) {
  return model.efforts.map((level) => ({ level, label: effortLabel(level) + (level === model.defaultEffort ? " · Default" : ""), note: model.effortNotes?.[level]?.trim() || undefined }));
}
