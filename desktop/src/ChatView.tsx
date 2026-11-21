import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  Clock,
  Copy,
  File,
  Folder,
  FileDiff,
  FoldVertical,
  FolderGit2,
  GitFork,
  PanelRight,
  Reply,
  RotateCcw,
  SlidersHorizontal,
  X,
  Volume2,
  Square,
} from "lucide-react";
import { type CompletionScroll, finalReplyIndex } from "./completionScroll";
import { RichText } from "./RichText";
import type { FilePreview } from "./ChatFileLink";
import {
  HelperChip,
  HelperDrawer,
  RunLead,
  InterimUpdate,
  Reasoning,
  ReasoningUpdate,
  StepList,
  RunCards,
  TaskChip,
  TaskDrawer,
  ToolTrail,
  TimelineFold,
  duration,
} from "./ChatActivity";
import { QuoteContext } from "./Composer";
import { MentionChips } from "./MentionMenu";
import { TeamRail } from "./TeamRail";
import RequestPanel from "./RequestPanel";
import { LinkPreviewCard, useReadAloud } from "./Extras";
import { clearReadingError, readAloud, useReading } from "./voice";
import ContextDetails from "./ContextDetails";
import { BotAvatar, activityLabel, botActivity, chatActivity, useOutcome } from "./Avatar";
import SidePane, { paneAction, useNarrow, usePaneAsk } from "./SidePane";
import { ModelBadge, modelLabel, useDefaultProvider } from "./ModelPicker";
import { useModelCatalog } from "./providers";
import ProjectChanges, { ProjectPicker, modeLabels } from "./ProjectChanges";
import { blockedBots } from "./access";
import { FolderKanban, ShieldAlert, UserPlus } from "lucide-react";
import { PeopleDialog } from "./ChatPeople";
import { chatPeopleView } from "./peopleView";
import type { Bot, Chat, ChatMode, Message, State } from "./types";
import { orderedRunEvents, type RunTimelineEvent } from "./chatTimeline";
import { teamCan } from "./teamAccess";
import "./canvas.css";
import "./projects.css";
import "./groups.css";

export type SideAnswer = { question: string; answer?: string; error?: string };

const failed = ["Needs you", "Interrupted", "Stopped"];

/** Starter prompts that fit a bot's role. */
function starters(bot: Bot) {
  // The role decides first; instructions only when the role says nothing specific.
  const role = (bot.name + " " + bot.role).toLowerCase();
  const generic = /everyday|general|assistant|helper/.test(role);
  const t = generic ? role : role + " " + bot.instructions.toLowerCase();
  if (/cod|software|program|develop|engineer|debug/.test(t))
    return [
      "Explain what this code does, step by step",
      "Write a small script that renames files by date",
      "Review a function for bugs and edge cases",
      "Set up a new project folder with a README",
    ];
  if (/research|investigat|evidence|analy|scout/.test(t))
    return [
      "Research a topic and summarize the evidence",
      "Compare two options and list the tradeoffs",
      "Find what changed recently on a subject",
      "Check whether a claim holds up",
    ];
  if (/writ|edit|prose|copy|blog|draft/.test(t))
    return [
      "Tighten this paragraph without changing its meaning",
      "Draft a friendly follow-up email",
      "Outline a blog post on a topic I choose",
      "Suggest five titles for my draft",
    ];
  return [
    "Help me plan my week",
    "Break a big task into small steps",
    "Draft a short email for me",
    "Brainstorm ideas for a weekend project",
  ];
}

const busy0 = (state: State, chatId: string) => state.streams[chatId] !== undefined;

function Attachments({ list }: { list: Message["attachments"] }) {
  if (!list?.length) return null;
  return (
    <ul className="attach-chips sent" aria-label="Attachments">
      {list.map((a) => (
        <li key={a.path} title={a.path}>
          {a.kind === "directory" ? <Folder size={13} /> : <File size={13} />}
          <span>{a.name}</span>
        </li>
      ))}
    </ul>
  );
}

/** One conversation: header, transcript, pending requests and the composer slot. */
export default function ChatView({
  completions,
  onScreen,
  state,
  chat,
  bot,
  back,
  botSettings,
  prefill,
  pickModel,
  side,
  dismissSide,
  composer,
  openChat,
  messageTarget,
  openProject,
  openWiki,
  openToday,
  openRoutines,
  openBot,
}: {
  completions: CompletionScroll;
  onScreen: boolean;
  state: State;
  chat: Chat;
  bot: Bot;
  back: () => void;
  botSettings: () => void;
  prefill: (text: string) => void;
  pickModel: () => void;
  side?: SideAnswer;
  dismissSide: () => void;
  composer: ReactNode;
  openChat?: (id: string, messageIndex?: number) => void;
  messageTarget?: { chatId: string; index: number };
  openProject?: (id: string) => void;
  /** Opens a wiki page in the Wiki section. */
  openWiki?: (path: string) => void;
  /** Opens Today, for a message that carries one of its items. */
  openToday?: () => void;
  /** Opens Routines on one routine (by its chat) or on a bot's routines. */
  openRoutines?: (target: { id?: string; botId?: string }) => void;
  /** Opens this bot's page. */
  openBot?: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const gliding = useRef(false);
  const readingBeginning = useRef(false);
  const [away, setAway] = useState(false);
  const [quotes, setQuotes] = useState<Record<string, string>>({});
  const [drawer, setDrawer] = useState<"" | "tasks" | "helpers">("");
  const [menu, setMenu] = useState<{ index: number; x: number; y: number }>();
  const [notice, setNotice] = useState("");
  const [showChanges, setShowChanges] = useState(false);
  const [choosingProject, setChoosingProject] = useState(false);
  const stream = state.streams[chat.id];
  // Group chats: 2 to 6 bots answer in turn (desktop/groups.mjs).
  const members = (chat.botIds ?? [])
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => !!b);
  const group = (chat.botIds?.length ?? 0) >= 2;
  // The model this chat runs on: its own choice, else its bot's, else the global default.
  const { models } = useModelCatalog();
  const defaultProvider = useDefaultProvider();
  const model = chat.model ?? bot.model ?? state.settings.model;
  const speaker = group ? state.bots.find((b) => b.id === state.speakers?.[chat.id]) : bot;
  const nameOf = (m: Message) =>
    m.botId ? (state.bots.find((b) => b.id === m.botId)?.name ?? "Removed bot") : bot.name;
  const messageClass = (message: Message) =>
    message.role + (message.role === "user" && message.author ? " from-member" : "");
  const project = chat.projectId ? state.projects?.find((p) => p.id === chat.projectId) : undefined;
  const canManageAgents = teamCan(state, "agents", "manage");
  // "Invite" in the header, when the computer in use keeps chat people and the team has someone to invite.
  const peopleView = chatPeopleView(state, chat);
  const [showPeople, setShowPeople] = useState(false);
  // A bot that lost access to the chat's project can't take new turns here (desktop/access.mjs).
  const blocked = blockedBots(state, chat);
  const mode: ChatMode = chat.mode ?? "default";
  const started = chat.messages.length > 0 || busy0(state, chat.id);
  const busy = stream !== undefined;
  const thinking = state.thinking?.[chat.id];
  const queued = state.queued?.[chat.id] ?? [];
  const showThinking = state.settings.showThinking !== false;
  // Newer preference records use the same words as the phone. Keep the older boolean working for
  // profiles created before the setting was split into Thinking and updates.
  const thinkingMode = state.settings.thinking ?? (showThinking ? "open" : "hidden");
  const stepsMode = state.settings.steps ?? (state.settings.foldTools ? "folded" : "every");
  const chatRuns = state.runs.filter((r) => r.chatId === chat.id);
  const runs = new Map(chatRuns.map((r) => [r.id, r]));
  const latest = chatRuns[0];
  const requests = state.requests.filter((r) => r.chatId === chat.id);
  const todos = chat.todos ?? latest?.todos ?? [];
  const agents = latest?.agents ?? [];
  const lastUserRun = [...chat.messages].reverse().find((m) => m.role === "user" && m.runId)?.runId;
  // What the chat's bot is doing now; when a reply ends, the avatar plays how it went once.
  const activity = chatActivity(state, chat.id);
  const face = useOutcome(activity, !!latest && failed.includes(latest.status));
  const doing = activityLabel(activity);
  // The side pane's open or closed choice is kept per computer, for every chat. In a narrow window
  // the pane is a drawer over the conversation instead, open only when asked for.
  const [sideOpen, setSideOpen] = useState(() => {
    try {
      return localStorage.getItem("botkins.chatSide") !== "0";
    } catch {
      return true;
    }
  });
  const narrow = useNarrow();
  const [paneDrawer, setPaneDrawer] = useState(false);
  const [preview, setPreview] = useState<(FilePreview & { chatId: string })>();
  const panels = chat.pane?.panels ?? [];
  // A group chat has no Details, so its pane is there only once a bot opened a panel.
  const paneAllowed = true;
  const paneShown = paneAllowed && (narrow ? paneDrawer : sideOpen);
  const detailsButton = useRef<HTMLButtonElement>(null);
  useEffect(() => setPaneDrawer(false), [chat.id]);
  const showPane = (open: boolean) => {
    if (narrow) return setPaneDrawer(open);
    setSideOpen(open);
    try {
      localStorage.setItem("botkins.chatSide", open ? "1" : "0");
    } catch {
      // Without storage the choice lasts until the window closes.
    }
  };
  // The person opens or closes the pane: the app hears of it, so a bot doesn't open it again this turn.
  const toggleSide = () => {
    showPane(!paneShown);
    paneAction(chat.id, paneShown ? "closed" : "opened");
    if (narrow && !paneShown) requestAnimationFrame(() => document.querySelector<HTMLElement>(".side-pane.drawer :is([role=tab][aria-selected=true], .pane-close)")?.focus());
  };
  const files = { chatId: chat.id, botId: bot.id, hostId: state.remote?.using?.id, remote: !!state.remote?.using, preview: (file: FilePreview) => {
    setPreview({ ...file, chatId: chat.id });
    showPane(true);
  } };
  const closePane = () => {
    showPane(false);
    paneAction(chat.id, "closed");
    if (narrow) detailsButton.current?.focus();
  };
  // A bot asked for the pane to open on a panel, or to close.
  usePaneAsk(state, chat, (close) => showPane(!close));
  const unseen = !paneShown && panels.some((p) => p.unseen);
  const sentCount = chat.messages.filter((m) => m.role === "user").length + queued.length;

  // Within this much of the end counts as at the bottom, so the button doesn't flicker there.
  const atBottom = () => {
    const el = scroller.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const clearBeginning = () => {
    readingBeginning.current = false;
    scroller.current?.style.removeProperty("--reply-scroll-room");
  };
  const toBottom = () => {
    clearBeginning();
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    gliding.current = false;
    stick.current = true;
    setAway(false);
  };
  // Scroll to latest message: glides down, and follows the reply again from there. While it
  // glides the view counts as at the bottom; the person scrolling themselves stops it.
  const glideToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    clearBeginning();
    stick.current = true;
    setAway(false);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return toBottom();
    gliding.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  const stopGlide = () => {
    gliding.current = false;
    readingBeginning.current = false;
  };
  // A new chat, or a message the person sent, jumps to the latest.
  useLayoutEffect(toBottom, [completions, chat.id]);
  useLayoutEffect(() => {
    if (!readingBeginning.current || busy) toBottom();
  }, [sentCount]);
  // New output follows only while the person is at the bottom.
  const liveSteps = latest?.status === "Working" ? (latest.steps?.length ?? 0) + (latest.reasoning?.length ?? 0) : 0;
  useLayoutEffect(() => {
    if (stick.current) {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    // A turn that ends, and a teammate row that appears, add rows below the last message too.
  }, [chat.messages.length, stream, thinking, liveSteps, requests.length, side?.answer, latest?.status, latest?.teamwork?.length]);
  // Rows also change size without any of the above changing: a card loads, a row or the task
  // list is opened. While the view follows the latest, growth is followed too, except just after
  // the person opened something: that stays where it is, and Scroll to latest message shows if the end
  // moved out of view.
  const opened = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const settle = () => {
      if (!stick.current || atBottom()) return;
      if (Date.now() - opened.current < 800) {
        stick.current = false;
        setAway(true);
      } else el.scrollTop = el.scrollHeight;
    };
    const mutations = new MutationObserver(settle);
    mutations.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden", "aria-expanded"] });
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(settle);
    sizes?.observe(el);
    const mark = (event: Event) => {
      if ((event.target as Element | null)?.closest?.("summary, details, [aria-expanded], .canvas-chip")) opened.current = Date.now();
    };
    // The task list and helper chips sit outside the scroller, so the whole page is watched.
    document.addEventListener("pointerdown", mark, true);
    document.addEventListener("keydown", mark, true);
    return () => {
      mutations.disconnect();
      sizes?.disconnect();
      document.removeEventListener("pointerdown", mark, true);
      document.removeEventListener("keydown", mark, true);
    };
  }, [chat.id]);
  const pendingRun = completions.pending(chat.id);
  const replyIndex = pendingRun ? finalReplyIndex(chat, pendingRun) : undefined;
  useLayoutEffect(() => {
    if (!pendingRun || replyIndex === undefined || busy || !onScreen || state.settings.completionPosition !== "beginning") return;
    if (!stick.current) {
      completions.readerMoved(chat.id, pendingRun);
      return;
    }
    const showBeginning = () => {
      const el = scroller.current;
      const row = document.getElementById(`message-${chat.id}-${replyIndex}`);
      if (!el || !row || !el.contains(row)) return;
      if (!completions.take(chat.id, { visible: !document.hidden && document.hasFocus(), rendered: pendingRun })) return;
      gliding.current = false;
      stick.current = false;
      readingBeginning.current = true;
      setAway(true);
      const top = el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top;
      // Even a one-line reply needs enough space below it to align with the top edge.
      const column = row.closest(".chat-column")!;
      const missing = Math.max(0, Math.ceil(el.clientHeight - (column.getBoundingClientRect().bottom - row.getBoundingClientRect().top)));
      el.style.setProperty("--reply-scroll-room", missing + "px");
      el.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    };
    showBeginning();
    window.addEventListener("focus", showBeginning);
    document.addEventListener("visibilitychange", showBeginning);
    return () => {
      window.removeEventListener("focus", showBeginning);
      document.removeEventListener("visibilitychange", showBeginning);
    };
  }, [completions, chat.id, pendingRun, replyIndex, busy, onScreen, state.settings.completionPosition]);

  const [earlier, setEarlier] = useState<{ target: typeof messageTarget; from: number; messages: Message[] }>();
  const loadedFrom = chat.loaded?.from ?? 0;
  useEffect(() => {
    if (!messageTarget || messageTarget.index >= loadedFrom) return;
    let current = true;
    void window.botkins.artifactMessagePage(chat.id, messageTarget.index).then((page) => {
      if (page && current) setEarlier({ target: messageTarget, ...page });
    }).catch((e) => { if (current) setNotice(String(e)); });
    return () => { current = false; };
  }, [messageTarget, chat.id, loadedFrom]);
  const historic = earlier && earlier.target === messageTarget ? earlier : undefined;
  useEffect(() => {
    if (!messageTarget) return;
    const frame = requestAnimationFrame(() => {
      const row = document.getElementById(`message-${chat.id}-${messageTarget.index}`);
      if (row) {
        stick.current = false;
        row.scrollIntoView({ block: "center" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [chat.id, messageTarget, historic, loadedFrom]);
  // Opening a row never scrolls; it only decides whether the view still follows.
  const disclosed = () =>
    requestAnimationFrame(() => {
      if (readingBeginning.current) return;
      stick.current = atBottom();
      setAway(!stick.current);
    });
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 2200);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (drawer === "tasks" && !todos.length) setDrawer("");
    if (drawer === "helpers" && !agents.length) setDrawer("");
  }, [drawer, todos.length, agents.length]);

  const quote = quotes[chat.id] || "";
  const setQuote = (q: string) => setQuotes((p) => ({ ...p, [chat.id]: q }));
  const focusComposer = () =>
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>(".composewrap textarea[role=combobox]")?.focus(),
    );
  const act = {
    copy: (m: Message) =>
      void window.botkins
        .copyText(m.text)
        .then(() => setNotice("Copied"))
        .catch((e) => setNotice(e.message)),
    reply: (m: Message) => {
      setQuote(m.text.trim().slice(0, 1200));
      focusComposer();
    },
    fork: (i: number) =>
      void window.botkins
        .forkChat(chat.id, i)
        .then((id) => openChat?.(id))
        .catch((e) => setNotice(e.message)),
  };
  useEffect(() => {
    setShowChanges(false);
    setChoosingProject(false);
  }, [chat.id]);
  // A chat that stays open a moment, or gets the window back, readies its session so the first reply starts sooner.
  useEffect(() => {
    const id = chat.id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const warm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void window.botkins.warmChat(id)?.catch(() => {}), 400);
    };
    warm();
    window.addEventListener("focus", warm);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", warm);
    };
  }, [chat.id]);
  const context = chat.context;
  const percent = context ? Math.min(100, Math.round((context.current / context.limit) * 100)) : 0;
  const [contextOpen, setContextOpen] = useState(false);

  // With "Read replies aloud" on, each new final reply in the open chat is spoken. Interim
  // messages are activity markers, not replies, and must never be read aloud as a finished turn.
  let latestIndex = chat.messages.length - 1;
  while (latestIndex >= 0 && !(chat.messages[latestIndex].role === "assistant" && !chat.messages[latestIndex].interim && chat.messages[latestIndex].text)) latestIndex--;
  const latestReply = chat.messages[latestIndex];
  useReadAloud(
    !!state.settings.readAloud,
    chat.id,
    latestReply && { key: latestIndex + ":" + latestReply.text.length, text: latestReply.text, index: latestIndex, botId: latestReply.botId ?? bot.id },
    !busy,
  );
  // Read aloud and Stop on a reply (src/voice.ts): one thing is read at a time, a reply by its chat and place.
  const reading = useReading();
  const readKey = (i: number) => chat.id + ":" + i;

  function actions(m: Message, i: number) {
    return (
      <div className="msg-actions" role="toolbar" aria-label="Message actions">
        <button aria-label="Copy message" title="Copy" onClick={() => act.copy(m)}>
          <Copy size={14} />
        </button>
        <button aria-label="Reply" title="Reply" onClick={() => act.reply(m)}>
          <Reply size={14} />
        </button>
        {m.role !== "user" && m.text && (
          <button
            aria-label={reading.key === readKey(i) ? "Stop reading" : "Read aloud"}
            title={reading.key === readKey(i) ? "Stop" : "Read aloud"}
            aria-pressed={reading.key === readKey(i)}
            onClick={() => void readAloud(readKey(i), m.text, m.botId ?? bot.id)}
          >
            {reading.key === readKey(i) ? <Square size={13} /> : <Volume2 size={14} />}
          </button>
        )}
        {!group && (
          <button
            aria-label="Fork from here"
            title="Fork from here"
            disabled={busy}
            onClick={() => act.fork(i)}
          >
            <GitFork size={14} />
          </button>
        )}
      </div>
    );
  }

  /* A turn-timeline-v1 run is rendered as one ordered block. Older runs continue through the
     legacy message map below, which keeps old profiles and remote hosts readable. */
  const timelineRunIds = new Set<string>();
  const timelineRendered = new Set<string>();
  // A turn uses one renderer from its first message. This keeps a growing reply anchored while
  // it runs instead of switching from the old trail when a tool first arrives. Group turns use
  // the same block so each member's reply can stay between that turn's activity markers.
  for (const m of chat.messages) {
    const owner = m.runId ?? m.steeredRunId ?? m.answer?.runId;
    if (owner && runs.has(owner)) timelineRunIds.add(owner);
  }
  const timelineBusy = !!latest && latest.status === "Working" && timelineRunIds.has(latest.id);
  const timelineMessage = (m: Message, index: number) => (
    <article
      id={`message-${chat.id}-${loadedFrom + index}`}
      className={messageClass(m)}
      key={`timeline-message-${index}`}
      onContextMenu={(e) => {
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        setMenu({ index, x: e.clientX, y: e.clientY });
      }}
    >
      {m.role === "assistant" ? (
        <b className="speaker">
          <BotAvatar bot={group ? state.bots.find((b) => b.id === m.botId) ?? bot : bot} size={22} />
          <span className="speaker-name">{group ? nameOf(m) : bot.name}</span>
        </b>
      ) : m.role === "user" ? (
        <b className={m.author ? "member-speaker" : "visually-hidden"}>{m.author?.name ?? "You"}</b>
      ) : <b className="command-label">Command output</b>}
      {m.answer && <small className="answer-label">{m.answer.title}</small>}
      {m.quote && <blockquote className="msg-quote">{m.quote}</blockquote>}
      {m.role === "command" && m.plain ? <pre className="command-output">{m.text}</pre> : <RichText text={m.text} files={files} />}
      <Attachments list={m.attachments} />
      {!!m.mentions?.length && (
        <MentionChips
          sent
          list={m.mentions}
          canOpen={(r) => r.kind === "wiki" ? !!openWiki : r.kind === "board" ? !!openToday : r.kind === "project" && !!openProject && !!state.projects?.some((p) => p.id === r.id)}
          open={(r) => { if (r.kind === "project") openProject?.(r.id); else if (r.kind === "wiki") openWiki?.(r.path); else if (r.kind === "board") openToday?.(); }}
        />
      )}
      {m.role === "assistant" && <LinkPreviewCard text={m.text} enabled={!!state.settings.linkPreviews} />}
      {actions(m, index)}
    </article>
  );

  const renderTimeline = (run: NonNullable<typeof latest>) => {
    const related = chat.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.runId === run.id || message.steeredRunId === run.id || message.answer?.runId === run.id);
    const initial = related.find(({ message }) => message.role === "user" && message.runId === run.id && !message.steeredRunId && !message.answer);
    if (!initial) return null;
    const reply = related.filter(({ message }) => message.role === "assistant" && !message.interim);
    const ownSteps = (run.steps ?? []).filter((step) => !step.agentId);
    const showStep = (step: NonNullable<typeof run.steps>[number]) => stepsMode !== "hidden" && (stepsMode !== "failed" || step.status === "Failed");
    type Event = { kind: RunTimelineEvent["kind"]; at: number; order: number; key: string; body: ReactNode; fold: ReactNode; details: ReactNode };
    const events: Event[] = [];
    for (const event of orderedRunEvents(run, chat.messages, { includeReplies: group })) {
      if (event.kind === "interim") {
        if (event.value.text.trim()) {
          events.push({
            kind: event.kind,
            at: event.at,
            order: event.order,
            key: event.key,
            body: <InterimUpdate text={event.value.text} display={thinkingMode} />,
            fold: <InterimUpdate text={event.value.text} display={thinkingMode} />,
            details: <InterimUpdate text={event.value.text} display="open" />,
          });
        }
      } else if (event.kind === "reply") {
        const body = timelineMessage(event.value, event.index);
        events.push({ kind: event.kind, at: event.at, order: event.order, key: event.key, body, fold: null, details: body });
      } else if (event.kind === "person" || event.kind === "command") {
        const marker = <div className="timeline-person">↳ {event.value.answer?.title ? event.value.answer.title + ": " : ""}{event.value.text}</div>;
        events.push({ kind: event.kind, at: event.at, order: event.order, key: event.key, body: timelineMessage(event.value, event.index), fold: marker, details: marker });
      } else if (event.kind === "reasoning") {
        if (event.value.text.trim()) {
          events.push({
            kind: event.kind,
            at: event.at,
            order: event.order,
            key: event.key,
            body: <ReasoningUpdate text={event.value.text} display={thinkingMode} />,
            fold: <ReasoningUpdate text={event.value.text} display={thinkingMode} />,
            details: <ReasoningUpdate text={event.value.text} display="open" />,
          });
        }
      } else {
        const body = <section className="timeline-step"><StepList steps={[event.value]} /></section>;
        events.push({ kind: event.kind, at: event.at, order: event.order, key: event.key, body: showStep(event.value) ? body : null, fold: showStep(event.value) ? body : null, details: body });
      }
    }
    const activityEvents = events.filter((event) => event.kind !== "reply");
    // A turn's work list starts with its helpers, then its to-do list; the steps and the rest follow.
    const lead = <RunLead agents={run.agents} todos={run.todos} />;
    const eventBody = <>{lead}{activityEvents.map((event) => <Fragment key={event.key}>{event.fold}</Fragment>)}</>;
    const detailsBody = <>{lead}{activityEvents.map((event) => <Fragment key={event.key}>{event.details}</Fragment>)}</>;
    // Person messages remain in the transcript even when the bot's work is folded. They are
    // part of the conversation, not activity hidden behind the work summary.
    const personBody = events
      .filter((event) => event.kind === "person" || event.kind === "command")
      .map((event) => <Fragment key={event.key}>{event.body}</Fragment>);
    const live = run.status === "Working";
    const elapsed = (run.finished ?? Date.now()) - run.time;
    const failedSteps = ownSteps.filter((step) => step.status === "Failed").length;
    const count = stepsMode === "failed" ? failedSteps : stepsMode === "hidden" ? 0 : ownSteps.length;
    const endingLabel = run.ending === "timed-out" ? "Timed out" : run.ending === "interrupted" ? "Interrupted" : run.ending === "stopped" ? "Stopped" : run.ending === "failed" ? "Needs you" : "";
    const line = live ? (state.intents[chat.id] || "Working…") : (!reply.length && endingLabel ? endingLabel : `Worked for ${duration(elapsed)}`);
    const countLabel = count ? count + (count === 1 ? " step" : " steps") : undefined;
    const folded = stepsMode !== "every";
    const groupTranscript = group
      ? events.map((event) => {
          const visible = event.kind === "reply" || live || !folded || event.kind === "person" || event.kind === "command";
          return <Fragment key={event.key}>{visible ? event.body : null}</Fragment>;
        })
      : null;
    const currentBot = group ? speaker ?? state.bots.find((b) => b.id === run.speakers?.at(-1)) : bot;
    const groupFailure = group && run.failures?.length
      ? run.failures.map((failure) => `${state.bots.find((b) => b.id === failure.botId)?.name ?? "A bot"}: ${failure.detail}`).join(" · ")
      : "";
    return (
      <Fragment key={`timeline-${run.id}`}>
        {timelineMessage(initial.message, initial.index)}
        {group ? groupTranscript : (live || !folded) ? events.map((event) => <Fragment key={event.key}>{event.body}</Fragment>) : personBody}
        {!group && reply.map(({ message, index }) => timelineMessage(message, index))}
        {live && stream && (
          <article className="assistant live">
            {group && currentBot && (
              <b className="speaker">
                <BotAvatar bot={currentBot} state={botActivity(state, currentBot.id)} size={22} />
                <span className="speaker-name">{currentBot.name}</span>
              </b>
            )}
            <RichText text={stream} files={files} />
          </article>
        )}
        {(live || folded) && (
          <TimelineFold
            line={line}
            live={live}
            body={eventBody}
            detailsBody={detailsBody}
            avatar={live && currentBot ? <BotAvatar bot={currentBot} state={group ? botActivity(state, currentBot.id) : activity} size={22} /> : undefined}
            intent={live ? state.intents[chat.id] : undefined}
            count={countLabel}
            onDetails={() => disclosed()}
          />
        )}
        <TeamRail run={run} bots={state.bots} />
        <RunCards run={run} prefill={prefill} pickModel={canManageAgents ? pickModel : undefined} />
        {!live && (failed.includes(run.status) || !!groupFailure) && (
          <div className="error run-error"><span>{groupFailure || (run.ending === "timed-out" ? "Timed out" : run.status) + " · " + (run.detail || "Reply stopped.")}</span>{!groupFailure && run.id === lastUserRun && !busy && <button className="secondary" onClick={() => void window.botkins.retry(run.id).catch((e) => setNotice(e.message))}><RotateCcw size={13} />Try again</button>}</div>
        )}
      </Fragment>
    );
  };

  return (
    <div className={"conversation" + (paneShown ? " with-side" : "") + (paneShown && narrow ? " with-drawer" : "")}>
      <div className="chat-main">
        {showPeople && peopleView && (
          <PeopleDialog
            state={state}
            chat={chat}
            close={() => setShowPeople(false)}
            left={() => {
              setShowPeople(false);
              back();
            }}
          />
        )}
      <div className="chathead">
        <button className="chathead-back" aria-label="Back to chats" title="Back to chats" onClick={back}>
          <ArrowLeft size={18} />
        </button>
        {group ? (
          <span className="group-avatars" aria-hidden="true">
            {members.map((m) => (
              <BotAvatar key={m.id} bot={m} state={botActivity(state, m.id)} size={28} />
            ))}
          </span>
        ) : (
          <BotAvatar bot={bot} state={face} size={30} />
        )}
        <div className="chathead-title">
          <h2>{group ? chat.title : bot.name}</h2>
          <small className={doing ? "doing" : undefined}>
            {doing ||
              (group
                ? chat.title === members.map((m) => m.name).join(", ")
                  ? "Group chat · " + members.length + " bots"
                  : members.map((m) => m.name).join(", ")
                : bot.role)}
          </small>
        </div>
        <div className="chathead-tools">
          {project && (
            <div className="project-tag">
              <span className="project-label" title={project.folder ?? project.name}>
                {project.folder ? <FolderGit2 size={13} /> : <FolderKanban size={13} />}
                <span>{project.name}</span>
                {project.folder && <em>{modeLabels[mode].label}</em>}
              </span>
              {project.folder && (
                <button
                  className="chathead-icon"
                  aria-label="Changes"
                  title="Changes"
                  aria-pressed={showChanges}
                  onClick={() => setShowChanges((v) => !v)}
                >
                  <FileDiff size={17} />
                </button>
              )}
            </div>
          )}
          {context && context.limit > 0 && (
            <div className="context-meter">
              <button
                className="context-open"
                aria-haspopup="dialog"
                aria-expanded={contextOpen}
                aria-label={"Context window: " + percent + "% used. Show details"}
                title="Context window"
                onClick={() => setContextOpen(!contextOpen)}
              >
                <span className="meter" aria-hidden="true">
                  <i style={{ width: percent + "%" }} className={percent >= 80 ? "high" : ""} />
                </span>
                <small>
                  {percent}%<span className="context-words"> of context</span>
                </small>
              </button>
              {contextOpen && (
                <ContextDetails
                  chat={chat}
                  runs={state.runs.filter((r) => r.chatId === chat.id)}
                  busy={busy}
                  close={() => setContextOpen(false)}
                  compact={() => {
                    setContextOpen(false);
                    void window.botkins.compact(chat.id).catch((e) => setNotice(e.message));
                  }}
                />
              )}
              <button
                className="chathead-icon"
                aria-label="Compact"
                disabled={busy}
                title="Compact: summarize earlier turns to free up context"
                onClick={() => void window.botkins.compact(chat.id).catch((e) => setNotice(e.message))}
              >
                <FoldVertical size={17} />
              </button>
            </div>
          )}
          {!group && canManageAgents && (
            <button
              className="chat-model"
              aria-label={"Model: " + modelLabel(model, models, defaultProvider) + ". Change model and thinking"}
              title="Model and thinking"
              onClick={pickModel}
            >
              <ModelBadge choice={model} models={models} />
            </button>
          )}
          {peopleView && (
            <button className="chathead-icon chat-invite" aria-label="Invite" title="Invite" aria-haspopup="dialog" onClick={() => setShowPeople(true)}>
              <UserPlus size={17} />
            </button>
          )}
          {canManageAgents && (
            <button className="chathead-icon bot-settings" aria-label="Bot settings" title="Bot settings" onClick={botSettings}>
              <SlidersHorizontal size={17} />
            </button>
          )}
          {paneAllowed && (
            <button
              ref={detailsButton}
              className={"chathead-icon chathead-details" + (panels.length ? " has-panels" : "")}
              aria-label={group ? "Side pane" : "Details"}
              title={(paneShown ? "Hide " : "Show ") + (panels.length ? "side pane" : "details")}
              aria-pressed={paneShown}
              aria-description={unseen ? "Something new" : undefined}
              onClick={toggleSide}
            >
              <PanelRight size={17} />
              {unseen && <i className="pane-dot" aria-hidden="true" />}
            </button>
          )}
        </div>
      </div>
      <div className="messages-wrap">
        <div
          className="messages"
          ref={scroller}
          onScroll={() => {
            if (readingBeginning.current) return;
            const bottom = atBottom();
            if (gliding.current) {
              if (bottom) gliding.current = false;
              return;
            }
            stick.current = bottom;
            if (!bottom && busy && latest && onScreen) completions.readerMoved(chat.id, latest.id);
            if (bottom === away) setAway(!bottom);
          }}
          onScrollEnd={() => {
            // A glide that ended short of the end (the reply grew meanwhile) finishes at once.
            if (gliding.current && !atBottom()) toBottom();
            gliding.current = false;
          }}
          onWheel={stopGlide}
          onPointerDown={stopGlide}
          onKeyDown={stopGlide}
        >
          <div className="chat-column">
          {chat.messages.length === 0 && group && (
            <div className="emptychat group-empty">
              <span className="group-avatars large" aria-hidden="true">
                {members.map((m) => (
                  <BotAvatar key={m.id} bot={m} size={80} />
                ))}
              </span>
              <h2>Start the group chat</h2>
              <p>
                {members.map((m) => m.name).join(", ")} answer in turn. Type @ to ask one bot, or @everyone.
              </p>
            </div>
          )}
          {chat.messages.length === 0 && !group && (
            <div className="emptychat">
              <BotAvatar bot={bot} state={face} size={136} animated />
              <h2>What can {bot.name} help with?</h2>
              <p>{bot.role}</p>
              <div className="starters">
                {starters(bot).map((s) => (
                  <button key={s} onClick={() => prefill(s)}>
                    {s}
                  </button>
                ))}
              </div>
              {!started &&
                (project || choosingProject ? (
                  <div className="empty-project">
                    <ProjectPicker
                      state={state}
                      botIds={chat.botIds?.length ? chat.botIds : [chat.botId]}
                      projectId={chat.projectId}
                      mode={mode}
                      change={(projectId, next) =>
                        void window.botkins
                          .setChatProject(chat.id, projectId ?? null, next)
                          .catch((e) => setNotice(e.message))
                      }
                      fail={(e) => setNotice(e instanceof Error ? e.message : String(e))}
                    />
                  </div>
                ) : (
                  <button className="textbutton empty-project-open" onClick={() => setChoosingProject(true)}>
                    <FolderKanban size={15} /> Work in a project…
                  </button>
                ))}
            </div>
          )}
          {chat.forkedFrom && chat.messages.length > 0 && (
            <p className="fork-note">
              <GitFork size={13} /> Forked from an earlier chat
            </p>
          )}
          {historic && historic.messages.map((message, i) => historic.from + i < loadedFrom && (
            <article key={historic.from + i} id={`message-${chat.id}-${historic.from + i}`} className={messageClass(message)}>
              {message.author && <b className="member-speaker">{message.author.name}</b>}
              <RichText text={message.text} files={files} />
              <Attachments list={message.attachments} />
            </article>
          ))}
          {chat.messages.map((m, i) => {
            const run = m.runId ? runs.get(m.runId) : undefined;
            const timelineOwner = m.runId ?? m.steeredRunId ?? m.answer?.runId;
            if (timelineOwner && timelineRunIds.has(timelineOwner)) {
              if (m.role === "user" && m.runId === timelineOwner && !m.steeredRunId && !m.answer && run) {
                // A paginated/remote chat can contain a reply without the opening user message.
                // Only claim the run after the timeline renderer found its anchor; otherwise let
                // the legacy map render the partial page instead of dropping it.
                const rendered = renderTimeline(run);
                if (rendered) {
                  timelineRendered.add(timelineOwner);
                  return rendered;
                }
              }
              if (timelineRendered.has(timelineOwner)) return null;
            }
            return (
              <Fragment key={i}>
                {(m.text || m.role !== "assistant") && (
                  <article
                    id={`message-${chat.id}-${loadedFrom + i}`}
                    className={messageClass(m)}
                    onContextMenu={(e) => {
                      if (window.getSelection()?.toString()) return;
                      e.preventDefault();
                      setMenu({ index: i, x: e.clientX, y: e.clientY });
                    }}
                  >
                    {m.interim ? (
                      <InterimUpdate text={m.text} onToggle={disclosed} />
                    ) : m.role === "assistant" ? (
                      // Consecutive replies from one bot share its label: only the first of a run shows it.
                      !(chat.messages[i - 1]?.role === "assistant" && chat.messages[i - 1].text && chat.messages[i - 1].botId === m.botId) && (
                        <b className="speaker">
                          {(() => {
                            const who = group ? state.bots.find((b) => b.id === m.botId) : bot;
                            return who && <BotAvatar bot={who} size={22} />;
                          })()}
                          <span className="speaker-name">{group ? nameOf(m) : bot.name}</span>
                        </b>
                      )
                    ) : m.role === "user" ? (
                      <b className={m.author ? "member-speaker" : "visually-hidden"}>{m.author?.name ?? "You"}</b>
                    ) : (
                      <b className="command-label">Command output</b>
                    )}
                    {!m.interim && <>
                      {m.quote && <blockquote className="msg-quote">{m.quote}</blockquote>}
                      {m.role === "command" && m.plain ? (
                        <pre className="command-output">{m.text}</pre>
                      ) : (
                        <RichText text={m.text} files={files} />
                      )}
                      <Attachments list={m.attachments} />
                    {!!m.mentions?.length && (
                      <MentionChips
                        sent
                        list={m.mentions}
                        canOpen={(r) =>
                          r.kind === "wiki"
                            ? !!openWiki
                            : r.kind === "board"
                              ? !!openToday
                              : r.kind === "project" && !!openProject && !!state.projects?.some((p) => p.id === r.id)
                        }
                        open={(r) => {
                          if (r.kind === "project") openProject?.(r.id);
                          else if (r.kind === "wiki") openWiki?.(r.path);
                          else if (r.kind === "board") openToday?.();
                        }}
                      />
                    )}
                      {m.role === "assistant" && <LinkPreviewCard text={m.text} enabled={!!state.settings.linkPreviews} />}
                      {actions(m, i)}
                    </>}
                  </article>
                )}
                {m.role === "user" && run && (
                  <>
                    {thinkingMode !== "hidden" && (
                      <Reasoning
                        run={run}
                        live={run.status === "Working" ? thinking : undefined}
                        display={thinkingMode}
                        onToggle={disclosed}
                      />
                    )}
                    <ToolTrail
                      run={run}
                      fold={stepsMode === "folded"}
                      mode={stepsMode}
                      intent={state.intents[chat.id]}
                      bot={group ? (run.status === "Working" && speaker ? speaker.name : "The group") : bot.name}
                      avatar={
                        run.status === "Working" && (group ? speaker : bot) ? (
                          <BotAvatar bot={group ? speaker : bot} state={group ? botActivity(state, speaker!.id) : activity} size={22} />
                        ) : undefined
                      }
                      onToggle={disclosed}
                    />
                    <TeamRail run={run} bots={state.bots} />
                    <RunCards run={run} prefill={prefill} pickModel={canManageAgents ? pickModel : undefined} />
                    {failed.includes(run.status) && (
                      <div className="error run-error">
                        <span>
                          {run.status} · {run.detail || "Reply stopped."}
                        </span>
                        {run.id === lastUserRun && !busy && (
                          <button
                            className="secondary"
                            onClick={() => void window.botkins.retry(run.id).catch((e) => setNotice(e.message))}
                          >
                            <RotateCcw size={13} />
                            Try again
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </Fragment>
            );
          })}
          {busy && !timelineBusy && group && (
            <article className="assistant live">
              {speaker && (
                <b className="speaker">
                  <BotAvatar bot={speaker} state={botActivity(state, speaker.id)} size={22} />
                  <span className="speaker-name">{speaker.name}</span>
                </b>
              )}
              {stream ? (
                <RichText text={stream} files={files} />
              ) : (
                <p className="typing" role="status">
                  {requests.length ? "Waiting for your response…" : (speaker?.name ?? "The group") + " is typing…"}
                </p>
              )}
            </article>
          )}
          {busy && !timelineBusy && !group && (
            <article className="assistant live">
              {!(chat.messages.at(-1)?.role === "assistant" && chat.messages.at(-1)?.text) && (
                <b className="speaker">
                  <BotAvatar bot={bot} state={activity} size={22} />
                  <span className="speaker-name">{bot.name}</span>
                </b>
              )}
              {stream ? (
                <RichText text={stream} files={files} />
              ) : (
                <p className="typing" role="status">
                  {requests.length ? "Waiting for your response…" : state.intents[chat.id] || "Working…"}
                </p>
              )}
            </article>
          )}
          {queued.length > 0 && (
            <section className="queued" aria-label="Queued messages">
              {queued.map((q) => (
                <div className="queued-row" key={q.id}>
                  <Clock size={14} />
                  <span className="queued-text">
                    <small>Queued</small>
                    {q.text}
                    {!!q.attachments?.length && (
                      <small>
                        {" "}
                        · {q.attachments.length} {q.attachments.length === 1 ? "attachment" : "attachments"}
                      </small>
                    )}
                  </span>
                  <button
                    className="secondary"
                    onClick={() => void window.botkins.sendNow(chat.id, q.id).catch((e) => setNotice(e.message))}
                  >
                    {state.steerable?.[chat.id] ? "Steer now" : "Send next"}
                  </button>
                  <button
                    aria-label="Remove queued message"
                    onClick={() => void window.botkins.unqueue(chat.id, q.id).catch((e) => setNotice(e.message))}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </section>
          )}
          </div>
        </div>
        {/* Always there, so it can fade in and out; hidden, it is out of the tab order and out of reach. */}
        <button
          className={"to-latest" + (away ? " shown" : "")}
          aria-label="Scroll to latest message"
          title="Scroll to latest message"
          aria-hidden={!away}
          tabIndex={away ? 0 : -1}
          onClick={(e) => {
            glideToBottom();
            // From the keyboard, focus moves on to the composer, since the button hides.
            if (e.detail === 0) document.querySelector<HTMLElement>(".composewrap textarea")?.focus();
          }}
        >
          <ArrowDown size={18} strokeWidth={2.25} aria-hidden="true" />
        </button>
        {notice && (
          <div className="canvas-notice" role="status">
            {notice}
          </div>
        )}
      </div>
      {menu && chat.messages[menu.index] && (
        <div
          className="msg-menu"
          role="menu"
          style={{ left: Math.min(menu.x, innerWidth - 190), top: Math.min(menu.y, innerHeight - 130) }}
        >
          <button role="menuitem" onClick={() => act.copy(chat.messages[menu.index])}>
            <Copy size={14} /> Copy
          </button>
          <button role="menuitem" onClick={() => act.reply(chat.messages[menu.index])}>
            <Reply size={14} /> Reply
          </button>
          {chat.messages[menu.index].role !== "user" && (
            <button role="menuitem" onClick={() => void readAloud(readKey(menu.index), chat.messages[menu.index].text, chat.messages[menu.index].botId ?? bot.id)}>
              {reading.key === readKey(menu.index) ? (
                <>
                  <Square size={13} /> Stop reading
                </>
              ) : (
                <>
                  <Volume2 size={14} /> Read aloud
                </>
              )}
            </button>
          )}
          {!group && (
            <button role="menuitem" disabled={busy} onClick={() => act.fork(menu.index)}>
              <GitFork size={14} /> Fork from here
            </button>
          )}
        </div>
      )}
      <div className="composewrap">
        {reading.error && (
          <div className="voice-strip note error" role="alert">
            <span>Couldn't read that aloud. {reading.error}</span>
            <span className="voice-actions">
              <button type="button" className="set-button" onClick={clearReadingError}>
                Close
              </button>
            </span>
          </div>
        )}
        {(todos.length > 0 || agents.length > 0) && (
          <>
            <div className="canvas-chips">
              {/* Helpers first, then the to-do list: the owner's order (2026-11-20), as in a turn's work list. */}
              {agents.length > 0 && (
                <HelperChip
                  agents={agents}
                  open={drawer === "helpers"}
                  toggle={() => setDrawer(drawer === "helpers" ? "" : "helpers")}
                />
              )}
              {todos.length > 0 && (
                <TaskChip todos={todos} open={drawer === "tasks"} toggle={() => setDrawer(drawer === "tasks" ? "" : "tasks")} />
              )}
            </div>
            {drawer === "helpers" && <HelperDrawer agents={agents} />}
            {drawer === "tasks" && <TaskDrawer todos={todos} />}
          </>
        )}
        {blocked.length > 0 && project && (
          <div className="access-blocked" role="alert">
            <ShieldAlert size={16} />
            <span>
              {blocked.map((b) => b.name).join(", ")} {blocked.length === 1 ? "doesn't" : "don't"} have access to the project “{project.name}”, so
              this chat can't take new messages. Nothing was deleted. Grant access on the bot's page, or turn on access for all bots in Settings › Access.
            </span>
          </div>
        )}
        {project?.folder && showChanges && (
          <ProjectChanges key={project.id} state={state} projectId={project.id} close={() => setShowChanges(false)} />
        )}
        {requests[0] && (
          <RequestPanel
            key={requests[0].id}
            req={requests[0]}
            count={requests.length}
            bot={state.bots.find((b) => b.id === requests[0].botId)?.name ?? bot.name}
          />
        )}
        {side && (
          <section className="side-answer" aria-label="Side answer">
            <div>
              <strong>Side question</strong>
              <button aria-label="Dismiss side answer" onClick={dismissSide}>
                <X size={15} />
              </button>
            </div>
            <small>{side.question}</small>
            <RichText text={side.answer || side.error || "Asking the model…"} />
          </section>
        )}
        <QuoteContext.Provider value={{ quote, setQuote }}>{composer}</QuoteContext.Provider>
      </div>
      </div>
      {paneShown && narrow && <div className="pane-scrim" aria-hidden="true" onClick={closePane} />}
      {paneShown && (
        <SidePane key={chat.id} preview={preview?.chatId === chat.id ? preview : undefined} state={state} chat={chat} bot={bot} face={face} group={group} drawer={narrow} close={closePane} openRoutines={openRoutines} openBot={openBot} openChat={openChat} />
      )}
    </div>
  );
}
