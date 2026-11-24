// The desktop's data, as the phone sees it. These mirror the desktop app's own types
// (desktop/src/types.ts); a chat arrives as a summary and its messages come separately.
import type { ProtonCalls, ProtonStatusFields } from "./proton-pass";
type LinkProtonCall<K extends keyof ProtonCalls> = (...args: Parameters<ProtonCalls[K]>) => Awaited<ReturnType<ProtonCalls[K]>>;

export type SkillUpload = { filename: string; data: string; replace?: string[] };
export type SkillImportResult = { added: string[]; conflicts: string[] };
export type CatalogSkill = { id: string; source: string; skillId: string; name: string; installs: number; available: boolean; installed?: string };
/** Where a featured skill comes from: its repository at a pinned commit, its license and who wrote it. */
export type SkillSource = { author: string; license: string; repo: string; commit: string; path: string; url: string; pack?: string };
export type CatalogPreview = { name: string; description: string; text: string; token: string; installed?: string; /** A featured skill's source. */ source?: SkillSource; /** A featured skill's files, the license among them. */ files?: string[] };
/** A skill on the featured shelf ("skills-featured-v1"). Its id is `owner/repo/skill@commit7`: preview and install it as a catalog skill. */
export type FeaturedSkill = SkillSource & { id: string; name: string; summary: string; group: string; installed?: string };

/** How an app of the direct apps catalog signs in ("mcp-catalog-v1"). */
export type McpCatalogAuth = "none" | "oauth" | "key";
/** An app of the direct apps catalog, with where it stands on the computer. No value of a key is ever in it. */
export type McpCatalogEntry = {
  id: string;
  name: string;
  category: string;
  categoryName: string;
  /** One line, in Botkins' words. */
  description: string;
  transport: "http" | "stdio";
  auth: McpCatalogAuth;
  /** http: the server's address. */
  url?: string;
  /** stdio: the npm package, its exact version and license, the line that runs, and the names of the values it gets. */
  package?: string;
  version?: string;
  license?: string;
  command?: string;
  env?: string[];
  /** The fields a key entry asks for, by label only. */
  keys: { id: string; label: string; hint?: string }[];
  docs: string;
  /** A letter tile: the app has no picture Botkins may show. */
  icon: { letter: string };
  /** A server on the computer that another app runs, and what it needs. */
  local?: string;
  added: boolean;
  serverId?: string;
  serverName?: string;
  enabled?: boolean;
  /** OAuth entries: signed in and not expired. */
  signedIn?: boolean;
  signingIn?: boolean;
  /** Key entries: every key is in the vault. */
  keysSet?: boolean;
  /** A program that holds this entry's keys but runs an older command: moving it to the catalog's version needs every key typed again. */
  commandChanged?: true;
};
export type McpCatalog = { entries: McpCatalogEntry[]; categories: { id: string; name: string; count: number }[] };
/** What adding an app answers: its tool server, and whether the browser sign-in (signInMcpServer) comes next. */
export type McpCatalogAdded = { serverId: string; next: "sign-in" | "done" };

export type ModelChoice = { model: string; provider?: string; source?: string; reasoningEffort?: string };
export type FastMode = "off" | "fast" | "ultrafast";
export type ModelInfo = {
  fastModes?: Partial<Record<Exclude<FastMode, "off">, string>>;
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
/** A harness that is a program of its own (Pi or OMP), as harnesses() reports it. */
export type HarnessStatus = {
  id: string;
  name: string;
  description: string;
  harness: true;
  installed: boolean;
  version?: string;
  message?: string;
  error?: string;
  install?: { url: string; command?: string };
};
/** Which of OpenAI's APIs a model is spoken to in ("keyed-providers-v1"). */
export type KeyApi = "responses" | "completions";
/** A model a person names for Azure Foundry (a deployment) or an OpenAI endpoint. */
export type KeyedModel = { id: string; name?: string; api?: KeyApi; contextWindow?: number; maxOutput?: number };
/** The settings of OpenRouter (none), Azure Foundry and an OpenAI endpoint. Never a key. */
export type KeyedConfig = { endpoint?: string; baseUrl?: string; api?: KeyApi; apiVersion?: string; models?: KeyedModel[] };
/** What the app shows for a provider that answers on a key (`ProviderStatus.keyed`; its `signIn` is "key"). */
export type KeyedProvider = {
  /** The settings this provider takes. OpenRouter: none; Azure Foundry: endpoint, apiVersion, models; an OpenAI endpoint: baseUrl, api, models. */
  fields: Array<"endpoint" | "baseUrl" | "api" | "apiVersion" | "models">;
  /** A key is kept on the computer (it is never sent back). */
  hasKey: boolean;
  /** True only for an OpenAI endpoint: a server on this computer or your own network needs no key. */
  keyOptional: boolean;
  config: KeyedConfig;
  /** What is still missing, in a sentence, or null when the provider is ready. */
  needs: string | null;
  /** Where to get a key. */
  keyUrl?: string;
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
  signIn: "browser" | "services" | "key" | null;
  signOut: boolean;
  install?: { url: string; command?: string };
  starting?: boolean;
  error?: string;
  /**
   * How a phone can sign this provider in through the computer ("provider-signin-v1"): `guided`,
   * the provider's own sign-in run on the computer, its page and code shown on the phone
   * (providerSignInStart); `token`, a token or key pasted on the phone (providerUseToken). Missing
   * on a computer without the capability.
   */
  signInWays?: { guided: boolean; token: boolean };
  /** For a provider whose signIn is "key" (OpenRouter, Azure Foundry, an OpenAI endpoint): its settings and what is missing ("keyed-providers-v1"). */
  keyed?: KeyedProvider;
};
/**
 * What a sign-in or an install run on the computer says, in order ("provider-signin-v1"): a page
 * to open with a code to type there, a page to open, a line the tool printed, or the tool waiting
 * for a line from the person (`text` may be empty when the tool asked in its own output).
 */
export type ProviderSignInEvent =
  | { n: number; type: "code"; url: string; code: string }
  | { n: number; type: "open"; url: string }
  | { n: number; type: "output"; text: string }
  | { n: number; type: "prompt"; text: string };
/** A sign-in or an install as it stands: the events after the ones already read, and how it ended. */
export type ProviderSignInView = {
  events: ProviderSignInEvent[];
  /** The number of the newest event: read on from here. */
  next: number;
  done: boolean;
  /** Why it didn't finish, in a sentence. */
  error?: string;
  /** How it finished: signed in (and as whom), or installed. */
  result?: { connected?: boolean; installed?: boolean; account?: string | null; plan?: string | null; version?: string | null };
  /** The tool waits for a line from the person (providerSignInInput). */
  wantsInput: boolean;
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
 * capabilities include "looks-v2". Drip, Orbit and Pebble were added in "botkin-heads-v2". All ten additional heads are available with "botkin-heads-v3".
 */
export type BotkinLook = { head: string; palette: string; eyes?: BotkinEyes; colors?: [string, string, string, string] };
export type BotAccessGrant = { all: boolean; projects: string[] };
export type Bot = {
  fastMode?: FastMode;
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
  /** A voice of this bot's own ("bot-voice-v1"). A field it leaves out is the same as Settings › Voice. */
  voice?: BotVoice;
  summary?: string;
  pinned?: boolean;
  hidden?: boolean;
  sectionId?: string | null;
  access?: BotAccessGrant;
  origin?: { provider: string; agent: string; file?: string };
  /** The starter this bot was made from (link-host/starters.mjs), kept after a rename. */
  starter?: string;
  /** Made from a starter that should be offered the Proactive agent (link-host/starters.mjs). */
  suggestProactive?: boolean;
};
/** `starter` names the starter the bot was made from; an older computer leaves it out. */
export type BotInput = Pick<Bot, "name" | "role" | "instructions" | "face"> & Partial<Pick<Bot, "avatar" | "summary" | "starter">>;
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
export type MemberDevice = { id: string; name: string; person?: string; kind: "phone" | "desktop"; platform: string; connected: boolean; canNotify?: boolean };
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
export type JoinRequest = { id: string; name: string; person?: string; platform: string; kind: "phone" | "desktop"; at: number; inviteId: string };
/** Someone a chat can be shared with ("team-people-v1"): the owner (id "owner", named after the computer) or a member. */
export type Person = { id: string; name: string };
export type TeamPart =
  | { name: string; roles: Role[]; groups: Group[]; members: Member[]; invites: Invite[]; requests: JoinRequest[]; people?: Person[]; /** "Members may share by link" ("spaces-v1"). */ linkSharing?: boolean }
  | {
      people?: Person[];
      linkSharing?: boolean;
      me: { memberId: string; name: string; group: { id: string; name: string }; role: { name: string; perms: Record<Scope, string[]>; bots: "all" | string[] }; devices?: MemberDevice[] };
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
  reactions?: { actor: string; emoji: string }[];
  clientMessageId?: string;
  /** One utterance in live voice, identified across partials and the final transcript. */
  voiceId?: string;
  voicePartial?: true;
  voiceCaption?: string;
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
  /** A proactive alert the bot sent on its own: the run that made it (a 👍 or 👎 on it teaches the bot). */
  proactiveRunId?: string;
  /** That alert's actions ("proactive-team-v1"): what the bot offers to do, and what the person chose. */
  alert?: ProactiveAlert;
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
export type PullRequestDetail = PullRequest & {
  body: string; createdAt: string; summary: string; review: string;
  checks: { name: string; result: string }[];
  files: { path: string; additions: number; deletions: number }[];
};
export type PullAnswer<T> = ({ available: true } & T) | { available: false; reason: string };
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
export type PasswordManagerStatus = ProtonStatusFields & {
  id: PasswordManagerId;
  name: string;
  /** ready: signed in and readable. locked: needs unlocking. signed-out: needs a sign-in on the computer. missing: its command-line tool isn't installed. */
  state: "ready" | "locked" | "signed-out" | "missing" | "error" | "installing" | "signing-in" | "expiring" | "expired";
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
  /** Specific people ("owner" or member ids) and/or device ids ("host" or paired device ids) to notify ("routine-notify-targets-v1"). */
  notifyTargets?: RoutineNotifyTargets;
  createdAt?: number;
  finishedAt?: number;
  /** A script routine's script: it runs on the computer with no model ("routine-scripts-v1"). */
  script?: string;
  /** On a script routine: after the script, the bot follows `prompt` with the script's output. */
  followUp?: boolean;
};
/** Explicit routine notification targets ("routine-notify-targets-v1"). Absent means everyone allowed. */
export type RoutineNotifyTargets = { people?: string[]; devices?: string[] };
/** Per-run notification override set by an agent via `routine_notify` ("routine-notify-targets-v1"). */
export type RunNotifyTargets = { mode: "only" | "none" | "default"; people?: string[]; devices?: string[]; message?: string };
/**
 * Where a routine's result lands when a run finishes. "routine" (and nothing) keeps it in the
 * routine's own chat; "chat" also posts it as a message from the bot in the person's chat with it
 * (`chatId` names one, else the bot's main chat); the rest post it to Today as that kind of item.
 * Needs the capability "routine-delivery-v1". "none" (the routine runs and keeps its history, and
 * publishes no reply and no notification) needs "routine-no-output-v1" as well.
 */
export type RoutineDelivery = { to: "none" | "routine" | "chat" | "feed" | "idea" | "goal"; chatId?: string; /** For "goal": which kind of goal. */ category?: string };
/** `notify: false` keeps a routine quiet: no notification when a run finishes, on the computer or a phone. */
export type RoutineInput = {
  botId: string;
  name: string;
  /** The instructions; on a script routine, its follow-up action's (needed only when `followUp` is on). */
  prompt: string;
  cadence: Cadence;
  timezone?: string;
  deliver?: RoutineDelivery;
  notify?: boolean;
  /** Specific notification targets ("routine-notify-targets-v1"). null resets to everyone; omitted on an edit keeps the existing targets. */
  notifyTargets?: RoutineNotifyTargets | null;
  /** A script that runs on the computer with no model ("routine-scripts-v1"; the owner's only). null on an edit takes it away. */
  script?: string | null;
  followUp?: boolean;
  /** The routine's own model, kept on its chat ("routine-models-v1"). null on an edit goes back to the Default routines model. */
  model?: ModelChoice | null;
};
export type ChatContext = { current: number; limit: number; system?: number; tools?: number; conversation?: number; messages?: number; updatedAt?: number };
/** A chat as lists show it. Its messages arrive in a ChatDetail when the chat is open. */
export type ChatSummary = {
  hostDispatch?: true;
  fastMode?: FastMode;
  id: string;
  botId: string;
  /** How many tabs the chat's side pane has ("side-pane-v1"). The tabs come with the chat's detail. */
  panes?: number;
  /** Set on a group chat: its 2 to 6 members, in answer order. */
  botIds?: string[];
  /** The member who created it. Missing on an owner chat. */
  createdBy?: string;
  /** The people invited to it ("team-people-v1"): "owner" or a member's id. The owner and the chat's people get it. */
  invited?: string[];
  title: string;
  time: number;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  /** The section the person put it in on their Chats screen ("chat-sections-v1"). Their own: nobody else sees it. */
  sectionId?: string;
  projectId?: string;
  folder?: string;
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
  background?: boolean;
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
  /** The step has a longer input or output than it carries here ("step-details-v1"): `link.step` reads them. */
  more?: boolean;
};
/** One step's input and output, read when the step is opened (`link.step`). */
export type StepDetail = { input?: string; output?: string };
export type Todo ={ id: string; title: string; status: "pending" | "in_progress" | "done" | "blocked" | "cancelled" | "failed"; dependsOn?: string[] };
export type Reasoning = { id: string; text: string; started: number; finished?: number; botId?: string };
/** One reasoning item's wire suffix for a phone following a working turn. */
export type ReasoningAppend = Omit<Reasoning, "text"> & { from: number; add: string };
/** Snapshot-diff reasoning updates ("reasoning-appends-v1"). */
export type ReasoningDelta = { run: string; reset?: true; remove?: string[]; order?: string[]; items: ReasoningAppend[] };
/** The expanded reasoning state held by the phone for one running chat. */
export type ReasoningView = { run: string; items: Reasoning[] };
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
  remote?: { hostId: string; hostName: string; botName: string };
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
/**
 * A bot asked the person to connect a Composio app (the computer's desktop/connects.mjs). The card
 * holds only the app and where it stands; the page to sign in on goes to the owner who presses Connect.
 * needed: not connected yet. waiting: a sign-in page is open. sign_in: the computer isn't signed in to
 * Composio. unavailable: the chat's bot can no longer use Composio.
 */
export type ConnectStatus = "needed" | "waiting" | "connected" | "failed" | "expired" | "sign_in" | "unavailable";
export type ConnectCard = { id: string; toolkit: string; name: string; logo?: string; status: ConnectStatus; note?: string; updatedAt: number; resumed?: boolean };
export type ConnectCardState = { card: string; app: string; status: ConnectStatus; note?: string };
/** The card of a tool with an MCP App view (the computer's desktop/mcp-apps.mjs): what anyone in the chat may see. */
export type McpAppCard = { id: string; server: string; tool: string; title: string; summary: string; at: number };
/** A tool's result as MCP gives it: `content` is what the model read; the view also gets the rest. */
export type McpToolResult = { content: Record<string, unknown>[]; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown>; isError?: boolean };
/** What a view is shown with: the tool, its input and its result as they were, the origins it may reach, and its page. */
export type McpAppView = {
  id: string;
  server: string;
  tool: { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; _meta?: Record<string, unknown> };
  input: Record<string, unknown>;
  result: McpToolResult;
  csp: { resourceDomains: string[]; connectDomains: string[] };
  prefersBorder?: boolean;
  html?: string;
};
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
  stepKinds?: string[];
  stepCount?: number;
  failedCount?: number;
  panelId?: string;
  scheduleId?: number;
  notifyTargets?: RunNotifyTargets;
  usage?: Usage;
};
export type Run = RunSummary & {
  model?: ModelChoice;
  usedTools?: string[];
  steps?: Step[];
  cards?: Card[];
  apps?: { id: string; title: string; description: string; sendsAnswers: boolean }[];
  /** Composio apps the bot asked the person to connect in this turn. */
  connects?: ConnectCard[];
  /** Tools with an MCP App view that ran in this turn. */
  mcpApps?: McpAppCard[];
  options?: { label: string; prompt: string; description?: string }[];
  reasoning?: Reasoning[];
  todos?: Todo[];
  agents?: Subagent[];
  speakers?: string[];
  failures?: { botId: string; detail: string }[];
  teamwork?: TeamAsk[];
  /** How a turn ended without finishing ("turn-timeline-v1"). Missing: the phone reads it from `status` and `detail`. */
  ending?: "failed" | "timed-out" | "interrupted" | "stopped";
  /** The turn's plan when it ended: how many steps are open, of how many. Older computers send none. */
  plan?: { open: number; total: number };
  /** The computer gave the bot more turns in this run by itself (it kept the work moving): how many so far (at most `limit`), why, and how many plan steps were open at the last one. */
  continued?: { count: number; limit: number; reason: "plan" | "next-step"; open?: number };
  /** The turn ended with plan steps open and nothing went on (the limit, the same steps again, Stop, a waiting message or request). */
  stoppedOpen?: true;
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
/** A cross-host permission is scoped to the source and target bots and hosts shown on the card. */
export type DispatchAction = "approve" | "today" | "remember" | "deny";
export type RequestAnswer = {
  action: DispatchAction | "cancel" | "answer" | "accept";
  /** A saved credential's reference instead of text: the computer puts the value in. */
  value?: string | CredentialRef;
  content?: Record<string, unknown>;
};
export type AgentRequest = {
  dispatch?: true;
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
  /** When the computer raised it (milliseconds). */
  time?: number;
  /** A question that waited ten minutes: its turn went on without an answer. It stays open as waiting, and an answer starts a new turn that quotes it. */
  detached?: true;
};
export type QueuedMessage = { clientMessageId?: string; id: string; text: string };
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
  /** People currently typing in a chat, per chat ("chat-typing-v1"). */
  typing?: Record<string, { id: string; name: string }[]>;
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
  /** The space it is in ("spaces-v1"). */
  spaceId?: string;
  /** The member who asked for it. Missing: the owner. */
  createdBy?: string;
  /** An app panel's saved state (`botkins.state`), and how many times it changed. */
  state?: Record<string, unknown>;
  stateRev?: number;
  /** Short notes people wrote on it. */
  notes?: PanelNote[];
  /** The last change a person made: "Maya ticked Press kit". `label` is the page's own words. */
  last?: { by: string; name: string; label?: string; at: number };
  /** Up to 3 things worth asking its bot next, in the bot's own words: plain text, at most 60 characters each. Never made up by an app. */
  asks?: string[];
};
export type PanelNote = { id: string; by: string; name: string; text: string; at: number };
/**
 * A panel as a device is sent it ("spaces-v1"). A member gets it without its project, without its
 * chats unless they are in them, and without its routine's prompt unless they may change the space.
 */
export type PanelView = Omit<Panel, "chatId" | "routine"> & {
  chatId?: string;
  routine: (Omit<NonNullable<Panel["routine"]>, "prompt"> & { prompt?: string; setBy?: string; promptBy?: string }) | null;
};
/** Who can open a space: only its maker, members the maker picked, all members, or anyone with the link. */
export type SpaceAccess = "private" | "members" | "team" | "link";
/** What a person may do with a space. A member's role narrows what each allows (`team.me.role`). */
export type SpaceCan = "own" | "edit" | "view";
export type SpaceNotify = "off" | "daily" | "all";
/** A space as one person is sent it in the `spaces` part ("spaces-v1"; docs/spaces.md): the spaces they can open, pinned first. */
export type SpaceSummary = {
  id: string;
  name: string;
  /** One of the four every person has. Another person's is shown with its maker: "Maya's Today". */
  builtin?: "today" | "feed" | "ideas" | "goals";
  /** Who made it. */
  by: Person;
  mine: boolean;
  access: SpaceAccess;
  can: SpaceCan;
  /** With access "members": the people picked. */
  people?: (Person & { can: "view" | "edit" })[];
  /** With access "team" or "link": what every member may do. */
  teamCan?: "view" | "edit";
  /** The link, for its maker and the owner. Absent while links are off. */
  link?: string;
  /**
   * For its maker and the owner: "leaving" while an earlier link's copy is still being taken back
   * from the relay ("Taking the link back…"); "off" while it is shared by link and the relay is off
   * ("Links are off while the relay is off.").
   */
  linkState?: "leaving" | "off";
  /** Owner devices only. */
  projectId?: string;
  /** Panels and open cards the person is sent. */
  count: number;
  /** Of those, changed since the person last opened it (99 at most). */
  changed: number;
  pinned: boolean;
  notify: SpaceNotify;
  /** Other people looking at it now. */
  here: (Person & { panelId?: string })[];
  rev: number;
  updatedAt: number;
};
/** A space's content, asked for with `spaces.read`. Read again when the `rev` in the `spaces` part passes this one. */
export type SpaceContent = { id: string; rev: number; /** When the person last opened it before this read. */ seenAt: number; /** When they opened a panel or card on its own since (item id → time). Absent from an older computer. */ seenItems?: Record<string, number>; panels: PanelView[]; cards: BoardItem[] };
export type PanelStart = "checklist" | "tracker" | "chart" | "table" | "notes" | "app";
export type SpaceShareInput = { access: SpaceAccess; grants?: { id: string; can: "view" | "edit" }[]; teamCan?: "view" | "edit" };
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
  /** A proactive alert's run and its actions ("proactive-team-v1"), as on a chat message. */
  proactiveRunId?: string;
  alert?: ProactiveAlert;
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
export type Project = {
  folders?: string[];
  mode?: ChatMode;
  id: string;
  name: string;
  description?: string;
  color?: ProjectColor;
  folder?: string;
  todos: ProjectTodo[];
  /** The artifacts attached to it, by id, newest attached first ("project-artifacts-v1"). Left out while there are none. */
  artifacts?: string[];
  lastUsed: number;
  createdAt: number;
};

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
  /** Missing on older computers means the desktop's usual default: on. */
  avatarAnimations?: boolean;
};
export type NotificationSettings = {
  replies: boolean;
  routines: boolean;
  requests: boolean;
  /** One plain reminder when something is left waiting on a person, with no model. On from the start. Missing on a computer without "proactive-team-v1". */
  reminders?: boolean;
  quietHours: { enabled: boolean; from: string; to: string };
};
export type Preferences = {
  fastMode?: FastMode;
  model: ModelChoice;
  /** The Default routines model ("routine-models-v1"): routines without their own use it before their bot's. */
  routineModel?: ModelChoice;
  appearance: Appearance;
  foldTools: boolean;
  showThinking: boolean;
  foldThinking?: boolean;
  showUpdates?: boolean;
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
  /** Turns between a chat's summaries into a new title, on the Default routines model: 5 to 30, or 0 for off. Missing on an older computer. */
  autoSummarize?: number;
  /** Settings › Experimental › Proactive agent: the computer's switch. Each bot's own is the `proactive` part. Missing on a computer without "proactive-agent-v2". */
  proactive?: ProactiveSettings;
  providers?: Record<string, { enabled: boolean }>;
  /**
   * What runs a bot's turn around the model. "copilot": one harness (the Copilot SDK) for every plan.
   * "provider": each provider's own tool (Codex for ChatGPT, Claude Code for Claude). "pi" and "omp"
   * run ChatGPT and Claude plans (harnesses() says whether each is installed). Missing on an older computer.
   */
  harness?: "copilot" | "provider" | "pi" | "omp";
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
 * "pr-panel-v1" (owner-only pull request details and per-file patches),
 * "screen-v1", "prs-v1", "uploads-v1", "relay-v1" (the computer keeps a relay open, so a phone away
 * from its network can reach it), "push-v1" (notifications and Live Activities), "device-v1" (tools
 * that run on a phone), "voice-v1" (speech through the computer's providers, and live voice),
 * "frames-v1" (custom views: the page of an html block, for the phone to draw),
 * "provider-usage-v1" (each provider's plan and what is left of its limits),
 * "app-update-v1" (the app's: which Botkins the computer runs, checking for a newer release and
 * starting its install from a phone, and whether a host installs them by itself),
 * "devices-v1" (the list of paired devices, and renaming and removing one), "device-person-v1" (the
 * name of the person each device belongs to, and "link.devices.setPerson"),
 * "side-pane-v1" (a bot can open a pane beside a chat: a custom view, a table, a website, the screen),
 * "adoptMcpSignIn", and what the computer's app supports itself: "looks-v2" (eyes and custom colors),
 * "botkin-heads-v2" and "botkin-heads-v3" (the 23- and 30-character catalogs in Bot Studio),
 * "routine-delivery-v1" (where a routine's result lands, and whether it notifies), "models-v2"
 * (context window and other model details), "files-v1" (a file out or in without a dialog on the
 * computer: a template, the usage table, a wiki export), "folders-v1" (the folder browser, and
 * choosing a folder from it), the link's own "maintenance-v1" (clear the cache, and the
 * computer's own test notification), and "screen-grant-v1" (a headless host: a phone may set what
 * phones may do with its screen), and the app's "artifacts-v1" (what a bot made or was given: a
 * list, a file in pieces, a small picture of it, and the paths written in a chat), and the app's
 * "secure-input-v1" (a bot asks for a password, a code or another secret in a request of kind
 * "secure": the value goes to the computer only, and the bot gets a handle, never the value).
 * "bot-voice-v1" (the app's: a bot may have a voice of its own, `Bot.voice`, set with `updateBot`;
 * `link.voice.speak` takes a `botId` and `link.voice.live` applies the bot's live voice).
 * "provider-signin-v1" (the app's: a model provider signed in from a phone with no browser on the
 * computer, by its own page and code, its own questions, or a pasted token; and a provider's
 * command-line tool installed from a phone).
 * "spaces-v1" (pages of panels, private or shared: the `spaces` part, `spaces.*` and `link.spaces.*`;
 * the contract is docs/spaces.md).
 * "team-people-v1" (the people in a chat: `ChatSummary.invited`, `link.team.inviteToChat` and
 * `removeFromChat`, `team.people`; a chat's alerts go to its people only; and each member's own
 * view of bots and chats, kept by the computer for them).
 * "member-rename-v1" (the owner renames a member: `link.team.renameMember`).
 * "project-folders-v1" (ordered folders and chat folder choice), "project-mode-v1" (saved project mode),
 * "project-clone-v1" (clone from GitHub on the computer),
 * "project-artifacts-v1" (artifacts attached to a project: `Project.artifacts` and three calls).
 * "sync-push-v1" (sealed sync updates on an open relay request),
 * "stream-appends-v1" (boolean live indicators and cursor-based reply and thinking text for watched chats).
 * "step-details-v1" (steps without their long input and output for a client that asks; `link.step` reads one).
 * "turn-timeline-v1" (a turn in the order it happened: text before a step, a steer or a request
 * as interim messages, answers to requests as messages, a time on every reply, each helper's own
 * steps marked, and how a turn ended; docs/turn-timeline.md).
 * "plugins-v1" (the app's: plugins from GitHub's catalogs, other marketplaces or a folder on the
 * computer, each adding skills, tools, hooks, agents and commands to the person's bots; the part
 * `plugins` and the calls `plugins.*`; docs/plugins.md).
 * "agent-templates-v1" (the app's: agent templates from the plugin marketplaces, to start a bot
 * from: `agents.browse` and `agents.template`; docs/agent-templates.md).
 * "skill-upload-v1" accepts Markdown and zip files. "skills-catalog-v1" searches, previews and installs skills.
 * "market-refresh-v1" (the app's: `plugins.refresh` reads every marketplace again now, so new
 * plugins and agent templates show without waiting for the hour; docs/plugins.md).
 */
export type Meta = {
  app: string;
  version: string;
  platform: string;
  name: string;
  serverId: string;
  protocol: number;
  capabilities: string[];
  /**
   * Who this device is. For an owner device, `admin` says whether Admin mode is on: with it off the
   * device is sent what the owner is part of, not every member's chats, spaces and bots.
   */
  you?: { kind: "owner"; admin?: boolean } | { kind: "member"; memberId: string; name: string };
};

/** Everything the phone keeps in step with the desktop, by part name. */
export type ProactiveWatch = "runs" | "tasks" | "requests" | "context";
/** The computer's switch for the Proactive agent. Off pauses every bot's agent without forgetting its settings. */
export type ProactiveSettings = { enabled: boolean };
/** One person a bot looks out for ("proactive-team-v1"): `on` is their own check, `notify: false` delivers their alerts with no notification. */
export type ProactivePerson = { on: boolean; notify: boolean };
/** What a delivered proactive alert carries: its run, the label of what the bot offers to do, and what the person chose. Never the offer's own request. */
export type ProactiveAlert = { runId: string; offer?: string; chosen?: "take" | "later" };
/**
 * What a bot's Proactive agent is set to. Everything but `people` is shared by everyone the bot looks out for. With
 * "proactive-team-v1": `setUp` says its setup steps were finished (until then it never wakes), and `people` holds each
 * person's own entry, by "owner" or a member's id.
 */
export type ProactiveBotSettings = { enabled: boolean; pausedBy?: "owner"; setUp?: boolean; every: number; sweepHours: number; maxPerDay: number; deliver: "chat" | "feed"; watch: ProactiveWatch[]; instructions: string; people?: Record<string, ProactivePerson> };
/** A change to a bot's agent: only what it names. In `people` an entry changes what it names, and null takes that person out. */
export type ProactivePatch = Partial<Omit<ProactiveBotSettings, "people" | "pausedBy">> & { people?: Record<string, Partial<ProactivePerson> | null> };
/**
 * One bot's agent as this phone is sent it. The owner is sent everyone in `people` and their own activity (`log`, `pings`…).
 * A member is sent the shared settings, only their own entry in `people`, and their own activity: never another person's.
 * Every field may be missing, and a computer may add more. `person` and `taken` are from a computer without
 * "proactive-team-v1", where a bot's agent worked for one person.
 */
export type ProactiveBot = Partial<ProactiveBotSettings> & {
  enabled: boolean;
  person?: string;
  mine?: boolean;
  taken?: boolean;
  /** The agent's routine's chat (Check now is `runRoutine` on it). */
  chatId?: string;
  lastSweepAt?: number;
  pings?: number;
  day?: string;
  log?: ProactiveLog[];
  nextReviewAt?: number;
  learning?: { rated: number; preferred: string[]; retired: string[];
    evaluation?: { trained: number; tested: number; baseline: number; previous: number; challenger: number; promoted: boolean };
  };
};
export type ProactivePart = { enabled: boolean; bots: Record<string, ProactiveBot | undefined> };
export type ProactiveLog = { at: number; reason: "signals" | "sweep" | "check" | "context" | "review"; score?: number; signals: number; outcome: "alerted" | "silent" | "failed"; runId: string; said?: string };
export type Parts = {
  meta: Meta;
  settings: Preferences;
  bots: Bot[];
  sections: Section[];
  /** The person's own sections for their chats, in their order ("chat-sections-v1"). */
  chatSections?: Section[];
  chats: ChatSummary[];
  live: Live;
  runs: RunSummary[];
  panels: Panel[];
  /** Owner devices, "spaces-v1": every panel that has a project, in whichever space it is. A project's "Spaces and panels" is drawn from it. */
  projectPanels?: PanelView[];
  board: BoardItem[];
  /** The spaces this person can open ("spaces-v1"). An app that has it ignores `panels` and `board`. */
  spaces?: SpaceSummary[];
  tasks: BotTask[];
  /** The Proactive agent: the computer's switch and each bot's agent ("proactive-agent-v2"). A member is sent only their own. */
  proactive?: ProactivePart;
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

/**
 * An agent template in a marketplace ("agent-templates-v1", docs/agent-templates.md). `id` is
 * opaque (`name@marketplace`): never read anything out of it. `name` is the bot's name and the title.
 */
export type PiPackageListing = { name: string; description: string; types: string[] };
export type PiPackageVersion = { name: string; version: string };
export type InstalledPiPackage = PiPackageVersion & { enabled: boolean };

export type MarketAgent = {
  id: string;
  name: string;
  role: string;
  /** Shown as the description. */
  summary: string;
  /** The look the bot starts with. */
  look?: BotkinLook;
  /** One of writing, research, productivity, work, dev, learning, health, finance, home, media, life, other. */
  category?: string;
  /** The category's words, such as "Productivity". */
  categoryName?: string;
  marketplace: string;
  /** Such as "Botkins". */
  marketplaceName: string;
  /** A marketplace that comes with Botkins. */
  builtIn: boolean;
  version?: string;
  author?: string;
  keywords?: string[];
  /** Botkins' own templates: the named deliverable, how it is useful on day one, what it asks before, and a suggested pairing. */
  deliverable?: string;
  dayOne?: string;
  approval?: string;
  group?: "everyday" | "builder";
  pairing?: { kind: "routine" | "proactive"; cadence?: string; note: string };
  /** Catalog ids of apps that help it (mcpCatalog). */
  apps?: string[];
  /** A Home starter: shown before every other template. */
  starter?: boolean;
};
/** A category's chip: how many templates the other filters leave in it. */
export type MarketAgentCategory = { id: string; name: string; count: number };
/** A template with what Create a bot is filled in with. */
export type MarketAgentTemplate = MarketAgent & { instructions: string };

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

/** A name and its value as the plugin wrote it. Never a secret: a secret comes from a setting, and the text then has `${NAME}`. */
export type PluginValue = { name: string; value: string };
/** A name the plugin asked for that the computer does not set, with the computer's sentence for why. */
export type PluginNotSet = { name: string; why: string };

/**
 * A tool (MCP server) of a plugin. `kind` is what the computer does with it: "local" starts
 * `command` with `args`, in `cwd` (a path that is not a full path is a folder in the plugin's own
 * copy; without one, the plugin's own folder), with the environment in `env`. "remote" connects to
 * `url` (`type` "sse" is a stream) and sends `headers`. A computer from before "plugin-starts-v1"
 * sends only `name`, `kind`, `command` or `url`, `oauth` and `serverId`.
 */
export type PluginTool = {
  name: string;
  kind: "local" | "remote";
  command?: string;
  args?: string[];
  env?: PluginValue[];
  envNotSet?: PluginNotSet[];
  cwd?: string;
  type?: "http" | "sse";
  url?: string;
  headers?: PluginValue[];
  oauth?: true;
  /** The client id the plugin names for the sign-in. */
  oauthClientId?: string;
  /** An installed plugin's tool with OAuth: the tool server to sign in with "signInMcpServer". */
  serverId?: string;
};

/** A hook: the whole command (up to 4,000 characters), its environment and how long it may run. */
export type PluginHook = { event: PluginHookEvent | (string & {}); command: string; env?: PluginValue[]; envNotSet?: PluginNotSet[]; timeoutSec?: number };

/** What a plugin adds, and with "plugin-starts-v1" everything it starts on the computer, whole. */
export type PluginContents = {
  skills: string[];
  agents: string[];
  commands: string[];
  mcpServers: PluginTool[];
  hooks: PluginHook[];
  lspServers?: string[];
  /** Hooks and tools the plugin has that the computer does not run, the first 40 with the reason. There only when `count` is more than zero. */
  notRun?: { count: number; items: { what: "hook" | "tool"; name: string; why: string }[] };
  /** The plugin's files that are not a skill, an agent or a command. `config`: a file tools read by themselves. A folder of dependencies is one row whose `path` ends with "/". */
  otherFiles?: { count: number; bytes: number; files: { path: string; bytes: number; config?: true; files?: number }[] };
};

/** Where a setting's value goes: an environment name of a tool or a hook (`hook` is its event), or a header at an address. */
export type PluginSentTo = { tool: string; env: string } | { tool: string; header: string; url: string } | { hook: string; env: string };

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
  /** Each place that gets the value ("plugin-starts-v1"). */
  sentTo?: PluginSentTo[];
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
  /**
   * The mark to trust ("plugin-starts-v1"): this description was made by the computer's one reading,
   * so every command it starts is in it, whole. Decide about one description from this mark. A
   * description without it asks first, always.
   */
  starts?: 1;
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
  /** A sentence for needs-sign-in and error. A computer up to 0.17.2 also gave one for a plugin it switched off itself (`enabled: false`); a newer one switches nothing off and puts its reason first in `warnings`. */
  detail?: string;
  /** "Hooks run only for bots on the Copilot SDK." */
  limits?: string;
  updateAvailable?: true;
  /** A folder plugin's path on the computer, to show. */
  folder?: string;
  installedAt: number;
  /** The installed copy's revision: sent with a switch-on and a choice of bots, as the person saw it. */
  revision?: string;
  /** See `PluginPreview.starts`. Not there when the installed copy could not be read or is not the reviewed files. */
  starts?: 1;
  /** An update is the repair (the copy is not the reviewed files, or could not be read): offer Update also when the source did not change. */
  repair?: "update";
  /** What it runs, in the computer's sentences. */
  warnings?: string[];
};

/** A plugin setting's value as a phone sends it: text, a saved credential the computer fills in, or null to clear it. */
export type PluginConfigValue = string | CredentialRef | null;

// ---------------------------------------------------------------------------------------------
// Notifications (capability "push-v1"). The computer sends them through the relay's push route;
// what a notification says is sealed for the phone, so the relay and Apple carry no message text.

/** What a phone wants to be told about. `previews` off shows "New message" with no text. */
/** `updates`: a newer Botkins for the computer is out ("app-update-v1"). A computer from before leaves it out; it counts as on. */
/** `spaces`: notes and changes in the person's spaces ("space-alerts-v1"). A computer from before leaves it out; it counts as on. */
export type PushPrefs = { replies: boolean; requests: boolean; routines: boolean; previews: boolean; activities: boolean; updates?: boolean; spaces?: boolean };
/**
 * The computer's own Botkins and its updates ("app-update-v1"; docs/link-contract.md). `message` is
 * the computer's sentence (why it can't install, what failed), shown as it comes. `auto` is there
 * only on a host that can install by itself. `last` is how the last install ended, kept across the
 * restart it causes, a rollback too.
 */
export type AppUpdate = {
  status: "idle" | "checking" | "current" | "available" | "downloading" | "restarting" | "error";
  current: string;
  latest?: string;
  canInstall: boolean;
  installer?: string;
  message?: string;
  auto?: boolean;
  last?: { at: string; from: string; to: string; ok: boolean; message?: string };
};
/** Where Apple delivers for this phone. `start` is the token that can start a Live Activity (iOS 17.2 or later). */
/**
 * `cards: "all"`: one Live Activity for all Botkins, sent only to a computer that names
 * "activity-all-v1". `cards: "bots"`: one per Botkin, for a computer that names only
 * "activity-bots-v1" (docs/live-cards.md).
 */
export type PushTarget = { token: string; env: "production" | "sandbox"; start?: string; cards?: "bots" | "all" };
/** A paired phone as the computer knows it. Tokens stay on the computer and are not in here. */
/**
 * A device paired with the computer (`devices-v1`, "link.devices.list"): a phone, or another
 * computer's Botkins app that uses this one. `connected` is true while it was heard from in the last
 * minute and a half. `current` marks the device that asked. Never a key or a notification address.
 * `name` describes the device ("iPhone 17 Pro"); `person` is who it belongs to ("Jordan"), given when
 * it paired or set by the owner ("device-person-v1"). A device paired before has none.
 */
export type PairedDevice = {
  id: string;
  name: string;
  person?: string;
  platform: string;
  kind: "phone" | "desktop" | "gadget";
  /** A gadget's board and firmware, as it said them, the bot it talks with ("gadgets-v1"), and its settings and Wi-Fi ("gadget-settings-v1"). */
  gadget?: GadgetInfo;
  createdAt: number;
  lastSeenAt: number;
  connected: boolean;
  canNotify?: boolean;
  current?: boolean;
};
/**
 * What a gadget is handed once a trusted device named it by its key ("gadgets-v1",
 * "link.gadgets.add"): who the computer is and where to find it. With its own secret key that is
 * a gadget's whole `Pairing`.
 */
export type GadgetIntroduction = { deviceId: string; serverId: string; serverKey: string; name: string; hosts: string[] };
/** A gadget's settings ("gadget-settings-v1"). The computer keeps them; the gadget applies them. */
export type GadgetSettings = {
  /** 0 to 100. */
  volume: number;
  mic: "low" | "normal" | "high";
  /** The microphone is off. */
  mute: boolean;
  /** 5 to 100. */
  brightness: number;
  /** Seconds idle before the screen dims, and before it goes dark. 0 is never. */
  dimAfter: number;
  offAfter: number;
};
/** A gadget as the device list shows it. */
export type GadgetInfo = {
  board?: string;
  firmware?: string;
  botId?: string;
  settings?: GadgetSettings;
  /** The network in use, the saved networks' names and the signal in dBm, as the gadget last said. Never a password. */
  wifi?: { network?: string; saved: string[]; signal?: number };
  /** Wi-Fi changes the gadget hasn't taken yet. */
  wifiWaiting?: ({ add: string } | { forget: string })[];
  /** A restart was asked for and hasn't happened yet. */
  restarting?: true;
};
/** A Wi-Fi change for a gadget: a network with its password, or one to forget. */
export type GadgetWifiChange = { add: { ssid: string; password: string } } | { forget: string };
/** The part a gadget follows in place of the app's parts (gadget/docs/contract.md). */
export type GadgetPart = {
  name: string;
  bot: { id: string; name: string; look?: BotkinLook } | null;
  bots: { id: string; name: string }[];
  chat: { id: string; title: string } | null;
  phase: "idle" | "working" | "writing" | "request";
  doing?: string;
  request?: { id: string; kind: AgentRequest["kind"]; title: string; preview?: string; choices?: string[]; remember?: true; freeform?: true };
  queued?: number;
  /** The newest reply, as plain words. `parts` is how many pieces "link.gadget.speak" reads it in. */
  reply?: { id: string; text: string; parts: number };
  voice: { hear: boolean; speak: boolean; live?: LiveProvider };
  /** While working: how many steps the turn has taken. */
  steps?: number;
  settings: GadgetSettings;
  /** Names the bot's Botkin: a new one means the faces ("link.gadget.face") are new. Absent on a computer without the design kit. */
  face?: { look: string };
  /** Wi-Fi changes for the gadget to take and then report done ("link.gadget.set" `wifiDone`). */
  wifi?: { changes: ({ id: string } & ({ add: { ssid: string; password: string } } | { forget: string }))[] };
  /** A restart the owner asked for: the gadget says `restarting` with this id, then restarts. */
  restart?: string;
};
export type PhoneRecord = {
  name: string;
  /** What the device is. Missing on an older computer, where every paired device is a phone. */
  kind?: "phone" | "desktop" | "gadget";
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

export type DeviceSource = "calendar" | "contacts" | "health" | "location" | "photos" | "music" | "mail";
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
export type LiveProvider = "codex" | "openai" | "azure" | "gemini" | "elevenlabs";
/**
 * A voice of a bot's own ("bot-voice-v1"), saved with the bot by the computer's app. Every field is
 * optional: one that is absent means the same as the shared VoiceSettings. No key is ever in it.
 * `updateBot(id, { voice })` sets it and `voice: null` clears it; the computer drops what isn't one
 * of its providers, and `speed` is 0.5 to 2.
 */
export type BotVoice = {
  tts?: { provider?: TtsProvider; model?: string; voice?: string; speed?: number };
  live?: { provider?: LiveProvider; model?: string; voice?: string };
};
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
  setPreferences(patch: Partial<Omit<Preferences, "model" | "appearance" | "providers" | "proactive">> & { appearance?: Partial<Appearance>; proactive?: Partial<ProactiveSettings> }): void;
  appInfo(): { version: string; electron: string; chrome: string; platform: string };
  // ---- The computer's own updates ("app-update-v1"; the owner's devices only). None takes a version or an address.
  appUpdateStatus(): AppUpdate;
  checkAppUpdate(): AppUpdate;
  /** Installs `latest` and restarts the computer's Botkins: the link drops and comes back. `last` says how it ended. */
  installAppUpdate(): AppUpdate;
  /** Installing by itself, on a host that can (`auto` present). Refused elsewhere. */
  setAppUpdateAuto(on: boolean): AppUpdate;
  addBot(bot: BotInput): string;
  updateBot(id: string, patch: Partial<Pick<Bot, "role" | "instructions" | "name" | "clarificationInstructions" | "summary" | "avatar">> & { voice?: BotVoice | null }): void;
  setBotFlags(id: string, flags: Partial<Pick<Bot, "pinned" | "hidden" | "sectionId" | "teamwork">>): void;
  makePrimary(id: string): void;
  reorderBots(ids: string[]): void;
  deleteBot(id: string): void;
  duplicateBot(id: string): string;
  setBotAccess(botId: string, grant: BotAccessGrant): void;
  setBotIntegrations(botId: string, off: { skillsOff?: string[]; mcpOff?: string[] }): void;
  /**
   * Changes what a bot's Proactive agent is set to (only what `patch` names), or with null forgets it. Needs "proactive-agent-v2";
   * `setUp` and `people` need "proactive-team-v1". The computer checks who calls: the owner changes anything and adds or takes out
   * anyone whose role sees the bot; a member changes only their own entry in `people`, and adds themselves or changes what the
   * people share only when their role manages the bot (never look-around, the tasks watch or the bot's switch to off). A member's
   * null takes only that member out.
   */
  setBotProactive(botId: string, patch: ProactivePatch | null): void;
  /**
   * What a person does with a proactive alert they were sent ("proactive-team-v1"). "take" starts a normal turn in their chat with
   * the bot, with what the bot offered as their message (its tools ask for approval as usual), and answers that chat. "later" holds
   * what the alert was about back for a day. Only the person the alert was for has it; anyone else is told it is gone.
   */
  proactiveAct(botId: string, runId: string, action: "take" | "later"): { chatId?: string; until?: number };
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
  markChatsRead(ids: string[]): void;
  renameChat(id: string, title: string): void;
  /** Generates and saves a title from the chat's messages ("chat-title-regeneration-v1"). */
  regenerateChatTitle(id: string): string;
  deleteChat(id: string): void;
  reactToMessage(chatId: string, index: number, time: number | null, emoji: string): NonNullable<Message["reactions"]>;
  forkChat(chatId: string, messageIndex: number): string;
  warmChat(chatId: string): void;
  startProjectChat(botIds: string[], projectId: string, mode?: ChatMode, folder?: string | null): string;
  /** While the chat works, `delivery: "steer"` hands the message to the turn under way where the provider can take it (the desktop app's default), and "queue" keeps it for after. */
  recordVoiceLine(chatId: string, id: string, text: string, final: boolean, options?: { role: "assistant"; sessionId: string; afterVoiceId?: string }): void;
  send(chatId: string, text: string, options?: { clientMessageId?: string; voiceId?: string; notify?: false; quote?: string; mentions?: MentionInput[]; attachments?: { name: string; path: string }[]; delivery?: "steer" | "queue" }): void;
  mentionables(chatId: string | undefined, botId?: string): Mentionables;
  catalog(botId: string, chatId?: string, refresh?: boolean): Catalog;
  stop(chatId: string): void;
  unqueue(chatId: string, itemId: string): void;
  sendNow(chatId: string, itemId: string): void;
  retry(runId: string): void;
  compact(chatId: string): void;
  sideQuestion(chatId: string, question: string): string;
  /** A value (or a form field's value) may be a CredentialRef: the computer fills the secret in. */
  respond(requestId: string, answer: RequestAnswer): void;
  clearApprovals(chatId?: string): void;
  models(): ModelInfo[];
  /** "routines" is the Default routines model ("routine-models-v1"); null clears it. */
  setModel(scope: "global" | "routines" | "bot" | "chat", id: string | null, value: ModelChoice | null, fastMode?: FastMode | null): void;
  providers(refresh?: boolean): ProviderStatus[];
  /** The program harnesses (Pi and OMP): installed, version, and how to install. Unknown on an older computer. */
  harnesses(): HarnessStatus[];
  setProviderEnabled(id: string, enabled: boolean): void;
  signIn(providerId?: string): void;
  cancelSignIn(providerId?: string): void;
  signOut(providerId?: string): void;
  // ---- Signing in and installing from a phone ("provider-signin-v1")
  /**
   * Starts the provider's own sign-in on the computer, with no browser there: a page and a code for
   * the person to open on the phone, or the tool's questions. `service` and `method`: one of
   * OpenCode's model services and its sign-in. Read it with providerSignInRead.
   */
  providerSignInStart(providerId: string, options?: { service?: string; method?: string }): { session: string };
  /** The events after `after`: at once when there are some or it is over, else within about ten seconds. */
  providerSignInRead(session: string, after?: number): ProviderSignInView;
  /** A line the person typed, for a sign-in that waits for one (a code the page showed). */
  providerSignInInput(session: string, text: string): void;
  /** Ends a sign-in or an install under way. False when it was already over. */
  providerSignInCancel(session: string): boolean;
  /**
   * Signs a provider in with a token or key the person pasted (or a saved credential, `{ $credential: id }`).
   * Sent once; the computer keeps it in its own vault or hands it to the tool, and never sends it back.
   */
  providerUseToken(providerId: string, token: string, options?: { service?: string }): { connected: boolean; account?: string | null; plan?: string | null; needs?: string };
  /**
   * The settings of OpenRouter, Azure Foundry or an OpenAI endpoint ("keyed-providers-v1"): replaces
   * all of them and answers the provider's new status. The key goes through providerUseToken. The
   * computer checks every value and throws a sentence for one that isn't acceptable.
   */
  providerConfigure(providerId: string, config: KeyedConfig): ProviderStatus;
  /** Installs a provider's command-line tool with the command the computer names for it (`install.command`). Read it like a sign-in. */
  installProvider(providerId: string): { session: string };
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
  editProjectFolder(id: string, action: "add" | "remove" | "default", path: string): string[];
  chatProjectFolder(id: string): string | null;
  setChatFolder(id: string, path: string | null): void;
  cloneProjectRepository(repository: string, parent?: string, id?: string, data?: { name?: string; description?: string }): string;
  /** `folder: null` unlinks the project's folder (the folder itself is left alone). */
  updateProject(id: string, patch: { name?: string; description?: string; color?: ProjectColor | null; folder?: string | null; mode?: ChatMode }): void;
  /** The folders inside `path`, or inside the home folder. Needs "folders-v1". */
  listFolders(path?: string): FolderList;
  /** A project for a folder chosen in the folder browser (or the one it already has); answers its id. Needs "folders-v1". */
  addProjectFolder(path: string): string;
  removeProject(id: string): void;
  /**
   * A project's artifacts ("project-artifacts-v1"). Adding one that is there moves it to the front;
   * each of the two answers the list of ids afterwards. `artifactId` is an artifact's id.
   */
  addProjectArtifact(projectId: string, artifactId: string): string[];
  removeProjectArtifact(projectId: string, artifactId: string): string[];
  /** The attached artifacts, described as `artifacts.list` describes them, newest attached first. One that is gone isn't among them. */
  projectArtifacts(projectId: string): { items: Artifact[] };
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
  /** Changes a chat's project or mode. Moving a started chat carries its transcript into the next session. */
  setChatProject(chatId: string, projectId: string | null, mode?: ChatMode, folder?: string | null): void;
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
  /** A plugin folder is never linked: it is installed as a plugin (`id`, `enabled`; "plugin-starts-v1"). It arrives on; a computer up to 0.17.2 added it off. */
  addSkillFolderAt(path: string): { kind: "skill" | "plugin" | "folder"; name: string; count?: number; id?: string; enabled?: boolean };
  renameProject(id: string, name: string): void;
  /** What changed in a project's folder, one file's changes as text, and committing all of it. */
  projectChanges(id: string, folder?: string): ProjectChanges;
  projectDiff(id: string, file: string, folder?: string): { text: string; truncated: boolean };
  projectCommit(id: string, message: string, folder?: string): string;
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
  /** `revision` (both calls): the installed plugin's, as the person saw it. The computer refuses when it is another one now. */
  "plugins.setBots"(id: string, bots: "all" | string[], options?: { revision?: string }): void;
  "plugins.setEnabled"(id: string, on: boolean, options?: { revision?: string }): void;
  /** `revision` is the preview's the person reviewed; the computer refuses another. */
  "plugins.update"(id: string, options?: { revision?: string }): InstalledPlugin;
  "plugins.uninstall"(id: string): void;
  /** Reads every marketplace again now ("market-refresh-v1"). One that can't be read keeps its last list and has `error`. */
  "plugins.refresh"(): PluginMarketplace[];
  // ---- Agent templates ("agent-templates-v1", docs/agent-templates.md)
  /** In the catalogs' own order. `query` (at most 200 characters) matches name, role, summary, category and keywords. `categories` counts what the other filters leave. */
  "skills.upload"(file: SkillUpload): SkillImportResult;
  "skillsCatalog.search"(query: string): CatalogSkill[];
  "skillsCatalog.preview"(id: string): CatalogPreview;
  "skillsCatalog.install"(token: string, replace?: string[]): SkillImportResult;
  /** The featured shelf ("skills-featured-v1"): upstream skills pinned to a commit. Preview and install them by id. */
  "skillsCatalog.featured"(): FeaturedSkill[];
  /** The direct apps catalog ("mcp-catalog-v1"). */
  "mcpCatalog.list"(): McpCatalog;
  /** Adds an app as a tool server, or sets its keys again. A stdio app needs `confirm`: its exact `command`. Owner only. */
  "mcpCatalog.add"(id: string, options?: { keys?: Record<string, string>; confirm?: string }): McpCatalogAdded;
  "piPackages.browse"(query?: { query?: string; page?: number }): { packages: PiPackageListing[]; nextPage?: number };
  "piPackages.preview"(name: string): PiPackageVersion;
  "piPackages.list"(): InstalledPiPackage[];
  "piPackages.install"(name: string, version: string): InstalledPiPackage;
  "piPackages.setEnabled"(name: string, version: string, enabled: boolean): InstalledPiPackage;
  "agents.browse"(query?: { query?: string; category?: string; marketplace?: string }): { agents: MarketAgent[]; categories: MarketAgentCategory[] };
  /** Refused with a sentence when the template is gone. */
  "agents.template"(id: string): MarketAgentTemplate;
  // ---- A chat's Connect card (the computer's desktop/connects.mjs): the computer's own Composio account, so its owner only
  /** Connect: starts or joins the app's sign-in. `url` is the page to open while it waits. */
  "composio.cardOpen"(chatId: string, cardId: string): ConnectCardState & { url?: string };
  /** Looks at the card again (back from the browser); the computer goes on with the chat once the app is connected. */
  "composio.cardCheck"(chatId: string, cardId: string): ConnectCardState;
  // ---- The view of an MCP App in a chat ("mcp-apps-v1", the computer's desktop/mcp-apps.mjs)
  /** What the view is shown with; `html` asks for the page too. Showing it never runs the tool again. */
  "mcpApps.view"(chatId: string, cardId: string, options?: { html?: boolean }): McpAppView;
  /** A call from the view to its own server: the tool's result, or `needsApproval` when the person must allow it first (then call again with `approved`). */
  "mcpApps.callTool"(chatId: string, cardId: string, name: string, args: Record<string, unknown>, options?: { approved?: boolean }): { result: McpToolResult } | { needsApproval: { tool: string; title: string; server: string } };
  "mcpApps.readResource"(chatId: string, cardId: string, uri: string): { contents: Record<string, unknown>[] };
  // Spaces ("spaces-v1"; docs/spaces.md). The app's calls, then the link's own.
  "spaces.read"(id: string): SpaceContent;
  /** A new private space, pinned for its maker. Answers its id. */
  "spaces.create"(input: { name: string }): string;
  "spaces.rename"(id: string, name: string): void;
  /** The space, its panels, their routines, refresh chats and views. Not a built-in. */
  "spaces.remove"(id: string): void;
  /** Owner only. */
  "spaces.setProject"(id: string, projectId: string | null): void;
  "spaces.setPanelProject"(panelId: string, projectId: string | null): void;
  /** Starts a chat with the bot in that space and sends the sentence; the app opens the chat. */
  "spaces.newPanel"(input: { spaceId: string; botId: string; prompt: string; start?: PanelStart; refresh?: { cron: string; timezone: string }; /** The new panel's project. Owner only. */ projectId?: string }): { chatId: string };
  "spaces.ask"(input: { spaceId: string; botId: string; text: string; panelId?: string }): { chatId: string };
  /** `before`: a panel id, or null for the end. */
  "spaces.movePanel"(panelId: string, to: { spaceId: string; before: string | null }): void;
  /** An app panel's state: a shallow merge of top-level keys; null removes a key. `label` says what the person did. */
  "spaces.patchState"(panelId: string, patch: Record<string, unknown>, label?: string): { rev: number };
  "spaces.note"(panelId: string, text: string): string;
  "spaces.removeNote"(panelId: string, noteId: string): void;
  /** Who can open a space. "link" makes a link when there is none. */
  /**
   * Sections on the Chats screen ("chat-sections-v1"): the caller's own way to group their chats.
   * A name is 1 to 40 characters and no two of a person's sections share one; 30 sections at most.
   */
  "link.chats.addSection"(name: string): string;
  "link.chats.renameSection"(id: string, name: string): null;
  /** Its chats stay in the list, in no section. */
  "link.chats.deleteSection"(id: string): null;
  /** The caller's order of their sections. */
  "link.chats.orderSections"(ids: string[]): null;
  /** Puts one of the caller's chats in a section, or in none (`null`). */
  "link.chats.setSection"(chatId: string, sectionId: string | null): null;
  /** Whether the caller is typing in this chat ("chat-typing-v1"). Ephemeral, in memory only. */
  "link.chat.typing"(chatId: string, typing: boolean): null;
  "link.spaces.share"(id: string, input: SpaceShareInput): { link?: string };
  /** A fresh link; the old one stops working. */
  "link.spaces.newLink"(id: string): { link: string };
  /** The caller's own order and pins. */
  "link.spaces.arrange"(input: { order: string[]; pinned: string[] }): null;
  /** With `itemId`, only that panel or card was seen (opened). An older computer takes it as the whole space. */
  "link.spaces.seen"(id: string, itemId?: string): null;
  "link.spaces.notify"(id: string, mode: SpaceNotify): null;
  /** The caller is looking at this space (and panel) now; null on leaving. Sent every 30 seconds while it stays in view. */
  "link.spaces.here"(id: string | null, panelId?: string): null;
  /** Owner only: whether members may share by link. */
  "link.team.setLinkSharing"(on: boolean): boolean;
  /** Owner only, for this device: Admin mode. On: every member's spaces, bots and chats are listed. Answers what it is now. */
  "link.team.setAdminMode"(on: boolean): boolean;
  /** Invites a person ("owner" or a member's id) to a chat, or takes them out ("team-people-v1"). Each answers who is invited afterwards. The chat's starter or the owner invites; someone invited may take themselves out. */
  "link.team.inviteToChat"(chatId: string, personId: string): string[];
  "link.team.removeFromChat"(chatId: string, personId: string): string[];
  "link.messages"(chatId: string, before: number, limit?: number): ChatDetail | null;
  /** A step's input and output, for a step that says `more` ("step-details-v1"). Null when the step is gone. */
  "link.step"(chatId: string, runId: string, stepId: string): StepDetail | null;
  "link.unpair"(): boolean;
  /** Sends a file to the computer for the next message. `data` is base64, at most about 3 MB a call; a larger file goes in parts with the same `id`. */
  /** The devices paired with the computer. Needs "devices-v1". */
  "link.devices.list"(): PairedDevice[];
  /** Pairs a gadget by introduction ("gadgets-v1"): its public key (X25519, base64url) as it gave it over a cable or Bluetooth. */
  "link.gadgets.add"(input: { publicKey: string; name?: string; board?: string; botId?: string }): GadgetIntroduction;
  /** A gadget's settings and its bot ("gadget-settings-v1"): any of them. Answers the device list afterwards. */
  "link.gadgets.configure"(id: string, patch: Partial<GadgetSettings> & { botId?: string }): PairedDevice[];
  /** A Wi-Fi network to add, with its password, or to forget. The gadget takes it at its next look (within 10 minutes). */
  "link.gadgets.wifi"(id: string, change: GadgetWifiChange): { queued: true };
  "link.gadgets.restart"(id: string): null;
  /** Renames a paired device (this one or another). Answers the list as it is afterwards. */
  "link.devices.rename"(id: string, name: string): PairedDevice[];
  /** Names the person a paired device belongs to (a team member's device names the member). Needs "device-person-v1". Answers the list as it is afterwards. */
  "link.devices.setPerson"(id: string, person: string): PairedDevice[];
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
  "link.team.renameMember"(memberId: string, name: string): Extract<TeamPart, { roles: Role[] }>;
  /** A custom view (an html block) as its bot wrote it, and its data. Needs "frames-v1". */
  "link.frame.page"(frame: string): { html: string; data: unknown };
  /** The chat a custom view's answer goes to, for a view in a Today panel. */
  "link.frame.chat"(frame: string): { chatId: string | null };
  "link.upload"(file: { id?: string; name: string; data: string; last?: boolean }): UploadedFile;
  /** Pull requests of the repository behind a chat's project. `available: false` says why there are none to offer. */
  "link.pullRequest"(input: { url: string }): PullAnswer<{ pull: PullRequestDetail }>;
  "link.pullRequestDiff"(input: { url: string; path: string }): PullAnswer<{ text: string }>;
  "link.pullRequests"(where: { chatId?: string; projectId?: string }, query?: string): { available: boolean; reason?: string; items: PullRequest[] };
  "link.credentials.save"(input: CredentialInput): string;
  "link.credentials.remove"(id: string): void;
  /** Whether a credential can be read right now. Never returns the value. */
  "link.credentials.check"(id: string): { ok: boolean; message?: string };
  "link.credentials.managers"(refresh?: boolean): PasswordManagerStatus[];
  "link.credentials.protonPassInstallPlan": () => Awaited<ReturnType<ProtonCalls["plan"]>>;
  "link.credentials.protonPassInstall": LinkProtonCall<"install">;
  "link.credentials.protonPassSignInStart": LinkProtonCall<"start">;
  "link.credentials.protonPassSignInRead": LinkProtonCall<"read">;
  "link.credentials.protonPassSignInInput": LinkProtonCall<"input">;
  "link.credentials.protonPassSignInCancel": LinkProtonCall<"cancel">;
  "link.credentials.protonPassDisconnect": LinkProtonCall<"disconnect">;
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
  "link.screen.frame"(options: { display?: string; maxWidth?: number; quality?: number; after?: number; wait?: boolean }): ScreenFrame;
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
  /** The models and voices a provider offers. For Azure, `model` is the model whose voices are wanted ("" is the standard voices); without it, the saved one. */
  "link.voice.options"(kind: "stt" | "tts" | "live", provider: string, model?: string): VoiceOptions;
  /** Speech to text on the computer's provider. `audio` is base64, at most about two minutes of 16 kHz WAV. */
  "link.voice.transcribe"(input: { audio: string; format: "wav" | "m4a" | "mp3" | "webm"; language?: string }): { text: string };
  /** Text to speech on the computer's provider: base64 audio to play. At most 4,000 characters; split long text by sentence. */
  "link.voice.speak"(input: { text: string; voice?: string; speed?: number; botId?: string }): { audio: string; format: "mp3" | "wav" };
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
