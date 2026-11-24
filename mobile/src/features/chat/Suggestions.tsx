import { pullReference } from "@/link/pr-reference";
// The composer's pickers, as on the desktop: "/" for commands and skills, "#" for records
// (projects, wiki pages, files and artifacts) and then the chat's pull requests, "@" for bots (a
// group chat's members and "everyone", or a one-bot chat's teammates) and then the records too, so
// either key finds everything. The trigger is the word that ends at the caret (compose.ts).
import { BookOpen, Cpu, FileText, FolderKanban, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Shrink, Sparkles, SquareSlash, User, Users } from "lucide-react-native";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import type { Bot, Capability, Mentionables, PullRequest } from "@/link/types";
import type { DraftCommand, DraftMention } from "./compose";
import { api } from "@/state/link";
import { BotAvatar, radius, space, T, Tap, useTheme } from "@/ui";

export { type DraftCommand, type DraftMention, findTrigger, MAX_MENTIONS, mentionKey, type Sigil, type Trigger, tokenOf } from "./compose";

export type Option = {
  key: string;
  group: string;
  title: string;
  subtitle?: string;
  leading: ReactNode;
  /** The text put in place of the trigger, without the trailing space. */
  insert?: string;
  mention?: DraftMention;
  /** A slash command or skill attached to the composer rail instead of inserted as text. */
  command?: DraftCommand;
  /** A local command that does something instead of inserting text. */
  action?: "model" | "compact";
};

const LIMIT = 40;
const has = (query: string, ...texts: (string | undefined)[]) => !query || texts.some((text) => text?.toLowerCase().includes(query));
function ranked<T>(list: T[], name: (item: T) => string, query: string): T[] {
  return list
    .map((item, index) => ({ item, index, rank: query && name(item).toLowerCase().startsWith(query) ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, LIMIT)
    .map((entry) => entry.item);
}

// --- "/" -------------------------------------------------------------------------------------

/** The chat's commands and skills, asked for the first time "/" is typed in this chat. */
export function useCatalog(active: boolean, botId: string | undefined, chatId: string) {
  const [items, setItems] = useState<Capability[]>();
  const [error, setError] = useState("");
  const asking = useRef(false);
  useEffect(() => {
    if (!active || !botId || items || asking.current) return;
    asking.current = true;
    setError("");
    api
      .catalog(botId, chatId)
      .then((catalog) => setItems(catalog.choices))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Couldn't load commands."))
      .finally(() => (asking.current = false));
  }, [active, botId, chatId, items]);
  return { items, error, loading: active && !items && !error };
}

export function slashOptions(query: string, items: Capability[] | undefined, iconColor: string): Option[] {
  const q = query.toLowerCase();
  const local: Option[] = [
    { key: "local:model", group: "Commands", title: "/model", subtitle: "Choose the model for this chat", leading: <Cpu size={18} color={iconColor} strokeWidth={2.2} />, action: "model" },
    { key: "local:compact", group: "Commands", title: "/compact", subtitle: "Summarize the chat to free up room", leading: <Shrink size={18} color={iconColor} strokeWidth={2.2} />, action: "compact" },
  ];
  const nameOf = (item: Capability) => item.name.replace(/^\//, "");
  const matches = (item: Capability) => has(q, item.name, item.description, ...(item.aliases ?? []));
  const commands = ranked(
    (items ?? []).filter((item) => item.kind === "Command" && !["model", "compact"].includes(nameOf(item)) && matches(item)),
    nameOf,
    q,
  );
  const skills = ranked(
    (items ?? []).filter((item) => item.kind === "Skill" && matches(item)),
    nameOf,
    q,
  );
  const toOption = (item: Capability, group: string, icon: ReactNode): Option => {
    const cleanName = item.name.replace(/^\//, "");
    const cleanCommand = item.command.replace(/^\//, "");
    return {
      key: item.kind + ":" + item.name + ":" + item.source,
      group,
      title: "/" + cleanName,
      subtitle: item.description || item.hint,
      leading: icon,
      command: {
        name: cleanName,
        command: cleanCommand,
        kind: item.kind,
        ...(item.description ? { description: item.description } : {}),
        ...(item.hint ? { hint: item.hint } : {}),
      },
    };
  };
  return [
    ...local.filter((option) => has(q, option.title.slice(1), option.subtitle)),
    ...commands.map((item) => toOption(item, "Commands", <SquareSlash size={18} color={iconColor} strokeWidth={2.2} />)),
    ...skills.map((item) => toOption(item, "Skills", <Sparkles size={18} color={iconColor} strokeWidth={2.2} />)),
  ];
}

// --- "@" and "#" ------------------------------------------------------------------------------

// The lists read the computer's disk for files, so a few seconds' reuse saves asking on every key.
const mentionCache = new Map<string, { time: number; data: Promise<Mentionables> }>();
function loadMentionables(chatId: string, botId: string | undefined) {
  const key = chatId + "|" + (botId ?? "");
  const hit = mentionCache.get(key);
  if (hit && Date.now() - hit.time < 5000) return hit.data;
  const data = api.mentionables(chatId, botId);
  mentionCache.set(key, { time: Date.now(), data });
  data.catch(() => mentionCache.delete(key));
  return data;
}

export function useMentionables(active: boolean, chatId: string, botId: string | undefined) {
  const [data, setData] = useState<Mentionables>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    let live = true;
    setError("");
    loadMentionables(chatId, botId)
      .then((result) => live && setData(result))
      .catch((reason: unknown) => live && setError(reason instanceof Error ? reason.message : "Couldn't load the list."));
    return () => {
      live = false;
    };
  }, [active, chatId, botId]);
  return { data, error, loading: active && !data && !error };
}

/** Other people in this chat that "@" can notify with a mention. */
export function personOptions(query: string, people: { id: string; name: string; subtitle?: string }[], iconColor: string): Option[] {
  const q = query.toLowerCase();
  return ranked(
    people.filter((person) => has(q, person.name, person.subtitle)),
    (p) => p.name,
    q,
  ).map((person) => ({
    key: "person:" + person.id,
    group: "People",
    title: person.name,
    subtitle: person.subtitle || undefined,
    leading: <User size={18} color={iconColor} strokeWidth={2.2} />,
    insert: "@" + person.name,
  }));
}

/** The bots "@" can address: a group chat's members and "everyone", or a one-bot chat's teammates. */
export function botOptions(query: string, roster: Bot[], group: boolean, iconColor: string): Option[] {
  const q = query.toLowerCase();
  const heading = group ? "Bots" : "Teammates";
  const out: Option[] = ranked(
    roster.filter((bot) => has(q, bot.name, bot.role)),
    (b) => b.name,
    q,
  ).map((bot) => ({ key: "bot:" + bot.id, group: heading, title: bot.name, subtitle: bot.role || undefined, leading: <BotAvatar bot={bot} size={28} />, insert: "@" + bot.name }));
  // The desktop asks every member for "@everyone" (desktop/groups.mjs, `responders`).
  if (group && roster.length > 1 && has(q, "everyone", "all"))
    out.push({ key: "bot:everyone", group: heading, title: "everyone", subtitle: "Every member answers", leading: <Users size={18} color={iconColor} strokeWidth={2.2} />, insert: "@everyone" });
  return out;
}

/** Projects (this chat's first), wiki pages, then files and artifacts, as the desktop's "#" lists them. */
export function recordOptions(query: string, data: Mentionables | undefined, iconColor: string): Option[] {
  const q = query.toLowerCase();
  const out: Option[] = [];
  const option = (key: string, group: string, title: string, subtitle: string | undefined, Icon: typeof FileText, mention: DraftMention): Option => ({
    key,
    group,
    title,
    subtitle: subtitle || undefined,
    leading: <Icon size={18} color={iconColor} strokeWidth={2.2} />,
    mention,
  });
  const projects = ranked(
    (data?.projects ?? []).filter((project) => has(q, project.name, project.hint)),
    (p) => p.name,
    q,
  ).sort((a, b) => Number(!!b.current) - Number(!!a.current));
  for (const project of projects) out.push(option("project:" + project.id, "Projects", project.name, project.current ? "This chat's project" : project.hint, FolderKanban, { kind: "project", id: project.id, label: project.name }));
  const pages = ranked(
    (data?.wiki ?? []).filter((page) => has(q, page.title, page.hint)),
    (p) => p.title,
    q,
  );
  for (const page of pages) out.push(option("wiki:" + page.path, "Wiki", page.title, page.hint, BookOpen, { kind: "wiki", path: page.path, label: page.title }));
  const files = ranked(
    (data?.files ?? []).filter((file) => has(q, file.name, file.folder, file.where)),
    (f) => f.name,
    q,
  );
  for (const file of files) out.push(option("file:" + file.path, "Files and artifacts", file.name, [file.folder, file.where].filter(Boolean).join(" · "), FileText, { kind: "file", path: file.path, label: file.name }));
  return out;
}

// --- "#": pull requests ----------------------------------------------------------------------

type PullState = { available: boolean; reason?: string; items: PullRequest[] };

/** Pull requests of the chat's repository, asked for 200 ms after typing stops. */
export function usePullRequests(active: boolean, supported: boolean, chatId: string, query: string) {
  const [result, setResult] = useState<{ chatId: string; query: string; value: PullState }>();
  useEffect(() => {
    if (!active || !supported) return;
    let live = true;
    const timer = setTimeout(async () => {
      const value = await api["link.pullRequests"]({ chatId }, query || undefined)
        .catch(() => ({ available: false, reason: "Couldn't load pull requests.", items: [] }));
      if (live) setResult({ chatId, query, value });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [active, supported, chatId, query]);
  const value = result?.chatId === chatId && result.query === query ? result.value : undefined;
  return { value, loading: active && supported && !value };
}

export function pullOptions(items: PullRequest[], colors: { success: string; faint: string; info: string; danger: string }): Option[] {
  return items.slice(0, LIMIT).map((pull) => {
    const Icon = pull.state === "merged" ? GitMerge : pull.state === "closed" ? GitPullRequestClosed : pull.draft ? GitPullRequestDraft : GitPullRequest;
    const tint = pull.state === "merged" ? colors.info : pull.state === "closed" ? colors.danger : pull.draft ? colors.faint : colors.success;
    const state = pull.draft && pull.state === "open" ? "draft" : pull.state;
    return {
      key: "pr:" + pull.number,
      group: "Pull requests",
      title: "#" + pull.number + " " + pull.title,
      subtitle: [state, pull.author].filter(Boolean).join(" · "),
      leading: <Icon size={18} color={tint} strokeWidth={2.2} accessibilityLabel={state} />,
      insert: pullReference(pull),
    };
  });
}

// --- The list --------------------------------------------------------------------------------

const ROW = 48;

/** The suggestions, directly above the composer. Taps keep the keyboard up. */
export function SuggestionList({ options, onPick, loading, note, label }: { options: Option[]; onPick: (option: Option) => void; loading?: boolean; note?: string; label: string }) {
  const { colors } = useTheme();
  const groups: { name: string; options: Option[] }[] = [];
  for (const option of options) {
    const last = groups[groups.length - 1];
    if (last?.name === option.group) last.options.push(option);
    else groups.push({ name: option.group, options: [option] });
  }
  const quiet = (content: ReactNode) => <View style={{ minHeight: ROW, paddingHorizontal: space.lg, flexDirection: "row", alignItems: "center", gap: space.sm }}>{content}</View>;
  return (
    <View
      accessibilityLabel={label}
      style={{ maxHeight: 240, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong, overflow: "hidden" }}
    >
      <ScrollView keyboardShouldPersistTaps="always" keyboardDismissMode="none" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingVertical: space.xs }}>
        {groups.map((group) => (
          <View key={group.name} accessibilityRole="list">
            {groups.length > 1 || group.name !== "Pull requests" ? (
              <T variant="caption" color="muted" accessibilityRole="header" style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: 2 }}>
                {group.name}
              </T>
            ) : null}
            {group.options.map((option) => (
              <Tap
                key={option.key}
                onPress={() => onPick(option)}
                feel="select"
                sink={1}
                hitSlop={0}
                accessibilityLabel={option.title + (option.subtitle ? ", " + option.subtitle : "")}
                style={{ minHeight: ROW, paddingHorizontal: space.lg, paddingVertical: 4, flexDirection: "row", alignItems: "center", gap: space.md }}
              >
                <View style={{ width: 28, alignItems: "center" }}>{option.leading}</View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T variant="subhead" weight="600" numberOfLines={1}>
                    {option.title}
                  </T>
                  {!!option.subtitle && (
                    <T variant="footnote" color="muted" numberOfLines={1}>
                      {option.subtitle}
                    </T>
                  )}
                </View>
              </Tap>
            ))}
          </View>
        ))}
        {loading &&
          quiet(
            <>
              <ActivityIndicator size="small" color={colors.muted} />
              <T variant="subhead" color="muted">
                Loading…
              </T>
            </>,
          )}
        {!loading &&
          options.length === 0 &&
          quiet(
            <T variant="subhead" color="muted" numberOfLines={2} style={{ flex: 1 }}>
              {note || "No matches"}
            </T>,
          )}
        {!loading && options.length > 0 && !!note && quiet(<T variant="footnote" color="muted" numberOfLines={2} style={{ flex: 1 }}>{note}</T>)}
      </ScrollView>
    </View>
  );
}
