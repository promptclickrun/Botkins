import { useEffect, useRef, useState } from "react";
import { Bot as BotIcon, ChevronDown, Download, Ellipsis, LayoutTemplate, Plus, Trash2, Upload } from "lucide-react";
import { BotStudio } from "./BotStudio";
import { BotAvatar } from "./Avatar";
import { freshLook } from "./botkins";
import type { BotLook, BotTemplate, ImportableAgent, MarketAgentTemplate } from "./types";
import "./agents.css";
import "./settings.css";
import "./botpage.css";

type Template = {
  name: string;
  role: string;
  instructions: string;
  /** The character that suits it. The same choices as the phone app. */
  look: BotLook;
};
export const templates: Template[] = [
  {
    name: "Writer",
    role: "Writing partner",
    instructions:
      "Help me draft, edit and tighten writing. Match my voice, keep it plain and concise, and point out anything unclear.",
    look: { head: "muse", palette: "original" },
  },
  {
    name: "Researcher",
    role: "Research assistant",
    instructions:
      "Find and summarize reliable information. Cite your sources, separate facts from guesses, and say when you are unsure.",
    look: { head: "fathom", palette: "original" },
  },
  {
    name: "Coder",
    role: "Coding partner",
    instructions:
      "Help me write, review and debug code. Read the existing code first, keep changes small, and explain the trade-offs.",
    look: { head: "tinker", palette: "original" },
  },
  {
    name: "Planner",
    role: "Planning and priorities",
    instructions:
      "Turn goals into clear plans with next steps, owners and dates. Keep lists short and flag risks early.",
    look: { head: "beacon", palette: "original" },
  },
  {
    name: "Tutor",
    role: "Patient tutor",
    instructions:
      "Teach step by step. Check what I already know, use examples, and ask a short question to confirm I understood.",
    look: { head: "wicket", palette: "original" },
  },
  {
    name: "Analyst",
    role: "Data analyst",
    instructions:
      "Analyze data and numbers. Show your method, state assumptions, and summarize the result in one or two sentences first.",
    look: { head: "spool", palette: "original" },
  },
];

/** The Create a bot sheet. Calls `created` with the new bot's id. */
export default function BotForm({
  created,
  fail,
  cancel,
  saved = [],
  agents: given,
  taken,
  start,
}: {
  created: (id: string) => void;
  fail: (e: unknown) => void;
  /** Closes the sheet without creating a bot. */
  cancel?: () => void;
  /** Templates the person saved or imported. */
  saved?: BotTemplate[];
  /** The person's existing agents, when the caller already has them. Otherwise the form looks them up. */
  agents?: ImportableAgent[];
  /** The looks of the bots there already are, so the new bot starts as a character few of them have. */
  taken?: (BotLook | undefined)[];
  /** An agent template from Marketplace › Agents to start from: the form opens filled in from it. */
  start?: MarketAgentTemplate;
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
  const [look, setLook] = useState<BotLook>(() => start?.look ?? freshLook(taken));
  const [studio, setStudio] = useState(false);
  const [template, setTemplate] = useState<Template>();
  const [mine, setMine] = useState<string>();
  /** The marketplace template the form was filled from, until another start is chosen. */
  const [market, setMarket] = useState(start);
  const [name, setName] = useState(start?.name ?? "");
  const [role, setRole] = useState(start?.role ?? "");
  const [summary, setSummary] = useState(start?.summary ?? "");
  const [instructions, setInstructions] = useState(start?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const chosen = saved.find((t) => t.id === mine);
  function use(t: Template) {
    setMarket(undefined);
    setTemplate(t);
    setMine(undefined);
    setAgentKey(undefined);
    setRole(t.role);
    setSummary("");
    setInstructions(t.instructions);
    setLook(t.look);
    setPicking(false);
  }
  function useAgent(a: ImportableAgent) {
    setMarket(undefined);
    setTemplate(undefined);
    setMine(undefined);
    setAgentKey(a.key);
    setName(a.name);
    setRole(a.role);
    setSummary(a.summary);
    setInstructions(a.instructions);
    setPicking(false);
  }
  function useMine(t: BotTemplate) {
    setMarket(undefined);
    setTemplate(undefined);
    setMine(t.id);
    setAgentKey(undefined);
    setName(t.name);
    setRole(t.role);
    setSummary(t.summary ?? "");
    setInstructions(t.instructions);
    if (t.look) setLook(t.look);
    setPicking(false);
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
  const current = template?.name ?? chosen?.name;
  return (
    <form
      className="botform"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const id = await window.botkins.addBot({
            name: name.trim(),
            role: role.trim(),
            instructions: instructions.trim(),
            look,
            ...(summary.trim() && { summary: summary.trim() }),
            ...(agent && { agent: agent.key }),
          });
          created(id);
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
          current={agent ? "Agent: " + agent.name : market ? "Marketplace: " + market.name : current && "Template: " + current}
          template={template}
          mine={mine}
          saved={saved}
          agents={agents}
          agentKey={agentKey}
          use={use}
          useMine={useMine}
          useAgent={useAgent}
          importOne={() => void importOne()}
          forget={(id) => {
            if (mine === id) setMine(undefined);
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
      <div className="botform-top">
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
            <input
              name="name"
              maxLength={48}
              required
              autoFocus
              placeholder={template?.name ?? "e.g. Nova"}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Role
            <input
              name="role"
              placeholder="e.g. Writing partner"
              maxLength={90}
              required
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
          </label>
        </div>
      </div>
      <label>
        <span>
          About <span className="optional">Optional</span>
        </span>
        <input
          name="summary"
          aria-label="About"
          maxLength={240}
          placeholder="A line about what this bot is for"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </label>
      <label>
        Instructions
        <textarea
          name="instructions"
          placeholder="How should this bot help? What should it always or never do?"
          rows={chosen || agent || market ? 6 : 5}
          required
          maxLength={30000}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      <footer className="botform-foot">
        {cancel && (
          <button type="button" className="set-button" onClick={cancel}>
            Cancel
          </button>
        )}
        <button className="set-button primary" disabled={busy}>
          <Plus size={15} />
          Create bot
        </button>
      </footer>
      {studio && (
        <BotStudio
          value={look}
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

/** "Start from a template": a popover with the built-ins, the person's own templates and Import…. */
function TemplateMenu({
  open,
  setOpen,
  current,
  template,
  mine,
  saved,
  agents,
  agentKey,
  use,
  useMine,
  useAgent,
  importOne,
  forget,
  exportOne,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  /** The trigger's label once something is chosen. */
  current?: string;
  template?: Template;
  mine?: string;
  saved: BotTemplate[];
  agents: ImportableAgent[];
  agentKey?: string;
  use: (t: Template) => void;
  useMine: (t: BotTemplate) => void;
  useAgent: (a: ImportableAgent) => void;
  importOne: () => void;
  forget: (id: string) => void;
  exportOne: (id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState("");
  useEffect(() => {
    if (!open) {
      setMenu("");
      return;
    }
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
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
            setOpen(false);
            box.current?.querySelector<HTMLElement>(".template-trigger")?.focus();
          }
        }
      }}
    >
      <button
        type="button"
        className="template-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <LayoutTemplate size={15} />
        {current || "Start from a template"}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="template-pop">
          <div className="template-section" role="group" aria-label="Built-in templates">
            <span className="template-heading">Built-in</span>
            {templates.map((t) => (
              <button
                type="button"
                key={t.name}
                className="template-item"
                aria-label={t.name}
                aria-pressed={template === t}
                onClick={() => use(t)}
              >
                <BotAvatar look={t.look} size={32} />
                <span>
                  <strong>{t.name}</strong>
                  <small>{t.role}</small>
                </span>
              </button>
            ))}
          </div>
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
          <div className="template-foot">
            <button type="button" className="set-button" onClick={importOne}>
              <Upload size={14} /> Import…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
