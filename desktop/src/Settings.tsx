import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Bell,
  Bug,
  Bot as BotIcon,
  Boxes,
  ChartColumn,
  Cpu,
  FlaskConical,
  HardDrive,
  Info,
  KeyRound,
  LockKeyhole,
  MessageSquareMore,
  MonitorSmartphone,
  PanelLeft,
  Palette,
  Server,
  Store,
  Smartphone,
  Mic,
  Settings2,
  Sparkles,
  Users,
  UsersRound,
  UserCircle,
  ChevronLeft,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button, Input } from "glisse";
import { GlassTabBar } from "./GlisseUI";
import type { AppUpdate, AppInfo, Bot, Catalog, MarketAgentTemplate, Preferences, State, NotificationSettings } from "./types";
import ModelPicker from "./ModelPicker";
import { AppearanceSettings, BehaviorSettings, ChatDisplaySettings, BackgroundSettings, HarnessSettings, SummarySettings, TaskSettings } from "./Preferences";
import Usage from "./Usage";
import { ComputersAndTeams } from "./RemoteHosts";
import AccessSettings from "./AccessSettings";
import { BotAvatar } from "./Avatar";
import { Group, Row, SwitchRow, ValueRow, errorText } from "./SettingsRows";
import ProviderSettings from "./ProviderSettings";
import SkillsSettings from "./SkillsSettings";
import McpSettings, { CredentialsSettings } from "./McpSettings";
import PhoneSettings from "./PhoneSettings";
import VoiceSettings from "./VoiceSettings";
import SidebarSettings from "./SidebarSettings";
import { hasSpaces } from "./spaces";
import TeamworkSettings from "./TeamworkSettings";
import BotIntegrations from "./BotIntegrations";
import BotMemory from "./BotMemory";
import PluginsSettings from "./PluginsSettings";
import TeamSettings, { type TeamView } from "./TeamSettings";
import ExperimentalSettings from "./ExperimentalSettings";
import ProfileSettings from "./ProfileSettings";
import NodeHostSettings from "./NodeHostSettings";
import { memberTeam, teamCan } from "./teamAccess";
import "./settings.css";

const api = window.botkins;

export type SectionId =
  | "general"
  | "profile"
  | "appearance"
  | "sidebar"
  | "chats"
  | "notifications"
  | "bots"
  | "skills"
  | "marketplace"
  | "mcp"
  | "credentials"
  | "teamwork"
  | "team"
  | "access"
  | "computers"
  | "node"
  | "phone"
  | "voice"
  | "usage"
  | "storage"
  | "account"
  | "experimental"
  | "feedback"
  | "about";
type BotView = "profile" | "model" | "capabilities" | "memory";
/** The groups of the side list, as the phone's Settings groups them. A group with no title is drawn with a gap, or a rule (`rule`). */
type SectionGroup = { title?: string; tile?: string; rule?: boolean; ids: SectionId[] };
const GROUPS: SectionGroup[] = [
  { tile: "tide", ids: ["general", "profile", "computers", "team", "phone", "node"] },
  { title: "Your bots\u2019 toolbox", tile: "clay", ids: ["account", "bots", "mcp", "skills", "marketplace", "credentials"] },
  { title: "How bots work", tile: "fern", ids: ["chats", "access", "teamwork", "voice", "notifications"] },
  { title: "This computer", tile: "rose", ids: ["appearance", "sidebar", "storage"] },
  { rule: true, ids: ["usage", "experimental", "feedback", "about"] },
];
const SECTIONS: { id: SectionId; label: string; icon: LucideIcon; about: string; words?: string }[] = [
  { id: "general", label: "General", icon: Settings2, about: "The models your bots use, the harness they run in, and what runs in the background.", words: "default model routines harness background fast mode thinking" },
  { id: "profile", label: "Profile", icon: UserCircle, about: "Who you are to your bots and to the people you work with.", words: "name picture photo about me account" },
  { id: "appearance", label: "Appearance", icon: Palette, about: "How Botkins looks on this computer. Your phone keeps its own choices.", words: "theme dark light mode color backdrop font text size avatar animations" },
  { id: "sidebar", label: "Side menu", icon: PanelLeft, about: "What the side menu shows, and in what order.", words: "places order hide show sidebar" },
  { id: "chats", label: "Chat", icon: MessageSquareMore, about: "How chats look, how they are summed up, and when bots ask first.", words: "thinking tool calls summary approvals clarification completion bubble" },
  { id: "notifications", label: "Notifications", icon: Bell, about: "What alerts you, and when Botkins stays quiet.", words: "replies routines questions reminders quiet hours test" },
  { id: "bots", label: "Bots & capabilities", icon: BotIcon, about: "Each bot\u2019s model, profile, tools and memory.", words: "model profile instructions role capabilities memory integrations inspect" },
  { id: "skills", label: "Skills", icon: Sparkles, about: "Know-how your bots can use, from you, plugins and catalogs.", words: "skill scripts commands" },
  { id: "marketplace", label: "Marketplace", icon: Store, about: "Apps, bots, plugins, Pi packages and skills to add.", words: "market apps plugins agents bots pi packages composio" },
  { id: "mcp", label: "MCP servers", icon: Server, about: "Tools your bots reach through the Model Context Protocol.", words: "server tools oauth catalog" },
  { id: "credentials", label: "Credentials", icon: LockKeyhole, about: "Keys and sign-ins your bots and tools use, kept encrypted.", words: "vault keys secrets passwords proton pass" },
  { id: "teamwork", label: "Teamwork", icon: UsersRound, about: "How your bots hand work to each other.", words: "handoff delegate together" },
  { id: "team", label: "Team", icon: Users, about: "The people on your team, what they may do, and their requests.", words: "requests invite members groups roles admin" },
  { id: "access", label: "Access", icon: KeyRound, about: "What bots may do on this computer without asking.", words: "permissions files folders shell approve allow" },
  { id: "computers", label: "Computers and teams", icon: MonitorSmartphone, about: "Other computers you use from here, and teams you joined.", words: "remote host pair join link" },
  { id: "node", label: "Node host", icon: Cpu, about: "Let this computer run work for another Botkins.", words: "node host server headless" },
  { id: "phone", label: "Phone", icon: Smartphone, about: "Phones and computers paired with this one.", words: "pair devices mobile qr" },
  { id: "voice", label: "Voice", icon: Mic, about: "How bots listen and speak, in chats and live calls.", words: "speech live voice microphone tts transcription" },
  { id: "usage", label: "Usage", icon: ChartColumn, about: "What your bots used, by day, bot and model.", words: "tokens cost spend runs" },
  { id: "storage", label: "Storage", icon: HardDrive, about: "What Botkins keeps on this computer to stay fast.", words: "cache clear" },
  // The id stays "account" so /login and older callers still land here.
  { id: "account", label: "Model providers", icon: Boxes, about: "Where your bots\u2019 models come from, and the keys and sign-ins for them.", words: "login sign in api key copilot claude openai providers limits" },
  { id: "experimental", label: "Experimental", icon: FlaskConical, about: "Early features you can try. They may change.", words: "proactive beta" },
  { id: "feedback", label: "Send feedback", icon: Bug, about: "Report a bug or ask for a feature on GitHub.", words: "bug feature issue report" },
  { id: "about", label: "About", icon: Info, about: "The version of Botkins and its updates.", words: "version update electron chromium platform" },
];

/** Where an older tab name, a section id or a section label opens. Callers still pass "Capabilities", "Bot", "Behavior"… */
export function sectionFor(tab: string): { section: SectionId; view?: BotView; teamView?: TeamView } {
  const key = tab.trim().toLowerCase();
  const teamView = /^team:(requests|invite|members|groups|roles)$/.exec(key)?.[1] as TeamView | undefined;
  if (teamView) return { section: "team", teamView };
  const legacy: Record<string, { section: SectionId; view?: BotView }> = {
    bot: { section: "bots", view: "model" },
    "bot settings": { section: "bots", view: "model" },
    profile: { section: "profile" },
    "bot profile": { section: "bots", view: "profile" },
    "user profile": { section: "profile" },
    "account profile": { section: "profile" },
    "botkins profile": { section: "profile" },
    capabilities: { section: "bots", view: "capabilities" },
    memory: { section: "bots", view: "memory" },
    "bot memory": { section: "bots", view: "memory" },
    "mcp servers": { section: "mcp" },
    "mcp server": { section: "mcp" },
    plugins: { section: "marketplace" },
    plugin: { section: "marketplace" },
    market: { section: "marketplace" },
    marketplace: { section: "marketplace" },
    vault: { section: "credentials" },
    keys: { section: "credentials" },
    "side menu": { section: "sidebar" },
    behavior: { section: "chats" },
    "chats & approvals": { section: "chats" },
    approvals: { section: "chats" },
    login: { section: "account" },
    "github copilot": { section: "account" },
    account: { section: "account" },
    providers: { section: "account" },
    "model providers": { section: "account" },
    "phone access": { section: "phone" },
    computers: { section: "computers" },
    "other computers": { section: "computers" },
    "join a team": { section: "computers" },
    node: { section: "node" },
    "node host": { section: "node" },
    speech: { section: "voice" },
    "live voice": { section: "voice" },
  };
  if (legacy[key]) return legacy[key];
  const match = SECTIONS.find((s) => s.id === key || s.label.toLowerCase() === key);
  return { section: match?.id ?? "general" };
}

let nextView: BotView | undefined;
/**
 * Opens the next Settings window on this bot view, whatever tab the caller passes.
 * The bot page uses it before `actions.capabilities(botId)` to land on Memory.
 */
export function openBotViewNext(view: BotView) {
  nextView = view;
}

/**
 * Settings: a full-window page in place of the app's side menu and page. On the left, Back, a
 * search and the sections in the phone's groups; on the right, one column of grouped rows.
 */
export default function Settings({
  state,
  bots,
  initialBot,
  initialTab,
  settings,
  initialJoin,
  runCount = 0,
  close,
  createBot,
}: {
  state: State;
  bots: Bot[];
  initialBot: string;
  initialTab: string;
  settings: Preferences;
  initialJoin?: string;
  /** Refreshes Usage when runs change. */
  runCount?: number;
  close?: () => void;
  /** Opens Create a bot filled in from an agent template (Marketplace › Agents). */
  createBot?: (template: MarketAgentTemplate) => void;
}) {
  const [start] = useState<{ section: SectionId; view?: BotView; teamView?: TeamView }>(() => {
    const s = sectionFor(initialTab);
    const v = nextView;
    nextView = undefined;
    return v ? { section: "bots" as SectionId, view: v } : s;
  });
  const [id, setId] = useState(initialBot || bots[0]?.id || ""),
    [section, setSection] = useState<SectionId>(start.section),
    [skillToOpen, setSkillToOpen] = useState<string>(),
    // The installed plugin that Skills asked to show: Marketplace opens on its page.
    [pluginToOpen, setPluginToOpen] = useState<string>(),
    [view, setView] = useState<BotView>(start.view ?? "model");
  useEffect(() => { if (section === "skills") setSkillToOpen(undefined); }, [section]);
  const teamView = start.teamView ?? "requests";
  const member = memberTeam(state);
  const memberHost = !!member || state.remote?.using?.member === true;
  // A computer this window reaches over the link may be older: routines have their own models from "routine-models-v1".
  const routineModels = !state.remote?.using || !!state.remote.using.capabilities?.includes("routine-models-v1");
  const sections = SECTIONS.filter((item) => {
    if (item.id === "team" && state.remote?.using) return false;
    if (item.id === "node" && state.remote?.using) return false;
    // A computer reached over the link may be older than this window: it says so in its capabilities.
    if (item.id === "experimental" && state.remote?.using && !state.remote.using.capabilities?.includes("proactive-agent-v2")) return false;
    if (!memberHost) return true;
    if (item.id === "experimental" || item.id === "node" ||
      item.id === "team" || item.id === "credentials" || item.id === "teamwork" || item.id === "access" || item.id === "usage" || item.id === "storage" || item.id === "account" || item.id === "voice") return false;
    if (item.id === "bots") return teamCan(state, "agents");
    if (item.id === "skills") return teamCan(state, "skills");
    if (item.id === "marketplace") return teamCan(state, "plugins") || teamCan(state, "skills", "read");
    if (item.id === "mcp") return teamCan(state, "mcp");
    if (item.id === "notifications") return teamCan(state, "settings", "manage");
    return true;
  });
  // Shown at once as the person changes them, and brought in step whenever the saved settings
  // change, here or from somewhere else (a paired phone, or the app settling a choice).
  const [preferences, setPreferences] = useState(settings);
  useEffect(() => setPreferences(settings), [settings]);
  async function changePreferences(patch: Parameters<typeof api.setPreferences>[0]) {
    setPreferences((p) => ({
      ...p,
      ...patch,
      appearance: { ...p.appearance, ...patch.appearance },
      ...(p.proactive && patch.proactive && { proactive: { ...p.proactive, ...patch.proactive } }),
    }) as Preferences);
    try {
      await api.setPreferences(patch);
    } catch (e) {
      setPreferences((await api.snapshot()).settings);
      throw e;
    }
  }
  const bot = bots.find((b) => b.id === id) ?? bots[0];
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [cache, setCache] = useState<{ bytes: number; catalogs: number }>();
  const sources = JSON.stringify([state.mcpServers, state.skills, bot?.skillsOff, bot?.mcpOff]);
  useEffect(() => {
    setCatalog(null);
    setError("");
    setMessage("");
  }, [id, sources, section, view]);
  useEffect(() => {
    if (section === "storage")
      api
        .cacheInfo()
        .then(setCache)
        .catch((e) => setError(String(e)));
  }, [section]);
  const menu = useRef<HTMLDivElement>(null);
  // Open on the chosen section with focus in the side menu, as a native settings window does.
  useEffect(() => {
    const focus = () => {
      const chosen = menu.current?.querySelector<HTMLElement>("[aria-selected=true]");
      chosen?.focus();
      chosen?.scrollIntoView({ block: "nearest" });
    };
    focus();
    // The window that holds this page is shown just after it is drawn, and showing it puts focus on
    // the first thing that can take it. When the menu is too long for the window and scrolls, that
    // is the menu itself, not a section. So the chosen section takes focus again once it is shown.
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, []);
  async function act(fn: () => Promise<void>) {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  // The search over the side list: a section's name, and the words of the rows inside it.
  const [find, setFind] = useState("");
  const query = find.trim().toLowerCase();
  const shown = query ? sections.filter((s) => (s.label + " " + (s.words ?? "")).toLowerCase().includes(query)) : sections;
  function move(e: KeyboardEvent<HTMLDivElement>) {
    const at = shown.findIndex((s) => s.id === section);
    const next =
      e.key === "ArrowDown"
        ? (at + 1) % shown.length
        : e.key === "ArrowUp"
          ? (at - 1 + shown.length) % shown.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? shown.length - 1
              : -1;
    if (next < 0 || !shown.length) return;
    e.preventDefault();
    setSection(shown[next].id);
    menu.current?.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus();
  }
  const current = sections.find((s) => s.id === section) ?? sections[0];
  const focusable = shown.some((s) => s.id === section) ? section : shown[0]?.id;
  const requests = state.team && "requests" in state.team ? state.team.requests.length : 0;
  return (
    <div className="settings-page">
      <nav className="set-sidebar" aria-label="Settings sections">
        {close && (
          <button type="button" className="set-back" aria-label="Back to Botkins" onClick={close}>
            <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
            Back
          </button>
        )}
        <h2 className="set-title">Settings</h2>
        <label className="set-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search settings"
            placeholder="Search settings"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              // The first Escape clears the search; the next one closes Settings.
              if (e.key === "Escape" && find) {
                e.preventDefault();
                e.stopPropagation();
                setFind("");
              }
              if (e.key === "ArrowDown" && shown.length) {
                e.preventDefault();
                setSection(shown[0].id);
                menu.current?.querySelector<HTMLElement>("[role=tab]")?.focus();
              }
            }}
          />
        </label>
        <div role="tablist" aria-orientation="vertical" aria-label="Settings" ref={menu} onKeyDown={move}>
          {GROUPS.map((group, at) => {
            const items = group.ids.map((id) => shown.find((s) => s.id === id)).filter((s) => !!s);
            if (!items.length) return null;
            return (
              <Fragment key={at}>
                {!query && group.title && <span className="set-group-label" role="presentation">{group.title}</span>}
                {!query && group.rule && <span className="set-rule" role="presentation" />}
                {items.map(({ id: s, label, icon: Icon }) => (
                  <button
                    key={s}
                    type="button"
                    role="tab"
                    id={"set-tab-" + s}
                    aria-selected={section === s}
                    aria-controls="set-pane"
                    tabIndex={focusable === s ? 0 : -1}
                    onClick={() => setSection(s)}
                  >
                    <span className={"icon-tile set-icon" + (group.tile ? " " + group.tile : "")} aria-hidden="true">
                      <Icon size={14} strokeWidth={2} />
                    </span>
                    <span className="set-tab-label">{label}</span>
                    {s === "team" && requests > 0 && (
                      <span className="count-badge set-tab-badge" aria-hidden="true">{requests}</span>
                    )}
                  </button>
                ))}
              </Fragment>
            );
          })}
        </div>
        {!shown.length && <p className="set-none" role="status">No settings match “{find.trim()}”.</p>}
      </nav>
      <div className="set-pane" id="set-pane" role="tabpanel" aria-labelledby={"set-tab-" + section}>
        {/* Escape closes Settings too (the app listens for it). Smokes close Settings by this name. */}
        {close && (
          <button type="button" className="icon-btn set-close" aria-label="Close dialog" title="Close (Esc)" onClick={close}>
            <X size={18} />
          </button>
        )}
        <div className="set-scroll" key={section}>
          <div className={"set-page" + (section === "marketplace" || section === "usage" ? " wide" : "")}>
          <div className="page-head set-pane-head">
            <div className="page-heading">
              <h2 className="page-title">{current.label}</h2>
              <p className="page-sub">{current.about}</p>
            </div>
            {section === "bots" && bot && (
              <div className="page-actions set-bot">
                <BotAvatar bot={bot} size={28} />
                <label className="visually-hidden" htmlFor="set-bot">
                  Bot
                </label>
                <select id="set-bot" disabled={busy} value={bot.id} onChange={(e) => setId(e.target.value)}>
                  {bots.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          {section === "general" && (
            <>
              <Group
                title="Default model"
                footer="Bots and chats use this unless they choose their own."
              >
                <div className="set-row stacked set-picker">
                  <ModelPicker scope="global" id={null} value={settings.model} speedSettings={!state.remote?.using || state.remote.using.capabilities.includes("fast-mode-v1") ? { value: settings.fastMode } : undefined} openProviders={() => setSection("account")} />
                </div>
              </Group>
              {routineModels && (
                <Group title="Default routines model" footer="Routines use this unless they choose their own. It comes before a bot's own default model.">
                  <div className="set-row stacked set-picker">
                    <ModelPicker scope="routines" id={null} value={settings.routineModel} inherited={settings.model} openProviders={() => setSection("account")} />
                  </div>
                </Group>
              )}
              <HarnessSettings
                settings={preferences}
                change={changePreferences}
                fail={fail}
                setup={!state.remote?.using || state.remote.using.capabilities.includes("provider-signin-v1")}
                windows={!state.remote?.using && /Windows/i.test(navigator.userAgent)}
              />
              <TaskSettings settings={preferences} limits={state.taskLimits} change={changePreferences} fail={fail} />
              <BackgroundSettings settings={preferences} change={changePreferences} fail={fail} />
            </>
          )}
          {section === "profile" && <ProfileSettings state={state} />}
          {section === "appearance" && (
            <AppearanceSettings settings={preferences} change={changePreferences} fail={fail} />
          )}
          {section === "sidebar" && <SidebarSettings settings={state.settings} spaces={hasSpaces(state)} fail={fail} />}
          {section === "chats" && <>
            <ChatDisplaySettings settings={{ ...settings, showUpdates: preferences.showUpdates }} change={changePreferences} chatMode={state.proactive?.chatMode} fail={fail} />
            {(!memberHost || teamCan(state, "settings", "manage")) && <>
              <SummarySettings settings={preferences} change={changePreferences} fail={fail} />
              <BehaviorSettings settings={preferences} change={changePreferences} fail={fail} />
            </>}
          </>}
          {section === "notifications" && (
            <NotificationPreferences
              value={preferences.notifications}
              change={(notifications) => changePreferences({ notifications })}
              fail={fail}
            />
          )}
          {section === "bots" && !bot && (
            <p className="set-status" role="status">
              This computer has no bots yet.
            </p>
          )}
          {section === "bots" && bot && (
            <>
              <div className="set-toolbar set-views">
                <GlassTabBar
                  aria-label={bot.name + " settings"}
                  value={view}
                  items={[
                    { value: "model", label: "Model" },
                    { value: "profile", label: "Profile" },
                    { value: "capabilities", label: "Capabilities" },
                    { value: "memory", label: "Memory" },
                  ]}
                  onValueChange={(next) => setView(next as typeof view)}
                />
              </div>
              {view === "model" && (
                <Group title="Default model" footer={"The default for new chats with " + bot.name + "."}>
                  <div className="set-row stacked set-picker">
                    <ModelPicker
                      key={id}
                      scope="bot"
                      id={id}
                      value={bot.model}
                      speedSettings={!state.remote?.using || state.remote.using.capabilities.includes("fast-mode-v1") ? { value: bot.fastMode, inherited: settings.fastMode } : undefined}
                      inherited={settings.model}
                      openProviders={() => setSection("account")}
                    />
                  </div>
                </Group>
              )}
              {view === "profile" && (
                <BotProfileForm key={id} bot={bot} busy={busy} act={act} done={() => setMessage("Bot updated.")} />
              )}
              {view === "memory" && <BotMemory bot={bot} />}
              {view === "capabilities" && (
                <>
                  <BotIntegrations state={state} bot={bot} teamworkOn={preferences.teamwork !== false} go={setSection} />
                  <Group title="Inspect">
                    <div className="set-row">
                      <div className="set-label">
                        <span className="set-name">What {bot.name} can use</span>
                        <small>Plugins, MCP servers, skills, commands and tools.</small>
                      </div>
                      <div className="set-control">
                        <Button
                          variant="glass"
                          className="lg-compact"
                          disabled={busy}
                          onClick={() => act(async () => setCatalog(await api.catalog(id, undefined, true)))}
                        >
                          {busy ? "Working…" : "Inspect capabilities"}
                        </Button>
                      </div>
                    </div>
                    {catalog && (
                      <div className="set-row stacked inventory">
                        <h3>Available to {bot.name}</h3>
                        <small>
                          {catalog.choices.filter((c) => c.kind === "Skill").length} skills ·{" "}
                          {catalog.choices.filter((c) => c.kind === "Command").length} commands ·{" "}
                          {catalog.choices.filter((c) => c.kind === "Tool").length} tools
                        </small>
                        <details>
                          <summary>Plugins ({catalog.plugins.length})</summary>
                          {catalog.plugins.map((p, i) => (
                            <small key={i}>
                              {p.name} · {p.enabled ? "enabled" : "disabled"}
                            </small>
                          ))}
                        </details>
                        <details>
                          <summary>MCP servers ({catalog.servers.length})</summary>
                          {catalog.servers.map((s) => (
                            <small key={s.name}>
                              {s.name} · {s.status}
                            </small>
                          ))}
                        </details>
                        <details>
                          <summary>Commands, skills and tools</summary>
                          {catalog.choices.map((c) => (
                            <small key={c.command}>
                              /{c.command} · {c.source}
                            </small>
                          ))}
                        </details>
                      </div>
                    )}
                  </Group>
                </>
              )}
            </>
          )}
          {section === "skills" && (
            <SkillsSettings key={state.remote?.using?.id ?? "local"}
              initialSkill={skillToOpen}
              stamp={JSON.stringify(state.skills ?? null)}
              plugins={state.plugins}
              hostId={state.remote?.using?.id}
              scriptsAllowed={!state.remote?.using || (!!state.remote.using.capabilities?.includes("script-commands-v1") && !state.remote.using.member)}
              openPlugin={(id) => {
                setPluginToOpen(id);
                setSection("marketplace");
              }}
            />
          )}
          {section === "marketplace" && <PluginsSettings openSkill={name => { setSkillToOpen(name); setSection("skills"); }} key={pluginToOpen ?? ""} state={state} bots={bots} open={pluginToOpen} createBot={createBot} />}
          {section === "mcp" && <McpSettings state={state} credentials={() => setSection("credentials")} />}
          {section === "credentials" && <CredentialsSettings state={state} mcp={() => setSection("mcp")} />}
          {section === "teamwork" && (
            <TeamworkSettings
              state={state}
              on={preferences.teamwork !== false}
              change={(teamwork) => void changePreferences({ teamwork }).catch(fail)}
              fail={setError}
            />
          )}
          {section === "team" && <TeamSettings state={state} initialView={teamView} />}
          {section === "access" && <AccessSettings state={state} />}
          {/* Phones and computers paired to this one. While another computer is in use its own devices are managed there. */}
          {section === "phone" &&
            (state.remote?.using ? (
              <p className="set-status" role="status">
                You are using {state.remote.using.name}. The phones and computers paired to it are managed on {state.remote.using.name} itself.
              </p>
            ) : (
              <PhoneSettings state={state} />
            ))}
          {section === "computers" && <ComputersAndTeams state={state} initialJoin={initialJoin} />}
          {section === "node" && <NodeHostSettings state={state} fail={fail} />}
          {section === "voice" && <VoiceSettings state={state} />}
          {section === "usage" && <Usage runCount={runCount} />}
          {section === "storage" && (
            <Group
              title="Workspace cache"
              footer="Clearing keeps your chats, bots, panels and routines."
              actions={
                <button
                  type="button"
                  className="set-button"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await api.clearCache();
                      setCache(await api.cacheInfo());
                      setMessage("Cache cleared.");
                    })
                  }
                >
                  Clear cache
                </button>
              }
            >
              <ValueRow label="Browser cache" value={cache ? (cache.bytes / 1024 / 1024).toFixed(1) + " MB" : "Measuring…"} />
              <ValueRow
                label="Saved capability menus"
                value={cache ? String(cache.catalogs) : "…"}
                help="So “/” opens fast."
              />
            </Group>
          )}
          {section === "account" && (
            <ProviderSettings
              key={state.remote?.using?.id ?? "local"}
              setup={!state.remote?.using || state.remote.using.capabilities.includes("provider-signin-v1")}
              windows={!state.remote?.using && /Windows/i.test(navigator.userAgent)}
              general={() => setSection("general")}
            />
          )}
          {section === "experimental" && <ExperimentalSettings state={state} bots={bots} settings={preferences} change={changePreferences} />}
          {section === "feedback" && <Feedback />}
          {section === "about" && <About />}
          {error && (
            <p className="set-status error-text" role="alert">
              {error}
            </p>
          )}
          {message && (
            <p className="set-status" role="status">
              {message}
            </p>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Bots & capabilities › Profile: name, role, instructions and when this bot asks questions. */
function BotProfileForm({
  bot,
  busy,
  act,
  done,
}: {
  bot: Bot;
  busy: boolean;
  act: (fn: () => Promise<void>) => Promise<void>;
  done: () => void;
}) {
  return (
    <form
      className="set-group"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void act(async () => {
          await api.updateBot(bot.id, {
            name: String(f.get("name")),
            role: String(f.get("role")),
            instructions: String(f.get("instructions")),
            clarificationInstructions: String(f.get("clarificationInstructions") || ""),
          });
          done();
        });
      }}
    >
      <div className="set-card">
        <Row label="Name">
          {(id) => <Input id={id} name="name" required maxLength={48} defaultValue={bot.name} />}
        </Row>
        <Row label="Role">
          {(id) => <Input id={id} name="role" required maxLength={90} defaultValue={bot.role} />}
        </Row>
        <Row label="Instructions" stacked>
          {(id) => <textarea id={id} name="instructions" required rows={3} maxLength={30000} defaultValue={bot.instructions} />}
        </Row>
        <Row label="Ask for clarification when" help="Added to the questions in Chats & approvals." stacked>
          {(id, d) => (
            <textarea
              id={id}
              aria-describedby={d}
              name="clarificationInstructions"
              rows={2}
              maxLength={4000}
              defaultValue={bot.clarificationInstructions}
              placeholder="Ask me for a deadline before planning a project."
            />
          )}
        </Row>
        <div className="set-actions">
          <Button type="submit" variant="filled" className="lg-compact" disabled={busy}>
            Save bot
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Settings › Send feedback: a bug report or a feature request, opened as an issue on the public Botkins repo. */
function Feedback() {
  const [kind, setKind] = useState<"bug" | "feature">("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [sent, setSent] = useState<{ number: number; url: string } | null>(null);
  const ready = title.trim().length >= 4 && body.trim().length >= 4 && !busy;
  async function send() {
    setBusy(true);
    setProblem("");
    try {
      setSent(await api.sendFeedback({ kind, title: title.trim(), body: body.trim() }));
      setTitle("");
      setBody("");
    } catch (error) { setProblem(errorText(error)); }
    finally { setBusy(false); }
  }
  if (sent) return (
    <Group>
      <Row label={"Thanks. It\u2019s issue #" + sent.number + "."} help="You can follow it, and add to it, on GitHub.">
        {(id) => <div className="set-buttons">
          <button id={id} type="button" className="set-button" onClick={() => void api.openLink(sent.url)}>Open on GitHub</button>
          <button type="button" className="set-button" onClick={() => setSent(null)}>Send another</button>
        </div>}
      </Row>
    </Group>
  );
  return (
    <Group
      footer="This opens a public issue on GitHub with what you write here, the app version and your platform. Leave out names, chats and anything private."
      actions={<button type="button" className="set-button primary" disabled={!ready} onClick={() => void send()}>{busy ? "Sending\u2026" : kind === "bug" ? "Report bug" : "Send request"}</button>}
    >
      <Row label="Kind">
        {(id) => <select id={id} value={kind} onChange={(e) => setKind(e.target.value === "feature" ? "feature" : "bug")}>
          <option value="bug">Bug report</option>
          <option value="feature">Feature request</option>
        </select>}
      </Row>
      <Row label="Title" stacked>
        {(id) => <input id={id} value={title} maxLength={120} placeholder={kind === "bug" ? "What went wrong, in a few words" : "What you\u2019d like, in a few words"} onChange={(e) => setTitle(e.target.value)} />}
      </Row>
      <Row label={kind === "bug" ? "What happened" : "Details"} help={problem || undefined} stacked>
        {(id, describedBy) => <textarea id={id} aria-describedby={describedBy} rows={8} value={body} maxLength={8000} placeholder={kind === "bug" ? "What you did, what you expected, and what happened instead." : "What it would let you do, and how you\u2019d use it."} onChange={(e) => setBody(e.target.value)} />}
      </Row>
    </Group>
  );
}

/** Settings › About: the app mark and version. */
function About() {
  const [info, setInfo] = useState<AppInfo>();
  const [update, setUpdate] = useState<AppUpdate>();
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    let mounted = true;
    const refresh = () => api.appUpdateStatus().then(value => { if (mounted) setUpdate(value); }).catch(() => {});
    void refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);
  async function updateAction(install: boolean) {
    setWorking(true);
    setProblem("");
    try { setUpdate(await (install ? api.installAppUpdate() : api.checkAppUpdate())); }
    // The reason as the app said it, without the words the window's bridge puts in front of an error.
    catch (error) { setProblem(errorText(error)); }
    finally { setWorking(false); }
  }
  const status = update?.status;
  const label = status === "current" ? "You’re up to date." : status === "available" ? "Version " + update?.latest + " is available."
    : status === "checking" ? "Checking GitHub…" : status === "downloading" ? "Downloading update…" : status === "restarting" ? "Restarting after the current request…" : "";
  useEffect(() => {
    api.appInfo().then(setInfo).catch(() => {});
  }, []);
  const platform: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };
  return (
    <>
      <div className="set-about">
        <img src="./icon.png" alt="" />
        <strong>Botkins</strong>
        <small>{info ? "Version " + info.version : "Version …"}</small>
        <p>A workspace for your AI bots, on your computer.</p>
      </div>
      <Group>
        <ValueRow label="Version" value={info?.version ?? "…"} />
        <Row label="Updates" help={problem || update?.message || label || "Botkins checks GitHub Releases automatically."}>
          {(id) => <div className="set-buttons">
            <button id={id} type="button" className="set-button" disabled={working || status === "downloading" || status === "restarting"} onClick={() => void updateAction(!!update?.canInstall)}>{update?.canInstall ? "Update and restart" : "Check for updates"}</button>
            {(status === "error" || (status === "available" && !update?.canInstall)) && <button type="button" className="set-button" onClick={() => void api.openAppRelease()}>Open release</button>}
          </div>}
        </Row>
        {typeof update?.auto === "boolean" && <SwitchRow label="Install updates automatically"
          help="Restart to install a signed update when your bots are idle." checked={update.auto} disabled={working}
          onChange={async (on) => {
            setWorking(true);
            setProblem("");
            try { setUpdate(await api.setAppUpdateAuto(on)); }
            catch (error) { setProblem(errorText(error)); }
            finally { setWorking(false); }
          }} />}
        <ValueRow label="Electron" value={info?.electron ?? "…"} />
        <ValueRow label="Chromium" value={info?.chrome ?? "…"} />
        <ValueRow label="Platform" value={info ? platform[info.platform] ?? info.platform : "…"} />
      </Group>
    </>
  );
}

/** Settings › Notifications: what alerts, quiet hours and a test. */
function NotificationPreferences({
  value,
  change,
  fail,
}: {
  value: NotificationSettings;
  change: (v: NotificationSettings) => Promise<void>;
  fail: (e: unknown) => void;
}) {
  const [sent, setSent] = useState("");
  const set = (patch: Partial<NotificationSettings>) => void change({ ...value, ...patch }).catch(fail);
  const quiet = value.quietHours;
  const toggles: [keyof NotificationSettings, string, string][] = [
    ["replies", "Replies", "When a bot finishes while Botkins is in the background."],
    ["routines", "Routines", "When a routine finishes or fails."],
    ["requests", "Questions & approvals", "When a bot needs your answer or approval."],
  ];
  // One plain reminder for what is left waiting, for each person and their own phones too. No model. Missing on an older computer.
  const reminders = value.reminders;
  return (
    <>
      <Group title="Notify me about">
        {toggles.map(([key, label, hint]) => (
          <SwitchRow key={key} label={label} help={hint} checked={value[key] as boolean} onChange={(on) => set({ [key]: on })} />
        ))}
        {reminders !== undefined && <SwitchRow label="Reminders" help="Once, when a bot is left waiting on someone." checked={reminders} onChange={(on) => set({ reminders: on })} />}
      </Group>
      <Group
        title="Quiet hours"
        actions={
          <>
            {sent && (
              <span className="set-wait" role="status">
                {sent}
              </span>
            )}
            <button
              type="button"
              className="set-button"
              onClick={() =>
                window.botkins
                  .testNotification()
                  .then(() => setSent("Sent. Nothing? Allow Botkins in your system settings."))
                  .catch(fail)
              }
            >
              Send test
            </button>
          </>
        }
      >
        <SwitchRow
          label="Silence notifications"
          help="Alerts in these hours are skipped, not sent later."
          checked={quiet.enabled}
          onChange={(on) => set({ quietHours: { ...quiet, enabled: on } })}
        />
        {quiet.enabled && (
          <div className="set-row">
            <div className="set-label">
              <span className="set-name">Hours</span>
            </div>
            <div className="set-control set-times">
              <label>
                From
                <input
                  type="time"
                  required
                  value={quiet.from}
                  onChange={(e) => e.target.value && set({ quietHours: { ...quiet, from: e.target.value } })}
                />
              </label>
              <label>
                To
                <input
                  type="time"
                  required
                  value={quiet.to}
                  onChange={(e) => e.target.value && set({ quietHours: { ...quiet, to: e.target.value } })}
                />
              </label>
            </div>
          </div>
        )}
      </Group>
    </>
  );
}
