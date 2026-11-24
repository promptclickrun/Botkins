import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CircleAlert, LoaderCircle } from "lucide-react";
import BotForm from "./BotForm";
import { BotAvatar } from "./Avatar";
import { STARTERS } from "../desktop/starters.mjs";
import { WelcomeFrame } from "./Welcome";
import ProviderIcon from "./ProviderIcon";
import type { BotTemplate, ImportableAgent, State } from "./types";
import "./settings.css";

const api = window.botkins;

/**
 * The full-window first-run step, shown while the workspace has no bots. It offers the agents the
 * person already has (for GitHub Copilot, the ones in ~/.copilot/agents) as bots. With none, or
 * when the person prefers to start fresh, it shows the three starters (desktop/starters.mjs) over
 * the Create a bot form: one fills the form in, and the person can change anything before Create.
 */
export default function FirstBot({
  saved,
  remote,
  created,
}: {
  /** Templates the person saved or imported. */
  saved?: BotTemplate[];
  remote?: State["remote"];
  /** The workspace has bots now. */
  created: () => Promise<void> | void;
}) {
  const [agents, setAgents] = useState<ImportableAgent[]>();
  const [picked, setPicked] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [starter, setStarter] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const fail = (e: unknown) =>
    setProblem((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ""));
  useEffect(() => {
    api
      .importableAgents()
      .then((list) => {
        setAgents(list);
        setPicked(list.filter((a) => !a.problem).map((a) => a.key));
      })
      // Without the list the person can still make a bot by hand.
      .catch(() => setAgents([]));
  }, []);
  const usable = agents?.filter((a) => !a.problem) ?? [];
  const form = !!agents && (creating || !usable.length);
  useEffect(() => {
    if (agents) heading.current?.focus();
  }, [!!agents, form]);

  if (!agents)
    return (
      <WelcomeFrame busy>
        <p className="welcome-signed" role="status">
          <LoaderCircle size={15} className="spin" />
          Looking for your agents…
        </p>
      </WelcomeFrame>
    );

  if (form)
    return (
      <WelcomeFrame label="firstbot-title" className="firstbot">
        <div className="welcome-card firstbot-card">
          <h1 id="firstbot-title" ref={heading} tabIndex={-1}>
            Create your first bot
          </h1>
          <p className="welcome-lede">Start with one of these, or write your own. You can add more later.</p>
          <div className="firstbot-starters" role="group" aria-label="Starters">
            {STARTERS.map((s) => (
              <button key={s.id} type="button" className="firstbot-starter" aria-pressed={starter === s.id} onClick={() => setStarter(starter === s.id ? undefined : s.id)}>
                <BotAvatar look={s.look} size={56} badge={false} />
                <strong>{s.name}</strong>
                <small>{s.summary}</small>
              </button>
            ))}
          </div>
          {problem && (
            <div className="welcome-problem" role="alert">
              <CircleAlert size={16} />
              <span>{problem}</span>
            </div>
          )}
          <div className="firstbot-form">
            <BotForm
              key={starter ?? "own"}
              starter={starter}
              remote={remote}
              saved={saved}
              agents={agents}
              fail={fail}
              created={async () => {
                setProblem("");
                await created();
              }}
            />
          </div>
          {usable.length > 0 && (
            <button
              className="welcome-later"
              onClick={() => {
                setProblem("");
                setCreating(false);
              }}
            >
              <ArrowLeft size={14} />
              Back to your agents
            </button>
          )}
        </div>
      </WelcomeFrame>
    );

  const provider = usable[0].providerName;
  const count = picked.length;
  async function add() {
    setBusy(true);
    setProblem("");
    try {
      // Bots are made in the order shown; the first one is the primary bot.
      await api.importAgents(agents!.filter((a) => picked.includes(a.key)).map((a) => a.key));
      await created();
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  }
  return (
    <WelcomeFrame label="firstbot-title" className="firstbot">
      <div className="welcome-card firstbot-card">
        <h1 id="firstbot-title" ref={heading} tabIndex={-1}>
          Bring in your agents
        </h1>
        <p className="welcome-lede">
          Botkins found {usable.length === 1 ? "an agent" : usable.length + " agents"} you already use with {provider}. Each
          one you choose becomes a bot with the same instructions.
        </p>
        <ul className="firstbot-list" aria-label={"Your " + provider + " agents"}>
          {agents.map((a) => (
            <li key={a.key}>
              <label className={a.problem ? "disabled" : undefined}>
                <input
                  type="checkbox"
                  aria-label={a.name}
                  disabled={!!a.problem || busy}
                  checked={picked.includes(a.key)}
                  onChange={(e) => setPicked((list) => (e.target.checked ? [...list, a.key] : list.filter((k) => k !== a.key)))}
                />
                <span className="firstbot-agent">
                  <strong>{a.name}</strong>
                  <small>{a.problem ? "Can't be added. " + a.problem : a.summary || a.role}</small>
                  {a.missingModel && !a.problem && (
                    <small className="firstbot-note">
                      Its model, {a.missingModel}, isn't on your account. The bot will use your default model.
                    </small>
                  )}
                  {a.ownTools && !a.problem && (
                    <small className="firstbot-note">
                      Sets its own tools in {a.providerName}. As a bot it uses Botkins' Skills, MCP servers and approvals.
                    </small>
                  )}
                </span>
                {a.modelName && !a.problem && (
                  <span className="firstbot-model">
                    <ProviderIcon provider={a.model?.provider ?? a.provider} name={a.providerName} size={12} />
                    {a.modelName}
                  </span>
                )}
              </label>
            </li>
          ))}
        </ul>

        <div className="welcome-action">
          <button className="welcome-primary" disabled={!count || busy} onClick={() => void add()}>
            {busy ? <LoaderCircle size={16} className="spin" /> : null}
            {count === 0 ? "Choose an agent" : count === 1 ? "Add 1 bot" : "Add " + count + " bots"}
            {!busy && count > 0 && <ArrowRight size={16} />}
          </button>
          <button className="welcome-secondary" disabled={busy} onClick={() => setCreating(true)}>
            Create a new bot instead
          </button>
        </div>

        {problem && (
          <div className="welcome-problem" role="alert">
            <CircleAlert size={16} />
            <span>{problem}</span>
          </div>
        )}
        <p className="welcome-foot">Botkins copies each agent. Your {provider} files stay as they are.</p>
      </div>
    </WelcomeFrame>
  );
}
