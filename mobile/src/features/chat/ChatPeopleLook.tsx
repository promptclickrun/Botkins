// The people and bots of one chat, as its messages draw them: each person's badge and name tag
// ("people-avatars-v1"), and "@Name" drawn as a tag where Name is one of them (mentionTags.ts).
// Made once per chat screen and handed down by context, so a row does no work of its own for it.
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { Text, View } from "react-native";
import type { Bot, ChatSummary } from "@/link/types";
import { usePart } from "@/state/hooks";
import { useProfile } from "@/state/profile";
import { BotAvatar, tint, useTheme } from "@/ui";
import { type InlineTags, InlineTagsContext, type InlineTagSpan } from "@/ui/inlineTags";
import { type MentionMatcher, type MentionTarget, mentionMatcher } from "./mentionTags";
import { myself, OWNER, starterOf } from "./people";
import { PersonBadge } from "./PersonBadge";
import { type PersonLook, peopleLooks } from "./personLook";

const NO_PEOPLE = new Map<string, PersonLook>();
/** The chat's people by id, for the badges and names beside messages. */
export const ChatPeopleContext = createContext<Map<string, PersonLook>>(NO_PEOPLE);
export const useChatPeople = () => useContext(ChatPeopleContext);

type Target = MentionTarget & { look?: PersonLook; bot?: Bot };

/** The last few matchers by what they were made from, so a list that syncs again unchanged keeps its matcher and what it found. */
const matchers = new Map<string, MentionMatcher>();
function matcherFor(signature: string, targets: Target[]): MentionMatcher {
  const kept = matchers.get(signature);
  if (kept) return kept;
  const made = mentionMatcher(targets);
  if (matchers.size >= 4) matchers.delete(matchers.keys().next().value!);
  matchers.set(signature, made);
  return made;
}

/** A tint of a text color, for a tag's pill: the color itself at a low strength. */
const soft = (color: string | undefined, fallback: string, strength: number) => (color && /^#[0-9a-f]{6}$/i.test(color) ? tint(color, strength) : fallback);

function MentionTag({ text, target, color }: { text: string; target: Target; color: string | undefined }) {
  const { colors, type, dark } = useTheme();
  const ink = color ?? colors.ink;
  const size = type.callout.fontSize;
  return (
    <View
      accessible
      accessibilityLabel={"Mention, " + target.name}
      // An inline view sits on the line's baseline; this lowers it to the middle of the line.
      style={{ flexDirection: "row", alignItems: "center", gap: 3, paddingLeft: target.look || target.bot ? 2 : 6, paddingRight: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: soft(ink, colors.sunken, dark ? 0.2 : 0.13), transform: [{ translateY: Math.round(size * 0.22) }] }}
    >
      {target.look ? <PersonBadge person={target.look} size={14} /> : target.bot ? <BotAvatar bot={target.bot} size={14} /> : null}
      <Text maxFontSizeMultiplier={1.35} style={{ fontFamily: type.callout.fontFamily, fontSize: size, lineHeight: Math.round(size * 1.2), fontWeight: "500", color: ink }}>
        {text}
      </Text>
    </View>
  );
}

/**
 * Hands a chat's people and tags to the rows inside. `bots` are the computer's bots by id; the chat's
 * own (its one bot, or a group chat's members) can be @mentioned.
 */
export function ChatPeopleLook({ chat, bots, children }: { chat: ChatSummary | undefined; bots: Map<string, Bot>; children: ReactNode }) {
  const { colors, dark } = useTheme();
  const people = usePart("team")?.people;
  const meta = usePart("meta");
  const me = myself(meta);
  const ownerEmoji = useProfile((state) => (me === OWNER ? state.home?.profile.avatar : undefined));
  const myAvatar = meta?.you?.avatar;
  const looks = useMemo(() => {
    const map = peopleLooks(people, ownerEmoji);
    // The phone's own picture can arrive on `meta.you` before the team list has it.
    const mine = map.get(me);
    if (mine && !mine.avatar && myAvatar && peopleLooks([{ id: me, name: mine.name, avatar: myAvatar }]).get(me)?.avatar) map.set(me, { ...mine, avatar: myAvatar, emoji: undefined });
    return map;
  }, [people, ownerEmoji, me, myAvatar]);
  const ids = chat ? [starterOf(chat), ...(chat.invited ?? [])] : [];
  const botIds = chat ? (chat.botIds?.length ? chat.botIds : chat.botId ? [chat.botId] : []) : [];
  const targets: Target[] = [
    ...ids.map((id) => looks.get(id)).filter((look): look is PersonLook => !!look).map((look): Target => ({ kind: "person", id: look.id, name: look.name, look })),
    ...botIds.map((id) => bots.get(id)).filter((bot): bot is Bot => !!bot).map((bot): Target => ({ kind: "bot", id: bot.id, name: bot.name, bot })),
  ];
  // Rebuilt only when a name, a picture or a bot changes; the matcher remembers what it found per text.
  const signature = targets.map((target) => target.kind + target.id + "\u0001" + target.name + "\u0001" + (target.look?.avatar ? target.look.avatar.length + target.look.avatar.slice(-32) : "") + (target.look?.emoji ?? "") + (target.bot?.look ? JSON.stringify(target.bot.look) : "")).join("\u0000");
  const matcher = matcherFor(signature, targets);
  const tags = useMemo<InlineTags>(
    () => ({
      find: (text) => matcher.find(text),
      draw: (span: InlineTagSpan, text, key, color) => <MentionTag key={key} text={text} target={span.target as Target} color={color} />,
      selected: (_span, color) => ({ fontWeight: "500", backgroundColor: soft(color, colors.sunken, dark ? 0.2 : 0.13) }),
    }),
    [matcher, colors, dark],
  );
  return (
    <ChatPeopleContext.Provider value={looks}>
      <InlineTagsContext.Provider value={tags}>{children}</InlineTagsContext.Provider>
    </ChatPeopleContext.Provider>
  );
}
