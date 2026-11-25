// A person's round badge (their own picture, or their initial in their color), and the tag an
// "@Name" in a message is drawn as (src/mentionTags.ts finds them).
import { createContext, memo, useContext, useRef, type ReactNode } from "react";
import { initialOf, personColor } from "./messageSides";
import type { MentionName } from "./mentionTags";
import type { Bot } from "./types";
import "./people.css";

/** Someone in a chat, as their badge draws them. `emoji` is the owner's profile avatar, for an owner with no picture here. */
export type ChatPerson = { id: string; name: string; avatar?: string; emoji?: string };

/**
 * The round badge: a picture when the person set one, else their profile's emoji, else their initial.
 * Decorative: the name is beside it. The letter is drawn by the style, so copying a message's text
 * (or reading a tag's) never picks it up.
 */
export const PersonBadge = memo(function PersonBadge({ person, size = 24, className = "" }: { person: ChatPerson; size?: number; className?: string }) {
  return (
    <span
      className={"person-badge person-color-" + personColor(person.id) + (className ? " " + className : "")}
      style={{ width: size, height: size, fontSize: Math.round(size * (person.emoji && !person.avatar ? 0.62 : 0.46)) }}
      data-initial={person.avatar ? undefined : person.emoji || initialOf(person.name)}
      aria-hidden="true"
    >
      {person.avatar && <img src={person.avatar} alt="" draggable={false} />}
    </span>
  );
});

/** Who a tag names: a person, or a bot in the chat. */
export type MentionTarget = { kind: "person"; person: ChatPerson } | { kind: "bot"; bot: Bot };
/**
 * The names a chat's messages may tag, and what each one draws. Made once per chat, so text is not
 * parsed again. `botFace` draws a bot's small face: the chat hands it in, so the text renderer (also
 * compiled for exports, scripts/build-wiki-export.mjs) never loads the avatar kit itself.
 */
export type MentionDirectory = { names: MentionName[]; targets: Map<string, MentionTarget>; botFace?: (bot: Bot) => ReactNode };

export const MentionContext = createContext<MentionDirectory | null>(null);

/** The tag of one "@Name": a rounded pill with the person's picture or the bot's face, and the text as it was written. */
export function MentionTag({ id, children }: { id: string; children?: ReactNode }) {
  const directory = useContext(MentionContext);
  const target = directory?.targets.get(id);
  if (!target) return <>{children}</>;
  return (
    <span className={"mention-tag " + (target.kind === "bot" ? "is-bot" : "is-person person-color-" + personColor(target.person.id))}>
      {target.kind === "bot" ? directory?.botFace?.(target.bot) : <PersonBadge person={target.person} size={14} />}
      <span className="mention-tag-text">{children}</span>
    </span>
  );
}

const samePeople = (a: readonly ChatPerson[], b: readonly ChatPerson[]) =>
  a.length === b.length && a.every((person, i) => person.id === b[i].id && person.name === b[i].name && person.avatar === b[i].avatar && person.emoji === b[i].emoji);
const sameBots = (a: readonly Bot[], b: readonly Bot[]) =>
  a.length === b.length && a.every((bot, i) => bot.id === b[i].id && bot.name === b[i].name && JSON.stringify(bot.look) === JSON.stringify(b[i].look));

/**
 * The chat's directory, kept the same object while its people and bots are the same. The window's
 * state is a new object on every change, and a new directory would draw every message again.
 */
export function useMentionDirectory(people: readonly ChatPerson[], bots: readonly Bot[], botFace?: (bot: Bot) => ReactNode): { people: readonly ChatPerson[]; directory: MentionDirectory } {
  const held = useRef<{ people: readonly ChatPerson[]; bots: readonly Bot[]; directory: MentionDirectory }>(null);
  if (!held.current || !samePeople(held.current.people, people) || !sameBots(held.current.bots, bots)) held.current = { people, bots, directory: mentionDirectory(people, bots, botFace) };
  return { people: held.current.people, directory: held.current.directory };
}

/** The directory for a chat: its people and its bots, by the names a message would use. */
export function mentionDirectory(people: readonly ChatPerson[], bots: readonly Bot[], botFace?: (bot: Bot) => ReactNode): MentionDirectory {
  const names: MentionName[] = [];
  const targets = new Map<string, MentionTarget>();
  for (const person of people) {
    names.push({ key: person.id, name: person.name });
    targets.set(person.id, { kind: "person", person });
  }
  for (const bot of bots) {
    names.push({ key: "bot:" + bot.id, name: bot.name });
    targets.set("bot:" + bot.id, { kind: "bot", bot });
  }
  return { names, targets, ...(botFace && { botFace }) };
}
