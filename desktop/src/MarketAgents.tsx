import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Plus, Search, ShieldAlert, Sparkles } from "lucide-react";
import { BotAvatar } from "./Avatar";
import { colorsOf, lookOf } from "./botkins";
import { asksFirst, botChips, botSections, deliverableLine, jobLine, tooLong } from "./marketLogic";
import { Group, errorText } from "./SettingsRows";
import { teamCan } from "./teamAccess";
import type { MarketAgent, MarketAgentTemplate, State } from "./types";
import "./plugins.css";
import "./marketapps.css";
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

/** How big the cards are, in px (the CSS reads them as --art and --face): a starter's tall card, and a grid card. */
const STARTER = { width: 240, art: 120, face: 80 };
const GRID_CARD = { art: 88, face: 60 };
const HERO_FACE = 120;
/** A template's instructions show this many lines until "Show all". */
const INSTRUCTION_LINES = 4;

/** Marketplace › Bots: agent templates from the marketplaces. Add opens Create a bot, filled in. */
export default function MarketAgents({ state, createBot, refreshed = 0 }: { state: State; createBot?: (template: MarketAgentTemplate) => void; /** Counts the Marketplace's refreshes: each one reads the list again, keeping the one shown. */ refreshed?: number }) {
  const using = state.remote?.using;
  const supported = supportsAgentTemplates(state.remote);
  const allowed = teamCan(state, "agents", "create");
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState("all");
  const [agents, setAgents] = useState<MarketAgent[]>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [openId, setOpenId] = useState<string>();
  const install = useInstall(createBot);

  // One read of every template; the search and the chips narrow it here, as on the phone.
  useEffect(() => {
    if (!supported || !allowed) return;
    let live = true;
    setError("");
    api["agents.browse"]({})
      .then((result) => live && setAgents(result.agents))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [supported, allowed, revision, refreshed, using?.id]);

  const chips = useMemo(() => botChips(agents ?? []), [agents]);
  const sections = useMemo(() => botSections(agents ?? [], { query, chip }), [agents, query, chip]);

  if (!supported)
    return <Empty icon={<ShieldAlert size={20} />} title="Bots need an update" text="Update the app on your computer to see bots here." />;
  if (!allowed) return <Empty icon={<ShieldAlert size={20} />} title="Your team role can't create bots" text="Ask the person who runs this computer." />;
  if (openId) return <AgentPage id={openId} back={() => setOpenId(undefined)} install={createBot} />;

  return (
    <>
      <div className="set-toolbar int-toolbar plugin-toolbar">
        <label className="int-filter">
          <Search size={14} aria-hidden="true" />
          <input type="search" aria-label="Search bots" placeholder="Search bots" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      {chips.length > 2 && (
        <div className="plugin-market-chips" role="group" aria-label="Categories">
          {chips.map((item) => (
            <button type="button" key={item.key} className={chip === item.key ? "selected" : ""} aria-pressed={chip === item.key} onClick={() => setChip(item.key)}>
              {item.label}
            </button>
          ))}
        </div>
      )}
      {(error || install.error) && (
        <p className="set-status error-text plugin-error" role="alert">
          <span>{error || install.error}</span>
          {error && (
            <button type="button" className="set-link" onClick={() => setRevision((n) => n + 1)}>
              Retry
            </button>
          )}
        </p>
      )}
      {!agents ? (
        !error && <p className="set-status">Loading bots…</p>
      ) : agents.length === 0 ? (
        <Empty icon={<Sparkles size={20} />} title="No bot templates yet" text="Templates from your marketplaces show here." />
      ) : sections.length === 0 ? (
        <div className="app-none">
          <p className="set-status">No bots match</p>
          <button
            type="button"
            className="set-button"
            onClick={() => {
              setQuery("");
              setChip("all");
            }}
          >
            Clear
          </button>
        </div>
      ) : (
        <>
          {sections.map((section) => (
            <section className="bot-section" key={section.key}>
              <h3 className="app-section-title">{section.title}</h3>
              {section.key === "starters" ? (
                <div className="bot-carousel">
                  {section.agents.map((agent) => (
                    <BotCard key={agent.id} agent={agent} starter open={() => setOpenId(agent.id)} add={() => install.add(agent.id)} disabled={!createBot || !!install.busy} />
                  ))}
                </div>
              ) : (
                <div className="bot-grid">
                  {section.agents.map((agent) => (
                    <BotCard key={agent.id} agent={agent} open={() => setOpenId(agent.id)} add={() => install.add(agent.id)} disabled={!createBot || !!install.busy} />
                  ))}
                </div>
              )}
            </section>
          ))}
          <p className="set-foot">Add fills in Create a bot. Change anything before you save.</p>
        </>
      )}
    </>
  );
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

/** The art band of a card or a page: a soft two-stop gradient from the bot's palette (CSS mixes it into the page, so it reads in light and dark), with its still Botkin on it. */
function BotArt({ agent, face, className = "" }: { agent: MarketAgent | MarketAgentTemplate; face: number; className?: string }) {
  const look = lookOf(agent);
  const [first, second] = colorsOf(look);
  const style = { "--c1": first, "--c2": second } as React.CSSProperties;
  return (
    <span className={"bot-art " + className} style={style}>
      <BotAvatar look={agent.look} size={face} badge={false} />
    </span>
  );
}

/** A template as a card: a starter's tall one (job, deliverable), or a grid one (summary, category). Tap it for its page; Add starts a bot from it. */
function BotCard({ agent, starter, open, add, disabled }: { agent: MarketAgent; starter?: boolean; open: () => void; add: () => void; disabled: boolean }) {
  const size = starter ? STARTER : GRID_CARD;
  const style = { "--art": size.art + "px", ...(starter && { "--card-width": STARTER.width + "px" }) } as React.CSSProperties;
  return (
    <div className={"bot-card" + (starter ? " starter" : "")} style={style}>
      <button type="button" className="bot-card-open" onClick={open} aria-label={"About " + agent.name}>
        <BotArt agent={agent} face={size.face} />
        <strong>{agent.name}</strong>
        <span className="bot-card-line">{starter ? jobLine(agent) : agent.summary || agent.role}</span>
        {starter && deliverableLine(agent) && <small>{deliverableLine(agent)}</small>}
      </button>
      <div className="bot-card-foot">
        {!starter && (
          <span className="bot-card-meta">
            {agent.categoryName && <small>{agent.categoryName}</small>}
            {asksFirst(agent) && <span className="app-badge warn">Asks first</span>}
          </span>
        )}
        <button type="button" className="set-button primary" disabled={disabled} onClick={add} aria-label={"Add " + agent.name}>
          Add
        </button>
      </div>
    </div>
  );
}

/** One template: its Botkin on a band, what it is for, its instructions as they will be given, and Add. */
function AgentPage({ id, back, install }: { id: string; back: () => void; install?: (template: MarketAgentTemplate) => void }) {
  const [template, setTemplate] = useState<MarketAgentTemplate>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [all, setAll] = useState(false);
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
      <ArrowLeft size={14} /> Back to bots
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
  const long = tooLong(template.instructions, INSTRUCTION_LINES);
  const rows: [string, string | undefined][] = [
    ["What you get", template.deliverable],
    ["Works on day one", template.dayOne],
    ["Asks first", template.approval],
    ["Suggested pairing", template.pairing && [template.pairing.kind === "routine" ? "Routine" : "Proactive", template.pairing.kind === "routine" ? template.pairing.cadence : "", template.pairing.note].filter(Boolean).join(" · ")],
  ];
  return (
    <div className="plugin-detail agent-detail">
      {backLink}
      <div className="bot-hero" style={{ "--art": HERO_FACE + 40 + "px" } as React.CSSProperties}>
        <BotArt agent={template} face={HERO_FACE} />
        <div className="bot-hero-copy">
          <h3>{template.name}</h3>
          <p className="agent-detail-role">{template.role}</p>
          {template.summary && <p>{template.summary}</p>}
          <small>{agentMeta(template, true)}</small>
          <div className="plugin-detail-actions">
            <button type="button" className="set-button primary" disabled={!install} onClick={() => install?.(template)}>
              <Plus size={14} /> Add
            </button>
          </div>
        </div>
      </div>
      {rows.some(([, text]) => text) && (
        <Group>
          {rows.map(
            ([name, text]) =>
              text && (
                <div className="set-row" key={name}>
                  <div className="set-label">
                    <span className="set-name">{name}</span>
                    <small>{text}</small>
                  </div>
                </div>
              ),
          )}
        </Group>
      )}
      <Group title="Instructions" footer={template.builtIn ? undefined : "Someone else wrote these instructions: read them first."}>
        <div className="set-row agent-instructions">
          <p className={long && !all ? "collapsed" : ""} style={{ "--lines": INSTRUCTION_LINES } as React.CSSProperties}>
            {template.instructions}
          </p>
          {long && (
            <button type="button" className="set-link" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? "Show less" : "Show all"}
            </button>
          )}
        </div>
      </Group>
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
