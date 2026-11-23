// A provider set up with a key ("keyed-providers-v1": OpenRouter, Azure Foundry, an OpenAI
// endpoint), on its page: the key, then the settings the provider takes (an endpoint, a base URL,
// its API, an API version and a list of models). The same choices and words as the computer's card
// (desktop/src/ProviderKeyed.tsx); the plain logic is keyed.ts.
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { ExternalLink, KeyRound, Plus, Trash2, X } from "lucide-react-native";
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import type { KeyedProvider, ProviderStatus } from "@/link/types";
import { refresh } from "@/state/hooks";
import { api } from "@/state/link";
import { Button, Field, Group, haptic, IconButton, IconTile, Label, radius, Row, Segmented, space, T, useTheme } from "@/ui";
import { API_CHOICES, configFromForm, formChanged, formFromConfig, formProblems, hasProblems, type KeyedForm, keyedParts, keyedWords, keyPage, type ModelRow, newRow } from "./keyed";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "That didn't work. Try again.");

/** The key: add it, replace it or remove it. It is typed only in its sheet and never shown again. */
export function KeyedKey({ provider, keyed }: { provider: ProviderStatus; keyed: KeyedProvider }) {
  const { colors } = useTheme();
  const words = keyedWords(provider.id, keyed);
  const page = keyPage(keyed);
  const openSheet = () => router.push({ pathname: "/models/signin", params: { id: provider.id, mode: "key" } });
  const remove = () =>
    Alert.alert("Remove the " + words.keyName + " for " + provider.name + "?", "Bots that use " + provider.name + " models can't reply until you add a key again. Your chats and bots stay here.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove key",
        style: "destructive",
        onPress: async () => {
          try {
            await api.signOut(provider.id);
            haptic.success();
          } catch (error) {
            Alert.alert("The key wasn't removed", messageOf(error));
          }
          await refresh("providers");
        },
      },
    ]);
  return (
    <View>
      <Label>{words.keyLabel}</Label>
      <Group>
        {keyed.hasKey ? (
          <>
            <Row leading={<IconTile icon={KeyRound} color={colors.success} />} title="Saved on your computer" subtitle="It isn't shown again." />
            <Row leading={<IconTile icon={KeyRound} color={colors.accent} />} title="Replace key" chevron onPress={openSheet} />
            <Row leading={<IconTile icon={Trash2} color={colors.danger} />} title="Remove key" tone="danger" onPress={remove} />
          </>
        ) : (
          <Row leading={<IconTile icon={KeyRound} color={colors.accent} />} title={"Add your " + words.keyName} subtitle={words.keyHint} subtitleLines={2} chevron onPress={openSheet} />
        )}
        {!!page && <Row leading={<IconTile icon={ExternalLink} color={colors.ink2} />} title="Get a key" onPress={() => void WebBrowser.openBrowserAsync(page)} />}
      </Group>
    </View>
  );
}

/** The settings besides the key; Save sends them whole (providerConfigure). */
export function KeyedSettings({ provider, keyed }: { provider: ProviderStatus; keyed: KeyedProvider }) {
  const { colors } = useTheme();
  const parts = keyedParts(keyed);
  const words = keyedWords(provider.id, keyed);
  const [form, setForm] = useState<KeyedForm>(() => formFromConfig(keyed.config));
  // Problems show once the person tries to save, then follow each change.
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const problems = formProblems(provider.id, keyed, form);
  const shown = tried ? problems : {};
  const changed = formChanged(keyed, form);
  const set = (next: Partial<KeyedForm>) => setForm((f) => ({ ...f, ...next }));
  const setRow = (row: string, next: Partial<ModelRow>) => set({ models: form.models.map((r) => (r.row === row ? { ...r, ...next } : r)) });

  const save = async () => {
    setTried(true);
    if (hasProblems(problems)) {
      haptic.warn();
      return;
    }
    setSaving(true);
    setProblem(undefined);
    try {
      await api.providerConfigure(provider.id, configFromForm(keyed, form));
      haptic.success();
      await refresh("providers");
    } catch (error) {
      haptic.warn();
      setProblem("The settings weren't saved. " + messageOf(error));
    } finally {
      setSaving(false);
    }
  };

  const url = { autoCapitalize: "none", autoCorrect: false, autoComplete: "off", keyboardType: "url" } as const;
  return (
    <View style={{ gap: space.lg }}>
      <View>
        <Label>Settings</Label>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          {parts.endpoint && <Field label={words.endpoint.label} placeholder={words.endpoint.placeholder} value={form.endpoint} onChangeText={(endpoint) => set({ endpoint })} error={shown.endpoint} {...url} />}
          {parts.baseUrl && <Field label={words.baseUrl.label} placeholder={words.baseUrl.placeholder} value={form.baseUrl} onChangeText={(baseUrl) => set({ baseUrl })} error={shown.baseUrl} {...url} />}
          {parts.api && (
            <View style={{ gap: 6 }}>
              <T variant="label" color="muted" style={{ paddingHorizontal: space.xs }}>
                {words.api.label}
              </T>
              <Segmented options={API_CHOICES} value={form.api} onChange={(value) => set({ api: value })} />
            </View>
          )}
          {parts.apiVersion && (
            <Field label={words.apiVersion.label} placeholder={words.apiVersion.placeholder} value={form.apiVersion} onChangeText={(apiVersion) => set({ apiVersion })} error={shown.apiVersion} autoCapitalize="none" autoCorrect={false} autoComplete="off" />
          )}
        </View>
      </View>

      {parts.models && (
        <View>
          <Label>{words.models.label}</Label>
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.lg, marginBottom: space.sm }}>
            {words.models.hint}
          </T>
          <View style={{ gap: space.md }}>
            {form.models.map((r, i) => (
              <View key={r.row} style={[styles.card, { backgroundColor: colors.surface, borderColor: shown.models?.[r.row] ? colors.danger : colors.line }]}>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <T variant="subhead" weight="600" style={{ flex: 1 }} numberOfLines={1}>
                    {r.name.trim() || r.id.trim() || "Model " + (i + 1)}
                  </T>
                  <IconButton icon={X} label={"Remove " + (r.id.trim() || "model " + (i + 1))} size={44} color={colors.muted} onPress={() => set({ models: form.models.filter((x) => x.row !== r.row) })} />
                </View>
                <Field
                  label={words.models.id}
                  placeholder={words.models.idPlaceholder}
                  value={r.id}
                  onChangeText={(id) => setRow(r.row, { id })}
                  error={shown.models?.[r.row]}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  autoFocus={!r.id && !r.name && i > 0 && i === form.models.length - 1}
                />
                <Field label={words.models.name} placeholder={words.models.namePlaceholder} value={r.name} onChangeText={(name) => setRow(r.row, { name })} autoCorrect={false} />
                {parts.modelApi && (
                  <View style={{ gap: 6 }}>
                    <T variant="label" color="muted" style={{ paddingHorizontal: space.xs }}>
                      API
                    </T>
                    <Segmented options={API_CHOICES} value={r.api} onChange={(value) => setRow(r.row, { api: value })} />
                  </View>
                )}
              </View>
            ))}
            <Button title={words.models.add} icon={Plus} variant="secondary" wide onPress={() => set({ models: [...form.models, newRow()] })} />
          </View>
        </View>
      )}

      {!!problem && (
        <T variant="footnote" color="danger" accessibilityLiveRegion="polite">
          {problem}
        </T>
      )}
      {tried && hasProblems(problems) && (
        <T variant="footnote" color="danger" accessibilityLiveRegion="polite">
          Fix what's marked, then save again.
        </T>
      )}
      <Button title="Save" size="lg" wide loading={saving} disabled={!changed} onPress={() => void save()} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md, padding: space.lg, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
});
