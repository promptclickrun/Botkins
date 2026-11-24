import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Bell,
  Bot as BotIcon,
  Boxes,
  ChartColumn,
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
  X,
  type LucideIcon,
} from "lucide-react";
import type { AppUpdate, AppInfo, Bot, Catalog, MarketAgentTemplate, Preferences, State, NotificationSettings } from "./types";
import ModelPicker from "./ModelPicker";
import { AppearanceSettings, BehaviorSettings, ChatDisplaySettings, BackgroundSettings, HarnessSettings, SummarySettings } from "./Preferences";
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
  | "phone"
  | "voice"
  | "usage"
  | "storage"
  | "account"
  | "experimental"
  | "about";
type BotView = "profile" | "model" | "capabilities" | "memory";
const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "profile", label: "Profile", icon: UserCircle },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "sidebar", label: "Side menu", icon: PanelLeft },
  { id: "chats", label: "Chat", icon: MessageSquareMore },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "bots", label: "Bots & capabilities", icon: BotIcon },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "marketplace", label: "Marketplace", icon: Store },
  { id: "mcp", label: "MCP servers", icon: Server },
  { id: "credentials", label: "Credentials", icon: LockKeyhole },
  { id: "teamwork", label: "Teamwork", icon: UsersRound },
  { id: "team", label: "Team", icon: Users },
  { id: "access", label: "Access", icon: KeyRound },
  { id: "computers", label: "Computers and teams", icon: MonitorSmartphone },
  { id: "phone", label: "Phone", icon: Smartphone },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "usage", label: "Usage", icon: ChartColumn },
  { id: "storage", label: "Storage", icon: HardDrive },
  // The id stays "account" so /login and older callers still land here.
  { id: "account", label: "Model providers", icon: Boxes },
  { id: "experimental", label: "Experimental", icon: FlaskConical },
  { id: "about", label: "About", icon: Info },
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

/** The Settings window: a side menu of sections and one pane of grouped rows. */
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
    // A computer reached over the link may be older than this window: it says so in its capabilities.
    if (item.id === "experimental" && state.remote?.using && !state.remote.using.capabilities?.includes("proactive-agent-v2")) return false;
    if (!memberHost) return true;
    if (item.id === "experimental" ||
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
  function move(e: KeyboardEvent<HTMLDivElement>) {
    const at = sections.findIndex((s) => s.id === section);
    const next =
      e.key === "ArrowDown"
        ? (at + 1) % sections.length
        : e.key === "ArrowUp"
          ? (at - 1 + sections.length) % sections.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ?               sections.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    setSection(sections[next].id);
    menu.current?.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus();
  }
  const current = sections.find((s) => s.id === section) ?? sections[0];
  return (
    <div className="settings-window-body">
      <div className="set-sidebar">
        <h2>Settings</h2>
        <div role="tablist" aria-orientation="vertical" aria-label="Settings" ref={menu} onKeyDown={move}>
          {sections.map(({ id: s, label, icon: Icon }) => (
            <button
              key={s}
              type="button"
              role="tab"
              id={"set-tab-" + s}
              aria-selected={section === s}
              aria-controls="set-pane"
              tabIndex={section === s ? 0 : -1}
              onClick={() => setSection(s)}
            >
              <span className="set-icon" aria-hidden="true">
                <Icon size={17} strokeWidth={1.8} />
              </span>
              {label}
              {s === "team" && state.team && "requests" in state.team && state.team.requests.length > 0 && (
                <span className="set-tab-badge" aria-hidden="true">{state.team.requests.length}</span>
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="set-pane" id="set-pane" role="tabpanel" aria-labelledby={"set-tab-" + section}>
        <div className="set-pane-head">
          <h2>{current.label}</h2>
          {close && (
            <button type="button" className="set-close" aria-label="Close dialog" onClick={close}>
              <X size={17} />
            </button>
          )}
        </div>
        <div className="set-scroll" key={section}>
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
              <BackgroundSettings settings={preferences} change={changePreferences} fail={fail} />
            </>
          )}
          {section === "profile" && <ProfileSettings state={state} />}
          {section === "appearance" && (
            <AppearanceSettings settings={preferences} change={changePreferences} fail={fail} />
          )}
          {section === "sidebar" && <SidebarSettings settings={state.settings} spaces={hasSpaces(state)} fail={fail} />}
          {section === "chats" && <>
            <ChatDisplaySettings settings={settings} />
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
          {section === "bots" && (
            <>
              <div className="set-toolbar">
                <span className="set-bot">
                  <BotAvatar bot={bot} size={30} />
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
                </span>
                <div className="segmented" role="tablist" aria-label={bot.name + " settings"}>
                  {(
                    [
                      ["model", "Model"],
                      ["profile", "Profile"],
                      ["capabilities", "Capabilities"],
                      ["memory", "Memory"],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      role="tab"
                      aria-selected={view === v}
                      onClick={() => setView(v)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
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
                        <button
                          type="button"
                          className="set-button"
                          disabled={busy}
                          onClick={() => act(async () => setCatalog(await api.catalog(id, undefined, true)))}
                        >
                          {busy ? "Working…" : "Inspect capabilities"}
                        </button>
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
          {(id) => <input id={id} name="name" required maxLength={48} defaultValue={bot.name} />}
        </Row>
        <Row label="Role">
          {(id) => <input id={id} name="role" required maxLength={90} defaultValue={bot.role} />}
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
          <button className="set-button primary" disabled={busy}>
            Save bot
          </button>
        </div>
      </div>
    </form>
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
          {(id) => <div>
            <button id={id} className="secondary" disabled={working || status === "downloading" || status === "restarting"} onClick={() => void updateAction(!!update?.canInstall)}>{update?.canInstall ? "Update and restart" : "Check for updates"}</button>
            {(status === "error" || (status === "available" && !update?.canInstall)) && <button className="secondary" onClick={() => void api.openAppRelease()}>Open release</button>}
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
  return (
    <>
      <Group title="Notify me about">
        {toggles.map(([key, label, hint]) => (
          <SwitchRow key={key} label={label} help={hint} checked={value[key] as boolean} onChange={(on) => set({ [key]: on })} />
        ))}
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
