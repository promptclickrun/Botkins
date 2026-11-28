// A secure input ("secure-input-v1"): a bot asks for a password, a one-time code, a secret or a
// user name, and what is typed goes to the computer only. The bot gets a handle it can pass to its
// tools; the computer puts the value in at the moment of use, so it never lands in the chat.
//
// The rules for a value, which are the point of this card:
// - It lives only in the field that types it (a ref in `Field`), never in this card's state, the
//   store, a route, a log, a toast, an error, the composer or anything saved with keep.ts. The card
//   only learns whether a field has something in it.
// - It is read once, when the answer is sent, and cleared when the answer has gone or was declined,
//   and when the card goes away. A send that fails keeps the fields and says only SEND_FAILED.
// - A masked field can use a saved credential instead: its reference is sent, and the computer fills
//   in the value, which is never on the phone.
// - Every word shown or read aloud comes from the request's title and labels.
import { Eye, EyeOff, Lock, ShieldCheck, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { TextInput, type TextInputInstance, View } from "react-native";
import { CredentialPicker } from "@/features/credentials/CredentialPicker";
import type { AgentRequest, Bot, CredentialRef, SecureField } from "@/link/types";
import { api } from "@/state/link";
import { showToast } from "@/state/store";
import { Button, haptic, radius, space, T, Tap, useTheme } from "@/ui";
import { wordsFor } from "./logic";
import { Frame, Pair, type Picked, useReveal } from "./parts";
import { fieldLabel, fieldProps, hasValue, promiseLine, returnKeyOf, SEND_FAILED, secureContent, secureReady, toggleLabel } from "./secure";

/** What the card may do with a field: read its value at the moment of sending, clear it, focus it. */
type Handle = { read: () => string | CredentialRef | undefined; clear: () => void; focus: () => void };

function Field({ field, index, count, register, onFilled, onSubmit, disabled }: { field: SecureField; index: number; count: number; register: (key: string, handle: Handle | null) => void; onFilled: (key: string, filled: boolean) => void; onSubmit: (index: number) => void; disabled: boolean }) {
  const { colors, dark, type, control } = useTheme();
  const kind = fieldProps(field.kind);
  // The value, here and nowhere else.
  const value = useRef("");
  const input = useRef<TextInputInstance>(null);
  const [picked, setPicked] = useState<Picked>();
  const [shown, setShown] = useState(false);
  const { ref, onFocus, onBlur } = useReveal();
  const label = fieldLabel(field);
  const key = field.key;

  useEffect(() => {
    register(key, {
      read: () => (picked ? picked.ref : value.current),
      clear: () => {
        value.current = "";
        input.current?.clear();
        setPicked(undefined);
        setShown(false);
        onFilled(key, false);
      },
      focus: () => input.current?.focus(),
    });
    return () => register(key, null);
  }, [key, picked, register, onFilled]);
  // When the card goes away, so does what was typed.
  useEffect(() => {
    const typed = value;
    return () => {
      typed.current = "";
    };
  }, []);

  const padV = Math.max(8, Math.round((control.field - type.callout.lineHeight) / 2));
  const box = { minHeight: control.field, flexDirection: "row", alignItems: "center", borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.canvas } as const;
  return (
    <View ref={ref} style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm, paddingHorizontal: space.xs }}>
        <T variant="subhead" weight="700" style={{ flexShrink: 1 }}>
          {field.label.trim()}
        </T>
        {!!field.optional && (
          <T variant="footnote" color="muted">
            Optional
          </T>
        )}
      </View>
      {!!field.hint && (
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: -2 }}>
          {field.hint}
        </T>
      )}
      {picked ? (
        <View style={[box, { paddingLeft: space.lg }]}>
          <T variant="callout" weight="600" style={{ flex: 1 }} accessibilityLabel={label + ", saved credential " + picked.name}>
            {"•••• " + picked.name}
          </T>
          <Tap
            onPress={() => {
              setPicked(undefined);
              onFilled(key, hasValue(field.kind, value.current));
            }}
            feel="select"
            accessibilityLabel="Don't use this credential"
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <X size={16} color={colors.muted} strokeWidth={2.4} />
          </Tap>
        </View>
      ) : (
        <View style={box}>
          <TextInput
            ref={input}
            onChangeText={(text) => {
              value.current = text;
              onFilled(key, hasValue(field.kind, text));
            }}
            onFocus={onFocus}
            onBlur={onBlur}
            secureTextEntry={kind.masked && !shown}
            textContentType={kind.textContentType}
            autoComplete={kind.autoComplete}
            keyboardType={kind.keyboardType}
            importantForAutofill={kind.importantForAutofill}
            autoCorrect={false}
            spellCheck={false}
            autoCapitalize="none"
            smartInsertDelete={false}
            returnKeyType={returnKeyOf(index, count)}
            submitBehavior={index < count - 1 ? "submit" : "blurAndSubmit"}
            onSubmitEditing={() => onSubmit(index)}
            editable={!disabled}
            keyboardAppearance={dark ? "dark" : "light"}
            selectionColor={colors.accent}
            maxFontSizeMultiplier={1.3}
            accessibilityLabel={label}
            accessibilityHint={field.hint}
            style={[field.kind === "code" ? { ...type.callout, letterSpacing: 2 } : type.callout, { flex: 1, color: colors.ink, paddingLeft: space.lg, paddingRight: kind.masked ? 0 : space.lg, paddingVertical: padV, minHeight: control.field }]}
          />
          {kind.masked && (
            <Tap onPress={() => setShown(!shown)} feel="select" sink={0.9} accessibilityLabel={toggleLabel(shown, field.label)} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", marginRight: 2 }}>
              {shown ? <EyeOff size={18} color={colors.muted} strokeWidth={2.2} /> : <Eye size={18} color={colors.muted} strokeWidth={2.2} />}
            </Tap>
          )}
        </View>
      )}
      {!picked && (
        <CredentialPicker
          disabled={disabled}
          onPick={(credential, name) => {
            value.current = "";
            input.current?.clear();
            setPicked({ ref: credential, name });
            onFilled(key, true);
          }}
        />
      )}
    </View>
  );
}

/** The body and buttons of a secure input. `fields` are the request's, already checked (`secureFieldsOf`). */
export function SecureInput({ request, fields, bot, room, onSent }: { request: AgentRequest; fields: SecureField[]; bot?: Bot; room: number; onSent: () => void }) {
  const { colors } = useTheme();
  const words = wordsFor("secure");
  const handles = useRef(new Map<string, Handle>());
  const [filled, setFilled] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<"send" | "decline" | null>(null);
  const ready = secureReady(
    fields,
    fields.filter((field) => filled[field.key]).map((field) => field.key),
  );

  const register = (key: string, handle: Handle | null) => {
    if (handle) handles.current.set(key, handle);
    else handles.current.delete(key);
  };
  const onFilled = (key: string, on: boolean) => setFilled((now) => (!!now[key] === on ? now : { ...now, [key]: on }));
  const clearAll = () => {
    for (const handle of handles.current.values()) handle.clear();
  };

  const send = async () => {
    if (!ready || busy) return;
    setBusy("send");
    try {
      // Read from each field at this moment, sent, and not kept.
      await api.respond(request.id, { action: "accept", content: secureContent(fields, (key) => handles.current.get(key)?.read()) });
      clearAll();
      haptic.success();
      onSent();
    } catch {
      // Nothing about what was typed: the fields keep it, to try again.
      showToast(SEND_FAILED, "error");
    }
    setBusy(null);
  };
  const decline = async () => {
    if (busy) return;
    clearAll();
    setBusy("decline");
    try {
      await api.respond(request.id, { action: "cancel" });
    } catch {
      showToast(SEND_FAILED, "error");
    }
    setBusy(null);
  };
  const next = (index: number) => {
    if (index < fields.length - 1) handles.current.get(fields[index + 1].key)?.focus();
    else if (ready) void send();
    else {
      const empty = fields.find((field) => !field.optional && !filled[field.key]);
      if (empty) handles.current.get(empty.key)?.focus();
    }
  };

  return (
    <Frame
      room={room}
      actions={
        <Pair
          quiet={{ label: words.quiet, render: (style) => <Button title={words.quiet} variant="secondary" style={style} loading={busy === "decline"} disabled={!!busy} onPress={() => void decline()} /> }}
          main={{
            label: words.main,
            extra: 27,
            render: (style) => <Button title={words.main} icon={Lock} style={style} loading={busy === "send"} disabled={!ready || !!busy} onPress={() => void send()} />,
          }}
        />
      }
    >
      <View style={{ gap: space.xs }}>
        <T variant="headline" selectable>
          {request.title}
        </T>
        {!!request.detail && (
          <T variant="subhead" color="ink2" selectable>
            {request.detail}
          </T>
        )}
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.infoSoft }}>
        <ShieldCheck size={18} color={colors.info} strokeWidth={2.2} style={{ marginTop: 1 }} />
        <T variant="subhead" color="ink" style={{ flex: 1 }}>
          {promiseLine(bot?.name, fields.length)}
        </T>
      </View>
      {fields.map((field, index) => (
        <Field key={field.key} field={field} index={index} count={fields.length} register={register} onFilled={onFilled} onSubmit={next} disabled={!!busy} />
      ))}
    </Frame>
  );
}
