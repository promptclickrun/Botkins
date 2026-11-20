import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { MacTool, MacToolLevel, MacToolsStatus, State } from "./types";
import { Group, errorText } from "./SettingsRows";
import { Choices } from "./Preferences";

const api = window.botkins;

const LEVELS: { id: MacToolLevel; name: string }[] = [
  { id: "off", name: "Off" },
  { id: "read", name: "Read" },
  { id: "interact", name: "Read and interact" },
];

const TOOLS: { id: MacTool; name: string; what: string; sends: string }[] = [
  { id: "imessage", name: "iMessage", what: "your messages", sends: "send messages" },
  { id: "mail", name: "Mail", what: "your email", sends: "send email" },
];

/** One line under a tool that is on. What a bot reads goes to the model, so it is said here. */
function help(tool: (typeof TOOLS)[number], level: MacToolLevel) {
  if (level === "off") return "Bots can't use " + tool.what + ".";
  const action = level === "interact" ? "Bots can read " + tool.what + " and " + tool.sends + ", under your approval level." : "Bots can read " + tool.what + ".";
  return action + " What they read goes to the model the chat uses.";
}

/** One permission macOS gives: allowed, or a Grant button that asks for it. Drawn like the rows of Settings › Phone. */
function Permission({ name, help, granted, busy, grant }: { name: string; help: string; granted: boolean; busy: boolean; grant: () => void }) {
  return (
    <div className="set-row int-item compact phone-permission">
      <div className="set-label">
        <span className="set-name">{name}</span>
        <small>{help}</small>
      </div>
      <div className="set-control">
        {granted ? (
          <span className="phone-allowed" role="status" aria-label={name + " is allowed"}>
            <Check size={14} aria-hidden="true" />
            Allowed
          </span>
        ) : (
          <button type="button" className="set-button" aria-label={"Grant " + name} disabled={busy} onClick={grant}>
            Grant
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Settings › MCP servers › On this Mac: iMessage and Mail as tools bots can use, each Off, Read, or
 * Read and interact. Only on a Mac, and only this window can change it. While a permission macOS
 * asks for is missing, the page looks again every few seconds, since it is switched on in System Settings.
 */
export default function MacTools({ state }: { state: State }) {
  const available = state.macTools?.available === true;
  const levels = state.settings.macTools ?? { imessage: "off", mail: "off" };
  const [status, setStatus] = useState<MacToolsStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = () =>
    api
      .macToolsStatus()
      .then((next) => {
        setStatus(next);
        setError("");
      })
      .catch((e) => setError(errorText(e)));
  // The switches decide which permissions count, so look again when one changes.
  useEffect(() => {
    if (available) void load();
  }, [available, levels.imessage, levels.mail]);
  const waiting = Object.values(status?.permissions ?? {}).some((granted) => granted === false);
  useEffect(() => {
    if (!available || !waiting) return;
    const timer = setInterval(() => void load(), 2500);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [available, waiting]);
  if (!available) return null;
  async function run(fn: () => Promise<MacToolsStatus>) {
    setError("");
    setBusy(true);
    try {
      setStatus(await fn());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy. Select the command and copy it.");
    }
  }
  const perms = status?.permissions ?? {};
  return (
    <Group title="On this Mac">
      {TOOLS.map((tool) => (
        <div className="set-row" key={tool.id}>
          <div className="set-label">
            <span className="set-name">{tool.name}</span>
            <small>{help(tool, levels[tool.id])}</small>
          </div>
          <div className="set-control">
            <Choices label={tool.name} value={levels[tool.id]} options={LEVELS} onChange={(level) => void run(() => api.setMacTool(tool.id, level))} />
          </div>
        </div>
      ))}
      {levels.imessage !== "off" && status && !status.imsg.found && (
        <div className="set-row stacked" role="status">
          <div className="set-label">
            <span className="set-name">iMessage needs imsg</span>
            <small>It isn't installed on this computer. Install it in Terminal, then come back to this page.</small>
          </div>
          <div className="set-control">
            <code className="int-mono">{status.imsg.install.command}</code>
            <button type="button" className="set-button" aria-label="Copy the install command" onClick={() => void copy(status.imsg.install.command)}>
              <Copy size={14} aria-hidden="true" />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
      {perms.fullDisk !== undefined && (
        <Permission
          name="Full Disk Access"
          help={perms.fullDisk ? "Bots can read your messages." : "Lets bots read your messages. Switch Botkins on in System Settings; macOS may then ask to reopen Botkins."}
          granted={perms.fullDisk}
          busy={busy}
          grant={() => void run(() => api.grantMacTool("fullDisk"))}
        />
      )}
      {perms.messagesAutomation !== undefined && (
        <Permission
          name="Messages automation"
          help={perms.messagesAutomation ? "Bots can send messages." : "Lets bots send messages. Allow Botkins to control Messages in System Settings."}
          granted={perms.messagesAutomation}
          busy={busy}
          grant={() => void run(() => api.grantMacTool("messagesAutomation"))}
        />
      )}
      {perms.mailAutomation !== undefined && (
        <Permission
          name="Mail automation"
          help={perms.mailAutomation ? "Bots can use Mail." : "Lets bots read and send email. Allow Botkins to control Mail in System Settings."}
          granted={perms.mailAutomation}
          busy={busy}
          grant={() => void run(() => api.grantMacTool("mailAutomation"))}
        />
      )}
      {error && (
        <p className="set-status error-text" role="alert">
          {error}
        </p>
      )}
    </Group>
  );
}
