import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Package, Sparkles, Wrench } from "lucide-react";
import type { Bot, FeaturedSkill, MarketAgent, MarketAgentTemplate, State } from "./types";
import PluginsSettings, { type MarketView } from "./PluginsSettings";
import { AgentPage, BotArt, BotCard, supportsAgentTemplates, useInstall } from "./MarketAgents";
import { CatalogEntryPage, FeaturedCard, AppCard, useMcpCatalog } from "./McpCatalog";
import { appsBlocks, botSections, jobLine } from "./marketLogic";
import { teamCan } from "./teamAccess";
import { errorText } from "./SettingsRows";
import "./settings.css";
import "./plugins.css";
import "./marketapps.css";
import "./marketagents.css";

const api = window.botkins;

/** How many cards a shelf on Discover shows before "See all" opens the full view. */
const SHELF = 10;
const APPS = 8;

/**
 * The Market: its own page, as on the phone. Discover first (a featured bot, the popular bots, the
 * featured apps and skills, and rows into Plugins and Pi packages), then a view for each catalog.
 * The views are the ones Settings › Marketplace shows, so both stay in step.
 */
export default function MarketPage({
  state,
  bots,
  createBot,
  openSkill,
}: {
  state: State;
  bots: Bot[];
  /** Opens Create a bot filled in from an agent template. */
  createBot?: (template: MarketAgentTemplate) => void;
  /** Opens an installed skill in Settings › Skills. Without it, Settings opens on Skills. */
  openSkill?: (name: string) => void;
}) {
  const open = openSkill ?? (() => window.dispatchEvent(new CustomEvent("botkins-open-settings", { detail: "Skills" })));
  return (
    <PluginsSettings
      page
      state={state}
      bots={bots}
      createBot={createBot}
      openSkill={open}
      home={(go, refreshed) => <Discover state={state} go={go} createBot={createBot} refreshed={refreshed} />}
    />
  );
}

/** Market › Discover: the phone's front page of the Market, from the catalogs the computer reads. */
function Discover({
  state,
  go,
  createBot,
  refreshed,
}: {
  state: State;
  go: (view: MarketView) => void;
  createBot?: (template: MarketAgentTemplate) => void;
  refreshed: number;
}) {
  const using = state.remote?.using;
  const botsAllowed = supportsAgentTemplates(state.remote) && teamCan(state, "agents", "create");
  const skillsAllowed = teamCan(state, "skills", "read") && typeof api["skillsCatalog.featured"] === "function";
  const [agents, setAgents] = useState<MarketAgent[]>();
  const [skills, setSkills] = useState<FeaturedSkill[]>();
  const [error, setError] = useState("");
  const [agentId, setAgentId] = useState<string>();
  const [appId, setAppId] = useState<string>();
  const install = useInstall(createBot);
  const apps = useMcpCatalog(state);

  useEffect(() => {
    if (!botsAllowed) return;
    let live = true;
    api["agents.browse"]({})
      .then((result) => live && setAgents(result.agents))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [botsAllowed, refreshed, using?.id]);
  useEffect(() => {
    if (!skillsAllowed) return;
    let live = true;
    api["skillsCatalog.featured"]().then(
      (next) => live && setSkills(next),
      () => live && setSkills([]),
    );
    return () => {
      live = false;
    };
  }, [skillsAllowed, refreshed, using?.id]);

  // The starters lead, as on the phone; with none, the first templates of any kind.
  const popular = useMemo(() => {
    const sections = botSections(agents ?? [], {});
    return (sections.find((s) => s.key === "starters") ?? sections[0])?.agents.slice(0, SHELF) ?? [];
  }, [agents]);
  const featuredApps = useMemo(() => {
    const blocks = appsBlocks(apps.catalog?.entries ?? [], {});
    const featured = blocks.find((b) => b.kind === "featured");
    return (featured ?? blocks[0])?.entries.slice(0, APPS) ?? [];
  }, [apps.catalog]);

  if (agentId) return <AgentPage id={agentId} back={() => setAgentId(undefined)} install={createBot} />;
  if (appId) return <CatalogEntryPage state={state} catalog={apps.catalog} id={appId} back={() => setAppId(undefined)} backLabel="Back to Discover" reload={apps.reload} />;

  const hero = popular[0];
  const more: { view: MarketView; title: string; sub: string; icon: typeof Wrench; tile: string }[] = [
    { view: "skills", title: "Skills", sub: "Know-how your bots can learn, from skills.sh and plugins.", icon: Sparkles, tile: "fern" },
    { view: "plugins", title: "Plugins", sub: "Skills, tools, hooks and commands in one install.", icon: Wrench, tile: "clay" },
    { view: "pi", title: "Pi packages", sub: "Extensions for the Pi harness.", icon: Package, tile: "tide" },
  ];
  return (
    <div className="market-discover">
      {(error || install.error) && (
        <p className="set-status error-text plugin-error" role="alert">
          <span>{error || install.error}</span>
        </p>
      )}
      {hero && (
        <section className="market-hero" aria-label={"Featured: " + hero.name}>
          <BotArt agent={hero} face={112} className="market-hero-art" />
          <div className="market-hero-copy">
            <span className="group-label">Featured bot</span>
            <h2>{hero.name}</h2>
            <p>{jobLine(hero) || hero.summary || hero.role}</p>
            <div className="market-hero-actions">
              <button type="button" className="btn primary" disabled={!createBot || !!install.busy} onClick={() => install.add(hero.id)} aria-label={"Add " + hero.name}>
                Add to my bots
              </button>
              <button type="button" className="btn" onClick={() => setAgentId(hero.id)} aria-label={"About " + hero.name}>
                About
              </button>
            </div>
          </div>
        </section>
      )}
      {popular.length > 1 && (
        <Shelf title="Popular bots" seeAll={() => go("agents")}>
          <div className="bot-carousel">
            {popular.slice(1).map((agent) => (
              <BotCard key={agent.id} agent={agent} starter open={() => setAgentId(agent.id)} add={() => install.add(agent.id)} disabled={!createBot || !!install.busy} />
            ))}
          </div>
        </Shelf>
      )}
      {featuredApps.length > 0 && (
        <Shelf title="Apps" seeAll={() => go("apps")}>
          <div className="market-app-grid">
            {featuredApps.slice(0, 2).map((entry) => (
              <FeaturedCard key={entry.id} entry={entry} open={setAppId} />
            ))}
            {featuredApps.slice(2).map((entry) => (
              <AppCard key={entry.id} entry={entry} open={setAppId} />
            ))}
          </div>
        </Shelf>
      )}
      {skills && skills.length > 0 && (
        <Shelf title="Skills" seeAll={() => go("skills")}>
          <div className="market-skill-shelf">
            {skills.slice(0, SHELF).map((skill) => (
              <button type="button" className="market-skill" key={skill.id} onClick={() => go("skills")} aria-label={skill.name + (skill.installed ? ", installed" : "")}>
                <span className="icon-tile fern" aria-hidden="true">
                  <Sparkles size={15} />
                </span>
                <strong>{skill.name}</strong>
                <small>{skill.summary}</small>
                {skill.installed && <span className="app-badge ok">Installed</span>}
              </button>
            ))}
          </div>
        </Shelf>
      )}
      <section className="page-section">
        <h3 className="group-label">More in the Market</h3>
        <div className="group">
          {more
            .filter((row) => row.view !== "skills" || teamCan(state, "skills", "read"))
            .map(({ view, title, sub, icon: Icon, tile }) => (
              <button type="button" className="group-row" key={view} onClick={() => go(view)}>
                <span className={"icon-tile " + tile} aria-hidden="true">
                  <Icon size={15} />
                </span>
                <span className="row-main">
                  <span className="row-title">{title}</span>
                  <span className="row-sub">{sub}</span>
                </span>
                <ChevronRight size={16} className="row-chevron" aria-hidden="true" />
              </button>
            ))}
        </div>
      </section>
    </div>
  );
}

/** A titled shelf of cards with "See all", which opens that catalog's full view. */
function Shelf({ title, seeAll, children }: { title: string; seeAll: () => void; children: React.ReactNode }) {
  return (
    <section className="page-section market-shelf">
      <div className="group-label">
        <h3>{title}</h3>
        <span className="spacer" />
        <button type="button" className="link-button" onClick={seeAll} aria-label={"See all " + title.toLowerCase()}>
          See all
        </button>
      </div>
      {children}
    </section>
  );
}
