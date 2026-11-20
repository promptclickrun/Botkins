import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Bell,
  Bot as BotIcon,
  Boxes,
  ChartColumn,
  HardDrive,
  Info,
  KeyRound,
  LockKeyhole,
  MessageSquareMore,
  PanelLeft,
  Palette,
  Server,
  Store,
  Smartphone,
  Mic,
  Settings2,
  Sparkles,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AppUpdate, AppInfo, Bot, Catalog, Preferences, State, NotificationSettings } from "./types";
import ModelPicker from "./ModelPicker";
import { AppearanceSettings, BehaviorSettings, BackgroundSettings, HarnessSettings } from "./Preferences";
import Usage from "./Usage";
import { OtherComputers } from "./RemoteHosts";
import AccessSettings from "./AccessSettings";
import { BotAvatar } from "./Avatar";
import { Group, Row, SwitchRow, ValueRow } from "./SettingsRows";
import ProviderSettings from "./ProviderSettings";
import SkillsSettings from "./SkillsSettings";
import McpSettings, { CredentialsSettings } from "./McpSettings";
import PhoneSettings from "./PhoneSettings";
import VoiceSettings from "./VoiceSettings";
import SidebarSettings from "./SidebarSettings";
import TeamworkSettings from "./TeamworkSettings";
import BotIntegrations from "./BotIntegrations";
import BotMemory from "./BotMemory";
import PluginsSettings from "./PluginsSettings";
import "./settings.css";

const api = window.botkins;

export type SectionId =
  | "general"
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
  | "access"
  | "phone"
  | "voice"
  | "usage"
  | "storage"
  | "account"
  | "about";
type BotView = "profile" | "model" | "capabilities" | "memory";
const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "sidebar", label: "Side menu", icon: PanelLeft },
  { id: "chats", label: "Chats & approvals", icon: MessageSquareMore },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "bots", label: "Bots & capabilities", icon: BotIcon },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "marketplace", label: "Marketplace", icon: Store },
  { id: "mcp", label: "MCP servers", icon: Server },
  { id: "credentials", label: "Credentials", icon: LockKeyhole },
  { id: "teamwork", label: "Teamwork", icon: UsersRound },
  { id: "access", label: "Access", icon: KeyRound },
  { id: "phone", label: "Phone", icon: Smartphone },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "usage", label: "Usage", icon: ChartColumn },
  { id: "storage", label: "Storage", icon: HardDrive },
  // The id stays "account" so /login and older callers still land here.
  { id: "account", label: "Model providers", icon: Boxes },
  { id: "about", label: "About", icon: Info },
];

/** Where an older tab name, a section id or a section label opens. Callers still pass "Capabilities", "Bot", "Behavior"… */
export function sectionFor(tab: string): { section: SectionId; view?: BotView } {
  const key = tab.trim().toLowerCase();
  const legacy: Record<string, { section: SectionId; view?: BotView }> = {
    bot: { section: "bots", view: "model" },
    "bot settings": { section: "bots", view: "model" },
    profile: { section: "bots", view: "profile" },
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
    approvals: { section: "chats" },
    login: { section: "account" },
    "github copilot": { section: "account" },
    account: { section: "account" },
    providers: { section: "account" },
    "model providers": { section: "account" },
    "phone access": { section: "phone" },
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
  runCount = 0,
  close,
}: {
  state: State;
  bots: Bot[];
  initialBot: string;
  initialTab: string;
  settings: Preferences;
  /** Refreshes Usage when runs change. */
  runCount?: number;
  close?: () => void;
}) {
  const [start] = useState(() => {
    const s = sectionFor(initialTab);
    const v = nextView;
    nextView = undefined;
    return v ? { section: "bots" as SectionId, view: v } : s;
  });
  const [id, setId] = useState(initialBot || bots[0].id),
    [section, setSection] = useState<SectionId>(start.section),
    [view, setView] = useState<BotView>(start.view ?? "model");
  // Shown at once as the person changes them, and brought in step whenever the saved settings
  // change, here or from somewhere else (a paired phone, or the app settling a choice).
  const [preferences, setPreferences] = useState(settings);
  useEffect(() => setPreferences(settings), [settings]);
  async function changePreferences(patch: Parameters<typeof api.setPreferences>[0]) {
    setPreferences((p) => ({
      ...p,
      ...patch,
      appearance: { ...p.appearance, ...patch.appearance },
    }));
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
  const sources = JSON.stringify([state.mcpServers, state.skills, bot.skillsOff, bot.mcpOff]);
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
    menu.current?.querySelector<HTMLElement>("[aria-selected=true]")?.focus();
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
    const at = SECTIONS.findIndex((s) => s.id === section);
    const next =
      e.key === "ArrowDown"
        ? (at + 1) % SECTIONS.length
        : e.key === "ArrowUp"
          ? (at - 1 + SECTIONS.length) % SECTIONS.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? SECTIONS.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    setSection(SECTIONS[next].id);
    menu.current?.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus();
  }
  const current = SECTIONS.find((s) => s.id === section)!;
  return (
    <div className="settings-window-body">
      <div className="set-sidebar">
        <h2>Settings</h2>
        <div role="tablist" aria-orientation="vertical" aria-label="Settings" ref={menu} onKeyDown={move}>
          {SECTIONS.map(({ id: s, label, icon: Icon }) => (
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
                  <ModelPicker scope="global" id={null} value={settings.model} openProviders={() => setSection("account")} />
                </div>
              </Group>
              <HarnessSettings settings={preferences} change={changePreferences} fail={fail} />
              <BackgroundSettings settings={preferences} change={changePreferences} fail={fail} />
            </>
          )}
          {section === "appearance" && (
            <AppearanceSettings settings={preferences} change={changePreferences} fail={fail} />
          )}
          {section === "sidebar" && <SidebarSettings settings={state.settings} fail={fail} />}
          {section === "chats" && <BehaviorSettings settings={preferences} change={changePreferences} fail={fail} />}
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
          {section === "skills" && <SkillsSettings stamp={JSON.stringify(state.skills ?? null)} />}
          {section === "marketplace" && <PluginsSettings state={state} bots={bots} />}
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
          {section === "access" && <AccessSettings state={state} />}
          {/* Phones and computers paired to this one, then the computers this app uses. While another
              computer is in use its own devices are managed there. */}
          {section === "phone" &&
            (state.remote?.using ? (
              <p className="set-status" role="status">
                You are using {state.remote.using.name}. The phones and computers paired to it are managed on {state.remote.using.name} itself.
              </p>
            ) : (
              <PhoneSettings state={state} />
            ))}
          {section === "phone" && <OtherComputers state={state} />}
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
          {section === "account" && <ProviderSettings general={() => setSection("general")} />}
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
    catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
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
            {status === "available" && !update?.canInstall && <button className="secondary" onClick={() => void api.openAppRelease()}>Open release</button>}
          </div>}
        </Row>
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
