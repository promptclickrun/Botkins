// A progress update reads like the reply. A thought is quieter and sits beside the bot’s face.
// The active canvas uses Open. An expanded completed fold can also disclose Folded activity.
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { Bot } from "@/link/types";
import type { AvatarState } from "@/state/hooks";
import { useChatPrefs } from "@/state/chatPrefs";
import { BotAvatar, Markdown, T, Tap, useTheme } from "@/ui";
import { plainPreview } from "./bits";
import { FACE } from "./WorkRows";

/** About three lines of a folded thought or update: its end, where the bot is now. */
const TAIL = 150;

const tailOf = (text: string) => (text.length > TAIL ? "…" + text.slice(-TAIL).trimStart() : text);

export function Aside({ kind, text, live, bot, state, label }: {
  kind: "thinking" | "update";
  text: string;
  /** Still being thought. */
  live?: boolean;
  /** The bot whose face leads a thought (the one speaking, in a group chat). */
  bot?: Bot;
  /** The face's pose, held still. */
  state?: AvatarState;
  /** In ink beside the face: what the bot is doing ("Coding"). Left out: "Thinking" or "Thought". */
  label?: string;
}) {
  const { colors } = useTheme();
  const mode = useChatPrefs((prefs) => prefs.thinking);
  const markdown = useChatPrefs((prefs) => prefs.markdown);
  const [open, setOpen] = useState(mode === "show");
  // A setting change must not leave an already-mounted update in its old preview state. Open is
  // intentionally full and readable; Folded keeps the compact tail until the person expands it.
  useEffect(() => setOpen(mode === "show"), [mode]);
  const toggle = () => setOpen(!open);

  if (kind === "update") {
    const flat = plainPreview(text);
    return (
      <Tap onPress={toggle} feel="select" sink={0.99} accessibilityLabel={open ? text : "Show the rest of this update: " + text} accessibilityState={{ expanded: open }}>
        {open ? (
          <Markdown text={text} plain={!markdown} color={colors.ink2} />
        ) : (
          <T variant="body" color="ink2" numberOfLines={3}>
            {flat}
          </T>
        )}
      </Tap>
    );
  }

  const head = (label ?? (live ? "Thinking" : "Thought")).replace(/…$/, "");
  return (
    <Tap
      onPress={toggle}
      feel="select"
      sink={0.99}
      accessibilityLabel={head + ". " + text}
      accessibilityHint={open ? "Shows less" : "Shows all of it"}
      accessibilityState={{ expanded: open }}
      style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}
    >
      <View style={{ paddingTop: 1 }}>
        <BotAvatar bot={bot} size={FACE} state={state ?? (live ? "thinking" : "idle")} animated={false} />
      </View>
      <T variant="subhead" color="muted" numberOfLines={open ? undefined : 3} style={{ flex: 1 }}>
        <T variant="subhead" weight="600" color="ink">
          {head}
        </T>
        {text ? " · " + (open ? text : tailOf(text)) : ""}
      </T>
    </Tap>
  );
}
