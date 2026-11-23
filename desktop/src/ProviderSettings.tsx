import { useEffect, useRef, useState, type HTMLAttributes, type SyntheticEvent } from "react";
import { ArrowLeft, LoaderCircle, Search } from "lucide-react";
import type { AuthStatus, ProviderService, ProviderStatus } from "./types";
import { ProviderInstall, ProviderToken } from "./ProviderSetup";
import { ProviderKeyed } from "./ProviderKeyed";
import ProviderIcon from "./ProviderIcon";
import { useAsk } from "./Pages";
import { Group, ValueRow } from "./SettingsRows";
import { COPILOT_PLANS, GitHubMark, useProviderSignIn } from "./Welcome";
import { describe, inSetupOrder, plainError, reloadProviders, signInLabel, toolName, useProviders } from "./providers";
import "./settings.css";
import "./models.css";

const api = window.botkins;
type Ask = ReturnType<typeof useAsk>["ask"];

/** React bubbles a nested dialog's cancel (Escape) through the component tree; this stops it at a wrapper. */
const stopCancel = { onCancel: (e: SyntheticEvent) => e.stopPropagation() } as HTMLAttributes<HTMLDivElement>;

/** How a Copilot sign-in that Botkins didn't make reached the runtime. */
const VIA: Record<string, string> = {
  "gh-cli": "the GitHub CLI",
  env: "an environment token",
  token: "a token",
  "api-key": "an API key",
  hmac: "a GitHub App",
};

/** What signing out also does on this computer, per provider. */
const SIGN_OUT_NOTE: Record<string, string> = {
  copilot: "Copilot CLI on this computer is signed out too.",
  codex: "The Codex CLI on this computer is signed out too.",
  claude: "Claude Code on this computer is signed out too.",
};

function pill(p: ProviderStatus): { text: string; tone?: "ok" | "warn" } {
  if (p.starting) return { text: "Starting…" };
  if (p.error) return { text: "Problem", tone: "warn" };
  if (!p.installed) return { text: "Not installed" };
  if (p.connected) return { text: "Connected", tone: "ok" };
  if (p.signIn === "key") return { text: "Not set up" };
  return { text: p.signIn === "browser" ? "Signed out" : "Not connected" };
}

/** Settings › Model providers: each provider that is on, its account and actions, and the ones to add. */
export default function ProviderSettings({ general, setup, windows }: { general?: () => void; setup: boolean; windows: boolean }) {
  const { providers, error, reload } = useProviders();
  const signin = useProviderSignIn();
  const dialogs = useAsk();
  // "<provider id>:<what>" while an action runs; every provider's buttons wait for it.
  const [busy, setBusy] = useState("");
  const [problems, setProblems] = useState<Record<string, string>>({});
  // After Add or Remove, focus follows the provider to where it now is.
  const [focus, setFocus] = useState<{ id: string; to: "card" | "add" }>();
  const root = useRef<HTMLDivElement>(null);
  const [copilotAuth, setCopilotAuth] = useState<AuthStatus>();
  // ChatGPT, Claude and GitHub Copilot come first, in that order, as on the welcome; then the rest.
  const on = inSetupOrder(providers?.filter((p) => p.enabled) ?? []);
  const off = inSetupOrder(providers?.filter((p) => !p.enabled) ?? []);
  const copilot = on.find((p) => p.id === "copilot");
  // Opening the page asks again (the main process keeps answers for half a minute).
  useEffect(() => {
    void reload();
  }, []);
  // A Copilot sign-in from the GitHub CLI or a token can't be signed out here; say where it came from.
  useEffect(() => {
    if (copilot?.connected)
      api
        .auth("copilot")
        .then(setCopilotAuth)
        .catch(() => setCopilotAuth(undefined));
  }, [copilot?.connected, copilot?.signOut]);
  useEffect(() => {
    if (!focus || !providers) return;
    const el =
      focus.to === "add"
        ? root.current?.querySelector<HTMLElement>(`[data-add="${focus.id}"]`)
        : (root.current?.querySelector<HTMLElement>(`[data-provider-card="${focus.id}"] [data-signin]`) ??
          root.current?.querySelector<HTMLElement>(`[data-provider-card="${focus.id}"] h3`));
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: "nearest" });
    setFocus(undefined);
  }, [focus, providers]);

  const note = (id: string, text = "") => setProblems((p) => ({ ...p, [id]: text }));
  async function enable(p: ProviderStatus, enabled: boolean) {
    if (!enabled) {
      const ok = await dialogs.ask({
        title: "Remove " + p.name + " from Botkins?",
        body:
          "Its models leave the model pickers until you add it back under Add a provider." +
          (p.connected && p.signIn === "browser" ? " You stay signed in to " + p.name + "." : ""),
        confirm: "Remove",
      });
      if (!ok) return;
    }
    setBusy(p.id + (enabled ? ":add" : ":remove"));
    note(p.id);
    try {
      await api.setProviderEnabled(p.id, enabled);
      await reloadProviders(enabled);
      setFocus({ id: p.id, to: enabled ? "card" : "add" });
    } catch (e) {
      note(p.id, plainError(e));
    } finally {
      setBusy("");
    }
  }
  async function signOut(p: ProviderStatus) {
    const ok = await dialogs.ask({
      title: "Sign out of " + p.name + "?",
      body:
        "Bots that use " +
        p.name +
        " models can't reply until you sign in again. " +
        (SIGN_OUT_NOTE[p.id] ? SIGN_OUT_NOTE[p.id] + " " : "") +
        "Your chats and bots stay here.",
      confirm: "Sign out",
      danger: true,
    });
    if (!ok) return;
    setBusy(p.id + ":signout");
    note(p.id);
    try {
      await api.signOut(p.id);
    } catch (e) {
      note(p.id, plainError(e));
    }
    await reloadProviders(true).catch(() => {});
    setBusy("");
  }

  return (
    // Escape in a question closes only that question, not Settings.
    <div className="set-stack provider-settings" ref={root} {...stopCancel}>
      {!providers ? (
        error ? (
          <p className="set-status error-text" role="alert">
            Botkins couldn't check your model providers. {error}{" "}
            <button type="button" className="set-link" onClick={() => void reload(true)}>
              Try again
            </button>
          </p>
        ) : (
          <p className="set-status" role="status">
            Checking your model providers…
          </p>
        )
      ) : (
        on.map((p) => {
          const state = pill(p);
          const waiting = signin.waiting === p.id;
          const problem = problems[p.id] || (signin.problem?.provider === p.id ? signin.problem.text : "");
          const managed =
            p.id === "copilot" && p.connected && !p.signOut && copilotAuth?.type && copilotAuth.type !== "user"
              ? "Signed in through " + (VIA[copilotAuth.type] ?? copilotAuth.type) + ". Sign out there."
              : "";
          // A Botkins or Copilot CLI sign-in can be signed out here, as before, even if the status doesn't say so.
          const canSignOut = p.signOut || (p.id === "copilot" && copilotAuth?.connected && copilotAuth.type === "user");
          return (
            <section key={p.id} className="set-group provider-card" data-provider-card={p.id} aria-labelledby={"provider-" + p.id}>
              <div className="set-card">
                <div className="set-row provider-head">
                  <span className={"provider-badge" + (p.connected ? " on" : "")} aria-hidden="true">
                    <ProviderIcon provider={p.id} name={p.name} size={20} />
                  </span>
                  <div className="set-label">
                    <h3 className="set-name" id={"provider-" + p.id} tabIndex={-1}>
                      {p.name}
                    </h3>
                    <small>{describe(p)}</small>
                    {p.keyed?.needs && <small className="provider-needs">{p.keyed.needs}</small>}
                    {p.version && (
                      <small className="provider-version">
                        {toolName(p).replace(/^the /, "").replace(/^./, (c) => c.toUpperCase())} {p.version}
                      </small>
                    )}
                  </div>
                  <div className="set-control">
                    <span className={"set-pill" + (state.tone ? " " + state.tone : "")}>{state.text}</span>
                  </div>
                </div>
                {p.starting && (
                  <div className="set-row">
                    <small className="provider-quiet">
                      <LoaderCircle size={13} className="spin" aria-hidden="true" /> Botkins is starting {p.name}. This can take a
                      minute; this page updates by itself.
                    </small>
                  </div>
                )}
                {p.error && !p.starting && (
                  <div className="set-row">
                    <small>Botkins couldn't ask {p.name}. {p.error}</small>
                  </div>
                )}
                <ProviderInstall provider={p} available={setup} windows={windows} />
                {setup && p.installed && !p.connected && p.signInWays?.token && p.signIn !== "key" && !p.starting && !waiting && (
                  <ProviderToken provider={p} />
                )}
                {p.connected && (p.account || p.plan || managed) && (
                  <ValueRow
                    label={p.account ? "Signed in as " + p.account : "Signed in"}
                    help={managed || undefined}
                    value={p.plan ?? ""}
                  />
                )}
                {p.signIn === "key" && p.keyed && !p.starting && (
                  <ProviderKeyed provider={p} keyed={p.keyed} ask={dialogs.ask} busy={busy} setBusy={setBusy} />
                )}
                {p.signIn === "services" && p.installed && !p.starting && !p.error && <Services provider={p} ask={dialogs.ask} />}
                <div className="set-actions">
                  <button
                    type="button"
                    className="set-button quiet provider-remove"
                    aria-label={"Remove " + p.name + " from Botkins"}
                    disabled={!!busy}
                    onClick={() => void enable(p, false)}
                  >
                    {busy === p.id + ":remove" ? "Removing…" : "Remove from Botkins"}
                  </button>
                  {waiting ? (
                    <>
                      <span className="set-wait" role="status">
                        Finish signing in in your browser…
                      </span>
                      <button type="button" className="set-button" onClick={() => signin.cancel(p)}>
                        Cancel
                      </button>
                    </>
                  ) : !p.installed && !p.starting ? (
                    <>
                      <button type="button" className="set-button" onClick={() => void reload(true)}>
                        Check again
                      </button>
                      {p.install && (
                        <button
                          type="button"
                          className="set-button primary"
                          onClick={() => void api.openLink(p.install!.url).catch(() => {})}
                        >
                          Get {toolName(p)}
                        </button>
                      )}
                    </>
                  ) : p.error && !p.starting ? (
                    <button type="button" className="set-button" onClick={() => void reload(true)}>
                      Try again
                    </button>
                  ) : p.starting ? null : p.connected ? (
                    <>
                      <button type="button" className="set-button" disabled={!!busy} onClick={() => void reload(true)}>
                        Check connection
                      </button>
                      {canSignOut && p.signIn !== "key" && (
                        <button
                          type="button"
                          className="set-button danger"
                          aria-label={"Sign out of " + p.name + "…"}
                          disabled={!!busy}
                          onClick={() => void signOut(p)}
                        >
                          {busy === p.id + ":signout" ? "Signing out…" : "Sign out…"}
                        </button>
                      )}
                    </>
                  ) : p.signIn === "browser" ? (
                    <button
                      type="button"
                      data-signin
                      className="set-button primary provider-signin"
                      disabled={!!signin.waiting || !!busy}
                      onClick={() => void signin.signIn(p)}
                    >
                      {p.id === "copilot" ? <GitHubMark size={14} /> : <ProviderIcon provider={p.id} name={p.name} size={14} />}
                      {signInLabel(p)}
                    </button>
                  ) : null}
                </div>
              </div>
              {problem && (
                <p className="set-status error-text provider-problem" role="alert">
                  {problem}{" "}
                  {p.id === "copilot" && signin.problem?.provider === "copilot" && signin.problem.plans && (
                    <button type="button" className="set-link" onClick={() => void api.openLink(COPILOT_PLANS).catch(() => {})}>
                      See Copilot plans
                    </button>
                  )}
                </p>
              )}
            </section>
          );
        })
      )}
      {providers && (
        <p className="set-foot provider-foot">
          Bots can use the models of every connected provider.{" "}
          {general ? (
            <>
              Choose the default model in{" "}
              <button type="button" className="set-link" onClick={general}>
                General
              </button>
              .
            </>
          ) : (
            "Choose the default model in General."
          )}
        </p>
      )}
      {off.length > 0 && (
        <Group title="Add a provider">
          {off.map((p) => (
            <div key={p.id} className="set-row provider-offer">
              <span className="provider-badge" aria-hidden="true">
                <ProviderIcon provider={p.id} name={p.name} size={18} />
              </span>
              <div className="set-label">
                <span className="set-name">{p.name}</span>
                <small>{describe(p)}</small>
              </div>
              <div className="set-control">
                <button
                  type="button"
                  className="set-button"
                  data-add={p.id}
                  aria-label={"Add " + p.name}
                  disabled={!!busy}
                  onClick={() => void enable(p, true)}
                >
                  {busy === p.id + ":add" ? "Adding…" : "Add"}
                </button>
              </div>
              {problems[p.id] && (
                <small className="error-text provider-offer-problem" role="alert">
                  {problems[p.id]}
                </small>
              )}
            </div>
          ))}
        </Group>
      )}
      {dialogs.node}
    </div>
  );
}

/** OpenCode's model services: the connected ones, and Connect a service… */
function Services({ provider, ask }: { provider: ProviderStatus; ask: Ask }) {
  const [list, setList] = useState<ProviderService[]>();
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState("");
  const [removing, setRemoving] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const load = () =>
    api
      .providerServices(provider.id)
      .then((l) => {
        setList(l);
        setError("");
      })
      .catch((e) => setError(plainError(e)));
  useEffect(() => {
    void load();
  }, [provider.id]);
  const connected = list?.filter((s) => s.connected) ?? [];
  async function remove(s: ProviderService) {
    const ok = await ask({
      title: "Remove " + s.name + "?",
      body: provider.name + " forgets the key or sign-in it keeps for " + s.name + ", and its models leave the pickers.",
      confirm: "Remove",
      danger: true,
    });
    if (!ok) return;
    setRemoving(s.id);
    setMessage("");
    try {
      await api.disconnectProviderService(provider.id, s.id);
      setMessage(s.name + " removed.");
    } catch (e) {
      setError(plainError(e));
    }
    await Promise.all([load(), reloadProviders()]);
    setRemoving("");
  }
  return (
    <div className="set-row stacked provider-services">
      <div className="set-label">
        <span className="set-name">Model services</span>
        <small>
          {provider.name}'s free models need nothing more. Connect a service to use its models with your own key or account.
        </small>
      </div>
      {!list && !error ? (
        <small className="provider-quiet">
          <LoaderCircle size={13} className="spin" aria-hidden="true" /> Looking up services…
        </small>
      ) : (
        list &&
        (connected.length ? (
          <ul className="service-list" aria-label="Connected services">
            {connected.map((s) => (
              <li key={s.id}>
                <span className="set-name">{s.name}</span>
                {s.via === "environment" ? (
                  <small>From this computer's environment</small>
                ) : (
                  <button
                    type="button"
                    className="set-button quiet"
                    aria-label={"Remove " + s.name}
                    disabled={!!removing}
                    onClick={() => void remove(s)}
                  >
                    {removing === s.id ? "Removing…" : "Remove"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <small>No services connected yet.</small>
        ))
      )}
      {error && (
        <small className="error-text" role="alert">
          {error}{" "}
          <button type="button" className="set-link" onClick={() => void load()}>
            Try again
          </button>
        </small>
      )}
      {message && (
        <small role="status" className="provider-quiet">
          {message}
        </small>
      )}
      {connecting ? (
        <ConnectService
          provider={provider}
          close={(done) => {
            setConnecting(false);
            if (done) {
              setMessage(done + " connected.");
              void load();
              void reloadProviders();
            }
            requestAnimationFrame(() => opener.current?.focus());
          }}
        />
      ) : (
        <div>
          <button
            ref={opener}
            type="button"
            className="set-button"
            onClick={() => {
              setMessage("");
              setConnecting(true);
            }}
          >
            Connect a service…
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Connect a service: search the services the provider knows, then an API key or one of the
 * service's sign-ins. A sign-in may come back with a code for the person to paste.
 */
function ConnectService({ provider, close }: { provider: ProviderStatus; close: (connected?: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProviderService[]>();
  const [searching, setSearching] = useState(false);
  const [service, setService] = useState<ProviderService>();
  const [phase, setPhase] = useState<"pick" | "method" | "working" | "waiting" | "code">("pick");
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<{ attempt: string; instructions: string }>();
  const [error, setError] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Each search has a number, so a slow answer to an older query is ignored.
  const asked = useRef(0);
  // A sign-in that is cancelled ignores its late answer.
  const attempt = useRef(0);
  useEffect(() => {
    search.current?.focus();
  }, []);
  useEffect(() => {
    if (phase !== "pick") return;
    const n = ++asked.current;
    setSearching(true);
    const t = setTimeout(
      () =>
        void api
          .providerServices(provider.id, query.trim())
          .then((l) => n === asked.current && (setResults(l), setError("")))
          .catch((e) => n === asked.current && setError(plainError(e)))
          .finally(() => n === asked.current && setSearching(false)),
      query ? 250 : 0,
    );
    return () => clearTimeout(t);
  }, [query, phase]);
  useEffect(() => {
    if (phase === "method") heading.current?.focus();
  }, [phase, service?.id]);

  function choose(s: ProviderService) {
    setService(s);
    setKey("");
    setError("");
    setPhase("method");
  }
  async function connect(options: { key: string } | { method: string }) {
    if (!service) return;
    const n = ++attempt.current;
    setError("");
    setPhase("method" in options ? "waiting" : "working");
    try {
      const result = await api.connectProviderService(provider.id, service.id, options);
      if (n !== attempt.current) return;
      setKey("");
      if (result.code) {
        setStep(result.code);
        setCode("");
        setPhase("code");
      } else close(service.name);
    } catch (e) {
      if (n !== attempt.current) return;
      setKey("");
      setError(plainError(e));
      setPhase("method");
    }
  }
  async function finish() {
    if (!service || !step) return;
    setError("");
    setPhase("working");
    try {
      const result = await api.finishProviderService(provider.id, service.id, step.attempt, code.trim());
      if (result.done) close(service.name);
      else {
        setError("That code didn't work. Check it and try again.");
        setPhase("code");
      }
    } catch (e) {
      setError(plainError(e));
      setPhase("code");
    }
  }
  function cancelWait() {
    attempt.current++;
    if (service) void api.cancelProviderService(provider.id, service.id).catch(() => {});
    setPhase("method");
  }
  return (
    <div
      className="service-connect"
      role="group"
      aria-label="Connect a service"
      onKeyDown={(e) => {
        // Escape leaves this panel, not Settings.
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (phase === "waiting") cancelWait();
        else close();
      }}
    >
      {phase === "pick" ? (
        <>
          <span className="mp-search service-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={search}
              type="search"
              aria-label="Search services"
              placeholder="Search services, such as OpenAI or Google"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </span>
          <ul className="service-results" aria-label="Services" aria-busy={searching || undefined}>
            {results?.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => choose(s)}>
                  <span>{s.name}</span>
                  {s.connected && <small>Connected</small>}
                </button>
              </li>
            ))}
          </ul>
          {results && !results.length && !searching && (
            <small role="status">No services match “{query.trim()}”.</small>
          )}
          {!results && searching && <small className="provider-quiet">Looking up services…</small>}
          <div className="service-buttons">
            <button type="button" className="set-button" onClick={() => close()}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        service && (
          <>
            <div className="service-title">
              <button
                type="button"
                className="set-close"
                aria-label="Back to services"
                disabled={phase === "working" || phase === "waiting"}
                onClick={() => {
                  setError("");
                  setPhase("pick");
                }}
              >
                <ArrowLeft size={15} />
              </button>
              <h4 ref={heading} tabIndex={-1}>
                {service.name}
              </h4>
              {service.connected && <span className="set-pill ok">Connected</span>}
            </div>
            {phase === "waiting" ? (
              <div className="service-buttons">
                <span className="set-wait" role="status">
                  Finish signing in in your browser…
                </span>
                <button type="button" className="set-button" onClick={cancelWait}>
                  Cancel
                </button>
              </div>
            ) : phase === "code" && step ? (
              <form
                className="service-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (code.trim()) void finish();
                }}
              >
                <small>{step.instructions}</small>
                <label>
                  Code
                  <input value={code} autoFocus autoComplete="off" spellCheck={false} onChange={(e) => setCode(e.target.value)} />
                </label>
                <div className="service-buttons">
                  <button type="button" className="set-button" onClick={() => close()}>
                    Cancel
                  </button>
                  <button className="set-button primary" disabled={!code.trim()}>
                    Finish
                  </button>
                </div>
              </form>
            ) : (
              <>
                {!service.methods.length && <small>{service.name} can't be connected from here.</small>}
                {service.methods.some((m) => m.type === "oauth") && (
                  <div className="service-methods">
                    {service.methods
                      .filter((m) => m.type === "oauth")
                      .map((m, i) => (
                        <button
                          key={m.id ?? "oauth" + i}
                          type="button"
                          className="set-button"
                          disabled={phase === "working"}
                          onClick={() => void connect({ method: m.id ?? "" })}
                        >
                          {m.label}
                        </button>
                      ))}
                  </div>
                )}
                {service.methods.map((m, i) =>
                  m.type === "key" ? (
                    <form
                      key={"key" + i}
                      className="service-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (key.trim()) void connect({ key: key.trim() });
                      }}
                    >
                      <label htmlFor={"service-key-" + i}>
                        {service.methods.some((m) => m.type === "oauth") ? "Or use an API key" : "API key"}
                      </label>
                      <div className="service-key">
                        <input
                          id={"service-key-" + i}
                          type="password"
                          value={key}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={phase === "working"}
                          onChange={(e) => setKey(e.target.value)}
                        />
                        <button className="set-button primary" disabled={!key.trim() || phase === "working"}>
                          {phase === "working" ? "Connecting…" : "Connect"}
                        </button>
                      </div>
                      <small>Botkins hands the key to {provider.name}, which keeps it. It isn't shown again.</small>
                    </form>
                  ) : null,
                )}
                <div className="service-buttons">
                  <button type="button" className="set-button" disabled={phase === "working"} onClick={() => close()}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </>
        )
      )}
      {error && (
        <small className="error-text" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
