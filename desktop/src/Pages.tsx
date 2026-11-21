import { useBotDrag } from "./useBotDrag";
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
  ArrowRight,
  SlidersHorizontal,
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
  Folder,
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
  Search,
  Star,
  Trash2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { BotAvatar, activityLabel, botActivity, chatActivity } from "./Avatar";
import type { Bot, Chat, Section, State } from "./types";
import { teamCan } from "./teamAccess";
import "./agents.css";
import "./groups.css";

const api = () => window.botkins;

export const dateLabel = (time: number) =>
  new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** A list's time: the hour today, "Yesterday", the weekday this week, else the date. */
export function shortTime(time: number) {
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
  addBot: () => void;
  newChat: () => void;
  showChats: () => void;
  /** Starts a new chat with this bot, even when it has older chats. */
  newChatWith: (botId: string) => void;
  /** Opens the bot page. */
  botPage: (botId: string) => void;
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
    document.body,
  );
}

/** Opens a context menu from a ⋯ button click or a right-click. */
export function useMenu() {
  const [request, setRequest] = useState<MenuRequest>();
  const close = useRef(() => setRequest(undefined)).current;
  function show(e: ReactMouseEvent<HTMLElement>, label: string, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    const button = (e.target as HTMLElement).closest<HTMLElement>(".menu-button");
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
  field?: { label: string; value: string; max: number };
};

function AskDialog({ ask, done }: { ask: Ask; done: (answer: string | null) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(ask.field?.value ?? "");
  useEffect(() => {
    ref.current?.showModal();
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
            <input
              autoFocus
              required
              maxLength={ask.field.max}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
        )}
        <div className="ask-actions">
          <button type="button" className="secondary" onClick={() => done(null)}>
            Cancel
          </button>
          <button
            className={ask.danger ? "primary danger-primary" : "primary"}
            autoFocus={!ask.field}
            disabled={!!ask.field && !value.trim()}
          >
            {ask.confirm}
          </button>
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

/** The bot ⋯ menu, shared by bot cards, the sidebar and the bot page. */
export function botMenuItems(state: State, b: Bot, actions: PageActions, ask: AskFn): MenuItem[] {
  const primary = state.bots[0]?.id === b.id;
  const sections = state.sections ?? [];
  const items: MenuItem[] = [
    { label: "New chat", icon: MessageSquarePlus, run: () => actions.newChatWith(b.id) },
    { label: "Bot page", icon: UserRound, run: () => actions.botPage(b.id) },
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
    if (item.label === "Bot page") return teamCan(state, "agents");
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

function BotCard({
  state,
  bot: b,
  actions,
  menu,
  drag,
  large,
}: {
  state: State;
  bot: Bot;
  actions: PageActions;
  menu: (e: ReactMouseEvent<HTMLElement>, b: Bot) => void;
  drag: ReturnType<ReturnType<typeof useBotDrag>["row"]>;
  large?: boolean;
}) {
  const activity = botActivity(state, b.id);
  const status = activityLabel(activity);
  const primary = state.bots[0]?.id === b.id;
  return (
    <div
      {...drag}
      className={"botcard-wrap" + (b.hidden ? " is-hidden" : "")}
      onContextMenu={(e) => menu(e, b)}
    >
      <button className="botcard" onClick={() => actions.botChat(b)}>
        <BotAvatar bot={b} state={activity} size={large ? 88 : 48} animated={large ? activity !== "idle" : undefined} />
        <span className="botcard-text">
          <strong>{b.name}</strong>
          <small>
            {primary && <span className="botbadge">Primary · </span>}
            {b.role}
          </small>
          {status && (
            <small className={"botstatus " + activity}>
              <i />
              {status}
            </small>
          )}
        </span>
      </button>
      <span className="botflags">
        {!primary && b.pinned && <Pin size={13} aria-label="Pinned" />}
        {b.hidden && <EyeOff size={13} aria-label="Hidden" />}
      </span>
      <button
        className="menu-button"
        aria-label={"Options for " + b.name}
        aria-haspopup="menu"
        onClick={(e) => menu(e, b)}
      >
        <Ellipsis size={16} />
      </button>
    </div>
  );
}

const collapsedKey = "commander.collapsedSections";
function readCollapsed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(collapsedKey) || "[]");
  } catch {
    return [];
  }
}

export function BotCards({
  state,
  actions,
  query = "",
  filter = "All",
  large,
}: {
  state: State;
  actions: PageActions;
  query?: string;
  filter?: string;
  /** Home's row: each bot is its Botkin, large, with its name and role under it. */
  large?: boolean;
}) {
  const menu = useMenu();
  const dialogs = useAsk();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const botMenu = (e: ReactMouseEvent<HTMLElement>, b: Bot) =>
    menu.show(e, b.name, botMenuItems(state, b, actions, dialogs.ask));
  const drag = useBotDrag(state.bots, actions.fail);
  const card = (b: Bot) => <BotCard key={b.id} state={state} bot={b} actions={actions} menu={botMenu} drag={drag.row(b, large)} large={large} />;
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
      <div className="bots">{matches.map(card)}</div>
    ) : (
      <p className="muted bots-none">
        {filter === "Hidden" ? "No hidden bots." : filter === "Pinned" ? "No pinned bots. Pin one from its ⋯ menu." : "No matching bots."}
      </p>
    );
  } else {
    const { primary, pinned, sections, rest } = arrangeBots(state);
    body = (
      <>
        <div className="bots">
          {primary && card(primary)}
          {pinned.map(card)}
          {!sections.length && rest.map(card)}
        </div>
        {sections.map(({ section, bots }) => {
          const open = !collapsed.includes(section.id);
          return (
            <div {...drag.place({pinned:false, sectionId:section.id})} className="botgroup" key={section.id} onContextMenu={(e) => menu.show(e, section.name, sectionMenuItems(section, actions, dialogs.ask))}>
              <div className="botgroup-head">
                <button aria-expanded={open} onClick={() => toggle(section.id)}>
                  <ChevronDown size={15} className="botgroup-chevron" />
                  <Folder size={15} />
                  <span>{section.name}</span>
                  <small>{bots.length}</small>
                </button>
                <button
                  className="menu-button"
                  aria-label={"Options for section " + section.name}
                  aria-haspopup="menu"
                  onClick={(e) => menu.show(e, section.name, sectionMenuItems(section, actions, dialogs.ask))}
                >
                  <Ellipsis size={16} />
                </button>
              </div>
              {open &&
                (bots.length ? (
                  <div className="bots">{bots.map(card)}</div>
                ) : (
                  <p className="muted bots-none">
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
            <div {...drag.place({pinned:false, sectionId:null})} className="botgroup-head plain">
              <span>Other bots</span>
            </div>
            <div className="bots">{rest.map(card)}</div>
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
 * The person's bots with their tools: search, the All / Pinned / Hidden filters, New section and
 * Add bot. On Chats everything is laid out. On Home (`home`) the bots are a row of Botkins and the
 * tools wait behind one quiet button, so the page stays calm and loses nothing.
 */
function BotsSection({ state, actions, home }: { state: State; actions: PageActions; home?: boolean }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [open, setOpen] = useState(false);
  const dialogs = useAsk();
  const hidden = state.bots.filter((b) => b.hidden).length;
  const pinned = state.bots.filter((b) => b.pinned && !b.hidden).length;
  // On Home the tools show when asked for, and stay while a search or a filter is in use.
  const tools = home ? open || filter !== "All" || !!query : state.bots.length > 3 || hidden > 0 || filter !== "All" || !!query;
  return (
    <section className={"bots-section" + (home ? " home" : "")}>
      <div className="sectionhead">
        <h2>{home ? "Your Botkins" : "Your bots"}</h2>
        <span className="sectionhead-actions">
          {home && (
            <button
              className="textbutton bot-tools-toggle"
              aria-label="Bot tools"
              aria-expanded={tools}
              title="Search, filters and sections"
              onClick={() => {
                // Closing puts everything back: no search or filter is left on out of sight.
                if (tools) {
                  setQuery("");
                  setFilter("All");
                }
                setOpen(!tools);
              }}
            >
              <SlidersHorizontal size={15} />
            </button>
          )}
          {(!home || tools) && teamCan(state, "agents", "manage") && (
          <button
            className="textbutton"
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
          {teamCan(state, "agents", "create") && (
            <button className="textbutton" onClick={actions.addBot}>
              <Plus size={15} />
              Add bot
            </button>
          )}
        </span>
      </div>
      {tools && (
        <div className="bot-tools">
          <div className="filters" role="group" aria-label="Show bots">
            {[
              ["All", "All"],
              ["Pinned", pinned ? "Pinned · " + pinned : "Pinned"],
              ["Hidden", "Hidden · " + hidden],
            ].map(([f, label]) => (
              <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {label}
              </button>
            ))}
          </div>
          <label className="search">
            <Search size={15} />
            <input
              aria-label="Search bots"
              placeholder="Search bots"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
      )}
      <BotCards state={state} actions={actions} query={query} filter={filter} large={home} />
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
export function SidebarBots({ state, actions, compact }: { state: State; actions: PageActions; compact?: boolean }) {
  const drag = useBotDrag(state.bots, actions.fail);
  const menu = useMenu();
  const dialogs = useAsk();
  const { primary, pinned, sections, rest } = arrangeBots(state);
  // One walk over the chats: each bot's latest chat (the one its row opens) and whether any is unread.
  const latest = new Map<string, Chat>();
  const unread = new Set<string>();
  for (const c of state.chats) {
    if (c.panelId || c.archived) continue;
    const seen = latest.get(c.botId);
    if (!seen || c.time > seen.time) latest.set(c.botId, c);
    if (c.unread) unread.add(c.botId);
  }
  const item = (b: Bot) => {
    const items = () => botMenuItems(state, b, actions, dialogs.ask);
    const activity = botActivity(state, b.id);
    const status = activityLabel(activity);
    const chat = latest.get(b.id);
    const last = chat?.messages.at(-1)?.text;
    const line = status || (last ? previewOf(last) : b.role);
    const lineId = "botnav-line-" + b.id;
    return (
      <div {...drag.row(b)} className="botnav-item" key={b.id} onContextMenu={(e) => menu.show(e, b.name, items())}>
        <button
          onClick={() => actions.botChat(b)}
          aria-label={b.name}
          aria-describedby={compact ? undefined : lineId}
          title={compact ? b.name + (activity === "waiting" ? " · needs you" : "") : undefined}
        >
          <BotAvatar bot={b} state={activity} size={compact ? 32 : 40} />
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

function chatMenuItems(chat: Chat, actions: PageActions, ask: AskFn): MenuItem[] {
  return [
    {
      label: chat.pinned ? "Unpin" : "Pin",
      icon: chat.pinned ? PinOff : Pin,
      run: () => run(actions, api().setChatFlags(chat.id, { pinned: !chat.pinned })),
    },
    {
      label: chat.unread ? "Mark read" : "Mark unread",
      icon: chat.unread ? MailOpen : Mail,
      run: () => run(actions, api().setChatFlags(chat.id, { unread: !chat.unread })),
    },
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
    {
      label: chat.archived ? "Restore" : "Archive",
      icon: chat.archived ? ArchiveRestore : Archive,
      run: () => run(actions, api().setChatFlags(chat.id, { archived: !chat.archived })),
    },
    // A chat in a project can leave it. One that already worked in the project's folder says why it can't.
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
}: {
  state: State;
  chat: Chat;
  open: (id: string) => void;
  /** With actions, the row gets its ⋯ and right-click menu. */
  actions?: PageActions;
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
  const controls = teamCan(state, "agents", "chat") ? actions : undefined;
  const items = () => chatMenuItems(chat, controls!, dialogs.ask);
  const last = chat.messages.at(-1)?.text;
  const row = (
    <button className={"row chatrow" + (chat.unread ? " unread" : "")} onClick={() => open(chat.id)}>
      {members.length > 1 ? (
        // Group chat: the members' avatars side by side (desktop/groups.mjs).
        <span className="group-avatars side" aria-hidden="true">
          {members.slice(0, 3).map((m) => (
            <BotAvatar key={m.id} bot={m} state={botActivity(state, m.id)} size={members.length > 2 ? 24 : 28} />
          ))}
        </span>
      ) : (
        <BotAvatar bot={b} state={chatActivity(state, chat.id)} size={40} />
      )}
      <span className="rowtext">
        <span className="rowtop">
          <strong>
            {chat.pinned && controls && <Pin size={12} className="row-pin" aria-label="Pinned" />}
            {chat.title}
          </strong>
          <time>{shortTime(chat.time)}</time>
        </span>
        <span className="rowline">
          <small>
            {createdBy && <>{createdBy} · </>}
            {members.length > 1 ? members.map((m) => m.name).join(", ") : b.name} ·{" "}
            {last ? previewOf(last) : "Start a conversation"}
          </small>
          {chat.unread && <i className="unread-dot" aria-label="Unread" />}
        </span>
        {project && (
          <small className="row-folder">
            {project.folder ? <FolderGit2 size={12} /> : <FolderKanban size={12} />} {project.name}
          </small>
        )}
      </span>
      {!controls && <ChevronRight size={16} />}
    </button>
  );
  if (!controls) return row;
  return (
    <div className="rowwrap" onContextMenu={(e) => menu.show(e, chat.title, items())}>
      {row}
      <button
        className="menu-button"
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

/**
 * Home: one question, the message box for the primary bot, that bot's Botkin, and the person's
 * Botkins in a row. Everything else a person can do with bots (search, filters, sections) is one
 * quiet button away here and laid out in full on Chats, where the chats themselves are too.
 */
export function HomePage({ state, actions, composer }: { state: State; actions: PageActions; composer: ReactNode }) {
  const attention = state.runs.filter(
    (r) => r.status === "Needs you" && state.runs.find((x) => x.chatId === r.chatId) === r,
  );
  const primary = state.bots[0];
  return (
    <>
      {/* The page's name, for screen readers: what a person sees first is the question below. */}
      <h1 className="visually-hidden">Home</h1>
      <section className="hero">
        <div className="herobody">
          <h2>What’s on your mind?</h2>
          {composer}
        </div>
        <div className="heroface">
          <BotAvatar bot={primary} state={botActivity(state, primary.id)} size={176} animated />
          <strong>{primary.name}</strong>
          <small>{primary.role}</small>
        </div>
      </section>
      {attention.length > 0 && (
        <section>
          <h2>Needs you</h2>
          {attention.map((r) => (
            <button className="row" key={r.id} onClick={() => actions.open(r.chatId)}>
              <CircleAlert size={19} />
              {r.title}
              <ChevronRight size={16} />
            </button>
          ))}
        </section>
      )}
      <BotsSection state={state} actions={actions} home />
    </>
  );
}

/** Pinned, Today, Yesterday and Earlier, newest first. */
function groupChats(chats: Chat[], pinFirst: boolean) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const yesterday = today - 86400000;
  const groups: [string, Chat[]][] = [
    ["Pinned", []],
    ["Today", []],
    ["Yesterday", []],
    ["Earlier", []],
  ];
  for (const c of chats) {
    const g = pinFirst && c.pinned ? 0 : c.time >= today ? 1 : c.time >= yesterday ? 2 : 3;
    groups[g][1].push(c);
  }
  return groups.filter(([, list]) => list.length);
}

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
  const [filter, setFilter] = useState<"All" | "Unread" | "Archived">("All");
  const chats = [...state.chats].sort((a, b) => b.time - a.time);
  const unread = chats.filter((c) => c.unread && !c.archived).length;
  const archived = chats.filter((c) => c.archived).length;
  const q = query.toLowerCase();
  const matches = chats.filter(
    (c) =>
      (filter === "Archived" ? c.archived : !c.archived && (filter === "All" || c.unread)) &&
      (c.title + " " + state.bots.find((b) => b.id === c.botId)?.name).toLowerCase().includes(q),
  );
  return (
    <>
      <h1>Chats</h1>
      <BotsSection state={state} actions={actions} />
      <section>
        <div className="sectionhead">
          <h2>Conversations</h2>
          <label className="search">
            <Search size={15} />
            <input
              aria-label="Search chats"
              placeholder="Search chats"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        <div className="filters chat-filters" role="group" aria-label="Show chats">
          {(
            [
              ["All", "All"],
              ["Unread", unread ? "Unread · " + unread : "Unread"],
              ["Archived", archived ? "Archived · " + archived : "Archived"],
            ] as const
          ).map(([f, label]) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        {groupChats(matches, filter !== "Archived").map(([label, list]) => (
          <div className="chatgroup" key={label} role="group" aria-label={label}>
            <h3 className="chatgroup-label">{label}</h3>
            {list.map((c) => (
              <ChatRow key={c.id} state={state} chat={c} open={actions.open} actions={actions} />
            ))}
          </div>
        ))}
        {!chats.length && teamCan(state, "agents", "chat") && (
          <div className="empty">
            <button className="textbutton" onClick={actions.newChat}>
              Start your first chat <ArrowRight size={15} />
            </button>
          </div>
        )}
        {!!chats.length && !matches.length && (
          <p className="muted bots-none">
            {query
              ? "No matching chats."
              : filter === "Unread"
                ? "You're all caught up."
                : filter === "Archived"
                  ? "No archived chats."
                  : "No chats. Restore one from Archived."}
          </p>
        )}
      </section>
    </>
  );
}
