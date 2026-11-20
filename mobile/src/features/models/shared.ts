// Reading a model choice for display: which provider, its name, its short name, its thinking level.
import type { ModelChoice, ModelInfo, ProviderStatus } from "@/link/types";
import { useProviders } from "@/state/hooks";
import { effortLabel, findModel, modelName, providerName } from "@/state/models";

/** The provider a choice without one runs on: the computer's default provider. */
export function useDefaultProvider() {
  return useProviders()?.find((provider) => provider.default)?.id;
}

export const defaultProviderOf = (providers: ProviderStatus[] | undefined) => providers?.find((provider) => provider.default)?.id;

/** What a choice shows: the model, its provider, and the thinking level when one was picked. */
export function describeChoice(choice: ModelChoice | undefined, models: ModelInfo[] | undefined, defaultProvider?: string) {
  const model = findModel(models ?? [], choice, defaultProvider);
  const provider = choice?.provider ?? model?.provider ?? (choice ? defaultProvider : undefined);
  const name = modelName(choice, models ?? [], defaultProvider);
  const effort = choice?.reasoningEffort ? effortLabel(choice.reasoningEffort) : undefined;
  return { model, provider, providerLabel: providerName(provider, models ?? []), name, effort, label: effort ? name + " · " + effort : name };
}

/** "Claude Sonnet 5.5" → "Sonnet 5.5" when the provider's name already says Claude. */
export function shortName(name: string, provider?: string, models?: ModelInfo[]) {
  const words = [providerName(provider, models), provider ?? ""].filter(Boolean).map((word) => word.toLowerCase() + " ");
  const lower = name.toLowerCase();
  const prefix = words.find((word) => lower.startsWith(word) && name.length > word.length);
  return prefix ? name.slice(prefix.length) : name;
}
