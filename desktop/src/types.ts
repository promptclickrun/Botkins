export type Bot = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  clarificationInstructions?: string;
  /** The Botkin this bot is drawn as (src/botkins.ts). Every bot has one; phones show the same. */
  look?: BotLook;
  model?: ModelChoice;
  /** Skills (by name) and MCP servers (by id) from Settings that this bot leaves out. */
  skillsOff?: string[];
  mcpOff?: string[];
  /** false keeps this bot out of Teamwork: it neither asks teammates nor is asked. */
  teamwork?: boolean;
  /** From earlier versions (a Lottie face and a silhouette). Still in the file; nothing draws them. */
  face?: string;
  avatar?: unknown;
  /** A short "About" line shown on the bot page. */
  summary?: string;
  pinned?: boolean;
  hidden?: boolean;
  sectionId?: string | null;
  /** The projects this bot may use when Settings › Access isn't global (desktop/access.mjs). */
  access?: BotAccessGrant;
  /** The existing agent this bot was made from (ImportableAgent). The bot is a copy of it. */
  origin?: { provider: string; agent: string; file?: string };
};
/**
 * An agent the person already has with a model provider (for Copilot, ~/.copilot/agents), as the
 * bot Botkins would make of it.
 */
export type ImportableAgent = {
  key: string;
  provider: string;
  providerName: string;
  /** The agent's own name, such as "backend-development". */
  agent: string;
  name: string;
  role: string;
  summary: string;
  instructions: string;
  model?: ModelChoice;
  modelName?: string;
  /** The model the agent names when this account doesn't have it. The bot then uses the default model. */
  missingModel?: string;
  file?: string;
  /** The agent names its own tools or MCP servers; the bot uses Botkins' settings instead. */
  ownTools: boolean;
  /** A bot was already made of this agent. */
  added: boolean;
  /** Why this agent can't become a bot. */
  problem?: string;
};
/** One of the design kit's 20 characters in one of its 7 palettes, by id: { head: "sprig", palette: "original" }. */
/** A bot's eyes at rest. "oval" is each character's own and is not saved. */
export type LookEyes = "oval" | "button" | "smile" | "sleepy" | "wink" | "curious";
/**
 * A bot's look: a character in a kit palette, or in "custom" colors [shell, accent, faceplate,
 * eyes] ("#rrggbb"), with its eyes (desktop/looks.mjs).
 */
export type BotLook = { head: string; palette: string; eyes?: LookEyes; colors?: [string, string, string, string] };
export type Section = { id: string; name: string };
export type Attachment = {
  name: string;
  path: string;
  kind?: "file" | "directory";
};
export type ArtifactKind = "folder" | "file" | "image" | "audio" | "video";
export type ArtifactSource = "tool" | "media" | "upload" | "export";
export type Artifact = {
  id: string;
  botId: string;
  chatId?: string;
  chatTitle?: string;
  messageIndex?: number;
  path: string;
  name: string;
  kind: ArtifactKind;
  mime: string;
  size: number | null;
  time: number;
  source: ArtifactSource;
};
/** A record named in a message with "#" (a project, a wiki page, or a file in the bot's workspace). */
export type Mention =
  | { kind: "project"; id: string; label: string }
  /** `path` is a file's full path, or a wiki page's path inside the wiki, such as "projects/website.md". */
  | { kind: "file" | "wiki"; path: string; label: string }
  /** An item from Today being discussed. The message keeps its text, so its card shows after the item is cleared. */
  | { kind: "board"; id: string; label: string; board?: "feed" | "idea" | "goal"; body?: string; links?: { url: string; title?: string }[] }
  /** Only in messages saved by an earlier version. It shows as a plain label and does nothing. */
  | { kind: "customer"; id: string; label: string };
/** What the composer sends for a mention; the main process checks it and fills in the label. */
export type MentionInput = { kind: "project" | "board"; id: string } | { kind: "file" | "wiki"; path: string };
export type Message = {
  role: "assistant" | "user" | "command";
  text: string;
  interim?: boolean;
  steeredRunId?: string;
  answer?: { runId: string; requestId: string; kind: string; title: string };
  /** Records the person mentioned in this message, for display. */
  mentions?: Mention[];
  plain?: boolean;
  runId?: string;
  time?: number;
  attachments?: Attachment[];
  /** The quoted text a user reply answers. */
  quote?: string;
  /** In a group chat, the bot that wrote this reply. */
  botId?: string;
  /** A team member's stamped identity. The original displayed text is unchanged. */
  author?: { memberId: string; name: string };
};
export type Chat = {
  /** Latest message count advertised by a paired computer, even before its chat page arrives. */
  count?: number;
  loaded?: { from: number; total: number } | null;
  id: string;
  /** Set on a group chat: its 2 to 6 members, in answer order. `botId` is the first. */
  botIds?: string[];
  /** Per group member: the message index it has read up to, and whether its session exists. */
  members?: Record<string, { seen: number; established: boolean }>;
  botId: string;
  /** The member who created this chat, when it did not come from the owner. */
  createdBy?: string;
  /** From another computer in use: the people invited into this chat ("owner" or a member's id). The window asks its own computer with chatPeople(). */
  invited?: string[];
  /** The project folder this chat works in, and how freely its bot acts there. */
  projectId?: string;
  mode?: ChatMode;
  panelId?: string;
  title: string;
  time: number;
  model?: ModelChoice;
  messages: Message[];
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  /** Set on a chat made by Fork from here. */
  forkedFrom?: { chatId: string; messageIndex: number };
  /** The last known context-window use, from session.usage_info. */
  context?: { current: number; limit: number; system?: number; tools?: number; conversation?: number; messages?: number; updatedAt?: number };
  /** The latest task list from session.todos_changed, kept after the turn. */
  todos?: Todo[];
  schedules?: ChatSchedule[];
  lastScheduleId?: number;
  /** The side pane a bot opened beside this chat (docs/SIDE_PANE.md). */
  pane?: {
    /** The tabs, oldest first. At most 8. */
    panels: PanePanel[];
    /** The id of the tab in front, or null for the chat's own Details. */
    active: string | null;
    /** The latest time a bot asked something of the pane. */
    ask?: { seq: number; panelId?: string | null; close?: true; runId: string; botId: string; at: number };
    /** The person closed the pane (runId: the turn that was running, if any). */
    closed?: { runId: string | null; at: number };
  };
};
/** One tab of a chat's side pane, opened by a bot (docs/SIDE_PANE.md). */
export type PanePanel = {
  id: string;
  kind: "rich_ui" | "table" | "web" | "screen";
  title: string;
  /** The bot that opened it. */
  botId: string;
  createdAt: number;
  updatedAt: number;
  pinned?: true;
  /** Added while the person couldn't see it. */
  unseen?: true;
  /** rich_ui: the id of the stored page. */
  frame?: string;
  columns?: string[];
  rows?: string[][];
  /** web: an http or https address. */
  url?: string;
};
export type Run = {
  ending?: "failed" | "timed-out" | "interrupted" | "stopped";
  id: string;
  /** HTML apps the bot showed in this turn. */
  apps?: AppCard[];
  chatId: string;
  title: string;
  time: number;
  status: string;
  detail: string;
  model?: ModelChoice;
  usedTools?: string[];
  steps?: Step[];
  cards?: Card[];
  openModel?: boolean;
  options?: { label: string; prompt: string; description?: string }[];
  skill?: string;
  panelId?: string;
  trigger?: "manual" | "scheduled";
  reasoning?: Reasoning[];
  todos?: Todo[];
  agents?: Subagent[];
  usage?: Usage;
  /** The chat schedule or routine entry that started this run. */
  scheduleId?: number;
  /** A routine completed without publishing a reply (explicitly quiet or no provider text). */
  noOutput?: boolean;
  /** When the turn ended. */
  finished?: number;
  /** Plain-language work summary, e.g. "Ran 3 commands, read 2 files". */
  summary?: string;
  /** In a group chat: who was asked to answer, and members that failed. */
  speakers?: string[];
  failures?: { botId: string; detail: string }[];
  /** Teammates the bot asked for help during this turn, in order (desktop/teamwork.mjs). */
  teamwork?: TeamAsk[];
};
/** One request from a bot to a teammate, and what came of it. */
export type TeamAsk = {
  id: string;
  /** The teammate that was asked. */
  botId: string;
  /** The bot that asked. */
  fromBotId: string;
  message: string;
  expecting?: string;
  /** waiting: queued behind another ask to the same teammate. working: the teammate is on it. */
  status: "waiting" | "working" | "answered" | "failed" | "stopped";
  started: number;
  finished?: number;
  reply?: string;
  error?: string;
  /** What the teammate is doing right now, while working. */
  intent?: string;
  /** The tools the teammate used. */
  steps?: Step[];
  usedTools?: string[];
};
export type Reasoning = {
  id: string;
  text: string;
  started: number;
  finished?: number;
  /** In a group chat, the member that thought this. */
  botId?: string;
};
export type Todo = {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done" | "blocked" | "cancelled";
  dependsOn?: string[];
};
export type Subagent = {
  prompt?: string;
  intent?: string;
  result?: string;
  id: string;
  name: string;
  description?: string;
  /** Stopped: the reply ended while the helper still ran. */
  status: "Running" | "Done" | "Failed" | "Stopped";
  started: number;
  finished?: number;
  detail?: string;
};
export type Usage = {
  input: number;
  output: number;
  cacheRead?: number;
  cost?: number;
  model?: string;
  durationMs?: number;
};
/** Another computer's Botkins this app is paired to (desktop/remotehosts.mjs). Nothing of its credential is here. */
export type RemoteHost = {
  id: string;
  name: string;
  addedAt: number;
  /** The one the window shows now. */
  current: boolean;
  state?: "idle" | "connecting" | "online" | "offline" | "revoked";
  route?: "direct" | "relay" | null;
  version?: string;
  capabilities?: string[];
  member?: true;
  /** The team this host's member pairing belongs to. */
  team?: string;
};
export type TeamScope = "agents" | "today" | "skills" | "mcp" | "plugins" | "settings";
export type TeamRole = {
  id: string;
  name: string;
  perms: Record<TeamScope, string[]>;
  bots: "all" | string[];
};
export type TeamGroup = { id: string; name: string; roleId: string };
export type TeamDevice = { id: string; name: string; kind: string; platform: string; connected: boolean };
export type TeamMember = { id: string; name: string; groupId: string; joinedAt: number; deviceIds: string[]; devices: TeamDevice[] };
export type TeamInvite = {
  id: string;
  code: string;
  groupId: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  uses: number;
  revoked?: true;
  published?: boolean;
  link: string;
};
export type TeamRequest = { id: string; name: string; person?: string; platform: string; kind: string; at: number; inviteId: string };
/** Someone who can be in a chat: the computer's owner (id "owner") or a team member. */
export type TeamPerson = { id: string; name: string };
export type OwnerTeam = { name: string; roles: TeamRole[]; groups: TeamGroup[]; members: TeamMember[]; invites: TeamInvite[]; requests: TeamRequest[]; /** With "team-people-v1": the owner first, then each member. */ people?: TeamPerson[] };
export type MemberTeam = {
  me: {
    memberId: string;
    name: string;
    group: { id: string; name: string };
    role: { name: string; perms: Record<TeamScope, string[]>; bots: "all" | string[] };
  };
  team: { name: string };
  people?: TeamPerson[];
};
export type TeamJoinTarget = { code: string; serverId: string; serverKey: string; name: string; hosts: string[]; room?: string; relayBase?: string };
export type TeamJoinState = { id: string; team: string; status: "pending" | "approved" | "denied" | "closed" | "offline"; createdAt?: number; requestId?: string };
export type State = {
  /** Which computer's workspace this is: null for this one, else the paired computer in use. */
  remote?: {
    using: { id: string; name: string; state: "idle" | "connecting" | "online" | "offline" | "revoked"; route: "direct" | "relay" | null; version: string | null; capabilities: string[]; member?: true; team?: string } | null;
    hosts: RemoteHost[];
  };
  bots: Bot[];
  /** Full team management data for this computer's owner, or this member's filtered identity. */
  team?: OwnerTeam | MemberTeam;
  chats: Chat[];
  runs: Run[];
  panels: Panel[];
  streams: Record<string, string>;
  intents: Record<string, string>;
  settings: Preferences;
  requests: AgentRequest[];
  sections: Section[];
  /** Bot templates the person saved or imported. */
  templates?: BotTemplate[];
  /** Feed posts, ideas and goals that bots publish to Today. */
  board?: BoardItem[];
  /** The Kanban board of work for bots. */
  tasks?: BotTask[];
  /** Project workspaces. One with a folder is also a coding project. */
  projects?: Project[];
  /** MCP servers every bot can use (Settings › MCP servers). Secret values never reach the page. */
  mcpServers?: McpServer[];
  /** Goes up whenever the wiki changes; read the wiki itself with wikiTree() and wikiPage(). */
  wiki?: { revision: number };
  /** Goes up when a model provider's status or models may have changed (ask providers() and models() again). */
  providers?: { revision: number };
  /** Goes up when indexed files, uploads or exports change. */
  artifacts?: { revision: number };
  /** Goes up when a phone pairs, connects or is removed (ask phoneLink() again). */
  phones?: { revision: number };
  /** False where iMessage and Mail tools can't exist (anything but a Mac). The choice itself is settings.macTools. */
  macTools?: { available: boolean };
  /** Linked skill folders, plugin folders and the names of skills that are switched off (Settings › Skills). */
  skills?: { folders: { id: string; path: string }[]; plugins: { id: string; path: string }[]; disabled: string[] };
  /** Plugins installed on this computer (`plugins-v1`). Secret settings only say whether they are set. */
  plugins?: InstalledPlugin[];
  /** Live reasoning text per chat while a turn runs. */
  thinking: Record<string, string>;
  /** Messages waiting to reach a busy chat, per chat. */
  steerable?: Record<string, boolean>;
  queued: Record<string, QueuedMessage[]>;
  /** In a group chat, the member replying right now. */
  speakers?: Record<string, string>;
};
export type QueuedMessage = {
  id: string;
  text: string;
  attachments?: Attachment[];
};
export type ChatSchedule = {
  id: number;
  prompt: string;
  /** null once a one-time routine has run. */
  nextAt: number | null;
  recurring: boolean;
  intervalMs?: number;
  cron?: string;
  timezone?: string;
  /** false while paused. */
  enabled?: boolean;
  /** Set on routines: named scheduled tasks in their own "Routine · <name>" chat (desktop/routines.mjs). */
  routine?: boolean;
  /** Where a routine's result goes besides its own chat. Missing means its own chat. */
  deliver?: RoutineDelivery;
  /** false when the routine runs quietly: no notification when a run finishes. Left out when it notifies. */
  notify?: boolean;
  /** On a routine a team member made: that member's id. Its turns run under their limits. Left out for the owner's. */
  createdBy?: string;
  name?: string;
  cadence?: Cadence;
  createdAt?: number;
  finishedAt?: number;
};
export type Cadence =
  | { kind: "once"; date: string; time: string }
  | { kind: "daily" | "weekdays"; time: string }
  | { kind: "weekly"; time: string; days: number[] }
  | { kind: "custom"; cron: string };
/** Where a routine's finished reply is sent. Missing still means the historical routine chat. */
export type RoutineDelivery = {
  to: "none" | "routine" | "chat" | "feed" | "idea" | "goal";
  /** With to "chat": a chat of the bot. Without it, the bot's latest chat. */
  chatId?: string;
  /** With to "goal": one of the goal categories. */
  category?: string;
};
export type RoutineInput = {
  botId: string;
  name: string;
  prompt: string;
  cadence: Cadence;
  timezone?: string;
  /** Leave out or null for the routine's own chat (on an edit, null clears a destination). */
  deliver?: RoutineDelivery | null;
  /** false to run quietly, with no notification when a run finishes. Left out, it notifies. */
  notify?: boolean;
};
export type UsageTotals = {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
  /** Turns that reported a cost. */
  priced: number;
};
export type UsageReport = {
  days: number;
  totals: UsageTotals;
  byDay: (UsageTotals & { date: string })[];
  /** `provider` is the model's provider id, for turns made since a run records it. */
  byModel: (UsageTotals & { model: string; provider?: string })[];
  byBot: (UsageTotals & { botId: string; name: string })[];
};
/** One limit of a provider's plan, as the provider stated it (docs/PROVIDER_USAGE.md). */
export type ProviderLimit = {
  /** Stable: "weekly", "session", "premium", "weekly-fable", … */
  id: string;
  /** As shown: "Weekly", "5-hour session", "Premium requests". */
  label: string;
  /** 0 to 100. Absent when the provider doesn't say; never a guess. */
  percentRemaining?: number;
  percentUsed?: number;
  /** When the limit starts again (ms since 1970), when the provider gives it and it lies ahead. */
  resetAt?: number;
  /** The one limit shown under the provider in the model picker. */
  primary?: boolean;
  window?: "session" | "week" | "month";
  /** Set when the limit counts one model only. */
  model?: string;
  /** The counts behind the percent, where the provider gives them. */
  used?: number;
  limit?: number;
  unit?: "requests" | "credits";
  /** The provider says this allowance has no limit: no percent, no bar. */
  unlimited?: boolean;
};
/** A connected provider's plan and what is left of its limits (docs/PROVIDER_USAGE.md). */
export type ProviderUsage = {
  provider: string;
  name: string;
  /** "Claude Max 20x", "ChatGPT Pro". Absent when the provider doesn't say. */
  plan?: string;
  /** An API-key account is billed by use and has no plan limits. */
  account?: "subscription" | "api-key";
  limits: ProviderLimit[];
  /** A bought balance, where the provider has one. */
  credits?: { label: string; amount: number; unit: string };
  /** One plain sentence when there is nothing to show and it is not an error. */
  note?: string;
  /** Whose tool said it: "Claude Code", "Codex", "GitHub Copilot". */
  source?: string;
  /** When these numbers were read from the provider (ms since 1970). */
  updatedAt?: number;
  /** One plain sentence when the last read failed; the limits are then the last known ones. */
  error?: string;
};
export type NotificationSettings = {
  replies: boolean;
  routines: boolean;
  requests: boolean;
  quietHours: { enabled: boolean; from: string; to: string };
};

declare global {
  interface Window {
    /** The same bridge under the app's earlier name. Still there, so nothing that says it breaks. */
    commander: Window["botkins"];
    /** The app, as its page reaches it (desktop/preload.cjs). */
    botkins: {
      snapshot(): Promise<State>;
      models(): Promise<ModelInfo[]>;
      setModel(
        scope: "global" | "bot" | "chat",
        id: string | null,
        value: ModelChoice | null,
      ): Promise<void>;
      setPreferences(
        patch: Partial<Omit<Preferences, "model" | "appearance">> & {
          appearance?: Partial<Appearance>;
        },
      ): Promise<void>;
      sideQuestion(id: string, question: string): Promise<string>;
      respond(
        id: string,
        answer: {
          action: string;
          /** A saved credential's reference instead of text: the computer puts the value in. */
          value?: string | CredentialRef;
          content?: Record<string, unknown>;
        },
      ): Promise<void>;
      clearApprovals(chatId?: string): Promise<void>;
      copyReply(chatId: string): Promise<void>;
      subscribe(fn: (state: State) => void): () => void;
      addBot(
        bot: Pick<Bot, "name" | "role" | "instructions"> &
          Partial<Pick<Bot, "look" | "summary">> & {
            /** The key of the existing agent the form started from. */
            agent?: string;
          },
      ): Promise<string>;
      /** The person's existing agents that can become bots. */
      importableAgents(): Promise<ImportableAgent[]>;
      /** Makes a bot of each agent, in the order given. Returns the new bots' ids. */
      importAgents(keys: string[]): Promise<string[]>;
      openLink(url: string): Promise<void>;
      "artifacts.list": (input: { botId: string; chatId?: string; kind?: "files" | "media"; folder?: string; cursor?: string }) => Promise<{ items: Artifact[]; nextCursor: string | null }>;
      "artifacts.read": (idOrPath: string, options?: { offset?: number; length?: number }) => Promise<{ artifact: Artifact; data: string; encoding: "base64"; offset: number; nextOffset: number | null }>;
      "artifacts.thumbnail": (id: string, options?: { size?: number }) => Promise<{ data: string; mime: string } | null>;
      "artifacts.resolve": (input: { chatId: string; paths: string[] }) => Promise<{ items: (Artifact | null)[] }>;
      inspectChatPaths(paths: string[]): Promise<({ path: string; kind: ArtifactKind; name: string; mime: string; size: number | null } | null)[]>;
      openChatPath(path: string, action: "open" | "reveal"): Promise<void>;
      artifactMessagePage(chatId: string, index: number): Promise<{ from: number; messages: Message[] } | null>;
      thumbnailChatPath(path: string, size?: number): Promise<{ data: string; mime: string } | null>;
      artifactMedia(id: string, localPath?: string): Promise<string>;
      closeArtifactMedia(url: string): Promise<void>;
      previewChatPath(path: string, options?: { offset?: number; length?: number }): Promise<{ artifact: Artifact; data: string; encoding: "base64"; offset: number; nextOffset: number | null }>;
      updateBot(
        id: string,
        data: Partial<
          Pick<
            Bot,
            | "role"
            | "instructions"
            | "name"
            | "clarificationInstructions"
            | "summary"
            | "look"
          >
        >,
      ): Promise<void>;
      // Agent management
      setBotFlags(
        id: string,
        patch: Partial<Pick<Bot, "pinned" | "hidden" | "sectionId" | "teamwork">>,
      ): Promise<void>;
      makePrimary(id: string): Promise<void>;
      reorderBots(ids: string[]): Promise<void>;
      duplicateBot(id: string): Promise<string>;
      deleteBot(id: string): Promise<void>;
      // Bot templates
      saveTemplate(botId: string, name?: string): Promise<string>;
      renameTemplate(id: string, name: string): Promise<void>;
      deleteTemplate(id: string): Promise<void>;
      /** Asks where to save, then writes the template or bot as a shareable file. False when cancelled. */
      exportTemplate(target: { templateId?: string; botId?: string }): Promise<boolean>;
      /** Asks for a template file someone shared and adds it. Null when cancelled. */
      importTemplate(): Promise<string | null>;
      addSection(name: string): Promise<string>;
      renameSection(id: string, name: string): Promise<void>;
      deleteSection(id: string): Promise<void>;
      setChatFlags(
        id: string,
        patch: Partial<Pick<Chat, "pinned" | "archived" | "unread">>,
      ): Promise<void>;
      renameChat(id: string, title: string): Promise<void>;
      deleteChat(id: string): Promise<void>;
      /** The person's answer to a Feed post, idea or goal. Returns a new goal's id for "goal". */
      // Projects and Project Changes
      addProject(): Promise<string | null>;
      renameProject(id: string, name: string): Promise<void>;
      removeProject(id: string): Promise<void>;
      setChatProject(chatId: string, projectId: string | null, mode?: ChatMode): Promise<void>;
      projectChanges(id: string): Promise<ProjectChanges>;
      projectDiff(id: string, file: string): Promise<{ text: string; truncated: boolean }>;
      projectCommit(id: string, message: string): Promise<string>;
      revealProject(id: string): Promise<string>;
      // Project workspaces, to-dos and agent access
      createProject(data: ProjectInput): Promise<string>;
      updateProject(id: string, patch: Partial<Omit<ProjectInput, "folder">> & { folder?: string | null }): Promise<void>;
      /** Asks for a folder and gives it to the project. Null when cancelled. */
      chooseProjectFolder(id: string): Promise<string | null>;
      /** A new chat in a project with one bot, or 2 to 6 for a group. Every bot needs access. */
      startProjectChat(botIds: string[], projectId: string, mode?: ChatMode): Promise<string>;
      /** Attaches an artifact to a project; one already there moves to the front. Answers the project's list afterwards. */
      addProjectArtifact(projectId: string, artifactId: string): Promise<string[]>;
      removeProjectArtifact(projectId: string, artifactId: string): Promise<string[]>;
      /** A project's artifacts as they are now, newest attached first. One that is gone is not among them. */
      projectArtifacts(projectId: string): Promise<{ items: Artifact[] }>;
      addTodo(projectId: string, text: string): Promise<string>;
      updateTodo(projectId: string, todoId: string, patch: { text?: string; done?: boolean }): Promise<void>;
      deleteTodo(projectId: string, todoId: string): Promise<void>;
      moveTodo(projectId: string, todoId: string, delta: -1 | 1): Promise<void>;
      setBotAccess(botId: string, access: BotAccessGrant): Promise<void>;
      openApp(id: string): Promise<void>;
      takePrefill(): Promise<{ chatId: string; text: string } | null>;
      linkPreview(url: string): Promise<LinkPreview | null>;
      // Tasks board
      saveTask(data: TaskInput): Promise<string>;
      moveTask(id: string, status: TaskStatus | "archived"): Promise<void>;
      startTask(id: string): Promise<void>;
      deleteTask(id: string): Promise<void>;
      onPrefill(fn: (data: { chatId: string; text: string }) => void): () => void;
      boardAct(id: string, action: "read" | "unread" | "clear" | "done" | "reopen" | "yes" | "goal" | "notToday" | "up" | "down" | "delete", value?: string): Promise<string | undefined>;
      // Chat canvas
      chooseFiles(): Promise<Attachment[]>;
      /** Resolves a dropped or pasted File to its path. Synchronous, in the preload. */
      pathForFile(file: File): string;
      forkChat(chatId: string, messageIndex: number): Promise<string>;
      retry(runId: string): Promise<void>;
      compact(chatId: string): Promise<void>;
      unqueue(chatId: string, itemId: string): Promise<void>;
      /** Steers the running turn if supported, otherwise moves this message to the front of the queue. */
      sendNow(chatId: string, itemId: string): Promise<void>;
      copyText(text: string): Promise<void>;
      // Skills and MCP servers for every bot (Settings)
      /** Adds a server, or changes one when `id` is set. Returns its id. */
      saveMcpServer(data: McpServerInput): Promise<string>;
      setMcpServerEnabled(id: string, enabled: boolean): Promise<void>;
      removeMcpServer(id: string): Promise<void>;
      /** Connects to one server and reports its status and tools. Takes a few seconds. */
      /** `status` is "connected", "needs-auth" (sign in first), "failed", "pending" and so on. */
      testMcpServer(id: string): Promise<{ status: string; tools: string[] }>;
      /**
       * Signs in to a remote server with OAuth: opens the person's browser and resolves when they
       * finish (rejects when they cancel, deny or it times out after five minutes). Turns OAuth on
       * for a server that turned out to need it.
       */
      signInMcpServer(id: string): Promise<McpAuth>;
      /** Stops waiting for a sign-in that is open in the browser. */
      cancelMcpSignIn(id: string): Promise<boolean>;
      signOutMcpServer(id: string): Promise<void>;
      /** The vault: every stored credential, without secrets. */
      credentials(): Promise<Credentials>;
      /** Removes one credential. An OAuth sign-in is signed out; a key must then be entered again on its server. */
      removeCredential(id: string): Promise<void>;
      /**
       * For a locked vault only: sets it aside (the file is renamed, not deleted) and starts an
       * empty one. Every key and sign-in then has to be entered again. Ask the person first.
       */
      resetVault(): Promise<void>;
      // Settings › Credentials: saved credentials and password managers (desktop/savedcredentials.mjs).
      // None of these ever returns a value.
      /** Every saved credential, by name. `locked`: they can be listed but not changed or read. */
      savedCredentials(): Promise<{ locked: boolean; entries: SavedCredential[] }>;
      /** Adds one typed in here, or changes one (`id`). `value: null` keeps the saved value. Returns the id. */
      saveSavedCredential(input: SavedCredentialInput): Promise<string>;
      removeSavedCredential(id: string): Promise<void>;
      /** Whether it can be read right now. Never the value. */
      checkSavedCredential(id: string): Promise<{ ok: boolean; message?: string }>;
      /** 1Password, Bitwarden and Proton Pass, each with its state. `refresh` looks again now. */
      passwordManagers(refresh?: boolean): Promise<PasswordManagerStatus[]>;
      /** Bitwarden: the master password goes to its tool and isn't kept. */
      unlockPasswordManager(manager: PasswordManagerId, password: string): Promise<PasswordManagerStatus>;
      lockPasswordManager(manager: PasswordManagerId): Promise<PasswordManagerStatus>;
      passwordManagerVaults(manager: PasswordManagerId): Promise<PasswordManagerVault[]>;
      passwordManagerItems(manager: PasswordManagerId, vaultId: string, query?: string): Promise<PasswordManagerItem[]>;
      /** One item with its fields, as labels only. */
      passwordManagerItem(manager: PasswordManagerId, vaultId: string, itemId: string): Promise<PasswordManagerItem>;
      /** Saves a field of a manager's item as a credential that is read from there each time. Returns its id. */
      linkPasswordManagerField(input: { manager: PasswordManagerId; vaultId: string; itemId: string; fieldId: string; name: string }): Promise<string>;
      /** Adds the servers in pasted MCP JSON ({ "mcpServers": { … } }). */
      importMcpServers(json: string): Promise<{ added: string[]; skipped: string[] }>;
      /** Asks for a JSON file and adds its servers. null when the person cancels. */
      importMcpServerFile(): Promise<{ added: string[]; skipped: string[] } | null>;
      /** Every skill Botkins can see, plus the linked skill folders and plugin folders. */
      skills(): Promise<{ skills: SkillInfo[] } & SkillFolders>;
      /** One of Botkins' own skills, for editing. */
      readSkill(name: string): Promise<{ name: string; description: string; instructions: string }>;
      /** Creates a skill, or rewrites one of Botkins' own when `original` is its current name. Returns its name. */
      saveSkill(data: { name: string; description: string; instructions: string; original?: string }): Promise<string>;
      removeSkill(name: string): Promise<void>;
      setSkillEnabled(name: string, enabled: boolean): Promise<void>;
      /** Asks for a folder: a skill is copied in; a folder of skills or a plugin is linked. null when cancelled. */
      addSkillFolder(): Promise<{ kind: "skill" | "plugin" | "folder"; name: string; count?: number } | null>;
      removeSkillFolder(id: string): Promise<void>;
      revealSkill(name: string): Promise<void>;
      /** Which skills (names) and MCP servers (ids) one bot leaves out. */
      setBotIntegrations(botId: string, patch: { skillsOff?: string[]; mcpOff?: string[] }): Promise<void>;
      // Marketplace plugins (`plugins-v1`, docs/plugins.md). Dotted names match the link contract.
      "plugins.marketplaces"(): Promise<PluginMarketplace[]>;
      "plugins.addMarketplace"(source: string): Promise<PluginMarketplace>;
      "plugins.removeMarketplace"(id: string): Promise<void>;
      "plugins.browse"(query: { marketplace?: string; query?: string; cursor?: string }): Promise<{ plugins: PluginListing[]; cursor?: string }>;
      "plugins.preview"(id: string): Promise<PluginPreview>;
      "plugins.install"(id: string, options?: { bots?: "all" | string[]; config?: Record<string, PluginConfigValue>; revision?: string }): Promise<InstalledPlugin>;
      "plugins.addFolder"(path: string): Promise<InstalledPlugin>;
      "plugins.configure"(id: string, values: Record<string, PluginConfigValue>): Promise<void>;
      "plugins.setBots"(id: string, bots: "all" | string[]): Promise<void>;
      "plugins.setEnabled"(id: string, on: boolean): Promise<void>;
      "plugins.update"(id: string, options?: { revision?: string }): Promise<InstalledPlugin>;
      "plugins.uninstall"(id: string): Promise<void>;
      /** Native folder chooser for local plugin installs. Remote hosts do not expose this method. */
      pickPluginFolder?(): Promise<string | null>;
      /** Folder-browser fallback for a paired/remote host when no native chooser is available. */
      listFolders?(path?: string): Promise<{
        path: string;
        parent: string | null;
        folders: { name: string; path: string }[];
        roots?: { name: string; path: string }[];
        more?: boolean;
      }>;
      /** A bot's persistent memory (its MEMORY.md), as text. */
      botMemory(botId: string): Promise<string>;
      setBotMemory(botId: string, text: string): Promise<void>;
      // ---- Html blocks (frames). The frame's page asks through postMessage; the app's page relays here.
      /** Puts text from a frame into its chat's message box (the app then opens that chat). Not sent by itself. */
      frameAnswer(frame: string, text: string): Promise<void>;
      /** Asks the person whether to open a web page a frame wants. Resolves true when it was opened. */
      frameOpenLink(frame: string, url: string): Promise<boolean>;
      // ---- The wiki. Paths are relative to the wiki and use "/". Every change bumps State.wiki.revision.
      wikiTree(): Promise<WikiTree>;
      /** One page with its text. Also reads "index.md" (the catalog) and "log.md" (the change log). */
      wikiPage(path: string): Promise<WikiPage>;
      /**
       * Saves a page's Markdown. With `base`, fails with a message containing "changed while you were editing"
       * when the page changed since it was read; save again without `base` to overwrite.
       */
      saveWikiPage(path: string, content: string, base?: string): Promise<WikiPage>;
      /** A new page from the folder's template ("" is the top of the wiki). Returns its path. */
      createWikiPage(input: { folder: string; title: string }): Promise<string>;
      /** A page for a project record that has none. Returns its path. */
      createWikiPageFor(record: { kind: "project"; id: string }): Promise<string>;
      /** A new section, or a folder inside `parent`. The name becomes a lower-case folder name. Returns its path. */
      createWikiFolder(input: { parent: string; name: string }): Promise<string>;
      /** Moves or renames a page or a folder. Links to the moved pages follow. Returns the new path. */
      moveWiki(from: string, to: string): Promise<string>;
      /** Removes a page, or a folder with everything in it. Removed pages are kept in the wiki folder's .trash. */
      deleteWiki(path: string): Promise<void>;
      searchWiki(query: string): Promise<{ path: string; title: string; snippet: string }[]>;
      wikiHistory(path: string): Promise<WikiVersion[]>;
      /** The Markdown of an earlier version. */
      wikiVersion(path: string, id: string): Promise<string>;
      restoreWikiVersion(path: string, id: string): Promise<WikiPage>;
      /** Shows the wiki folder, or one page's file, in Finder or Explorer. */
      revealWiki(path?: string): Promise<void>;
      /**
       * The pages an export would hold. "all" is the whole wiki. "project" and "page" start from
       * the page at `path` and add what is related to it: `why` is "start", "linked" (linked with
       * the start page) or "related" (one step further).
       */
      wikiExportPlan(request: { scope: "all" | "project" | "page"; path?: string }): Promise<WikiExportPlan>;
      /** The Markdown of the given pages, to lay out as one document. */
      wikiExportPages(paths: string[]): Promise<{ path: string; title: string; section: string; content: string }[]>;
      /**
       * Saves an export where the person chooses (a save dialog opens). Resolves the saved file's
       * path, or null when they cancel.
       * - `{ format: "zip", paths, title }`: the pages as Markdown files with a contents page.
       *   `everything: true` takes the whole wiki folder instead (templates, guide, index and log too).
       * - `{ format: "html" | "pdf", html, title }`: one self-contained document laid out by the
       *   app's page (no scripts, no remote content). For "pdf" the app prints that document.
       */
      exportWiki(
        request:
          | { format: "zip"; paths?: string[]; title: string; everything?: boolean }
          | { format: "html" | "pdf"; html: string; title: string },
      ): Promise<string | null>;
      /** Shows the file the last export saved, in Finder or Explorer. */
      revealWikiExport(): Promise<void>;
      /** What "@" and "#" can mention in a chat. Before the chat exists, pass undefined and the bot's id. */
      mentionables(chatId: string | undefined, botId?: string): Promise<Mentionables>;
      /** Readies a chat's session so its next message starts at once. Call when a chat is opened. */
      warmChat(chatId: string): Promise<void>;
      catalog(
        botId: string,
        chatId?: string,
        refresh?: boolean,
      ): Promise<Catalog>;
      routine(
        id: string,
        data: {
          action: "set" | "pause" | "resume" | "remove";
          cron?: string;
          prompt?: string;
          timezone?: string;
        },
      ): Promise<void>;
      changePanel(id: string, action: string): Promise<void>;
      refreshPanel(id: string): Promise<void>;
      cacheInfo(): Promise<{ bytes: number; catalogs: number }>;
      clearCache(): Promise<void>;
      createChat(id: string): Promise<string>;
      /** A chat with 2 to 6 bots. Returns its id. */
      createGroupChat(botIds: string[], title?: string): Promise<string>;
      /** Sends a message. While the chat is working, the message steers a supported turn by default. */
      send(
        id: string,
        text: string,
        options?: { attachments?: Attachment[]; quote?: string; mentions?: MentionInput[]; delivery?: "steer" | "queue" },
      ): Promise<void>;
      stop(id: string): Promise<void>;
      /** The account behind one model provider. Without an id, the default provider (GitHub Copilot). */
      auth(providerId?: string): Promise<AuthStatus>;
      /** Starts that provider's sign-in in the person's browser and resolves when it is done. */
      signIn(providerId?: string): Promise<void>;
      /** Stops a sign-in that is waiting for the browser. */
      cancelSignIn(providerId?: string): Promise<void>;
      /** Signs the account out of that provider on this computer. */
      signOut(providerId?: string): Promise<void>;
      /**
       * Every model provider Botkins knows, with whether it is on, installed and connected.
       * Answers are kept for half a minute; pass true to ask each provider again.
       * State.providers.revision goes up when the answer may have changed.
       */
      providers(refresh?: boolean): Promise<ProviderStatus[]>;
      installProvider(id: string): Promise<{ session: string }>;
      providerSignInRead(session: string, after: number): Promise<ProviderSignInView>;
      providerSignInCancel(session: string): Promise<unknown>;
      providerSignInInput(session: string, text: string): Promise<void>;
      providerUseToken(id: string, token: string, options?: { service?: string }): Promise<{ connected: boolean }>;
      /** Switches a provider on or off. At least one stays on. */
      setProviderEnabled(id: string, enabled: boolean): Promise<void>;
      /** For a provider whose signIn is "services" (OpenCode): the model services it can connect, best matches first. */
      providerServices(id: string, query?: string): Promise<ProviderService[]>;
      /**
       * Connects a model service with an API key ({ key }) or one of its sign-ins ({ method }).
       * A sign-in opens the browser and resolves { done: true } when it finished, or
       * { code } when the page gives the person a code to paste (then finishProviderService).
       */
      connectProviderService(
        id: string,
        serviceId: string,
        options: { key: string } | { method: string },
      ): Promise<{ done?: boolean; instructions?: string; code?: { attempt: string; instructions: string } }>;
      finishProviderService(id: string, serviceId: string, attempt: string, code: string): Promise<{ done: boolean }>;
      /** Stops a service sign-in that is waiting for the browser. */
      cancelProviderService(id: string, serviceId: string): Promise<void>;
      /** Removes the key or sign-in the provider stored for a service. */
      disconnectProviderService(id: string, serviceId: string): Promise<void>;
      appUpdateStatus(): Promise<AppUpdate>;
      checkAppUpdate(): Promise<AppUpdate>;
      installAppUpdate(): Promise<AppUpdate>;
      openAppRelease(): Promise<void>;
      appInfo(): Promise<AppInfo>;
      // Phone access (Settings › Phone). State.phones.revision goes up when phoneLink() may have changed.
      phoneLink(): Promise<PhoneLink>;
      setPhoneLink(enabled: boolean): Promise<PhoneLink>;
      /** Opens a pairing code for a few minutes. */
      startPhonePairing(): Promise<PhoneLink>;
      cancelPhonePairing(): Promise<void>;
      removePhone(id: string): Promise<void>;
      renamePhoneLinkComputer(name: string): Promise<void>;
      /** What a paired phone may do with this screen. Only this window can change it. */
      setPhoneScreen(mode: PhoneLink["screen"]["mode"]): Promise<PhoneLink>;
      /** Away from home, on or off. Turning it on needs phone access on. Only this window can change it. */
      setPhoneRelay(enabled: boolean): Promise<PhoneLink>;
      /** Gives this computer a new place on the relay. Phones that are away find it again once they have been home. */
      resetPhoneRelay(): Promise<PhoneLink>;
      /** Asks macOS for a permission the screen needs, and opens the page of System Settings where it is switched on. */
      requestScreenPermission(kind: "screenRecording" | "accessibility"): Promise<PhoneLink>;
      /** Opens the page of System Settings where macOS lets Botkins use the local network. */
      allowLocalNetwork(): Promise<PhoneLink>;
      // iMessage and Mail tools for bots (Settings › MCP servers › On this Mac). Only this window can make these calls.
      /** The permissions the switched-on tools need and whether macOS has allowed them, and whether imsg is installed. */
      macToolsStatus(): Promise<MacToolsStatus>;
      /** Switches a tool Off, to Read, or to Read and interact. Refused anywhere but a Mac. */
      setMacTool(tool: MacTool, level: MacToolLevel): Promise<MacToolsStatus>;
      /** Asks macOS for a permission and opens the page of System Settings where it is switched on. */
      grantMacTool(permission: "fullDisk" | "messagesAutomation" | "mailAutomation"): Promise<MacToolsStatus>;
      // Voice (Settings › Voice, desktop/voicedesk.mjs). Only this window can make these calls. No key ever comes back.
      voiceSettings(): Promise<DeskVoiceSettings>;
      setVoice(patch: VoicePatch): Promise<DeskVoiceSettings>;
      /** Saves a key (a string) or removes it (null). The answer only says whether one is saved. */
      setVoiceKey(provider: VoiceKeyProvider, key: string | null): Promise<DeskVoiceSettings>;
      voiceOptions(kind: "stt" | "tts" | "live", provider: string): Promise<VoiceOptions>;
      /** A recording from the microphone, as text (not for "This computer"). */
      transcribe(bytes: Uint8Array, format: "wav" | "m4a" | "mp3" | "webm", language?: string): Promise<{ text: string }>;
      /** { device: true }: speak it with the page's own voices. Otherwise the audio, in parts. */
      speak(text: string, options?: { voice?: string; speed?: number }): Promise<{ device: true } | { parts: { audio: Uint8Array; format: "mp3" | "wav" }[] }>;
      /** Starts the system's own dictation into the focused field (macOS). started is false where there is none. */
      startDictation(): Promise<{ started: boolean; platform: string }>;
      /** { prepare: true } readies this window for WebRTC, before the offer is made. */
      startLiveVoice(chatId: string, options?: { sdp?: string; prepare?: boolean }): Promise<DeskLiveSession>;
      /** Runs a tool the live voice called (ask_bot): resolves with the bot's reply, ready to speak. */
      liveVoiceTool(sessionId: string, name: string, args: Record<string, unknown>): Promise<string>;
      endLiveVoice(sessionId: string): Promise<void>;
      /** What a live session in the main process (Codex) heard and said, and when it ended. */
      onLiveVoice(fn: (event: LiveVoiceEvent) => void): () => void;
      // Routines, notifications and usage
      createRoutine(data: RoutineInput): Promise<string>;
      updateRoutine(id: string, data: Partial<Omit<RoutineInput, "botId">>): Promise<void>;
      setRoutineEnabled(id: string, enabled: boolean): Promise<void>;
      deleteRoutine(id: string): Promise<void>;
      runRoutine(id: string): Promise<void>;
      duplicateRoutine(id: string, botId: string): Promise<string>;
      previewCadence(cadence: Cadence, timezone?: string): Promise<{ nextAt: number; summary: string; timezone: string }>;
      changeSchedule(chatId: string, id: number, action: "pause" | "resume" | "delete"): Promise<void>;
      testNotification(): Promise<void>;
      /** Says which chat is open in the window (null for none), so a phone isn't pinged for it. */
      viewing(chatId: string | null): Promise<void>;
      usage(days: number): Promise<UsageReport>;
      /** What the person did with a chat's side pane (docs/SIDE_PANE.md): chose a tab (null: Details), closed or pinned a panel, closed or opened the pane. */
      sidePane(chatId: string, action: "select" | "remove" | "pin" | "unpin" | "closed" | "opened", panelId?: string | null): Promise<void>;
      /** The computers this app is paired to, and the one in use. */
      remoteHosts(): Promise<NonNullable<State["remote"]>>;
      /** Pairs with another computer: its pairing link, or its address and the code it shows. */
      pairRemoteHost(input: { link?: string; address?: string; code?: string }): Promise<{ id: string; name: string }>;
      /** Finds a team from a ten-character code or Botkins join link. */
      findTeamInvite(input: string): Promise<TeamJoinTarget>;
      startTeamJoin(target: TeamJoinTarget): Promise<TeamJoinState>;
      checkTeamJoin(id: string): Promise<TeamJoinState>;
      teamJoins(): Promise<TeamJoinState[]>;
      cancelTeamJoin(id: string): Promise<void>;
      /** A join link received by the operating system before this window opened. */
      takeTeamJoin(): Promise<string | null>;
      /** The owner view of this computer's team, managed by Settings › Team. */
      team(): Promise<OwnerTeam>;
      /** Who started a chat ("owner" or a member's id) and who was invited into it. */
      chatPeople(chatId: string): Promise<{ createdBy: string; invited: string[] }>;
      /** Invites a person into a chat, or takes one out. Each answers the invited list afterwards. */
      inviteToChat(chatId: string, personId: string): Promise<string[]>;
      removeFromChat(chatId: string, personId: string): Promise<string[]>;
      saveTeamRole(role: TeamRole): Promise<OwnerTeam>;
      deleteTeamRole(id: string): Promise<OwnerTeam>;
      saveTeamGroup(group: TeamGroup): Promise<OwnerTeam>;
      deleteTeamGroup(id: string, moveTo?: string): Promise<OwnerTeam>;
      createTeamInvite(options: { groupId: string; days: number; maxUses: number }): Promise<TeamInvite>;
      revokeTeamInvite(id: string): Promise<OwnerTeam>;
      approveTeamRequest(id: string, groupId?: string): Promise<OwnerTeam>;
      denyTeamRequest(id: string): Promise<OwnerTeam>;
      moveTeamMember(id: string, groupId: string): Promise<OwnerTeam>;
      removeTeamMember(id: string): Promise<OwnerTeam>;
      renameTeam(name: string): Promise<OwnerTeam>;
      /** Shows a paired computer's workspace in this window, or this computer's own (null). */
      useRemoteHost(id: string | null): Promise<unknown>;
      forgetRemoteHost(id: string): Promise<void>;
      renameRemoteHost(id: string, name: string): Promise<void>;
      /** Renames a paired phone or computer as this computer lists it. */
      renamePhone(id: string, name: string): Promise<void>;
      setPhonePerson(id: string, person: string): Promise<void>;
      /** Each connected provider's plan and limits. `refresh` reads every provider again first. */
      providerUsage(options?: { refresh?: boolean }): Promise<ProviderUsage[]>;
      /** A read that nobody waited for has come in: ask again. */
      onProviderUsage(fn: () => void): () => void;
      exportUsage(days: number): Promise<boolean>;
      /** A notification click asks to open a chat. */
      onOpenChat(fn: (chatId: string) => void): () => void;
      onOpenSettings(fn: (tab: string) => void): () => void;
      onTeamJoin(fn: (url: string) => void): () => void;
    };
  }
}

/** An MCP server as the page sees it: `env` and `headers` list names only, never values. */
export type McpServer = {
  id: string;
  name: string;
  type: "stdio" | "http" | "sse";
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: string[];
  cwd?: string;
  url?: string;
  headers?: string[];
  /** Names in `env` or `headers` whose stored value is gone from the vault and must be entered again. */
  needs?: string[];
  /** How a remote server signs in. Local servers sign in with their environment values. */
  auth?: McpAuth;
};
/**
 * A remote MCP server's sign-in. "none": nothing is sent. "header": a key in one of `headers`
 * (an API key or token). "oauth": the person signs in through their browser and Botkins keeps
 * the tokens in its vault; the fields say how that sign-in stands. No token is ever sent to the page.
 */
export type McpAuth =
  | { type: "none" | "header" }
  | {
      type: "oauth";
      signedIn: boolean;
      /** The sign-in ended or needs more permission: the person has to sign in again. */
      needsSignIn?: boolean;
      /** A sign-in is waiting in the person's browser right now. */
      signingIn: boolean;
      /** When the current access token ends; Botkins renews it by itself when `canRenew`. */
      expiresAt?: number;
      canRenew: boolean;
      scope?: string;
      /** The sign-in server's address. */
      issuer?: string;
      /** A client ID entered by hand, for a server that doesn't let apps register themselves. */
      clientId?: string;
      /** True when a client secret is stored for that client ID. */
      clientSecret: boolean;
    };
/** One credential in the vault, without its secret. */
export type Credential = {
  id: string;
  /** Such as "tickets · API_KEY" or "docs sign-in". */
  label: string;
  kind: "environment" | "header" | "oauth" | "client-secret" | string;
  owner: string;
  createdAt: number;
  updatedAt: number;
  /** The MCP server that uses it. */
  serverId?: string;
  usedBy?: string;
};
// Saved credentials (the phone link's store, desktop/link/credentials.mjs), shown in Settings ›
// Credentials and offered where a bot asks for a secret. Not the MCP vault above. Never a value.
export type CredentialSource = "vault" | "onepassword" | "bitwarden" | "protonpass";
export type CredentialKind = "api-key" | "login" | "note";
export type SavedCredential = {
  id: string;
  name: string;
  kind: CredentialKind;
  username?: string;
  website?: string;
  notes?: string;
  /** "vault": typed in and kept encrypted on this computer. Otherwise the password manager it is read from each time. */
  source: CredentialSource;
  /** For a linked one: what is read, as text ("Work / GitHub / token"). Never the value. */
  reference?: string;
  createdAt: number;
  updatedAt: number;
};
/** `value: null` (or none) keeps the saved value. */
export type SavedCredentialInput = { id?: string; name: string; kind?: CredentialKind; username?: string; website?: string; notes?: string; value?: string | null };
export type PasswordManagerId = Exclude<CredentialSource, "vault">;
export type PasswordManagerStatus = {
  id: PasswordManagerId;
  name: string;
  /** ready: signed in and readable. locked: needs unlocking. signed-out: needs a sign-in on this computer. missing: its command-line tool isn't installed. */
  state: "ready" | "locked" | "signed-out" | "missing" | "error";
  version?: string;
  account?: string;
  /** One line about what to do next. */
  message?: string;
  install?: { url: string; command?: string };
  /** It can be unlocked here with the master password (Bitwarden). */
  canUnlock?: boolean;
};
export type PasswordManagerVault = { id: string; name: string; count?: number };
export type PasswordManagerItem = { id: string; title: string; subtitle?: string; fields?: { id: string; label: string; secret: boolean }[] };
/** Stands in for a saved credential's value in an answer. The computer puts the value in. */
export type CredentialRef = { $credential: string; prefix?: string };

export type Credentials = {
  /** "keychain": the vault's key is guarded by the operating system. "file": a development run. */
  protection: "keychain" | "file";
  /**
   * Set when a vault exists that this copy of Botkins can't open; nothing can be read or saved
   * until it opens again or is reset. "installed-app": this is a development run and the vault
   * belongs to the installed app. "key": the system keychain didn't give the vault's key (another
   * computer, or a keychain that was reset). "damaged": the vault file can't be read.
   */
  locked?: "installed-app" | "key" | "damaged";
  /** The address to register when creating a client ID by hand for a server's sign-in. */
  redirectUrl: string;
  entries: Credential[];
};
/** A server to save. In `env` and `headers`, null keeps the value already stored under that name. */
export type McpServerInput = {
  id?: string;
  name: string;
  type: "stdio" | "http" | "sse";
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string | null>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string | null>;
  /**
   * OAuth sign-in for a remote server. Omit to keep what is stored; null turns it off (and signs
   * out); {} turns it on with the server's own registration. `clientId`, `clientSecret` and
   * `scope` are only for a server that needs a client entered by hand; `clientSecret: null`
   * keeps the stored one.
   */
  oauth?: { clientId?: string; clientSecret?: string | null; scope?: string } | null;
};
export type SkillInfo = {
  name: string;
  description: string;
  /** The skill's folder. */
  path: string;
  /** commander: kept and editable in Botkins. folder: read from a linked folder. built-in: ships with Botkins. */
  origin: "commander" | "folder" | "built-in";
  enabled: boolean;
  editable?: boolean;
  folderId?: string;
};
export type SkillFolders = {
  folders: { id: string; path: string; missing: boolean; skills: number }[];
  plugins: { id: string; path: string; missing: boolean }[];
};

// Plugins (`plugins-v1`, docs/plugins.md). IDs are opaque: the renderer only displays names and
// marketplace labels and sends the id back unchanged to the bridge.
export type PluginMarketplace = {
  id: string;
  name: string;
  source: string;
  builtIn: boolean;
  count?: number;
  updatedAt?: number;
  error?: string;
};
export type PluginListing = {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  installed?: true;
};
export type PluginHookEvent =
  | "sessionStart"
  | "userPromptSubmitted"
  | "preToolUse"
  | "postToolUse"
  | "postToolUseFailure"
  | "agentStop"
  | "subagentStart"
  | "subagentStop"
  | "sessionEnd"
  | "errorOccurred"
  | "preCompact"
  | "notification"
  | "permissionRequest";
export type PluginContents = {
  skills: string[];
  agents: string[];
  commands: string[];
  mcpServers: { name: string; kind: "local" | "remote"; command?: string; url?: string; oauth?: true; serverId?: string }[];
  hooks: { event: PluginHookEvent | (string & {}); command: string }[];
  lspServers?: string[];
};
export type PluginField = {
  key: string;
  label: string;
  description?: string;
  secret: boolean;
  required: boolean;
  default?: string;
};
export type PluginPreview = PluginListing & {
  contents: PluginContents;
  config: PluginField[];
  postInstallMessage?: string;
  revision?: string;
  warnings?: string[];
};
export type InstalledPlugin = PluginListing & {
  installed: true;
  enabled: boolean;
  bots: "all" | string[];
  contents: PluginContents;
  config: (PluginField & { set: boolean; value?: string })[];
  status: "ready" | "needs-config" | "needs-sign-in" | "error";
  detail?: string;
  limits?: string;
  updateAvailable?: true;
  folder?: string;
  installedAt: number;
};
export type PluginConfigValue = string | CredentialRef | null;
export type Mentionables = {
  projects: { id: string; name: string; hint: string; current?: boolean }[];
  /** Wiki pages the chat's bots may use. Newest first. `hint` is the page's section. */
  wiki: { path: string; title: string; hint: string; modified: number }[];
  /** Files in the bot's own folder and, in a coding chat, the project folder. Newest first. */
  files: { path: string; name: string; folder: string; where: string; modified: number; size: number }[];
  /** A group chat's members, which "@" also addresses. */
  bots: { id: string; name: string; hint: string }[];
};
/** A wiki page as the Wiki section lists it (desktop/wiki.mjs). Paths use "/" and are relative to the wiki. */
export type WikiPageInfo = {
  /** Such as "projects/website.md". The path stays the same when the title changes. */
  path: string;
  /** The page's first "# " heading, or a title made from its file name. */
  title: string;
  /** Its first sentence, for lists. May be empty. */
  summary: string;
  updatedAt: number;
  /** Paths of the pages this page links to, and of the pages that link to it. */
  links: string[];
  backlinks: string[];
  /** Links on this page to pages that don't exist yet. */
  missing: { path: string; label: string }[];
  /** True for a section's _template.md, the outline its new pages start from. */
  template?: boolean;
};
export type WikiTree = {
  /** Every folder, including empty ones and sub-folders: "projects", "projects/archive". A top-level folder is a section. */
  folders: string[];
  /** Every page, including the guide and the templates. index.md and log.md are not listed. */
  pages: WikiPageInfo[];
  /** The path of the guide page, "WIKI.md". It can be edited but not moved or removed. */
  guide: string;
  revision: number;
  /** Project records that have no wiki page yet. */
  suggested: { projects: { id: string; name: string }[] };
};
export type WikiPage = WikiPageInfo & {
  /** The page's Markdown. */
  content: string;
  /** Identifies this text. Pass it back when saving so a change made meanwhile isn't overwritten. */
  base: string;
  /** How many earlier versions are kept. */
  versions: number;
  /** The project record with this page's name, when the page is in projects/. */
  record?: { kind: "project"; id: string; name: string };
  /** True for index.md and log.md, which Botkins writes. They can't be edited. */
  generated?: boolean;
};
export type WikiExportPlan = {
  /** A name for the export: the start page's title, or "Wiki". */
  title: string;
  pages: { path: string; title: string; section: string; why: "start" | "linked" | "related" }[];
};
/** An earlier version: the page as it was until `by` changed it at `time`. */
export type WikiVersion = { id: string; time: number; by: string };
export type Capability = {
  name: string;
  kind: "Skill" | "Tool" | "Command";
  aliases?: string[];
  hint?: string;
  duringTurn?: boolean;
  options?: { name: string; description: string }[];
  command: string;
  source: string;
  description: string;
};
export type Catalog = {
  choices: Capability[];
  servers: { name: string; status: string }[];
  plugins: { name: string; enabled: boolean }[];
};
export type Routine = {
  cron: string;
  timezone: string;
  prompt: string;
  nextAt: number | null;
  enabled: boolean;
};
export type PanelBlock =
  | { type: "markdown"; text: string }
  | { type: "metric"; label: string; value: string; note?: string }
  | { type: "list"; items: string[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "bars"; label: string; items: { label: string; value: number }[] }
  | { type: "progress"; label: string; value: number; max: number; note?: string }
  | { type: "badges"; items: { label: string; tone: "neutral" | "positive" | "warning" | "negative" | "accent" }[] }
  | { type: "line"; label: string; labels: string[]; series: { name: string; values: number[] }[] }
  /**
   * A page the bot wrote, drawn in a sandboxed frame: `<iframe sandbox="allow-scripts"
   * src={"commander-app://frame-" + frame + "/"}>`. `height` is its starting height in pixels;
   * the page reports its real height. See desktop/frames.mjs for the messages it exchanges.
   */
  | { type: "html"; frame: string; height: number };
export type Panel = {
  id: string;
  key: string;
  botId: string;
  chatId: string;
  title: string;
  blocks: PanelBlock[];
  hidden: boolean;
  size: "small" | "wide" | "tall";
  revision: number;
  updatedAt: number;
  routine: Routine | null;
  refreshChatId?: string;
  lastCheck?: { time: number; status: string; detail?: string };
  /** Set when the panel was published from a chat in a project. */
  projectId?: string;
};

export type ModelChoice = {
  model: string;
  /** The model provider in Botkins' registry (desktop/providers), such as "copilot". */
  provider?: string;
  /** That provider's own reference for where the model comes from. */
  source?: string;
  reasoningEffort?: string;
};
export type ModelInfo = {
  id: string;
  name: string;
  /** The provider's id ("copilot", "codex", "claude", "opencode") and its name for people ("ChatGPT"). */
  provider?: string;
  providerName?: string;
  source?: string;
  /** A service inside the provider, when it holds several (OpenCode's "Anthropic", "Google"). */
  group?: string;
  /** One line about the model, when the provider gives one. */
  description?: string;
  /** The provider's own pick. */
  recommended?: boolean;
  /** The thinking levels the model takes, lowest first. Empty when the provider manages thinking itself. */
  efforts: string[];
  defaultEffort?: string;
  /**
   * What the provider that serves the model states about it (desktop/modeldetails.mjs). Each is
   * absent when the provider doesn't say: nothing here is ever a default.
   */
  /** Tokens the model can hold at once. */
  contextWindow?: number;
  /** Tokens one request may hold, where the provider names a limit below the window. */
  maxPrompt?: number;
  /** Tokens one reply may hold. */
  maxOutput?: number;
  /** Whether it takes pictures, and whether it can call tools. */
  vision?: boolean;
  tools?: boolean;
  /** The provider's own line about each thinking level. */
  effortNotes?: Record<string, string>;
  /** Its knowledge cut-off, as the provider writes it. */
  knowledge?: string;
  /** Who made it, where a provider serves several makers' models. */
  vendor?: string;
  /** The provider's price or speed class, as it names it. */
  tier?: string;
  available: boolean;
};
/** One provider's account, from its own sign-in status. */
export type AuthStatus = {
  connected: boolean;
  login?: string;
  /** How the runtime is signed in: "user" for a Botkins or Copilot CLI sign-in, else env, gh-cli and so on. */
  type?: string;
  host?: string;
};
export type ProviderSignInView = {
  events: (
    | { n: number; type: "output"; text: string }
    | { n: number; type: "prompt"; text: string }
    | { n: number; type: "open"; url: string }
    | { n: number; type: "code"; url: string; code: string }
  )[];
  next: number;
  done: boolean;
  wantsInput: boolean;
  error?: string;
  result?: { installed?: boolean; connected?: boolean; version?: string | null; account?: string | null; plan?: string | null };
};
/** A model provider as Settings › Model providers shows it (desktop/providers). */
export type ProviderStatus = {
  signInWays?: { guided: boolean; token: boolean };
  id: string;
  name: string;
  /** One line under the name. */
  description: string;
  /** The person has this provider switched on. A provider that is off is asked nothing. */
  enabled: boolean;
  /** The provider used for model choices saved without one. */
  default: boolean;
  /** False when the provider needs a tool that isn't on this computer (see install). */
  installed: boolean;
  version?: string;
  /** True when the provider can answer: signed in, or needing no sign-in. */
  connected: boolean;
  /** Who is signed in, and the plan or kind of account behind it. */
  account?: string;
  plan?: string;
  /** What to do next when something is missing. */
  message?: string;
  /** "browser": signIn(id) opens a sign-in page. "services": the person connects model services (providerServices). */
  signIn: "browser" | "services" | null;
  /** signOut(id) can remove the sign-in. */
  signOut: boolean;
  /** Where to get the tool the provider needs. */
  install?: { url: string; command?: string };
  /** The provider is still starting; ask again when State.providers.revision goes up. */
  starting?: boolean;
  /** The provider couldn't be asked. */
  error?: string;
};
/** A model service a provider can connect (for OpenCode: OpenAI, Anthropic, an OpenCode account…). */
export type ProviderService = {
  id: string;
  name: string;
  connected: boolean;
  /** "environment" when it was found in the computer's environment and can't be removed here. */
  via?: "opencode" | "environment";
  methods: { type: "key" | "oauth"; id?: string; label: string }[];
};
/** Phone access as Settings › Phone shows it. */
export type PhoneLink = {
  canSetPerson?: boolean;
  /** The server operator handles pairing outside this virtual workspace. */
  managed?: boolean;
  enabled: boolean;
  /** Set when this copy of the app can't open the link's key (it was set up by the installed app). */
  locked?: boolean;
  /** False while enabled when the port could not be opened. */
  listening: boolean;
  port: number;
  /** The name phones show for this computer. */
  name: string;
  addresses: { address: string; kind: "lan" | "tailnet" | "loopback" | "link"; interface: string }[];
  devices: { id: string; name: string; person?: string; platform: string; kind?: "phone" | "desktop"; createdAt: number; lastSeenAt: number; connected: boolean }[];
  /** An open pairing code. `qr` is the code's link as one SVG path in a square of `size` units. */
  pairing: { code: string; expiresAt: number; url: string; qr: { size: number; d: string } } | null;
  /**
   * Away from home: whether a phone that isn't on this network may reach this computer through the
   * Botkins relay, whether the computer's connection to the relay is up, and "taken" when another
   * computer is using this computer's place there.
   */
  relay: { enabled: boolean; connected: boolean; problem?: "taken" };
  /** The phones that get notifications, and what each wants to hear of. Never where they are sent. */
  push?: { deviceId: string; name: string; prefs: { replies?: boolean; requests?: boolean; routines?: boolean; previews?: boolean; activities?: boolean } }[];
  /** What each phone lets bots use on it, by phone id and source: "read", or "interact" for read and change. */
  sources?: Record<string, Record<string, "off" | "read" | "interact">>;
  /**
   * Whether the computer is announced on the local network, so a phone finds it by name: "on",
   * "starting", "off", "failed", or "blocked" when macOS has not allowed Botkins to use the local network.
   */
  nearby?: "off" | "starting" | "on" | "blocked" | "failed";
  /**
   * Whether a paired phone may watch this screen, or watch and use it; who is watching now; and
   * what the system has allowed. `system` is true where the system asks for these at all (macOS).
   */
  screen: {
    mode: "off" | "view" | "control";
    setBy?: { deviceId: string; name: string; at: number };
    viewers: { deviceId: string; name: string; since: number }[];
    permissions: { system: boolean; screenRecording: boolean; accessibility: boolean };
  };
};
export type AppUpdate = { status: "idle" | "checking" | "current" | "available" | "downloading" | "restarting" | "error"; current: string; latest?: string; message?: string; canInstall: boolean };
export type AppInfo = { version: string; electron: string; chrome: string; platform: string };
export type Appearance = {
  /** System, light or dark. */
  theme: "system" | "light" | "dark";
  /** One of the themes (src/themes.ts): Ink until the person picks one. */
  colorTheme: string;
  /** The person picked the theme themselves. */
  themePicked?: boolean;
  /** One of the fonts (src/themes.ts): the system's face until the person picks one. "botkins" is the design kit's pairing. */
  font: string;
  /** The person picked the font themselves. */
  fontPicked?: boolean;
  textSize: "small" | "default" | "large" | "larger";
  /** "theme", or a hex color for the person's own messages. */
  bubble: string;
  /** Background presets from before themes; kept as saved and no longer drawn. */
  lightBackground: string;
  darkBackground: string;
};
export type MacTool = "imessage" | "mail";
export type MacToolLevel = "off" | "read" | "interact";
export type MacToolLevels = Record<MacTool, MacToolLevel>;
/** Settings › MCP servers › On this Mac: what each tool needs and whether macOS has allowed it. A permission is absent while its tool is off. */
export type MacToolsStatus = {
  available: boolean;
  levels: MacToolLevels;
  imsg: { found: boolean; install: { command: string; url: string } };
  permissions: { fullDisk?: boolean; messagesAutomation?: boolean; mailAutomation?: boolean };
};

export type Preferences = {
  model: ModelChoice;
  appearance: Appearance;
  completionPosition?: import("./chatDisplay").ChatDisplay["completionPosition"];
  /** What selecting a bot does on this device: open its latest chat (the usual), or start a new one. */
  botTap?: import("./chatDisplay").ChatDisplay["botTap"];
  steps?: "folded" | "every" | "failed" | "hidden";
  thinking?: "open" | "folded" | "hidden";
  foldTools: boolean;
  showThinking: boolean;
  /** Show a card for the first web link in a reply. Private and local hosts are never fetched. */
  linkPreviews?: boolean;
  /** Speak each new reply aloud in the open chat. */
  readAloud?: boolean;
  /** The person finished the welcome screen. */
  onboarded?: boolean;
  /** A new workspace has no default model until a provider is connected (desktop/workspace.mjs firstDefaultModel). */
  modelUnset?: boolean;
  approval: "ask" | "read" | "assisted" | "all";
  clarify: string[];
  clarificationInstructions: string;
  notifications: NotificationSettings;
  /** On (the default): every bot can use every project. Off: each bot's grant applies. */
  access?: { allBots: boolean };
  /** iMessage and Mail as bot tools, on a Mac. Only the app's own window changes it (setMacTool); a phone can read it to say "set up on your Mac". */
  macTools?: MacToolLevels;
  /**
   * The side menu: its places in the person's order (always every place once: "Home", "Today",
   * "Chats", "Work", "Wiki") and whether the menu is collapsed to icons, which is
   * the usual menu. `picked` is there once the person has opened or collapsed it themselves.
   * Set either field with setPreferences({ sidebar: { order } }) or ({ sidebar: { collapsed } }).
   */
  sidebar?: { order: string[]; collapsed: boolean; picked?: boolean };
  /**
   * What runs a turn around the model (desktop/harness). "copilot": one harness, the Copilot
   * runtime, runs every chat it can, and the model's own plan answers (GitHub Copilot, ChatGPT,
   * Claude). "provider": each provider's own tool runs its chats.
   */
  harness?: "copilot" | "provider";
  /**
   * Staying on (desktop/startup.mjs). keepRunning: closing the window leaves Botkins running, with
   * its icon in the menu bar or the taskbar's notification area. runAtStartup: Botkins starts,
   * without a window, when the person signs in to the computer.
   */
  background?: { keepRunning: boolean; runAtStartup: boolean };
  /** On (the default): a bot in a one-bot chat may ask other bots for help (desktop/teamwork.mjs). */
  teamwork?: boolean;
};
export type Step = {
  agentId?: string;
  id: string;
  name: string;
  source?: string;
  label: string;
  input?: string;
  output?: string;
  progress?: string;
  status: string;
  started: number;
  finished?: number;
  /** In a group chat, the member that ran this step. */
  botId?: string;
};
export type Card = {
  id: string;
  title: string;
  blocks: PanelBlock[];
  replies: string[];
};
export type FormField = {
  type: string;
  title?: string;
  description?: string;
  enum?: string[];
  enumNames?: string[];
  oneOf?: { const: string; title?: string }[];
  items?: { enum?: string[]; anyOf?: { const: string; title?: string }[] };
  default?: string | number | boolean | string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
};
export type AgentRequest = {
  id: string;
  chatId: string;
  botId: string;
  kind: "permission" | "question" | "form" | "secure";
  fields?: { key: string; label: string; kind: "password" | "code" | "secret" | "text"; hint?: string; optional?: true }[];
  title: string;
  label?: string;
  preview?: string;
  detail?: string;
  remember?: string;
  choices?: string[];
  freeform?: boolean;
  schema?: { properties: Record<string, FormField>; required?: string[] };
  url?: string;
  /** A request raised by a member's turn, shown and notified to the owner. */
  askedBy?: { memberId: string; name: string };
};

export type BoardItem = {
  id: string;
  botId: string;
  kind: "feed" | "idea" | "goal";
  title: string;
  body: string;
  links?: { url: string; title: string }[];
  category?: string;
  status: "open" | "done" | "cleared";
  answer?: "yes" | "goal";
  read: boolean;
  rating?: "up" | "down";
  reason?: string;
  snoozedUntil?: number;
  /** The routine that posted it. */
  source?: string;
  createdAt: number;
  updatedAt: number;
};

export type ProjectTodo = { id: string; text: string; done: boolean; createdAt: number; doneAt?: number };
export type ProjectColor = "coral" | "amber" | "green" | "teal" | "blue" | "violet" | "pink" | "gray";
/** A project workspace. With a folder, its chats are coding chats with modes and Changes. */
export type Project = {
  id: string;
  name: string;
  description?: string;
  color?: ProjectColor;
  folder?: string;
  todos: ProjectTodo[];
  /** Artifacts a person attached, as their ids, newest first (capability "project-artifacts-v1"). Left out while there are none. */
  artifacts?: string[];
  lastUsed: number;
  createdAt: number;
};
export type ProjectInput = { name?: string; description?: string; color?: ProjectColor | null; folder?: string };
export type BotAccessGrant = { all: boolean; projects: string[] };
/** How freely a coding chat's bot acts: ask before risky steps, plan first without changing code, or run without asking. */
export type ChatMode = "default" | "plan" | "yolo";
export type ChangedFile = { path: string; from?: string; kind: "modified" | "added" | "deleted" | "renamed" | "untracked"; staged: boolean; added: number; removed: number };
export type ProjectChanges =
  | { repo: false; files: [] }
  | { repo: true; root: string; branch: string; upstream: string; ahead: number; behind: number; files: ChangedFile[]; added: number; removed: number };

/** An HTML app a bot showed in a turn, as its card in the chat. */
export type AppCard = { id: string; title: string; description: string; sendsAnswers: boolean };

export type TaskStatus = "later" | "ready" | "working" | "review" | "blocked" | "done";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type BotTask = {
  id: string;
  title: string;
  body: string;
  botId: string | null;
  priority: TaskPriority;
  status: TaskStatus | "archived";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  chatId?: string;
  runId?: string;
  result?: string;
  problem?: string;
};
export type TaskInput = { id?: string; title: string; body?: string; botId?: string | null; priority?: TaskPriority; status?: "later" | "ready" };

export type LinkPreview = { url: string; title: string; description: string; site: string; image?: string };

export type BotTemplate = {
  id: string;
  name: string;
  role: string;
  summary: string;
  instructions: string;
  look?: BotLook;
  source: "saved" | "imported";
  /** The file an imported template came from. */
  from?: string;
  createdAt: number;
};

// Voice (capability "voice-v1"), as in the Botkins link (desktop/link/VOICE.md). Keys stay in the main process.
export type SttProvider = "device" | "openai" | "azure" | "elevenlabs" | "custom" | "local";
export type TtsProvider = "device" | "openai" | "azure" | "elevenlabs" | "gemini" | "custom" | "local";
export type LiveProvider = "codex" | "openai" | "gemini" | "elevenlabs";
export type VoiceKeyProvider = "openai" | "azure" | "elevenlabs" | "gemini" | "custom";
export type LocalVoiceModel = { id: string; name: string; kind: "stt" | "tts"; installed: boolean; sizeMB?: number; voices?: { id: string; name: string }[] };
export type VoiceSettings = {
  /** "device" is the computer's own speech, and the default. */
  stt: { provider: SttProvider; model?: string; language?: string };
  /** `auto` reads replies aloud (a phone's choice; this window uses Preferences.readAloud). `speed` runs from 0.5 to 2. */
  tts: { provider: TtsProvider; model?: string; voice?: string; speed?: number; auto?: boolean };
  /** null until the person picks one. */
  live: { provider: LiveProvider | null; model?: string; voice?: string };
  providers: {
    openai: { baseUrl: string; hasKey: boolean };
    azure: { kind: "openai" | "speech"; endpoint?: string; region?: string; sttDeployment?: string; ttsDeployment?: string; apiVersion?: string; hasKey: boolean };
    elevenlabs: { hasKey: boolean; agentId?: string };
    gemini: { hasKey: boolean };
    /** The person's own OpenAI-compatible server, such as one that runs local models. */
    custom: { baseUrl?: string; hasKey: boolean };
    /** Models the computer's app runs itself. */
    local: { available: boolean; models: LocalVoiceModel[] };
    codex: { available: boolean; signedIn: boolean };
  };
};
/** The settings as this window gets them: whether they can be changed here, and what this computer does itself. */
export type DeskVoiceSettings = VoiceSettings & { ready: boolean; problem?: string; device: { stt: boolean; tts: true } };
export type VoicePatch = {
  stt?: Partial<VoiceSettings["stt"]>;
  tts?: Partial<VoiceSettings["tts"]>;
  live?: Partial<VoiceSettings["live"]>;
  providers?: { openai?: { baseUrl?: string }; azure?: Partial<Omit<VoiceSettings["providers"]["azure"], "hasKey">>; elevenlabs?: { agentId?: string }; custom?: { baseUrl?: string } };
};
export type VoiceOptions = { models: { id: string; name: string }[]; voices: { id: string; name: string; language?: string; preview?: string }[] };
/** A tool the live voice may call. The page sends the call to liveVoiceTool and the answer back to the provider. */
export type LiveTool = { name: string; description: string; parameters: Record<string, unknown> };
/**
 * A live voice session. "webrtc": the answer to the page's offer. The others are a socket to open
 * with a short-lived token in its address or beside it, and the first message to send on it.
 */
export type LiveSession =
  | { id: string; kind: "webrtc"; sdp: string }
  | { id: string; kind: "openai-ws"; url: string; token: string; expiresAt: number; session: Record<string, unknown> }
  | { id: string; kind: "gemini-ws"; url: string; expiresAt: number; setup: Record<string, unknown>; input: { sampleRate: number }; output: { sampleRate: number } }
  | { id: string; kind: "elevenlabs-ws"; url: string; init: Record<string, unknown>; input: { sampleRate: number }; output: { sampleRate: number } };
export type DeskLiveSession = LiveSession & { tools: LiveTool[] };
export type LiveVoiceEvent = { sessionId: string } & (
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "ended"; reason?: string }
  /** Words to put into the session for the voice to say: the bot's answer to a request that outlasted its tool call. */
  | { type: "say"; text: string }
);
