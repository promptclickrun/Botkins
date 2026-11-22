import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { refresh, useCan, useMember, useModels, usePart, useProviders, useSettings } from "@/state/hooks";
import { api } from "@/state/link";
import { Badge, Group, Label, Loading, Page, ProviderIcon, Row, space, T } from "@/ui";
import { defaultProviderOf, describeChoice } from "./shared";
import { providerBadge, providerLine } from "./status";

/** The computer's default model and the providers models come from. */
export default function Providers() {
  const settings = useSettings();
  const models = useModels();
  const providers = useProviders();
  const member = useMember();
  const canManage = useCan("agents", "manage");
  const [refreshing, setRefreshing] = useState(false);
  const fallback = describeChoice(settings?.model, models, defaultProviderOf(providers));
  // The Default routines model, on a computer that has one ("routine-models-v1"). Without it routines use the default model.
  const routineModels = !!usePart("meta")?.capabilities?.includes("routine-models-v1");
  const routines = describeChoice(settings?.routineModel ?? settings?.model, models, defaultProviderOf(providers));

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
          chevron={canManage}
          onPress={canManage ? () => router.push({ pathname: "/chat/model", params: { scope: "global" } }) : undefined}
        />
        {routineModels && (
          <Row
            leading={<ProviderIcon provider={routines.provider} name={routines.providerLabel} size={36} tile />}
            title="Default routines model"
            subtitle={models ? (settings?.routineModel ? routines.label : "Not set") : undefined}
            chevron={canManage}
            onPress={canManage ? () => router.push({ pathname: "/chat/model", params: { scope: "routines" } }) : undefined}
          />
        )}
      </Group>
      {routineModels && (
        <T variant="footnote" color="muted" style={{ marginTop: -space.md, paddingHorizontal: space.lg }}>
          Routines use their own default unless they choose a model. With none set, they use the bot's model, then the default model.
        </T>
      )}

      {!member && <View>
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
      </View>}
    </Page>
  );
}
