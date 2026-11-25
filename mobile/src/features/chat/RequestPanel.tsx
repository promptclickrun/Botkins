// What a bot is waiting on, docked above the composer: an approval, a question, a form or a secure
// input. Every word can be read: the question, each choice and a command wrap onto as many lines as
// they need, and when the card is taller than its room its body scrolls while the buttons stay in
// reach. The heading folds the card to one line ("Gordie has a question") so the chat behind it
// can be read, and opens it again. The words and the behaviour are the desktop app's
// (desktop/src/RequestPanel.tsx): a choice is picked, then sent with "Send answer".
//
// Secrets are typed masked or picked from saved credentials (the computer fills those in, so the
// value never reaches the phone), and are cleared the moment the answer goes. A request that looks
// destructive turns red and asks for a press-and-hold on Allow. A secure input (request/SecureInput)
// sends its values to the computer only. The plain logic is in request/logic.ts and
// request/secure.ts, tested by tests/requests.test.ts.
import { ChevronDown, ChevronUp, CircleHelp, Hand, Lock, ShieldAlert } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Alert, Keyboard, StyleSheet, Switch, type TextInputInstance, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import type { AgentRequest, Bot, FormField, RequestAnswer } from "@/link/types";
import { api, attempt } from "@/state/link";
import { BotAvatar, Button, Field, haptic, lift, radius, space, switchColors, T, Tap, useTheme } from "@/ui";
import { shownText } from "@/ui/shownText";
import {
  answerOf,
  choicesOf,
  countLabel,
  DETACHED_LINE,
  detailMode,
  foldHint,
  formReady,
  freeAnswerShown,
  heading,
  headerLabel,
  initialValue,
  isSecretField,
  looksDangerous,
  looksSecret,
  rememberNote,
  splitChoice,
  wordsFor,
} from "./request/logic";
import { AnswerField, ChoiceRow, Code, Disclosure, Frame, HOLD_EXTRA, HoldToAllow, LinkLine, Pair, type Picked, SecretInput, useReveal } from "./request/parts";
import { isKnownKind, secureFieldsOf, UNKNOWN_LINE } from "./request/secure";
import { SecureInput } from "./request/SecureInput";

export { looksDangerous, looksSecret } from "./request/logic";

/** What the lock icon beside a button's label adds to its width. */
const ICON_EXTRA = 27;

function useRespond(request: AgentRequest) {
  const [busy, setBusy] = useState<string | null>(null);
  const respond = async (answer: RequestAnswer, which: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(which);
    // A request that holds a script is shown whole in this panel (detailMode): it says so, and nothing else (a notification, a Live Activity) does.
    const shownWhole = request.review && ["approve", "today", "remember"].includes(answer.action);
    const done = await attempt(api.respond(request.id, shownWhole ? { ...answer, reviewed: true } : answer).then(() => true));
    if (done) haptic.success();
    setBusy(null);
    return !!done;
  };
  return { busy, respond };
}

/** The title, and the label under it when there is one. Both can be selected and copied. */
function Head({ request }: { request: AgentRequest }) {
  // An approval is a decision: its words are shown made safe to read (a mark that turns text around can't make one command read as another).
  const safe = request.kind === "permission";
  return (
    <View style={{ gap: space.xs }}>
      <T variant="headline" selectable>
        {safe ? shownText(request.title) : request.title}
      </T>
      {!!request.label && (
        <T variant="subhead" color="muted" selectable>
          {safe ? shownText(request.label, { lines: true }) : request.label}
        </T>
      )}
    </View>
  );
}

/** The full request: under "Full request" when there is a preview, else shown. */
function Detail({ request }: { request: AgentRequest }) {
  const mode = detailMode(request);
  if (mode === "none" || !request.detail) return null;
  // An approval's full request is read for a decision too (a plugin's whole description can be in it): its lines stay, nothing else hides.
  const detail = request.kind === "permission" ? shownText(request.detail, { lines: true }) : request.detail;
  if (mode === "folded")
    return (
      <Disclosure title="Full request">
        <Code>{detail}</Code>
      </Disclosure>
    );
  return <Code>{detail}</Code>;
}

// --- The kinds ---------------------------------------------------------------------------------

function Permission({ request, danger, room }: { request: AgentRequest; danger: boolean; room: number }) {
  const { busy, respond } = useRespond(request);
  const words = wordsFor("permission", request.dispatch);
  const approve = () => void respond({ action: "approve" }, "approve");
  const always = () => void respond({ action: "remember" }, "remember");
  return (
    <Frame
      room={room}
      actions={
        <View style={{ gap: space.xs }}>
          <Pair
            quiet={{ label: words.quiet, render: (style) => <Button title={words.quiet} variant="secondary" style={style} loading={busy === "deny"} disabled={!!busy} onPress={() => void respond({ action: "deny" }, "deny")} /> }}
            main={
              danger
                ? { label: "Hold to " + words.main.toLowerCase(), extra: HOLD_EXTRA, render: (style) => <HoldToAllow label={words.main} style={style} busy={busy === "approve"} disabled={!!busy} onConfirm={approve} /> }
                : { label: words.main, render: (style) => <Button title={words.main} style={style} loading={busy === "approve"} disabled={!!busy} onPress={approve} /> }
            }
          />
          {request.dispatch && (
            <Button title="Allow for today" variant="secondary" wide loading={busy === "today"} disabled={!!busy} onPress={() => void respond({ action: "today" }, "today")} />
          )}
          {(request.dispatch || !!request.remember) && !!words.remember && (
            <Button
              title={words.remember}
              variant="ghost"
              size="sm"
              wide
              loading={busy === "remember"}
              disabled={!!busy}
              onPress={
                danger
                  ? () =>
                      Alert.alert(words.remember + "?", request.remember + " won't ask again in this chat.", [
                        { text: "Cancel", style: "cancel" },
                        { text: words.remember ?? "Allow", style: "destructive", onPress: always },
                      ])
                  : always
              }
              accessibilityLabel={request.dispatch ? words.remember : "Allow " + request.remember + " for this chat"}
            />
          )}
        </View>
      }
    >
      <Head request={request} />
      {!!request.preview && <Code danger={danger}>{shownText(request.preview, { lines: true })}</Code>}
      <Detail request={request} />
      {!!request.url && <LinkLine url={request.url} />}
      {!!request.remember && !request.dispatch && (
        <T variant="footnote" color="muted">
          {rememberNote(request.remember)}
        </T>
      )}
    </Frame>
  );
}

function Question({ request, room, onPrivate }: { request: AgentRequest; room: number; onPrivate: () => void }) {
  const { busy, respond } = useRespond(request);
  const words = wordsFor("question");
  const [choice, setChoice] = useState<string>();
  // What is typed: the free answer, or a secret while it is being typed (cleared when it is sent).
  const [typed, setTyped] = useState("");
  const [picked, setPicked] = useState<Picked>();
  const field = useRef<TextInputInstance>(null);
  const secret = looksSecret(request.title, request.label);
  const choices = request.choices ?? [];
  const answer = picked ? picked.ref : answerOf(choice, typed);

  const choose = (next: string) => {
    setChoice(next);
    // One answer at a time: picking a choice empties what was typed.
    if (typed) {
      field.current?.clear();
      setTyped("");
    }
    setPicked(undefined);
  };
  const onType = (text: string) => {
    setTyped(text);
    if (text.trim()) setChoice(undefined);
  };
  const send = async () => {
    if (!answer) return;
    if (secret) {
      // Nothing secret stays on screen or in memory once it is on its way.
      setTyped("");
      setPicked(undefined);
      if (await respond({ action: "answer", value: answer }, "send")) onPrivate();
    } else void respond({ action: "answer", value: answer }, "send");
  };

  return (
    <Frame
      room={room}
      actions={
        <Pair
          quiet={{ label: words.quiet, render: (style) => <Button title={words.quiet} variant="secondary" style={style} loading={busy === "cancel"} disabled={!!busy} onPress={() => void respond({ action: "cancel" }, "cancel")} /> }}
          main={{
            label: words.main,
            extra: secret ? ICON_EXTRA : 0,
            render: (style) => <Button title={words.main} icon={secret ? Lock : undefined} accessibilityLabel={secret ? "Send answer privately" : undefined} style={style} loading={busy === "send"} disabled={!answer || !!busy} onPress={() => void send()} />,
          }}
        />
      }
    >
      <Head request={request} />
      {!!request.detached && (
        <T variant="footnote" color="muted">
          {DETACHED_LINE}
        </T>
      )}
      <Detail request={request} />
      {!!request.url && <LinkLine url={request.url} />}
      {choices.length > 0 && (
        <View accessibilityRole="radiogroup" style={{ gap: space.sm }}>
          {choices.map((option, index) => (
            <ChoiceRow key={index + ":" + option} parts={splitChoice(option)} selected={choice === option} disabled={!!busy} onPress={() => choose(option)} />
          ))}
        </View>
      )}
      {freeAnswerShown(request) &&
        (secret ? (
          <SecretInput label="Your answer" value={typed} onChangeText={onType}
            picked={picked}
            onPick={(next) => {
              setPicked(next);
              setChoice(undefined);
            }} onClear={() => setPicked(undefined)} disabled={!!busy} />
        ) : (
          <AnswerField text={typed} onChangeText={onType} inputRef={field} label="Your answer" disabled={!!busy} />
        ))}
    </Frame>
  );
}

/** A form's text or number field, kept in view when focused. */
function FormText({ label, field, value, onChange, disabled }: { label: string; field: FormField; value: unknown; onChange: (value: unknown) => void; disabled: boolean }) {
  const { ref, onFocus, onBlur } = useReveal();
  const numeric = field.type === "number" || field.type === "integer";
  return (
    <View ref={ref}>
      <Field
        label={label}
        hint={field.description}
        value={value === undefined ? "" : String(value)}
        editable={!disabled}
        onFocus={onFocus}
        onBlur={onBlur}
        keyboardType={numeric ? "decimal-pad" : field.format === "email" ? "email-address" : "default"}
        autoCapitalize={field.format === "email" || field.format === "uri" ? "none" : "sentences"}
        onChangeText={(text) => onChange(numeric ? (text.trim() === "" || Number.isNaN(Number(text)) ? undefined : Number(text)) : text)}
      />
    </View>
  );
}

function Form({ request, room, onPrivate }: { request: AgentRequest; room: number; onPrivate: () => void }) {
  const { colors } = useTheme();
  const { busy, respond } = useRespond(request);
  const words = wordsFor("form");
  const properties = Object.entries(request.schema?.properties ?? {});
  const required = request.schema?.required ?? [];
  const secretKeys = properties.filter(([key, field]) => isSecretField(key, field)).map(([key]) => key);
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(properties.map(([key, field]) => [key, initialValue(field, isSecretField(key, field))])));
  const [picked, setPicked] = useState<Record<string, Picked>>({});
  const set = (key: string, value: unknown) => setValues((now) => ({ ...now, [key]: value }));
  const ready = formReady(required, values, Object.keys(picked));
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
  return (
    <Frame
      room={room}
      actions={
        <Pair
          quiet={{ label: words.quiet, render: (style) => <Button title={words.quiet} variant="secondary" style={style} loading={busy === "cancel"} disabled={!!busy} onPress={() => void respond({ action: "cancel" }, "cancel")} /> }}
          main={{
            label: words.main,
            extra: secretKeys.length ? ICON_EXTRA : 0,
            render: (style) => <Button title={words.main} icon={secretKeys.length ? Lock : undefined} accessibilityLabel={secretKeys.length ? "Send answer privately" : undefined} style={style} loading={busy === "accept"} disabled={!ready || !!busy} onPress={() => void submit()} />,
          }}
        />
      }
    >
      <Head request={request} />
      <Detail request={request} />
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
              onPick={(choice) => setPicked((now) => ({ ...now, [key]: choice }))}
              onClear={() => setPicked((now) => Object.fromEntries(Object.entries(now).filter(([name]) => name !== key)))}
              disabled={!!busy}
            />
          );
        if (field.type === "boolean")
          return (
            <View key={key} style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <T variant="callout">{label}</T>
                {!!field.description && (
                  <T variant="footnote" color="muted">
                    {field.description}
                  </T>
                )}
              </View>
              <Switch value={!!values[key]} disabled={!!busy} onValueChange={(next) => set(key, next)} {...switchColors(colors, !!values[key])} accessibilityLabel={label} />
            </View>
          );
        const choices = choicesOf(field);
        if (choices)
          return (
            <View key={key} style={{ gap: space.sm }}>
              <T variant="label" color="muted" style={{ paddingHorizontal: space.xs }}>
                {label}
              </T>
              {!!field.description && (
                <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
                  {field.description}
                </T>
              )}
              <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ gap: space.sm }}>
                {choices.map((choice) => (
                  <ChoiceRow key={choice.value} parts={{ label: choice.label }} selected={values[key] === choice.value} disabled={!!busy} onPress={() => set(key, choice.value)} />
                ))}
              </View>
            </View>
          );
        return <FormText key={key} label={label} field={field} value={values[key]} onChange={(value) => set(key, value)} disabled={!!busy} />;
      })}
    </Frame>
  );
}

/** A request this phone can't answer (a kind from a newer computer, or a secure input with nothing to fill): its title, a line, and a way to dismiss it. Nothing is guessed. */
function Unknown({ request, room }: { request: AgentRequest; room: number }) {
  const { busy, respond } = useRespond(request);
  return (
    <Frame room={room} actions={<Button title="Dismiss" variant="secondary" wide loading={!!busy} disabled={!!busy} onPress={() => void respond({ action: "cancel" }, "cancel")} />}>
      <T variant="headline" selectable>
        {request.title}
      </T>
      <T variant="subhead" color="muted">
        {UNKNOWN_LINE}
      </T>
    </Frame>
  );
}

// --- The panel -------------------------------------------------------------------------------

/**
 * The card for a bot's request. `count` is how many requests wait in the chat ("1 of 3" beside the
 * heading). `maxHeight` is the most room the card may take; past it, its body scrolls.
 */
export function RequestPanel({ request, bot, maxHeight, count }: { request: AgentRequest; bot?: Bot; maxHeight: number; count?: number }) {
  const theme = useTheme();
  const { colors } = theme;
  const [open, setOpen] = useState(true);
  // After a secret answer, one quiet line stands in until the bot moves on.
  const [sent, setSent] = useState<string | null>(null);
  const kind = request.kind;
  const danger = kind === "permission" && !request.dispatch && looksDangerous(request);
  const secure = kind === "secure";
  const secureFields = secure ? secureFieldsOf(request) : [];
  const title = heading(kind, bot?.name, danger);
  const of = countLabel(count);
  const tone = danger ? "danger" : secure ? "info" : "warning";
  // The card's room under its heading.
  const room = Math.max(120, maxHeight - Math.max(52, theme.control.row));

  // A screen reader hears that a bot is waiting.
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(title);
  }, [title]);

  if (sent)
    return (
      <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, paddingHorizontal: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
        <Lock size={15} color={colors.success} strokeWidth={2.4} />
        <T variant="subhead" weight="600" color="success">
          {sent}
        </T>
      </View>
    );

  const toggle = () => {
    if (open) Keyboard.dismiss();
    setOpen(!open);
  };
  const Fold = open ? ChevronDown : ChevronUp;
  const mark = danger ? (
    <ShieldAlert size={18} color={colors.danger} strokeWidth={2.4} />
  ) : secure ? (
    <Lock size={17} color={colors.info} strokeWidth={2.5} />
  ) : !isKnownKind(kind) ? (
    <CircleHelp size={18} color={colors.warning} strokeWidth={2.4} />
  ) : bot ? (
    <BotAvatar bot={bot} size={24} state="waiting" />
  ) : (
    <Hand size={16} color={colors.warning} strokeWidth={2.4} />
  );

  return (
    <Animated.View entering={FadeInDown.duration(220)} style={[{ backgroundColor: colors.surface, borderRadius: radius.lg, maxHeight }, lift(theme, 2)]}>
      <View style={{ flexShrink: 1, borderRadius: radius.lg, overflow: "hidden", borderWidth: danger || secure ? 1 : StyleSheet.hairlineWidth, borderColor: danger ? colors.danger : secure ? colors.info : colors.lineStrong }}>
        <Tap
          onPress={toggle}
          feel="select"
          sink={1}
          hitSlop={0}
          accessibilityRole="button"
          accessibilityLabel={headerLabel(request, { bot: bot?.name, danger, count })}
          accessibilityHint={foldHint(open)}
          accessibilityState={{ expanded: open }}
          style={{ minHeight: Math.max(52, theme.control.row), flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.xs, backgroundColor: danger ? colors.dangerSoft : secure ? colors.infoSoft : undefined }}
        >
          {mark}
          <T variant="subhead" weight="700" color={tone} numberOfLines={open ? undefined : 1} style={{ flex: 1 }}>
            {title}
          </T>
          {!!of && (
            <T variant="footnote" weight="600" color="muted">
              {of}
            </T>
          )}
          <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.sunken, alignItems: "center", justifyContent: "center" }}>
            <Fold size={18} color={colors.muted} strokeWidth={2.4} />
          </View>
        </Tap>
        {/* Folded, the body is hidden but kept, so nothing typed or chosen is lost. */}
        <View style={{ flexShrink: 1, display: open ? "flex" : "none" }}>
          {kind === "permission" ? (
            <Permission request={request} danger={danger} room={room} />
          ) : kind === "question" ? (
            <Question request={request} room={room} onPrivate={() => setSent("Sent privately")} />
          ) : kind === "form" ? (
            <Form key={request.id} request={request} room={room} onPrivate={() => setSent("Sent privately")} />
          ) : secure && secureFields.length > 0 ? (
            <SecureInput request={request} fields={secureFields} bot={bot} room={room} onSent={() => setSent("Sent securely")} />
          ) : (
            <Unknown request={request} room={room} />
          )}
        </View>
      </View>
    </Animated.View>
  );
}
