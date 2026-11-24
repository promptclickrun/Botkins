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

export function supportsAgentTemplates(remote: State["remote"]) {
  const using = remote?.using;
  return (!using || using.capabilities.includes(AGENT_TEMPLATES)) && typeof api["agents.browse"] === "function";
}

/** "Productivity · Botkins · v1.0.0 · Botkins": what is known about where a template is from. */
export function agentMeta(agent: MarketAgent, more = false): string {
  return [agent.categoryName, agent.marketplaceName, more && agent.version ? "v" + agent.version : "", more ? agent.author : ""].filter(Boolean).join(" · ");
}

/** Marketplace › Agents: agent templates from the marketplaces. Install opens Create a bot, filled in. */
export default function MarketAgents({ state, createBot, refreshed = 0 }: { state: State; createBot?: (template: MarketAgentTemplate) => void; /** Counts the Marketplace's refreshes: each one reads the list again, keeping the one shown. */ refreshed?: number }) {
  const using = state.remote?.using;
  const supported = supportsAgentTemplates(state.remote);
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
  }, [supported, allowed, query, category, revision, refreshed, using?.id]);

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
      ) : agents.length === 0 ? (
        <Group title="Agents">
          <div className="set-row">
            <small>{loading ? "Searching agents…" : "No agents match this search."}</small>
          </div>
        </Group>
      ) : (
        <>
          {!searching && !category && <Featured agents={agents} open={setOpenId} install={createBot} />}
          {shelves(agents).map((shelf, index, all) => (
            <Group key={shelf.title} title={shelf.title} footer={index === all.length - 1 ? "Install fills in Create a bot. Change anything before you save." : undefined}>
              {shelf.agents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} open={() => setOpenId(agent.id)} />
              ))}
            </Group>
          ))}
        </>
      )}
    </>
  );
}

/** Starters first, then Botkins' Everyday and Builder templates, then each other marketplace. */
function shelves(agents: MarketAgent[]) {
  const out: { title: string; agents: MarketAgent[] }[] = [];
  const push = (title: string, list: MarketAgent[]) => list.length && out.push({ title, agents: list });
  push("Starters", agents.filter((agent) => agent.starter));
  const rest = agents.filter((agent) => !agent.starter);
  push("Everyday", rest.filter((agent) => agent.group === "everyday"));
  push("For builders", rest.filter((agent) => agent.group === "builder"));
  const others = new Map<string, MarketAgent[]>();
  for (const agent of rest) {
    if (agent.group === "everyday" || agent.group === "builder") continue;
    const title = agent.marketplaceName || "Other agents";
    others.set(title, [...(others.get(title) ?? []), agent]);
  }
  for (const [title, list] of others) push(title, list);
  return out;
}

/** Reads a template and opens Create a bot with it. */
function useInstall(install?: (template: MarketAgentTemplate) => void) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const add = (id: string) => {
    if (!install || busy) return;
    setBusy(id);
    setError("");
    api["agents.template"](id)
      .then((template) => install(template))
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(undefined));
  };
  return { busy, error, add };
}

/** With no search: one featured bot, and a shelf of popular ones with Add. */
function Featured({ agents, open, install }: { agents: MarketAgent[]; open: (id: string) => void; install?: (template: MarketAgentTemplate) => void }) {
  const ranked = [...agents.filter((agent) => agent.starter), ...agents.filter((agent) => !agent.starter && agent.group === "everyday"), ...agents.filter((agent) => !agent.starter && agent.group !== "everyday")];
  const hero = ranked[0];
  const popular = ranked.slice(1, 9);
  const { busy, error, add } = useInstall(install);
  if (!hero) return null;
  return (
    <>
      <section className="set-group">
        <div className="set-card agent-hero">
          <button type="button" className="agent-hero-face" onClick={() => open(hero.id)} aria-label={"About " + hero.name}>
            <BotAvatar look={hero.look} size={72} badge={false} />
          </button>
          <div className="agent-hero-copy">
            <strong>{hero.name}</strong>
            <p>{hero.deliverable || hero.summary || hero.role}</p>
            <span className="agent-hero-actions">
              <button type="button" className="set-button primary" disabled={!install || !!busy} onClick={() => add(hero.id)}>
                <Plus size={14} /> Add
              </button>
              <button type="button" className="set-link" onClick={() => open(hero.id)}>
                Details
              </button>
            </span>
          </div>
        </div>
      </section>
      {popular.length > 0 && (
        <section className="set-group">
          <h3>Popular bots</h3>
          <div className="agent-shelf">
            {popular.map((agent) => (
              <div className="agent-card" key={agent.id}>
                <button type="button" className="agent-card-open" onClick={() => open(agent.id)} aria-label={"About " + agent.name}>
                  <BotAvatar look={agent.look} size={48} badge={false} />
                  <strong>{agent.name}</strong>
                  <small>{agent.role}</small>
                </button>
                <button type="button" className="set-button" disabled={!install || !!busy} onClick={() => add(agent.id)} aria-label={"Add " + agent.name}>
                  Add
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {error && (
        <p className="set-status error-text" role="alert">
          {error}
        </p>
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
      {(template.deliverable || template.dayOne || template.approval || template.pairing) && (
        <Group>
          {template.deliverable && (
            <div className="set-row">
              <div className="set-label">
                <span className="set-name">What you get</span>
                <small>{template.deliverable}</small>
              </div>
            </div>
          )}
          {template.dayOne && (
            <div className="set-row">
              <div className="set-label">
                <span className="set-name">Works on day one</span>
                <small>{template.dayOne}</small>
              </div>
            </div>
          )}
          {template.approval && (
            <div className="set-row">
              <div className="set-label">
                <span className="set-name">Asks first</span>
                <small>{template.approval}</small>
              </div>
            </div>
          )}
          {template.pairing && (
            <div className="set-row">
              <div className="set-label">
                <span className="set-name">Suggested pairing</span>
                <small>{[template.pairing.kind === "routine" ? "Routine" : "Proactive", template.pairing.kind === "routine" ? template.pairing.cadence : "", template.pairing.note].filter(Boolean).join(" · ")}</small>
              </div>
            </div>
          )}
        </Group>
      )}
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
