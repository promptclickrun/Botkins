import { PendingSends } from "../desktop/link/pending-sends";
import { CompletionScroll } from "./completionScroll";
import { chatDisplayEvent, readChatDisplay, settleChatDisplay } from "./chatDisplay";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  BrainCircuit,
  SlidersHorizontal,
  ChevronRight,
  CircleAlert,
  MailOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  SquarePen,
  Store,
  X,
  ShieldCheck,
} from "lucide-react";
import { MOD, placeOrder } from "./places";
import { PlaceIcon } from "./PlaceIcon";
import Composer from "./Composer";
import Today from "./Today";
import BoardPanel from "./Board";
import Settings from "./Settings";
import MarketPage from "./MarketPage";
import ModelPicker, { chatDefault, isRoutineChat, modelLabel } from "./ModelPicker";
import ProviderIcon from "./ProviderIcon";
import { isConnected, useModelCatalog, useProviders } from "./providers";
import { AvatarAnimations } from "./Avatar";
import ChatView, { type SideAnswer } from "./ChatView";
import { WindowState, type HotMessage } from "./hotState";
import { ChatListColumn, ChatsPage, HomePage, SidebarBots, type PageActions } from "./Pages";
import { ActivityPage } from "./Work";
import { WORK_TABS, WorkBack, type WorkNav, type WorkTab } from "./WorkBar";
import RoutinesPage from "./Routines";
import TasksPage from "./Tasks";
import Usage from "./Usage";
import { HostBanner, HostSwitcher, HostUnreachable } from "./RemoteHosts";
import BotForm from "./BotForm";
import BotProfile from "./BotProfile";
import NewChat from "./NewChat";
import ProjectsPage, { type ProjectsTarget } from "./Projects";
import WikiPage, { type WikiTarget } from "./Wiki";
import { AllSpaces, SidebarSpaces, SpacePage } from "./SpacePage";
import { hasSpaces } from "./spaces";
import Welcome from "./Welcome";
import FirstBot from "./FirstBot";
import SetupChoice, { SetupConnect, SetupNode, SetupTeam, type SetupPath } from "./SetupChoice";
import RequestPanel from "./RequestPanel";
import { ProfileMigrationPrompt, useMigrationPrompt } from "./ProfileSettings";
import type { Attachment, BoardItem, Bot, Chat, MarketAgentTemplate, MentionInput, Message, State } from "./types";
import { tokenOf, type DraftMention } from "./MentionMenu";
import { composeSlashPrompt, type DraftCommand } from "./slashCommand";
import { applyAppearance, startAppearance } from "./appearance";
import { BackdropLayer } from "./Backdrop";
import { backdropOf } from "./themes";
import { memberTeam, teamCan } from "./teamAccess";
import { chatMentionPeople } from "./peopleView";
import { leftEmpty, newChatToReuse } from "./emptyChat";
import { allUnreadChats, botUnreadChats } from "./unread";
import { chatsPageUnreadChats } from "./chatSections";
import "glisse/styles.css";
import "./style.css";
import "./glisse.css";
import "./ui.css";
import "./sidebar.css";

// The remembered colors go on before anything is drawn.
startAppearance();
const api = window.botkins;
/** Where the first-run choice is kept for the window's session (src/SetupChoice.tsx). */
const SETUP_KEY = "botkins.setupPath";
const CHAT_LIST_KEY = "botkins.chatList";
// Work is three pages with tabs between them (Routines, Projects, Tasks); Activity and Usage open from its top.
// With Spaces ("spaces-v1"), a space's page and All spaces take the Today page's place (src/SpacePage.tsx).
type Page = "Home" | "Today" | "Chats" | "Wiki" | "Market" | WorkTab | "Activity" | "Usage" | "Space" | "AllSpaces";
const WORK_PAGES: Page[] = [...WORK_TABS, "Activity", "Usage"];
type Modal = "" | "bot" | "chat" | "account" | "settings" | "model";
const personalChat = (chat: Chat) =>
  !chat.hostDispatch && !chat.archived && (!chat.main || !!(chat.count ?? chat.messages.length)) && !chat.botIds && !chat.panelId && !chat.schedules?.some((entry) => entry.routine);
const visitKey = (host: string, bot: string) => "botkins.lastChat." + JSON.stringify([host, bot]);
function App() {
  const [updates] = useState(() => new WindowState());
  const snapshot = useSyncExternalStore(updates.subscribe, updates.workspace);
  const [outboxes] = useState(() => new Map<string, PendingSends<Message & { clientMessageId: string }>>());
  function outbox(host: string) {
    let box = outboxes.get(host);
    if (!box) {
      box = new PendingSends();
      outboxes.set(host, box);
    }
    return box;
  }
  const [completionByHost] = useState(() => new Map<string, CompletionScroll>());
  const [display, setDisplay] = useState(readChatDisplay);
  const position = useRef(settleChatDisplay(display).completionPosition);
  function observeQueue(next: State) {
    const box = outboxes.get(next.remote?.unified ? "unified" : (next.remote?.using?.id ?? "local"));
    if (box) for (const id of box.chatIds()) {
      const chat = next.chats.find(chat => chat.id === id);
      box.observe(id, chat?.loaded?.from ?? 0, chat?.messages ?? [], next.queued?.[id] ?? []);
    }
  }
  function receiveSnapshot(received: State) {
    updates.whole(received, next => {
      const hostId = next.remote?.unified ? "unified" : (next.remote?.using?.id ?? "local");
      const scroll = completionByHost.get(hostId) ?? new CompletionScroll();
      completionByHost.set(hostId, scroll);
      scroll.observe(next.chats, next.runs, position.current);
      observeQueue(next);
    });
  }
  // Only one recovery request at a time. A newer delta may arrive before its base's RPC reply.
  const missed = useRef<HotMessage | null>(null);
  function receiveHot(hot: HotMessage) {
    if (updates.hot(hot, observeQueue)) return;
    if (missed.current) {
      if (hot.seq > missed.current.seq) missed.current = hot;
      return;
    }
    missed.current = hot;
    void api.snapshot().then(next => {
      const last = missed.current;
      missed.current = null;
      receiveSnapshot(next);
      if (last && next.seq !== undefined && last.seq > next.seq) receiveHot(last);
    }).catch(error => {
      missed.current = null;
      fail(error);
    });
  }
  useEffect(() => {
    const read = () => {
      const saved = readChatDisplay();
      position.current = settleChatDisplay(saved).completionPosition;
      setDisplay(saved);
    };
    window.addEventListener(chatDisplayEvent, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(chatDisplayEvent, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  // The settings are one object until they change, so the rows that read them are not made again for a streamed word.
  const shownSettings = useMemo(() => snapshot && ({
    ...snapshot.settings, ...settleChatDisplay(display, snapshot.settings.showThinking)
  }), [snapshot?.settings, display]);
  const state = useMemo(() => snapshot && shownSettings && ({ ...snapshot, settings: shownSettings }), [snapshot, shownSettings]);
  const [page, setPage] = useState<Page>("Home");
  const [chatId, setChatId] = useState("");
  /** The space whose page is open (page "Space"). */
  const [spaceId, setSpaceId] = useState("");
  /** Text a panel's view handed over, for the ask bar of its space. */
  const [spaceAbout, setSpaceAbout] = useState<{ spaceId: string; panelId: string; text: string; n: number }>();
  useEffect(() => {
    if (spaceAbout) openSpaceRef.current(spaceAbout.spaceId);
  }, [spaceAbout?.n]);
  const host = state?.remote?.unified ? "unified" : (state?.remote?.using?.id ?? "local");
  const box = outbox(host);
  const pending = useSyncExternalStore(box.subscribe, () => box.rows(chatId));
  const pendingVisit = useRef<{ host: string; id: string } | null>(null);
  const [messageTarget, setMessageTarget] = useState<{ chatId: string; index: number } | null>(null);
  const [modal, setModal] = useState<Modal>("");
  // A project the New chat dialog opens with (a project's Chats); cleared when the dialog closes.
  const [chatProject, setChatProject] = useState<string>();
  useEffect(() => {
    if (modal !== "chat") setChatProject(undefined);
  }, [modal]);
  /** An agent template from Marketplace › Agents that Create a bot opens filled in from. */
  const [botStart, setBotStart] = useState<MarketAgentTemplate>();
  useEffect(() => {
    if (modal !== "bot") setBotStart(undefined);
  }, [modal]);
  function createBot(template: MarketAgentTemplate) {
    setBotStart(template);
    setModal("bot");
  }
  // The chat list beside an open chat (the panel-left button in the chat's header), kept for next time.
  const [chatListShown, setChatListShown] = useState(() => {
    try {
      return localStorage.getItem(CHAT_LIST_KEY) === "1";
    } catch {
      return false;
    }
  });
  function toggleChatList() {
    setChatListShown((shown) => {
      try {
        localStorage.setItem(CHAT_LIST_KEY, shown ? "0" : "1");
      } catch {
        /* storage unavailable */
      }
      return !shown;
    });
  }
  const [settingsTab, setSettingsTab] = useState("General");
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [teamJoinUrl, setTeamJoinUrl] = useState("");
  const [side, setSide] = useState<Record<string, SideAnswer>>({});
  /** The bot whose page is open, or "". */
  const [profileId, setProfileId] = useState("");
  // The bot whose page opens on the setup steps of its Proactive agent (`actions.proactiveSetup`).
  const [setupId, setSetupId] = useState("");
  const [settingsBot, setSettingsBot] = useState("");
  function settings(tab: string, botId = "") {
    setSettingsTab(tab);
    setSettingsRevision((revision) => revision + 1);
    setSettingsBot(botId);
    setModal("settings");
  }
  // The model providers, shared with the pickers and Settings (src/providers.ts); asked again when they change.
  const { providers } = useProviders();
  const { models } = useModelCatalog();
  const defaultProvider = providers?.find((p) => p.default)?.id;
  const [error, setError] = useState("");
  /** An onboarded person chose Not now on the signed-out welcome; lasts until the app restarts. */
  const [later, setLater] = useState(false);
  /**
   * On a first launch, how the person chose to use Botkins here (src/SetupChoice.tsx); "" until they
   * choose. Kept for the window's session, so a reload stays on the step it was on.
   */
  const [setupPath, setSetupPathNow] = useState<SetupPath | "">(() => {
    try {
      const saved = sessionStorage.getItem(SETUP_KEY);
      return saved === "here" || saved === "computer" || saved === "team" || saved === "node" ? saved : "";
    } catch {
      return "";
    }
  });
  const setSetupPath = (path: SetupPath | "") => {
    setSetupPathNow(path);
    try {
      sessionStorage.setItem(SETUP_KEY, path);
    } catch {}
  };
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  /** The tab Work shows when it is opened from the side menu: the one last looked at. */
  const [workTab, setWorkTab] = useState<WorkTab>("Routines");
  useEffect(() => {
    if ((WORK_TABS as Page[]).includes(page)) setWorkTab(page as WorkTab);
  }, [page]);
  /** Where Routines opens; `n` remounts the page for each visit. */
  const [routineTarget, setRoutineTarget] = useState<{ id?: string; botId?: string; create?: boolean; n: number }>({ n: 0 });
  // Where Projects opens; `n` remounts the page for each visit (src/Projects.tsx).
  const [projectTarget, setProjectTarget] = useState<ProjectsTarget>({ n: 0 });
  // Where the Wiki opens: a page's path, or its home (src/Wiki.tsx).
  const [wikiTarget, setWikiTarget] = useState<WikiTarget>({ n: 0 });
  // Set while a wiki page has unsaved changes: asks before the person leaves it.
  const leaveGuard = useRef<(() => Promise<boolean>) | null>(null);
  function leave(go: () => void) {
    const ask = leaveGuard.current;
    if (!ask) return go();
    void ask().then((ok) => {
      if (!ok) return;
      leaveGuard.current = null;
      go();
    });
  }
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Records picked with "@" and "#" stay with their draft (src/MentionMenu.tsx).
  const [draftMentions, setDraftMentions] = useState<Record<string, DraftMention[]>>({});
  // Slash commands, skills, and tools picked with "/" stay attached to the composer rail (src/slashCommand.ts).
  const [draftCommands, setDraftCommands] = useState<Record<string, DraftCommand | null>>({});
  const [sending, setSending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  // The side menu collapsed to icons; shown at once, then kept with the preferences.
  const [collapsedNow, setCollapsedNow] = useState<boolean>();
  const collapsed = collapsedNow ?? !!state?.settings.sidebar?.collapsed;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const toggleSidebarRef = useRef(() => {});
  toggleSidebarRef.current = () => {
    const next = !collapsedRef.current;
    setCollapsedNow(next);
    api.setPreferences({ sidebar: { collapsed: next } } as Parameters<typeof api.setPreferences>[0]).catch((e) => {
      fail(e);
      setCollapsedNow(undefined);
    });
  };
  // The choice shows at once and gives way when the saved setting says the same. Letting go any
  // sooner would show the old setting for a moment, and a second ⌘B in that moment would undo the first.
  const savedCollapsed = state?.settings.sidebar?.collapsed;
  useEffect(() => {
    if (collapsedNow !== undefined && !!savedCollapsed === collapsedNow) setCollapsedNow(undefined);
  }, [savedCollapsed, collapsedNow]);
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  useEffect(() => {
    const off = api.subscribe(receiveSnapshot);
    const offHot = api.subscribeHot?.(receiveHot);
    api.snapshot().then(receiveSnapshot).catch(fail);
    const shortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        settings("General");
      }
      // ⌘B / Ctrl+B collapses or expands the side menu, unless a text editor uses it (bold in the wiki editor).
      const target = e.target as HTMLElement | null;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b" && !e.defaultPrevented && !target?.isContentEditable) {
        e.preventDefault();
        toggleSidebarRef.current();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => {
      off();
      offHot?.();
      window.removeEventListener("keydown", shortcut);
    };
  }, []);
  // Esc leaves Settings for the page underneath, as it closed the Settings window before; a sheet
  // or menu open inside Settings takes its own Esc first.
  useEffect(() => {
    if (modal !== "settings") return;
    const leave = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("dialog[open]")) return;
      e.preventDefault();
      setModal("");
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [modal]);
  useEffect(() => {
    // Settings is a page over the whole window (below), not this dialog.
    if (modal && modal !== "settings") dialog.current?.showModal();
    else dialog.current?.close();
  }, [modal]);
  const chat = state?.chats.find((c) => c.id === chatId);
  const bot = state?.bots.find((b) => b.id === chat?.botId);
  useEffect(() => {
    if (!chat || pendingVisit.current?.id !== chat.id || pendingVisit.current.host !== host) return;
    pendingVisit.current = null;
    if (personalChat(chat)) {
      try { localStorage.setItem(visitKey(host, chat.botId), chat.id); } catch { /* storage unavailable */ }
    }
  }, [chat, host]);
  // A new chat nobody wrote in is archived when the person leaves it (src/emptyChat.ts). Only a
  // chat left on the same computer counts: after a switch, the id belongs to the other one.
  const lastShown = useRef({ host, id: "" });
  // The empty chats this window took out of the archive to show again (selecting a bot with "Start
  // a new chat"). Until the computer's answer arrives, the window still knows them as archived.
  const reopenedChats = useRef(new Set<string>());
  const leaving = useRef({ state, drafts, sending });
  leaving.current = { state, drafts, sending };
  useEffect(() => {
    const before = lastShown.current;
    lastShown.current = { host, id: chatId };
    const now = leaving.current;
    if (!before.id || before.id === chatId || before.host !== host || now.sending || !now.state) return;
    const reopened = reopenedChats.current.delete(before.id);
    if (leftEmpty(now.state.chats.find((c) => c.id === before.id), now.state, now.drafts[before.id], reopened))
      void api.setChatFlags(before.id, { archived: true }).catch(() => {});
  }, [chatId, host]);
  // A reply that lands in the open chat marks it unread on the backend. It counts as read once the
  // window is visible and focused, so a reply that arrives while Botkins sits in the tray stays unread.
  useEffect(() => {
    if (!chat?.unread) return;
    const id = chat.id;
    const read = () => {
      if (!document.hidden && document.hasFocus()) void api.setChatFlags(id, { unread: false }).catch(() => {});
    };
    read();
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [chat?.id, chat?.unread]);
  // The theme, light or dark, the text size and the bubble color (src/appearance.ts).
  const look = state?.settings.appearance;
  useEffect(() => {
    if (look) applyAppearance(look);
  }, [look?.theme, look?.colorTheme, look?.darkColorTheme, look?.contrast, look?.textSize, look?.font, look?.bubble, look?.backdrop]);
  // The main process is told which chat is on screen, so a phone isn't pinged for a reply here.
  const onScreen = page === "Chats" && chatId && !modal ? chatId : null;
  useEffect(() => {
    void api.viewing(onScreen).catch(() => {});
  }, [onScreen]);
  function nav(p: Page) {
    leave(() => {
      setPage(p);
      setChatId("");
      setProfileId("");
      setQuery("");
      setError("");
    });
  }
  function open(id: string, messageIndex?: number) {
    leave(() => {
      nav("Chats");
      pendingVisit.current = { host, id };
      setChatId(id);
      setMessageTarget(Number.isInteger(messageIndex) ? { chatId: id, index: messageIndex! } : null);
      setModal("");
      if (state?.chats.find((c) => c.id === id)?.unread && teamCan(state, "agents"))
        void api.setChatFlags(id, { unread: false }).catch(fail);
    });
  }
  function markChatsRead(ids: string[]) {
    if (!state || !teamCan(state, "agents") || ids.length === 0) return;
    void api.markChatsRead(ids).catch(fail);
  }
  function markBotRead(botId: string, exceptId?: string) {
    if (!state) return;
    markChatsRead(botUnreadChats(state.chats, botId).filter((c) => c.id !== exceptId).map((c) => c.id));
  }
  function markAllChatsRead() {
    if (!state) return;
    markChatsRead(allUnreadChats(state.chats).map((c) => c.id));
  }
  // Notification clicks open their chat.
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => api.onOpenChat((id) => openRef.current(id)), []);
  useEffect(() => api.onOpenSettings((tab) => settingsRef.current(tab)), []);
  // An HTML app's answer waits in its chat's message box; the person reviews and sends it.
  useEffect(() => {
    // The answer joins whatever is already typed in that chat, so nothing the person wrote is lost.
    // From a view in a panel of a space, it waits in that space's ask bar, about that panel.
    const place = ({ chatId, text, panelId, spaceId }: { chatId?: string; text: string; panelId?: string; spaceId?: string }) => {
      if (panelId && spaceId && spacesRef.current(spaceId)) return void setSpaceAbout((was) => ({ spaceId, panelId, text, n: (was?.n ?? 0) + 1 }));
      if (!chatId) return;
      setDrafts((prev) => ({ ...prev, [chatId]: prev[chatId]?.trim() ? prev[chatId] + "\n\n" + text : text }));
      openRef.current(chatId);
    };
    void api.takePrefill().then((p) => p && place(p)).catch(() => {});
    return api.onPrefill(place);
  }, []);
  function routines(target: { id?: string; botId?: string; create?: boolean } = {}) {
    leave(() => {
      nav("Routines");
      setRoutineTarget((t) => ({ ...target, n: t.n + 1 }));
    });
  }
  // A starter that suggests Proactive (Chief of Staff, Money manager) opens its setup steps once made, where the computer has them.
  const proactiveTeam = !state?.remote?.using || state.remote.using.capabilities.includes("proactive-team-v1");
  function botPage(id: string, setup = false) {
    leave(() => {
      setChatId("");
      setModal("");
      setError("");
      setSetupId(setup ? id : "");
      setProfileId(id);
    });
  }
  function projects(target: Omit<ProjectsTarget, "n"> = {}) {
    leave(() => {
      nav("Projects");
      setProjectTarget((t) => ({ ...target, n: t.n + 1 }));
    });
  }
  function workPage(tab: WorkTab) {
    if (tab === "Routines") routines();
    else if (tab === "Projects") projects();
    else nav("Tasks");
  }
  function wiki(path?: string) {
    leave(() => {
      nav("Wiki");
      setWikiTarget((t) => ({ path, n: t.n + 1 }));
    });
  }
  function openSpace(id: string) {
    const alreadyOpen = page === "Space" && spaceId === id && !chatId && !profileId;
    leave(() => {
      nav("Space");
      setSpaceId(id);
      if (alreadyOpen && state?.spaces?.some((s) => s.id === id && s.changed > 0)) {
        void api["link.spaces.seen"](id).catch(fail);
      }
    });
  }
  // For listeners set up once: the way to a space as it is now, and whether a space is one the window knows.
  const openSpaceRef = useRef(openSpace);
  openSpaceRef.current = openSpace;
  const spacesRef = useRef<(id: string) => boolean>(() => false);
  spacesRef.current = (id) => !!state?.spaces?.some((s) => s.id === id);
  /** Today: the Today space when the computer has Spaces, else the Today page. */
  function openToday() {
    const today = hasSpaces(state!) && (state!.spaces ?? []).find((s) => s.builtin === "today" && s.mine);
    if (today) openSpace(today.id);
    else nav("Today");
  }
  /** Opens a chat the computer just made, once the window knows it. */
  async function openNew(id: string) {
    receiveSnapshot(await api.snapshot());
    open(id);
  }
  /** A chat about a Feed, Ideas or Goals card. `send` sends the text; otherwise it waits in the message box. */
  async function boardChat(botId: string, text: string, send: boolean, item?: BoardItem) {
    const id = await newChat(botId);
    // A Today item goes along as a record: the chat shows a card for it and the bot reads it.
    const mention: DraftMention | undefined = item && { kind: "board", id: item.id, label: item.title };
    if (send) await api.send(id, text, mention && { mentions: [{ kind: "board", id: mention.id }] });
    else {
      setDrafts((prev) => ({ ...prev, [id]: mention ? tokenOf(mention) + " " + text : text }));
      if (mention) setDraftMentions((prev) => ({ ...prev, [id]: [mention] }));
    }
  }
  /** A new chat with the primary bot and a prepared message, not sent. A page comes as a "#" mention. */
  async function wikiChat(text: string, wikiPage?: { path: string; title: string }) {
    const id = await newChat(state!.bots[0].id);
    const mention: DraftMention | undefined = wikiPage && { kind: "wiki", path: wikiPage.path, label: wikiPage.title };
    setDrafts((prev) => ({ ...prev, [id]: mention ? tokenOf(mention) + " " + text : text }));
    if (mention) setDraftMentions((prev) => ({ ...prev, [id]: [mention] }));
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composewrap textarea[role=combobox]")?.focus());
  }
  // A model picker outside Settings links to Settings › Model providers (src/providers.ts).
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => {
    const show = (e: Event) => settingsRef.current((e as CustomEvent<string>).detail || "General");
    window.addEventListener("botkins-open-settings", show);
    return () => window.removeEventListener("botkins-open-settings", show);
  }, []);
  useEffect(() => {
    const openJoin = (url: string) => {
      void api.takeTeamJoin().catch(() => {});
      setTeamJoinUrl(url);
      // On a first launch the link opens the Join a team step; otherwise Settings › Computers and teams.
      setSetupPath("team");
      settingsRef.current("Computers");
    };
    const off = api.onTeamJoin(openJoin);
    api.takeTeamJoin().then((url) => url && openJoin(url)).catch(() => {});
    return off;
  }, []);
  // Settings › Access links to a bot's page (src/access.ts).
  const botPageRef = useRef(botPage);
  botPageRef.current = botPage;
  useEffect(() => {
    const show = (e: Event) => botPageRef.current((e as CustomEvent<string>).detail);
    window.addEventListener("botkins-open-bot", show);
    return () => window.removeEventListener("botkins-open-bot", show);
  }, []);
  async function newChat(id: string) {
    const key = await api.createChat(id);
    receiveSnapshot(await api.snapshot());
    open(key);
    return key;
  }
  // Every bot has a Main chat on a computer that keeps them; the Proactive setting doesn't decide that.
  const keepsMain = !state?.remote?.using || state.remote.using.capabilities.includes("main-chat-v1");
  async function mainChat(id: string) {
    if (!keepsMain) return newChat(id);
    const key = await api.mainChat(id);
    await openNew(key);
    return key;
  }
  function botChat(b: Bot) {
    leave(() => {
      // Settings › Chat › When you select a bot: "Main chat", when this computer keeps one.
      if (keepsMain && (state?.settings.botTap ?? "main") === "main" && state && teamCan(state, "agents", "chat")) {
        markBotRead(b.id);
        void mainChat(b.id).catch(fail);
        return;
      }
      const chats = state?.chats.filter((c) => c.botId === b.id && personalChat(c)) ?? [];
      // Settings › Chat › When you select a bot: "Start a new chat". A new chat nobody wrote in yet
      // is that new chat, so selecting the bot twice makes one, not two; so is one that was archived
      // when it was left. It is taken out of the archive first, also when it is not shown as
      // archived yet: the archiving of a chat just left may still be on its way.
      if (state?.settings.botTap === "new" && teamCan(state, "agents", "chat")) {
        markBotRead(b.id);
        const blank = newChatToReuse(state.chats, b.id, state, memberTeam(state)?.me.memberId);
        if (blank) {
          if (blank.archived) reopenedChats.current.add(blank.id);
          void api.setChatFlags(blank.id, { archived: false }).then(() => open(blank.id)).catch(fail);
        }
        else void newChat(b.id).catch(fail);
        return;
      }
      let visited: string | null = null;
      try { visited = localStorage.getItem(visitKey(host, b.id)); } catch { /* storage unavailable */ }
      const eligible = new Set(chats.map((c) => c.id));
      // Before the first visit on this desktop, prefer the last conversation the person worked in.
      const lastTurn = state?.runs.find((run) => eligible.has(run.chatId) && run.scheduleId == null && run.trigger !== "scheduled");
      const recent = chats.sort((a, b) => b.time - a.time);
      const c = recent.find((c) => c.id === visited) ?? recent.find((c) => c.id === lastTurn?.chatId)
        ?? recent.find((c) => c.messages.some((message) => message.role === "user" && !message.runId))
        ?? recent[0];
      if (c) {
        markBotRead(b.id, c.id);
        open(c.id);
      } else {
        markBotRead(b.id);
        if (state && teamCan(state, "agents", "chat")) void newChat(b.id).catch(fail);
        else nav("Chats");
      }
    });
  }
  async function send(key: string, options?: { attachments?: Attachment[]; quote?: string; mentions?: MentionInput[]; delivery?: "steer" | "queue" }, onDispatch?: () => void) {
    const prompt = composeSlashPrompt(drafts[key] || "", draftCommands[key]);
    if (!prompt || prompt === "/" || sending) return;
    setSending(true);
    try {
      const parts = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(prompt);
      const command = parts?.[1].toLowerCase(),
        args = parts?.[2]?.trim() || "";
      const clear = () => {
        setDrafts((prev) => ({ ...prev, [key]: "" }));
        setDraftCommands((prev) => ({ ...prev, [key]: null }));
      };
      if (
        command === "config" ||
        command === "settings" ||
        command === "theme"
      ) {
        settings(command === "theme" ? "Appearance" : "General");
        clear();
        return;
      }
      if (command === "login") {
        settings("Account");
        clear();
        return;
      }
      if (command === "agent" || command === "agents") {
        setModal("chat");
        clear();
        return;
      }
      if (command === "resume") {
        nav("Chats");
        clear();
        return;
      }
      if (command === "new" || command === "clear") {
        // In a Main chat both clear its context in place; the Main chat stays the same chat.
        if (chat?.main) await api.changeMainFork(chat.id, "reset", undefined, chat.activeFork);
        else await newChat(bot?.id || state!.bots[0].id);
        clear();
        return;
      }
      const id = key === "home" ? await mainChat(state!.bots[0].id) : key;
      if ((command === "model" || command === "models") && !args) {
        setModal("model");
        clear();
        return;
      }
      if (command === "btw" || command === "ask") {
        if (!args)
          throw new Error("Enter a side question after /" + command + ".");
        if (side[id] && !side[id].answer && !side[id].error)
          throw new Error("Your previous side question is still running.");
        clear();
        setSide((p) => ({ ...p, [id]: { question: args } }));
        const finish = (result: { answer?: string; error?: string }) =>
          setSide((p) =>
            p[id]?.question === args
              ? { ...p, [id]: { question: args, ...result } }
              : p,
          );
        void api
          .sideQuestion(id, args)
          .then((answer) => finish({ answer }))
          .catch((e) => finish({ error: e.message }));
        return;
      }
      if (command === "copy") {
        await api.copyReply(id);
        clear();
        return;
      }
      const clientMessageId = crypto.randomUUID();
      const message = { role: "user" as const, clientMessageId, text: prompt, time: Date.now(),
        quote: options?.quote, attachments: options?.attachments, mentions: draftMentions[key] };
      const remote = state?.remote?.using;
      const legacy = remote && !remote.capabilities.includes("client-message-id-v1") ? {
        from: key === "home" ? 0 : chat?.count ?? chat?.messages.length ?? 0,
        queued: new Set((state?.queued?.[id] ?? []).map(q => q.id)),
      } : undefined;
      clear();
      onDispatch?.();
      try {
        await box.send(id, message, () => api.send(id, prompt, legacy ? options : { ...options, clientMessageId }), legacy);
      } catch (error) {
        setDrafts(prev => ({ ...prev, [key]: [drafts[key], prev[key]].filter(Boolean).join("\n") }));
        if (draftMentions[key]?.length) setDraftMentions(prev => ({
          ...prev, [key]: [...draftMentions[key], ...(prev[key] ?? []).filter(m => !draftMentions[key].some(old => tokenOf(old) === tokenOf(m)))],
        }));
        throw error;
      }
      // Dispatch can succeed before the host has published the new row.
      void api.snapshot().then(receiveSnapshot).catch(fail);
      return true;
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  }
  async function pickModel(key: string) {
    if (key === "home") {
      const id = await mainChat(state!.bots[0].id);
      setDrafts((prev) => ({ ...prev, [id]: prev.home || "", home: "" }));
      setDraftMentions((prev) => ({ ...prev, [id]: prev.home ?? [], home: [] }));
      setDraftCommands((prev) => ({ ...prev, [id]: prev.home ?? null, home: null }));
    }
    setModal("model");
  }
  function prefill(text: string) {
    setDrafts((p) => ({ ...p, [chatId]: text }));
    setDraftCommands((p) => ({ ...p, [chatId]: null }));
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>(
          ".composewrap textarea[role=combobox]",
        )
        ?.focus(),
    );
  }
  function composer(key: string, placeholder: string) {
    if (key !== "home" && chat?.hostDispatch) {
      return state?.streams[key] !== undefined
        ? <button className="secondary" onClick={() => void api.stop(key).catch(fail)}>Stop request</button>
        : null;
    }
    const target = key === "home" ? state!.bots[0] : bot!;
    const chatPeople = key !== "home" && chat ? chatMentionPeople(state!, chat) : [];
    const canTyping =
      key !== "home" &&
      chatPeople.length > 0 &&
      (!state?.remote?.using || state.remote.using.capabilities.includes("chat-typing-v1"));
    return (
      <Composer
        key={key}
        botId={target.id}
        chatId={key === "home" ? undefined : key}
        listPulls={key !== "home" && !!chat?.projectId && !memberHost && (!state?.remote?.using || state.remote.using.capabilities.includes("prs-v1"))}
        sourceKey={JSON.stringify([state!.mcpServers, state!.skills, target.skillsOff, target.mcpOff])}
        draft={drafts[key] || ""}
        placeholder={placeholder}
        model={modelLabel(
          (key !== "home" ? chat?.model : undefined) ?? chatDefault(state!.settings, key !== "home" ? chat : undefined, target),
          models,
          defaultProvider,
        )}
        modelProvider={
          ((key !== "home" ? chat?.model : undefined) ?? chatDefault(state!.settings, key !== "home" ? chat : undefined, target))?.provider ?? defaultProvider
        }
        pickModel={() => void pickModel(key).catch(fail)}
        busy={state?.streams[key] !== undefined}
        sending={sending}
        above={key !== "home"}
        change={(value) => setDrafts((prev) => ({ ...prev, [key]: value }))}
        mentions={draftMentions[key]}
        setMentions={(list) => setDraftMentions((prev) => ({ ...prev, [key]: list }))}
        command={draftCommands[key] ?? null}
        setCommand={(cmd) => setDraftCommands((prev) => ({ ...prev, [key]: cmd }))}
        send={(options, onDispatch) => send(key, options, onDispatch)}
        stop={() => void api.stop(key).catch(fail)}
        botName={key !== "home" && (chat?.botIds?.length ?? 0) > 1 ? "The group" : target.name}
        botLook={target.look}
        botVoice={target.voice}
        startChat={key === "home" ? () => mainChat(target.id) : undefined}
        members={
          key !== "home" && (chat?.botIds?.length ?? 0) > 1
            ? chat!.botIds!.map((id) => state!.bots.find((b) => b.id === id)!).filter(Boolean)
            : undefined
        }
        people={chatPeople.length ? chatPeople : undefined}
        onTyping={canTyping ? (active) => void api["link.chat.typing"](key, active).catch(() => {}) : undefined}
      />
    );
  }
  // The welcome shows on first launch and whenever no model provider that is on is connected. A workspace
  // with chats predates it. A computer set up as a node host has finished setup without bots or a model
  // provider, so it opens straight into the window. While the list loads, or every provider is still
  // starting, nothing is known yet, so an onboarded person isn't shown the welcome in the meantime.
  const isNodeHost = !!state?.nodeHost?.enabled && !state?.remote?.using;
  const onboarded = !!state && (!!state.settings.onboarded || isNodeHost || state.chats.some(c => !c.main || c.messages.length > 0));
  const enabledProviders = providers?.filter((p) => p.enabled) ?? [];
  const connectedProviders = enabledProviders.filter(isConnected);
  const settled = !!providers && !(enabledProviders.length > 0 && enabledProviders.every((p) => p.starting));
  // A first launch opens on the choice of where the bots run (src/SetupChoice.tsx), unless the window
  // already uses another computer or a team: their bots are already there.
  const firstRun = !!state && !onboarded && !state.remote?.using && !memberTeam(state);
  const welcome = !!state && (firstRun || (onboarded && !isNodeHost && settled && !connectedProviders.length && !later));
  // The computer in use has sent nothing yet (it can't be reached, a different computer answered, or
  // it no longer knows this one): the window says so in place of its pages, and offers the way back.
  const using = state?.remote?.using;
  const hostDown = !!state && !!using && using.state !== "online" && !state.bots.length && !state.chats.length;
  useEffect(() => {
    if (welcome) setModal("");
  }, [welcome]);
  // With Spaces, Today is a space; without them (another computer, an older Botkins) there are no space pages.
  const spaces = !!state && hasSpaces(state);
  const openedSpace = page === "Space" ? state?.spaces?.find((s) => s.id === spaceId) : undefined;
  const hadSpace = useRef("");
  useEffect(() => {
    if (!state) return;
    if (!spaces && (page === "Space" || page === "AllSpaces")) return nav("Home");
    if (spaces && page === "Today") return openToday();
    if (openedSpace) hadSpace.current = openedSpace.id;
    // The open space went away (deleted, or no longer shared): go to the first pinned one.
    else if (page === "Space" && hadSpace.current === spaceId) {
      hadSpace.current = "";
      const first = state.spaces?.find((s) => s.pinned && s.id !== spaceId);
      if (first) openSpace(first.id);
      else nav("Home");
    }
  }, [spaces, page, spaceId, !!openedSpace]);
  const migrationPrompt = useMigrationPrompt(state?.profile);
  if (!state) return <main>{error || "Opening Botkins…"}</main>;
  if (migrationPrompt.open) return <ProfileMigrationPrompt state={state} onDismiss={migrationPrompt.dismiss} />;
  if (firstRun && setupPath === "") return <SetupChoice choose={setSetupPath} state={state} />;
  if (firstRun && setupPath === "computer") return <SetupConnect back={() => setSetupPath("")} />;
  if (firstRun && setupPath === "team") return <SetupTeam back={() => setSetupPath("")} initialJoin={teamJoinUrl || undefined} />;
  if (firstRun && setupPath === "node")
    return (
      <SetupNode
        back={() => setSetupPath("")}
        state={state}
        finish={async () => {
          receiveSnapshot(await api.snapshot());
          setSetupPath("");
        }}
      />
    );
  if (welcome)
    return (
      <Welcome
        onboarded={onboarded}
        finish={() => api.setPreferences({ onboarded: true })}
        later={onboarded ? () => setLater(true) : undefined}
        back={firstRun ? () => setSetupPath("") : undefined}
      />
    );
  // A workspace of this computer's with no bots opens on the first-run step: the person's existing
  // agents, or Create a bot. Never while another computer is in use, and never on an empty node host.
  if (!state.bots.length && !isNodeHost && !state.remote?.using && !memberTeam(state))
    return (
      <FirstBot
        remote={state.remote}
        saved={state.templates}
        created={async (id, after) => {
          receiveSnapshot(await api.snapshot());
          if (id && after?.setUp && proactiveTeam) botPage(id, true);
          else if (id) await mainChat(id);
        }}
      />
    );
  const stream = state.streams[chatId];
  const chatIds = new Set(state.chats.map((c) => c.id));
  const hostRequests = state.requests.filter((r) => r.nodeJob || !chatIds.has(r.chatId));
  const elsewhere = state.requests.find((r) => r.chatId !== chatId && !r.nodeJob && chatIds.has(r.chatId));
  const actions: PageActions = {
    open,
    botChat,
    markBotRead: (id) => markBotRead(id),
    markAllRead: () => {
      if (!state) return;
      markChatsRead(chatsPageUnreadChats(state.chats).map((c) => c.id));
    },
    mainChat: id => void mainChat(id).catch(fail),
    addBot: () => setModal("bot"),
    newChat: () => setModal("chat"),
    newChatIn: (projectId) => {
      setChatProject(projectId);
      setModal("chat");
    },
    showChats: () => nav("Chats"),
    newChatWith: (id) => void newChat(id).catch(fail),
    botPage: (id) => botPage(id),
    proactiveSetup: (id) => botPage(id, true),
    capabilities: (id) => settings("Capabilities", id),
    fail,
  };
  const profileBot = state.bots.find((b) => b.id === profileId);
  // The side menu's Models line: how many providers are connected, or what to do.
  const modelsState = !providers
    ? "Checking…"
    : connectedProviders.length
      ? connectedProviders.length === 1
        ? connectedProviders[0].name
        : connectedProviders.length + " connected"
      : enabledProviders.some((p) => p.starting)
        ? "Starting…"
        : "Sign in";
  const teamRequests = !state.remote?.using && state.team && "requests" in state.team ? state.team.requests.length : 0;
  const member = memberTeam(state);
  const memberHost = !!member || state.remote?.using?.member === true;
  const canViewAgents = teamCan(state, "agents");
  const canChat = teamCan(state, "agents", "chat");
  const placeAllowed = (place: string) => {
    // The Market adds apps, bots and skills: whoever may manage plugins sees it.
    if (place === "Market") return teamCan(state, "plugins");
    if (!memberHost) return true;
    if (place === "Home" || place === "Chats") return canViewAgents;
    if (place === "Today") return teamCan(state, "today");
    if (place === "Work") return teamCan(state, "today", "view") || teamCan(state, "today", "use");
    return false;
  };
  // Projects belong to the computer's owner; a team member's Work has the other two tabs.
  const work: WorkNav = {
    tabs: memberHost ? WORK_TABS.filter((tab) => tab !== "Projects") : WORK_TABS,
    go: workPage,
    activity: () => nav("Activity"),
    usage: () => nav("Usage"),
    waiting: (state.tasks ?? []).filter((t) => t.status === "blocked" || (t.status === "review" && !t.reviewerBotId)).length,
  };
  const openWork = () => workPage(work.tabs.includes(workTab) ? workTab : work.tabs[0]);
  // Collapses the side menu to icons: beside Settings when open, at the top of the strip when collapsed.
  const toggle = (
    <button
      type="button"
      className="sidebar-toggle"
      aria-label={collapsed ? "Expand side menu" : "Collapse side menu"}
      aria-expanded={!collapsed}
      title={(collapsed ? "Expand side menu" : "Collapse side menu") + " (" + MOD + "B)"}
      onClick={() => toggleSidebarRef.current()}
    >
      {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
    </button>
  );
  return (
    <AvatarAnimations enabled={state.settings.appearance.avatarAnimations !== false}>
    <BackdropLayer backdrop={backdropOf(state.settings.appearance.backdrop)} />
    <div className={"shell" + (collapsed ? " collapsed" : "")} inert={modal === "settings"}>
      <aside aria-label="Side menu">
        {/* The logo, then the side menu's own two buttons: collapse it, and New chat (the phone's +). */}
        <div className="brand">
          <img className="brand-name for-light" src="./wordmark.png" alt="Botkins" />
          <img className="brand-name for-dark" src="./wordmark-dark.png" alt="Botkins" />
          <span className="brand-actions">
            {toggle}
            {canChat && (
              <button type="button" className="newchat" aria-label="New chat" title={"New chat"} onClick={() => setModal("chat")}>
                <SquarePen size={17} />
              </button>
            )}
          </span>
        </div>
        <nav aria-label="Workspace">
          {placeOrder(state.settings.sidebar?.order).filter((p) => placeAllowed(p) && !(spaces && p === "Today")).map((p) => {
            const working = p === "Work" && Object.keys(state.streams).length > 0;
            const selected = p === "Work" ? WORK_PAGES.includes(page) : p === page;
            const unreadChats = p === "Chats" ? allUnreadChats(state.chats).length : 0;
            return (
              <button
                key={p}
                className={selected ? "selected" : ""}
                aria-current={selected ? "page" : undefined}
                aria-description={working ? "Bots are working" : unreadChats ? unreadChats + " unread" : undefined}
                onClick={() => (p === "Work" ? openWork() : p === "Wiki" ? wiki() : nav(p))}
              >
                <PlaceIcon place={p} size={collapsed ? 24 : 18} />
                {/* With icons only, the name shows beside the icon on hover and on keyboard focus. */}
                <span className="nav-label">
                  {p}
                  {working && (
                    <span className="nav-note" aria-hidden="true">
                      {" · bots are working"}
                    </span>
                  )}
                </span>
                {working && <i />}
                {unreadChats > 0 && !collapsed && (
                  <span className="count-badge" aria-hidden="true">
                    {unreadChats}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        {spaces && placeAllowed("Today") && (
          <SidebarSpaces
            state={state}
            collapsed={collapsed}
            selected={chat || profileBot ? "" : page === "Space" ? spaceId : page === "AllSpaces" ? "all" : ""}
            openSpace={openSpace}
            openAll={() => nav("AllSpaces")}
            fail={fail}
          />
        )}
        {canViewAgents && (
          <>
            <div className="sidebarlabel">
              <span className="nav-label">Bots</span>
              <span className="sidebarlabel-actions">
                {!collapsed && allUnreadChats(state.chats).length > 0 && (
                  <button aria-label="Mark all as read" title="Mark all as read" onClick={markAllChatsRead}>
                    <MailOpen size={15} />
                  </button>
                )}
                {teamCan(state, "agents", "create") && !hostDown && (
                  <button aria-label="Create bot" title={collapsed ? "Create bot" : undefined} onClick={() => setModal("bot")}>
                    <Plus size={15} />
                  </button>
                )}
              </span>
            </div>
            <SidebarBots state={state} actions={actions} compact={collapsed} selectedBotId={chat ? chat.botId : profileBot?.id} />
          </>
        )}
        {/* One row at the bottom: the computer in use (its menu switches computers and opens the
            model providers and Admin mode) and Settings. */}
        <div className="sidebar-foot">
          <HostSwitcher
            state={state}
            collapsed={collapsed}
            connect={() => settings("Computers")}
            admin={() => settings("Team")}
            models={{
              label: "Models · " + modelsState,
              line: modelsState,
              on: connectedProviders.length > 0,
              icons: connectedProviders.length ? (
                connectedProviders.slice(0, 3).map((p) => <ProviderIcon key={p.id} provider={p.id} name={p.name} size={14} />)
              ) : (
                <BrainCircuit size={15} />
              ),
              open: () => settings("Account"),
            }}
          />
          <button className="settings-link" aria-label="Settings" title={"Settings (" + MOD + ",)"} onClick={() => settings("General")}>
            <SlidersHorizontal size={17} />
            <span className="nav-label">Settings</span>
            {teamRequests > 0 && <span className="settings-badge" aria-hidden="true">{teamRequests}</span>}
          </button>
        </div>
      </aside>
      <main>
        {!hostDown && <HostBanner state={state} pairAgain={() => settings("Computers")} />}
        {hostRequests.length > 0 && (
          <div style={{ padding: "12px 18px 0" }}>
            <RequestPanel
              key={hostRequests[0].id}
              req={hostRequests[0]}
              count={hostRequests.length}
              bot={hostRequests[0].sourceBotName || state.nodeHost?.name || "Node host"}
            />
          </div>
        )}
        {elsewhere && (
          <button
            className="request-banner"
            onClick={() => open(elsewhere.chatId)}
          >
            <CircleAlert size={16} />
            {state.bots.find((b) => b.id === elsewhere.botId)?.name} needs your
            input <ArrowRight size={14} />
          </button>
        )}
        {error && (
          <div role="alert" className="error">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {hostDown ? (
          <HostUnreachable state={state} pairAgain={() => settings("Computers")} />
        ) : chat && bot ? (
          <div className={"chat-with-list" + (chatListShown ? " list-shown" : "")}>
          {chatListShown && <ChatListColumn state={state} actions={actions} selectedChatId={chat.id} />}
          <ChatView
            listShown={chatListShown}
            toggleList={toggleChatList}
            updates={updates}
            completions={completionByHost.get(host)!}
            onScreen={onScreen === chat.id}
            state={state}
            chat={chat}
            pending={pending}
            bot={bot}
            back={() => nav("Chats")}
            botSettings={() => settings("Bot")}
            prefill={prefill}
            pickModel={() => setModal("model")}
            side={side[chat.id]}
            dismissSide={() =>
              setSide((p) => {
                const v = { ...p };
                delete v[chat.id];
                return v;
              })
            }
            composer={canChat ? composer(
              chat.id,
              (chat.botIds?.length ?? 0) > 1 ? "Message the group… Type @ to ask one bot" : "Message " + bot.name + "…",
            ) : null}
            openChat={open}
            messageTarget={messageTarget?.chatId === chat.id ? messageTarget : undefined}
            openProject={(projectId) => projects({ projectId })}
            openWiki={(path) => wiki(path)}
            openToday={openToday}
            openRoutines={routines}
            openBot={() => botPage(bot.id)}
          />
          </div>
        ) : profileBot ? (
          <div className="content">
            <BotProfile
              key={profileBot.id}
              state={state}
              bot={profileBot}
              actions={actions}
              back={() => setProfileId("")}
              proactiveSetup={setupId === profileBot.id}
              routines={routines}
            />
          </div>
        ) : page === "Wiki" ? (
          <WikiPage
            key={wikiTarget.n}
            state={state}
            target={wikiTarget}
            openProject={(projectId) => projects({ projectId })}
            startChat={(text, wikiPage) => void wikiChat(text, wikiPage).catch(fail)}
            guard={(ask) => (leaveGuard.current = ask)}
          />
        ) : page === "Space" && openedSpace ? (
          <SpacePage
            key={host + ":" + openedSpace.id}
            state={state}
            space={openedSpace}
            open={open}
            openNew={(id) => void openNew(id).catch(fail)}
            openProject={(projectId) => projects({ projectId })}
            boardChat={boardChat}
            about={spaceAbout?.spaceId === openedSpace.id ? spaceAbout : undefined}
            removed={() => {
              hadSpace.current = "";
              const first = state.spaces?.find((s) => s.pinned && s.id !== openedSpace.id);
              if (first) openSpace(first.id);
              else nav("Home");
            }}
            fail={fail}
          />
        ) : (
          <div className="content">
            {page === "AllSpaces" && <AllSpaces state={state} openSpace={openSpace} fail={fail} />}
            {/* The Market: apps, bots, skills, plugins and Pi packages to add (Settings › Marketplace has the same). */}
            {page === "Market" && <MarketPage state={state} bots={state.bots} createBot={createBot} />}
            {page === "Today" && !spaces && (
              <Today
                state={state}
                open={open}
                fail={fail}
                request={async (botId, text) => {
                  const id = await newChat(botId);
                  await api.send(id, "/today-panel " + text);
                }}
                board={
                  <BoardPanel state={state} fail={fail} startChat={boardChat} />
                }
              />
            )}
            {page === "Home" && state.bots.length > 0 && (
              <HomePage
                state={state}
                actions={actions}
                composer={canChat ? composer(
                  "home",
                  "Ask " + state.bots[0].name + "…",
                ) : null}
                openWork={openWork}
                openRoutines={routines}
                openToday={openToday}
              />
            )}
            {page === "Chats" && (
              <ChatsPage
                state={state}
                actions={actions}
                query={query}
                setQuery={setQuery}
              />
            )}
            {page === "Activity" && (
              <ActivityPage state={state} actions={actions} filter={filter} setFilter={setFilter} routines={routines} back={openWork} />
            )}
            {page === "Home" && state.bots.length === 0 && (
              <div className="empty">
                {memberHost ? (
                  "No agents are visible to this role. Ask the team owner if you need access."
                ) : isNodeHost && state.nodeHost ? (
                  <div style={{ display: "grid", gap: 10, justifyItems: "center", maxWidth: 460 }}>
                    <strong>
                      {state.nodeHost.name} · {state.nodeHost.paused ? "Paused" : "Online"}
                    </strong>
                    <span>
                      Node host with {state.nodeHost.sharedProjects.length} shared{" "}
                      {state.nodeHost.sharedProjects.length === 1 ? "folder" : "folders"}
                      {state.nodeHost.lastCompleted
                        ? ` · Last request: ${state.nodeHost.lastCompleted.sourceBotName} (${state.nodeHost.lastCompleted.status})`
                        : ""}
                    </span>
                    <button type="button" className="primary" onClick={() => settings("Node host")}>
                      Manage Node host
                    </button>
                  </div>
                ) : (
                  (state.remote?.using?.name ?? "This computer") + " has no bots yet. Create one with the + beside Bots."
                )}
              </div>
            )}
            {page === "Projects" && (
              <ProjectsPage
                key={projectTarget.n}
                state={state}
                target={projectTarget}
                work={work}
                actions={actions}
                openChat={open}
                botPage={botPage}
                openSpace={openSpace}
                openNew={(id) => void openNew(id).catch(fail)}
                fail={fail}
              />
            )}
            {page === "Tasks" && (
              <TasksPage state={state} openChat={open} work={work} fail={fail} />
            )}
            {page === "Routines" && (
              <RoutinesPage
                key={routineTarget.n}
                state={state}
                actions={actions}
                initial={routineTarget}
                work={work}
                openToday={openToday}
              />
            )}
            {page === "Usage" && (
              <div className="page work-page usage-page">
                <WorkBack back={openWork} />
                <h1 className="page-title">Usage</h1>
                <Usage runCount={state.runs.length} />
              </div>
            )}
          </div>
        )}
      </main>
      <dialog
        ref={dialog}
        className={modal === "settings" ? "settings-window" : modal === "bot" ? "bot-sheet" : modal === "model" ? "model-dialog" : undefined}
        aria-label={modal === "settings" ? "Settings" : modal === "bot" ? "Create a bot" : undefined}
        onCancel={() => setModal("")}
      >
        {modal !== "settings" && <div className="sectionhead">
          <h2>
            {modal === "bot"
              ? "Create a bot"
              : modal === "chat"
                ? chatProject
                  ? "New chat in " + (state.projects?.find((p) => p.id === chatProject)?.name ?? "project")
                  : "New chat"
                : modal === "model"
                  ? "Chat model and thinking"
                  : ""}
          </h2>
          <button aria-label="Close dialog" onClick={() => setModal("")}>
            <X size={19} />
          </button>
        </div>}
        {modal === "model" && chat && bot && (
          <>
            <p>
              {bot.name} · {chat.title}
            </p>
            <ModelPicker
              key={chat.id}
              scope="chat"
              id={chat.id}
              value={chat.model}
              speedSettings={!state.remote?.using || state.remote.using.capabilities.includes("fast-mode-v1") ? { value: chat.fastMode, inherited: bot.fastMode ?? state.settings.fastMode } : undefined}
              inherited={chatDefault(state.settings, chat, bot)}
              inheritLabel={isRoutineChat(chat) ? "Use the routines default" : undefined}
              done={() => setModal("")}
              openProviders={() => settings("Account")}
            />
            {stream !== undefined && (
              <small>Changes apply to the next turn.</small>
            )}
          </>
        )}
        {modal === "chat" && canChat && (
          <NewChat
            state={state}
            project={chatProject}
            fail={fail}
            open={async (id) => {
              receiveSnapshot(await api.snapshot());
              open(id);
            }}
          />
        )}
        {modal === "bot" && (
          <BotForm
            key={botStart?.id ?? "blank"}
            remote={state.remote}
            start={botStart}
            fail={fail}
            cancel={() => setModal("")}
            saved={state.templates}
            taken={state.bots.map((b) => b.look)}
            created={async (id, after) => {
              receiveSnapshot(await api.snapshot());
              setModal("");
              if (after?.setUp && proactiveTeam) botPage(id, true);
              else await mainChat(id);
            }}
          />
        )}
      </dialog>
    </div>
    {/* Settings: a page over the whole window, its own list of sections where the side menu was.
        Back (or Esc) returns to the page underneath, which kept its place. */}
    {modal === "settings" && (
      <div className="settings-host" role="dialog" aria-modal="true" aria-label="Settings">
        <Settings
          key={settingsTab + ":" + settingsRevision}
          state={state}
          close={() => setModal("")}
          bots={state.bots}
          initialTab={settingsTab}
          settings={state.settings}
          initialBot={settingsBot || bot?.id || state.bots[0]?.id || ""}
          runCount={state.runs.length}
          initialJoin={teamJoinUrl}
          createBot={createBot}
        />
      </div>
    )}
    </AvatarAnimations>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
