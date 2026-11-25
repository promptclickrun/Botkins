import { saveChatDisplay } from "./chatDisplay";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { Button, Slider } from "glisse";
import type { Preferences as Values, Appearance, HarnessStatus } from "./types";
import { BackdropPreview } from "./Backdrop";
import { GlassSegmented } from "./GlisseUI";
import { ProviderInstall } from "./ProviderSetup";
import { Group, Row, SwitchRow, ValueRow } from "./SettingsRows";
import { modeOf, previewContrast } from "./appearance";
import { BACKDROPS, backdropOf, type Mode, TEXT_SIZES, THEMES, type ThemeColors, fontShown, fontsHere, themeFor, themeOf } from "./themes";

type Patch = Parameters<typeof window.botkins.setPreferences>[0];
type Props = {
  settings: Values;
  change: (patch: Patch) => Promise<void>;
  fail: (e: unknown) => void;
};

const HARNESSES: { id: NonNullable<Values["harness"]>; name: string }[] = [
  { id: "pi", name: "Pi" },
  { id: "provider", name: "Provider default" },
  { id: "copilot", name: "Copilot SDK" },
  { id: "omp", name: "OMP" },
];
const HARNESS_HELP: Record<NonNullable<Values["harness"]>, string> = {
  copilot: "One harness runs every chat. GitHub Copilot, ChatGPT, Claude and OpenCode models each answer on their own plan, with the same tools, skills and connections.",
  provider: "Each model's own tool runs its chats: Codex for ChatGPT, Claude Code for Claude, the Copilot SDK for GitHub Copilot, and OpenCode for its models.",
  pi: "Pi runs every chat: GitHub Copilot, ChatGPT, Claude and OpenCode models each answer on their own plan. Copilot's Auto model stays on the Copilot SDK.",
  omp: "OMP runs every chat with Pi-compatible tools and its own improvements: GitHub Copilot, ChatGPT, Claude and OpenCode models each answer on their own plan. Copilot's Auto model stays on the Copilot SDK.",
};

/** Settings › General › Harness: one harness for every plan (the Copilot SDK), or each provider's own. */
export function HarnessSettings({ settings, change, fail, setup = true, windows = false }: Props & { setup?: boolean; windows?: boolean }) {
  const harness = settings.harness ?? "pi";
  const [programs, setPrograms] = useState<HarnessStatus[]>([]);
  const load = () =>
    (window.botkins.harnesses?.() ?? Promise.resolve([]))
      .then((list) => setPrograms(list))
      .catch(() => setPrograms([]));
  useEffect(() => void load(), []);
  // An older computer only offers program harnesses it reports, plus the one already selected.
  const knownPrograms = new Set(programs.map((item) => item.id));
  const options = HARNESSES.filter((option) => option.id === "copilot" || option.id === "provider" || knownPrograms.has(option.id) || harness === option.id);
  return (
    <Group title="Harness" footer="A chat keeps its conversation when you switch; its next reply starts on the other harness. Agents you add over ACP always run themselves.">
      <div className="set-row">
        <div className="set-label">
          <span className="set-name">What runs your bots</span>
          <small>{HARNESS_HELP[harness]}</small>
        </div>
        <div className="set-control">
          <Choices label="Harness" value={harness} options={options} onChange={(id) => void change({ harness: id }).catch(fail)} />
        </div>
      </div>
      <SwitchRow
        label="Keep prompt cache longer"
        help="With Pi or OMP, keeps a chat's prompt cache for about an hour instead of five minutes where the provider supports it (GitHub Copilot's models do), so a chat you come back to after a break still starts from cache. A plan isn't billed by the token, so this costs nothing extra."
        checked={settings.longPromptCache ?? true}
        onChange={(on) => void change({ longPromptCache: on }).catch(fail)}
      />
      {programs.filter((program) => program.installed).map((program) => (
        <ValueRow key={program.id} label={program.name} value={program.version ? "Version " + program.version : "Installed"} />
      ))}
      {/* Kept mounted after an install, so each result stays; it shows nothing while installed and idle. */}
      {programs.map((program) => (
        <ProviderInstall
          key={program.id}
          provider={{ ...program, message: program.message || program.name + " isn't on this computer. Install it to use it as the harness." }}
          available={setup}
          windows={windows}
          onInstalled={load}
        />
      ))}
    </Group>
  );
}

/** Settings › General › Background: keep running when the window is closed, and start with the computer. */
export function BackgroundSettings({ settings, change, fail }: Props) {
  const background = settings.background ?? { keepRunning: true, runAtStartup: false };
  const mac = /Mac/.test(navigator.platform);
  const set = (patch: Partial<typeof background>) => void change({ background: { ...background, ...patch } }).catch(fail);
  return (
    <Group title="Background">
      <SwitchRow
        label="Keep running when the window is closed"
        help={"Botkins stays in the " + (mac ? "menu bar" : "taskbar") + ", so your phone and your routines keep working. Quit it from its icon there."}
        checked={background.keepRunning}
        onChange={(on) => set({ keepRunning: on })}
      />
      <SwitchRow label="Run at startup" help="Botkins starts quietly, without a window, when you sign in to this computer." checked={background.runAtStartup} onChange={(on) => set({ runAtStartup: on })} />
    </Group>
  );
}

/** Arrow keys move through a row of radio buttons and choose as they go, as a radio group does. */
function rove(e: KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=radio]")];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (at < 0 || !step) return;
  e.preventDefault();
  const next = items[(at + step + items.length) % items.length];
  next.focus();
  next.click();
}

/** A few choices side by side, one of them on. */
export function Choices<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; name: string }[]; onChange: (id: T) => void }) {
  return (
    <GlassSegmented
      aria-label={label}
      value={value}
      items={options.map((option) => ({ value: option.id, label: option.name }))}
      onValueChange={(next) => onChange(next as T)}
    />
  );
}

const MODES: { id: Appearance["theme"]; name: string }[] = [
  { id: "system", name: "System" },
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
];
const HALVES: { id: Mode; name: string }[] = [
  { id: "light", name: "Light mode" },
  { id: "dark", name: "Dark mode" },
];

/** A theme in miniature, as the app draws it: the side menu, a reply, your bubble, the message box and its send button. */
function ThemePane({ colors, half }: { colors: ThemeColors; half: "light" | "dark" }) {
  return (
    <span className={"theme-pane " + half} style={{ background: colors.canvas }}>
      <i className="tp-menu" style={{ background: colors.sunken, borderColor: colors.line }} />
      <i className="tp-mark" style={{ background: colors.primary }} />
      <i className="tp-row on" style={{ background: colors.raised, borderColor: colors.line }} />
      <i className="tp-row" style={{ background: colors.ink }} />
      <i className="tp-bubble" style={{ background: colors.bubble }} />
      <i className="tp-avatar" style={{ background: colors.accentSoft }} />
      <i className="tp-text" style={{ background: colors.ink }} />
      <i className="tp-text short" style={{ background: colors.muted }} />
      <i className="tp-box" style={{ background: colors.surface, borderColor: colors.line }} />
      <i className="tp-send" style={{ background: colors.primary }} />
    </span>
  );
}

/** Settings › Appearance: the theme for light and dark, contrast, font, text size, chat bubbles and what a conversation shows. */
export function AppearanceSettings({ settings, change, fail }: Props) {
  const a = settings.appearance;
  const update = (p: Partial<Appearance>) => change({ appearance: p }).catch(fail);
  const toggle = (p: Patch) => void change(p).catch(fail);
  const mode = modeOf(a.theme);
  const darkTheme = a.darkColorTheme ?? null;
  const separate = darkTheme !== null;
  // With a theme of its own for dark mode, the cards pick for one mode at a time: the one showing, to start.
  const [target, setTarget] = useState<Mode>(mode);
  const picking: Mode = separate ? target : mode;
  const pickedFor = (m: Mode) => (m === "dark" && darkTheme) || a.colorTheme;
  const [hex, setHex] = useState(a.bubble === "theme" ? themeFor(a, mode)[mode].bubble : a.bubble);
  const [contrast, setContrast] = useState(a.contrast ?? 0);
  // The slider draws as it moves and saves once it rests. While a save waits, an older saved value
  // coming back never moves the slider under the person's hand.
  const pending = useRef<{ timer: number; value: number } | null>(null);
  const saveContrast = (value: number) => {
    pending.current = null;
    void change({ appearance: { contrast: value } }).catch((e) => {
      setContrast(a.contrast ?? 0);
      previewContrast(a.contrast ?? 0);
      fail(e);
    });
  };
  const moveContrast = (value: number) => {
    setContrast(value);
    previewContrast(value);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { value, timer: window.setTimeout(() => saveContrast(value), 400) };
  };
  useEffect(() => {
    if (a.bubble !== "theme") setHex(a.bubble);
  }, [a.bubble]);
  useEffect(() => {
    if (!pending.current) setContrast(a.contrast ?? 0);
  }, [a.contrast]);
  // Leaving the page saves a move that hasn't rested yet.
  useEffect(
    () => () => {
      if (!pending.current) return;
      clearTimeout(pending.current.timer);
      void change({ appearance: { contrast: pending.current.value } }).catch(fail);
    },
    [],
  );
  const pick = (id: string) => void update(separate && picking === "dark" ? { darkColorTheme: id } : { colorTheme: id });
  return (
    <>
      <Group title="Theme">
        <div className="set-row">
          <div className="set-label">
            <span>Light or dark</span>
          </div>
          <div className="set-control">
            <Choices label="Light or dark" value={a.theme} options={MODES} onChange={(theme) => void update({ theme })} />
          </div>
        </div>
        {separate && (
          <div className="set-row">
            <div className="set-label">
              <span>Choose the theme for</span>
            </div>
            <div className="set-control">
              <Choices label="Choose the theme for" value={target} options={HALVES} onChange={setTarget} />
            </div>
          </div>
        )}
        <div className="theme-cards" role="radiogroup" aria-label={separate ? "Theme for " + picking + " mode" : "Theme"} onKeyDown={rove}>
          {THEMES.map((theme) => {
            const on = theme.id === pickedFor(picking);
            const light = theme.id === pickedFor("light");
            const dark = theme.id === pickedFor("dark");
            return (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={theme.name}
                tabIndex={on ? 0 : -1}
                className={"theme-card" + (on ? " on" : "")}
                onClick={() => pick(theme.id)}
              >
                {/* The theme's light half and dark half, split on a slant. */}
                <span className="theme-wire" aria-hidden="true">
                  <ThemePane colors={theme.light} half="light" />
                  <ThemePane colors={theme.dark} half="dark" />
                </span>
                <span className="theme-name">
                  {on && <Check size={13} strokeWidth={2.5} aria-hidden="true" />}
                  {theme.name}
                  {separate && (light || dark) && (
                    <span className="theme-uses">
                      {light && <em>Light</em>}
                      {dark && <em>Dark</em>}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <SwitchRow
          label="Use a different theme in dark mode"
          help={separate ? "Light: " + themeOf(a.colorTheme).name + " · Dark: " + themeOf(darkTheme).name : undefined}
          checked={separate}
          onChange={(on) => {
            setTarget(on ? "dark" : mode);
            void update({ darkColorTheme: on ? a.colorTheme : null });
          }}
        />
        <Row label="Contrast" help="Stronger lines and clearer quiet text across the app.">
          {(id, describedBy) => (
            <Slider
              id={id}
              aria-describedby={describedBy}
              min={0}
              max={100}
              step={5}
              value={contrast}
              onValueChange={moveContrast}
            />
          )}
        </Row>
        <Row label="Font">
          {(id) => (
            // A face this computer lacks isn't listed, and a saved one shows as the system's face, which is what is drawn.
            <select id={id} value={fontShown(a.font)} onChange={(e) => void update({ font: e.target.value })}>
              {fontsHere().map((font) => (
                <option key={font.id} value={font.id}>
                  {font.name}
                </option>
              ))}
            </select>
          )}
        </Row>
        <div className="set-row">
          <div className="set-label">
            <span>Text size</span>
          </div>
          <div className="set-control">
            <Choices label="Text size" value={a.textSize} options={TEXT_SIZES} onChange={(textSize) => void update({ textSize })} />
          </div>
        </div>
      </Group>
      <Group title="Backdrop" footer="Clean keeps your solid theme surface. Other backdrops shine gently through the glass controls.">
        <div className="backdrop-cards" role="radiogroup" aria-label="Backdrop" onKeyDown={rove}>
          {BACKDROPS.map((item) => {
            const on = backdropOf(a.backdrop) === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={item.name}
                tabIndex={on ? 0 : -1}
                className={"backdrop-card" + (on ? " on" : "")}
                onClick={() => void update({ backdrop: item.id })}
              >
                <BackdropPreview id={item.id} />
                <span className="backdrop-name">
                  {on && <Check size={13} strokeWidth={2.5} aria-hidden="true" />}
                  {item.name}
                </span>
                <span className="backdrop-desc">{item.description}</span>
              </button>
            );
          })}
        </div>
      </Group>
      <Group title="Your messages">
        <SwitchRow
          label="Use the theme's color"
          checked={a.bubble === "theme"}
          onChange={(on) => void update({ bubble: on ? "theme" : hex })}
        />
        {a.bubble !== "theme" && (
          <Row label="Bubble color">
            {(id) => (
              <input
                id={id}
                type="color"
                className="set-color"
                value={hex}
                onChange={(e) => {
                  setHex(e.target.value);
                  void update({ bubble: e.target.value });
                }}
              />
            )}
          </Row>
        )}
        <div className="set-row set-preview" aria-hidden="true">
          <span className="set-name">Preview</span>
          <div className="bubble-preview">
            <article className="user">Message preview</article>
          </div>
        </div>
      </Group>
      <Group title="Avatars">
        <SwitchRow
          label="Avatar animations"
          checked={a.avatarAnimations !== false}
          onChange={(on) => void update({ avatarAnimations: on })}
        />
      </Group>
      {/* Steps, Thinking and Updates are in Settings › Chat (ChatDisplaySettings). */}
      <Group title="Conversations">
        <SwitchRow
          label="Show link previews"
          help="Fetches the first link in a reply, never a private or local one."
          checked={!!settings.linkPreviews}
          onChange={(on) => toggle({ linkPreviews: on })}
        />
        <SwitchRow
          label="Read replies aloud"
          help="Speaks each new reply in the open chat."
          checked={!!settings.readAloud}
          onChange={(on) => toggle({ readAloud: on })}
        />
      </Group>
    </>
  );
}

const scenarios: Record<string, string> = {
  missing: "Details are missing or ambiguous",
  choices: "A tradeoff depends on my preference",
  changes: "A change is difficult to reverse",
};
const approvalHelp: Record<Values["approval"], string> = {
  ask: "You review each request in the chat.",
  read: "Approves file reads and read-only MCP tools. Asks for the rest.",
  assisted: "Your model provider asks you only when it needs a decision.",
  all: "Approves every request, commands and file changes too. Managed policies still apply.",
};

export function ChatDisplaySettings({ settings, change, chatMode, fail }: Pick<Props, "settings" | "change" | "fail"> & { chatMode?: "main" | "new" }) {
  // With Steps or Thinking Open, a finished turn always folds into the island's receipt.
  const island = settings.steps === "open" || settings.thinking === "open";
  return (
    <Group title="Chat">
      <Row label="Steps" help={({folded:"Folded: steps stay in the working line under the turn", open:"Open: a live window of the newest steps", failed:"Failed only: only failed steps show in the chat"})[settings.steps ?? "open"]}>
        {(id, desc) => <select id={id} aria-describedby={desc} value={settings.steps ?? "open"} onChange={e => saveChatDisplay({steps:e.target.value as Values["steps"], stepsPicked:true, foldFinishedSteps: settings.foldFinishedSteps ?? true})}>
          <option value="folded">Folded</option><option value="open">Open</option><option value="failed">Failed only</option>
        </select>}
      </Row>
      {!island && <SwitchRow label="Fold finished steps" help="Collapse finished work into one expandable line with its time and step count." checked={settings.foldFinishedSteps ?? true} onChange={(on) => saveChatDisplay({ foldFinishedSteps: on })} />}
      <Row label="Thinking" help={({ folded: "Folded: thinking stays in the working line under the turn", open: "Open: the latest lines of thought, in the same window", hidden: "Hidden: no thinking in the chat or the working line" })[settings.thinking ?? "open"]}>
        {(id, desc) => <select id={id} aria-describedby={desc} value={settings.thinking ?? "open"} onChange={e => saveChatDisplay({thinking:e.target.value as Values["thinking"], thinkingPicked:true})}>
          <option value="folded">Folded</option><option value="open">Open</option><option value="hidden">Hidden</option>
        </select>}
      </Row>
      <SwitchRow
        label="Updates"
        help="Interim messages land in the chat, whatever Thinking is set to."
        checked={settings.showUpdates !== false}
        onChange={(on) => void change({ showUpdates: on }).catch(fail)}
      />
      <Row label="Position after response completes">
        {(id) => <select className="completion-position" id={id} value={settings.completionPosition ?? "latest"} onChange={e => saveChatDisplay({ completionPosition: e.target.value === "beginning" ? "beginning" : "latest" })}>
          <option value="latest">Keep at latest content</option>
          <option value="beginning">Show beginning of completed response</option>
        </select>}
      </Row>
      <Row label="When you select a bot">
        {(id) => <select className="bot-tap" id={id} value={settings.botTap === "main" && !chatMode ? "latest" : settings.botTap ?? (chatMode ? "main" : "latest")} onChange={e => saveChatDisplay({ botTap: e.target.value as Values["botTap"] })}>
          {chatMode && <option value="main">Open Main chat</option>}
          <option value="latest">Open the latest chat</option>
          <option value="new">Start a new chat</option>
        </select>}
      </Row>
      {chatMode && <Row label="Proactive signals" help="Where your bots send alerts delivered to chat.">
        {id => <select id={id} value={chatMode} onChange={e => void window.botkins.setProactiveChatMode(e.target.value === "new" ? "new" : "main").catch(fail)}>
          <option value="main">Main chat</option>
          <option value="new">New chat every time</option>
        </select>}
      </Row>}
    </Group>
  );
}

/** Off, or every 5 to 30 turns (desktop/summaries.mjs). */
const SUMMARY_TURNS = [0, ...Array.from({ length: 26 }, (_, i) => i + 5)];

/** Settings › Chat › Chat titles: whether a chat is named from its first message, and how often it is renamed after. Hidden for an older computer. */
export function SummarySettings({ settings, change, fail }: Props) {
  if (settings.autoSummarize === undefined) return null;
  return (
    <Group title="Chat titles" footer="Botkins names a new chat from your first message, then renames it from what it's about every few turns. It uses the Default routines model. A chat you rename keeps your title.">
      <Row label="Auto-summarize">
        {(id) => (
          <select id={id} value={settings.autoSummarize} onChange={(e) => void change({ autoSummarize: Number(e.target.value) }).catch(fail)}>
            {SUMMARY_TURNS.map((turns) => (
              <option key={turns} value={turns}>
                {turns ? "Every " + turns + " turns" : "Off"}
              </option>
            ))}
          </select>
        )}
      </Row>
    </Group>
  );
}

/** Settings › Chats & approvals: the global tool approval level and when bots ask clarifying questions. */
export function BehaviorSettings({ settings, change, fail }: Props) {
  const [instructions, setInstructions] = useState(settings.clarificationInstructions),
    [message, setMessage] = useState("");
  const update = (p: Patch) => change(p).catch(fail);
  return (
    <>
      <Group title="Tool approvals">
        <Row label="Approval level" help={approvalHelp[settings.approval]}>
          {(id, d) => (
            <select
              id={id}
              aria-describedby={d}
              value={settings.approval}
              onChange={(e) => void update({ approval: e.target.value as Values["approval"] })}
            >
              <option value="ask">Ask for each request</option>
              <option value="read">Auto-approve read-only tools</option>
              <option value="assisted">Assisted approvals</option>
              <option value="all">Approve all tools (YOLO)</option>
            </select>
          )}
        </Row>
        <ValueRow
          label="Remembered approvals"
          help="Saved tool approvals and cross-host Teamwork permissions."
          value={
            <Button
              variant="glass"
              className="lg-compact"
              onClick={() =>
                window.botkins
                  .clearApprovals()
                  .then(() => setMessage("Remembered approvals cleared."))
                  .catch(fail)
              }
            >
              Clear remembered approvals
            </Button>
          }
        />
      </Group>
      <Group title="Ask me a question when">
        {Object.entries(scenarios).map(([key, title]) => (
          <SwitchRow
            key={key}
            label={title}
            checked={settings.clarify.includes(key)}
            onChange={(on) =>
              void update({
                clarify: on ? [...settings.clarify, key] : settings.clarify.filter((k) => k !== key),
              })
            }
          />
        ))}
      </Group>
      <form
        className="set-group"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await change({ clarificationInstructions: instructions });
            setMessage("Question instructions saved.");
          } catch (error) {
            fail(error);
          }
        }}
      >
        <div className="set-card">
          <Row label="Custom question instructions" help="Added for every bot. Each bot can add its own." stacked>
            {(id, d) => (
              <textarea
                id={id}
                aria-describedby={d}
                rows={2}
                maxLength={4000}
                value={instructions}
                placeholder="Ask about the audience before drafting a report."
                onChange={(e) => {
                  setInstructions(e.target.value);
                  setMessage("");
                }}
              />
            )}
          </Row>
          <div className="set-actions">
            <Button type="submit" variant="filled" className="lg-compact">Save instructions</Button>
          </div>
        </div>
      </form>
      {message && (
        <p className="set-status" role="status">
          {message}
        </p>
      )}
    </>
  );
}
