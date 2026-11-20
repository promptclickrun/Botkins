import { saveChatDisplay } from "./chatDisplay";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import type { Preferences as Values, Appearance } from "./types";
import { Group, Row, SwitchRow, ValueRow } from "./SettingsRows";
import { modeOf } from "./appearance";
import { TEXT_SIZES, THEMES, fontShown, fontsHere, themeOf } from "./themes";

type Patch = Parameters<typeof window.botkins.setPreferences>[0];
type Props = {
  settings: Values;
  change: (patch: Patch) => Promise<void>;
  fail: (e: unknown) => void;
};

const HARNESSES: { id: NonNullable<Values["harness"]>; name: string }[] = [
  { id: "copilot", name: "Copilot SDK" },
  { id: "provider", name: "Provider default" },
];
const HARNESS_HELP: Record<NonNullable<Values["harness"]>, string> = {
  copilot: "One harness runs every chat. GitHub Copilot, ChatGPT and Claude models each answer on their own plan, with the same tools, skills and connections.",
  provider: "Each model's own tool runs its chats: Codex for ChatGPT, Claude Code for Claude, and the Copilot SDK for GitHub Copilot.",
};

/** Settings › General › Harness: one harness for every plan (the Copilot SDK), or each provider's own. */
export function HarnessSettings({ settings, change, fail }: Props) {
  const harness = settings.harness ?? "copilot";
  return (
    <Group title="Harness" footer="A chat keeps its conversation when you switch; its next reply starts on the other harness. OpenCode and other agents always run themselves.">
      <div className="set-row">
        <div className="set-label">
          <span className="set-name">What runs your bots</span>
          <small>{HARNESS_HELP[harness]}</small>
        </div>
        <div className="set-control">
          <Choices label="Harness" value={harness} options={HARNESSES} onChange={(id) => void change({ harness: id }).catch(fail)} />
        </div>
      </div>
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
    <div className="segmented set-choices" role="radiogroup" aria-label={label} onKeyDown={rove}>
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={option.id === value} tabIndex={option.id === value ? 0 : -1} onClick={() => onChange(option.id)}>
          {option.name}
        </button>
      ))}
    </div>
  );
}

const MODES: { id: Appearance["theme"]; name: string }[] = [
  { id: "system", name: "System" },
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
];

/** Settings › Appearance: the theme, light or dark, the text size, chat bubbles and what a conversation shows. */
export function AppearanceSettings({ settings, change, fail }: Props) {
  const a = settings.appearance;
  const update = (p: Partial<Appearance>) => change({ appearance: p }).catch(fail);
  const toggle = (p: Patch) => void change(p).catch(fail);
  const mode = modeOf(a.theme);
  const [hex, setHex] = useState(a.bubble === "theme" ? themeOf(a.colorTheme)[mode].bubble : a.bubble);
  useEffect(() => {
    if (a.bubble !== "theme") setHex(a.bubble);
  }, [a.bubble]);
  return (
    <>
      <Group title="Theme">
        <div className="theme-cards" role="radiogroup" aria-label="Theme" onKeyDown={rove}>
          {THEMES.map((theme) => {
            const colors = theme[mode];
            const on = theme.id === a.colorTheme;
            return (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={theme.name}
                tabIndex={on ? 0 : -1}
                className={"theme-card" + (on ? " on" : "")}
                onClick={() => void update({ colorTheme: theme.id })}
              >
                {/* A small picture of the theme: its side menu and page, a line of ink, your bubble and its action color. */}
                <span className="theme-swatch" style={{ background: colors.canvas }} aria-hidden="true">
                  <i style={{ background: colors.sunken }} />
                  <i style={{ background: colors.ink }} />
                  <i style={{ background: colors.bubble }} />
                  <i style={{ background: colors.accent }} />
                </span>
                <span className="theme-name">
                  {on && <Check size={13} strokeWidth={2.5} aria-hidden="true" />}
                  {theme.name}
                </span>
              </button>
            );
          })}
        </div>
        <div className="set-row">
          <div className="set-label">
            <span>Light or dark</span>
          </div>
          <div className="set-control">
            <Choices label="Light or dark" value={a.theme} options={MODES} onChange={(theme) => void update({ theme })} />
          </div>
        </div>
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

export function ChatDisplaySettings({ settings }: Pick<Props, "settings">) {
  return (
    <Group title="Chat">
      <Row label="Steps" help={({folded:"Every step while it works; one line when it's done", every:"Each step, thought and update in order", failed:"Only steps that failed", hidden:"Hide steps"})[settings.steps ?? "folded"]}>
        {(id, desc) => <select id={id} aria-describedby={desc} value={settings.steps ?? "folded"} onChange={e => saveChatDisplay({steps:e.target.value as Values["steps"], stepsPicked:true})}>
          <option value="folded">Folded</option><option value="every">Every step</option><option value="failed">Failed only</option><option value="hidden">Hidden</option>
        </select>}
      </Row>
      <Row label="Position after response completes">
        {(id) => <select className="completion-position" id={id} value={settings.completionPosition ?? "latest"} onChange={e => saveChatDisplay({ completionPosition: e.target.value === "beginning" ? "beginning" : "latest" })}>
          <option value="latest">Keep at latest content</option>
          <option value="beginning">Show beginning of completed response</option>
        </select>}
      </Row>
      <Row label="Thinking and updates" help="Its reasoning and notes while it works">
        {(id, desc) => <select id={id} aria-describedby={desc} value={settings.thinking ?? "folded"} onChange={e => saveChatDisplay({thinking:e.target.value as Values["thinking"]})}>
          <option value="open">Open</option><option value="folded">Folded</option><option value="hidden">Hidden</option>
        </select>}
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
          help="Requests you allowed for the rest of a chat."
          value={
            <button
              type="button"
              className="set-button"
              onClick={() =>
                window.botkins
                  .clearApprovals()
                  .then(() => setMessage("Remembered chat approvals cleared."))
                  .catch(fail)
              }
            >
              Clear remembered approvals
            </button>
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
            <button className="set-button primary">Save instructions</button>
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
