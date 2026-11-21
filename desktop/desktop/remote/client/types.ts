// The desktop's data, as the phone sees it. These mirror the desktop app's own types
// (desktop/src/types.ts); a chat arrives as a summary and its messages come separately.

export type ModelChoice = { model: string; provider?: string; source?: string; reasoningEffort?: string };
export type ModelInfo = {
  id: string;
  name: string;
  provider?: string;
  providerName?: string;
  source?: string;
  /** A service inside the provider, when it holds several (OpenCode's "Anthropic", "Google"). */
  group?: string;
  description?: string;
  recommended?: boolean;
  /** The thinking levels the model takes, lowest first. Empty when the provider manages thinking. */
  efforts: string[];
  defaultEffort?: string;
  available: boolean;
  // What the provider that serves the model says about it ("models-v2"). Each is left out when it
  // is not known: nothing here is a guess.
  /** Tokens the model can hold in one conversation. */
  contextWindow?: number;
  /** The most tokens it writes in one reply. */
  maxOutput?: number;
  /** The most tokens of a conversation it reads, where the provider names a limit below the window. */
  maxPrompt?: number;
  /** It reads pictures. */
  vision?: boolean;
  /** It can call tools. */
  tools?: boolean;
  /** What each thinking level means, where the provider says. */
  effortNotes?: Record<string, string>;
  /** How recent its knowledge is, as the provider writes it. */
  knowledge?: string;
  /** Who made the model, such as "Anthropic". */
  vendor?: string;
  /** The provider's own price or speed class. */
  tier?: string;
};
export type ProviderStatus = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  default: boolean;
  installed: boolean;
  version?: string;
  connected: boolean;
  account?: string;
  plan?: string;
  message?: string;
  signIn: "browser" | "services" | null;
  signOut: boolean;
  install?: { url: string; command?: string };
  starting?: boolean;
  error?: string;
};
export type ProviderService = {
  id: string;
  name: string;
  connected: boolean;
  via?: "opencode" | "environment";
  methods: { type: "key" | "oauth"; id?: string; label: string }[];
};

/** The picture the computer's own app draws for a bot. The phone draws a Botkin instead (`Bot.look`). */
export type BotAvatarSpec = { body: string; main?: string; accent?: string; eyes?: string; mouth?: string; cheeks?: boolean };
/** A Botkins character and palette, by id (src/data/botLook.ts). */
/** The eyes a Botkin has at rest. "oval" is every character's own. */
export type BotkinEyes = "oval" | "button" | "smile" | "sleepy" | "wink" | "curious";
/**
 * How a bot looks. `palette` is one of the kit's, or "custom" with `colors`
 * ([shell, accent, faceplate, eyes], each "#rrggbb"). `eyes` and "custom" need a computer whose
 * capabilities include "looks-v2"; an older one refuses them.
 */
export type BotkinLook = { head: string; palette: string; eyes?: BotkinEyes; colors?: [string, string, string, string] };
export type BotAccessGrant = { all: boolean; projects: string[] };
export type Bot = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  clarificationInstructions?: string;
  face: string;
  model?: ModelChoice;
  skillsOff?: string[];
  mcpOff?: string[];
  teamwork?: boolean;
  avatar?: BotAvatarSpec;
  /** The Botkin chosen for this bot on a phone. Without one, the bot shows its default character. */
  look?: BotkinLook;
  summary?: string;
  pinned?: boolean;
  hidden?: boolean;
  sectionId?: string | null;
  access?: BotAccessGrant;
  origin?: { provider: string; agent: string; file?: string };
};
export type BotInput = Pick<Bot, "name" | "role" | "instructions" | "face"> & Partial<Pick<Bot, "avatar" | "summary">>;
/** An agent the person already has in a provider's own tool (a Copilot or Codex agent), which can become a bot. */
export type ImportableAgent = {
  key: string;
  provider: string;
  providerName: string;
  agent: string;
  name: string;
  role: string;
  summary: string;
  instructions: string;
  /** The agent's model, by name, when the account has it. */
  modelName?: string;
  /** The model the agent names when the account doesn't have it; the bot then uses the default model. */
  missingModel?: string;
  /** The agent names its own tools; the bot uses Botkins' skills, tools and approvals instead. */
  ownTools?: boolean;
  /** A bot was made from it already. */
  added?: boolean;
  /** Why it can't become a bot. */
  problem?: string;
};
/** What a web page says about itself, for a link's preview card. */
export type LinkPreview = { url: string; title: string; description: string; site: string; image?: string };
export type ChangedFile = { path: string; from?: string; kind: "modified" | "added" | "deleted" | "renamed" | "untracked"; staged: boolean; added: number; removed: number };
/** What changed in a project's folder since its last commit. `repo: false` when the folder isn't a git repository. */
export type ProjectChanges = { repo: false; files: [] } | { repo: true; root: string; branch: string; upstream: string; ahead: number; behind: number; files: ChangedFile[]; added: number; removed: number };
/** The computer's app, for About. */
export type AppInfo = { version: string; electron: string; chrome: string; platform: string };
export type Section = { id: string; name: string };
export type BotTemplate = {
  id: string;
  name: string;
  role: string;
  summary: string;
  instructions: string;
  avatar?: BotAvatarSpec;
  source: "saved" | "imported";
  createdAt: number;
};
export type Scope = "agents" | "today" | "skills" | "mcp" | "plugins" | "settings";
export type Role = {
  id: string;
  name: string;
  perms: Record<Scope, string[]>;
  bots: "all" | string[];
};
export type Group = { id: string; name: string; roleId: string };
export type MemberDevice = { id: string; name: string; kind: "phone" | "desktop"; platform: string; connected: boolean };
export type Member = { id: string; name: string; groupId: string; joinedAt: number; deviceIds: string[]; devices?: MemberDevice[] };
export type Invite = {
  id: string;
  code: string;
  groupId: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  uses: number;
  revoked?: true;
  published?: boolean;
  link?: string;
};
export type JoinRequest = { id: string; name: string; platform: string; kind: "phone" | "desktop"; at: number; inviteId: string };
export type TeamPart =
  | { name: string; roles: Role[]; groups: Group[]; members: Member[]; invites: Invite[]; requests: JoinRequest[] }
  | {
      me: { memberId: string; name: string; group: { id: string; name: string }; role: { name: string; perms: Record<Scope, string[]>; bots: "all" | string[] } };
      team: { name: string };
    };

/**
 * What a message carried along, as the computer keeps it. A Today item ("board-mentions-v1") keeps
 * its title in `label` with its kind, the start of its text and its links, so the chat can show it
 * as a card after the item itself is cleared.
 */
export type Mention =
  | { kind: "label"; id: string; label: string } // Display only, for older messages.
  | { kind: "project"; id: string; label: string }
  | { kind: "file" | "wiki"; path: string; label: string }
  | { kind: "board"; id: string; label: string; board?: BoardItem["kind"]; body?: string; links?: { url: string; title?: string }[] };
export type Message = {
  role: "assistant" | "user" | "command";
  text: string;
  mentions?: Mention[];
  plain?: boolean;
  runId?: string;
  time?: number;
  attachments?: { name: string; path: string; kind?: "file" | "directory" }[];
  quote?: string;
  /** In a group chat, the bot that wrote this reply. */
  botId?: string;
  /** The team member who sent this user message. Missing on the owner's messages. */
  author?: { memberId: string; name: string };
  /** A person's message delivered into a turn that was under way (a steer): that turn's run. The desktop app records it today. */
  steeredRunId?: string;
  /**
   * Text a bot wrote during a turn before a step, a steer or a request, or before the turn ended
   * without a reply ("turn-timeline-v1", docs/turn-timeline.md). `time` is when its first words came.
   */
  interim?: true;
  /** What the person answered to a request in a turn ("turn-timeline-v1"): `text` is the answer in words, never a secret. */
  answer?: { runId: string; requestId: string; kind: AgentRequest["kind"]; title: string };
};
/**
 * What the composer sends for a mention; the computer checks it and fills in the label. "board" is a
 * Today card (a BoardItem's id) being discussed; only a computer with "board-mentions-v1" takes it.
 */
export type MentionInput = { kind: "project" | "board"; id: string } | { kind: "file" | "wiki"; path: string };
/** What can be mentioned in a chat (the computer's own list). Files are the bot's workspace and the project folder. */
export type Mentionables = {
  projects: { id: string; name: string; hint: string; current?: boolean }[];
  wiki: { path: string; title: string; hint: string; modified: number }[];
  files: { path: string; name: string; folder: string; where: string; modified: number; size: number }[];
  bots: { id: string; name: string; hint: string }[];
};
/** One entry of the "/" menu: a skill, a tool or a command of the chat's model provider. */
export type Capability = { name: string; kind: "Skill" | "Tool" | "Command"; aliases?: string[]; hint?: string; duringTurn?: boolean; options?: { name: string; description: string }[]; command: string; source: string; description: string };
export type Catalog = { choices: Capability[]; servers: { name: string; status: string }[]; plugins: { name: string; enabled: boolean }[] };
/** A file the phone uploaded to the computer for a message. */
export type UploadedFile = { id: string; name: string; path: string; size: number };
/** A pull request of the repository a chat's project works in. */
export type PullRequest = { number: number; title: string; url: string; state: "open" | "closed" | "merged"; draft: boolean; author?: string; head?: string; base?: string; updatedAt?: string; repository?: string };

// Credentials. Values stay on the computer: the phone can save one, and can name one in a call
// with a CredentialRef, but can never read one back.
export type CredentialSource = "vault" | "onepassword" | "bitwarden" | "protonpass";
export type CredentialKind = "api-key" | "login" | "note";
export type Credential = {
  id: string;
  name: string;
  kind: CredentialKind;
  username?: string;
  website?: string;
  notes?: string;
  /** "vault": kept encrypted on the computer. Otherwise the password manager it is read from at the moment of use. */
  source: CredentialSource;
  /** For a credential linked to a password manager: what is read, as text ("Work / GitHub / token"). Never the value. */
  reference?: string;
  createdAt: number;
  updatedAt: number;
};
/** `value: null` keeps the saved value. */
export type CredentialInput = { id?: string; name: string; kind?: CredentialKind; username?: string; website?: string; notes?: string; value?: string | null };
export type PasswordManagerId = Exclude<CredentialSource, "vault">;
export type PasswordManagerStatus = {
  id: PasswordManagerId;
  name: string;
  /** ready: signed in and readable. locked: needs unlocking. signed-out: needs a sign-in on the computer. missing: its command-line tool isn't installed. */
  state: "ready" | "locked" | "signed-out" | "missing" | "error";
  version?: string;
  account?: string;
  /** One line about what to do next. */
  message?: string;
  install?: { url: string; command?: string };
  /** The phone can unlock it by sending the master password (Bitwarden). */
  canUnlock?: boolean;
};
export type PasswordManagerVault = { id: string; name: string; count?: number };
export type PasswordManagerItem = { id: string; title: string; subtitle?: string; fields?: { id: string; label: string; secret: boolean }[] };
/**
 * Stands in for a credential's value inside a call. The computer puts the value in; it never reaches
 * the phone. `prefix` is a scheme word and a space to put in front, as an Authorization header needs ("Bearer ").
 */
export type CredentialRef = { $credential: string; prefix?: string };

// The computer's screen.
/** off: phones can't see the screen. view: they can watch. control: they can also click and type. Set on the computer. */
export type ScreenMode = "off" | "view" | "control";
/** Whether a headless host has a display to show now. `kind` says what it is ("xvfb"); `note` is one sentence a person reads. */
export type HostDisplay = { available: boolean; kind?: string; note?: string };
/** What the person lets phones do with the computer, and what kind of computer it is. */
export type HostPart = {
  screen: ScreenMode;
  /** The computer uses a relay (see `relay-v1`). */
  relay?: boolean;
  /** The computer has no window of its own (a server). Only then can a phone set `screen` ("screen-grant-v1"). */
  headless?: true;
  /** With `headless`: the display, as it is now. */
  display?: HostDisplay;
  /** The phone that last set `screen` from afar, and when. Missing when it was set on the computer itself. */
  screenSetBy?: { deviceId: string; name: string; at: number };
};
/** A ticket to turn the screen on: the phone signs it and sends it back within the minute it lasts. */
export type ScreenTicket = { ticket: string; expiresAt: number };
export type ScreenDisplay = { id: string; label: string; width: number; height: number; primary: boolean };
export type ScreenInfo = { mode: ScreenMode; displays: ScreenDisplay[]; canView: boolean; canControl: boolean; /** Why it can't, in one line ("Allow screen recording for Botkins on your computer"). */ problem?: string };
/** One picture of a display. `jpeg` (base64) is left out when nothing changed since frame `after`. */
export type ScreenFrame = { seq: number; display: string; width: number; height: number; jpeg?: string };
/** Positions are fractions (0 to 1) of the display, so the picture's size doesn't matter. */
export type ScreenInput =
  | { type: "move" | "down" | "up" | "click" | "doubleClick" | "rightClick"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string; modifiers?: ("cmd" | "ctrl" | "alt" | "shift")[] };

export type ChatMode = "default" | "plan" | "yolo";
export type Cadence =
  | { kind: "once"; date: string; time: string }
  | { kind: "daily" | "weekdays"; time: string }
  | { kind: "weekly"; time: string; days: number[] }
  | { kind: "custom"; cron: string };
export type ChatSchedule = {
  id: number;
  prompt: string;
  nextAt: number | null;
  recurring: boolean;
  intervalMs?: number;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  /** Set on routines: named scheduled tasks in their own "Routine · <name>" chat. */
  routine?: boolean;
  name?: string;
  cadence?: Cadence;
  /** Where a routine's result lands; missing means its own chat. */
  deliver?: RoutineDelivery;
  /** False when the routine sends no notification. */
  notify?: boolean;
  createdAt?: number;
  finishedAt?: number;
};
/**
 * Where a routine's result lands when a run finishes. "routine" (and nothing) keeps it in the
 * routine's own chat; "chat" also posts it as a message from the bot in the person's chat with it
 * (`chatId` names one, else the bot's main chat); the rest post it to Today as that kind of item.
 * Needs the capability "routine-delivery-v1". "none" (the routine runs and keeps its history, and
 * publishes no reply and no notification) needs "routine-no-output-v1" as well.
 */
export type RoutineDelivery = { to: "none" | "routine" | "chat" | "feed" | "idea" | "goal"; chatId?: string; /** For "goal": which kind of goal. */ category?: string };
/** `notify: false` keeps a routine quiet: no notification when a run finishes, on the computer or a phone. */
export type RoutineInput = { botId: string; name: string; prompt: string; cadence: Cadence; timezone?: string; deliver?: RoutineDelivery; notify?: boolean };
export type ChatContext = { current: number; limit: number; system?: number; tools?: number; conversation?: number; messages?: number; updatedAt?: number };
/** A chat as lists show it. Its messages arrive in a ChatDetail when the chat is open. */
export type ChatSummary = {
  id: string;
  botId: string;
  /** How many tabs the chat's side pane has ("side-pane-v1"). The tabs come with the chat's detail. */
  panes?: number;
  /** Set on a group chat: its 2 to 6 members, in answer order. */
  botIds?: string[];
  /** The member who created it. Missing on an owner chat. */
  createdBy?: string;
  title: string;
  time: number;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  projectId?: string;
  mode?: ChatMode;
  panelId?: string;
  model?: ModelChoice;
  forkedFrom?: { chatId: string; messageIndex: number };
  context?: ChatContext;
  schedules?: ChatSchedule[];
  count: number;
  last?: { role: Message["role"]; text: string; time?: number; botId?: string };
};
export type Step = {
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
  botId?: string;
  /** The helper (`Subagent.id`) that ran this step ("turn-timeline-v1"). Missing: the turn's own step, or a computer that doesn't say. */
  agentId?: string;
};
export type Todo ={ id: string; title: string; status: "pending" | "in_progress" | "done" | "blocked" | "cancelled"; dependsOn?: string[] };
export type Reasoning = { id: string; text: string; started: number; finished?: number; botId?: string };
/**
 * A helper a turn started ("In the background"). `id` is the id of the step that started it. With
 * "turn-timeline-v1": `prompt` is what it was asked, `intent` what it says it is doing now, and
 * `result` what it came back with (each cut short by the computer).
 */
export type Subagent = { id: string; name: string; description?: string; status: "Running" | "Done" | "Failed" | "Stopped"; started: number; finished?: number; detail?: string; prompt?: string; intent?: string; result?: string };
export type Usage = { input: number; output: number; cacheRead?: number; cost?: number; model?: string; durationMs?: number };
export type TeamAsk = {
  id: string;
  botId: string;
  fromBotId: string;
  message: string;
  status: "waiting" | "working" | "answered" | "failed" | "stopped";
  started: number;
  finished?: number;
  reply?: string;
  error?: string;
  intent?: string;
  steps?: Step[];
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
  | { type: "html"; frame: string; height: number };
export type Card = { id: string; title: string; blocks: PanelBlock[]; replies: string[] };
export type RunSummary = {
  id: string;
  chatId: string;
  title: string;
  time: number;
  /** "Working", "Completed", "Needs you" (failed), "Stopped" or "Interrupted". */
  status: string;
  detail?: string;
  trigger?: "manual" | "scheduled";
  finished?: number;
  summary?: string;
  panelId?: string;
  scheduleId?: number;
  usage?: Usage;
};
export type Run = RunSummary & {
  model?: ModelChoice;
  usedTools?: string[];
  steps?: Step[];
  cards?: Card[];
  apps?: { id: string; title: string; description: string; sendsAnswers: boolean }[];
  options?: { label: string; prompt: string; description?: string }[];
  reasoning?: Reasoning[];
  todos?: Todo[];
  agents?: Subagent[];
  speakers?: string[];
  failures?: { botId: string; detail: string }[];
  teamwork?: TeamAsk[];
  /** How a turn ended without finishing ("turn-timeline-v1"). Missing: the phone reads it from `status` and `detail`. */
  ending?: "failed" | "timed-out" | "interrupted" | "stopped";
};
/**
 * A tab in the side pane a bot opened beside a chat ("side-pane-v1"; the contract is the desktop
 * app's docs/SIDE_PANE.md). `rich_ui` is a custom view (its page is read with "link.frame.page"),
 * `table` plain text cells, `web` an http or https address, `screen` the Screen view.
 */
export type PanePanel = {
  id: string;
  kind: "rich_ui" | "table" | "web" | "screen";
  title: string;
  botId: string;
  createdAt: number;
  updatedAt: number;
  pinned?: true;
  unseen?: true;
  frame?: string;
  columns?: string[];
  rows?: string[][];
  url?: string;
};
/** A chat's side pane: its tabs, the one in front (null: the chat's own details), the latest time a bot asked something of it, and whether the person closed it. */
export type ChatPane = {
  panels: PanePanel[];
  active: string | null;
  ask?: { seq: number; panelId?: string | null; close?: true; runId: string; botId: string; at: number };
  closed?: { runId: string | null; at: number };
};
/** One page of a chat's messages. `from` is the index of the first one in the whole chat. */
export type ChatDetail = { id: string; from: number; total: number; messages: Message[]; runs: Run[]; todos?: Todo[]; pane?: ChatPane };

export type FormField = {
  type: string;
  title?: string;
  description?: string;
  enum?: string[];
  enumNames?: string[];
  oneOf?: { const: string; title?: string }[];
  default?: string | number | boolean | string[];
  minimum?: number;
  maximum?: number;
  format?: string;
};
/**
 * One field of a secure input ("secure-input-v1"). password: masked, the phone's password
 * autofill. code: a one-time passcode, its autofill, shown as typed. secret: masked, any token or
 * key. text: shown as typed (a username, an account id). Whatever the kind, the value goes to the
 * computer only and never lands in the chat.
 */
export type SecureField = {
  /** The name in the answer. */
  key: string;
  /** The field's header, as the bot wrote it: "Password", "One-time code". */
  label: string;
  kind: "password" | "code" | "secret" | "text";
  /** One short line under the label. */
  hint?: string;
  optional?: true;
};
export type AgentRequest = {
  id: string;
  chatId: string;
  botId: string;
  /** "secure" needs "secure-input-v1": what is typed goes to the computer only, and the bot gets a handle it can pass to its tools, never the value. */
  kind: "permission" | "question" | "form" | "secure";
  title: string;
  label?: string;
  preview?: string;
  detail?: string;
  /** Set when "Always allow in this chat" is on offer. */
  remember?: string;
  choices?: string[];
  freeform?: boolean;
  schema?: { properties: Record<string, FormField>; required?: string[] };
  url?: string;
  /** A secure input's fields: 1 is a single value, 2 to 8 a multi-value. Answered with `{ action: "accept", content: { [key]: string | CredentialRef } }`. */
  fields?: SecureField[];
};
export type QueuedMessage = { id: string; text: string };
/** What is happening right now, per chat. */
export type Live = {
  /**
   * The reply so far. An empty string means the bot is still thinking. With "turn-timeline-v1" it
   * holds only what came after the turn's last interim message.
   */
  streams: Record<string, string>;
  intents: Record<string, string>;
  thinking: Record<string, string>;
  speakers: Record<string, string>;
  queued: Record<string, QueuedMessage[]>;
  requests: AgentRequest[];
  active: string[];
  /** Whether a message sent now steers the turn under way ("Steer now") or waits for it ("Send next"). Missing on an older link. */
  steerable?: Record<string, boolean>;
};

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
  routine: { cron: string; timezone: string; prompt: string; nextAt: number | null; enabled: boolean } | null;
  lastCheck?: { time: number; status: string; detail?: string };
  projectId?: string;
  /** The chat that holds the panel's refreshes (its "refresh history"), once it has refreshed. */
  refreshChatId?: string;
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
  snoozedUntil?: number;
  createdAt: number;
  updatedAt: number;
};
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
export type ProjectTodo = { id: string; text: string; done: boolean; createdAt: number; doneAt?: number };
export type ProjectColor = "coral" | "amber" | "green" | "teal" | "blue" | "violet" | "pink" | "gray";
export type Project = { id: string; name: string; description?: string; color?: ProjectColor; folder?: string; todos: ProjectTodo[]; lastUsed: number; createdAt: number };

export type McpAuth =
  | { type: "none" | "header" }
  | { type: "oauth"; signedIn: boolean; needsSignIn?: boolean; signingIn: boolean; expiresAt?: number; canRenew: boolean; scope?: string; issuer?: string; clientId?: string; clientSecret: boolean };
export type McpServer = {
  id: string;
  name: string;
  type: "stdio" | "http" | "sse";
  enabled: boolean;
  command?: string;
  args?: string[];
  /** Names only, never values. */
  env?: string[];
  cwd?: string;
  url?: string;
  headers?: string[];
  needs?: string[];
  auth?: McpAuth;
};
export type McpServerInput = {
  id?: string;
  name: string;
  type: "stdio" | "http" | "sse";
  enabled?: boolean;
  command?: string;
  args?: string[];
  /** null keeps the stored value. */
  env?: Record<string, string | null>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string | null>;
  /** Omit to keep what is stored; null turns sign-in off; {} turns it on. */
  oauth?: { clientId?: string; clientSecret?: string | null; scope?: string } | null;
};
export type SkillInfo = {
  name: string;
  description: string;
  path: string;
  /** botkins: kept and editable in the desktop app. folder: read from a linked folder. built-in: ships with it. */
  origin: "botkins" | "folder" | "built-in";
  enabled: boolean;
  editable?: boolean;
  folderId?: string;
};
export type SkillDetail = { name: string; description: string; instructions: string };

/**
 * How the app on the computer looks (the phone has its own look, in `prefs.ts`). `colorTheme`,
 * `font` and `textSize` are missing on an older computer. `bubble` is "theme" or a `#rrggbb` color.
 */
export type Appearance = {
  theme: "system" | "light" | "dark";
  lightBackground: string;
  darkBackground: string;
  bubble: string;
  colorTheme?: string;
  themePicked?: boolean;
  font?: string;
  fontPicked?: boolean;
  textSize?: "small" | "default" | "large" | "larger";
};
export type NotificationSettings = { replies: boolean; routines: boolean; requests: boolean; quietHours: { enabled: boolean; from: string; to: string } };
export type Preferences = {
  model: ModelChoice;
  appearance: Appearance;
  foldTools: boolean;
  showThinking: boolean;
  linkPreviews?: boolean;
  readAloud?: boolean;
  onboarded?: boolean;
  /** ask: every request. read: reads are allowed. assisted: the model decides. all: nothing asks. */
  approval: "ask" | "read" | "assisted" | "all";
  clarify: string[];
  clarificationInstructions: string;
  notifications: NotificationSettings;
  access?: { allBots: boolean };
  /** The computer's app: keep running when its window is closed, and start with the computer. Missing on an older computer. */
  background?: { keepRunning: boolean; runAtStartup: boolean };
  /** The side menu of the computer's own window: the order of its places, and icons only. */
  sidebar?: { order: string[]; collapsed: boolean; picked?: boolean };
  teamwork?: boolean;
  providers?: Record<string, { enabled: boolean }>;
  /**
   * What runs a bot's turn around the model. "copilot": one harness (the Copilot SDK) for every plan.
   * "provider": each provider's own tool (Codex for ChatGPT, Claude Code for Claude). Missing on an older computer.
   */
  harness?: "copilot" | "provider";
  /** Tools that run in Botkins on a Mac, switched there only: iMessage and Mail. Missing on an older computer or one that isn't a Mac. */
  macTools?: { imessage?: DeviceLevel; mail?: DeviceLevel };
};
/**
 * One limit of a provider's plan, as the provider reports it. `percentRemaining` is 0 to 100 and is
 * absent when the provider doesn't say: never a guess. `resetAt` is in milliseconds. `unlimited`
 * is an allowance the provider says has no limit (no percent, no bar). `model` is set when the limit
 * counts one model only. `used` and `limit` are the counts behind the percent, where the provider
 * gives them. `primary` marks the one limit to show where there is room for one.
 */
export type ProviderLimit = {
  id: string;
  label: string;
  percentRemaining?: number;
  percentUsed?: number;
  resetAt?: number;
  primary?: boolean;
  window?: "session" | "week" | "month";
  model?: string;
  used?: number;
  limit?: number;
  unit?: "requests" | "credits";
  unlimited?: boolean;
};
/**
 * A connected provider's plan and what is left of its limits (needs "provider-usage-v1"; the shape
 * is the desktop app's docs/PROVIDER_USAGE.md). The computer reads these from the provider with the
 * sign-in it already has; the phone only shows them. An API-key account has no plan limits.
 * `error` is one sentence when the lookup failed; `limits` may then be the last ones known, as old
 * as `updatedAt` says. `note` is one sentence when there is nothing to show and nothing went wrong.
 * `credits` is a bought balance, where the provider has one.
 */
export type ProviderUsage = {
  provider: string;
  name?: string;
  plan?: string;
  account?: "subscription" | "api-key";
  limits: ProviderLimit[];
  updatedAt?: number;
  error?: string;
  source?: string;
  note?: string;
  credits?: { label: string; amount: number; unit: string };
};
/** A file the computer hands over for the phone to share or save: its text, or base64 when it is not text (a zip, a PDF). */
export type SharedFile = { name: string; text: string } | { name: string; base64: string };
/** What a wiki export would hold. `why` says how a page came in: it is the start, it is linked from it, or one step further. */
export type WikiExportPlan = { title: string; pages: { path: string; title: string; section: string; why: "start" | "linked" | "related" }[] };
export type WikiExportFormat = "zip" | "html" | "pdf";
/**
 * The folders inside one folder on the computer, by name only. `parent` is null at the top of a place.
 * `roots` lists the places when there is more than the home folder (a plugged-in disk is one);
 * `more` says the list was cut.
 */
export type FolderList = { path: string; parent: string | null; folders: { name: string; path: string }[]; more?: true; roots?: { name: string; path: string }[] };
/**
 * Something a bot made or was given ("artifacts-v1"): a file it wrote, a picture or sound it sent,
 * an upload the person gave it, an export. The computer keeps the index. `chatId`, `chatTitle` and
 * `messageIndex` are there only when it belongs to a chat; `messageIndex` (from 0) only when the
 * message is known. `size` is null for a folder.
 */
export type Artifact = {
  id: string;
  botId: string;
  chatId?: string;
  chatTitle?: string;
  /** Where it is on the computer. Shown, never used to read it: reading goes by `id`. */
  path: string;
  name: string;
  kind: "file" | "folder" | "image" | "video" | "audio";
  mime: string;
  size: number | null;
  time: number;
  source: "tool" | "media" | "upload" | "export";
  messageIndex?: number;
};
/** A page of artifacts, newest first. `nextCursor` asks for the page after it; null at the end. */
export type ArtifactPage = { items: Artifact[]; nextCursor: string | null };
/** A piece of a file, as base64. `nextOffset` is where the next piece starts; null at the end. A folder has no data. */
export type ArtifactChunk = { artifact: Artifact; data: string; encoding: "base64"; offset: number; nextOffset: number | null };
export type UsageTotals = { turns: number; input: number; output: number; cacheRead: number; cost: number; priced: number };
export type UsageReport = {
  days: number;
  totals: UsageTotals;
  byDay: (UsageTotals & { date: string })[];
  byModel: (UsageTotals & { model: string })[];
  byBot: (UsageTotals & { botId: string; name: string })[];
};

/**
 * `capabilities` names what this computer's link can do beyond the basics: "credentials-v1",
 * "screen-v1", "prs-v1", "uploads-v1", "relay-v1" (the computer keeps a relay open, so a phone away
 * from its network can reach it), "push-v1" (notifications and Live Activities), "device-v1" (tools
 * that run on a phone), "voice-v1" (speech through the computer's providers, and live voice),
 * "frames-v1" (custom views: the page of an html block, for the phone to draw),
 * "provider-usage-v1" (each provider's plan and what is left of its limits),
 * "devices-v1" (the list of paired devices, and renaming and removing one),
 * "side-pane-v1" (a bot can open a pane beside a chat: a custom view, a table, a website, the screen),
 * "adoptMcpSignIn", and what the computer's app supports itself: "looks-v2" (eyes and custom colors),
 * "routine-delivery-v1" (where a routine's result lands, and whether it notifies), "models-v2"
 * (context window and other model details), "files-v1" (a file out or in without a dialog on the
 * computer: a template, the usage table, a wiki export), "folders-v1" (the folder browser, and
 * choosing a folder from it), the link's own "maintenance-v1" (clear the cache, and the
 * computer's own test notification), and "screen-grant-v1" (a headless host: a phone may set what
 * phones may do with its screen), and the app's "artifacts-v1" (what a bot made or was given: a
 * list, a file in pieces, a small picture of it, and the paths written in a chat), and the app's
 * "secure-input-v1" (a bot asks for a password, a code or another secret in a request of kind
 * "secure": the value goes to the computer only, and the bot gets a handle, never the value).
 * "turn-timeline-v1" (a turn in the order it happened: text before a step, a steer or a request
 * as interim messages, answers to requests as messages, a time on every reply, each helper's own
 * steps marked, and how a turn ended; docs/turn-timeline.md).
 * "plugins-v1" (the app's: plugins from GitHub's catalogs, other marketplaces or a folder on the
 * computer, each adding skills, tools, hooks, agents and commands to the person's bots; the part
 * `plugins` and the calls `plugins.*`; docs/plugins.md).
 */
export type Meta = {
  app: string;
  version: string;
  platform: string;
  name: string;
  serverId: string;
  protocol: number;
  capabilities: string[];
  you?: { kind: "owner" } | { kind: "member"; memberId: string; name: string };
};

/** Everything the phone keeps in step with the desktop, by part name. */
export type Parts = {
  meta: Meta;
  settings: Preferences;
  bots: Bot[];
  sections: Section[];
  chats: ChatSummary[];
  live: Live;
  runs: RunSummary[];
  panels: Panel[];
  board: BoardItem[];
  tasks: BotTask[];
  projects: Project[];
  mcp: McpServer[];
  skills: { folders: { id: string; path: string }[]; plugins: { id: string; path: string }[]; disabled: string[] };
  templates: BotTemplate[];
  /** Each number goes up when what it names changes. `artifacts` (what bots made, "artifacts-v1") is missing on a computer without that index. */
  revs: { wiki: number; providers: number; artifacts?: number };
  /** The credentials saved or linked on the computer (never their values). */
  credentials?: Credential[];
  /** Choices made on the computer about what phones may do. */
  host?: HostPart;
  /** What the computer keeps for each paired phone, by the phone's device id (`push-v1`, `device-v1`). */
  phones?: Record<string, PhoneRecord>;
  /** What bots are asking phones for right now (`device-v1`). A phone answers the ones addressed to it. */
  asks?: DeviceAsk[];
  /** Speech settings, shared by the computer and every phone (`voice-v1`). Never a key. */
  voice?: VoiceSettings;
  /** The plugins installed on the computer (`plugins-v1`). A secret field says only whether it is set. */
  plugins?: InstalledPlugin[];
  /** The full team for an owner device, or this member's team identity. Needs "teams-v1". */
  team: TeamPart;
};

// ---------------------------------------------------------------------------------------------
// Plugins (capability "plugins-v1"; the contract is docs/plugins.md). A plugin adds skills, tools
// (MCP servers), hooks, agents and commands to the person's bots. The computer reads the catalogs;
// a phone never fetches them itself, and never receives a secret field's value.

/** A catalog of plugins: one of GitHub's two (`builtIn`), or one the person added. */
export type PluginMarketplace = {
  /** Its name from marketplace.json, e.g. "awesome-copilot". */
  id: string;
  /** Shown: "GitHub", "Copilot plugins", or the catalog's own name. */
  name: string;
  /** "github/awesome-copilot", a URL, or "Folder on your computer". */
  source: string;
  /** GitHub's two; can't be removed. */
  builtIn: boolean;
  count?: number;
  updatedAt?: number;
  /** A sentence when it couldn't be read. */
  error?: string;
};

/** A plugin in a catalog. `id` is opaque: never read anything out of it; show `name` and `marketplace`. */
export type PluginListing = {
  id: string;
  name: string;
  /** PluginMarketplace.id, or "folder". */
  marketplace: string;
  description?: string;
  version?: string;
  author?: string;
  /** https only. */
  homepage?: string;
  /** https only. */
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

/** What a plugin adds. A hook's command is as written, at most 300 characters. */
export type PluginContents = {
  skills: string[];
  agents: string[];
  commands: string[];
  /** `serverId` (an installed plugin's tool with OAuth): the tool server to sign in with "signInMcpServer". */
  mcpServers: { name: string; kind: "local" | "remote"; command?: string; url?: string; oauth?: true; serverId?: string }[];
  hooks: { event: PluginHookEvent | (string & {}); command: string }[];
  lspServers?: string[];
};

/** One of a plugin's settings: a `userConfig` entry, or a `${NAME}` in its tool and hook files. */
export type PluginField = {
  /** The placeholder or userConfig name, e.g. "HINDSIGHT_API_KEY". */
  key: string;
  /** userConfig's title, or the key made readable: "Hindsight API key". */
  label: string;
  description?: string;
  secret: boolean;
  /** userConfig's `required`; a placeholder is required. */
  required: boolean;
  /** Never for a secret. */
  default?: string;
};

/** A plugin read before install: what it adds, its settings, and what it runs, in sentences. */
export type PluginPreview = PluginListing & {
  contents: PluginContents;
  config: PluginField[];
  postInstallMessage?: string;
  /** Sentences: "Runs a command on your computer at each prompt." */
  warnings?: string[];
  /** What was read, as an opaque tag. Install and update send it back; the computer refuses when the plugin changed since. */
  revision?: string;
};

/** A plugin installed on the computer, as the part `plugins` holds it. */
export type InstalledPlugin = PluginListing & {
  installed: true;
  /** On at all. */
  enabled: boolean;
  /** Which bots use it. */
  bots: "all" | string[];
  contents: PluginContents;
  /** `value` only for a field that is not secret. */
  config: (PluginField & { set: boolean; value?: string })[];
  status: "ready" | "needs-config" | "needs-sign-in" | "error";
  /** A sentence for needs-sign-in and error. */
  detail?: string;
  /** "Hooks run only for bots on the Copilot SDK." */
  limits?: string;
  updateAvailable?: true;
  /** A folder plugin's path on the computer, to show. */
  folder?: string;
  installedAt: number;
};

/** A plugin setting's value as a phone sends it: text, a saved credential the computer fills in, or null to clear it. */
export type PluginConfigValue = string | CredentialRef | null;

// ---------------------------------------------------------------------------------------------
// Notifications (capability "push-v1"). The computer sends them through the relay's push route;
// what a notification says is sealed for the phone, so the relay and Apple carry no message text.

/** What a phone wants to be told about. `previews` off shows "New message" with no text. */
export type PushPrefs = { replies: boolean; requests: boolean; routines: boolean; previews: boolean; activities: boolean };
/** Where Apple delivers for this phone. `start` is the token that can start a Live Activity (iOS 17.2 or later). */
export type PushTarget = { token: string; env: "production" | "sandbox"; start?: string };
/** A paired phone as the computer knows it. Tokens stay on the computer and are not in here. */
/**
 * A device paired with the computer (`devices-v1`, "link.devices.list"): a phone, or another
 * computer's Botkins app that uses this one. `connected` is true while it was heard from in the last
 * minute and a half. `current` marks the device that asked. Never a key or a notification address.
 */
export type PairedDevice = { id: string; name: string; platform: string; kind: "phone" | "desktop"; createdAt: number; lastSeenAt: number; connected: boolean; current?: boolean };
export type PhoneRecord = {
  name: string;
  /** What the device is. Missing on an older computer, where every paired device is a phone. */
  kind?: "phone" | "desktop";
  platform?: string;
  /** The computer keeps this phone's presence key: it paired directly, with a build that has one ("screen-grant-v1"). */
  presence?: true;
  /** Notifications are set up for this phone. */
  push?: PushPrefs;
  /** What bots may use on this phone, by source. */
  sources?: DeviceSources;
};
/** What a Live Activity shows for a chat's running turn. */
/** What a chat's Live Activity shows. `startedAt` and `finishedAt` are in seconds; `finishedAt` is there once the turn is over. */
export type ActivityState = { phase: "thinking" | "working" | "waiting" | "needs-you" | "done" | "failed"; label: string; steps: number; startedAt: number; finishedAt?: number };

// ---------------------------------------------------------------------------------------------
// Device access (capability "device-v1"): tools a bot can call that run on a paired phone.

export type DeviceSource = "calendar" | "contacts" | "health" | "location" | "photos" | "mail";
/** off: bots can't use it. read: look only. interact: look, and add or change. */
export type DeviceLevel = "off" | "read" | "interact";
export type DeviceSources = Partial<Record<DeviceSource, DeviceLevel>>;
/** One call of a phone tool, waiting for the phone named in `deviceId` to answer it. */
export type DeviceAsk = { id: string; deviceId: string; tool: string; args: Record<string, unknown>; at: number; botId?: string; chatId?: string };
/** A phone's answer: `result` is what the bot gets (it must be JSON, and small); `error` is one plain sentence. */
export type DeviceAnswer = { ok: true; result: unknown } | { ok: false; error: string };

// ---------------------------------------------------------------------------------------------
// Voice (capability "voice-v1"). Keys stay on the computer. See link-host/VOICE.md.

export type SttProvider = "device" | "openai" | "azure" | "elevenlabs" | "custom" | "local";
export type TtsProvider = "device" | "openai" | "azure" | "elevenlabs" | "gemini" | "custom" | "local";
export type LiveProvider = "codex" | "openai" | "gemini" | "elevenlabs";
export type VoiceKeyProvider = "openai" | "azure" | "elevenlabs" | "gemini" | "custom";
export type LocalVoiceModel = { id: string; name: string; kind: "stt" | "tts"; installed: boolean; sizeMB?: number; voices?: { id: string; name: string }[] };
export type VoiceSettings = {
  /** "device" is the phone's or the computer's own speech, and the default. */
  stt: { provider: SttProvider; model?: string; language?: string };
  /** `auto` reads replies aloud. `speed` runs from 0.5 to 2. */
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
export type VoicePatch = { stt?: Partial<VoiceSettings["stt"]>; tts?: Partial<VoiceSettings["tts"]>; live?: Partial<VoiceSettings["live"]>; providers?: { openai?: { baseUrl?: string }; azure?: Partial<Omit<VoiceSettings["providers"]["azure"], "hasKey">>; elevenlabs?: { agentId?: string }; custom?: { baseUrl?: string } } };
export type VoiceOptions = { models: { id: string; name: string }[]; voices: { id: string; name: string; language?: string; preview?: string }[] };
/**
 * What a phone tells the computer about itself for a live call. `place` is at most 120 characters;
 * coordinates come as a pair, rounded to two decimals. Never logged.
 */
export type LiveContext = { location?: { place?: string; latitude?: number; longitude?: number } };
/** A tool the live voice may call. The phone runs it and sends the result back itself. */
export type LiveTool = { name: string; description: string; parameters: Record<string, unknown> };
/**
 * A live voice session the computer set up. "webrtc": the answer to the phone's offer (the computer
 * dealt with the provider, so no secret reaches the phone). The others are a socket to open with a
 * short-lived token in its address or beside it, and the first message to send on it.
 */
export type LiveSession =
  | { id: string; kind: "webrtc"; sdp: string }
  | { id: string; kind: "openai-ws"; url: string; token: string; expiresAt: number; session: Record<string, unknown> }
  | { id: string; kind: "gemini-ws"; url: string; expiresAt: number; setup: Record<string, unknown>; input: { sampleRate: number }; output: { sampleRate: number } }
  | { id: string; kind: "elevenlabs-ws"; url: string; init: Record<string, unknown>; input: { sampleRate: number }; output: { sampleRate: number } };

/** The desktop's calls a phone may make (link-host/methods.mjs), with their arguments and answers. */
export type Calls = {
  setPreferences(patch: Partial<Omit<Preferences, "model" | "appearance" | "providers">> & { appearance?: Partial<Appearance> }): void;
  appInfo(): { version: string; electron: string; chrome: string; platform: string };
  addBot(bot: BotInput): string;
  updateBot(id: string, patch: Partial<Pick<Bot, "role" | "instructions" | "name" | "clarificationInstructions" | "summary" | "avatar">>): void;
  setBotFlags(id: string, flags: Partial<Pick<Bot, "pinned" | "hidden" | "sectionId" | "teamwork">>): void;
  makePrimary(id: string): void;
  reorderBots(ids: string[]): void;
  deleteBot(id: string): void;
  duplicateBot(id: string): string;
  setBotAccess(botId: string, grant: BotAccessGrant): void;
  setBotIntegrations(botId: string, off: { skillsOff?: string[]; mcpOff?: string[] }): void;
  botMemory(botId: string): string;
  setBotMemory(botId: string, text: string): void;
  saveTemplate(botId: string, name?: string): string;
  deleteTemplate(id: string): void;
  /** A template, or a bot as one, as the text of its file. Needs "files-v1". */
  exportTemplateText(target: { templateId: string } | { botId: string }): SharedFile;
  /** Makes a template from a shared file's text and answers its id. Needs "files-v1". */
  importTemplateText(file: { name?: string; text: string }): string;
  createChat(botId: string): string;
  createGroupChat(botIds: string[], title?: string): string;
  setChatFlags(id: string, flags: Partial<Pick<ChatSummary, "pinned" | "archived" | "unread">>): void;
  renameChat(id: string, title: string): void;
  deleteChat(id: string): void;
  forkChat(chatId: string, messageIndex: number): string;
  warmChat(chatId: string): void;
  startProjectChat(botIds: string[], projectId: string, mode?: ChatMode): string;
  /** While the chat works, `delivery: "steer"` hands the message to the turn under way where the provider can take it (the desktop app's default), and "queue" keeps it for after. */
  send(chatId: string, text: string, options?: { quote?: string; mentions?: MentionInput[]; attachments?: { name: string; path: string }[]; delivery?: "steer" | "queue" }): void;
  mentionables(chatId: string | undefined, botId?: string): Mentionables;
  catalog(botId: string, chatId?: string, refresh?: boolean): Catalog;
  stop(chatId: string): void;
  unqueue(chatId: string, itemId: string): void;
  sendNow(chatId: string, itemId: string): void;
  retry(runId: string): void;
  compact(chatId: string): void;
  sideQuestion(chatId: string, question: string): string;
  /** A value (or a form field's value) may be a CredentialRef: the computer fills the secret in. */
  respond(requestId: string, answer: { action: string; value?: string | CredentialRef; content?: Record<string, unknown> }): void;
  clearApprovals(chatId?: string): void;
  models(): ModelInfo[];
  setModel(scope: "global" | "bot" | "chat", id: string | null, value: ModelChoice | null): void;
  providers(refresh?: boolean): ProviderStatus[];
  setProviderEnabled(id: string, enabled: boolean): void;
  signIn(providerId?: string): void;
  cancelSignIn(providerId?: string): void;
  signOut(providerId?: string): void;
  providerServices(id: string, query?: string): ProviderService[];
  connectProviderService(id: string, serviceId: string, how: { key: string } | { method: string }): { done?: boolean; instructions?: string; code?: { attempt: string; instructions: string } };
  disconnectProviderService(id: string, serviceId: string): void;
  createRoutine(input: RoutineInput): string;
  updateRoutine(id: string, patch: Partial<Omit<RoutineInput, "botId">>): void;
  setRoutineEnabled(id: string, enabled: boolean): void;
  deleteRoutine(id: string): void;
  runRoutine(id: string): void;
  duplicateRoutine(id: string, botId: string): string;
  previewCadence(cadence: Cadence, timezone?: string): { nextAt: number | null; summary: string; timezone: string };
  saveTask(task: TaskInput): string;
  moveTask(id: string, status: TaskStatus | "archived"): void;
  startTask(id: string): void;
  deleteTask(id: string): void;
  refreshPanel(id: string): void;
  changePanel(id: string, action: "delete" | "hide" | "show" | "small" | "wide" | "tall" | "earlier" | "later"): void;
  boardAct(id: string, action: "read" | "unread" | "clear" | "done" | "reopen" | "yes" | "goal" | "notToday" | "up" | "down" | "delete", value?: string): string | undefined;
  skills(): { skills: SkillInfo[] };
  readSkill(name: string): SkillDetail;
  saveSkill(skill: { name: string; description: string; instructions: string; original?: string }): string;
  removeSkill(name: string): void;
  setSkillEnabled(name: string, enabled: boolean): void;
  saveMcpServer(server: McpServerInput): string;
  setMcpServerEnabled(id: string, enabled: boolean): void;
  removeMcpServer(id: string): void;
  testMcpServer(id: string): { status: string; tools: string[] };
  signInMcpServer(id: string): McpAuth;
  cancelMcpSignIn(id: string): boolean;
  signOutMcpServer(id: string): void;
  createProject(input: { name?: string; description?: string; color?: ProjectColor | null }): string;
  /** `folder: null` unlinks the project's folder (the folder itself is left alone). */
  updateProject(id: string, patch: { name?: string; description?: string; color?: ProjectColor | null; folder?: string | null }): void;
  /** The folders inside `path`, or inside the home folder. Needs "folders-v1". */
  listFolders(path?: string): FolderList;
  /** A project for a folder chosen in the folder browser (or the one it already has); answers its id. Needs "folders-v1". */
  addProjectFolder(path: string): string;
  removeProject(id: string): void;
  addTodo(projectId: string, text: string): string;
  updateTodo(projectId: string, todoId: string, patch: { text?: string; done?: boolean }): void;
  deleteTodo(projectId: string, todoId: string): void;
  usage(days: number): UsageReport;
  /** The usage table of 7, 30 or 90 days as the text of a .csv file. Needs "files-v1". */
  exportUsageText(days: number): SharedFile;
  // The calls below were always allowed to a phone; they got their types when the phone got their screens.
  /** Agents in the providers' own tools that can become bots, and making bots of some of them (answers the new bots' ids). */
  importableAgents(): ImportableAgent[];
  importAgents(keys: string[]): string[];
  /** Sections group bots in a list. */
  addSection(name: string): string;
  renameSection(id: string, name: string): void;
  deleteSection(id: string): void;
  renameTemplate(id: string, name: string): void;
  /** Changes the project and mode of a chat that has no messages yet. */
  setChatProject(chatId: string, projectId: string | null, mode?: "default" | "plan" | "yolo"): void;
  linkPreview(url: string): LinkPreview | null;
  /** Pauses, resumes or deletes a schedule a bot made in a chat. */
  changeSchedule(chatId: string, id: number, action: "pause" | "resume" | "delete"): void;
  /** A Today panel's own routine: when it refreshes itself, and with what instructions. */
  routine(panelId: string, data: { action: "set" | "pause" | "resume" | "remove"; cron?: string; prompt?: string; timezone?: string }): void;
  /** Adds tool servers from pasted JSON (the `mcpServers` shape other apps use). */
  importMcpServers(json: string): { added: string[]; skipped: string[] };
  /** The second step of connecting a model service that gives a code to type in. */
  finishProviderService(id: string, serviceId: string, attempt: string, code: string): { done: boolean };
  cancelProviderService(id: string, serviceId: string): void;
  /** Stops using a linked skills folder or plugin (the folder itself is left alone). */
  removeSkillFolder(id: string): void;
  /** Adds a skill, a plugin or a folder of skills from a folder chosen in the folder browser. Needs "folders-v1". */
  addSkillFolderAt(path: string): { kind: "skill" | "plugin" | "folder"; name: string; count?: number };
  renameProject(id: string, name: string): void;
  /** What changed in a project's folder, one file's changes as text, and committing all of it. */
  projectChanges(id: string): ProjectChanges;
  projectDiff(id: string, file: string): { text: string; truncated: boolean };
  projectCommit(id: string, message: string): string;
  moveTodo(projectId: string, todoId: string, delta: -1 | 1): void;
  /** Makes the wiki page for a project that has none yet; answers the page's path. */
  createWikiPageFor(record: { kind: "project"; id: string }): string;
  cacheInfo(): { bytes: number; catalogs: number };
  /** A bot's artifacts, newest first, 50 a page. `folder` (a folder artifact's id) lists what is directly in it. Needs "artifacts-v1". */
  "artifacts.list"(query: { botId: string; chatId?: string; kind?: "files" | "media"; folder?: string; cursor?: string }): ArtifactPage;
  /** A piece of an artifact (512 KiB at most), by its id. */
  "artifacts.read"(id: string, options?: { offset?: number; length?: number }): ArtifactChunk;
  /** A small picture of an image or a video (its long edge `size`, 160 unless said, 512 at most), or null when the computer can't make one. */
  "artifacts.thumbnail"(id: string, options?: { size?: number }): { data: string; mime: string } | null;
  /** The artifacts behind paths written in a chat's messages, in the order asked (20 at most). Null: not available. */
  "artifacts.resolve"(query: { chatId: string; paths: string[] }): { items: (Artifact | null)[] };
  /** Clears the workspace cache. Chats, bots, panels and routines stay. Needs "maintenance-v1". */
  clearCache(): void;
  /** Shows a test notification on the computer. Needs "maintenance-v1". */
  testNotification(): void;
  /** What the computer's vault holds, never a value. The phone reads only `redirectUrl`: the address a tool's own OAuth app registers. */
  credentials(): { redirectUrl?: string };
  /** What the person does with a chat's side pane: choose a tab, remove or pin one, or say the pane was closed or opened. Needs "side-pane-v1". */
  sidePane(chatId: string, action: "select" | "remove" | "pin" | "unpin" | "closed" | "opened", panelId?: string): void;
  /** Each connected provider's plan and limits. `refresh` asks the computer to read the providers again now. */
  providerUsage(options?: { refresh?: boolean }): ProviderUsage[];
  // ---- Plugins ("plugins-v1", docs/plugins.md)
  "plugins.marketplaces"(): PluginMarketplace[];
  /** `owner/repo`, `owner/repo#ref`, an https URL, or a folder path. */
  "plugins.addMarketplace"(source: string): PluginMarketplace;
  /** Not a built-in one. Installed plugins stay. */
  "plugins.removeMarketplace"(id: string): void;
  /** 50 a page, by name. `query` matches name, description and keywords. */
  "plugins.browse"(query: { marketplace?: string; query?: string; cursor?: string }): { plugins: PluginListing[]; cursor?: string };
  /** Reads the plugin's manifest and files before install. */
  "plugins.preview"(id: string): PluginPreview;
  /** `bots` is "all" (the default) or bot ids. `config` as in "plugins.configure". */
  "plugins.install"(id: string, options?: { bots?: "all" | string[]; config?: Record<string, PluginConfigValue>; revision?: string }): InstalledPlugin;
  /** A folder on the computer, chosen in the folder browser ("folders-v1"). */
  "plugins.addFolder"(path: string): InstalledPlugin;
  /** `null` clears a value. A secret is kept in the computer's vault. */
  "plugins.configure"(id: string, values: Record<string, PluginConfigValue>): void;
  "plugins.setBots"(id: string, bots: "all" | string[]): void;
  "plugins.setEnabled"(id: string, on: boolean): void;
  /** `revision` is the preview's the person reviewed; the computer refuses another. */
  "plugins.update"(id: string, options?: { revision?: string }): InstalledPlugin;
  "plugins.uninstall"(id: string): void;
  "link.messages"(chatId: string, before: number, limit?: number): ChatDetail | null;
  "link.unpair"(): boolean;
  /** Sends a file to the computer for the next message. `data` is base64, at most about 3 MB a call; a larger file goes in parts with the same `id`. */
  /** The devices paired with the computer. Needs "devices-v1". */
  "link.devices.list"(): PairedDevice[];
  /** Renames a paired device (this one or another). Answers the list as it is afterwards. */
  "link.devices.rename"(id: string, name: string): PairedDevice[];
  /** Removes a paired device: it can't reach the computer any more. Removing this device is unpairing. Answers the devices that are left. */
  "link.devices.remove"(id: string): PairedDevice[];
  // ---- Teams ("teams-v1")
  "link.team.get"(): Extract<TeamPart, { roles: Role[] }>;
  "link.team.saveRole"(role: Role): Extract<TeamPart, { roles: Role[] }>;
  "link.team.deleteRole"(id: string): Extract<TeamPart, { roles: Role[] }>;
  "link.team.saveGroup"(group: Group): Extract<TeamPart, { roles: Role[] }>;
  "link.team.deleteGroup"(id: string, moveTo?: string): Extract<TeamPart, { roles: Role[] }>;
  "link.team.createInvite"(input: { groupId: string; days: 1 | 7 | 30; maxUses: 1 | 5 | 25 }): Invite & { link: string };
  "link.team.revokeInvite"(id: string): Extract<TeamPart, { roles: Role[] }>;
  "link.team.approve"(requestId: string, groupId?: string): Extract<TeamPart, { roles: Role[] }>;
  "link.team.deny"(requestId: string): Extract<TeamPart, { roles: Role[] }>;
  "link.team.moveMember"(memberId: string, groupId: string): Extract<TeamPart, { roles: Role[] }>;
  "link.team.removeMember"(memberId: string): Extract<TeamPart, { roles: Role[] }>;
  "link.team.rename"(name: string): Extract<TeamPart, { roles: Role[] }>;
  /** A custom view (an html block) as its bot wrote it, and its data. Needs "frames-v1". */
  "link.frame.page"(frame: string): { html: string; data: unknown };
  /** The chat a custom view's answer goes to, for a view in a Today panel. */
  "link.frame.chat"(frame: string): { chatId: string | null };
  "link.upload"(file: { id?: string; name: string; data: string; last?: boolean }): UploadedFile;
  /** Pull requests of the repository behind a chat's project. `available: false` says why there are none to offer. */
  "link.pullRequests"(where: { chatId?: string; projectId?: string }, query?: string): { available: boolean; reason?: string; items: PullRequest[] };
  "link.credentials.save"(input: CredentialInput): string;
  "link.credentials.remove"(id: string): void;
  /** Whether a credential can be read right now. Never returns the value. */
  "link.credentials.check"(id: string): { ok: boolean; message?: string };
  "link.credentials.managers"(refresh?: boolean): PasswordManagerStatus[];
  "link.credentials.unlock"(manager: PasswordManagerId, secret: { password: string }): PasswordManagerStatus;
  "link.credentials.lock"(manager: PasswordManagerId): PasswordManagerStatus;
  "link.credentials.vaults"(manager: PasswordManagerId): PasswordManagerVault[];
  "link.credentials.items"(manager: PasswordManagerId, vaultId: string, query?: string): PasswordManagerItem[];
  /** One item with its fields (labels only), to choose which field to link. */
  "link.credentials.item"(manager: PasswordManagerId, vaultId: string, itemId: string): PasswordManagerItem;
  /** Links a field of a password manager item as a credential. Returns the new credential's id. */
  "link.credentials.link"(input: { manager: PasswordManagerId; vaultId: string; itemId: string; fieldId: string; name: string }): string;
  "link.screen.info"(): ScreenInfo;
  /** The newest picture of a display. With `after`, waits a moment for a change and leaves `jpeg` out when there is none. */
  "link.screen.frame"(options: { display?: string; maxWidth?: number; quality?: number; after?: number }): ScreenFrame;
  "link.screen.input"(display: string, events: ScreenInput[]): void;
  /** The phone stopped watching. */
  "link.screen.stop"(): void;
  /**
   * Setting what phones may do with the screen, from a phone ("screen-grant-v1": a headless host only,
   * a phone only, over a direct connection only). `begin` answers a ticket; `confirm` takes it back
   * with the phone's signature over it, made after Face ID or the passcode; `revoke` turns the screen off.
   */
  "link.screen.grant.begin"(level: "view" | "control"): ScreenTicket;
  "link.screen.grant.confirm"(ticket: string, signature: string): { screen: ScreenMode };
  "link.screen.revoke"(): { screen: "off" };
  /** Saves the Botkin a bot is shown as. It is kept on the computer, so every paired phone sees it. */
  "link.setLook"(botId: string, look: BotkinLook): void;
  // ---- Notifications ("push-v1")
  /** Where Apple delivers for this phone, and what it wants to hear about. Turns notifications on. */
  "link.push.register"(target: PushTarget, prefs?: Partial<PushPrefs>): void;
  "link.push.prefs"(prefs: Partial<PushPrefs>): void;
  /** Turns notifications off for this phone and forgets its tokens. */
  "link.push.unregister"(): void;
  /** The app is in front (`chatId`: the chat on screen) or went to the background. A phone that is in front gets no notification for what it is showing. */
  "link.push.presence"(active: boolean, chatId?: string): void;
  /** The token Apple gave for the Live Activity of a chat's running turn; null when it ended. */
  "link.push.activity"(chatId: string, token: string | null): void;
  /** Sends one notification to this phone, to see that it arrives. */
  "link.push.test"(): void;
  // ---- Device access ("device-v1")
  /** What bots may use on this phone. The phone holds the switches; the computer offers bots the matching tools. */
  "link.device.sources"(sources: DeviceSources): void;
  /** This phone's answer to one of `Parts.asks`. */
  "link.device.answer"(id: string, answer: DeviceAnswer): void;
  /** The file an ask sends along (a picture to save), as base64. Only for the phone the ask is addressed to, while it is open. */
  "link.device.file"(id: string): { name: string; data: string };
  // ---- Voice ("voice-v1")
  "link.voice.set"(patch: VoicePatch): void;
  /** Saves a provider's key on the computer (a string, or a saved credential), or removes it with null. It is never sent back. */
  "link.voice.key"(provider: VoiceKeyProvider, key: string | { $credential: string } | null): void;
  /** The models and voices a provider offers. */
  "link.voice.options"(kind: "stt" | "tts" | "live", provider: string): VoiceOptions;
  /** Speech to text on the computer's provider. `audio` is base64, at most about two minutes of 16 kHz WAV. */
  "link.voice.transcribe"(input: { audio: string; format: "wav" | "m4a" | "mp3" | "webm"; language?: string }): { text: string };
  /** Text to speech on the computer's provider: base64 audio to play. At most 4,000 characters; split long text by sentence. */
  "link.voice.speak"(input: { text: string; voice?: string; speed?: number }): { audio: string; format: "mp3" | "wav" };
  /** Sets up a live voice session for a chat with a bot. `sdp` is this phone's WebRTC offer, for the providers that use WebRTC. */
  /**
   * `context` is what the phone says about itself for the voice: roughly where the person is, only
   * when Location is on in Device access. The computer adds the chat so far and what its app knows
   * (`backend.liveContext({ chatId, botId })` → `{ userName?, identity?, user? }`, each a string).
   */
  "link.voice.live"(input: { chatId: string; botId: string; provider?: LiveProvider; sdp?: string; context?: LiveContext }): LiveSession & { tools: LiveTool[] };
  "link.voice.endLive"(id: string): void;
  /** Hands the desktop a sign-in the phone finished, for an MCP server that signs in with OAuth. */
  "link.adoptMcpSignIn"(serverId: string, grant: { clientId: string; accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string; redirectUri: string }): { status: string; tools: string[] };
  // ---- The wiki. Paths are relative to the wiki and use "/". Every change bumps revs.wiki.
  wikiTree(): WikiTree;
  /** What an export of the whole wiki, or of one page and the pages around it, would hold. Needs "files-v1". */
  wikiExportPlan(request: { scope: "all" | "project" | "page"; path?: string }): WikiExportPlan;
  /** The export as a file: a zip of Markdown, one web page, or a PDF. At most 4 MB. Needs "files-v1". */
  exportWikiFile(request: { format: WikiExportFormat; paths: string[]; title?: string; everything?: boolean }): SharedFile;
  /** One page with its text. Also reads "index.md" (the catalog) and "log.md" (the change log). */
  wikiPage(path: string): WikiPage;
  /**
   * Saves a page's Markdown. With `base`, fails with a message containing "changed while you were editing"
   * when the page changed since it was read; save again without `base` to overwrite.
   */
  saveWikiPage(path: string, content: string, base?: string): WikiPage;
  /** A new page from the folder's template ("" is the top of the wiki). Returns its path. */
  createWikiPage(input: { folder: string; title: string }): string;
  /** A new section, or a folder inside `parent`. The name becomes a lower-case folder name. Returns its path. */
  createWikiFolder(input: { parent: string; name: string }): string;
  /** Moves or renames a page or a folder. Links to the moved pages follow. Returns the new path. */
  moveWiki(from: string, to: string): string;
  /** Removes a page, or a folder with everything in it. Removed pages are kept in the wiki folder's .trash. */
  deleteWiki(path: string): void;
  searchWiki(query: string): { path: string; title: string; snippet: string }[];
  wikiHistory(path: string): WikiVersion[];
  /** The Markdown of an earlier version. */
  wikiVersion(path: string, id: string): string;
  restoreWikiVersion(path: string, id: string): WikiPage;
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
/** An earlier version: the page as it was until `by` changed it at `time`. */
export type WikiVersion = { id: string; time: number; by: string };
