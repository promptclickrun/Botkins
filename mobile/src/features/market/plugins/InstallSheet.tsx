// Installing a plugin: which bots use it, and its settings. What is installed is the preview the
// person looked at (its `revision`); when the plugin changed since, the page shows it again first.
// A secret is typed only in its field and sent once with the install, then forgotten.
import { router, useLocalSearchParams } from "expo-router";
import { Check, Puzzle } from "lucide-react-native";
import { useState } from "react";
import { Alert, View } from "react-native";
import { CredentialPicker, PickedCredential } from "@/features/credentials/CredentialPicker";
import { useBots, useOnline } from "@/state/hooks";
import { showToast } from "@/state/store";
import { BotAvatar, EmptyState, Field, Group, Label, Loading, Row, Sheet, space, useTheme } from "@/ui";
import { shownText } from "@/ui/shownText";
import { loadPreview, pluginCalls, usePreview } from "./calls";
import { configValues, type FieldDraft, missingFields } from "./logic";
import { WhereItGoes } from "./PluginPage";

export default function InstallSheet() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { colors } = useTheme();
  const online = useOnline();
  const bots = useBots();
  const preview = usePreview(id)?.preview;
  const [all, setAll] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>({});
  const [busy, setBusy] = useState(false);

  if (!id || !preview)
    return <Sheet title="Install">{id ? <Loading /> : <EmptyState icon={Puzzle} title="This plugin is gone" />}</Sheet>;
  const fields = preview.config;
  const missing = missingFields(fields, drafts);
  const ready = online && !busy && missing.length === 0 && (all || chosen.length > 0);
  const draft = (key: string): FieldDraft => drafts[key] ?? { text: "" };
  const change = (key: string, next: FieldDraft) => setDrafts((was) => ({ ...was, [key]: next }));

  const install = async () => {
    if (!ready) return;
    setBusy(true);
    const config = configValues(fields, drafts);
    // Secrets leave the form the moment they are sent, whatever the answer.
    setDrafts((was) => Object.fromEntries(Object.entries(was).filter(([key]) => !fields.find((field) => field.key === key)?.secret)));
    try {
      await pluginCalls.install(id, { bots: all ? "all" : chosen, ...(Object.keys(config).length > 0 && { config }), ...(preview.revision !== undefined && { revision: preview.revision }) });
      setBusy(false);
      router.back();
      if (preview.postInstallMessage) Alert.alert("Installed", preview.postInstallMessage);
      else showToast("Installed", "success");
    } catch (error) {
      setBusy(false);
      // When the plugin changed since it was looked at, the page shows the new one before anything is installed.
      const fresh = await loadPreview(id);
      if (fresh && fresh.revision !== preview.revision) {
        showToast("This plugin changed since you looked at it. Look at it again.", "info");
        router.back();
      } else showToast(error instanceof Error ? error.message : "That didn't work.", "error");
    }
  };

  return (
    <Sheet title={"Install " + shownText(preview.name)} action="Install" onAction={() => void install()} actionDisabled={!ready} actionLoading={busy}>
      {bots.length > 0 && (
        <View>
          <Label>Bots</Label>
          <Group>
            <Row title="All bots" subtitle={all ? "New bots too" : undefined} toggled={all} onToggle={setAll} disabled={busy} />
            {!all &&
              bots.map((bot) => {
                const on = chosen.includes(bot.id);
                return (
                  <Row
                    key={bot.id}
                    leading={<BotAvatar bot={bot} size={32} badge={false} />}
                    title={bot.name}
                    subtitle={on ? "Uses it" : undefined}
                    trailing={on ? <Check size={20} color={colors.accentText} strokeWidth={2.6} /> : undefined}
                    disabled={busy}
                    onPress={() => setChosen((was) => (on ? was.filter((item) => item !== bot.id) : [...was, bot.id]))}
                  />
                );
              })}
          </Group>
        </View>
      )}

      {fields.length > 0 && (
        <View style={{ gap: space.md }}>
          <Label style={{ marginBottom: 0 }}>Settings</Label>
          {fields.map((field) => {
            const value = draft(field.key);
            const label = field.label + (field.required ? "" : " (optional)");
            if (field.secret && value.credential)
              return (
                <View key={field.key} style={{ gap: space.xs }}>
                  <Label style={{ marginBottom: 0 }}>{label}</Label>
                  <PickedCredential name={value.credential.name} onClear={() => change(field.key, { text: "" })} disabled={busy} />
                  <WhereItGoes field={field} />
                </View>
              );
            return (
              <View key={field.key} style={{ gap: space.xs }}>
                <Field
                  label={label}
                  hint={field.description}
                  value={value.text}
                  onChangeText={(text) => change(field.key, { text })}
                  placeholder={field.secret ? "Value" : (field.default ?? "")}
                  secureTextEntry={field.secret}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  accessibilityLabel={field.label}
                />
                <WhereItGoes field={field} />
                {field.secret && <CredentialPicker disabled={busy} onPick={(ref, name) => change(field.key, { text: "", credential: { id: ref.$credential, name } })} />}
              </View>
            );
          })}
        </View>
      )}
    </Sheet>
  );
}
