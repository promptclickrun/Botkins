import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, Plus, Search, ShieldAlert, Sparkles } from "lucide-react";
import { BotAvatar } from "./Avatar";
import { Group, errorText } from "./SettingsRows";
import { teamCan } from "./teamAccess";
import type { MarketAgent, MarketAgentCategory, MarketAgentTemplate, State } from "./types";
import "./plugins.css";
import "./marketagents.css";

const api = window.botkins;
/** Named by the computer's app when it reads agent templates (the phone's docs/agent-templates.md). */
export const AGENT_TEMPLATES = "agent-templates-v1";

/** "Productivity · Botkins · v1.0.0 · Botkins": what is known about where a template is from. */
export function agentMeta(agent: MarketAgent, more = false): string {
  return [agent.categoryName, agent.marketplaceName, more && agent.version ? "v" + agent.version : "", more ? agent.author : ""].filter(Boolean).join(" · ");
}

/** Marketplace › Agents: agent templates from the marketplaces. Install opens Create a bot, filled in. */
export default function MarketAgents({ state, createBot }: { state: State; createBot?: (template: MarketAgentTemplate) => void }) {
  const using = state.remote?.using;
  const supported = (!using || using.capabilities.includes(AGENT_TEMPLATES)) && typeof api["agents.browse"] === "function";
  const allowed = teamCan(state, "agents", "create");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [agents, setAgents] = useState<MarketAgent[]>();
  const [categories, setCategories] = useState<MarketAgentCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [openId, setOpenId] = useState<string>();

  useEffect(() => {
    if (!supported || !allowed) return;
    let live = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      api["agents.browse"]({ ...(query.trim() && { query: query.trim() }), ...(category && { category }) })
        .then((result) => {
          if (!live) return;
          setAgents(result.agents);
          setCategories(result.categories);
        })
        .catch((e) => live && setError(errorText(e)))
        .finally(() => live && setLoading(false));
    }, query ? 150 : 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [supported, allowed, query, category, revision, using?.id]);

  if (!supported)
    return <Empty icon={<ShieldAlert size={20} />} title="Agents need an update" text="Update the app on your computer to see agent templates here." />;
  if (!allowed) return <Empty icon={<ShieldAlert size={20} />} title="Your team role can't create bots" text="Ask the person who runs this computer." />;
  if (openId) return <AgentPage id={openId} back={() => setOpenId(undefined)} install={createBot} />;

  const total = categories.reduce((sum, item) => sum + item.count, 0);
  const searching = !!query.trim();
  return (
    <>
      <div className="set-toolbar int-toolbar plugin-toolbar">
        <label className="int-filter">
          <Search size={14} aria-hidden="true" />
          <input type="search" aria-label="Search agents" placeholder="Search agents" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      {categories.length > 1 && (
        <div className="plugin-market-chips" role="group" aria-label="Categories">
          <button type="button" className={category ? "" : "selected"} aria-pressed={!category} onClick={() => setCategory("")}>
            All <span className="agent-chip-count">{total}</span>
          </button>
          {categories.map((item) => (
            <button type="button" key={item.id} className={category === item.id ? "selected" : ""} aria-pressed={category === item.id} onClick={() => setCategory(category === item.id ? "" : item.id)}>
              {item.name} <span className="agent-chip-count">{item.count}</span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="set-status error-text plugin-error" role="alert">
          <span>{error}</span>
          <button type="button" className="set-link" onClick={() => setRevision((n) => n + 1)}>
            Retry
          </button>
        </p>
      )}
      {!agents ? (
        !error && <p className="set-status">Loading agents…</p>
      ) : agents.length === 0 && !searching && !category ? (
        <Empty icon={<Sparkles size={20} />} title="No agent templates yet" text="Templates from your marketplaces show here." />
      ) : (
        <Group title="Agents" footer="Install fills in Create a bot. Change anything before you save.">
          {agents.length ? (
            agents.map((agent) => <AgentRow key={agent.id} agent={agent} open={() => setOpenId(agent.id)} />)
          ) : (
            <div className="set-row">
              <small>{loading ? "Searching agents…" : "No agents match this search."}</small>
            </div>
          )}
        </Group>
      )}
    </>
  );
}

function AgentRow({ agent, open }: { agent: MarketAgent; open: () => void }) {
  return (
    <button type="button" className="plugin-listing agent-listing" onClick={open}>
      <span className="agent-listing-face" aria-hidden="true">
        <BotAvatar look={agent.look} size={40} badge={false} />
      </span>
      <span className="plugin-listing-copy">
        <strong>{agent.name}</strong>
        <small>{agent.summary || agent.role}</small>
        <em>{agentMeta(agent)}</em>
      </span>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  );
}

/** One template: its Botkin, what it is for, its instructions as they will be given, and Install. */
function AgentPage({ id, back, install }: { id: string; back: () => void; install?: (template: MarketAgentTemplate) => void }) {
  const [template, setTemplate] = useState<MarketAgentTemplate>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setError("");
    api["agents.template"](id)
      .then((value) => live && setTemplate(value))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [id, revision]);
  const backLink = (
    <button type="button" className="set-link plugin-back" onClick={back}>
      <ArrowLeft size={14} /> Back to agents
    </button>
  );
  if (!template)
    return (
      <div className="plugin-detail">
        {backLink}
        {error ? (
          <p className="set-status error-text plugin-error" role="alert">
            <span>{error}</span>
            <button type="button" className="set-link" onClick={() => setRevision((n) => n + 1)}>
              Retry
            </button>
          </p>
        ) : (
          <p className="set-status">Reading the template…</p>
        )}
      </div>
    );
  return (
    <div className="plugin-detail agent-detail">
      {backLink}
      <div className="agent-detail-head">
        <BotAvatar look={template.look} size={88} badge={false} />
        <div>
          <h3>{template.name}</h3>
          <p className="agent-detail-role">{template.role}</p>
          {template.summary && <p>{template.summary}</p>}
          <small>{agentMeta(template, true)}</small>
        </div>
      </div>
      <Group title="Instructions" footer={template.builtIn ? undefined : "Someone else wrote these instructions: read them first."}>
        <div className="set-row agent-instructions">
          <p>{template.instructions}</p>
        </div>
      </Group>
      <div className="plugin-detail-actions">
        <button type="button" className="set-button primary" disabled={!install} onClick={() => install?.(template)}>
          <Plus size={14} /> Install
        </button>
      </div>
    </div>
  );
}

function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <Group>
      <div className="int-empty">
        <span className="int-empty-icon" aria-hidden="true">
          {icon}
        </span>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </Group>
  );
}
