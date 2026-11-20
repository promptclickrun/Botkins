import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  BrainCircuit,
  SlidersHorizontal,
  ChevronRight,
  CircleAlert,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  SquarePen,
  X,
} from "lucide-react";
import { MOD, placeOrder } from "./places";
import { PlaceIcon } from "./PlaceIcon";
import Composer from "./Composer";
import Today from "./Today";
import BoardPanel from "./Board";
import Settings from "./Settings";
import ModelPicker, { modelLabel } from "./ModelPicker";
import ProviderIcon from "./ProviderIcon";
import { isConnected, useModelCatalog, useProviders } from "./providers";
import ChatView, { type SideAnswer } from "./ChatView";
import { ChatsPage, HomePage, SidebarBots, type PageActions } from "./Pages";
import { WorkPage } from "./Work";
import RoutinesPage from "./Routines";
import TasksPage from "./Tasks";
import Usage from "./Usage";
import { HostBanner, HostSwitcher } from "./RemoteHosts";
import BotForm from "./BotForm";
import BotProfile from "./BotProfile";
import NewChat from "./NewChat";
import ProjectsPage, { type ProjectsTarget } from "./Projects";
import WikiPage, { type WikiTarget } from "./Wiki";
import Welcome from "./Welcome";
import FirstBot from "./FirstBot";
import type { Attachment, Bot, Chat, MentionInput, State } from "./types";
import { tokenOf, type DraftMention } from "./MentionMenu";
import { applyAppearance, startAppearance } from "./appearance";
import "./style.css";

// The remembered colors go on before anything is drawn.
startAppearance();
const api = window.botkins;
type Page = "Home" | "Today" | "Chats" | "Work" | "Projects" | "Wiki" | "Routines" | "Usage" | "Tasks";
type Modal = "" | "bot" | "chat" | "account" | "settings" | "model";
const personalChat = (chat: Chat) =>
  !chat.archived && !chat.botIds && !chat.panelId && !chat.schedules?.some((entry) => entry.routine);
const visitKey = (host: string, bot: string) => "botkins.lastChat." + JSON.stringify([host, bot]);
function App() {
  const [state, setState] = useState<State>();
  const [page, setPage] = useState<Page>("Home");
  const [chatId, setChatId] = useState("");
  const host = state?.remote?.using?.id ?? "local";
  const pendingVisit = useRef<{ host: string; id: string } | null>(null);
  const [messageTarget, setMessageTarget] = useState<{ chatId: string; index: number } | null>(null);
  const [modal, setModal] = useState<Modal>("");
  const [settingsTab, setSettingsTab] = useState("General");
  const [side, setSide] = useState<Record<string, SideAnswer>>({});
  /** The bot whose page is open, or "". */
  const [profileId, setProfileId] = useState("");
  const [settingsBot, setSettingsBot] = useState("");
  function settings(tab: string, botId = "") {
    setSettingsTab(tab);
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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
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
    const off = api.subscribe(setState);
    api.snapshot().then(setState).catch(fail);
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
      window.removeEventListener("keydown", shortcut);
    };
  }, []);
  useEffect(() => {
    if (modal) dialog.current?.showModal();
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
  }, [look?.theme, look?.colorTheme, look?.textSize, look?.font, look?.bubble]);
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
      if (state?.chats.find((c) => c.id === id)?.unread)
        void api.setChatFlags(id, { unread: false }).catch(fail);
    });
  }
  // Notification clicks open their chat.
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => api.onOpenChat((id) => openRef.current(id)), []);
  // An HTML app's answer waits in its chat's message box; the person reviews and sends it.
  useEffect(() => {
    // The answer joins whatever is already typed in that chat, so nothing the person wrote is lost.
    const place = ({ chatId, text }: { chatId: string; text: string }) => {
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
  function botPage(id: string) {
    leave(() => {
      setChatId("");
      setModal("");
      setError("");
      setProfileId(id);
    });
  }
  function projects(target: Omit<ProjectsTarget, "n"> = {}) {
    leave(() => {
      nav("Projects");
      setProjectTarget((t) => ({ ...target, n: t.n + 1 }));
    });
  }
  function wiki(path?: string) {
    leave(() => {
      nav("Wiki");
      setWikiTarget((t) => ({ path, n: t.n + 1 }));
    });
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
    setState(await api.snapshot());
    open(key);
    return key;
  }
  function botChat(b: Bot) {
    const chats = state?.chats.filter((c) => c.botId === b.id && personalChat(c)) ?? [];
    let visited: string | null = null;
    try { visited = localStorage.getItem(visitKey(host, b.id)); } catch { /* storage unavailable */ }
    const eligible = new Set(chats.map((c) => c.id));
    // Before the first visit on this desktop, prefer the last conversation the person worked in.
    const lastTurn = state?.runs.find((run) => eligible.has(run.chatId) && run.scheduleId == null && run.trigger !== "scheduled");
    const recent = chats.sort((a, b) => b.time - a.time);
    const c = recent.find((c) => c.id === visited) ?? recent.find((c) => c.id === lastTurn?.chatId)
      ?? recent.find((c) => c.messages.some((message) => message.role === "user" && !message.runId))
      ?? recent[0];
    if (c) open(c.id);
    else void newChat(b.id).catch(fail);
  }
  async function send(key: string, options?: { attachments?: Attachment[]; quote?: string; mentions?: MentionInput[]; delivery?: "steer" | "queue" }) {
    const prompt = drafts[key]?.trim();
    if (!prompt || prompt === "/" || sending) return;
    setSending(true);
    try {
      const parts = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(prompt);
      const command = parts?.[1].toLowerCase(),
        args = parts?.[2]?.trim() || "";
      const clear = () => setDrafts((prev) => ({ ...prev, [key]: "" }));
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
        await newChat(bot?.id || state!.bots[0].id);
        clear();
        return;
      }
      const id = key === "home" ? await newChat(state!.bots[0].id) : key;
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
      await api.send(id, prompt, options);
      setState(await api.snapshot());
      clear();
      return true;
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  }
  async function pickModel(key: string) {
    if (key === "home") {
      const id = await newChat(state!.bots[0].id);
      setDrafts((prev) => ({ ...prev, [id]: prev.home || "", home: "" }));
      setDraftMentions((prev) => ({ ...prev, [id]: prev.home ?? [], home: [] }));
    }
    setModal("model");
  }
  function prefill(text: string) {
    setDrafts((p) => ({ ...p, [chatId]: text }));
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>(
          ".composewrap textarea[role=combobox]",
        )
        ?.focus(),
    );
  }
  function composer(key: string, placeholder: string) {
    const target = key === "home" ? state!.bots[0] : bot!;
    return (
      <Composer
        key={key}
        botId={target.id}
        chatId={key === "home" ? undefined : key}
        sourceKey={JSON.stringify([state!.mcpServers, state!.skills, target.skillsOff, target.mcpOff])}
        draft={drafts[key] || ""}
        placeholder={placeholder}
        model={modelLabel(
          (key !== "home" ? chat?.model : undefined) ??
            target.model ??
            state!.settings.model,
          models,
          defaultProvider,
        )}
        modelProvider={
          ((key !== "home" ? chat?.model : undefined) ?? target.model ?? state!.settings.model)?.provider ?? defaultProvider
        }
        pickModel={() => void pickModel(key).catch(fail)}
        busy={state?.streams[key] !== undefined}
        sending={sending}
        above={key !== "home"}
        change={(value) => setDrafts((prev) => ({ ...prev, [key]: value }))}
        mentions={draftMentions[key]}
        setMentions={(list) => setDraftMentions((prev) => ({ ...prev, [key]: list }))}
        send={(options) => send(key, options)}
        stop={() => void api.stop(key).catch(fail)}
        botName={key !== "home" && (chat?.botIds?.length ?? 0) > 1 ? "The group" : target.name}
        startChat={key === "home" ? () => newChat(target.id) : undefined}
        members={
          key !== "home" && (chat?.botIds?.length ?? 0) > 1
            ? chat!.botIds!.map((id) => state!.bots.find((b) => b.id === id)!).filter(Boolean)
            : undefined
        }
      />
    );
  }
  // The welcome shows on first launch and whenever no model provider that is on is connected. A workspace
  // with chats predates it. While the list loads, or every provider is still starting, nothing is known
  // yet, so an onboarded person isn't shown the welcome in the meantime.
  const onboarded = !!state && (!!state.settings.onboarded || state.chats.length > 0);
  const enabledProviders = providers?.filter((p) => p.enabled) ?? [];
  const connectedProviders = enabledProviders.filter(isConnected);
  const settled = !!providers && !(enabledProviders.length > 0 && enabledProviders.every((p) => p.starting));
  const welcome = !!state && (!onboarded || (settled && !connectedProviders.length && !later));
  useEffect(() => {
    if (welcome) setModal("");
  }, [welcome]);
  if (!state) return <main>{error || "Opening Botkins…"}</main>;
  if (welcome)
    return (
      <Welcome
        onboarded={onboarded}
        finish={() => api.setPreferences({ onboarded: true })}
        later={onboarded ? () => setLater(true) : undefined}
      />
    );
  // A workspace with no bots opens on the first-run step: the person's existing agents, or Create a bot.
  if (!state.bots.length)
    return <FirstBot saved={state.templates} created={async () => setState(await api.snapshot())} />;
  const stream = state.streams[chatId];
  const elsewhere = state.requests.find((r) => r.chatId !== chatId);
  const actions: PageActions = {
    open,
    botChat,
    addBot: () => setModal("bot"),
    newChat: () => setModal("chat"),
    showChats: () => nav("Chats"),
    newChatWith: (id) => void newChat(id).catch(fail),
    botPage,
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
    <div className={"shell" + (collapsed ? " collapsed" : "")}>
      <aside aria-label="Side menu">
        <div className="brand">
          <img className="brand-name for-light" src="./wordmark.png" alt="Botkins" />
          <img className="brand-name for-dark" src="./wordmark-dark.png" alt="Botkins" />
          {/* New chat sits at the top of the list, as the + does in the phone app. */}
          <button type="button" className="newchat" aria-label="New chat" title="New chat" onClick={() => setModal("chat")}>
            <SquarePen size={17} />
          </button>
          {collapsed && toggle}
        </div>
        <nav aria-label="Workspace">
          {placeOrder(state.settings.sidebar?.order).map((p) => {
            const working = p === "Work" && Object.keys(state.streams).length > 0;
            const selected = (p === page || (p === "Work" && (page === "Routines" || page === "Usage" || page === "Tasks")));
            return (
              <button
                key={p}
                className={selected ? "selected" : ""}
                aria-current={selected ? "page" : undefined}
                aria-description={working ? "Bots are working" : undefined}
                onClick={() => (p === "Projects" ? projects() : p === "Wiki" ? wiki() : nav(p))}
              >
                <PlaceIcon place={p} size={collapsed ? 24 : 20} />
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
              </button>
            );
          })}
        </nav>
        <div className="sidebarlabel">
          <span className="nav-label">Bots</span>
          <button aria-label="Create bot" title={collapsed ? "Create bot" : undefined} onClick={() => setModal("bot")}>
            <Plus size={15} />
          </button>
        </div>
        <SidebarBots state={state} actions={actions} compact={collapsed} />
        <div className="sidebar-foot">
          <button className="settings-link" title={collapsed ? "Settings (" + MOD + ",)" : undefined} onClick={() => settings("General")}>
            <SlidersHorizontal size={17} />
            <span className="nav-label">Settings</span>
          </button>
          {!collapsed && toggle}
        </div>
        <HostSwitcher state={state} collapsed={collapsed} connect={() => settings("Phone")} />
        <button
          className={"account models-status" + (connectedProviders.length ? " on" : "")}
          aria-label={"Models · " + modelsState}
          title={collapsed ? "Models · " + modelsState : undefined}
          onClick={() => settings("Account")}
        >
          <span className="provider-stack" aria-hidden="true">
            {connectedProviders.length ? (
              connectedProviders.slice(0, 3).map((p) => <ProviderIcon key={p.id} provider={p.id} name={p.name} size={15} />)
            ) : (
              <BrainCircuit size={18} />
            )}
          </span>
          <span className="nav-label">
            Models
            <small>{modelsState}</small>
          </span>
          <ChevronRight size={14} />
        </button>
      </aside>
      <main>
        <HostBanner state={state} pairAgain={() => settings("Phone")} />
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
        {chat && bot ? (
          <ChatView
            state={state}
            chat={chat}
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
            composer={composer(
              chat.id,
              (chat.botIds?.length ?? 0) > 1 ? "Message the group… Type @ to ask one bot" : "Message " + bot.name + "…",
            )}
            openChat={open}
            messageTarget={messageTarget?.chatId === chat.id ? messageTarget : undefined}
            openProject={(projectId) => projects({ projectId })}
            openWiki={(path) => wiki(path)}
            openToday={() => nav("Today")}
            openRoutines={routines}
            openBot={() => botPage(bot.id)}
          />
        ) : profileBot ? (
          <div className="content">
            <BotProfile
              key={profileBot.id}
              state={state}
              bot={profileBot}
              actions={actions}
              back={() => setProfileId("")}
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
        ) : (
          <div className="content">
            {page === "Today" && (
              <Today
                state={state}
                open={open}
                fail={fail}
                request={async (botId, text) => {
                  const id = await newChat(botId);
                  await api.send(id, "/today-panel " + text);
                }}
                board={
                  <BoardPanel
                    state={state}
                    fail={fail}
                    startChat={async (botId, text, send, item) => {
                      const id = await newChat(botId);
                      // A Today item goes along as a record: the chat shows a card for it and the bot reads it.
                      const mention: DraftMention | undefined = item && { kind: "board", id: item.id, label: item.title };
                      if (send) await api.send(id, text, mention && { mentions: [{ kind: "board", id: mention.id }] });
                      else {
                        setDrafts((prev) => ({ ...prev, [id]: mention ? tokenOf(mention) + " " + text : text }));
                        if (mention) setDraftMentions((prev) => ({ ...prev, [id]: [mention] }));
                      }
                    }}
                  />
                }
              />
            )}
            {page === "Home" && (
              <HomePage
                state={state}
                actions={actions}
                composer={composer(
                  "home",
                  "Ask " + state.bots[0].name + "…",
                )}
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
            {page === "Work" && (
              <WorkPage
                state={state}
                actions={actions}
                filter={filter}
                setFilter={setFilter}
                routines={routines}
                usage={() => nav("Usage")}
                tasks={() => nav("Tasks")}
              />
            )}
            {page === "Projects" && (
              <ProjectsPage
                key={projectTarget.n}
                state={state}
                target={projectTarget}
                openChat={open}
                botPage={botPage}
                fail={fail}
              />
            )}
            {page === "Tasks" && (
              <TasksPage state={state} openChat={open} back={() => nav("Work")} fail={fail} />
            )}
            {page === "Routines" && (
              <RoutinesPage
                key={routineTarget.n}
                state={state}
                actions={actions}
                initial={routineTarget}
                openToday={() => nav("Today")}
              />
            )}
            {page === "Usage" && (
              <div className="usage-page">
                <h1>Usage</h1>
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
                ? "New chat"
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
              inherited={bot.model ?? state.settings.model}
              done={() => setModal("")}
              openProviders={() => settings("Account")}
            />
            {stream !== undefined && (
              <small>Changes apply to the next turn.</small>
            )}
          </>
        )}
        {modal === "settings" && (
          <Settings
            state={state}
            close={() => setModal("")}
            bots={state.bots}
            initialTab={settingsTab}
            settings={state.settings}
            initialBot={settingsBot || bot?.id || state.bots[0].id}
            runCount={state.runs.length}
          />
        )}
        {modal === "chat" && (
          <NewChat
            state={state}
            fail={fail}
            open={async (id) => {
              setState(await api.snapshot());
              open(id);
            }}
          />
        )}
        {modal === "bot" && (
          <BotForm
            fail={fail}
            cancel={() => setModal("")}
            saved={state.templates}
            taken={state.bots.map((b) => b.look)}
            created={async () => {
              setState(await api.snapshot());
              setModal("");
            }}
          />
        )}
      </dialog>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
