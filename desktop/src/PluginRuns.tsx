// What a plugin adds and starts, as it is shown before an install, an update or a switch-on, and on
// an installed plugin's page. Every field of the description is here, whole and as text (the rules
// and the words: src/pluginStarts.ts). Nothing of a command, an argument or a value is cut: a long
// one wraps, and a command of many lines scrolls in its own box.
import type { ReactNode } from "react";
import { Globe, KeyRound, ShieldAlert, Terminal, Zap } from "lucide-react";
import type { InstalledPlugin, PluginHook, PluginNamed, PluginNotSet, PluginPreview, PluginTool } from "./types";
import { Group } from "./SettingsRows";
import { decisionText, folderLine, hookWords, namedLine, notRunView, otherFilesView, timeLimit, toolWords, unmarkedLine, type Where } from "./pluginStarts";

/** What an app from before the rule could say of a description: true of what is shown, and no more. */
function oldWarnings(contents: PluginPreview["contents"]) {
  const warnings: string[] = [];
  if (contents.hooks.length) warnings.push("Runs a command on your computer through chat hooks.");
  if (contents.mcpServers.some((server) => server.kind === "local")) warnings.push("Runs a local tool on your computer.");
  return warnings;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Named({ label, list }: { label: string; list?: PluginNamed[] }) {
  if (!list?.length) return null;
  return (
    <Fact label={label}>
      {list.map((one, index) => (
        <code className="plugin-value" key={index}>
          {namedLine(one)}
        </code>
      ))}
    </Fact>
  );
}

function NotSet({ list }: { list?: PluginNotSet[] }) {
  if (!list?.length) return null;
  return (
    <Fact label="Not set by Botkins">
      {list.map((one, index) => (
        <span className="plugin-reason" key={index}>
          <code>{decisionText(one.name)}</code>
          <small>{one.why}</small>
        </span>
      ))}
    </Fact>
  );
}

function Tool({ tool, where, onSignIn }: { tool: PluginTool; where: Where; onSignIn?: (serverId: string) => void }) {
  const local = tool.kind === "local";
  return (
    <div className="plugin-run" role="group" aria-label={"Tool " + decisionText(tool.name)}>
      <div className="plugin-run-head">
        <span className="plugin-tool-icon" aria-hidden="true">
          {local ? <Terminal size={14} /> : <Globe size={14} />}
        </span>
        <b>{decisionText(tool.name)}</b>
        {!local && tool.oauth && tool.serverId && onSignIn && (
          <button type="button" className="set-link" onClick={() => onSignIn(tool.serverId!)}>
            <KeyRound size={13} /> Sign in
          </button>
        )}
      </div>
      {local ? (
        <dl className="plugin-facts">
          <Fact label="Runs">
            <code className="plugin-words">
              {toolWords(tool).map((word, index) => (
                <span key={index} className={word ? undefined : "empty"}>
                  {word || "“”"}
                </span>
              ))}
            </code>
          </Fact>
          {tool.cwd && (
            <Fact label="In folder">
              <code className="plugin-value">{folderLine(tool.cwd)}</code>
            </Fact>
          )}
          <Named label="Environment" list={tool.env} />
          <NotSet list={tool.envNotSet} />
        </dl>
      ) : (
        <dl className="plugin-facts">
          <Fact label="Connects to">
            <code className="plugin-value">{decisionText(tool.url ?? "") + (tool.type === "sse" ? " (stream)" : "")}</code>
          </Fact>
          <Named label="Sends headers" list={tool.headers} />
          {tool.oauth && (
            <Fact label={"Signs in on " + (where.name ? decisionText(where.name) : "this computer")}>
              {tool.oauthClientId ? <code className="plugin-value">{"Client id = " + decisionText(tool.oauthClientId)}</code> : <span className="plugin-plain">Yes</span>}
            </Fact>
          )}
        </dl>
      )}
    </div>
  );
}

function Hook({ hook }: { hook: PluginHook }) {
  return (
    <div className="plugin-run" role="group" aria-label={"Hook: " + hookWords(hook.event)}>
      <div className="plugin-run-head">
        <span className="plugin-tool-icon" aria-hidden="true">
          <Zap size={14} />
        </span>
        <b>{hookWords(hook.event)}</b>
      </div>
      <dl className="plugin-facts">
        <Fact label="Runs">
          {/* The whole command, never cut: it wraps, and a long one scrolls here. */}
          <pre className="plugin-command" tabIndex={0}>
            {decisionText(hook.command)}
          </pre>
        </Fact>
        {hook.timeoutSec != null && (
          <Fact label="Time limit">
            <span className="plugin-plain">{timeLimit(hook.timeoutSec)}</span>
          </Fact>
        )}
        <Named label="Environment" list={hook.env} />
        <NotSet list={hook.envNotSet} />
      </dl>
    </div>
  );
}

function Files({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null;
  return (
    <div className="set-row stacked plugin-content-list">
      <strong>{label}</strong>
      <ul>
        {values.map((value, index) => (
          <li key={index}>{decisionText(value)}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The whole description of a plugin. `where` is the computer in use. A description without the
 * mark `starts` may leave out a command that runs: on a computer from before the rule a line says
 * to update the app there, and the question before each step says the rest.
 */
export function PluginContentsView({
  plugin,
  where,
  onSignIn,
}: {
  plugin: Pick<PluginPreview | InstalledPlugin, "contents" | "warnings" | "starts">;
  where: Where;
  onSignIn?: (serverId: string) => void;
}) {
  const { contents } = plugin;
  // The computer's own sentences, as they come. Only a description without the mark gets the window's old ones.
  const warnings = plugin.warnings?.length ? plugin.warnings : plugin.starts === 1 ? [] : oldWarnings(contents);
  const older = plugin.starts === 1 ? "" : unmarkedLine(where);
  const other = otherFilesView(contents);
  const not = notRunView(contents);
  const nothing = !contents.skills.length && !contents.agents.length && !contents.commands.length && !contents.lspServers?.length && !contents.mcpServers.length && !contents.hooks.length;
  return (
    <Group title="What this plugin adds" footer="Review commands and tools before you turn a plugin on.">
      {older && (
        <div className="set-row plugin-warning">
          <ShieldAlert size={15} aria-hidden="true" />
          <small>{older}</small>
        </div>
      )}
      {warnings.map((warning) => (
        <div className="set-row plugin-warning" key={warning}>
          <ShieldAlert size={15} aria-hidden="true" />
          <small>{warning}</small>
        </div>
      ))}
      {nothing && (
        <div className="set-row">
          <small>This plugin adds no skills, tools or hooks.</small>
        </div>
      )}
      <Files label="Skills" values={contents.skills} />
      <Files label="Agents" values={contents.agents} />
      <Files label="Commands" values={contents.commands} />
      <Files label="Language servers" values={contents.lspServers ?? []} />
      {contents.mcpServers.length > 0 && (
        <div className="set-row stacked plugin-content-list">
          <strong>Tools</strong>
          {contents.mcpServers.map((tool, index) => (
            <Tool tool={tool} where={where} onSignIn={onSignIn} key={index} />
          ))}
        </div>
      )}
      {contents.hooks.length > 0 && (
        <div className="set-row stacked plugin-content-list">
          <strong>Hooks</strong>
          {contents.hooks.map((hook, index) => (
            <Hook hook={hook} key={index} />
          ))}
        </div>
      )}
      {not && (
        <div className="set-row stacked plugin-content-list">
          <strong>Not run</strong>
          {not.rows.map((row, index) => (
            <span className="plugin-reason" key={index}>
              <code>{row.name}</code>
              <small>{row.why}</small>
            </span>
          ))}
          {not.more && <small className="plugin-more">{not.more}</small>}
        </div>
      )}
      {other && (
        <div className="set-row stacked plugin-content-list">
          <strong>Other files</strong>
          <span className="plugin-plain">{other.line}</span>
          {other.read.length > 0 && (
            <>
              <small className="plugin-more">Files that tools read by themselves</small>
              <ul>
                {other.read.map((row, index) => (
                  <li key={index}>
                    <code>{row}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Group>
  );
}
