import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { refresh, useModels, useProviders, useSettings } from "@/state/hooks";
import { api } from "@/state/link";
import { Badge, Group, Label, Loading, Page, ProviderIcon, Row } from "@/ui";
import { defaultProviderOf, describeChoice } from "./shared";
import { providerBadge, providerLine } from "./status";

/** The computer's default model and the providers models come from. */
export default function Providers() {
  const settings = useSettings();
  const models = useModels();
  const providers = useProviders();
  const [refreshing, setRefreshing] = useState(false);
  const fallback = describeChoice(settings?.model, models, defaultProviderOf(providers));

  const reload = async () => {
    setRefreshing(true);
    // Asks the computer to check each provider again, then reads the fresh lists.
    await api.providers(true).catch(() => undefined);
    await refresh("providers");
    setRefreshing(false);
  };

  return (
    <Page title="Models" onRefresh={reload} refreshing={refreshing}>
      <Group>
        <Row
          leading={<ProviderIcon provider={fallback.provider} name={fallback.providerLabel} size={36} tile />}
          title="Default model"
          subtitle={models ? fallback.label : undefined}
          chevron
          onPress={() => router.push({ pathname: "/chat/model", params: { scope: "global" } })}
        />
      </Group>

      <View>
        <Label>Providers</Label>
        {!providers ? (
          <Loading />
        ) : (
          <Group>
            {providers.map((provider) => {
              const badge = providerBadge(provider);
              return (
                <Row
                  key={provider.id}
                  leading={<ProviderIcon provider={provider.id} name={provider.name} size={36} tile />}
                  title={provider.name}
                  subtitle={providerLine(provider)}
                  trailing={<Badge label={badge.label} tone={badge.tone} />}
                  chevron
                  onPress={() => router.push({ pathname: "/models/[id]", params: { id: provider.id } })}
                />
              );
            })}
          </Group>
        )}
      </View>
    </Page>
  );
}
