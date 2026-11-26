import { storageKey } from "./storage";
import { useBotDrag } from "./useBotDrag";
import { useChatDrag } from "./useChatDrag";
import { chatGroups, chatsPageUnreadChats, hasChatSections, isVisibleInChatList, movedSection, type ChatGroup } from "./chatSections";
import { isRoutineChat } from "../desktop/link/routine-chat.mjs";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderMinus,
  CircleAlert,
  Copy,
  Ellipsis,
  Eye,
  EyeOff,
  FolderGit2,
  FolderKanban,
  FolderInput,
  FolderPlus,
  Mail,
  MailOpen,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCw,
  Search,
  Star,
  Trash2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { Button, Input, SearchField } from "glisse";
import { BotAvatar, activityLabel, botActivity, chatActivity } from "./Avatar";
import type { Bot, Chat, Section, State } from "./types";
import { memberTeam, teamCan } from "./teamAccess";
import { botUnreadChats, unreadBotIds } from "./unread";
import "./agents.css";
import "./groups.css";
import "./home.css";
import { upcomingRuns, whenLabel } from "./Routines";

const api = () => window.botkins;

export const dateLabel = (time: number) =>
  new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** A list's time: the hour today, "Yesterday", the weekday this week, else the date. */
export function shortTime(time: number) {
  if (!time) return "";
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (time >= today) return new Date(time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (time >= today - 86400000) return "Yesterday";
  if (time >= today - 6 * 86400000) return new Date(time).toLocaleDateString(undefined, { weekday: "long" });
  return dateLabel(time);
}

/** A message as one quiet preview line: its first lines of prose, without markdown marks. Tables and code are left out. */
const previewOf = (text: string) =>
  text
    .slice(0, 600)
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .split("\n")
    .filter((line) => !/^\s*\|/.test(line))
    .join(" ")
    .replace(/(^|\s)[-+*]\s+(\[[ xX]\]\s+)?/g, " ")
    .replace(/[`*#>]+/g, "")
    .replace(/-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/** Actions the list pages ask the shell to perform. */
export type PageActions = {
  open: (chatId: string) => void;
  botChat: (bot: Bot) => void;
  /** Marks every unread chat that counts toward this bot's side-menu dot as read. */
  markBotRead: (botId: string) => void;
  /** Marks every non-archived, non-panel unread chat across all bots as read. */
  markAllRead: () => void;
  mainChat: (botId: string) => void;
  addBot: () => void;
  newChat: () => void;
  showChats: () => void;
  /** Starts a new chat with this bot, even when it has older chats. */
  newChatWith: (botId: string) => void;
  /** Opens the bot page. */
  botPage: (botId: string) => void;
  /** Opens the bot page on the setup steps of its Proactive agent ("Who should <Bot> look out for?"), for right after a bot is made. */
  proactiveSetup: (botId: string) => void;
  /** Opens Settings on its Capabilities tab for this bot. */
  capabilities: (botId: string) => void;
  fail: (e: unknown) => void;
};

/* ------------------------------------------------------------------ menus */

export type MenuItem =
  | {
      label: string;
      icon?: LucideIcon;
      run?: () => void;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      submenu?: MenuItem[];
    }
  | "separator";

type MenuRequest = {
  x: number;
  y: number;
  items: MenuItem[];
  label: string;
  from: HTMLElement | null;
  /** The opening button's top edge; the menu flips above it when it does not fit below. */
  above?: number;
};

/** A small context menu. Arrow keys move, Escape closes, ArrowRight/Enter opens a submenu. */
function Menu({ request, close }: { request: MenuRequest; close: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [stack, setStack] = useState<{ label: string; items: MenuItem[] }[]>([]);
  const [pos, setPos] = useState({ left: request.x, top: request.y });
  const level = stack.at(-1);
  const items = level?.items ?? request.items;
  useLayoutEffect(() => {
    const r = box.current!.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(request.x, innerWidth - r.width - 8)),
      top:
        request.y + r.height > innerHeight - 8 && request.above !== undefined && request.above - r.height - 4 >= 8
          ? request.above - r.height - 4
          : Math.max(8, Math.min(request.y, innerHeight - r.height - 8)),
    });
    box.current!.querySelector<HTMLButtonElement>("[role^=menuitem]:not(:disabled)")?.focus();
  }, [request, stack.length]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) close();
    };
    const dismiss = () => close();
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [close]);
  function key(e: ReactKeyboardEvent<HTMLDivElement>) {
    const list = [...box.current!.querySelectorAll<HTMLButtonElement>("[role^=menuitem]:not(:disabled)")];
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(list.length - 1);
    else if (e.key === "ArrowLeft" && stack.length) setStack((s) => s.slice(0, -1));
    else if (e.key === "ArrowRight") (document.activeElement as HTMLElement)?.dataset.submenu && (document.activeElement as HTMLElement).click();
    else if (e.key === "Escape") {
      if (stack.length) setStack((s) => s.slice(0, -1));
      else {
        close();
        request.from?.focus();
      }
    } else if (e.key === "Tab") close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  return createPortal(
    <div
      ref={box}
      className="agent-menu"
      role="menu"
      aria-label={level?.label ?? request.label}
      style={pos}
      onKeyDown={key}
      onContextMenu={(e) => e.preventDefault()}
    >
      {level && (
        <button role="menuitem" className="menu-back" onClick={() => setStack((s) => s.slice(0, -1))}>
          <ChevronLeft size={15} />
          {level.label}
        </button>
      )}
      {items.map((item, i) =>
        item === "separator" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role={item.checked !== undefined ? "menuitemradio" : "menuitem"}
            aria-checked={item.checked}
            aria-haspopup={item.submenu ? "menu" : undefined}
            data-submenu={item.submenu ? "1" : undefined}
            disabled={item.disabled}
            className={item.danger ? "danger" : undefined}
            onClick={() => {
              if (item.submenu) setStack((s) => [...s, { label: item.label, items: item.submenu! }]);
              else {
                close();
                request.from?.focus();
                item.run?.();
              }
            }}
          >
            {item.checked !== undefined ? (
              <Check size={15} style={{ visibility: item.checked ? "visible" : "hidden" }} />
            ) : (
              item.icon && <item.icon size={15} />
            )}
            <span>{item.label}</span>
            {item.submenu && <ChevronRight size={14} className="menu-more" />}
          </button>
        ),
      )}
    </div>,
    request.from?.closest("dialog") ?? document.body,
  );
}

/** Opens a context menu from a ⋯ button click or a right-click. */
export function useMenu() {
  const [request, setRequest] = useState<MenuRequest>();
  const close = useRef(() => setRequest(undefined)).current;
  function show(e: ReactMouseEvent<HTMLElement>, label: string, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    const button = (e.target as HTMLElement).closest<HTMLElement>('.menu-button, button[aria-haspopup="menu"]');
    if (e.type === "contextmenu" || !button) {
      setRequest({ x: e.clientX, y: e.clientY, items, label, from: e.currentTarget.querySelector(".menu-button") });
    } else {
      const r = button.getBoundingClientRect();
      setRequest({ x: r.right - 210, y: r.bottom + 4, above: r.top, items, label, from: button });
    }
  }
  return { show, node: request && <Menu request={request} close={close} /> };
}

/* --------------------------------------------------------------- dialogs */

type Ask = {
  title: string;
  body?: string;
  confirm: string;
  danger?: boolean;
  /** Set to ask for text; the answer is the trimmed text. */
  field?: { label: string; value: string; max: number; emoji?: boolean };
};

function AskDialog({ ask, done }: { ask: Ask; done: (answer: string | null) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(ask.field?.value ?? "");
  useEffect(() => {
    ref.current?.showModal();
    if (ask.field?.emoji) void window.botkins.showEmojiPanel();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="ask-dialog"
      aria-label={ask.title}
      onCancel={(e) => {
        e.preventDefault();
        done(null);
      }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          done(ask.field ? value.trim() : "ok");
        }}
      >
        <h2>{ask.title}</h2>
        {ask.body && <p>{ask.body}</p>}
        {ask.field && (
          <label>
            {ask.field.label}
            <Input
              autoFocus
              required
              maxLength={ask.field.max}
              value={value}
              onValueChange={setValue}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
        )}
        <div className="ask-actions">
          <Button variant="glass" className="lg-compact" onClick={() => done(null)}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="filled"
            destructive={ask.danger}
            className="lg-compact"
            autoFocus={!ask.field}
            disabled={!!ask.field && !value.trim()}
          >
            {ask.confirm}
          </Button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}

/** Promise-based confirm and text prompts drawn as Botkins dialogs. */
export function useAsk() {
  const [current, setCurrent] = useState<{ ask: Ask; resolve: (v: string | null) => void }>();
  const ask = (a: Ask) =>
    new Promise<string | null>((resolve) => setCurrent({ ask: a, resolve }));
  const node = current && (
    <AskDialog
      ask={current.ask}
      done={(v) => {
        setCurrent(undefined);
        current.resolve(v);
      }}
    />
  );
  return { ask, node };
}
type AskFn = ReturnType<typeof useAsk>["ask"];

/* ------------------------------------------------------------ bot order */

/** The bot list in Bighelp's order: primary, pinned, each section, then the rest. Hidden bots are left out. */
export function arrangeBots(state: State) {
  const [primary, ...others] = state.bots;
  const visible = others.filter((b) => !b.hidden);
  const pinned = visible.filter((b) => b.pinned);
  const sections = (state.sections ?? []).map((section) => ({
    section,
    bots: visible.filter((b) => !b.pinned && b.sectionId === section.id),
  }));
  const known = new Set(sections.map((s) => s.section.id));
  const rest = visible.filter((b) => !b.pinned && !(b.sectionId && known.has(b.sectionId)));
  return { primary, pinned, sections, rest, hidden: others.filter((b) => b.hidden) };
}

const run = (actions: PageActions, p: Promise<unknown>) => void p.catch(actions.fail);
/** A call about chat sections: the computer's sentence is shown as it comes, without the window's wrapping. */
const runSection = (actions: PageActions, p: Promise<unknown>) =>
  void p.catch((e: unknown) => actions.fail((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "")));

/** The bot ⋯ menu, shared by bot cards, the sidebar and the bot page. */
export function botMenuItems(state: State, b: Bot, actions: PageActions, ask: AskFn): MenuItem[] {
  const primary = state.bots[0]?.id === b.id;
  const sections = state.sections ?? [];
  const hasUnread = botUnreadChats(state.chats, b.id).length > 0;
  const items: MenuItem[] = [
    ...(state.proactive?.chatMode ? [{ label: "Main chat", icon: MessageSquarePlus, run: () => actions.mainChat(b.id) }] : []),
    { label: "New chat", icon: MessageSquarePlus, run: () => actions.newChatWith(b.id) },
    { label: "Bot page", icon: UserRound, run: () => actions.botPage(b.id) },
    ...(hasUnread ? [{ label: "Mark as read", icon: MailOpen, run: () => actions.markBotRead(b.id) }] : []),
    "separator",
    {
      label: b.pinned ? "Unpin" : "Pin",
      icon: b.pinned ? PinOff : Pin,
      run: () => run(actions, api().setBotFlags(b.id, { pinned: !b.pinned })),
    },
    {
      label: "Move to section",
      icon: FolderInput,
      submenu: [
        ...sections.map((s) => ({
          label: s.name,
          checked: b.sectionId === s.id,
          run: () => run(actions, api().setBotFlags(b.id, { sectionId: s.id })),
        })),
        {
          label: "None",
          checked: !b.sectionId || !sections.some((s) => s.id === b.sectionId),
          run: () => run(actions, api().setBotFlags(b.id, { sectionId: null })),
        },
        "separator",
        {
          label: "New section…",
          icon: FolderPlus,
          run: () =>
            run(
              actions,
              (async () => {
                const name = await ask({
                  title: "New section",
                  body: b.name + " moves into it.",
                  confirm: "Create section",
                  field: { label: "Section name", value: "", max: 40 },
                });
                if (!name) return;
                const id = await api().addSection(name);
                await api().setBotFlags(b.id, { sectionId: id });
              })(),
            ),
        },
      ],
    },
    {
      label: "Make primary",
      icon: Star,
      disabled: primary,
      run: () => run(actions, api().makePrimary(b.id)),
    },
    {
      label: "Duplicate",
      icon: Copy,
      run: () => run(actions, api().duplicateBot(b.id)),
    },
    {
      label: b.hidden ? "Show" : "Hide",
      icon: b.hidden ? Eye : EyeOff,
      // The backend refuses to hide the primary bot.
      disabled: primary && !b.hidden,
      run: () => run(actions, api().setBotFlags(b.id, { hidden: !b.hidden })),
    },
    "separator",
    {
      label: "Delete…",
      icon: Trash2,
      danger: true,
      disabled: state.bots.length < 2,
      run: () => run(actions, deleteBot(b, ask)),
    },
  ];
  const kept = items.filter((item) => {
    if (item === "separator") return true;
    if (item.label === "New chat") return teamCan(state, "agents", "chat");
    if (item.label === "Bot page" || item.label === "Mark as read") return teamCan(state, "agents");
    if (item.label === "Duplicate") return teamCan(state, "agents", "create");
    if (item.label.startsWith("Delete")) return teamCan(state, "agents", "delete");
    return teamCan(state, "agents", "manage");
  });
  return kept.filter((item, index) => item !== "separator" || (index > 0 && index < kept.length - 1 && kept[index - 1] !== "separator"));
}

export async function deleteBot(b: Bot, ask: AskFn) {
  const ok = await ask({
    title: "Delete " + b.name + "?",
    body:
      "This removes " +
      b.name +
      " and all of its chats, Today panels and history. You can't undo this.",
    confirm: "Delete bot",
    danger: true,
  });
  if (ok) await api().deleteBot(b.id);
  return !!ok;
}

function sectionMenuItems(section: Section, actions: PageActions, ask: AskFn): MenuItem[] {
  return [
    {
      label: "Rename…",
      icon: Pencil,
      run: () =>
        run(
          actions,
          (async () => {
            const name = await ask({
              title: "Rename section",
              confirm: "Rename",
              field: { label: "Section name", value: section.name, max: 40 },
            });
            if (name && name !== section.name) await api().renameSection(section.id, name);
          })(),
        ),
    },
    {
      label: "Delete section…",
      icon: Trash2,
      danger: true,
      run: () =>
        run(
          actions,
          (async () => {
            const ok = await ask({
              title: "Delete “" + section.name + "”?",
              body: "Its bots stay. They move out of the section.",
              confirm: "Delete section",
              danger: true,
            });
            if (ok) await api().deleteSection(section.id);
          })(),
        ),
    },
  ];
}

/* ------------------------------------------------------------- bot cards */

/**
 * Each bot's latest conversation and the bots with an unread chat, in one walk over the chats: the
 * conversation the default bot selection opens (its Main chat, when that is the choice), as in the
 * side menu, so a bot's row says the same thing in both places.
 */
function botLatest(state: State) {
  const showMain = state.proactive?.chatMode && (state.settings.botTap ?? "main") === "main";
  const creator = memberTeam(state)?.me.memberId;
  const latest = new Map<string, Chat>();
  for (const c of state.chats) {
    if (c.panelId || c.archived) continue;
    if (showMain && (!c.main || c.createdBy !== creator)) continue;
    const seen = latest.get(c.botId);
    if (!seen || c.time > seen.time) latest.set(c.botId, c);
  }
  return { latest, unread: unreadBotIds(state.chats) };
}

/** A bot as a row of a card, as on the phone: its avatar, its name, one quiet line, the time and the unread dot. */
function BotCard({
  state,
  bot: b,
  actions,
  menu,
  drag,
  chat,
  unread,
}: {
  state: State;
  bot: Bot;
  actions: PageActions;
  menu: (e: ReactMouseEvent<HTMLElement>, b: Bot) => void;
  drag: ReturnType<ReturnType<typeof useBotDrag>["row"]>;
  /** The bot's latest conversation, for the quiet line and the time. */
  chat?: Chat;
  unread?: boolean;
}) {
  const activity = botActivity(state, b.id);
  const status = activityLabel(activity);
  const primary = state.bots[0]?.id === b.id;
  const last = chat?.messages.at(-1)?.text;
  // What it is doing, else what was said last, else what it is for.
  const line = status || (last ? previewOf(last) : b.role);
  return (
    <div
      {...drag}
      className={"botcard-wrap group-row" + (b.hidden ? " is-hidden" : "")}
      onContextMenu={(e) => menu(e, b)}
    >
      <button className="botcard" onClick={() => actions.botChat(b)}>
        <BotAvatar bot={b} state={activity} size={44} />
        <span className="botcard-text">
          <span className="botcard-top">
            <strong>{b.name}</strong>
            {primary && <span className="botbadge">Primary</span>}
            {!primary && b.pinned && <Pin size={12} className="botcard-flag" aria-label="Pinned" />}
            {b.hidden && <EyeOff size={12} className="botcard-flag" aria-label="Hidden" />}
            {chat && <time className={unread ? "unread" : undefined}>{shortTime(chat.time)}</time>}
          </span>
          <span className="botcard-line">
            <small className={status ? "botcard-status " + activity : undefined}>{line}</small>
            {unread && <i className="unread-dot" aria-label="Unread" />}
          </span>
        </span>
      </button>
      <button
        className="menu-button icon-btn"
        aria-label={"Options for " + b.name}
        aria-haspopup="menu"
        onClick={(e) => menu(e, b)}
      >
        <Ellipsis size={16} />
      </button>
    </div>
  );
}

const collapsedKey = storageKey("collapsedSections");
function readCollapsed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(collapsedKey) || "[]");
  } catch {
    return [];
  }
}

/**
 * The bots as the phone lists them: the primary bot and the pinned ones in the first card, then each
 * section as an uppercase label (it folds, and has its ⋯) over a card of its bots. A search or a
 * filter shows one card of the matches. Rows drag between sections.
 */
export function BotCards({
  state,
  actions,
  query = "",
  filter = "All",
}: {
  state: State;
  actions: PageActions;
  query?: string;
  filter?: string;
}) {
  const menu = useMenu();
  const dialogs = useAsk();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const botMenu = (e: ReactMouseEvent<HTMLElement>, b: Bot) =>
    menu.show(e, b.name, botMenuItems(state, b, actions, dialogs.ask));
  const drag = useBotDrag(state.bots, actions.fail);
  const { latest, unread } = botLatest(state);
  const card = (b: Bot) => (
    <BotCard
      key={b.id}
      state={state}
      bot={b}
      actions={actions}
      menu={botMenu}
      drag={drag.row(b)}
      chat={latest.get(b.id)}
      unread={unread.has(b.id)}
    />
  );
  function toggle(id: string) {
    const next = collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id];
    setCollapsed(next);
    try {
      localStorage.setItem(collapsedKey, JSON.stringify(next));
    } catch {
      /* per-viewer convenience only */
    }
  }
  const q = query.trim().toLowerCase();
  let body: ReactNode;
  if (q || filter !== "All") {
    const matches = state.bots.filter(
      (b) =>
        (filter === "Hidden" ? b.hidden : filter === "Pinned" ? b.pinned && !b.hidden : !b.hidden) &&
        (!q || (b.name + " " + b.role + " " + (b.summary ?? "")).toLowerCase().includes(q)),
    );
    body = matches.length ? (
      <div className="group bots">{matches.map(card)}</div>
    ) : (
      <p className="group-foot bots-none">
        {filter === "Hidden" ? "No hidden bots." : filter === "Pinned" ? "No pinned bots. Pin one from its ⋯ menu." : "No matching bots."}
      </p>
    );
  } else {
    const { primary, pinned, sections, rest } = arrangeBots(state);
    body = (
      <>
        <div className="group bots">
          {primary && card(primary)}
          {pinned.map(card)}
          {!sections.length && rest.map(card)}
        </div>
        {sections.map(({ section, bots }) => {
          const open = !collapsed.includes(section.id);
          const sectionMenu = (e: ReactMouseEvent<HTMLElement>) =>
            menu.show(e, section.name, sectionMenuItems(section, actions, dialogs.ask));
          return (
            <div {...drag.place({ pinned: false, sectionId: section.id })} className="botgroup" key={section.id} onContextMenu={sectionMenu}>
              <div className="botgroup-head group-label">
                <button className="botgroup-toggle" aria-expanded={open} onClick={() => toggle(section.id)}>
                  <span>{section.name}</span>
                  <small>· {bots.length}</small>
                  <ChevronDown size={14} className="botgroup-chevron" />
                </button>
                <span className="spacer" />
                <button
                  className="menu-button icon-btn"
                  aria-label={"Options for section " + section.name}
                  aria-haspopup="menu"
                  onClick={sectionMenu}
                >
                  <Ellipsis size={16} />
                </button>
              </div>
              {open &&
                (bots.length ? (
                  <div className="group bots">{bots.map(card)}</div>
                ) : (
                  <p className="group-foot bots-none">
                    {state.bots.some((b) => b.sectionId === section.id && !b.hidden)
                      ? "Its bots are pinned above."
                      : "No bots here yet. Use “Move to section” in a bot’s ⋯ menu."}
                  </p>
                ))}
            </div>
          );
        })}
        {sections.length > 0 && rest.length > 0 && (
          <div className="botgroup">
            <div {...drag.place({ pinned: false, sectionId: null })} className="botgroup-head group-label plain">
              <span>Other bots · {rest.length}</span>
            </div>
            <div className="group bots">{rest.map(card)}</div>
          </div>
        )}
      </>
    );
  }
  return (
    <>
      {body}
      {drag.zones(state.sections ?? [])}
      {menu.node}
      {dialogs.node}
    </>
  );
}

/**
 * Home's "Your bots" board: the All / Pinned / Hidden chips, search (behind one button, and kept open
 * while a search is typed), New section, and the bots. Add bot is in the page header.
 */
function BotsSection({ state, actions, className }: { state: State; actions: PageActions; className?: string }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [searching, setSearching] = useState(false);
  const dialogs = useAsk();
  const hidden = state.bots.filter((b) => b.hidden).length;
  const pinned = state.bots.filter((b) => b.pinned && !b.hidden).length;
  const search = searching || !!query;
  return (
    <section className={"page-section bots-section" + (className ? " " + className : "")} aria-labelledby="home-bots-title">
      <div className="board-head">
        <h2 id="home-bots-title" className="board-title">
          Your bots
        </h2>
        <div className="chip-row" role="group" aria-label="Show bots">
          {[
            ["All", "All"],
            ["Pinned", pinned ? "Pinned · " + pinned : "Pinned"],
            ["Hidden", "Hidden · " + hidden],
          ].map(([f, label]) => (
            <button key={f} className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button
          className="icon-btn"
          aria-label="Bot tools"
          aria-expanded={search}
          title="Search bots"
          onClick={() => {
            // Closing clears the search, so nothing is left filtered out of sight.
            if (search) setQuery("");
            setSearching(!search);
          }}
        >
          <Search size={16} />
        </button>
        {teamCan(state, "agents", "manage") && (
          <button
            className="link-button"
            onClick={() =>
              run(
                actions,
                (async () => {
                  const name = await dialogs.ask({
                    title: "New section",
                    body: "Group bots into a section. Move bots in from their ⋯ menu.",
                    confirm: "Create section",
                    field: { label: "Section name", value: "", max: 40 },
                  });
                  if (name) await api().addSection(name);
                })(),
              )
            }
          >
            <FolderPlus size={15} />
            New section
          </button>
        )}
      </div>
      {search && (
        <SearchField
          className="lg-search-compact bots-search"
          aria-label="Search bots"
          placeholder="Search bots"
          autoFocus
          value={query}
          onValueChange={setQuery}
        />
      )}
      <BotCards state={state} actions={actions} query={query} filter={filter} />
      {dialogs.node}
    </section>
  );
}

/* --------------------------------------------------------------- sidebar */

/**
 * The bots in the side menu, in the bot cards' order with hidden bots left out. Each row is the bot's
 * avatar, its name, and one line: what it is doing, else its latest chat's last message, else its role.
 * `compact`: the menu is collapsed to icons, so each bot is its avatar with its name as a tooltip.
 */
export function SidebarBots({ state, actions, compact, selectedBotId }: { state: State; actions: PageActions; compact?: boolean; /** The bot whose chat is open, drawn selected. */ selectedBotId?: string }) {
  const drag = useBotDrag(state.bots, actions.fail);
  const menu = useMenu();
  const dialogs = useAsk();
  const { primary, pinned, sections, rest } = arrangeBots(state);
  // One walk over the chats for each bot's latest preview: the conversation the default bot
  // selection opens (its Main chat, when that is the choice). The shared helper owns the unread
  // dot, which can come from any of the bot's chats.
  const showMain = state.proactive?.chatMode && (state.settings.botTap ?? "main") === "main";
  const creator = memberTeam(state)?.me.memberId;
  const latest = new Map<string, Chat>();
  for (const c of state.chats) {
    if (c.panelId || c.archived) continue;
    if (showMain && (!c.main || c.createdBy !== creator)) continue;
    const seen = latest.get(c.botId);
    if (!seen || c.time > seen.time) latest.set(c.botId, c);
  }
  const unread = unreadBotIds(state.chats);
  const item = (b: Bot) => {
    const items = () => botMenuItems(state, b, actions, dialogs.ask);
    const activity = botActivity(state, b.id);
    const status = activityLabel(activity);
    const chat = latest.get(b.id);
    const last = chat?.messages.at(-1)?.text;
    const line = status || (last ? previewOf(last) : b.role);
    const lineId = "botnav-line-" + b.id;
    return (
      <div {...drag.row(b)} className={"botnav-item" + (b.id === selectedBotId ? " selected" : "")} key={b.id} onContextMenu={(e) => menu.show(e, b.name, items())}>
        <button
          onClick={() => actions.botChat(b)}
          aria-label={b.name}
          aria-describedby={compact ? undefined : lineId}
          title={compact ? b.name + (activity === "waiting" ? " · needs you" : "") : undefined}
        >
          <BotAvatar bot={b} state={activity} size={compact ? 32 : 24} />
          <span className="botnav-text">
            <span className="botnav-top">
              <span className="botnav-name">{b.name}</span>
              {unread.has(b.id) && <i className="unread-dot" aria-label="Unread" />}
            </span>
            {/* The time sits on the quiet line, so the name has the row's whole width. */}
            <span className={"botnav-line" + (status ? " busy " + activity : "")} id={lineId}>
              <span>{line}</span>
              {chat && !status && <time>{shortTime(chat.time)}</time>}
            </span>
            {/* The row is one line: what the bot is doing, else nothing (the unread dot is beside the name). */}
            {status && (
              <span className={"botnav-meta " + (activity === "waiting" ? "waiting" : "busy")} aria-hidden="true">
                {activity === "waiting" ? "Needs you" : "Working"}
              </span>
            )}
          </span>
          {activity === "waiting" && <i className="botnav-alert" aria-label="Needs you" />}
        </button>
        <button
          className="menu-button"
          aria-label={"Options for " + b.name}
          aria-haspopup="menu"
          onClick={(e) => menu.show(e, b.name, items())}
        >
          <Ellipsis size={15} />
        </button>
      </div>
    );
  };
  return (
    <div className="botnav">
      {primary && item(primary)}
      {pinned.map(item)}
      {sections.map(
        ({ section, bots }) =>
          bots.length > 0 && (
            <div {...drag.place({pinned:false, sectionId:section.id})} className="botnav-group" key={section.id} role="group" aria-label={section.name}>
              <span className="botnav-label">{section.name}</span>
              {bots.map(item)}
            </div>
          ),
      )}
      {sections.some((s) => s.bots.length) && rest.length > 0 && <span className="botnav-label">Other</span>}
      {rest.map(item)}
      {drag.zones(state.sections ?? [])}
      {menu.node}
      {dialogs.node}
    </div>
  );
}

/* ----------------------------------------------------------------- chats */

/** A chat's "Move to section": each of the person's sections, None, then New section… ("chat-sections-v1"). */
function chatSectionItem(state: State, chat: Chat, actions: PageActions, ask: AskFn): MenuItem {
  const sections = state.chatSections ?? [];
  const put = (sectionId: string | null) => runSection(actions, api()["link.chats.setSection"](chat.id, sectionId));
  return {
    label: "Move to section",
    icon: FolderInput,
    submenu: [
      ...sections.map((s) => ({ label: s.name, checked: chat.sectionId === s.id, run: () => put(s.id) })),
      {
        label: "None",
        checked: !chat.sectionId || !sections.some((s) => s.id === chat.sectionId),
        run: () => put(null),
      },
      "separator",
      {
        label: "New section…",
        icon: FolderPlus,
        run: () =>
          runSection(
            actions,
            (async () => {
              const name = await ask({
                title: "New section",
                body: chat.title + " moves into it.",
                confirm: "Create section",
                field: { label: "Section name", value: "", max: 40 },
              });
              if (!name) return;
              const id = await api()["link.chats.addSection"](name);
              await api()["link.chats.setSection"](chat.id, id);
            })(),
          ),
      },
    ],
  };
}

/** A section's menu on the Chats page: Rename…, Move up, Move down, Delete section…. */
function chatSectionMenuItems(state: State, section: Section, actions: PageActions, ask: AskFn): MenuItem[] {
  const sections = state.chatSections ?? [];
  const order = (by: -1 | 1) => movedSection(sections, section.id, by);
  const move = (by: -1 | 1) => {
    const ids = order(by);
    if (ids) runSection(actions, api()["link.chats.orderSections"](ids));
  };
  return [
    {
      label: "Rename…",
      icon: Pencil,
      run: () =>
        runSection(
          actions,
          (async () => {
            const name = await ask({
              title: "Rename section",
              confirm: "Rename",
              field: { label: "Section name", value: section.name, max: 40 },
            });
            if (name && name !== section.name) await api()["link.chats.renameSection"](section.id, name);
          })(),
        ),
    },
    { label: "Move up", icon: ArrowUp, disabled: !order(-1), run: () => move(-1) },
    { label: "Move down", icon: ArrowDown, disabled: !order(1), run: () => move(1) },
    "separator",
    {
      label: "Delete section…",
      icon: Trash2,
      danger: true,
      run: () =>
        runSection(
          actions,
          (async () => {
            const ok = await ask({
              title: "Delete “" + section.name + "”?",
              body: "Its chats stay. They move out of the section.",
              confirm: "Delete section",
              danger: true,
            });
            if (ok) await api()["link.chats.deleteSection"](section.id);
          })(),
        ),
    },
  ];
}

export function regenerateTitleItem(state: State, chat: Chat, fail: (error: unknown) => void): MenuItem | undefined {
  const host = state.remote?.using;
  const member = memberTeam(state);
  if (
    (host && !host.capabilities.includes("chat-title-regeneration-v1")) ||
    !teamCan(state, "agents", "chat") ||
    (member && chat.createdBy !== member.me.memberId) ||
    chat.main || !(chat.count ?? chat.messages.length) ||
    chat.panelId ||
    chat.schedules?.some((entry) => entry.routine)
  ) return undefined;
  return {
    label: "Regenerate title",
    icon: RotateCw,
    run: () => void api().regenerateChatTitle(chat.id).catch(fail),
  };
}

function chatMenuItems(state: State, chat: Chat, actions: PageActions, ask: AskFn): MenuItem[] {
  const titleItem = regenerateTitleItem(state, chat, actions.fail);
  const common: MenuItem[] = [
    {
      label: chat.pinned ? "Unpin" : "Pin",
      icon: chat.pinned ? PinOff : Pin,
      run: () => run(actions, api().setChatFlags(chat.id, { pinned: !chat.pinned })),
    },
    // Only when the computer in use keeps sections; without them the menu is as before.
    ...(hasChatSections(state) ? [chatSectionItem(state, chat, actions, ask)] : []),
    ...(!isRoutineChat(chat)
      ? [
          {
            label: chat.unread ? "Mark read" : "Mark unread",
            icon: chat.unread ? MailOpen : Mail,
            run: () => run(actions, api().setChatFlags(chat.id, { unread: !chat.unread })),
          },
        ]
      : []),
  ];
  if (chat.main) return common;
  return [
    ...common,
    {
      label: "Rename…",
      icon: Pencil,
      run: () =>
        run(
          actions,
          (async () => {
            const title = await ask({
              title: "Rename chat",
              confirm: "Rename",
              field: { label: "Title", value: chat.title, max: 120 },
            });
            if (title && title !== chat.title) await api().renameChat(chat.id, title);
          })(),
        ),
    },
    ...(titleItem ? [titleItem] : []),
    {
      label: chat.archived ? "Restore" : "Archive",
      icon: chat.archived ? ArchiveRestore : Archive,
      run: () => run(actions, api().setChatFlags(chat.id, { archived: !chat.archived })),
    },
    // A chat in a project can leave it. Its next turn carries the transcript.
    ...(chat.projectId
      ? [{ label: "Remove from project", icon: FolderMinus, run: () => run(actions, api().setChatProject(chat.id, null, "default")) }]
      : []),
    "separator",
    {
      label: "Delete…",
      icon: Trash2,
      danger: true,
      run: () =>
        run(
          actions,
          (async () => {
            const ok = await ask({
              title: "Delete “" + chat.title + "”?",
              body: "This removes the chat and its history. You can't undo this.",
              confirm: "Delete chat",
              danger: true,
            });
            if (ok) await api().deleteChat(chat.id);
          })(),
        ),
    },
  ];
}

export function ChatRow({
  state,
  chat,
  open,
  actions,
  drag,
  look = "list",
  selected,
}: {
  state: State;
  chat: Chat;
  open: (id: string) => void;
  /** With actions, the row gets its ⋯ and right-click menu. */
  actions?: PageActions;
  /** On the Chats page with sections, the row can be dragged into one. */
  drag?: ReturnType<ReturnType<typeof useChatDrag>["row"]>;
  /** "card": a row of a grouped card (the Chats page, the chat list column, the bot page). "list": the plain row other pages use. */
  look?: "list" | "card";
  /** The chat open beside the list, drawn selected. */
  selected?: boolean;
}) {
  const b = state.bots.find((b) => b.id === chat.botId);
  const members = (chat.botIds ?? []).map((id) => state.bots.find((x) => x.id === id)).filter((x): x is Bot => !!x);
  const project = chat.projectId ? state.projects?.find((p) => p.id === chat.projectId) : undefined;
  const createdBy =
    chat.createdBy && state.team && "members" in state.team
      ? state.team.members.find((member) => member.id === chat.createdBy)?.name
      : chat.messages.find((message) => message.author?.memberId === chat.createdBy)?.author?.name;
  const menu = useMenu();
  const dialogs = useAsk();
  if (!b) return null;
  const canChat = teamCan(state, "agents", "chat");
  const unread = !!chat.unread && !isRoutineChat(chat);
  const canMarkRead = !canChat && unread && teamCan(state, "agents");
  const controls = canChat || canMarkRead ? actions : undefined;
  const items = (): MenuItem[] =>
    canChat
      ? chatMenuItems(state, chat, controls!, dialogs.ask)
      : [
          {
            label: "Mark read",
            icon: MailOpen,
            run: () => run(controls!, api().setChatFlags(chat.id, { unread: false })),
          },
        ];
  const lastMessage = chat.messages.at(-1);
  const last = lastMessage?.text;
  const card = look === "card";
  // On a card the quiet line says who spoke last, as the phone does: "You: …" or "Gordie: …".
  const speaker =
    lastMessage?.role === "user"
      ? lastMessage.author?.name ?? "You"
      : (lastMessage?.botId && state.bots.find((x) => x.id === lastMessage.botId)?.name) ||
        (members.length > 1 ? members.map((m) => m.name).join(", ") : b.name);
  const avatar =
    members.length > 1 ? (
      // Group chat: the members' avatars (desktop/groups.mjs).
      <span className={"group-avatars " + (card ? "stack" : "side")} aria-hidden="true">
        {(card ? members.slice(0, 2) : members.slice(0, 3)).map((m) => (
          <BotAvatar key={m.id} bot={m} state={botActivity(state, m.id)} size={card ? 28 : members.length > 2 ? 24 : 28} />
        ))}
      </span>
    ) : (
      <BotAvatar bot={b} state={chatActivity(state, chat.id)} size={40} />
    );
  const row = (
    <button
      className={"row chatrow" + (unread ? " unread" : "")}
      aria-current={selected ? "true" : undefined}
      onClick={() => open(chat.id)}
    >
      {avatar}
      <span className="rowtext">
        <span className="rowtop">
          <strong>
            {chat.pinned && canChat && controls && <Pin size={12} className="row-pin" aria-label="Pinned" />}
            {chat.title}
          </strong>
          <time>{shortTime(chat.time)}</time>
        </span>
        <span className="rowline">
          <small>
            {card ? (
              <>
                {createdBy && lastMessage?.role !== "user" && <>{createdBy} · </>}
                {last ? speaker + ": " + previewOf(last) : (members.length > 1 ? members.map((m) => m.name).join(", ") : b.name) + " · No messages yet"}
              </>
            ) : (
              <>
                {createdBy && <>{createdBy} · </>}
                {members.length > 1 ? members.map((m) => m.name).join(", ") : b.name} ·{" "}
                {last ? previewOf(last) : "Start a conversation"}
              </>
            )}
          </small>
          {unread && <i className="unread-dot" aria-label="Unread" />}
        </span>
        {project && (
          <small className="row-folder">
            {project.folder ? <FolderGit2 size={12} /> : <FolderKanban size={12} />} {project.name}{project.folder && " · " + (chat.folder ?? project.folder)}
          </small>
        )}
      </span>
      {!controls && <ChevronRight size={16} className={card ? "row-chevron" : undefined} />}
    </button>
  );
  const wrap = "rowwrap" + (card ? " group-row chat-item" : "") + (selected ? " selected" : "");
  if (!controls) return card ? <div className={wrap}>{row}</div> : row;
  return (
    <div {...drag} className={wrap} onContextMenu={(e) => menu.show(e, chat.title, items())}>
      {row}
      <button
        className={"menu-button" + (card ? " icon-btn" : "")}
        aria-label="Chat options"
        aria-haspopup="menu"
        onClick={(e) => menu.show(e, chat.title, items())}
      >
        <Ellipsis size={16} />
      </button>
      {menu.node}
      {dialogs.node}
    </div>
  );
}

/* ----------------------------------------------------------------- pages */

/** "Good morning", "Good afternoon" or "Good evening", by the computer's clock. */
function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

type Need = { key: string; bot?: Bot; title: string; sub: string; action: string; go?: () => void };

/**
 * What is waiting on the person: a bot's open question or approval, a turn that stopped for them, and
 * tasks on the board in review or blocked. One row each, newest kind first.
 */
function needsYou(state: State, actions: PageActions, openWork?: () => void): Need[] {
  const chats = new Map(state.chats.map((c) => [c.id, c]));
  const botOf = (id?: string | null) => (id ? state.bots.find((b) => b.id === id) : undefined);
  const out: Need[] = [];
  const asked = new Set<string>();
  for (const r of state.requests ?? []) {
    const chat = chats.get(r.chatId);
    if (r.nodeJob || !chat) continue;
    asked.add(r.chatId);
    const bot = botOf(r.botId);
    out.push({ key: "r:" + r.id, bot, title: r.title, sub: (bot?.name ?? "A bot") + " needs you · " + chat.title, action: "Open", go: () => actions.open(r.chatId) });
  }
  for (const r of state.runs) {
    // A turn that stopped for the person, once per chat (the newest run comes first).
    if (r.status !== "Needs you" || asked.has(r.chatId) || state.runs.find((x) => x.chatId === r.chatId) !== r) continue;
    const chat = chats.get(r.chatId);
    if (!chat) continue;
    asked.add(r.chatId);
    const bot = botOf(chat.botId);
    out.push({ key: "u:" + r.id, bot, title: r.title, sub: (bot?.name ?? "A bot") + " needs you · " + chat.title, action: "Open", go: () => actions.open(r.chatId) });
  }
  for (const t of state.tasks ?? []) {
    if (t.status !== "review" && t.status !== "blocked") continue;
    const bot = botOf(t.botId);
    const chatId = t.chatId && chats.has(t.chatId) ? t.chatId : undefined;
    out.push({
      key: "t:" + t.id,
      bot,
      title: t.title,
      sub: (bot?.name ?? "Unassigned") + " · " + (t.status === "review" ? "task ready for review" : "task blocked" + (t.problem ? ": " + t.problem : "")),
      action: t.status === "review" ? "Review" : "Open",
      go: openWork ?? (chatId ? () => actions.open(chatId) : undefined),
    });
  }
  return out;
}

/** The line under Home's greeting: who is working and how much waits on the person. */
function homeStatus(state: State, needs: number) {
  const busy = state.bots.filter((b) => {
    const a = botActivity(state, b.id);
    return a !== "idle" && a !== "waiting" && a !== "needs-input";
  });
  const working =
    busy.length === 0
      ? ""
      : busy.length === 1
        ? busy[0].name + " is working"
        : busy.length === 2
          ? busy[0].name + " and " + busy[1].name + " are working"
          : busy.length + " bots are working";
  const waiting = needs === 0 ? "" : needs === 1 ? "1 thing needs you" : needs + " things need you";
  return [working, waiting].filter(Boolean).join(" · ") || "Nothing needs you right now";
}

const boardKind = { feed: "Feed", idea: "Idea", goal: "Goal" } as const;

/**
 * Home, laid out like the phone's: a greeting with what is going on, the message box for the primary
 * bot, what needs the person, then the bots beside Today and the routines up next. The bots' tools
 * (filters, search, sections, drag to arrange) live here; Chats is for conversations.
 */
export function HomePage({
  state,
  actions,
  composer,
  openWork,
  openRoutines,
  openToday,
}: {
  state: State;
  actions: PageActions;
  composer: ReactNode;
  /** Opens Work, where tasks in review or blocked are handled. */
  openWork?: () => void;
  /** Opens Routines, on one routine (its chat's id) or on the list. */
  openRoutines?: (target: { id?: string }) => void;
  /** Opens Today. */
  openToday?: () => void;
}) {
  const needs = needsYou(state, actions, openWork);
  const now = Date.now();
  const today = teamCan(state, "today")
    ? (state.board ?? [])
        .filter((i) => i.status === "open" && !(i.snoozedUntil && i.snoozedUntil > now))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 3)
    : [];
  const next = upcomingRuns(state).slice(0, 4);
  const side = today.length > 0 || next.length > 0;
  return (
    <div className="page home-page">
      {/* The page's name, for screen readers and tests: what a person sees first is the greeting. */}
      <h1 className="visually-hidden">Home</h1>
      <div className="page-head">
        <div className="page-heading">
          <p className="page-title">{greeting()}</p>
          <p className="page-sub">{homeStatus(state, needs.length)}</p>
        </div>
        <div className="page-actions">
          {teamCan(state, "agents", "create") && (
            <button className="btn primary" onClick={actions.addBot}>
              <Plus size={16} />
              Add bot
            </button>
          )}
        </div>
      </div>
      {composer && (
        <section className="home-composer" aria-label="Ask a bot">
          {composer}
        </section>
      )}
      {needs.length > 0 && (
        <section className="page-section" aria-labelledby="home-needs-title">
          <h2 id="home-needs-title" className="group-label">
            Needs you · {needs.length}
          </h2>
          <div className="group">
            {needs.map((n) => (
              <div className="group-row need-row" key={n.key}>
                {n.bot ? <BotAvatar bot={n.bot} state={botActivity(state, n.bot.id)} size={36} /> : <span className="icon-tile"><CircleAlert size={16} /></span>}
                <span className="row-main">
                  <span className="row-title">{n.title}</span>
                  <span className="row-sub">{n.sub}</span>
                </span>
                <span className="status-dot waiting" aria-hidden="true" />
                {n.go && (
                  <button className="btn soft small" aria-label={n.action + " " + n.title} onClick={n.go}>
                    {n.action}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      <div className="page-columns">
        <BotsSection state={state} actions={actions} className="main-column" />
        {side && (
          <div className="home-side">
            {today.length > 0 && (
              <section className="page-section" aria-labelledby="home-today-title">
                <div className="board-head">
                  <h2 id="home-today-title" className="board-title">
                    Today
                  </h2>
                  <span className="spacer" />
                  {openToday && (
                    <button className="link-button" onClick={openToday}>
                      Open Today
                      <ChevronRight size={14} />
                    </button>
                  )}
                </div>
                <div className="group">
                  {today.map((item) => {
                    const bot = state.bots.find((b) => b.id === item.botId);
                    return (
                      <div className="group-row today-item" key={item.id}>
                        <span className="today-meta">
                          {bot && <BotAvatar bot={bot} size={18} animated={false} />}
                          {bot && <strong>{bot.name}</strong>}
                          <span>
                            {shortTime(item.createdAt)} · {item.category || boardKind[item.kind]}
                          </span>
                        </span>
                        <h3 className="row-title">{item.title}</h3>
                        {item.body && <p className="row-sub">{previewOf(item.body)}</p>}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
            {next.length > 0 && (
              <section className="page-section" aria-labelledby="home-next-title">
                <div className="group-label">
                  <h2 id="home-next-title">Up next</h2>
                  <span className="spacer" />
                  {openRoutines && (
                    <button className="link-button" onClick={() => openRoutines({})}>
                      All routines
                    </button>
                  )}
                </div>
                <div className="group">
                  {next.map(({ chat, entry, bot, at }) => (
                    <button
                      className="group-row next-row"
                      key={chat.id + ":" + entry.id}
                      onClick={() => (entry.routine && openRoutines ? openRoutines({ id: chat.id }) : actions.open(chat.id))}
                    >
                      {bot && <BotAvatar bot={bot} size={32} animated={false} />}
                      <span className="row-main">
                        <span className="row-title">{entry.name || entry.prompt}</span>
                      </span>
                      <span className="row-value">{whenLabel(at)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The sections folded in the chat lists, kept while the app is open (not saved). */
const foldedChatSections = new Set<string>();

type ChatFilterName = "All" | "Unread" | "Archived";

/** The All / Unread / Archived chips plus the "Show routine chats" toggle over a chat list. */
function ChatFilterChips({
  state,
  actions,
  filter,
  setFilter,
  selectedChatId,
}: {
  state: State;
  actions: PageActions;
  filter: ChatFilterName;
  setFilter: (f: ChatFilterName) => void;
  selectedChatId?: string;
}) {
  const showRoutineChats = !!state.settings.showRoutineChats;
  const unread = chatsPageUnreadChats(state.chats).length;
  const archived = state.chats.filter((c) => c.archived && isVisibleInChatList(c, { showRoutineChats, selectedChatId })).length;
  const hasRoutines = state.chats.some((c) => isRoutineChat(c));
  return (
    <div className="chip-row chat-filters" role="group" aria-label="Show chats">
      {(
        [
          ["All", "All"],
          ["Unread", unread ? "Unread · " + unread : "Unread"],
          ["Archived", archived ? "Archived · " + archived : "Archived"],
        ] as const
      ).map(([f, label]) => (
        <button key={f} className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
          {label}
        </button>
      ))}
      {(hasRoutines || showRoutineChats) && (
        <button
          className="chip"
          aria-pressed={showRoutineChats}
          onClick={() => run(actions, api().setPreferences({ showRoutineChats: !showRoutineChats }))}
        >
          Show routine chats
        </button>
      )}
    </div>
  );
}

/** Makes a new chat section, from the Chats page header ("chat-sections-v1"). */
function newChatSection(actions: PageActions, ask: AskFn) {
  runSection(
    actions,
    (async () => {
      const name = await ask({
        title: "New section",
        body: "Group chats into a section. Move chats in from their ⋯ menu, or drag them.",
        confirm: "Create section",
        field: { label: "Section name", value: "", max: 40 },
      });
      if (name) await api()["link.chats.addSection"](name);
    })(),
  );
}

/**
 * The chats, grouped: Pinned, the person's sections (they fold, have a ⋯ menu and take dropped
 * chats), then Today, Yesterday and Earlier, or the archived ones. Each group is an uppercase label
 * over a card of rows. The Chats page and the chat list beside an open chat both draw this.
 */
function ChatList({
  state,
  actions,
  query,
  filter,
  selectedChatId,
}: {
  state: State;
  actions: PageActions;
  query: string;
  filter: ChatFilterName;
  selectedChatId?: string;
}) {
  const [folded, setFolded] = useState(() => new Set(foldedChatSections));
  const menu = useMenu();
  const dialogs = useAsk();
  const drag = useChatDrag(state.chats, (e) => runSection(actions, Promise.reject(e)));
  const showRoutineChats = !!state.settings.showRoutineChats;
  const chats = state.chats;
  // Sections are there only when the computer in use keeps them ("chat-sections-v1").
  const sections = hasChatSections(state) ? state.chatSections ?? [] : undefined;
  const groups = chatGroups({ chats, sections, query, filter, showRoutineChats, selectedChatId, botName: (c) => state.bots.find((b) => b.id === c.botId)?.name });
  const matched = groups.some((group) => group.chats.length);
  // A chat is dragged into a section only where its menu could move it there.
  const movable = !!sections && filter !== "Archived" && teamCan(state, "agents", "chat");
  function fold(id: string) {
    if (foldedChatSections.has(id)) foldedChatSections.delete(id);
    else foldedChatSections.add(id);
    setFolded(new Set(foldedChatSections));
  }
  const rows = (list: Chat[]) => (
    <div className="group chat-rows">
      {list.map((c) => (
        <ChatRow
          key={c.id}
          state={state}
          chat={c}
          open={actions.open}
          actions={actions}
          drag={movable ? drag.row(c) : undefined}
          look="card"
          selected={c.id === selectedChatId}
        />
      ))}
    </div>
  );
  const plain = (group: ChatGroup) => (
    <div className="chatgroup page-section" key={group.key} role="group" aria-label={group.label}>
      <h3 className="group-label chatgroup-label">{group.label}</h3>
      {rows(group.chats)}
    </div>
  );
  const sectionGroup = (group: Extract<ChatGroup, { kind: "section" }>) => {
    const { section } = group;
    // While searching, a folded section opens, so its matches show.
    const open = !!query || !folded.has(section.id);
    const sectionMenu = (e: ReactMouseEvent<HTMLElement>) => menu.show(e, section.name, chatSectionMenuItems(state, section, actions, dialogs.ask));
    return (
      <div
        {...(movable ? drag.place(section.id) : {})}
        className="chatgroup chatsection page-section"
        key={group.key}
        role="group"
        aria-label={section.name}
        onContextMenu={movable ? sectionMenu : undefined}
      >
        <div className="chatsection-head group-label">
          <button className="botgroup-toggle" aria-expanded={open} onClick={() => fold(section.id)}>
            <span>{section.name}</span>
            <small>· {group.chats.length}</small>
            <ChevronDown size={14} className="botgroup-chevron" />
          </button>
          <span className="spacer" />
          {movable && (
            <button className="menu-button icon-btn" aria-label={"Options for section " + section.name} aria-haspopup="menu" onClick={sectionMenu}>
              <Ellipsis size={16} />
            </button>
          )}
        </div>
        {open && (group.chats.length ? rows(group.chats) : <p className="group-foot chatsection-none">No chats here yet.</p>)}
      </div>
    );
  };
  const days = groups.filter((group) => group.kind === "day");
  return (
    <>
      {groups.map((group) => (group.kind === "pinned" ? plain(group) : group.kind === "section" ? sectionGroup(group) : null))}
      {movable && sections!.length > 0 ? (
        // The chats in no section are one place to drop a chat on, which takes it out of its section.
        days.length > 0 ? (
          <div {...drag.place(null)} className="chatgroups-loose">
            {days.map(plain)}
          </div>
        ) : (
          drag.dragging?.sectionId && (
            <div className="bot-drop-zones">
              <div {...drag.place(null)}>None</div>
            </div>
          )
        )
      ) : (
        days.map(plain)
      )}
      {!chats.length && teamCan(state, "agents", "chat") && (
        <div className="chats-empty">
          <button className="link-button" onClick={actions.newChat}>
            Start your first chat <ArrowRight size={15} />
          </button>
        </div>
      )}
      {!!chats.length && !matched && (
        <p className="group-foot bots-none">
          {query
            ? "No matching chats."
            : filter === "Unread"
              ? "You're all caught up."
              : filter === "Archived"
                ? "No archived chats."
                : !showRoutineChats && chats.some((c) => !c.archived && isRoutineChat(c))
                  ? "Routine chats are hidden."
                  : "No chats. Restore one from Archived."}
        </p>
      )}
      {menu.node}
      {dialogs.node}
    </>
  );
}

/** Chats: the person's conversations, with search, the filters, Mark all as read, New section and New chat. Bots are on Home. */
export function ChatsPage({
  state,
  actions,
  query,
  setQuery,
}: {
  state: State;
  actions: PageActions;
  query: string;
  setQuery: (q: string) => void;
}) {
  const [filter, setFilter] = useState<ChatFilterName>("All");
  const dialogs = useAsk();
  const unread = chatsPageUnreadChats(state.chats).length;
  const canChat = teamCan(state, "agents", "chat");
  return (
    <div className="page chats-page">
      <div className="page-head">
        <div className="page-heading">
          <h1 className="page-title">Chats</h1>
        </div>
        <div className="page-actions">
          {hasChatSections(state) && canChat && (
            <button className="btn quiet" onClick={() => newChatSection(actions, dialogs.ask)}>
              <FolderPlus size={15} />
              New section
            </button>
          )}
          {unread > 0 && teamCan(state, "agents") && (
            <button className="btn quiet chat-mark-read" onClick={() => actions.markAllRead()}>
              <MailOpen size={15} />
              Mark all as read
            </button>
          )}
          {canChat && (
            // Named apart from the side menu's own New chat button, which the window keeps too.
            <button className="btn primary" aria-label="Start a new chat" onClick={actions.newChat}>
              <MessageSquarePlus size={15} />
              New chat
            </button>
          )}
        </div>
      </div>
      <div className="chats-tools">
        <Input
          className="lg-search-compact chats-search"
          icon={<Search size={15} />}
          aria-label="Search chats"
          placeholder="Search chats"
          value={query}
          onValueChange={setQuery}
        />
        <ChatFilterChips state={state} actions={actions} filter={filter} setFilter={setFilter} />
      </div>
      <ChatList state={state} actions={actions} query={query} filter={filter} />
      {dialogs.node}
    </div>
  );
}

/**
 * The chat list for beside an open chat: the same groups and rows as the Chats page in a narrow
 * column (about 340px) with its own scroll, its own search and filters, and a small header with
 * Chats, New section, Mark all as read and New chat. `selectedChatId` is drawn selected.
 */
export function ChatListColumn({
  state,
  actions,
  selectedChatId,
}: {
  state: State;
  actions: PageActions;
  /** The chat open beside the list. */
  selectedChatId?: string;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ChatFilterName>("All");
  const dialogs = useAsk();
  const unread = chatsPageUnreadChats(state.chats).length;
  const canChat = teamCan(state, "agents", "chat");
  return (
    <section className="chatlist-column" aria-label="Chat list">
      <div className="chatlist-head">
        <div className="chatlist-title">
          <h2>Chats</h2>
          {hasChatSections(state) && canChat && (
            <button className="icon-btn" aria-label="New section" title="New section" onClick={() => newChatSection(actions, dialogs.ask)}>
              <FolderPlus size={16} />
            </button>
          )}
          {unread > 0 && teamCan(state, "agents") && (
            <button className="icon-btn" aria-label="Mark all as read" title="Mark all as read" onClick={() => actions.markAllRead()}>
              <MailOpen size={16} />
            </button>
          )}
          {canChat && (
            <button className="icon-btn chatlist-new" aria-label="Start a new chat" title="New chat" onClick={actions.newChat}>
              <Plus size={17} />
            </button>
          )}
        </div>
        <Input
          className="lg-search-compact chats-search"
          icon={<Search size={15} />}
          aria-label="Search chats"
          placeholder="Search chats"
          value={query}
          onValueChange={setQuery}
        />
        <ChatFilterChips state={state} actions={actions} filter={filter} setFilter={setFilter} selectedChatId={selectedChatId} />
      </div>
      <div className="chatlist-scroll">
        <ChatList state={state} actions={actions} query={query} filter={filter} selectedChatId={selectedChatId} />
      </div>
      {dialogs.node}
    </section>
  );
}
