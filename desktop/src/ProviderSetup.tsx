import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import type { ProviderStatus } from "./types";
import { plainError, reloadProviders, toolName } from "./providers";

const api = window.botkins;
type InstallAttempt = { session?: string; cancelling?: boolean };

export function ProviderInstall({ provider, available, windows }: { provider: ProviderStatus; available: boolean; windows: boolean }) {
  const [copied, setCopied] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState<string>();
  const attempt = useRef<InstallAttempt | null>(null);
  const log = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [lines]);
  function stop() {
    const session = attempt.current?.session;
    attempt.current = null;
    if (session) void api.providerSignInCancel(session).catch(() => {});
  }
  useEffect(() => stop, []);
  async function cancel() {
    const task = attempt.current;
    if (!task || task.cancelling) return;
    task.cancelling = true;
    if (task.session) {
      try {
        await api.providerSignInCancel(task.session);
      } catch {
        if (attempt.current === task) {
          task.cancelling = false;
          setError("The installer couldn't be cancelled. Try again.");
        }
      }
    }
  }
  async function install() {
    if (attempt.current) return;
    const task: InstallAttempt = {};
    follow.current = true;
    attempt.current = task;
    setRunning(true);
    setLines([]);
    setError("");
    setResult("");
    setPrompt(undefined);
    try {
      const { session } = await api.installProvider(provider.id);
      if (attempt.current !== task) {
        await api.providerSignInCancel(session);
        return;
      }
      task.session = session;
      if (task.cancelling) await api.providerSignInCancel(session);
      let after = 0;
      while (attempt.current === task) {
        const view = await api.providerSignInRead(session, after);
        if (attempt.current !== task) return;
        after = view.next;
        const output = view.events.filter(event => event.type === "output").map(event => event.text);
        if (output.length) setLines(previous => [...previous, ...output].slice(-40));
        for (const event of view.events) {
          if (event.type === "prompt" && view.wantsInput) setPrompt(event.text || "Reply to the installer");
        }
        if (!view.done) continue;
        if (task.cancelling && view.error === "Install cancelled.") {
          setResult(view.error);
          break;
        }
        if (view.error || !view.result?.installed) throw Error(view.error || "The tool was not found after installation.");
        const version = view.result.version;
        setResult(provider.name + " is installed" + (version ? " (" + version + ")" : "") + ".");
        await reloadProviders(true);
        break;
      }
    } catch (e) {
      if (attempt.current === task) {
        const message = plainError(e);
        setError(message.startsWith("The install didn't finish.") ? message : "The install didn't finish. " + message);
        if (task.session) void api.providerSignInCancel(task.session).catch(() => {});
      }
    } finally {
      if (attempt.current === task) {
        attempt.current = null;
        setRunning(false);
        setPrompt(undefined);
      }
    }
  }

  const missing = !provider.installed && !provider.starting;
  if (!missing && !result && !running && !error) return null;
  const command = provider.install?.command;
  return (
    <div className="set-row stacked">
      {missing && <small>{provider.message || toolName(provider) + " isn't on this computer."}</small>}
      {missing && command && (
        <div className="provider-command">
          <code aria-label="Install command">{command}</code>
          <button type="button" className="set-button" onClick={() => void api.copyText(command).then(() => setCopied(true)).catch(() => {})}>
            <Copy size={13} aria-hidden="true" /> {copied ? "Copied" : "Copy"}
          </button>
          {available && (
            <button type="button" className="set-button primary" disabled={running || windows} onClick={() => void install()}>
              {running ? "Installing…" : "Install on your computer"}
            </button>
          )}
        </div>
      )}
      {missing && command && windows && <small>Run the command in a terminal, then choose Check again.</small>}
      {lines.length > 0 && (
        <pre ref={log} className="provider-install-output" aria-label="Install output" tabIndex={0} onScroll={({ currentTarget }) => {
          follow.current = currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight < 8;
        }}>{lines.join("\n")}</pre>
      )}
      {running && (
        <button type="button" className="set-button" onClick={() => void cancel()}>Cancel install</button>
      )}
      {running && prompt && <form onSubmit={event => {
        event.preventDefault();
        const input = event.currentTarget.elements.namedItem("answer") as HTMLInputElement;
        const session = attempt.current?.session;
        if (session && input.value) {
          void api.providerSignInInput(session, input.value).then(() => {
            if (attempt.current?.session === session) setPrompt(undefined);
          }).catch(() => setError("The installer couldn't receive your reply."));
          input.value = "";
        }
      }}>
        <label>{prompt} <input type="text" autoComplete="off" name="answer" required /></label>
        <button className="set-button" type="submit">Send</button>
      </form>}
      {result && <small role="status">{result}</small>}
      {error && <small role="alert" className="error-text">{error}</small>}
    </div>
  );
}

export function ProviderToken({ provider }: { provider: ProviderStatus }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  if (!open) return <div className="set-row"><button type="button" className="set-link" onClick={() => setOpen(true)}>Use a token instead</button></div>;
  return (
    <form className="set-row" onSubmit={async event => {
      event.preventDefault();
      const input = event.currentTarget.elements.namedItem("token") as HTMLInputElement;
      const token = input.value.trim();
      if (!token || sending) return;
      input.value = "";
      setSending(true);
      setError("");
      try {
        await api.providerUseToken(provider.id, token);
        setOpen(false);
        await reloadProviders(true);
      } catch {
        setError("Sign-in didn't finish. Check the token and try again.");
      } finally {
        setSending(false);
      }
    }}>
      <label>Token <input name="token" type="password" autoFocus required autoComplete="off" spellCheck={false} disabled={sending} /></label>
      <button type="submit" className="set-button primary" disabled={sending}>Sign in with token</button>
      <button type="button" className="set-button" disabled={sending} onClick={() => { setOpen(false); setError(""); }}>Cancel</button>
      {error && <small role="alert" className="error-text">{error}</small>}
    </form>
  );
}
