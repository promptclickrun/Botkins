// Spaces in the window ("spaces-v1"): the side menu's Spaces, a space's page and All spaces. The
// pure parts (names, tags, lines, lists) are in spaces.ts; the Share popover is in SpaceShare.tsx.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Ellipsis,
  LayoutGrid,
  LayoutList,
  Lightbulb,
  Lock,
  MailOpen,
  Maximize2,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Rss,
  Share,
  Sun,
  Target,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { BotAvatar } from "./Avatar";
import BoardPanel from "./Board";
import { useAsk, useMenu, type MenuItem } from "./Pages";
import { PanelCard, usePanelManager } from "./Today";
import SharePopover, { isOwner } from "./SpaceShare";
import NotesSheet from "./SpaceNotes";
import OpenedPanel from "./SpacePanelOpen";
import { usePanelDrag, usePanelResize, useSpaceDrag } from "./SpaceArrange";
import { CadencePicker, ZoneInput, cronFromCadence } from "./Routines";
import { memberTeam, teamCan } from "./teamAccess";
import { changedSpaces } from "./unread";
import {
  accessTag,
  arrangePin,
  arrangeStep,
  askBot,
  asksOf,
  changedLine,
  changedPanels,
  deleteQuestion,
  initial,
  lastLine,
  moveTargets,
  panelChanged,
  panelProject,
  spaceIcon,
  spaceLine,
  spaceName,
  spaceSections,
  spaceWhen,
  type SpaceContent,
  type SpaceStart,
  type SpaceSummary,
} from "./spaces";
import type { BoardItem, Cadence, State } from "./types";
import "./spaces.css";
import "./workspaces.css";

const api = window.botkins;
const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
export { isOwner };

const ICONS = { today: Sun, feed: Rss, ideas: Lightbulb, goals: Target, shared: Users, grid: LayoutGrid };
export function SpaceIcon({ space, size = 20 }: { space: SpaceSummary; size?: number }) {
  const Icon = ICONS[spaceIcon(space)];
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
}

/** Sets the person's pins: the order and pinned list with one space pinned or unpinned. */
export const setPinned = (spaces: SpaceSummary[], id: string, pin: boolean) => api["link.spaces.arrange"](arrangePin(spaces, id, pin));

/** The person: "owner", or their member id. */
export const personOf = (state: State) => memberTeam(state)?.me.memberId ?? "owner";

/** Move up and Move down for a pinned space, in its menu. `send` sends the new order. */
function moveItems(spaces: SpaceSummary[], id: string, send: (next: ReturnType<typeof arrangeStep>) => void): MenuItem[] {
  const up = arrangeStep(spaces, id, -1);
  const down = arrangeStep(spaces, id, 1);
  return [
    { label: "Move up", icon: ArrowUp, disabled: !up, run: () => send(up) },
    { label: "Move down", icon: ArrowDown, disabled: !down, run: () => send(down) },
  ];
}

/**
 * The side menu's Spaces: the heading and its +, the person's pinned spaces in their order, and
 * All spaces. Collapsed, each is its icon, as the places are.
 */
export function SidebarSpaces({
  state,
  collapsed,
  selected,
  openSpace,
  openAll,
  fail,
}: {
  state: State;
  collapsed: boolean;
  /** The open space's id, "all" for All spaces, or "". */
  selected: string;
  openSpace: (id: string) => void;
  openAll: () => void;
  fail: (e: unknown) => void;
}) {
  const dialogs = useAsk();
  const menu = useMenu();
  const spaces = state.spaces ?? [];
  const unreadSpaces = changedSpaces(spaces);
  // Pinned spaces are dragged up and down; a line shows where one lands.
  const drag = useSpaceDrag(spaces, fail);
  async function create() {
    const name = await dialogs.ask({ title: "New space", confirm: "Create", field: { label: "Name", value: "", max: 40 } });
    if (!name) return;
    openSpace(await api["spaces.create"]({ name }));
  }
  function markAllSpacesRead() {
    if (unreadSpaces.length === 0) return;
    void Promise.all(unreadSpaces.map((s) => api["link.spaces.seen"](s.id))).catch(fail);
  }
  return (
    <>
      <div className="sidebarlabel">
        <span className="nav-label">Spaces</span>
        <span className="sidebarlabel-actions">
          {!collapsed && unreadSpaces.length > 0 && (
            <button aria-label="Mark all spaces as read" title="Mark all as read" onClick={markAllSpacesRead}>
              <MailOpen size={15} />
            </button>
          )}
          {teamCan(state, "today", "create") && (
            <button aria-label="New space…" title={collapsed ? "New space…" : undefined} onClick={() => void create().catch(fail)}>
              <Plus size={15} />
            </button>
          )}
        </span>
      </div>
      <nav aria-label="Spaces" className="spacenav">
        {drag.shown.map((s) => {
          const on = selected === s.id;
          const name = spaceName(s);
          return (
            <button
              key={s.id}
              className={on ? "selected" : ""}
              aria-current={on ? "page" : undefined}
              aria-description={s.changed > 0 ? "Changed" : undefined}
              onClick={() => openSpace(s.id)}
              onContextMenu={(e) =>
                menu.show(e, name, [
                  ...(s.changed > 0
                    ? [{ label: "Mark as read", icon: MailOpen, run: () => void api["link.spaces.seen"](s.id).catch(fail) }, "separator" as const]
                    : []),
                  ...moveItems(spaces, s.id, drag.send),
                  "separator",
                  { label: "Unpin", icon: PinOff, run: () => void setPinned(spaces, s.id, false).catch(fail) },
                ])
              }
              {...drag.row(s.id)}
            >
              <SpaceIcon space={s} size={collapsed ? 24 : 20} />
              <span className="nav-label">{name}</span>
              {s.changed > 0 && <i />}
            </button>
          );
        })}
        <button className={"spacenav-all" + (selected === "all" ? " selected" : "")} aria-current={selected === "all" ? "page" : undefined} onClick={openAll}>
          <LayoutList size={24} className="spacenav-all-icon" aria-hidden="true" />
          <span className="nav-label">All spaces</span>
        </button>
      </nav>
      {menu.node}
      {dialogs.node}
    </>
  );
}

/** All spaces: Pinned, More and, for the owner, From members. */
export function AllSpaces({ state, openSpace, fail }: { state: State; openSpace: (id: string) => void; fail: (e: unknown) => void }) {
  const menu = useMenu();
  const spaces = state.spaces ?? [];
  // "From members" is what Admin mode shows the owner. A computer without Admin mode shows the owner everything, as before it.
  const { pinned, more, fromMembers } = spaceSections(spaces, isOwner(state) && state.adminMode !== false);
  const list = (title: string, items: SpaceSummary[]) =>
    items.length > 0 && (
      <section className="space-group" aria-label={title} key={title}>
        <h2>{title}</h2>
        <ul>
          {items.map((s) => {
            const name = spaceName(s);
            const items = (): MenuItem[] => [
              ...(s.changed > 0
                ? [{ label: "Mark as read", icon: MailOpen, run: () => void api["link.spaces.seen"](s.id).catch(fail) }, "separator" as const]
                : []),
              ...(s.pinned
                ? [...moveItems(spaces, s.id, (next) => next && void api["link.spaces.arrange"](next).catch(fail)), "separator" as const]
                : []),
              { label: s.pinned ? "Unpin" : "Pin", icon: s.pinned ? PinOff : Pin, run: () => void setPinned(spaces, s.id, !s.pinned).catch(fail) },
            ];
            return (
              <li key={s.id} onContextMenu={(e) => menu.show(e, name, items())}>
                <button className="space-row" onClick={() => openSpace(s.id)}>
                  <span className="space-tile">
                    <SpaceIcon space={s} size={17} />
                  </span>
                  <span className="space-row-text">
                    <strong>{name}</strong>
                    <small>{spaceLine(s)}</small>
                  </span>
                  {s.changed > 0 && <i className="space-dot" aria-label="Changed" />}
                </button>
                <button className="menu-button" aria-label={"Options for " + name} aria-haspopup="menu" onClick={(e) => menu.show(e, name, items())}>
                  <Ellipsis size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    );
  return (
    <div className="all-spaces">
      <h1>All spaces</h1>
      {list("Pinned", pinned)}
      {list("More", more)}
      {list("From members", fromMembers)}
      {menu.node}
    </div>
  );
}

const STARTS: { id: SpaceStart; label: string }[] = [
  { id: "checklist", label: "Checklist" },
  { id: "tracker", label: "Tracker" },
  { id: "chart", label: "Chart" },
  { id: "table", label: "Table" },
  { id: "notes", label: "Notes" },
  { id: "app", label: "App" },
];

/**
 * The sheet "New panel": a sentence, a bot, what to start from, the space it goes to and whether a
 * routine refreshes it. The owner also has the row Project (projects are the owner's): it starts on
 * the space's own project when the space has one, else on None, and the computer sets it as the
 * panel's project when the bot first publishes the panel. A member's sheet has no such row.
 */
export function NewPanel({ state, space, botId, close, opened }: { state: State; space: SpaceSummary; botId: string; close: () => void; opened: (chatId: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [prompt, setPrompt] = useState("");
  const [bot, setBot] = useState(botId);
  const [start, setStart] = useState<SpaceStart>();
  const [spaceId, setSpaceId] = useState(space.id);
  const [refresh, setRefresh] = useState(false);
  const [cadence, setCadence] = useState<Cadence>({ kind: "weekdays", time: "09:00" });
  const [zone, setZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  // The spaces a panel may be made in: the open one first, then every other the person can change.
  const choices = [space, ...(state.spaces ?? []).filter((s) => s.id !== space.id && s.can !== "view")];
  // A routine is a change to the space: a member needs Can manage for it.
  const canRefresh = teamCan(state, "today", "manage");
  // The owner's Project row. Until the person picks, it follows the chosen space's own project.
  const projects = isOwner(state) ? (state.projects ?? []) : [];
  const [pickedProject, setPickedProject] = useState<string | null | undefined>(undefined);
  const projectId = panelProject(pickedProject, choices.find((s) => s.id === spaceId), projects);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="space-sheet" aria-label="New panel" onCancel={close} onClose={close}>
      <div className="sectionhead">
        <h2>New panel</h2>
        <button type="button" aria-label="Close dialog" onClick={close}>
          <X size={19} />
        </button>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || !prompt.trim()) return;
          setBusy(true);
          setError("");
          try {
            const { chatId } = await api["spaces.newPanel"]({
              spaceId,
              botId: bot,
              prompt: prompt.trim(),
              ...(start && { start }),
              ...(projectId && { projectId }),
              ...(refresh && canRefresh && { refresh: { cron: cronFromCadence(cadence), timezone: zone } }),
            });
            opened(chatId);
          } catch (e) {
            setError(clean(e));
            setBusy(false);
          }
        }}
      >
        <label>
          What should it show?
          <textarea rows={3} autoFocus required maxLength={8000} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <label>
          Bot
          <select value={bot} onChange={(e) => setBot(e.target.value)}>
            {state.bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <div className="space-starts" role="group" aria-labelledby="space-start-label">
          <span id="space-start-label">Start from</span>
          <div>
            {STARTS.map((s) => (
              <button type="button" key={s.id} aria-pressed={start === s.id} onClick={() => setStart(start === s.id ? undefined : s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        {choices.length > 1 && (
          <label>
            Space
            <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
              {choices.map((s) => (
                <option key={s.id} value={s.id}>
                  {spaceName(s)}
                </option>
              ))}
            </select>
          </label>
        )}
        {projects.length > 0 && (
          <label>
            Project
            <select value={projectId ?? ""} onChange={(e) => setPickedProject(e.target.value || null)}>
              <option value="">None</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {canRefresh && (
          <>
            <label>
              Refresh
              <select value={refresh ? "on" : "off"} onChange={(e) => setRefresh(e.target.value === "on")}>
                <option value="off">Off</option>
                <option value="on">On a schedule</option>
              </select>
            </label>
            {refresh && (
              <div className="space-refresh">
                <CadencePicker value={cadence} onChange={setCadence} allowOnce={false} />
                <ZoneInput value={zone} onChange={setZone} />
              </div>
            )}
          </>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="ask-actions">
          <button className="primary" disabled={busy || !prompt.trim()}>
            Create
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** A space's page: its header, its panels (and cards), and the bar that asks about it. */
export function SpacePage({
  state,
  space,
  open,
  openNew,
  openProject,
  boardChat,
  removed,
  about,
  fail,
}: {
  state: State;
  space: SpaceSummary;
  /** A view in one of this space's panels handed over text: it waits in the ask bar, about that panel, not sent. */
  about?: { panelId: string; text: string; n: number };
  open: (chatId: string) => void;
  /** Opens a chat the computer just made. */
  openNew: (chatId: string) => void;
  openProject: (projectId: string) => void;
  boardChat: (botId: string, text: string, send: boolean, item?: BoardItem) => Promise<void>;
  /** After Delete space. */
  removed: () => void;
  fail: (e: unknown) => void;
}) {
  const [content, setContent] = useState<SpaceContent>();
  const held = useRef(-1);
  // What changed is told against the visit before this one, so the line and dots stay while the page is open.
  const seenAt = useRef<number | undefined>(undefined);
  const changedAtOpen = useRef(space.changed);
  // The panels opened on their own: before this visit (the read's `seenItems`), and on this page.
  // Opening one clears its dot at once, and tells the computer, so it is not news on the phone either.
  const [openedItems, setOpenedItems] = useState<Record<string, number>>({});
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [hidden, showHidden] = useState(false);
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  /** The app panel that is opened large, or null. */
  const [openedState, setOpenedState] = useState<{ id: string; fullscreen?: boolean } | null>(null);
  const openPanel = (id: string, fullscreen?: boolean) => setOpenedState({ id, fullscreen });
  const closePanel = () => setOpenedState(null);
  /** The panel the ask is about ("Ask Pip to change it"), or "" for the whole space. */
  const [aboutPanel, setAboutPanel] = useState("");
  useEffect(() => {
    if (!about) return;
    setAboutPanel(about.panelId);
    // The answer joins whatever is already typed, so nothing the person wrote is lost.
    setText((typed) => (typed.trim() ? typed + "\n\n" + about.text : about.text));
  }, [about?.n]);
  const menu = useMenu();
  const dialogs = useAsk();
  const name = spaceName(space);
  const panels = content?.panels ?? [];
  const me = personOf(state);
  const [notesOf, setNotesOf] = useState("");
  const view = space.can === "view";
  // Resizing, moving and putting panels in order are changes to the space: Can manage, on a space the person can change.
  const arrange = !view && teamCan(state, "today", "manage");
  const canNote = !view && teamCan(state, "today", "use");
  const grid = useRef<HTMLDivElement>(null);
  const manager = usePanelManager(panels, open, name, (shown, close) => {
    const panel = panels.find((p) => p.id === shown.id);
    if (!panel) return null;
    const targets = arrange ? moveTargets(state.spaces ?? [], space, panel, me) : [];
    const isApp = panel.blocks.some((b) => b.type === "html");
    return (
      <>
        {isApp && (
          <button
            onClick={() => {
              close();
              openedPanel(panel);
              openPanel(panel.id, true);
            }}
          >
            <Maximize2 size={16} />
            Open full screen
          </button>
        )}
        {targets.length > 0 && (
          <label>
            Space
            <select value={space.id} onChange={(e) => void moveTo(panel.id, e.target.value, close).catch(fail)}>
              <option value={space.id}>{name}</option>
              {targets.map((s) => (
                <option key={s.id} value={s.id}>
                  {spaceName(s)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          onClick={() => {
            close();
            setNotesOf(panel.id);
          }}
        >
          <MessageSquare size={16} />
          Notes
        </button>
      </>
    );
  });
  const addAllowed = !view && teamCan(state, "today", "create") && teamCan(state, "agents", "chat");
  const askAllowed = !view && teamCan(state, "today", "use") && teamCan(state, "agents", "chat") && state.bots.length > 0;
  const asked = panels.find((p) => p.id === aboutPanel);
  // An ask about a panel goes to that panel's bot.
  const bot = (asked && state.bots.find((b) => b.id === asked.botId)) || askBot(state.bots, panels);

  // The content is asked for, and asked again when the space's rev passes the one held.
  useEffect(() => {
    if (space.rev <= held.current) return;
    let live = true;
    api["spaces.read"](space.id)
      .then((next) => {
        if (!live) return;
        if (seenAt.current === undefined) {
          seenAt.current = next.seenAt;
          if (next.seenItems) setOpenedItems((now) => ({ ...next.seenItems, ...now }));
          // Seen once it is read, so the read still says when it was opened before.
          void api["link.spaces.seen"](space.id).catch(() => {});
        } else if (!document.hidden) {
          // A change that arrives while the person is here is seen too, so the space is not left
          // marked changed once they leave. The line and dots still tell it until then.
          void api["link.spaces.seen"](space.id).catch(() => {});
        }
        held.current = next.rev;
        setContent(next);
      })
      .catch(fail);
    return () => {
      live = false;
    };
  }, [space.id, space.rev]);
  // Who is here: told when the page comes into view, every 30 seconds while it stays, and on leaving.
  useEffect(() => {
    const id = space.id;
    const tell = () => void api["link.spaces.here"](document.hidden ? null : id).catch(() => {});
    tell();
    const timer = setInterval(() => !document.hidden && tell(), 30_000);
    document.addEventListener("visibilitychange", tell);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tell);
      void api["link.spaces.here"](null).catch(() => {});
    };
  }, [space.id]);

  const project = space.projectId ? state.projects?.find((p) => p.id === space.projectId) : undefined;
  // Once the space is read, the line counts its panels as the dots do, so a person's own tick or
  // note is not news to them. Before that, and for a space never opened, the computer's count.
  const line = content && seenAt.current ? changedLine(changedPanels(panels, seenAt.current, me, openedItems), seenAt.current) : changedLine(Math.max(space.changed, changedAtOpen.current), seenAt.current);
  /** The person opened this panel (clicked in it): its dot clears, here and on their other devices. */
  function openedPanel(panel: SpaceContent["panels"][number]) {
    if (!panelChanged(panel, seenAt.current, me, openedItems)) return;
    // Up to the change it shows: a newer one brings the dot back.
    setOpenedItems((now) => ({ ...now, [panel.id]: panel.updatedAt }));
    void api["link.spaces.seen"](space.id, panel.id).catch(() => {});
  }
  const shown = panels.filter((p) => p.hidden === hidden);
  const drag = usePanelDrag(
    shown.map((p) => p.id),
    space.id,
    grid,
    fail,
  );
  const resize = usePanelResize(grid, fail);
  const noted = panels.find((p) => p.id === notesOf);
  const hiddenCount = view ? 0 : panels.filter((p) => p.hidden).length;
  const board = space.builtin && space.builtin !== "today" ? ({ feed: "feed", ideas: "idea", goals: "goal" } as const)[space.builtin] : undefined;

  function spaceMenu(): MenuItem[] {
    return [
      {
        label: "Rename",
        icon: Pencil,
        run: () =>
          void (async () => {
            const next = await dialogs.ask({ title: "Rename", confirm: "Rename", field: { label: "Name", value: space.name, max: 40 } });
            if (next && next !== space.name) await api["spaces.rename"](space.id, next);
          })().catch(fail),
      },
      ...(teamCan(state, "today", "delete")
        ? [
            "separator" as const,
            {
              label: "Delete space",
              icon: Trash2,
              danger: true,
              run: () =>
                void (async () => {
                  const ok = await dialogs.ask({ title: deleteQuestion(space.name, content ? panels.length : space.count), confirm: "Delete", danger: true });
                  if (!ok) return;
                  await api["spaces.remove"](space.id);
                  removed();
                })().catch(fail),
            },
          ]
        : []),
    ];
  }

  /** Moves a panel to the end of another space; into a space shared by link, after asking. */
  async function moveTo(panelId: string, spaceId: string, close: () => void) {
    const target = state.spaces?.find((s) => s.id === spaceId);
    if (!target || target.id === space.id) return;
    if (target.access === "link") {
      const ok = await dialogs.ask({ title: "Move to " + spaceName(target) + "?", body: "Anyone with the link will see this panel.", confirm: "Move" });
      if (!ok) return;
    }
    await api["spaces.movePanel"](panelId, { spaceId: target.id, before: null });
    close();
  }

  async function ask() {
    const said = text.trim();
    if (!said || asking || !bot) return;
    setAsking(true);
    try {
      const { chatId } = await api["spaces.ask"]({ spaceId: space.id, botId: bot.id, text: said, ...(asked && { panelId: asked.id }) });
      setText("");
      setAboutPanel("");
      openNew(chatId);
    } catch (e) {
      fail(e);
    } finally {
      setAsking(false);
    }
  }

  const opened = openedState ? panels.find((p) => p.id === openedState.id) : undefined;
  let body: ReactNode = null;
  if (content && !shown.length && !board && !hidden)
    body = addAllowed ? (
      <div className="today-empty today-blank">
        <h2>Build your first panel</h2>
        <p>Ask a bot for a briefing, a table or a chart, kept fresh on a schedule.</p>
        <button className="textbutton" onClick={() => setAdding(true)}>
          New panel…
        </button>
      </div>
    ) : null;
  else if (shown.length)
    body = (
      <div ref={grid} className={"panel-grid" + (drag.dragging ? " arranging" : "")} {...(arrange ? drag.grid : {})}>
        {shown.map((p) => {
          const notes = p.notes?.length ?? 0;
          const place = arrange ? drag.panel(p.id) : undefined;
          return (
            <PanelCard
              key={p.id}
              state={state}
              panel={{ ...p, size: resize.sizeOf(p.id, p.size) }}
              outer={{ ...place, className: (place && [place.className, resize.pulling === p.id && "pulling"].filter(Boolean).join(" ")) || undefined, onClick: () => openedPanel(p) }}
              top={arrange ? drag.handle(p.id) : undefined}
              after={arrange && resize.corner(p)}
              fail={fail}
              readOnly={view}
              // An app panel keeps what people change in it. A person who may only look reads it.
              store={{ state: p.state ?? {}, rev: p.stateRev ?? 0, ...(canNote && { set: (patch, label) => api["spaces.patchState"](p.id, patch, label).then((answer) => answer.rev) }) }}
              manage={view ? undefined : () => manager.manage(p.id)}
              when={(t) => spaceWhen(t)}
              badges={
                <>
                  {p.blocks.some((b) => b.type === "html") && <span className="space-app">App</span>}
                  {panelChanged(p, seenAt.current, me, openedItems) && <i className="space-dot" aria-label="Changed" />}
                </>
              }
              tools={
                p.blocks.some((b) => b.type === "html") && (
                  <button aria-label={"Open " + p.title} title="Open" onClick={() => openPanel(p.id)}>
                    <Maximize2 size={16} />
                  </button>
                )
              }
              foot={p.last && <small className="space-last">{lastLine(p.last)}</small>}
              side={
                notes > 0 && (
                  <button className="space-notes" aria-label={notes === 1 ? "1 note" : notes + " notes"} onClick={() => setNotesOf(p.id)}>
                    <MessageSquare size={14} aria-hidden="true" />
                    {notes}
                  </button>
                )
              }
            />
          );
        })}
      </div>
    );

  return (
    <div className="space-shell">
      <div className="content space-page">
        <div className="space-head">
          <div className="space-title">
            <h1>{name}</h1>
            {space.can === "own" && !space.builtin && (
              <button className="menu-button space-menu" aria-label={"Options for " + name} aria-haspopup="menu" onClick={(e) => menu.show(e, name, spaceMenu())}>
                <Ellipsis size={18} />
              </button>
            )}
            <span className="space-tag">
              {space.access === "private" ? <Lock size={13} aria-hidden="true" /> : <Users size={13} aria-hidden="true" />}
              {accessTag(space)}
            </span>
            {project && (
              <button className="space-tag space-project" title="Open project" onClick={() => openProject(project.id)}>
                <span className={"space-project-dot project-color " + (project.color ?? "")} aria-hidden="true" />
                <span className="space-project-name">{project.name}</span>
              </button>
            )}
          </div>
          <div className="space-actions">
            {space.here.length > 0 && (
              <span className="space-here" role="group" aria-label="Here now">
                {space.here.slice(0, 5).map((p) => (
                  <span key={p.id} className="space-person" title={p.name} aria-label={p.name}>
                    {initial(p.name)}
                  </span>
                ))}
              </span>
            )}
            <button
              className="space-button space-pin"
              aria-label={space.pinned ? "Unpin" : "Pin"}
              aria-pressed={space.pinned}
              title={space.pinned ? "Unpin" : "Pin"}
              onClick={() => void setPinned(state.spaces ?? [], space.id, !space.pinned).catch(fail)}
            >
              <Pin size={16} fill={space.pinned ? "currentColor" : "none"} />
            </button>
            {space.can === "own" && (
              <span className="space-share-anchor">
                <button className="space-button" aria-expanded={sharing} aria-haspopup="dialog" onClick={() => setSharing(!sharing)}>
                  <Share size={16} />
                  Share
                </button>
                {sharing && <SharePopover state={state} space={space} name={name} close={() => setSharing(false)} />}
              </span>
            )}
            {addAllowed && (
              <button className="primary space-add" onClick={() => setAdding(true)}>
                <Plus size={16} />
                Add panel
              </button>
            )}
          </div>
        </div>
        {line && <p className="space-changed">{line}</p>}
        {board && content && (
          <BoardPanel state={state} cards={content.cards} only={board} fail={fail} startChat={boardChat} />
        )}
        {hiddenCount > 0 && (
          <div className="filters">
            <button aria-pressed={!hidden} onClick={() => showHidden(false)}>
              {name}
            </button>
            <button aria-pressed={hidden} onClick={() => showHidden(true)}>
              Hidden · {hiddenCount}
            </button>
          </div>
        )}
        {body}
      </div>
      {askAllowed && bot && (
        <form
          className="space-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          <BotAvatar bot={bot} size={26} />
          {asked && (
            <span className="space-ask-about">
              {asked.title}
              <button type="button" aria-label={"Ask about the whole space instead of " + asked.title} onClick={() => setAboutPanel("")}>
                <X size={13} />
              </button>
            </span>
          )}
          <input
            aria-label={asked ? "Ask " + bot.name + " to change it" : "Ask about this space, or describe a new panel"}
            placeholder={asked ? "Ask " + bot.name + " to change it" : "Ask about this space, or describe a new panel"}
            value={text}
            maxLength={8000}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="space-send" aria-label="Send" disabled={!text.trim() || asking}>
            <ArrowUp size={16} />
          </button>
        </form>
      )}
      {opened && (
        <OpenedPanel
          key={opened.id}
          title={opened.title}
          bot={askAllowed ? state.bots.find((b) => b.id === opened.botId) : undefined}
          asks={asksOf(opened)}
          frameIds={opened.blocks.flatMap((b) => (b.type === "html" ? [b.frame] : []))}
          initialFullscreen={openedState?.fullscreen}
          close={closePanel}
          ask={async (said) => {
            try {
              const { chatId } = await api["spaces.ask"]({ spaceId: space.id, botId: opened.botId, text: said, panelId: opened.id });
              closePanel();
              openNew(chatId);
            } catch (e) {
              fail(e);
            }
          }}
        >
          <PanelCard
            state={state}
            panel={{ ...opened, size: "wide" }}
            fail={fail}
            readOnly={view}
            store={{ state: opened.state ?? {}, rev: opened.stateRev ?? 0, ...(canNote && { set: (patch, label) => api["spaces.patchState"](opened.id, patch, label).then((answer) => answer.rev) }) }}
            when={(t) => spaceWhen(t)}
            badges={<span className="space-app">App</span>}
            foot={opened.last && <small className="space-last">{lastLine(opened.last)}</small>}
          />
        </OpenedPanel>
      )}
      {adding && (
        <NewPanel
          state={state}
          space={space}
          botId={bot?.id ?? ""}
          close={() => setAdding(false)}
          opened={(chatId) => {
            setAdding(false);
            openNew(chatId);
          }}
        />
      )}
      {noted && <NotesSheet space={space} panel={noted} me={me} canWrite={canNote} close={() => setNotesOf("")} />}
      {manager.node}
      {menu.node}
      {dialogs.node}
    </div>
  );
}
