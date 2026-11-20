// A model's page: its name and provider, then what the provider says about it ("models-v2"). Each
// fact shows only when it is known.
import { router, useLocalSearchParams } from "expo-router";
import { CircleHelp } from "lucide-react-native";
import { View } from "react-native";
import { useModels, usePart, useProviders } from "@/state/hooks";
import { effortLabel, providerName } from "@/state/models";
import { EmptyState, Group, Label, Loading, ProviderIcon, Row, Sheet, space, T } from "@/ui";
import { effortRows, modelFacts } from "./facts";

export default function ModelInfo() {
  const params = useLocalSearchParams<{ model?: string; provider?: string }>();
  const models = useModels();
  const providers = useProviders();
  const detailed = !!usePart("meta")?.capabilities.includes("models-v2");
  const model = models?.find((m) => m.id === params.model && (m.provider ?? "") === (params.provider ?? "")) ?? models?.find((m) => m.id === params.model && !params.provider);
  const provider = providers?.find((p) => p.id === model?.provider);

  if (!models)
    return (
      <Sheet title="Model">
        <Loading />
      </Sheet>
    );
  if (!model)
    return (
      <Sheet title="Model">
        <EmptyState icon={CircleHelp} title="This model isn't offered now" action="Back" onAction={() => router.back()} />
      </Sheet>
    );

  const facts = modelFacts(model);
  const levels = effortRows(model, effortLabel);
  const providerLabel = model.providerName ?? providerName(model.provider, models);
  return (
    <Sheet title="Model">
      <View style={{ alignItems: "center", gap: space.sm, paddingTop: space.sm }}>
        <ProviderIcon provider={model.provider} name={providerLabel} size={48} tile />
        <View style={{ alignItems: "center", gap: 2 }}>
          <T variant="title2" center>
            {model.name}
          </T>
          <T variant="subhead" color="muted" center>
            {[providerLabel, model.group].filter(Boolean).join(" · ")}
          </T>
        </View>
        {!!model.description && (
          <T variant="callout" color="ink2" center>
            {model.description}
          </T>
        )}
        {!model.available && (
          <T variant="footnote" color="warning" center>
            Not on this account
          </T>
        )}
      </View>

      {facts.length > 0 ? (
        <Group>
          {facts.map((fact) => (
            <Row key={fact.key} title={fact.label} value={fact.value} />
          ))}
        </Group>
      ) : (
        <T variant="subhead" color="muted" center>
          {detailed ? "Your computer has no more details for this model." : "Update the app on your computer to see this model's details."}
        </T>
      )}

      {levels.length > 0 && (
        <View>
          <Label>Thinking levels</Label>
          <Group>
            {levels.map((level) => (
              <Row key={level.level} title={level.label} subtitle={level.note} subtitleLines={2} />
            ))}
          </Group>
        </View>
      )}

      {!!provider?.description && (
        <View>
          <Label>{provider.name}</Label>
          <Group>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md }}>
              <ProviderIcon provider={provider.id} name={provider.name} size={32} tile />
              <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                <T variant="callout">{provider.description}</T>
                {!!provider.plan && (
                  <T variant="footnote" color="muted">
                    {provider.plan}
                  </T>
                )}
              </View>
            </View>
          </Group>
        </View>
      )}
    </Sheet>
  );
}
