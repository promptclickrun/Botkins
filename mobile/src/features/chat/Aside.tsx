// The bot's thinking and its interim texts ("updates"), drawn as one family wherever they show: in a
// turn under way, in an Every step turn that ended, and in an opened fold. Settings › Chat ›
// Thinking and updates says how: Open shows all of it, Folded the last few lines (a tap shows the
// rest), Hidden keeps them out of the chat (turn.ts never hands them over). The reply is never one.
import { Brain, ChevronDown, ChevronRight, MessageSquareText } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { useChatPrefs } from "@/state/chatPrefs";
import { Markdown, space, T, Tap, useTheme } from "@/ui";
import { plainPreview } from "./bits";

const TAIL = 260;

export function Aside({ kind, text, live }: { kind: "thinking" | "update"; text: string; /** Still being thought. */ live?: boolean }) {
  const { colors } = useTheme();
  const mode = useChatPrefs((prefs) => prefs.thinking);
  const markdown = useChatPrefs((prefs) => prefs.markdown);
  const [open, setOpen] = useState(mode === "show");
  const thinking = kind === "thinking";
  const Icon = thinking ? Brain : MessageSquareText;
  const Chevron = open ? ChevronDown : ChevronRight;
  const flat = thinking ? text : plainPreview(text);
  const tail = flat.length > TAIL ? "…" + flat.slice(-TAIL).trimStart() : flat;
  const what = thinking ? "thinking" : "update";
  return (
    <Tap
      onPress={() => setOpen(!open)}
      feel="select"
      sink={0.99}
      accessibilityLabel={(open ? "Hide " : "Show ") + what}
      accessibilityState={{ expanded: open }}
      style={{ gap: 6, paddingLeft: space.md, borderLeftWidth: 2, borderLeftColor: colors.lineStrong }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 20 }}>
        <Icon size={14} color={colors.muted} strokeWidth={2.2} />
        <T variant="footnote" weight="600" color="muted">
          {thinking ? (live ? "Thinking…" : "Thinking") : "Update"}
        </T>
        <Chevron size={14} color={colors.faint} strokeWidth={2.4} />
      </View>
      {open && !thinking ? (
        <Markdown text={text} size="small" color={colors.ink2} plain={!markdown} />
      ) : (
        <T variant="footnote" color={thinking ? "muted" : "ink2"} numberOfLines={open ? undefined : 3} ellipsizeMode="head" style={thinking ? { fontStyle: "italic" } : undefined}>
          {open ? text : tail}
        </T>
      )}
    </Tap>
  );
}
