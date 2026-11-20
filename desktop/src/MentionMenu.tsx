import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, FileText, FolderKanban, Newspaper, Users, X } from "lucide-react";
import { BotAvatar } from "./Avatar";
import type { Bot, Mention, MentionInput, Mentionables } from "./types";
import "./mentions.css";

/** A mention picked in the composer: what is sent, plus the label typed into the message. */
export type DraftMention = Exclude<Mention, { kind: "customer" }>;
export const MAX_MENTIONS = 12;

/** The text a mention puts in the message, without the trailing space. */
export const tokenOf = (m: DraftMention) => "#" + m.label;
export const mentionKey = (m: Mention | MentionInput) => m.kind + ":" + ("id" in m ? m.id : m.path);
export const toInput = (m: DraftMention): MentionInput =>
  "path" in m ? { kind: m.kind, path: m.path } : { kind: m.kind, id: m.id };

export function MentionIcon({ kind, size = 13 }: { kind: Mention["kind"]; size?: number }) {
  // A mention saved by an earlier version ("customer") has no icon: it shows as a plain label.
  return kind === "project" ? (
    <FolderKanban size={size} aria-hidden="true" />
  ) : kind === "wiki" ? (
    <BookOpen size={size} aria-hidden="true" />
  ) : kind === "file" ? (
    <FileText size={size} aria-hidden="true" />
  ) : kind === "board" ? (
    <Newspaper size={size} aria-hidden="true" />
  ) : null;
}
const BOARD_NAMES = { feed: "Feed", idea: "Ideas", goal: "Goals" };

// The lists read the disk for files, so a menu reuses what it fetched for a few seconds.
const cache = new Map<string, { time: number; data: Promise<Mentionables> }>();
const FRESH_MS = 5000;
function load(chatId: string | undefined, botId: string) {
  const key = (chatId ?? "") + "|" + botId;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < FRESH_MS) return hit.data;
  const data = window.botkins.mentionables(chatId, chatId ? undefined : botId);
  cache.set(key, { time: Date.now(), data });
  data.catch(() => cache.delete(key));
  return data;
}

/** What "@" and "#" can mention, fetched when a menu opens. */
export function useMentionables(active: boolean, chatId: string | undefined, botId: string) {
  const [data, setData] = useState<Mentionables>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    let live = true;
    setError("");
    load(chatId, botId)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(String(e?.message || e)));
    return () => {
      live = false;
    };
  }, [active, chatId, botId]);
  return { data, error, loading: active && !data && !error };
}

/** The "@" or "#" being typed at the caret: at the start of the message or after whitespace, never inside a word. */
export function findTrigger(draft: string, caret: number) {
  const m = /(?:^|\s)([@#])([^\n@#]{0,60})$/.exec(draft.slice(0, caret));
  if (!m || /^\s/.test(m[2])) return null;
  return { sigil: m[1] as "@" | "#", query: m[2], start: caret - m[2].length - 1 };
}

export type MentionOption = {
  key: string;
  group: "Bots" | "Projects" | "Wiki" | "Files";
  name: string;
  hint?: string;
  tag?: string;
  icon: ReactNode;
  /** The text inserted, without the trailing space. */
  token: string;
  /** Recorded with the message; bots are plain-text addressing and have none. */
  mention?: DraftMention;
};

const LIMIT = 50;

/** The menu's options for a trigger, grouped and filtered by the typed text. */
export function mentionOptions(
  sigil: "@" | "#",
  query: string,
  data: Mentionables | undefined,
  members: Bot[] | undefined,
): MentionOption[] {
  const q = query.toLowerCase();
  const hit = (...texts: (string | undefined)[]) => texts.some((t) => t?.toLowerCase().includes(q));
  const ranked = <T extends { name: string }>(list: T[]) =>
    list
      .map((item, i) => ({ item, rank: item.name.toLowerCase().startsWith(q) ? 0 : 1, i }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((r) => r.item)
      .slice(0, LIMIT);
  const out: MentionOption[] = [];
  if (sigil === "@") {
    if (members?.length) {
      const bots = [
        ...members.map((b) => ({ id: b.id, name: b.name, hint: b.role, bot: b as Bot | undefined })),
        { id: "everyone", name: "everyone", hint: "Every member answers", bot: undefined },
      ].filter((b) => hit(b.name, b.id === "everyone" ? "everyone" : b.hint));
      for (const b of bots)
        out.push({
          key: "bot:" + b.id,
          group: "Bots",
          name: "@" + b.name,
          hint: b.hint,
          icon: b.bot ? <BotAvatar bot={b.bot} size={22} /> : <Users size={15} aria-hidden="true" />,
          token: "@" + b.name,
        });
    }
    return out;
  }
  const projects = (data?.projects ?? []).filter((p) => hit(p.name, p.hint));
  // The chat's own project comes first.
  for (const p of ranked(projects).sort((a, b) => Number(!!b.current) - Number(!!a.current)))
    out.push({
      key: "project:" + p.id,
      group: "Projects",
      name: p.name,
      hint: p.hint,
      tag: p.current ? "This chat" : undefined,
      icon: <MentionIcon kind="project" size={15} />,
      token: "#" + p.name,
      mention: { kind: "project", id: p.id, label: p.name },
    });
  const pages = (data?.wiki ?? []).map((p) => ({ ...p, name: p.title }));
  for (const p of ranked(pages.filter((p) => hit(p.title, p.hint))))
    out.push({
      key: "wiki:" + p.path,
      group: "Wiki",
      name: p.title,
      hint: p.hint,
      icon: <MentionIcon kind="wiki" size={15} />,
      token: "#" + p.title,
      mention: { kind: "wiki", path: p.path, label: p.title },
    });
  for (const f of ranked((data?.files ?? []).filter((f) => hit(f.name, f.folder, f.where))))
    out.push({
      key: "file:" + f.path,
      group: "Files",
      name: f.name,
      hint: [f.folder, f.where].filter(Boolean).join(" · "),
      icon: <MentionIcon kind="file" size={15} />,
      token: "#" + f.name,
      mention: { kind: "file", path: f.path, label: f.name },
    });
  return out;
}

/** The "@" or "#" popup, in the "/" menu's look and listbox pattern. */
export function MentionMenu({
  id,
  sigil,
  options,
  selected,
  loading,
  error,
  filtered,
  pick,
}: {
  id: string;
  sigil: "@" | "#";
  options: MentionOption[];
  selected: number;
  loading: boolean;
  error: string;
  filtered: boolean;
  pick: (i: number) => void;
}) {
  const label = sigil === "#" ? "Mention a project, wiki page or file" : "Mention a bot";
  const empty =
    sigil === "#"
      ? filtered
        ? "No matching projects, pages or files"
        : "No projects, pages or files yet"
      : filtered
        ? "No matching bots"
        : "No bots to mention";
  const groups: { name: MentionOption["group"]; items: { o: MentionOption; i: number }[] }[] = [];
  options.forEach((o, i) => {
    const last = groups.at(-1);
    if (last?.name === o.group) last.items.push({ o, i });
    else groups.push({ name: o.group, items: [{ o, i }] });
  });
  return (
    <div className="slash-menu mention-menu record-menu" id={id} role="listbox" aria-label={label}>
      {groups.map((g) => (
        <div role="group" aria-labelledby={id + "-g-" + g.name} key={g.name}>
          <div className="slash-heading" id={id + "-g-" + g.name}>
            {g.name}
          </div>
          {g.items.map(({ o, i }) => (
            <button
              role="option"
              id={id + "-x" + i}
              aria-selected={i === selected}
              key={o.key}
              tabIndex={-1}
              title={o.mention?.kind === "file" ? o.mention.path : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <span className="mention-name">
                <span className="mention-icon">{o.icon}</span>
                <strong>{o.name}</strong>
                {o.tag && <em>{o.tag}</em>}
              </span>
              {o.hint && <small>{o.hint}</small>}
            </button>
          ))}
        </div>
      ))}
      {loading ? (
        <p>Loading…</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : (
        !options.length && <p>{empty}</p>
      )}
    </div>
  );
}

/** Mention chips: removable in the composer, and under a sent message, where records open on click. */
export function MentionChips({
  list,
  remove,
  open,
  canOpen = () => true,
  sent,
}: {
  list: Mention[];
  remove?: (m: Mention) => void;
  open?: (m: Mention) => void;
  /** Whether a record still exists; a removed one shows as a plain chip. */
  canOpen?: (m: Mention) => boolean;
  sent?: boolean;
}) {
  if (!list.length) return null;
  return (
    <ul className={"attach-chips mention-chips" + (sent ? " sent" : "")} aria-label="Mentions">
      {list.map((m) => {
        const body = (
          <>
            <MentionIcon kind={m.kind} />
            <span>{m.label}</span>
          </>
        );
        const title =
          m.kind === "file" ? m.path : m.kind === "wiki" ? "Wiki page · " + m.label : m.kind === "project" ? "Project · " + m.label : m.label;
        // A Today item sent with a message shows as a card: what it is, its title and how it begins.
        if (sent && m.kind === "board") {
          const card = (
            <>
              <small>
                <MentionIcon kind="board" /> From Today{m.board ? " · " + BOARD_NAMES[m.board] : ""}
              </small>
              <strong>{m.label}</strong>
              {m.body && <span className="mention-card-body">{m.body}</span>}
            </>
          );
          return (
            <li key={mentionKey(m)} className="mention-card">
              {open && canOpen(m) ? (
                <button type="button" className="mention-open" aria-label={"Open Today for " + m.label} onClick={() => open(m)}>
                  {card}
                </button>
              ) : (
                card
              )}
            </li>
          );
        }
        return (
          <li key={mentionKey(m)} title={title} className={"mention-chip " + m.kind}>
            {open && m.kind !== "file" && canOpen(m) ? (
              <button
                type="button"
                className="mention-open"
                aria-label={"Open " + (m.kind === "wiki" ? "wiki page " : m.kind === "board" ? "Today for " : "project ") + m.label}
                onClick={() => open(m)}
              >
                {body}
              </button>
            ) : (
              body
            )}
            {remove && (
              <button type="button" aria-label={"Remove " + m.label} onClick={() => remove(m)}>
                <X size={12} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
