// The pane beside a chat (docs/SIDE_PANE.md). A one-bot chat's own Details come first; then one tab
// for each panel a bot opened there: a page it wrote (in the sandboxed frame of an html block), a
// table, a website in the app's own viewer, or the Screen panel. The tabs live in the chat's state,
// so a phone sees the same ones; what the person does with them goes back through sidePane().
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { AppWindow, ArrowLeft, ArrowRight, ExternalLink, File, FileAudio, FileImage, FileText, FileVideo, Folder, Globe, Info, MonitorUp, Pin, RotateCw, Table2, TriangleAlert, X } from "lucide-react";
import { BotAvatar, type AvatarState } from "./Avatar";
import ChatSide from "./ChatSide";
import HtmlFrame from "./HtmlFrame";
import { ScreenPanel } from "./ScreenSettings";
import { AddToProjectDialog, canAddToProject } from "./ProjectExtras";
import type { Artifact, Bot, Chat, PanePanel, State } from "./types";
import "./blocks.css";
import "./sidepane.css";

// The website viewer is Electron's <webview>. The main process lets one in only with this partition
// and an http(s) address, and sets everything else about it (desktop/webviewer.mjs).
const VIEWER_PARTITION = "side-pane-web";
type Viewer = HTMLWebViewElement & {
  src: string;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
};

type Action = "select" | "remove" | "pin" | "unpin" | "closed" | "opened";
/** Tells the app what the person did. Looked up at the call, so a test can watch it. */
export const paneAction = (chatId: string, action: Action, panelId?: string | null) => void window.botkins.sidePane(chatId, action, panelId).catch(() => {});

// ---- When a bot's ask opens or closes the pane.
// The `seq` of each chat's latest ask this window has dealt with. A chat that isn't on screen has
// its asks dealt with by doing nothing, so opening it later doesn't open the pane.
const handled = new Map<string, number>();
let onScreen: string | null = null;
let watching = false;
function watchOffScreen() {
  if (watching) return;
  watching = true;
  window.botkins.subscribe((state) => {
    for (const chat of state.chats) {
      const last = handled.get(chat.id);
      if (chat.id !== onScreen && last !== undefined) handled.set(chat.id, Math.max(last, chat.pane?.ask?.seq ?? 0));
    }
  });
}

/**
 * Calls `react(close)` when a bot asks something of the pane of the chat on screen: `close` false
 * to open it, true to close it. Only a rise of `seq` counts. A chat seen for the first time takes
 * the `seq` it has as dealt with, unless the turn that asked is still running.
 */
export function usePaneAsk(state: State, chat: Chat, react: (close: boolean) => void) {
  const seq = chat.pane?.ask?.seq ?? 0;
  const latest = useRef(react);
  latest.current = react;
  useEffect(() => {
    watchOffScreen();
    onScreen = chat.id;
    return () => {
      if (onScreen === chat.id) onScreen = null;
    };
  }, [chat.id]);
  useEffect(() => {
    const ask = chat.pane?.ask;
    const last = handled.get(chat.id);
    handled.set(chat.id, Math.max(last ?? 0, seq));
    if (!ask) return;
    const fresh = last === undefined ? state.runs.some((r) => r.id === ask.runId && r.status === "Working") : seq > last;
    if (fresh) latest.current(!!ask.close);
  }, [chat.id, seq]);
}

/** True while the window is too narrow for the pane beside the chat: it opens as a drawer instead. */
export function useNarrow() {
  const query = "(max-width: 1079px)";
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const change = () => setNarrow(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return narrow;
}

const KIND_ICONS = { rich_ui: AppWindow, table: Table2, web: Globe, screen: MonitorUp } as const;
const KIND_NAMES = { rich_ui: "View", table: "Table", web: "Website", screen: "Screen" } as const;
const DETAILS = "details";
const ARTIFACTS = "artifacts";
const tabId = (chatId: string, id: string) => "pane-tab-" + chatId + "-" + id;
const bodyId = (chatId: string, id: string) => "pane-body-" + chatId + "-" + id;

export default function SidePane({
  state,
  chat,
  bot,
  face,
  group,
  drawer,
  close,
  openRoutines,
  openBot,
  openChat,
  preview,
}: {
  state: State;
  chat: Chat;
  /** The chat's bot, for Details. */
  bot: Bot;
  face: AvatarState;
  /** A group chat has no Details: only the panels. */
  group: boolean;
  /** Shown over the conversation, in a narrow window. */
  drawer: boolean;
  /** The person closes the pane. */
  close: () => void;
  openRoutines?: (target: { id?: string; botId?: string }) => void;
  openBot?: () => void;
  openChat?: (id: string, messageIndex?: number) => void;
  preview?: { item: Artifact; local: boolean };
}) {
  const panels = chat.pane?.panels ?? [];
  const active = chat.pane?.active ?? null;
  // The tab the person just chose shows at once, until the app's answer says the same.
  const [picked, setPicked] = useState<string | null>();
  const askSeq = chat.pane?.ask?.seq ?? 0;
  useEffect(() => setPicked(undefined), [active, askSeq]);
  const wanted = picked !== undefined ? picked : active;
  // A chat-path preview is an explicit navigation request from ChatView. Keep this
  // local to the pane so it does not mutate the bot's persisted pane selection.
  useEffect(() => {
    if (preview) setPicked(ARTIFACTS);
  }, [preview?.item.id, preview?.local]);
  // A tab that is gone shows Details instead, or in a group chat the newest panel.
  const shownPanel = panels.find((p) => p.id === wanted) ?? (group ? panels.at(-1) : undefined);
  const front = wanted === ARTIFACTS ? ARTIFACTS : shownPanel?.id ?? (group ? ARTIFACTS : DETAILS);
  const tabs: { id: string; panel?: PanePanel }[] = [...(group ? [] : [{ id: DETAILS }]), { id: ARTIFACTS }, ...panels.map((panel) => ({ id: panel.id, panel }))];
  const showTabs = true;
  const botOf = (id: string) => state.bots.find((b) => b.id === id);

  const select = (id: string) => {
    if (id === ARTIFACTS) { setPicked(ARTIFACTS); return; }
    const panelId = id === DETAILS ? null : id;
    setPicked(panelId);
    paneAction(chat.id, "select", panelId);
  };
  const remove = (panel: PanePanel) => paneAction(chat.id, "remove", panel.id);
  const pin = (panel: PanePanel) => paneAction(chat.id, panel.pinned ? "unpin" : "pin", panel.id);

  // The tab in front stays in view in a strip that scrolls.
  const strip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [front, panels.length]);
  // Arrow keys, Home and End move between tabs and show the one they land on; Delete closes a panel's tab.
  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((t) => t.id === front);
    let next = -1;
    if (e.key === "ArrowRight") next = (at + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (at - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else if (e.key === "Delete" && shownPanel) {
      e.preventDefault();
      remove(shownPanel);
      return;
    } else return;
    e.preventDefault();
    select(tabs[next].id);
    requestAnimationFrame(() => document.getElementById(tabId(chat.id, tabs[next].id))?.focus());
  };

  const opener = shownPanel ? botOf(shownPanel.botId) : undefined;
  return (
    <aside
      className={"side-pane" + (shownPanel ? " wide" : "") + (drawer ? " drawer" : "")}
      aria-label="Side pane"
      onKeyDown={(e) => {
        if (drawer && e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          close();
        }
      }}
    >
      {(showTabs || drawer) && (
        <div className="pane-head">
          {showTabs ? (
            <div
              className="pane-tabs"
              role="tablist"
              aria-label="Side pane tabs"
              ref={strip}
              onKeyDown={onKeys}
              // A mouse wheel scrolls a crowded strip sideways.
              onWheel={(e) => {
                if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
              }}
            >
              {tabs.map(({ id, panel }) => {
                const selected = id === front;
                const who = panel ? botOf(panel.botId) : undefined;
                const Icon = panel ? KIND_ICONS[panel.kind] : id === ARTIFACTS ? File : Info;
                const title = panel ? panel.title : id === ARTIFACTS ? "Artifacts" : "Details";
                const name = title + (panel ? ", " + KIND_NAMES[panel.kind].toLowerCase() + " from " + (who?.name ?? "a removed bot") : "") + (panel?.pinned ? ", pinned" : "") + (panel?.unseen && !selected ? ", new" : "");
                return (
                  <div key={id} className={"pane-tab" + (selected ? " selected" : "") + (panel?.pinned ? " pinned" : "")}>
                    <button
                      type="button"
                      role="tab"
                      id={tabId(chat.id, id)}
                      aria-selected={selected}
                      aria-controls={bodyId(chat.id, id)}
                      aria-label={name}
                      title={title}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => select(id)}
                    >
                      <Icon size={14} aria-hidden="true" className="pane-kind" />
                      <span className="pane-tab-title">{title}</span>
                      {who && <BotAvatar bot={who} size={16} badge={false} />}
                      {panel?.pinned && <Pin size={11} aria-hidden="true" className="pane-pinned" />}
                      {panel?.unseen && !selected && <i className="pane-dot" aria-hidden="true" />}
                    </button>
                    {panel && (
                      // For the pointer; from the keyboard Delete closes the tab, and the bar below has the same button.
                      <button type="button" className="pane-tab-close" tabIndex={-1} aria-label={"Close tab " + title} title="Close tab" onClick={() => remove(panel)}>
                        <X size={12} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <span className="pane-head-title">Details</span>
          )}
          <button type="button" className="chathead-icon pane-close" aria-label="Close side pane" title="Close side pane" onClick={close}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      {shownPanel && (
        <div className="pane-meta">
          {opener && <BotAvatar bot={opener} size={18} badge={false} />}
          <span className="pane-opener">
            Opened by <strong>{opener?.name ?? "a removed bot"}</strong>
          </span>
          <button
            type="button"
            className={"pane-tool" + (shownPanel.pinned ? " on" : "")}
            aria-pressed={!!shownPanel.pinned}
            aria-label={"Pin " + shownPanel.title}
            title={shownPanel.pinned ? "Unpin: a bot's new panel may take its place in front" : "Pin: keeps this tab in front and never drops it"}
            onClick={() => pin(shownPanel)}
          >
            <Pin size={14} aria-hidden="true" />
          </button>
          <button type="button" className="pane-tool" aria-label={"Close " + shownPanel.title} title="Close tab" onClick={() => remove(shownPanel)}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="pane-bodies">
        {!group && front === DETAILS && (
          <Body chatId={chat.id} id={DETAILS} tabs={showTabs}>
            <ChatSide state={state} bot={bot} face={face} openRoutines={openRoutines} openBot={openBot} />
          </Body>
        )}
        {front === ARTIFACTS && <Body chatId={chat.id} id={ARTIFACTS} tabs={showTabs}><ArtifactsPanel bot={bot} chat={chat} state={state} openChat={openChat} preview={preview} /></Body>}
        {/* A website stays loaded while its tab is behind another, so switching back doesn't reload it. */}
        {panels.map((panel) =>
          panel.id === front || panel.kind === "web" ? (
            <Body key={panel.id} chatId={chat.id} id={panel.id} tabs={showTabs} away={panel.id !== front} kind={panel.kind}>
              {panel.kind === "web" ? (
                <WebPanel panel={panel} />
              ) : panel.kind === "table" ? (
                <TablePanel panel={panel} />
              ) : panel.kind === "rich_ui" ? (
                panel.frame ? (
                  <div className="pane-rich">
                    <HtmlFrame key={panel.frame} frame={panel.frame} height={480} title={panel.title} />
                  </div>
                ) : null
              ) : (
                <ScreenPanel state={state} />
              )}
            </Body>
          ) : null,
        )}
      </div>
    </aside>
  );
}

const artifactIcon = (item: Artifact) => item.kind === "folder" ? Folder : item.kind === "image" ? FileImage : item.kind === "video" ? FileVideo : item.kind === "audio" ? FileAudio : item.mime === "application/pdf" || item.mime.startsWith("text/") ? FileText : File;
const artifactSourceLabel: Record<Artifact["source"], string> = { tool: "Written", media: "Sent", upload: "Uploaded", export: "Exported" };
const readableSize = (size: number | null) => size == null ? "" : size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 102.4) / 10} KB` : `${Math.round(size / 104857.6) / 10} MB`;
const readableTime = (time: number) => Number.isFinite(time) && time > 0 ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(time) : "";
const artifactApi = () => window.botkins;
const artifactList = (input: Parameters<typeof window.botkins["artifacts.list"]>[0]) => window.botkins["artifacts.list"](input);
const artifactRead = (id: string, options?: { offset?: number; length?: number }) => window.botkins["artifacts.read"](id, options);
const artifactThumbnail = (id: string, options?: { size?: number }) => window.botkins["artifacts.thumbnail"](id, options);

function ArtifactsPanel({ bot, chat, state, openChat, preview }: { bot: Bot; chat: Chat; state: State; openChat?: (id: string, messageIndex?: number) => void; preview?: { item: Artifact; local: boolean } }) {
  const [scope, setScope] = useState<"chat" | "bot">("chat");
  const [kind, setKind] = useState<"all" | "files" | "media">("all");
  const [items, setItems] = useState<Artifact[]>([]);
  const [folder, setFolder] = useState<Artifact | null>(null);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [nextCursors, setNextCursors] = useState<Record<string, string | null>>({});
  const [contextMenu, setContextMenu] = useState<{ item: Artifact; x: number; y: number } | null>(null);
  const [selectedLocal, setSelectedLocal] = useState(false);
  /** The artifact "Add to a project…" was chosen for. A file inside a shared folder can be added too. */
  const [toProject, setToProject] = useState<Artifact | null>(null);
  const projectsOffered = canAddToProject(state);
  const request = useRef(0);
  const botIds = chat.botIds?.length ? chat.botIds : [bot.id];
  const reload = async (reset = true) => {
    const sequence = ++request.current;
    const cursors = reset ? {} : nextCursors;
    const query = (botId: string) => artifactList({
      botId,
      ...(scope === "chat" && { chatId: chat.id }),
      ...(kind !== "all" && { kind }),
      ...(folder && { folder: folder.id }),
      ...(cursors[botId] && { cursor: cursors[botId] ?? undefined }),
    });
    try {
      const pageBotIds = reset ? botIds : botIds.filter((botId) => !!cursors[botId]);
      if (!pageBotIds.length) return;
      const pages = await Promise.all(pageBotIds.map(async (botId) => ({ botId, page: await query(botId) })));
      if (sequence !== request.current) return;
      const merged = pages.flatMap(({ page }) => page.items).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
      setItems((old) => reset ? merged : [...old, ...merged]);
      setNextCursors((old) => ({ ...(reset ? {} : old), ...Object.fromEntries(pages.map(({ botId, page }) => [botId, page.nextCursor])) }));
      setError("");
    } catch (e) {
      if (sequence === request.current) setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => { setFolder(null); setSelected(null); setSelectedLocal(false); setNextCursors({}); }, [bot.id, chat.id, scope, kind]);
  useEffect(() => { void reload(); }, [bot.id, chat.id, scope, kind, folder?.id, state.artifacts?.revision]);
  useEffect(() => {
    if (!preview) return;
    setSelected(preview.item);
    setSelectedLocal(preview.local);
    setItems((old) => old.some((item) => item.id === preview.item.id) ? old : [preview.item, ...old]);
    setFolder(null);
  }, [preview?.item.id, preview?.local]);
  useEffect(() => {
    for (const item of items.filter((i) => (i.kind === "image" || i.kind === "video" || i.mime === "application/pdf") && !thumbs[i.id])) artifactThumbnail(item.id, { size: 160 }).then((image) => image && setThumbs((old) => ({ ...old, [item.id]: `data:${image.mime};base64,${image.data}` }))).catch(() => {});
  }, [items]);
  const enterFolder = (item: Artifact) => { setSelected(item); setSelectedLocal(false); setFolder(item); };
  const open = (item: Artifact) => void artifactApi().openChatPath(item.path, "open").catch(() => {});
  const reveal = (item: Artifact) => void artifactApi().openChatPath(item.path, "reveal").catch(() => {});
  const hasMore = botIds.some((botId) => !!nextCursors[botId]);
  const rows = items.map((item) => (
    <ArtifactRow
      key={item.id}
      item={item}
      selected={selected?.id === item.id}
      thumbnail={thumbs[item.id]}
      onSelect={() => item.kind === "folder" ? enterFolder(item) : (setSelected(item), setSelectedLocal(false))}
      onOpen={() => open(item)}
      onReveal={() => reveal(item)}
      onChat={item.chatId && openChat ? () => openChat(item.chatId!, item.messageIndex) : undefined}
      onProject={projectsOffered ? () => setToProject(item) : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        setSelected(item);
        setSelectedLocal(false);
        setContextMenu({ item, x: event.clientX, y: event.clientY });
      }}
    />
  ));
  return (
    <section className="artifacts-panel" aria-label="Artifacts">
      <div className="artifacts-head">
        <h3>Artifacts</h3>
        <button type="button" className="pane-tool" onClick={() => void reload()} aria-label="Refresh artifacts">↻</button>
      </div>
      <div className="artifacts-controls">
        <label>
          <span className="visually-hidden">Scope</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="chat">This chat</option>
            <option value="bot">All of this bot’s chats</option>
          </select>
        </label>
        <div className="artifacts-filters" role="group" aria-label="Filter artifacts">
          {(["all", "files", "media"] as const).map((value) => (
            <button key={value} type="button" className={kind === value ? "selected" : ""} onClick={() => setKind(value)}>
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {folder && <button type="button" className="artifact-back" onClick={() => setFolder(null)}>‹ All artifacts <span>{folder.name}</span></button>}
      {error ? <p className="pane-empty">{error}</p> : !items.length ? <p className="pane-empty">No artifacts yet.</p> : <ul className="artifact-list">{rows}</ul>}
      {hasMore && <button type="button" className="artifact-more" onClick={() => void reload(false)}>Load more</button>}
      {selected && selected.kind !== "folder" && <ArtifactPreview item={selected} thumbnail={thumbs[selected.id]} local={selectedLocal} />}
      {contextMenu && (
        <ArtifactMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onOpen={() => { open(contextMenu.item); setContextMenu(null); }}
          onReveal={() => { reveal(contextMenu.item); setContextMenu(null); }}
          onProject={projectsOffered ? () => { setToProject(contextMenu.item); setContextMenu(null); } : undefined}
        />
      )}
      {toProject && <AddToProjectDialog state={state} artifact={toProject} close={() => setToProject(null)} />}
    </section>
  );
}

function ArtifactRow({ item, selected, thumbnail, onSelect, onOpen, onReveal, onChat, onProject, onContextMenu }: { item: Artifact; selected: boolean; thumbnail?: string; onSelect: () => void; onOpen: () => void; onReveal: () => void; onChat?: () => void; onProject?: () => void; onContextMenu: (event: React.MouseEvent<HTMLLIElement>) => void }) {
  const Icon = artifactIcon(item);
  return <li className={selected ? "selected" : ""} onDoubleClick={onOpen} onContextMenu={onContextMenu}>
    <button type="button" className="artifact-row" onClick={onSelect}>
      {thumbnail ? <img src={thumbnail} alt="" className="artifact-thumb" /> : <Icon size={22} aria-hidden="true" className="artifact-icon" />}
      <span className="artifact-copy">
        <strong>{item.name}</strong>
        <small>{[artifactSourceLabel[item.source], readableSize(item.size), readableTime(item.time), item.chatTitle].filter(Boolean).join(" · ")}</small>
      </span>
    </button>
    {selected && <div className="artifact-actions"><button type="button" onClick={onOpen}>Open</button><button type="button" onClick={onReveal}>Show in folder</button>{onChat && <button type="button" onClick={onChat}>Go to message</button>}{onProject && <button type="button" onClick={onProject}>Add to a project…</button>}</div>}
  </li>;
}

function ArtifactMenu({ menu, onClose, onOpen, onReveal, onProject }: { menu: { item: Artifact; x: number; y: number }; onClose: () => void; onOpen: () => void; onReveal: () => void; onProject?: () => void }) {
  return <div className="artifact-menu" role="menu" style={{ left: menu.x, top: menu.y }} onMouseLeave={onClose}>
    <button type="button" role="menuitem" onClick={onOpen}>Open</button>
    <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(menu.item.path); onClose(); }}>Copy path</button>
    <button type="button" role="menuitem" onClick={onReveal}>Show in folder</button>
    <button type="button" role="menuitem" onClick={onClose}>Preview in Artifacts</button>
    {onProject && <button type="button" role="menuitem" onClick={onProject}>Add to a project…</button>}
  </div>;
}

async function readPreviewBytes(item: Artifact, local: boolean, limit = item.size ?? 64 * 1024 * 1024) {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let total = 0;
  do {
    const length = Math.min(512 * 1024, Math.max(1, limit - total));
    const reply = local
      ? await window.botkins.previewChatPath(item.path, { offset, length })
      : await artifactRead(item.id, { offset, length });
    const binary = atob(reply.data);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    chunks.push(bytes);
    total += bytes.byteLength;
    if (!bytes.byteLength || reply.nextOffset == null || total >= limit || reply.nextOffset <= offset) break;
    offset = reply.nextOffset;
  } while (true);
  const output = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { output.set(chunk, at); at += chunk.byteLength; }
  return output;
}

function ArtifactPreview({ item, thumbnail, local }: { item: Artifact; thumbnail?: string; local: boolean }) {
  const [text, setText] = useState<string>();
  const [mediaData, setMediaData] = useState<string>();
  const [previewThumbnail, setPreviewThumbnail] = useState<string | undefined>(thumbnail);
  const [imageData, setImageData] = useState<string>();
  const [previewError, setPreviewError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let mediaUrl: string | undefined;
    let imageUrl: string | undefined;
    setText(undefined);
    setMediaData(undefined);
    setPreviewThumbnail(thumbnail);
    setImageData(undefined);
    setPreviewError(false);
    const textLike = item.mime.startsWith("text/") || item.mime === "application/json" || item.mime === "application/xml";
    if (item.kind === "image" || item.mime === "application/pdf") {
      const fallbackImage = () => {
        if (item.kind !== "image") {
          setPreviewError(true);
          return;
        }
        void readPreviewBytes(item, local, 8 * 1024 * 1024).then((bytes) => {
          if (disposed) return;
          imageUrl = URL.createObjectURL(new Blob([bytes], { type: item.mime }));
          setImageData(imageUrl);
        }, () => { if (!disposed) setPreviewError(true); });
      };
      const requestThumbnail = local
        ? window.botkins.thumbnailChatPath(item.path, 160)
        : artifactThumbnail(item.id, { size: 160 });
      void requestThumbnail.then((image) => {
        if (disposed) return;
        if (image) {
          setPreviewThumbnail(`data:${image.mime};base64,${image.data}`);
          return;
        }
        // A native thumbnail is preferred, but an indexed image can still have a
        // useful bounded fallback when the platform cannot make one.
        fallbackImage();
      }, () => { if (!disposed) fallbackImage(); });
    } else if (item.kind === "video" || item.kind === "audio") {
      void window.botkins.artifactMedia(item.id, local ? item.path : undefined).then((url) => {
        if (disposed) {
          void window.botkins.closeArtifactMedia(url).catch(() => {});
          return;
        }
        mediaUrl = url;
        setMediaData(url);
      }, () => { if (!disposed) setPreviewError(true); });
    } else if (textLike) {
      void readPreviewBytes(item, local, 64 * 1024).then((bytes) => {
        if (!disposed) setText(new TextDecoder().decode(bytes));
      }, () => { if (!disposed) setText("Preview unavailable."); });
    }
    return () => {
      disposed = true;
      if (mediaUrl) void window.botkins.closeArtifactMedia(mediaUrl).catch(() => {});
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [item.id, item.path, item.mime, item.kind, local, thumbnail]);
  if (item.kind === "image" || item.mime === "application/pdf") return <div className="artifact-preview">{imageData ? <img src={imageData} alt={item.name} className="artifact-preview-image" /> : previewThumbnail ? <img src={previewThumbnail} alt={item.name} className="artifact-preview-image" /> : <p>{previewError ? "Preview unavailable." : "Loading preview…"}</p>}</div>;
  if (item.kind === "video") return <div className="artifact-preview">{mediaData ? <video controls preload="metadata" src={mediaData} className="artifact-preview-media" /> : <p>{previewError ? "Preview unavailable." : "Loading video preview…"}</p>}</div>;
  if (item.kind === "audio") return <div className="artifact-preview">{mediaData ? <audio controls preload="metadata" src={mediaData} /> : <p>{previewError ? "Preview unavailable." : "Loading audio preview…"}</p>}</div>;
  if (!item.mime.startsWith("text/") && item.mime !== "application/json" && item.mime !== "application/xml") return <div className="artifact-preview"><p>Preview opens in the default app.</p></div>;
  return <pre className="artifact-preview artifact-text">{text ?? "Loading preview…"}</pre>;
}

function Body({ chatId, id, tabs, away, kind, children }: { chatId: string; id: string; tabs: boolean; away?: boolean; kind?: PanePanel["kind"]; children: ReactNode }) {
  return (
    <div
      className={"pane-body" + (kind ? " " + kind : " details") + (away ? " away" : "")}
      id={bodyId(chatId, id)}
      {...(tabs && { role: "tabpanel", "aria-labelledby": tabId(chatId, id) })}
      inert={away || undefined}
    >
      {children}
    </div>
  );
}

function TablePanel({ panel }: { panel: PanePanel }) {
  const columns = panel.columns ?? [];
  const rows = panel.rows ?? [];
  return (
    <div className="pane-table" tabIndex={0} aria-label={panel.title}>
      <table>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="pane-empty">No rows yet.</p>}
    </div>
  );
}

/** A website in the app's viewer, with a small bar: back, forward, reload, the address, and Open in browser. */
function WebPanel({ panel }: { panel: PanePanel }) {
  const ref = useRef<Viewer>(null);
  const [address, setAddress] = useState(panel.url ?? "");
  const [loading, setLoading] = useState(true);
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);
  const [history, setHistory] = useState({ back: false, forward: false });
  // The bot sent this panel to another address: the viewer goes there.
  useEffect(() => {
    setAddress(panel.url ?? "");
    setFailed(false);
  }, [panel.url]);
  useEffect(() => {
    const view = ref.current;
    if (!view) return;
    const moved = (e: Event) => {
      const event = e as Event & { url: string; isMainFrame?: boolean };
      if (event.type === "did-navigate-in-page" && event.isMainFrame === false) return;
      setAddress(event.url);
      try {
        setHistory({ back: view.canGoBack(), forward: view.canGoForward() });
      } catch {
        // Not ready yet; the next navigation says.
      }
    };
    const start = () => {
      setLoading(true);
      setFailed(false);
    };
    const stop = () => {
      setLoading(false);
      setShown(true);
    };
    const fail = (e: Event) => {
      const event = e as Event & { errorCode: number; isMainFrame: boolean };
      // -3 is a load that was replaced by another one (a redirect, a new address): not a failure.
      if (event.isMainFrame && event.errorCode !== -3) setFailed(true);
    };
    view.addEventListener("did-navigate", moved);
    view.addEventListener("did-navigate-in-page", moved);
    view.addEventListener("did-start-loading", start);
    view.addEventListener("did-stop-loading", stop);
    view.addEventListener("did-fail-load", fail);
    return () => {
      view.removeEventListener("did-navigate", moved);
      view.removeEventListener("did-navigate-in-page", moved);
      view.removeEventListener("did-start-loading", start);
      view.removeEventListener("did-stop-loading", stop);
      view.removeEventListener("did-fail-load", fail);
    };
  }, []);
  const call = (fn: (view: Viewer) => void) => {
    try {
      if (ref.current) fn(ref.current);
    } catch {
      // The viewer isn't ready yet.
    }
  };
  const openOutside = () => void window.botkins.openLink(address || panel.url || "").catch(() => {});
  if (!panel.url) return null;
  return (
    <div className="pane-web">
      <div className="pane-webbar" role="toolbar" aria-label="Website">
        <button type="button" className="pane-tool" aria-label="Back" title="Back" disabled={!history.back} onClick={() => call((v) => v.goBack())}>
          <ArrowLeft size={15} aria-hidden="true" />
        </button>
        <button type="button" className="pane-tool" aria-label="Forward" title="Forward" disabled={!history.forward} onClick={() => call((v) => v.goForward())}>
          <ArrowRight size={15} aria-hidden="true" />
        </button>
        <button type="button" className="pane-tool" aria-label="Reload" title="Reload" onClick={() => call((v) => v.reload())}>
          <RotateCw size={14} aria-hidden="true" />
        </button>
        <span className="pane-address" title={address} aria-label="Address">
          {address}
        </span>
        <button type="button" className="pane-tool" aria-label="Open in browser" title="Open in browser" onClick={openOutside}>
          <ExternalLink size={14} aria-hidden="true" />
        </button>
        {loading && <i className="pane-loading-line" aria-hidden="true" />}
      </div>
      <div className="pane-web-page">
        <webview ref={ref as Ref<HTMLWebViewElement>} partition={VIEWER_PARTITION} src={panel.url} title={panel.title} />
        {failed ? (
          <div className="pane-web-state failed" role="alert">
            <TriangleAlert size={18} aria-hidden="true" />
            <p>This page couldn't be shown.</p>
            <button type="button" className="secondary" onClick={openOutside}>
              <ExternalLink size={13} aria-hidden="true" />
              Open in browser
            </button>
          </div>
        ) : (
          !shown && (
            <div className="pane-web-state" role="status">
              Loading the page…
            </div>
          )
        )}
      </div>
    </div>
  );
}
