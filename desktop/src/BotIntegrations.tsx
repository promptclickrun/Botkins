import { useState } from "react";
import { Search } from "lucide-react";
import type { Bot, State } from "./types";
import { Group, SwitchRow, errorText } from "./SettingsRows";
import { skillOrigin, useSkills } from "./SkillsSettings";
import { serverSummary } from "./McpSettings";
import "./integrations.css";

const api = window.botkins;

/** Bots & capabilities › Capabilities: the skills and MCP servers from Settings this bot leaves out, and Teamwork. */
export default function BotIntegrations({
  state,
  bot,
  teamworkOn,
  go,
}: {
  state: State;
  bot: Bot;
  /** Settings › Teamwork's main switch. */
  teamworkOn: boolean;
  /** Opens another Settings section. */
  go: (section: "skills" | "mcp" | "teamwork") => void;
}) {
  const { list } = useSkills(JSON.stringify(state.skills ?? null));
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const skillsOff = bot.skillsOff ?? [];
  const mcpOff = bot.mcpOff ?? [];
  // A script command is typed by the person; it is no skill that a bot has or leaves out.
  const named = (list?.skills ?? []).filter((s) => !s.command);
  const skills = named.filter((s) => s.enabled);
  const servers = (state.mcpServers ?? []).filter((s) => s.enabled);
  const hidden = named.length - skills.length + (state.mcpServers ?? []).length - servers.length;
  const q = query.trim().toLowerCase();
  const match = (text: string) => !q || text.toLowerCase().includes(q);
  const save = (patch: { skillsOff?: string[]; mcpOff?: string[] }) => {
    setError("");
    void api.setBotIntegrations(bot.id, patch).catch((e) => setError(errorText(e)));
  };
  const flip = (list: string[], item: string, on: boolean) => (on ? list.filter((x) => x !== item) : [...new Set([...list, item])]);
  const shownSkills = skills.filter((s) => match(s.name + " " + s.description));
  const shownServers = servers.filter((s) => match(s.name + " " + serverSummary(s)));
  return (
    <>
      <section className="set-group">
        <div className="int-grouphead">
          <h3>Skills and MCP servers</h3>
          <span>
            <button type="button" className="set-link" onClick={() => go("skills")}>
              Manage skills
            </button>
            <button type="button" className="set-link" onClick={() => go("mcp")}>
              Manage MCP servers
            </button>
          </span>
        </div>
        <div className="set-card">
          <div className="set-row int-intro">
            <small>
              Every bot uses the skills and MCP servers from Settings. Turn off what {bot.name} shouldn't use.
            </small>
            {skills.length + servers.length > 8 && (
              <label className="int-filter compact">
                <Search size={13} aria-hidden="true" />
                <input type="search" aria-label="Filter skills and servers" placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
            )}
          </div>
          <div className="int-subhead">Skills</div>
          {!list ? (
            <div className="set-row">
              <small>Loading…</small>
            </div>
          ) : !skills.length ? (
            <div className="set-row">
              <small>No skills are on in Settings.</small>
            </div>
          ) : (
            shownSkills.map((s) => (
              <div className="set-row int-item compact" key={s.name}>
                <div className="set-label">
                  <span className="int-title">
                    <span className="set-name">{s.name}</span>
                    <span className="int-origin">{skillOrigin(s, list)}</span>
                  </span>
                  {s.description && <small className="int-line" title={s.description}>{s.description}</small>}
                </div>
                <div className="set-control">
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch set-switch"
                    aria-label={"Skill " + s.name}
                    checked={!skillsOff.includes(s.name)}
                    onChange={(e) => save({ skillsOff: flip(skillsOff, s.name, e.target.checked) })}
                  />
                </div>
              </div>
            ))
          )}
          <div className="int-subhead">MCP servers</div>
          {!servers.length ? (
            <div className="set-row">
              <small>
                No MCP servers are on in Settings.{" "}
                <button type="button" className="set-link" onClick={() => go("mcp")}>
                  Add one
                </button>
              </small>
            </div>
          ) : (
            shownServers.map((s) => (
              <div className="set-row int-item compact" key={s.id}>
                <div className="set-label">
                  <span className="set-name">{s.name}</span>
                  <small className="int-mono int-line" title={serverSummary(s)}>
                    {serverSummary(s)}
                  </small>
                </div>
                <div className="set-control">
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch set-switch"
                    aria-label={"MCP server " + s.name}
                    checked={!mcpOff.includes(s.id)}
                    onChange={(e) => save({ mcpOff: flip(mcpOff, s.id, e.target.checked) })}
                  />
                </div>
              </div>
            ))
          )}
          {q && !shownSkills.length && !shownServers.length && (
            <div className="set-row">
              <small>Nothing matches “{query.trim()}”.</small>
            </div>
          )}
        </div>
        {hidden > 0 && (
          <p className="set-foot">
            {hidden === 1 ? "1 more is" : hidden + " more are"} switched off in Settings for every bot.
          </p>
        )}
      </section>
      {error && (
        <p className="set-status error-text" role="alert">
          {error}
        </p>
      )}
      <Group
        title="Teamwork"
        footer={
          teamworkOn ? (
            bot.teamwork !== false ? (
              bot.name + " can ask other bots for help, and they can ask " + bot.name + "."
            ) : (
              bot.name + " neither asks other bots for help nor is asked."
            )
          ) : (
            <>
              Teamwork is off for every bot.{" "}
              <button type="button" className="set-link" onClick={() => go("teamwork")}>
                Open Teamwork
              </button>
            </>
          )
        }
      >
        <SwitchRow
          label="Takes part in Teamwork"
          checked={bot.teamwork !== false}
          disabled={!teamworkOn}
          onChange={(on) => void api.setBotFlags(bot.id, { teamwork: on }).catch((e) => setError(errorText(e)))}
        />
      </Group>
    </>
  );
}
