// The pieces of a request card (RequestPanel.tsx): the frame that scrolls and keeps the buttons in
// reach, a choice as a full-width row, a field that grows with its text, a masked field, code in
// mono, a fold for the full request, the press-and-hold Allow, and two buttons that sit side by
// side only when neither label would be cut.
import * as WebBrowser from "expo-web-browser";
import { Check, ChevronDown, ChevronRight, Globe, Lock, X } from "lucide-react-native";
import { createContext, type ReactNode, type Ref, useContext, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Alert, Pressable, ScrollView, type ScrollViewInstance, StyleSheet, Text, TextInput, type TextInputInstance, useWindowDimensions, View, type ViewInstance, type ViewStyle } from "react-native";
import Animated, { useAnimatedProps, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { CredentialPicker } from "@/features/credentials/CredentialPicker";
import type { CredentialRef } from "@/link/types";
import { Button, haptic, radius, space, T, Tap, useTheme } from "@/ui";
import { type ChoiceParts, choiceLabel, emFor, fitsSideBySide, hostOf } from "./logic";

export type Picked = { ref: CredentialRef; name: string };

// --- Keeping a focused field in view -------------------------------------------------------

type Revealer = { focus: (view: ViewInstance | null) => void; blur: (view: ViewInstance | null) => void };
const RevealContext = createContext<Revealer>({ focus: () => {}, blur: () => {} });

/**
 * For a field inside a card: put `ref` on a View around it and pass `onFocus` and `onBlur` to its
 * input. The card then scrolls the field into view when it is focused, and again when the keyboard
 * makes the card smaller or the field grows.
 */
export function useReveal() {
  const revealer = useContext(RevealContext);
  const ref = useRef<ViewInstance>(null);
  return { ref, onFocus: () => revealer.focus(ref.current), onBlur: () => revealer.blur(ref.current) };
}

/**
 * A card's body, which scrolls inside the card when it is taller than the room, and under it the
 * buttons, which stay put. When even the buttons would take most of the room (the largest text
 * with the keyboard up), they go at the end of what scrolls, so the body is never squeezed away.
 */
export function Frame({ children, actions, room }: { children: ReactNode; actions?: ReactNode; room: number }) {
  const { colors } = useTheme();
  const scroll = useRef<ScrollViewInstance>(null);
  const content = useRef<ViewInstance>(null);
  const focused = useRef<ViewInstance | null>(null);
  const offset = useRef(0);
  const viewport = useRef(0);
  const contentHeight = useRef(0);
  const flashed = useRef(false);
  const [overflow, setOverflow] = useState(false);
  const [actionsHeight, setActionsHeight] = useState(0);
  const tight = actionsHeight > room * 0.45;

  const reveal = () => {
    const target = focused.current;
    const inner = content.current;
    if (!target || !inner) return;
    target.measureLayout(inner, (_x, y, _width, height) => {
      const top = offset.current;
      const seen = viewport.current;
      const pad = space.md;
      if (y + height + pad > top + seen) scroll.current?.scrollTo({ y: Math.max(0, y + height + pad - seen), animated: true });
      else if (y - pad < top) scroll.current?.scrollTo({ y: Math.max(0, y - pad), animated: true });
    });
  };
  const revealer: Revealer = {
    focus: (view) => {
      focused.current = view;
      // After the keyboard has made the card smaller.
      setTimeout(reveal, 280);
    },
    blur: (view) => {
      if (focused.current === view) focused.current = null;
    },
  };
  const measure = () => {
    const over = contentHeight.current > viewport.current + 1;
    setOverflow(over);
    // Not while the card is folded (no height): the flash would be missed.
    if (over && viewport.current > 0 && !flashed.current) {
      // Says once that there is more below.
      flashed.current = true;
      scroll.current?.flashScrollIndicators();
    }
  };

  const buttons = actions ? <View onLayout={(event) => setActionsHeight(Math.ceil(event.nativeEvent.layout.height))}>{actions}</View> : null;
  return (
    <RevealContext.Provider value={revealer}>
      <ScrollView
        ref={scroll}
        style={{ flexShrink: 1 }}
        keyboardShouldPersistTaps="handled"
        alwaysBounceVertical={false}
        scrollEventThrottle={32}
        onScroll={(event) => {
          offset.current = event.nativeEvent.contentOffset.y;
        }}
        onLayout={(event) => {
          viewport.current = event.nativeEvent.layout.height;
          measure();
          reveal();
        }}
        onContentSizeChange={(_width, height) => {
          contentHeight.current = height;
          measure();
          reveal();
        }}
      >
        <View ref={content} style={{ paddingHorizontal: space.lg, paddingTop: space.xs, paddingBottom: tight ? space.lg : space.md, gap: space.md }}>
          {children}
          {tight && buttons}
        </View>
      </ScrollView>
      {!tight && !!buttons && <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.lg, borderTopWidth: overflow ? StyleSheet.hairlineWidth : 0, borderTopColor: colors.line }}>{buttons}</View>}
    </RevealContext.Provider>
  );
}

// --- Choices --------------------------------------------------------------------------------

/** One choice: a full-width row, its label and description wrapping as far as they need, checked when chosen. */
export function ChoiceRow({ parts, selected, onPress, disabled }: { parts: ChoiceParts; selected: boolean; onPress: () => void; disabled?: boolean }) {
  const { colors, control } = useTheme();
  const mark = 22;
  return (
    <Pressable
      onPress={() => {
        haptic.select();
        onPress();
      }}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={choiceLabel(parts)}
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      style={({ pressed }) => ({
        minHeight: Math.max(44, control.field),
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingVertical: space.sm + 2,
        paddingLeft: space.md + 2,
        paddingRight: space.md,
        borderRadius: radius.md,
        borderWidth: 1.5,
        borderColor: selected ? colors.accent : pressed ? colors.lineStrong : colors.line,
        backgroundColor: selected ? colors.accentSoft : pressed ? colors.sunken : "transparent",
        opacity: disabled && !selected ? 0.5 : 1,
      })}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="callout" weight="600">
          {parts.label}
        </T>
        {!!parts.description && (
          <T variant="subhead" color="muted">
            {parts.description}
          </T>
        )}
      </View>
      <View style={{ width: mark, height: mark, borderRadius: mark / 2, borderWidth: selected ? 0 : 1.5, borderColor: colors.lineStrong, backgroundColor: selected ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
        {selected && <Check size={14} color={colors.onAccent} strokeWidth={3} />}
      </View>
    </Pressable>
  );
}

// --- Fields ---------------------------------------------------------------------------------

const MAX_LINES = 6;

/**
 * A typed answer that grows with its text, from one line to six, then scrolls inside. Like the
 * composer, the field keeps its own text (handing it back between keystrokes resets the iPhone's
 * autocorrect), and its height comes from a hidden copy of `text` drawn at the same width and type.
 * Empty it with `inputRef.current.clear()`.
 */
export function AnswerField({ text, onChangeText, inputRef, label, disabled }: { text: string; onChangeText: (text: string) => void; inputRef: Ref<TextInputInstance>; label: string; disabled?: boolean }) {
  const { colors, dark, type, control } = useTheme();
  const { fontScale } = useWindowDimensions();
  const { ref, onFocus, onBlur } = useReveal();
  const [textHeight, setTextHeight] = useState(0);
  const border = 1;
  const padV = Math.max(8, Math.round((control.field - type.callout.lineHeight) / 2)) - border;
  const padH = space.lg;
  const line = type.callout.lineHeight * Math.min(Math.max(fontScale, 1), 1.3);
  const chrome = padV * 2 + border * 2;
  const tallest = Math.ceil(line * MAX_LINES) + chrome;
  const height = Math.max(control.field, Math.min(tallest, textHeight + chrome));
  return (
    <View ref={ref}>
      <TextInput
        ref={inputRef}
        multiline
        onChangeText={onChangeText}
        onFocus={onFocus}
        onBlur={onBlur}
        editable={!disabled}
        placeholder={label}
        placeholderTextColor={colors.faint}
        keyboardAppearance={dark ? "dark" : "light"}
        selectionColor={colors.accent}
        maxFontSizeMultiplier={1.3}
        accessibilityLabel={label}
        textAlignVertical="top"
        scrollEnabled={textHeight + chrome > tallest}
        style={[type.callout, { color: colors.ink, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: border, borderColor: colors.line, paddingHorizontal: padH, paddingTop: padV, paddingBottom: padV, height }]}
      />
      {/* The hidden copy that says how tall the field should be. A line break at the end gets a character after it, so the new line counts. */}
      <Text
        onLayout={(event) => setTextHeight(Math.ceil(event.nativeEvent.layout.height))}
        maxFontSizeMultiplier={1.3}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[type.callout, { position: "absolute", top: 0, left: padH + border, right: padH + border, opacity: 0 }]}
      >
        {text.endsWith("\n") ? text + "​" : text || " "}
      </Text>
    </View>
  );
}

/** A masked field for a secret, or the saved credential chosen in its place. Paste works; the phone never lets a masked field be copied. */
export function SecretInput({ label, hint, value, onChangeText, picked, onPick, onClear, disabled }: { label: string; hint?: string; value: string; onChangeText: (text: string) => void; picked?: Picked; onPick: (picked: Picked) => void; onClear: () => void; disabled?: boolean }) {
  const { colors, dark, type, control } = useTheme();
  const { ref, onFocus, onBlur } = useReveal();
  return (
    <View ref={ref} style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: space.xs }}>
        <Lock size={12} color={colors.muted} strokeWidth={2.6} />
        <T variant="label" color="muted" style={{ flexShrink: 1 }}>
          {label}
        </T>
      </View>
      {picked ? (
        <View style={{ minHeight: control.field, flexDirection: "row", alignItems: "center", paddingLeft: space.lg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}>
          <T variant="callout" weight="600" style={{ flex: 1 }} accessibilityLabel={"Saved credential, " + picked.name}>
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
          onFocus={onFocus}
          onBlur={onBlur}
          secureTextEntry
          autoCorrect={false}
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
          editable={!disabled}
          returnKeyType="done"
          placeholder="Typed privately"
          placeholderTextColor={colors.faint}
          keyboardAppearance={dark ? "dark" : "light"}
          selectionColor={colors.accent}
          maxFontSizeMultiplier={1.3}
          accessibilityLabel={label + ", secret"}
          accessibilityHint={hint}
          style={[type.callout, { color: colors.ink, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space.lg, paddingVertical: Math.max(8, Math.round((control.field - type.callout.lineHeight) / 2)), minHeight: control.field }]}
        />
      )}
      {!!hint && (
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
          {hint}
        </T>
      )}
      {!picked && <CredentialPicker disabled={disabled} onPick={(credential, name) => onPick({ ref: credential, name })} />}
    </View>
  );
}

// --- What a request shows -------------------------------------------------------------------

/** A command, a preview or the full request, in mono, wrapping to as many lines as it needs. Red when it looks destructive. */
export function Code({ children, danger }: { children: string; danger?: boolean }) {
  const { colors, type } = useTheme();
  return (
    <View style={{ backgroundColor: danger ? colors.dangerSoft : colors.sunken, borderRadius: radius.md, borderWidth: danger ? 1 : 0, borderColor: colors.danger, paddingHorizontal: space.md, paddingVertical: space.sm + 2 }}>
      <Text selectable maxFontSizeMultiplier={1.3} style={[type.mono, { color: colors.ink }]}>
        {children}
      </Text>
    </View>
  );
}

/** A line that opens what is under it ("Full request"). */
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <View style={{ gap: space.xs }}>
      <Tap onPress={() => setOpen(!open)} feel="select" sink={1} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.xs, alignSelf: "flex-start", paddingRight: space.md }}>
        <Chevron size={16} color={colors.muted} strokeWidth={2.4} />
        <T variant="subhead" weight="600" color="muted">
          {title}
        </T>
      </Tap>
      {open && children}
    </View>
  );
}

/** The address a request wants opened, by its host, with a way to open it. */
export function LinkLine({ url }: { url: string }) {
  const { colors } = useTheme();
  const host = hostOf(url);
  if (!host) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, paddingLeft: space.md, borderRadius: radius.md, backgroundColor: colors.sunken }}>
      <Globe size={16} color={colors.muted} strokeWidth={2.2} />
      <T variant="subhead" weight="600" style={{ flex: 1 }} accessibilityLabel={"Address, " + host}>
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

// --- Buttons --------------------------------------------------------------------------------

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
const RING = 22;
/** What the ring and its gap add beside the hold button's label. */
export const HOLD_EXTRA = RING + space.sm;
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Allow for a risky request: held for a moment while a ring fills. With a screen reader, a second confirm instead. */
export function HoldToAllow({ label, onConfirm, busy, disabled, style }: { label: string; onConfirm: () => void; busy: boolean; disabled: boolean; style?: ViewStyle }) {
  const { colors, control } = useTheme();
  const reader = useScreenReader();
  const progress = useSharedValue(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stroke = 2.5;
  const r = (RING - stroke) / 2;
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
        title={label}
        variant="danger"
        style={style}
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
      accessibilityLabel={"Hold to " + label.toLowerCase()}
      accessibilityState={{ disabled: disabled || busy, busy }}
      style={[{ minHeight: control.button.md, paddingHorizontal: 20, borderRadius: radius.md, backgroundColor: colors.danger, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, opacity: disabled ? 0.45 : 1 }, style]}
    >
      <Svg width={RING} height={RING}>
        <Circle cx={RING / 2} cy={RING / 2} r={r} stroke={colors.dangerSoft} strokeOpacity={0.5} strokeWidth={stroke} fill="none" />
        <AnimatedCircle cx={RING / 2} cy={RING / 2} r={r} stroke={colors.dangerSoft} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={length} animatedProps={ring} transform={"rotate(-90 " + RING / 2 + " " + RING / 2 + ")"} />
      </Svg>
      <T variant="headline" weight="600" color={colors.dangerSoft} numberOfLines={1}>
        {busy ? "Allowing…" : "Hold to " + label.toLowerCase()}
      </T>
    </Pressable>
  );
}

/** One button of a pair: its label (to see whether it fits), what sits beside the label, and how to draw it. */
export type PairButton = { label: string; extra?: number; render: (style: ViewStyle) => ReactNode };

/** The quiet button and the main one: side by side (quiet first) when both labels fit, else stacked with the main one on top. */
export function Pair({ quiet, main }: { quiet: PairButton; main: PairButton }) {
  const { type } = useTheme();
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  // A button's label is drawn with the phone's text size on top, up to 1.35 times (T).
  const size = type.headline.fontSize * Math.min(Math.max(fontScale, 1), 1.35);
  const side = fitsSideBySide(width, [quiet, main], size, emFor(type.headline.fontFamily), space.sm);
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ flexDirection: side ? "row" : "column", gap: space.sm }}>
      {side ? quiet.render({ flex: 1 }) : main.render({ alignSelf: "stretch" })}
      {side ? main.render({ flex: 1 }) : quiet.render({ alignSelf: "stretch" })}
    </View>
  );
}
