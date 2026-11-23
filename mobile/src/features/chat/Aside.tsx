// The bot's thinking and its interim texts ("updates"), wherever they show: in a turn under way, in
// an Every step turn that ended, and in an opened fold. The two are drawn apart on purpose (the
// owner's pick, 2026-11-22). An update is something the bot said, so it reads like its reply: the
// same text at full size, a shade quieter, with no box, label or line. Thinking is the bot's face,
// still, with a muted line beside it ("Coding · One promise per session…"), and the steps of that
// part sit under it (LiveTurn.tsx). While the bot is thinking with no step running, "Coding" is the
// turn's live line and shimmers (`shimmer`, T3 Code's "Thinking" row); a live thought then hangs
// beside the word instead of flowing under it, so the word is one line the band can cross. Settings › Chat › Thinking and updates says how much: Open shows
// all of it, Folded the last few lines (a tap shows the rest), Hidden keeps both out of the chat
// (turn.ts never hands them over). The reply is never one.
import { useState } from "react";
import { View } from "react-native";
import type { Bot } from "@/link/types";
import type { AvatarState } from "@/state/hooks";
import { useChatPrefs } from "@/state/chatPrefs";
import { BotAvatar, Markdown, T, Tap, useTheme } from "@/ui";
import { Shimmer } from "@/ui/Shimmer";
import { plainPreview } from "./bits";
import { FACE } from "./WorkRows";

/** About three lines of a folded thought or update: its end, where the bot is now. */
const TAIL = 150;

const tailOf = (text: string) => (text.length > TAIL ? "…" + text.slice(-TAIL).trimStart() : text);

export function Aside({ kind, text, live, bot, state, label, shimmer = false }: {
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
  /** With `live`: the bot is on this now, with no step running, so what it is doing shimmers. */
  shimmer?: boolean;
}) {
  const { colors } = useTheme();
  const mode = useChatPrefs((prefs) => prefs.thinking);
  const markdown = useChatPrefs((prefs) => prefs.markdown);
  const [open, setOpen] = useState(mode === "show");
  const toggle = () => setOpen(!open);

  if (kind === "update") {
    const flat = plainPreview(text);
    return (
      <Tap onPress={toggle} feel="select" sink={0.99} accessibilityLabel={(open ? "Hide" : "Show") + " the rest of this update"} accessibilityState={{ expanded: open }}>
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
      accessibilityLabel={head + ". " + (open ? text : tailOf(text))}
      accessibilityHint={open ? "Shows less" : "Shows all of it"}
      accessibilityState={{ expanded: open }}
      style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}
    >
      <View style={{ paddingTop: 1 }}>
        <BotAvatar bot={bot} size={FACE} state={state ?? (live ? "thinking" : "idle")} animated={false} />
      </View>
      {live ? (
        <View style={{ flex: 1, flexDirection: "row", alignItems: "flex-start" }}>
          <Shimmer
            on={shimmer}
            lit={
              <T variant="subhead" weight="600" color="ink" numberOfLines={1}>
                {head}
              </T>
            }
          >
            <T variant="subhead" weight="600" color={shimmer ? "muted" : "ink"} numberOfLines={1}>
              {head}
            </T>
          </Shimmer>
          {!!text && (
            <T variant="subhead" color="muted" numberOfLines={open ? undefined : 3} style={{ flex: 1 }}>
              {" · " + (open ? text : tailOf(text))}
            </T>
          )}
        </View>
      ) : (
      <T variant="subhead" color="muted" numberOfLines={open ? undefined : 3} style={{ flex: 1 }}>
        <T variant="subhead" weight="600" color="ink">
          {head}
        </T>
        {text ? " · " + (open ? text : tailOf(text)) : ""}
      </T>
      )}
    </Tap>
  );
}
