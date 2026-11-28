import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Bot as BotIcon, ChevronDown, Download, Ellipsis, LayoutTemplate, Plus, Trash2, Upload } from "lucide-react";
import { Button, Input } from "glisse";
import { BotStudio } from "./BotStudio";
import { BotAvatar } from "./Avatar";
import { availableHeads, freshLook } from "./botkins";
import type { BotLook, BotTemplate, ImportableAgent, MarketAgent, MarketAgentTemplate, State } from "./types";
import { supportsTemplateBundles, TemplateBundle } from "./TemplateBundle";
import { readAgentTemplate, supportsAgentTemplates } from "./MarketAgents";
import { errorText } from "./SettingsRows";
import { type Starter, starterById, STARTERS } from "../desktop/starters.mjs";
import "./agents.css";
import "./settings.css";
import "./botpage.css";

type Picker = "templates" | "import" | undefined;

/** The Create a bot sheet. Calls `created` with the new bot's id. */
export default function BotForm({
  created,
  fail,
  cancel,
  saved = [],
  agents: given,
  taken,
  remote,
  start,
  starter: firstStarter,
}: {
  /** `setUp`: the bot came from a starter that suggests Proactive, so its setup steps should open. */
  created: (id: string, after?: { setUp: boolean }) => void;
  fail: (e: unknown) => void;
  /** Closes the sheet without creating a bot. */
  cancel?: () => void;
  /** Templates the person saved or imported. */
  saved?: BotTemplate[];
  /** The person's existing agents, when the caller already has them. Otherwise the form looks them up. */
  agents?: ImportableAgent[];
  /** The looks of the bots there already are, so the new bot starts as a character few of them have. */
  taken?: (BotLook | undefined)[];
  remote?: State["remote"];
  /** An agent template from Marketplace › Agents to start from: the form opens filled in from it. */
  start?: MarketAgentTemplate;
  /** A starter's id (desktop/starters.mjs) to start from, when there is no `start`. */
  starter?: string;
}) {
  const [found, setFound] = useState<ImportableAgent[]>([]);
  const agents = given ?? found;
  useEffect(() => {
    if (given) return;
    // The menu just has no agents section when the lookup fails.
    void window.botkins.importableAgents().then(setFound, () => {});
  }, []);
  /** The existing agent the form was filled from. */
  const [agentKey, setAgentKey] = useState<string>();
  const agent = agents.find((a) => a.key === agentKey);
  const characters = availableHeads(remote);
  const formLook = (look?: BotLook) => {
    if (!look) return freshLook(taken, characters);
    return characters.some((head) => head.id === look.head) ? look : { ...look, head: freshLook(taken, characters).head };
  };
  const first = start ? undefined : starterById(firstStarter);
  const filled = start ?? first;
  const [look, setLook] = useState<BotLook>(() => formLook(filled?.look));
  /** The starter the form was filled from, until another start is chosen. */
  const [starterId, setStarterId] = useState(first?.id);
  const starter = starterById(starterId);
  const [studio, setStudio] = useState(false);
  const [chosen, setChosen] = useState<BotTemplate>();
  const mine = chosen?.id;
  /** The marketplace template the form was filled from, until another start is chosen. */
  const [market, setMarket] = useState(start);
  const [name, setName] = useState(filled?.name ?? "");
  const [role, setRole] = useState(filled?.role ?? "");
  const [summary, setSummary] = useState(filled?.summary ?? "");
  const [instructions, setInstructions] = useState(filled?.instructions ?? "");
  const onlineUnifiedHosts = remote?.unified ? (remote.unifiedHosts ?? []).filter((h) => h.local || h.state === "online") : [];
  const [targetHost, setTargetHost] = useState(remote?.settingsHost ?? "local");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<Picker>();
  const bundle = market?.bundle ?? chosen?.bundle;
  const bundlesSupported = supportsTemplateBundles(remote);
  const canCreate = !busy && (!bundle || bundlesSupported);
  function useStarter(s: Starter) {
    setStarterId(s.id);
    setMarket(undefined);
    setChosen(undefined);
    setAgentKey(undefined);
    setName(s.name);
    setRole(s.role);
    setSummary(s.summary);
    setInstructions(s.instructions);
    setLook(formLook(s.look));
    setPicking(undefined);
  }
  function useMarket(t: MarketAgentTemplate) {
    setStarterId(undefined);
    setMarket(t);
    setChosen(undefined);
    setAgentKey(undefined);
    setName(t.name);
    setRole(t.role);
    setSummary(t.summary);
    setInstructions(t.instructions);
    setLook(formLook(t.look));
    setPicking(undefined);
  }
  function useAgent(a: ImportableAgent) {
    setStarterId(undefined);
    setMarket(undefined);
    setChosen(undefined);
    setAgentKey(a.key);
    setName(a.name);
    setRole(a.role);
    setSummary(a.summary);
    setInstructions(a.instructions);
    setPicking(undefined);
  }
  function useMine(t: BotTemplate) {
    setStarterId(undefined);
    setMarket(undefined);
    setChosen(t);
    setAgentKey(undefined);
    setName(t.name);
    setRole(t.role);
    setSummary(t.summary ?? "");
    setInstructions(t.instructions);
    if (t.look) setLook(formLook(t.look));
    setPicking(undefined);
  }
  async function importOne() {
    try {
      const id = await window.botkins.importTemplate();
      if (!id) return;
      const snapshot = await window.botkins.snapshot();
      const t = snapshot.templates?.find((x) => x.id === id);
      if (t) useMine(t);
    } catch (e) {
      fail(e);
    }
  }
  return (
    <form
      className="botform"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!canCreate) return;
        setBusy(true);
        try {
          const id = await window.botkins.addBot({
            name: name.trim(),
            role: role.trim(),
            instructions: instructions.trim(),
            look,
            ...(summary.trim() && { summary: summary.trim() }),
            ...(agent && { agent: agent.key }),
            ...(starter && { starter: starter.id }),
            ...(bundle && { bundle }),
            ...(onlineUnifiedHosts.length > 1 && { hostId: targetHost }),
          });
          created(id, { setUp: !!starter?.suggestProactive });
        } catch (e) {
          fail(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="botform-bar">
        <TemplateMenu
          open={picking}
          setOpen={setPicking}
          remote={remote}
          mine={mine}
          saved={saved}
          agents={agents}
          agentKey={agentKey}
          starterId={starterId}
          useStarter={useStarter}
          useMarket={useMarket}
          useMine={useMine}
          useAgent={useAgent}
          importOne={() => void importOne()}
          forget={(id) => {
            if (mine === id) setChosen(undefined);
            window.botkins.deleteTemplate(id).catch(fail);
          }}
          exportOne={(id) => void window.botkins.exportTemplate({ templateId: id }).catch(fail)}
        />
      </div>
      {market && (
        <p className="template-note" role="note">
          From {market.marketplaceName === "Botkins" ? "the Botkins marketplace" : market.marketplaceName}.
          {!market.builtIn && " Someone else wrote these instructions: read them first."}
        </p>
      )}
      {chosen?.source === "imported" && (
        <p className="template-note" role="note">
          Imported from {chosen.from ?? "a file"}. Someone else wrote these instructions: read them first.
        </p>
      )}
      {agent && (
        <p className="template-note" role="note">
          Copied from your {agent.providerName} agent {agent.agent}
          {agent.modelName ? ", with its model, " + agent.modelName : ""}. Changes you make here don't change that agent.
          {agent.missingModel && " Its model, " + agent.missingModel + ", isn't on your account, so this bot will use your default model."}
          {agent.ownTools && " It sets its own tools there. This bot uses Botkins' Skills, MCP servers and approvals instead."}
        </p>
      )}
      {onlineUnifiedHosts.length > 1 && (
        <div className="settings-host-bar">
          <label htmlFor="botform-target-host">Create bot on</label>
          <select id="botform-target-host" value={targetHost} onChange={(e) => setTargetHost(e.target.value)}>
            {onlineUnifiedHosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.local ? h.name + " (this computer)" : h.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {/* The bot as the phone shows it: its Botkin beside its name and role, then what it is for. */}
      <div className="botform-top group padded botform-card">
        <div className="botform-face">
          <button
            type="button"
            className="botform-avatar"
            aria-label="Open Bot Studio"
            aria-describedby="botform-avatar-hint"
            onClick={() => setStudio(true)}
          >
            <BotAvatar look={look} size={96} />
          </button>
          <small id="botform-avatar-hint">Click to change</small>
        </div>
        <div className="botform-fields">
          <label>
            Name
            <Input
              name="name"
              maxLength={48}
              required
              autoFocus
              placeholder="e.g. Nova"
              value={name}
              onValueChange={setName}
            />
          </label>
          <label>
            Role
            <Input
              name="role"
              placeholder="e.g. Writing partner"
              maxLength={90}
              required
              value={role}
              onValueChange={setRole}
            />
          </label>
        </div>
      </div>
      <div className="group padded botform-card">
        <label>
          <span>
            About <span className="optional">Optional</span>
          </span>
          <Input
            name="summary"
            aria-label="About"
            maxLength={240}
            placeholder="A line about what this bot is for"
            value={summary}
            onValueChange={setSummary}
          />
        </label>
        <label>
          Instructions
          <textarea
            name="instructions"
            placeholder="How should this bot help? What should it always or never do?"
            rows={chosen || agent || market || starter ? 6 : 5}
            required
            maxLength={30000}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>
      </div>
      <TemplateBundle bundle={bundle} supported={bundlesSupported} />
      <footer className="botform-foot">
        {cancel && (
          <Button variant="glass" className="lg-compact" onClick={cancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="filled" className="lg-compact" icon={<Plus size={15} />} disabled={!canCreate}>
          Create bot
        </Button>
      </footer>
      {studio && (
        <BotStudio
          value={look}
          characters={characters}
          cancel={() => setStudio(false)}
          save={(v) => {
            setLook(v);
            setStudio(false);
          }}
        />
      )}
    </form>
  );
}

function TemplateMenu({
  open,
  setOpen,
  remote,
  mine,
  saved,
  agents,
  agentKey,
  starterId,
  useStarter,
  useMarket,
  useMine,
  useAgent,
  importOne,
  forget,
  exportOne,
}: {
  open: Picker;
  setOpen: (value: Picker) => void;
  remote?: State["remote"];
  mine?: string;
  saved: BotTemplate[];
  agents: ImportableAgent[];
  agentKey?: string;
  starterId?: string;
  useStarter: (s: Starter) => void;
  useMarket: (t: MarketAgentTemplate) => void;
  useMine: (t: BotTemplate) => void;
  useAgent: (a: ImportableAgent) => void;
  importOne: () => void;
  forget: (id: string) => void;
  exportOne: (id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState("");
  useEffect(() => {
    setMenu("");
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(undefined);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  return (
    <div
      className="template-picker"
      ref={box}
      onKeyDown={(e) => {
        // Escape closes the popover (or a template's menu), not the whole sheet.
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          if (menu) setMenu("");
          else {
            setOpen(undefined);
            box.current?.querySelector<HTMLElement>('.template-trigger[aria-expanded="true"]')?.focus();
          }
        }
      }}
    >
      <button
        type="button"
        className="template-trigger"
        aria-haspopup="true"
        aria-expanded={open === "templates"}
        onClick={() => setOpen(open === "templates" ? undefined : "templates")}
      >
        <LayoutTemplate size={15} />
        Start from template
        <ChevronDown size={14} />
      </button>
      <button type="button" className="template-trigger" aria-haspopup="true" aria-expanded={open === "import"} onClick={() => setOpen(open === "import" ? undefined : "import")}>
        <Upload size={15} /> Import <ChevronDown size={14} />
      </button>
      {open === "import" && (
        <div className="template-pop">
          <button type="button" className="set-button" onClick={importOne}>
            <Upload size={14} /> Import from file…
          </button>
          {[...new Set(agents.map((a) => a.providerName))].map((provider) => (
            <div key={provider} className="template-section" role="group" aria-label={"Your " + provider + " agents"}>
              <span className="template-heading">Your {provider} agents</span>
              {agents.filter((a) => a.providerName === provider).map((a) => (
                <button
                  type="button"
                  key={a.key}
                  className="template-item"
                  aria-label={a.name}
                  aria-pressed={agentKey === a.key}
                  disabled={!!a.problem}
                  title={a.problem}
                  onClick={() => useAgent(a)}
                >
                  <BotIcon size={18} />
                  <span>
                    <strong>{a.name}</strong>
                    <small>{a.problem ?? (a.added ? "Already a bot · " + a.role : a.role)}</small>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {open === "templates" && (
        <div className="template-pop">
          <div className="template-section" role="group" aria-label="Starters">
            <span className="template-heading">Starters</span>
            {STARTERS.map((s) => (
              <button type="button" key={s.id} className="template-item" aria-label={s.name} aria-pressed={starterId === s.id} onClick={() => useStarter(s)}>
                <BotAvatar look={s.look} size={32} />
                <span>
                  <strong>{s.name}</strong>
                  <small>{s.summary}</small>
                </span>
              </button>
            ))}
          </div>
          <div className="template-section" role="group" aria-label="Marketplace templates">
            <span className="template-heading">Marketplace</span>
            {supportsAgentTemplates(remote) ? <MarketTemplates key={remote?.using?.id} bundlesSupported={supportsTemplateBundles(remote)} pick={useMarket} /> : (
              <p className="set-status"><strong>Agents need an update</strong><br />Update the app on your computer to see agent templates here.</p>
            )}
          </div>
          <div className="template-section" role="group" aria-label="Your templates">
            <span className="template-heading">Your templates</span>
            {saved.map((t) => (
              <div key={t.id} className="template-row">
                <button
                  type="button"
                  className="template-item"
                  aria-label={t.name}
                  aria-pressed={mine === t.id}
                  title={t.source === "imported" ? "Imported from " + (t.from ?? "a file") : "Saved from a bot"}
                  onClick={() => useMine(t)}
                >
                  {t.look ? <BotAvatar look={t.look} size={32} /> : <LayoutTemplate size={18} />}
                  <span>
                    <strong>{t.name}</strong>
                    <small>{t.source === "imported" ? "Imported · " + t.role : t.role}</small>
                    {t.summary && <small>{t.summary}</small>}
                  </span>
                </button>
                <button
                  type="button"
                  className="template-more"
                  aria-label={"Options for template " + t.name}
                  aria-haspopup="menu"
                  aria-expanded={menu === t.id}
                  onClick={() => setMenu(menu === t.id ? "" : t.id)}
                >
                  <Ellipsis size={15} />
                </button>
                {menu === t.id && (
                  <span className="my-template-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu("");
                        exportOne(t.id);
                      }}
                    >
                      <Download size={14} /> Export…
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      onClick={() => {
                        setMenu("");
                        forget(t.id);
                      }}
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  </span>
                )}
              </div>
            ))}
            {!saved.length && (
              <small className="template-empty">Save a bot as a template from its page, or import one someone shared.</small>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MarketTemplates({ pick, bundlesSupported }: { bundlesSupported: boolean; pick: (template: MarketAgentTemplate) => void }) {
  const [agents, setAgents] = useState<MarketAgent[]>();
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  const [tries, setTries] = useState(0);
  const apply = useEffectEvent(pick);
  useEffect(() => {
    let live = true;
    setError("");
    const read = id
      ? readAgentTemplate(id, bundlesSupported).then((t) => live && apply(t))
      : window.botkins["agents.browse"]({}).then((page) => live && setAgents(page.agents));
    read.catch((e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [id, tries, bundlesSupported]);

  if (error) return <p className="set-status error-text" role="alert">{error} <button type="button" className="set-link" onClick={() => setTries(tries + 1)}>Retry</button></p>;
  if (!agents || id) return <p className="set-status">{id ? "Reading the template…" : "Loading agents…"}</p>;
  if (!agents.length) return <p className="template-empty">No agent templates yet</p>;
  return agents.map((t) => (
    <button key={t.id} type="button" className="template-item" onClick={() => setId(t.id)}>
      <BotAvatar look={t.look} size={32} />
      <span><strong>{t.name}</strong><small>{t.role}</small>{t.summary && <small>{t.summary}</small>}</span>
    </button>
  ));
}
