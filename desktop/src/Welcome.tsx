import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { ProviderStatus } from "./types";
import ProviderIcon from "./ProviderIcon";
import { SETUP_PROVIDERS, currentProviders, describe, isConnected, plainError, reloadProviders, signInLabel, toolName, useProviders } from "./providers";
import "./settings.css";
import "./models.css";

const api = window.botkins;
export const COPILOT_PLANS = "https://github.com/features/copilot/plans";

/** The GitHub mark, for Sign in with GitHub buttons (GitHub Copilot's mark). */
export function GitHubMark({ size = 16 }: { size?: number }) {
  return <ProviderIcon provider="copilot" name="GitHub" size={size} />;
}

/**
 * The first-run screens' frame: the Botkins illustration fills one side to the window's edge
 * (a band at the top in a narrow window), and the screen's words sit on the canvas beside it.
 */
export function WelcomeFrame({ label, className = "", busy, children }: { label?: string; className?: string; busy?: boolean; children: ReactNode }) {
  return (
    <main className={"welcome " + className} aria-labelledby={label} aria-busy={busy || undefined}>
      <div className="welcome-art" aria-hidden="true">
        <img src="./welcome.jpg" alt="" />
      </div>
      <div className="welcome-side">{children}</div>
    </main>
  );
}

/** The Botkins wordmark, drawn for light paper and for dark. */
export function WelcomeLogo() {
  return (
    <>
      <img className="welcome-logo for-light" src="./wordmark.png" alt="" />
      <img className="welcome-logo for-dark" src="./wordmark-dark.png" alt="" />
    </>
  );
}

/** Where a provider's sign-in happens, for "couldn't reach …". */
const SITES: Record<string, string> = { copilot: "GitHub", codex: "ChatGPT", claude: "Claude" };

/**
 * A plain message for a failed sign-in. `plans` offers the Copilot plans page, for a GitHub
 * Copilot sign-in only. Without a provider the message names none: no provider is assumed.
 */
export function signInError(e: unknown, provider?: Pick<ProviderStatus, "id" | "name">): { text: string; plans?: boolean; cancelled?: boolean } {
  const raw = plainError(e);
  if (/cancel|denied|declined/i.test(raw))
    return { text: "Sign-in was cancelled. Try again when you're ready.", cancelled: true };
  if (!provider) {
    if (/network|ENOTFOUND|ECONN|EAI_AGAIN|timed? ?out|offline/i.test(raw)) return { text: "Botkins couldn't reach the sign-in page. Check your internet connection and try again." };
    return { text: "Sign-in didn't finish. " + (raw || "Try again.") };
  }
  if (
    provider.id === "copilot" &&
    /copilot.*(access|subscription|seat|licen[cs]e|plan|entitle)|(access|subscription|seat|licen[cs]e|entitle).*copilot|not entitled|no (active )?copilot|forbidden|\b403\b/i.test(
      raw,
    )
  )
    return {
      text: "This GitHub account doesn't have GitHub Copilot. Choose a Copilot plan, including Copilot Free, and then sign in again.",
      plans: true,
    };
  if (provider.id !== "copilot" && /subscription|\bplan\b|not entitled|forbidden|\b403\b/i.test(raw))
    return { text: "This account's " + provider.name + " plan can't be used here. Check your plan, then sign in again." };
  if (/network|ENOTFOUND|ECONN|EAI_AGAIN|timed? ?out|offline/i.test(raw))
    return {
      text: "Botkins couldn't reach " + (SITES[provider.id] ?? provider.name) + ". Check your internet connection and try again.",
    };
  return { text: "Sign-in didn't finish. " + (raw || "Try again.") };
}

/**
 * A browser sign-in for one provider at a time, shared by the welcome and Settings › Model providers.
 * Each attempt has a number, so a cancelled attempt's late result is ignored.
 */
export function useProviderSignIn() {
  const [waiting, setWaiting] = useState<string>();
  const [problem, setProblem] = useState<ReturnType<typeof signInError> & { provider: string }>();
  const attempt = useRef(0);
  async function signIn(p: ProviderStatus) {
    const n = ++attempt.current;
    setProblem(undefined);
    setWaiting(p.id);
    try {
      await api.signIn(p.id);
      if (n !== attempt.current) return;
    } catch (e) {
      if (n !== attempt.current) return;
      setProblem({ ...signInError(e, p), provider: p.id });
    }
    // Also after a failure: a sign-in the person finished elsewhere still counts.
    await reloadProviders(true).catch(() => {});
    if (n === attempt.current) setWaiting(undefined);
  }
  function cancel(p: ProviderStatus) {
    attempt.current++;
    setWaiting(undefined);
    setProblem({ ...signInError(new Error("cancelled"), p), provider: p.id });
    void api.cancelSignIn(p.id).catch(() => {});
  }
  return { waiting, problem, setProblem, signIn, cancel };
}

/**
 * The full-window welcome: shown on first launch, and whenever no model provider is connected.
 * ChatGPT, Claude and GitHub Copilot are always the three main choices, in that order and as
 * equals: the same row, the same button, none chosen ahead or marked as recommended, whether or
 * not the provider was switched on before. Every other provider is under More providers. Once
 * any provider is connected the screen offers its one main action: Get started.
 */
export default function Welcome({
  onboarded,
  finish,
  later,
}: {
  /** The person has used Botkins before; the welcome is back because nothing is connected. */
  onboarded: boolean;
  /** Get started: marks the welcome done. */
  finish: () => Promise<void> | void;
  /** Not now: an onboarded person can open their workspace with nothing connected. */
  later?: () => void;
}) {
  const { providers, error, reload } = useProviders();
  const { waiting, problem, setProblem, signIn, cancel } = useProviderSignIn();
  const [finishing, setFinishing] = useState(false);
  /** The provider being switched on. */
  const [adding, setAdding] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const main = SETUP_PROVIDERS.map((id) => providers?.find((p) => p.id === id)).filter((p): p is ProviderStatus => !!p);
  const more = providers?.filter((p) => !SETUP_PROVIDERS.includes(p.id)) ?? [];
  const connected = !!providers?.some(isConnected);
  const loaded = !!providers || !!error;
  // Focus lands on Get started once something is connected. Before that it rests on the title:
  // putting it on one provider's button would single that provider out.
  useEffect(() => {
    if (!loaded || waiting) return;
    (connected ? primary.current : title.current)?.focus();
  }, [loaded, connected, !!waiting]);

  /** Switches a provider on and gives back its status as it is then. */
  async function switchOn(p: ProviderStatus) {
    setAdding(p.id);
    setProblem(undefined);
    try {
      await api.setProviderEnabled(p.id, true);
      await reloadProviders(true);
      return currentProviders()?.find((x) => x.id === p.id);
    } catch (e) {
      setProblem({ text: plainError(e), provider: p.id });
    } finally {
      setAdding("");
    }
  }
  /** One of the three that was switched off: one click turns it on and goes straight to its sign-in. */
  async function choose(p: ProviderStatus) {
    const now = await switchOn(p);
    if (now?.enabled && now.installed && !now.connected && !now.starting && !now.error && now.signIn === "browser") await signIn(now);
  }
  /** Another provider, from More providers: it is switched on and its row takes the focus. */
  async function add(p: ProviderStatus) {
    if (await switchOn(p)) requestAnimationFrame(() => card.current?.querySelector<HTMLElement>(`[data-provider-row="${p.id}"]`)?.focus());
  }
  const plans = () => void api.openLink(COPILOT_PLANS).catch(() => {});
  const mark = (p: ProviderStatus) => (p.id === "copilot" ? <GitHubMark size={14} /> : <ProviderIcon provider={p.id} name={p.name} size={14} />);

  function action(p: ProviderStatus) {
    // Switched off: one of the three signs in in one click; any other is added first.
    if (!p.enabled)
      return SETUP_PROVIDERS.includes(p.id) ? (
        <button className="welcome-secondary welcome-signin" disabled={!!waiting || !!adding} onClick={() => void choose(p)}>
          {mark(p)}
          {signInLabel(p)}
        </button>
      ) : (
        <button className="welcome-secondary" aria-label={"Add " + p.name} disabled={!!adding} onClick={() => void add(p)}>
          {adding === p.id ? "Adding…" : "Add"}
        </button>
      );
    if (p.starting)
      return (
        <span className="welcome-provider-state">
          <LoaderCircle size={14} className="spin" aria-hidden="true" />
          Starting…
        </span>
      );
    if (p.error)
      return (
        <button className="welcome-secondary" onClick={() => void reload(true)}>
          Try again
        </button>
      );
    if (!p.installed)
      return (
        p.install && (
          <button className="welcome-secondary" aria-label={"Get " + toolName(p)} onClick={() => void api.openLink(p.install!.url).catch(() => {})}>
            Get it
          </button>
        )
      );
    if (p.connected)
      return (
        <span className="welcome-provider-state on">
          <Check size={15} aria-hidden="true" />
          Connected
        </span>
      );
    if (p.signIn === "browser")
      return waiting === p.id ? (
        <>
          <span className="welcome-provider-state">
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
            Waiting…
          </span>
          <button className="welcome-secondary" onClick={() => cancel(p)}>
            Cancel
          </button>
        </>
      ) : (
        <button className="welcome-secondary welcome-signin" disabled={!!waiting || !!adding} onClick={() => void signIn(p)}>
          {mark(p)}
          {signInLabel(p)}
        </button>
      );
    return <span className="welcome-provider-state">Set up in Settings</span>;
  }
  // The three main choices are described in the same few words, so their rows are the same.
  const about = (p: ProviderStatus) => (SETUP_PROVIDERS.includes(p.id) ? "Your " + p.name + " plan" : describe(p));
  function line(p: ProviderStatus) {
    if (!p.enabled || p.starting) return about(p);
    if (p.error) return "Botkins couldn't ask " + p.name + ". " + p.error;
    if (!p.installed) return p.message || toolName(p) + " isn't on this computer.";
    if (p.connected) return [p.account, p.plan].filter(Boolean).join(" · ") || about(p);
    return about(p);
  }
  /** One provider: its mark, its name, one line, its action, and under them what its sign-in is waiting for or why it failed. */
  function row(p: ProviderStatus) {
    const failed = problem?.provider === p.id ? problem : undefined;
    return (
      <li key={p.id} className="welcome-provider" data-provider-row={p.id} tabIndex={-1} aria-label={p.name}>
        <span className="welcome-provider-icon" aria-hidden="true">
          <ProviderIcon provider={p.id} name={p.name} size={18} />
        </span>
        <span className="welcome-provider-text">
          <strong>{p.name}</strong>
          <small>{line(p)}</small>
        </span>
        <span className="welcome-provider-action">{action(p)}</span>
        {waiting === p.id && (
          <p className="welcome-note" role="status">
            Your browser opened {p.id === "copilot" ? "github.com" : "a sign-in page for " + p.name}. Finish signing in there, then come back.
          </p>
        )}
        {failed && (
          <div className="welcome-problem" role="alert">
            <CircleAlert size={16} />
            <span>
              {failed.text}
              {failed.plans && p.id === "copilot" && (
                <>
                  {" "}
                  <button className="set-link" onClick={plans}>
                    See Copilot plans
                  </button>
                </>
              )}
            </span>
          </div>
        )}
      </li>
    );
  }
  // A problem that belongs to no row on the screen.
  const loose = problem && !providers?.some((p) => p.id === problem.provider) ? problem : undefined;
  // More providers opens by itself when one of them is in use, so it is never out of sight.
  const moreShown = moreOpen || more.some((p) => p.enabled);

  return (
    <WelcomeFrame label="welcome-title">
      <div className="welcome-card" ref={card}>
        <WelcomeLogo />
        <h1 id="welcome-title" ref={title} tabIndex={-1}>
          {onboarded ? "Welcome back" : "Welcome to Botkins"}
        </h1>
        <p className="welcome-lede">
          {onboarded ? "Connect a model provider to pick up where you left off." : "Your AI bots, each with its own role and instructions."}
        </p>

        <section className="welcome-providers" aria-labelledby="welcome-providers-title">
          <h2 id="welcome-providers-title">{connected ? "Your model providers" : "Connect a model provider"}</h2>
          {!loaded ? (
            <p className="welcome-provider-loading" role="status">
              <LoaderCircle size={15} className="spin" aria-hidden="true" />
              Checking your model providers…
            </p>
          ) : !providers ? (
            <div className="welcome-problem" role="alert">
              <CircleAlert size={16} />
              <span>
                Botkins couldn't check your model providers. {error}{" "}
                <button className="set-link" onClick={() => void reload(true)}>
                  Try again
                </button>
              </span>
            </div>
          ) : (
            <ul className="welcome-provider-list" aria-label="Model providers">
              {main.map(row)}
            </ul>
          )}
          {more.length > 0 && (
            <details className="welcome-more" open={moreShown} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
              <summary>
                <ChevronRight size={14} aria-hidden="true" />
                More providers
              </summary>
              <ul className="welcome-provider-list" aria-label="More providers">
                {more.map(row)}
              </ul>
            </details>
          )}
        </section>

        {loose && (
          <div className="welcome-problem" role="alert">
            <CircleAlert size={16} />
            <span>{loose.text}</span>
          </div>
        )}

        {connected && (
          <div className="welcome-action">
            <button
              ref={primary}
              className="welcome-primary"
              disabled={finishing}
              onClick={async () => {
                setFinishing(true);
                try {
                  await finish();
                } catch (e) {
                  setProblem({ text: plainError(e), provider: "" });
                  setFinishing(false);
                }
              }}
            >
              {onboarded ? "Continue" : "Get started"}
              <ArrowRight size={16} />
            </button>
          </div>
        )}

        <p className="welcome-foot">Your bots run on the plans you already have.</p>
        {later && !connected && !waiting && (
          <button className="welcome-later" onClick={later}>
            Not now
          </button>
        )}
      </div>
    </WelcomeFrame>
  );
}
