// Settings › Channels › Add channel / Replace token (Screen 3).
// 3-step Sheet with a progress bar:
//   Step 1: Choose channel kind (large brand-colored tiles)
//   Step 2: Label + per-kind credentials (secureTextEntry; held only in component state,
//           sent once in channelAdd/channelUpdate `secrets`, then cleared; shows "In vault"
//           afterward and never persists, logs, or echoes tokens)
//   Step 3: Bound bot + DM policy → channelAdd
// In Replace token mode (`mode=replace&id=<connId>`), edits credentials for an existing
// connection via channelUpdate({ secrets }) and clears the inputs immediately after submit.
import { router, useLocalSearchParams } from "expo-router";
import { Check, Lock, ShieldCheck } from "lucide-react-native";
import { useEffect, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import type { ChannelDmPolicy, ChannelKind } from "@/link/types";
import { useOnline, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import {
  Button,
  Field,
  Glass,
  Group,
  Label,
  radius,
  Row,
  Segmented,
  Sheet,
  space,
  T,
  Tap,
  tint,
  useTheme,
} from "@/ui";
import {
  buildSecretsPayload,
  CHANNEL_KIND_LIST,
  CHANNEL_KIND_SPECS,
  DM_POLICY_OPTIONS,
  submitAndClearSecrets,
} from "./logic";
import { ChannelKindTile, OwnerOnlySheet, PillBadge, StepProgressBar, useIsChannelsOwner } from "./ui";

function TokenInput({
  label,
  placeholder,
  value,
  inVault,
  prefixHint,
  error,
  onChangeText,
}: {
  label: string;
  placeholder: string;
  value: string;
  inVault: boolean;
  prefixHint?: string;
  error?: string;
  onChangeText: (next: string) => void;
}) {
  const { colors, dark, type, control } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const [focused, setFocused] = useState(false);

  const inner = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        gap: space.sm,
        minHeight: control.field + 14,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="caption" color="muted" weight="600">
          {label}
        </T>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={
            inVault && !focused
              ? `${prefixHint ?? ""}••••••••`
              : placeholder || "Tap to enter securely"
          }
          placeholderTextColor={inVault && !focused ? colors.ink2 : colors.faint}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
          spellCheck={false}
          keyboardAppearance={dark ? "dark" : "light"}
          selectionColor={colors.accent}
          maxFontSizeMultiplier={1.3}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          accessibilityLabel={label}
          style={[
            value || inVault ? type.mono : type.callout,
            { color: colors.ink, paddingVertical: 0, minHeight: 22 },
          ]}
        />
      </View>
      {inVault && !value ? (
        <PillBadge label="✓ In vault" tone="success" />
      ) : (
        <Lock size={17} color={focused ? colors.ink : colors.muted} strokeWidth={2.2} />
      )}
    </View>
  );

  const borderColor = error ? colors.danger : focused ? colors.primary : colors.line;

  return (
    <View style={{ gap: 4 }}>
      {hasBackdrop ? (
        <Glass
          tintColor={tint(colors.surface, dark ? 0.28 : 0.42)}
          style={{
            borderRadius: radius.md,
            overflow: "hidden",
            borderWidth: focused || error ? 1.5 : StyleSheet.hairlineWidth,
            borderColor,
          }}
        >
          {inner}
        </Glass>
      ) : (
        <View
          style={{
            backgroundColor: colors.surface,
            borderRadius: radius.md,
            borderWidth: focused || error ? 1.5 : 1,
            borderColor,
          }}
        >
          {inner}
        </View>
      )}
      {!!error && (
        <T variant="footnote" color="danger" style={{ paddingHorizontal: space.xs }}>
          {error}
        </T>
      )}
    </View>
  );
}

export default function AddChannel() {
  const owner = useIsChannelsOwner();
  const params = useLocalSearchParams<{ mode?: string; id?: string; step?: string; kind?: string }>();
  const { colors, dark } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const online = useOnline();
  const channels = usePart("channels") ?? [];
  const bots = (usePart("bots") ?? []).filter((b) => !b.hidden);

  const replaceMode = params.mode === "replace" && !!params.id;
  const existing = replaceMode ? channels.find((c) => c.id === params.id) : undefined;

  const initialKind: ChannelKind =
    existing?.kind ??
    (params.kind && CHANNEL_KIND_LIST.includes(params.kind as ChannelKind)
      ? (params.kind as ChannelKind)
      : "slack");
  const initialStep = replaceMode ? 2 : params.step === "2" ? 2 : params.step === "3" ? 3 : 1;

  const [step, setStep] = useState<1 | 2 | 3>(initialStep);
  const [kind, setKind] = useState<ChannelKind>(initialKind);
  const [label, setLabel] = useState(existing?.label ?? "");
  const [nodeHostId, setNodeHostId] = useState(existing?.nodeHostId ?? "");
  const [botId, setBotId] = useState(existing?.botId ?? bots[0]?.id ?? "");
  const [dm, setDm] = useState<ChannelDmPolicy>("pairing");
  // Secret tokens live strictly in local component state, sent once, then wiped.
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [savedInVault, setSavedInVault] = useState<string[]>(existing?.configuredSecrets ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!botId && bots[0]?.id) setBotId(bots[0].id);
  }, [botId, bots]);

  // Wipe secret state on unmount.
  useEffect(() => {
    return () => {
      setSecretDrafts({});
    };
  }, []);

  if (!owner) return <OwnerOnlySheet title={replaceMode ? "Replace token" : "Add channel"} />;

  const spec = CHANNEL_KIND_SPECS[kind];

  function selectKind(next: ChannelKind) {
    if (replaceMode) return;
    setKind(next);
    setSecretDrafts({});
    setErrors({});
  }

  function validateStep2(): boolean {
    if (replaceMode) {
      const anyProvided = spec.secrets.some((s) => (secretDrafts[s.key] ?? "").trim().length > 0);
      if (!anyProvided) {
        const nextErrors: Record<string, string> = {};
        if (spec.secrets[0]) nextErrors[spec.secrets[0].key] = "Enter a new token to replace.";
        setErrors(nextErrors);
        return false;
      }
      setErrors({});
      return true;
    }
    const { missing } = buildSecretsPayload(kind, secretDrafts);
    if (missing.length > 0) {
      const nextErrors: Record<string, string> = {};
      for (const m of missing) nextErrors[m.key] = `Enter ${m.label}.`;
      setErrors(nextErrors);
      return false;
    }
    setErrors({});
    return true;
  }

  async function handleReplaceSubmit() {
    if (!existing || !validateStep2()) return;
    const { secrets } = buildSecretsPayload(kind, secretDrafts);
    setSaving(true);
    try {
      const updated = await submitAndClearSecrets(
        secrets,
        (payload) =>
          attempt(
            api.channelUpdate(existing.id, { secrets: payload }),
            "Credentials updated in vault",
          ),
        () => setSecretDrafts({}),
      );
      if (updated) {
        setSavedInVault(updated.configuredSecrets ?? Object.keys(secrets));
        router.back();
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateSubmit() {
    const { secrets, missing } = buildSecretsPayload(kind, secretDrafts);
    if (missing.length > 0) {
      setStep(2);
      const nextErrors: Record<string, string> = {};
      for (const m of missing) nextErrors[m.key] = `Enter ${m.label}.`;
      setErrors(nextErrors);
      return;
    }
    setSaving(true);
    try {
      const created = await submitAndClearSecrets(
        secrets,
        (payload) =>
          attempt(
            api.channelAdd({
              kind,
              label: label.trim() || `${spec.name} channel`,
              botId: botId || bots[0]?.id || undefined,
              ...(kind === "imessage" && nodeHostId.trim() ? { nodeHostId: nodeHostId.trim() } : {}),
              policy: { dm },
              ...(Object.keys(payload).length > 0 ? { secrets: payload } : {}),
            }),
            `${spec.name} channel connected`,
          ),
        () => setSecretDrafts({}),
      );
      if (created) {
        setSavedInVault(created.configuredSecrets ?? []);
        router.back();
      }
    } finally {
      setSaving(false);
    }
  }

  const titleText = replaceMode
    ? `Update ${existing?.label ?? spec.name}`
    : step === 1
      ? "Add channel"
      : step === 2
        ? spec.connectHeading
        : "Who answers";

  const captionText = replaceMode
    ? "Enter replacement credentials to save directly to your computer's vault."
    : step === 1
      ? "Choose where people will message your bot."
      : step === 2
        ? spec.connectCaption
        : "Pick the bot and who can send direct messages.";

  const footer = (
    <View
      style={{
        paddingHorizontal: space.xl,
        paddingTop: space.sm,
        paddingBottom: space.xl,
        flexDirection: "row",
        gap: space.sm,
      }}
    >
      {!replaceMode && step > 1 && (
        <Button
          title="Back"
          variant="secondary"
          size="lg"
          style={{ borderRadius: radius.pill }}
          disabled={saving}
          onPress={() => setStep((s) => (s === 3 ? 2 : 1))}
        />
      )}
      <Button
        title={
          replaceMode
            ? "Save to vault"
            : step === 3
              ? `Connect ${spec.name}`
              : "Continue"
        }
        variant="primary"
        size="lg"
        wide
        style={{ flex: 1, borderRadius: radius.pill }}
        loading={saving}
        disabled={!online || saving}
        onPress={() => {
          if (replaceMode) {
            void handleReplaceSubmit();
          } else if (step === 1) {
            setStep(2);
          } else if (step === 2) {
            if (validateStep2()) setStep(3);
          } else {
            void handleCreateSubmit();
          }
        }}
      />
    </View>
  );

  return (
    <Sheet
      title={replaceMode ? "Credentials" : "Add channel"}
      onClose={() => {
        setSecretDrafts({});
        router.back();
      }}
      footer={footer}
    >
      {!replaceMode && <StepProgressBar step={step} total={3} />}

      <View style={{ gap: 4 }}>
        <T variant="title1" weight="700">
          {titleText}
        </T>
        <T variant="subhead" color="muted">
          {captionText}
        </T>
      </View>

      {step === 1 && !replaceMode && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {CHANNEL_KIND_LIST.map((k) => {
            const item = CHANNEL_KIND_SPECS[k];
            const selected = kind === k;
            const tileBody = (
              <View style={{ padding: space.md, gap: space.sm }}>
                <ChannelKindTile kind={k} size={38} />
                <View style={{ gap: 1 }}>
                  <T variant="callout" weight="600" numberOfLines={1}>
                    {item.name}
                  </T>
                  <T variant="footnote" color="muted" numberOfLines={1}>
                    {item.shortSubtitle}
                  </T>
                </View>
              </View>
            );
            return (
              <Tap
                key={k}
                onPress={() => selectKind(k)}
                feel="select"
                sink={0.97}
                accessibilityState={{ selected }}
                accessibilityLabel={`${item.name}, ${item.shortSubtitle}`}
                style={{ width: "48%" }}
              >
                {hasBackdrop ? (
                  <Glass
                    tintColor={tint(colors.surface, dark ? 0.3 : 0.44)}
                    style={{
                      borderRadius: radius.lg,
                      overflow: "hidden",
                      borderWidth: selected ? 1.8 : StyleSheet.hairlineWidth,
                      borderColor: selected ? colors.primary : colors.line,
                    }}
                  >
                    {tileBody}
                  </Glass>
                ) : (
                  <View
                    style={{
                      borderRadius: radius.lg,
                      backgroundColor: colors.surface,
                      borderWidth: selected ? 1.8 : 1,
                      borderColor: selected ? colors.primary : colors.line,
                    }}
                  >
                    {tileBody}
                  </View>
                )}
              </Tap>
            );
          })}
        </View>
      )}

      {step === 2 && (
        <View style={{ gap: space.md }}>
          {!replaceMode && (
            <View style={{ flexDirection: "row", gap: space.sm }}>
              {CHANNEL_KIND_LIST.slice(0, 2).map((k) => {
                const item = CHANNEL_KIND_SPECS[k];
                const selected = kind === k;
                const inner = (
                  <View style={{ padding: space.md, gap: space.sm }}>
                    <ChannelKindTile kind={k} size={34} />
                    <View style={{ gap: 1 }}>
                      <T variant="callout" weight="600" numberOfLines={1}>
                        {item.name}
                      </T>
                      <T variant="footnote" color="muted" numberOfLines={1}>
                        {item.shortSubtitle}
                      </T>
                    </View>
                  </View>
                );
                return (
                  <Tap
                    key={k}
                    onPress={() => selectKind(k)}
                    feel="select"
                    sink={0.97}
                    style={{ flex: 1 }}
                  >
                    {hasBackdrop ? (
                      <Glass
                        tintColor={tint(colors.surface, dark ? 0.3 : 0.44)}
                        style={{
                          borderRadius: radius.lg,
                          overflow: "hidden",
                          borderWidth: selected ? 1.8 : StyleSheet.hairlineWidth,
                          borderColor: selected ? colors.primary : colors.line,
                        }}
                      >
                        {inner}
                      </Glass>
                    ) : (
                      <View
                        style={{
                          borderRadius: radius.lg,
                          backgroundColor: colors.surface,
                          borderWidth: selected ? 1.8 : 1,
                          borderColor: selected ? colors.primary : colors.line,
                        }}
                      >
                        {inner}
                      </View>
                    )}
                  </Tap>
                );
              })}
            </View>
          )}

          {!replaceMode && (
            <Field
              label="Label"
              placeholder={`Acme ${spec.name}`}
              value={label}
              onChangeText={setLabel}
              returnKeyType="next"
            />
          )}

          {spec.secrets.length > 0 ? (
            <View style={{ gap: space.sm }}>
              {spec.secrets.map((field) => (
                <TokenInput
                  key={field.key}
                  label={field.label}
                  placeholder={field.placeholder}
                  prefixHint={field.prefixHint}
                  value={secretDrafts[field.key] ?? ""}
                  inVault={savedInVault.includes(field.key)}
                  error={errors[field.key]}
                  onChangeText={(next) => {
                    setSecretDrafts((prev) => ({ ...prev, [field.key]: next }));
                    if (errors[field.key]) setErrors((prev) => ({ ...prev, [field.key]: "" }));
                  }}
                />
              ))}
            </View>
          ) : (
            <Field
              label="Mac node host (optional)"
              placeholder="Leave blank for this Mac"
              hint="If your host runs on Linux or in the cloud, enter the paired Mac node host ID."
              value={nodeHostId}
              onChangeText={setNodeHostId}
              autoCapitalize="none"
              autoCorrect={false}
              mono
            />
          )}

          {spec.secrets.length > 0 && (
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingHorizontal: space.xs }}>
              <ShieldCheck size={18} color={colors.success} strokeWidth={2.2} style={{ marginTop: 1 }} />
              <T variant="footnote" color="muted" style={{ flex: 1 }}>
                Saved to the vault on your computer. This phone never keeps or shows it.
              </T>
            </View>
          )}
        </View>
      )}

      {step === 3 && !replaceMode && (
        <View style={{ gap: space.lg }}>
          <View>
            <Label>Answers as</Label>
            <Group>
              {bots.map((bot) => (
                <Row
                  key={bot.id}
                  title={bot.name}
                  subtitle={bot.role || undefined}
                  trailing={
                    bot.id === botId ? (
                      <Check size={18} color={colors.accentText} strokeWidth={2.5} />
                    ) : undefined
                  }
                  onPress={() => setBotId(bot.id)}
                />
              ))}
            </Group>
          </View>

          <View>
            <Label>Direct messages</Label>
            <Segmented
              options={DM_POLICY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              value={dm}
              onChange={setDm}
            />
            <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
              {DM_POLICY_OPTIONS.find((o) => o.value === dm)?.description}
            </T>
          </View>
        </View>
      )}
    </Sheet>
  );
}
