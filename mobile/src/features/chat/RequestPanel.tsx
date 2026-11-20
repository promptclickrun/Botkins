// What a bot is waiting on: an approval, a question or a short form, docked above the composer.
// Secrets are typed masked or picked from saved credentials (the computer fills those in, so the
// value never reaches the phone), and are cleared the moment the answer goes. A request that looks
// destructive turns red and asks for a press-and-hold on Allow.
import * as WebBrowser from "expo-web-browser";
import { Globe, Hand, Lock, ShieldAlert, X } from "lucide-react-native";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import Animated, { FadeInDown, useAnimatedProps, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { CredentialPicker } from "@/features/credentials/CredentialPicker";
import type { AgentRequest, Bot, CredentialRef, FormField } from "@/link/types";
import { api, attempt } from "@/state/link";
import { BotAvatar, Button, Chip, Field, haptic, lift, radius, space, T, Tap, useTheme, switchColors } from "@/ui";

type Answer = { action: string; value?: string | CredentialRef; content?: Record<string, unknown> };
type Picked = { ref: CredentialRef; name: string };

// --- What a request looks like -------------------------------------------------------------

const SECRET = /\b(password|passwd|passcode|passphrase|secret|token|api ?key|access ?key|private ?key|key|pin|otp|2fa|mfa|one ?time ?code|verification ?code)s?\b/;
const words = (text: string) =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.:/]+/g, " ")
    .toLowerCase();
/** Whether a name or title asks for a secret ("API key", "password", "otp_code"). */
export const looksSecret = (...texts: (string | undefined)[]) => texts.some((text) => !!text && SECRET.test(words(text)));
const isSecretField = (key: string, field: FormField) => field.format === "password" || looksSecret(key, field.title);

const DANGER = /\brm\s+(-\w*r\w*f|-\w*f\w*r|--recursive\s+--force|--force\s+--recursive)\b|\bdrop\s+(table|database|schema)\b|\btruncate\s+table\b|\bpush\b[^\n]*(\s-f\b|--force)|\bforce[- ]push|\bdelete\b|\bformat\b|\bmkfs\b|\bdd\s+if=|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-\w*f/i;
/** Whether a request's command or words look destructive. */
export const looksDangerous = (request: AgentRequest) => DANGER.test([request.preview, request.label, request.title].filter(Boolean).join("\n"));

function hostOf(url: string): string | null {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url);
  return match ? match[1].replace(/^[^@]*@/, "") : null;
}

// --- Pieces ----------------------------------------------------------------------------------

function useRespond(request: AgentRequest) {
  const [busy, setBusy] = useState<string | null>(null);
  const respond = async (answer: Answer, which: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(which);
    const done = await attempt(api.respond(request.id, answer).then(() => true));
    if (done) haptic.success();
    setBusy(null);
    return !!done;
  };
  return { busy, respond };
}

function useScreenReader() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((value) => live && setOn(value));
    const subscription = AccessibilityInfo.addEventListener("screenReaderChanged", setOn);
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return on;
}

const HOLD_MS = 700;
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Allow for a risky request: held for a moment while a ring fills. With a screen reader, a second confirm instead. */
function HoldToAllow({ onConfirm, busy, disabled }: { onConfirm: () => void; busy: boolean; disabled: boolean }) {
  const { colors } = useTheme();
  const reader = useScreenReader();
  const progress = useSharedValue(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const size = 22;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  const ring = useAnimatedProps(() => ({ strokeDashoffset: length * (1 - progress.value) }));
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (reader)
    return (
      <Button
        title="Allow"
        variant="danger"
        style={{ flex: 1 }}
        loading={busy}
        disabled={disabled}
        onPress={() =>
          Alert.alert("Allow this?", "It may delete or overwrite things.", [
            { text: "Cancel", style: "cancel" },
            { text: "Allow", style: "destructive", onPress: onConfirm },
          ])
        }
      />
    );

  const release = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    progress.value = withTiming(0, { duration: 160 });
  };
  return (
    <Pressable
      disabled={disabled || busy}
      onPressIn={() => {
        haptic.tap();
        progress.value = withTiming(1, { duration: HOLD_MS });
        timer.current = setTimeout(() => {
          timer.current = null;
          haptic.warn();
          onConfirm();
        }, HOLD_MS);
      }}
      onPressOut={release}
      accessibilityRole="button"
      accessibilityLabel="Hold to allow"
      accessibilityState={{ disabled: disabled || busy, busy }}
      style={{ flex: 1, height: 46, borderRadius: radius.md, backgroundColor: colors.danger, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, opacity: disabled ? 0.45 : 1 }}
    >
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.dangerSoft} strokeOpacity={0.5} strokeWidth={stroke} fill="none" />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.dangerSoft}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={length}
          animatedProps={ring}
          transform={"rotate(-90 " + size / 2 + " " + size / 2 + ")"}
        />
      </Svg>
      <T variant="headline" weight="600" color={colors.dangerSoft} numberOfLines={1}>
        {busy ? "Allowing…" : "Hold to allow"}
      </T>
    </Pressable>
  );
}

/** The address a request wants opened, by its host, with a way to open it. */
function LinkLine({ url }: { url: string }) {
  const { colors } = useTheme();
  const host = hostOf(url);
  if (!host) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, paddingLeft: space.md, borderRadius: radius.md, backgroundColor: colors.sunken }}>
      <Globe size={16} color={colors.muted} strokeWidth={2.2} />
      <T variant="subhead" weight="600" numberOfLines={1} style={{ flex: 1 }} accessibilityLabel={"Address, " + host}>
        {host}
      </T>
      <Tap onPress={() => void WebBrowser.openBrowserAsync(url).catch(() => {})} feel="select" accessibilityLabel={"Open " + host} style={{ height: 44, justifyContent: "center", paddingHorizontal: space.md }}>
        <T variant="subhead" weight="700" color="accentText">
          Open
        </T>
      </Tap>
    </View>
  );
}

/** A masked field for a secret, or the saved credential chosen in its place. */
function SecretInput({ label, hint, value, onChangeText, picked, onPick, onClear, onSubmit, disabled }: { label: string; hint?: string; value: string; onChangeText: (text: string) => void; picked?: Picked; onPick: (picked: Picked) => void; onClear: () => void; onSubmit?: () => void; disabled?: boolean }) {
  const { colors, dark, type } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: space.xs }}>
        <Lock size={12} color={colors.muted} strokeWidth={2.6} />
        <T variant="label" color="muted">
          {label}
        </T>
      </View>
      {picked ? (
        <View style={{ minHeight: 50, flexDirection: "row", alignItems: "center", paddingLeft: space.lg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}>
          <T variant="callout" weight="600" numberOfLines={1} style={{ flex: 1 }} accessibilityLabel={"Saved credential, " + picked.name}>
            {"•••• " + picked.name}
          </T>
          <Tap onPress={onClear} feel="select" accessibilityLabel="Don't use this credential" style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
            <X size={16} color={colors.muted} strokeWidth={2.4} />
          </Tap>
        </View>
      ) : (
        <TextInput
          value={value}
          onChangeText={onChangeText}
          secureTextEntry
          autoCorrect={false}
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
          contextMenuHidden
          editable={!disabled}
          returnKeyType={onSubmit ? "send" : "done"}
          onSubmitEditing={onSubmit}
          placeholder="Typed privately"
          placeholderTextColor={colors.faint}
          keyboardAppearance={dark ? "dark" : "light"}
          selectionColor={colors.accent}
          maxFontSizeMultiplier={1.3}
          accessibilityLabel={label + ", secret"}
          accessibilityHint={hint}
          style={[type.callout, { color: colors.ink, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space.lg, paddingVertical: 13, minHeight: 50 }]}
        />
      )}
      {!!hint && (
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
          {hint}
        </T>
      )}
      {!picked && <CredentialPicker disabled={disabled} onPick={(ref, name) => onPick({ ref, name })} />}
    </View>
  );
}

/** How a request is laid out: its body, which may scroll, and its buttons, which stay put. */
type Frame = (body: ReactNode, actions?: ReactNode) => ReactNode;

// --- The three kinds -------------------------------------------------------------------------

function Permission({ request, danger }: { request: AgentRequest; danger: boolean }) {
  const { colors, type } = useTheme();
  const { busy, respond } = useRespond(request);
  const always = () => void respond({ action: "remember" }, "remember");
  return (
    <>
      {!!request.preview && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ backgroundColor: danger ? colors.dangerSoft : colors.sunken, borderRadius: radius.md }} contentContainerStyle={{ paddingHorizontal: space.md, paddingVertical: 10 }}>
          <Text selectable maxFontSizeMultiplier={1.3} style={[type.mono, { color: colors.ink }]}>
            {request.preview}
          </Text>
        </ScrollView>
      )}
      {!!request.detail && (
        <T variant="footnote" color="muted" numberOfLines={2}>
          {request.detail}
        </T>
      )}
      {!!request.url && <LinkLine url={request.url} />}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <Button title="Deny" variant="secondary" style={{ flex: 1 }} loading={busy === "deny"} disabled={!!busy} onPress={() => void respond({ action: "deny" }, "deny")} />
        {danger ? (
          <HoldToAllow busy={busy === "approve"} disabled={!!busy} onConfirm={() => void respond({ action: "approve" }, "approve")} />
        ) : (
          <Button title="Allow" style={{ flex: 1 }} loading={busy === "approve"} disabled={!!busy} onPress={() => void respond({ action: "approve" }, "approve")} />
        )}
      </View>
      {!!request.remember && (
        <Button
          title="Always allow"
          variant="ghost"
          size="sm"
          wide
          loading={busy === "remember"}
          disabled={!!busy}
          onPress={
            danger
              ? () =>
                  Alert.alert("Always allow this?", request.remember + " won't ask again in this chat.", [
                    { text: "Cancel", style: "cancel" },
                    { text: "Always allow", style: "destructive", onPress: always },
                  ])
              : always
          }
          accessibilityLabel={"Always allow " + request.remember + " in this chat"}
        />
      )}
    </>
  );
}

function Question({ request, onPrivate }: { request: AgentRequest; onPrivate: () => void }) {
  const { busy, respond } = useRespond(request);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Picked>();
  const secret = looksSecret(request.title, request.label);
  const answer = async (value: string | CredentialRef, which: string) => {
    if (secret) {
      // Nothing secret stays on screen or in memory once it is on its way.
      setText("");
      setPicked(undefined);
      if (await respond({ action: "answer", value }, which)) onPrivate();
    } else void respond({ action: "answer", value }, which);
  };
  const free = text.trim();
  const ready = !!picked || !!free;
  const send = () => ready && void answer(picked ? picked.ref : free, "free");
  return (
    <>
      {!!request.url && <LinkLine url={request.url} />}
      {request.choices?.map((choice) => (
        <Button key={choice} title={choice} variant="secondary" wide loading={busy === choice} disabled={!!busy} onPress={() => void answer(choice, choice)} />
      ))}
      {(request.freeform || (secret && !request.choices?.length)) &&
        (secret ? (
          <View style={{ gap: space.sm }}>
            <SecretInput label={request.choices?.length ? "Something else" : "Your answer"} value={text} onChangeText={setText} picked={picked} onPick={setPicked} onClear={() => setPicked(undefined)} onSubmit={send} disabled={!!busy} />
            <Button title="Send privately" icon={Lock} wide disabled={!ready || !!busy} loading={busy === "free"} onPress={send} />
          </View>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
            <Field
              placeholder={request.choices?.length ? "Something else" : "Your answer"}
              value={text}
              onChangeText={setText}
              returnKeyType="send"
              onSubmitEditing={send}
              containerStyle={{ flex: 1 }}
              style={{ minHeight: 46, paddingVertical: 11 }}
            />
            <Button title="Send" disabled={!free || !!busy} loading={busy === "free"} onPress={send} />
          </View>
        ))}
      <Button title="Skip" variant="ghost" size="sm" wide disabled={!!busy} onPress={() => void respond({ action: "cancel" }, "cancel")} />
    </>
  );
}

const initialValue = (field: FormField, secret: boolean): unknown => {
  if (secret) return "";
  if (field.default !== undefined) return field.default;
  if (field.type === "boolean") return false;
  return field.type === "number" || field.type === "integer" ? undefined : "";
};
const choicesOf = (field: FormField) => field.oneOf?.map((option) => ({ value: option.const, label: option.title ?? option.const })) ?? field.enum?.map((value, index) => ({ value, label: field.enumNames?.[index] ?? value }));

function Form({ request, onPrivate, frame }: { request: AgentRequest; onPrivate: () => void; frame: Frame }) {
  const { colors } = useTheme();
  const { busy, respond } = useRespond(request);
  const properties = Object.entries(request.schema?.properties ?? {});
  const required = request.schema?.required ?? [];
  const secretKeys = properties.filter(([key, field]) => isSecretField(key, field)).map(([key]) => key);
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(properties.map(([key, field]) => [key, initialValue(field, isSecretField(key, field))])));
  const [picked, setPicked] = useState<Record<string, Picked>>({});
  const set = (key: string, value: unknown) => setValues({ ...values, [key]: value });
  const filled = (key: string) => !!picked[key] || (values[key] !== undefined && values[key] !== "");
  const ready = required.every(filled);
  const submit = async () => {
    const content: Record<string, unknown> = { ...values };
    for (const [key, choice] of Object.entries(picked)) content[key] = choice.ref;
    if (secretKeys.length) {
      // Nothing secret stays on screen or in memory once it is on its way.
      setValues((current) => ({ ...current, ...Object.fromEntries(secretKeys.map((key) => [key, ""])) }));
      setPicked({});
      if (await respond({ action: "accept", content }, "accept")) onPrivate();
    } else void respond({ action: "accept", content }, "accept");
  };
  return frame(
    <>
      {!!request.url && <LinkLine url={request.url} />}
      {properties.map(([key, field]) => {
        const label = field.title ?? key;
        if (secretKeys.includes(key))
          return (
            <SecretInput
              key={key}
              label={label}
              hint={field.description}
              value={typeof values[key] === "string" ? (values[key] as string) : ""}
              onChangeText={(text) => set(key, text)}
              picked={picked[key]}
              onPick={(choice) => setPicked({ ...picked, [key]: choice })}
              onClear={() => setPicked(Object.fromEntries(Object.entries(picked).filter(([name]) => name !== key)))}
              disabled={!!busy}
            />
          );
        const choices = choicesOf(field);
        if (field.type === "boolean")
          return (
            <View key={key} style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44 }}>
              <T variant="callout" style={{ flex: 1 }}>
                {label}
              </T>
              <Switch value={!!values[key]} onValueChange={(next) => set(key, next)} {...switchColors(colors, !!values[key])} accessibilityLabel={label} />
            </View>
          );
        if (choices)
          return (
            <View key={key} style={{ gap: space.sm }}>
              <T variant="label" color="muted" style={{ paddingHorizontal: space.xs }}>
                {label}
              </T>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                {choices.map((choice) => (
                  <Chip key={choice.value} label={choice.label} selected={values[key] === choice.value} onPress={() => set(key, choice.value)} />
                ))}
              </View>
            </View>
          );
        const numeric = field.type === "number" || field.type === "integer";
        return (
          <Field
            key={key}
            label={label}
            hint={field.description}
            value={values[key] === undefined ? "" : String(values[key])}
            keyboardType={numeric ? "decimal-pad" : field.format === "email" ? "email-address" : "default"}
            autoCapitalize={field.format === "email" || field.format === "uri" ? "none" : "sentences"}
            onChangeText={(text) => set(key, numeric ? (text.trim() === "" || Number.isNaN(Number(text)) ? undefined : Number(text)) : text)}
          />
        );
      })}
    </>,
    <View style={{ flexDirection: "row", gap: space.sm }}>
      <Button title="Cancel" variant="secondary" style={{ flex: 1 }} disabled={!!busy} loading={busy === "cancel"} onPress={() => void respond({ action: "cancel" }, "cancel")} />
      <Button title={secretKeys.length ? "Send" : "Submit"} icon={secretKeys.length ? Lock : undefined} accessibilityLabel={secretKeys.length ? "Send privately" : "Submit"} style={{ flex: 1 }} disabled={!ready || !!busy} loading={busy === "accept"} onPress={() => void submit()} />
    </View>,
  );
}

// --- The panel -------------------------------------------------------------------------------

export function RequestPanel({ request, bot, maxHeight }: { request: AgentRequest; bot?: Bot; maxHeight: number }) {
  const theme = useTheme();
  const { colors } = theme;
  // After a secret answer, one quiet line stands in until the bot moves on.
  const [sentPrivately, setSentPrivately] = useState(false);
  const danger = request.kind === "permission" && looksDangerous(request);

  if (sentPrivately)
    return (
      <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, paddingHorizontal: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
        <Lock size={15} color={colors.success} strokeWidth={2.4} />
        <T variant="subhead" weight="600" color="success">
          Sent privately
        </T>
      </View>
    );

  const head = (
    <View style={{ gap: 2 }}>
      <T variant="headline">{request.title}</T>
      {!!request.label && request.kind === "permission" && (
        <T variant="subhead" color="ink2" numberOfLines={2}>
          {request.label}
        </T>
      )}
      {!!request.detail && request.kind !== "permission" && (
        <T variant="subhead" color="muted" numberOfLines={3}>
          {request.detail}
        </T>
      )}
    </View>
  );
  // What may scroll, and under it the buttons that stay in view however little room there is.
  const frame: Frame = (body, actions) => (
    <>
      <ScrollView bounces={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, gap: space.md }} showsVerticalScrollIndicator={false}>
        {head}
        {body}
      </ScrollView>
      {!!actions && <View style={{ paddingHorizontal: space.lg, paddingBottom: space.lg }}>{actions}</View>}
    </>
  );

  return (
    <Animated.View entering={FadeInDown.duration(220)} style={[{ backgroundColor: colors.surface, borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth, borderColor: danger ? colors.danger : colors.lineStrong, overflow: "hidden", maxHeight }, lift(theme, 2)]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingTop: danger ? space.sm : space.md, paddingBottom: danger ? space.sm : 0, backgroundColor: danger ? colors.dangerSoft : undefined }} accessibilityRole="header">
        {danger ? <ShieldAlert size={18} color={colors.danger} strokeWidth={2.4} /> : bot ? <BotAvatar bot={bot} size={24} state="waiting" /> : <Hand size={16} color={colors.warning} strokeWidth={2.4} />}
        <T variant="footnote" weight="700" color={danger ? "danger" : "warning"} numberOfLines={1} style={{ flex: 1 }}>
          {(bot?.name ?? "Your bot") + (danger ? " wants to do something risky" : " needs you")}
        </T>
      </View>
      {request.kind === "permission" ? (
        frame(<Permission request={request} danger={danger} />)
      ) : request.kind === "question" ? (
        frame(<Question request={request} onPrivate={() => setSentPrivately(true)} />)
      ) : (
        <Form key={request.id} request={request} onPrivate={() => setSentPrivately(true)} frame={frame} />
      )}
    </Animated.View>
  );
}
