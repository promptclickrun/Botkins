// Typing on the computer: a hidden text field takes the phone's keyboard, and a bar of keys the
// phone's keyboard lacks sits above it (Esc, Tab, sticky modifiers, arrows, Delete, Paste).
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, KeyboardOff, type LucideIcon } from "lucide-react-native";
import { type ComponentRef, type RefObject, useRef, useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { ScreenInput } from "@/link/types";
import { space, T, Tap } from "@/ui";
import { chrome } from "./chrome";

type KeyEvent = Extract<ScreenInput, { type: "key" }>;
export type Modifier = NonNullable<KeyEvent["modifiers"]>[number];

/** The hidden field starts with these invisible characters, so a backspace always changes it. */
const SEED = "​".repeat(8);
/** The hidden field starts over once it holds this much. */
const MAX_HELD = 200;
export const KEY_BAR_HEIGHT = 52;

/** What changed between two versions of the field: characters taken away, and text put in. */
function difference(before: string, after: string) {
  const old = Array.from(before), next = Array.from(after);
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head++;
  // The remote caret is at the end. An IME can revise earlier letters while keeping a suffix.
  return { removed: old.length - head, added: next.slice(head).join("") };
}

export function HiddenInput({ inputRef, send, modifiers, release, onFocus, onBlur }: { inputRef: RefObject<ComponentRef<typeof TextInput> | null>; send: (event: ScreenInput) => void; modifiers: Modifier[]; release: () => void; onFocus: () => void; onBlur: () => void }) {
  const [buffer, setBuffer] = useState(SEED);
  const held = useRef(SEED);

  function changed(text: string) {
    // A sticky modifier goes with the first key or character of this change, then lets go.
    let pending = modifiers;
    const key = (name: string) => {
      const event: KeyEvent = pending.length ? { type: "key", key: name, modifiers: pending } : { type: "key", key: name };
      send(event);
      pending = [];
    };
    const typed = (added: string) => {
      added
        .replace(/\u200B/g, "")
        .split("\n")
        .forEach((line, index) => {
          if (index > 0) key("enter");
          if (!line) return;
          if (pending.length) {
            const first = Array.from(line)[0]!;
            key(first);
            const rest = line.slice(first.length);
            if (rest) send({ type: "text", text: rest });
          } else send({ type: "text", text: line });
        });
    };

    const { removed, added } = difference(held.current, text);
    for (let i = 0; i < removed; i++) key("backspace");
    if (added) typed(added);
    if (modifiers.length && pending.length === 0) release();
    const next = text.length < 2 || text.length > MAX_HELD ? SEED : text;
    held.current = next;
    setBuffer(next);
  }

  return (
    <TextInput
      ref={inputRef}
      value={buffer}
      onChangeText={changed}
      onFocus={onFocus}
      onBlur={onBlur}
      multiline
      autoCorrect={false}
      autoCapitalize="none"
      autoComplete="off"
      importantForAutofill="no"
      textContentType="none"
      spellCheck={false}
      smartInsertDelete={false}
      keyboardAppearance="dark"
      caretHidden
      contextMenuHidden
      accessibilityLabel="Type on your computer"
      style={styles.hidden}
    />
  );
}

export function KeyBar({
  platform,
  superKey,
  modifiers,
  toggle,
  send,
  release,
  paste,
  hide,
  bottom,
}: {
  platform: string | undefined;
  superKey: boolean;
  modifiers: Modifier[];
  toggle: (modifier: Modifier) => void;
  send: (event: ScreenInput) => void;
  release: () => void;
  paste: () => void;
  hide: () => void;
  bottom: number;
}) {
  const mac = platform === "darwin";
  const windows = platform === "win32";

  function key(name: string) {
    send(modifiers.length ? { type: "key", key: name, modifiers } : { type: "key", key: name });
    if (modifiers.length) release();
  }

  return (
    <View style={[styles.bar, { bottom }]}>
      <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.keys}>
        <Key icon={KeyboardOff} label="Hide keyboard" onPress={hide} />
        <Key title="Esc" label="Escape" onPress={() => key("escape")} />
        <Key title="Tab" label="Tab" onPress={() => key("tab")} />
        <Key title={mac ? "⌃ Ctrl" : "Ctrl"} label="Control" on={modifiers.includes("ctrl")} onPress={() => toggle("ctrl")} />
        <Key title={mac ? "⌥ Option" : "Alt"} label={mac ? "Option" : "Alt"} on={modifiers.includes("alt")} onPress={() => toggle("alt")} />
        {mac && <Key title="⌘ Cmd" label="Command" on={modifiers.includes("cmd")} onPress={() => toggle("cmd")} />}
        {!mac && superKey && <Key title={windows ? "Win" : "Super"} label={windows ? "Windows key" : "Super"} on={modifiers.includes("super")} onPress={() => toggle("super")} />}
        <Key title="⇧ Shift" label="Shift" on={modifiers.includes("shift")} onPress={() => toggle("shift")} />
        <Key icon={ArrowLeft} label="Left arrow" onPress={() => key("left")} />
        <Key icon={ArrowUp} label="Up arrow" onPress={() => key("up")} />
        <Key icon={ArrowDown} label="Down arrow" onPress={() => key("down")} />
        <Key icon={ArrowRight} label="Right arrow" onPress={() => key("right")} />
        <Key title="Delete" label="Forward delete" onPress={() => key("delete")} />
        <Key icon={ClipboardPaste} title="Paste" label="Paste from phone" onPress={paste} />
      </ScrollView>
    </View>
  );
}

function Key({ title, icon: Icon, label, on, onPress }: { title?: string; icon?: LucideIcon; label: string; on?: boolean; onPress: () => void }) {
  const fg = on ? chrome.inkOn : chrome.ink;
  return (
    <Tap
      onPress={onPress}
      feel="select"
      accessibilityLabel={label}
      accessibilityState={on === undefined ? undefined : { selected: on }}
      style={[styles.key, { backgroundColor: on ? chrome.keyOn : chrome.key }]}
    >
      {Icon && <Icon size={18} color={fg} strokeWidth={2.2} />}
      {!!title && (
        <T variant="subhead" weight="600" color={fg} numberOfLines={1}>
          {title}
        </T>
      )}
    </Tap>
  );
}

const styles = StyleSheet.create({
  hidden: { position: "absolute", left: 0, bottom: 0, width: 1, height: 1, opacity: 0 },
  bar: { position: "absolute", left: 0, right: 0, height: KEY_BAR_HEIGHT, backgroundColor: chrome.glass, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: chrome.glassLine, justifyContent: "center" },
  keys: { paddingHorizontal: space.sm, gap: 6, alignItems: "center" },
  key: { minWidth: 44, height: 44, paddingHorizontal: 12, borderRadius: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
});
