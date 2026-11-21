// The text of the card that a person reads before a bot's plugin change is applied.
//
// The card is built from the whole description of the plugin (what ws.plugins.preview or
// ws.plugins.list gives), so a person who says yes has seen what the plugin starts, where it
// sends their settings, what it does not run, and which of its other files could change that.
// Every piece of text that comes from the plugin goes through shownText (shown-text.mjs): a
// character that hides or turns text is written as its number, so a line cannot look like
// another line.
import { shownText } from "./shown-text.mjs";

const LINE_LIMIT = 4200;
const TEXT_LIMIT = 1000;
const LINES_LIMIT = 400;
const CONFIG_ROWS = 12;
const MORE_LINE = "and more: look at the plugin in Settings";

const list = (value) => (Array.isArray(value) ? value : []);
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

// Text from the plugin, made safe and cut at the limit. The cut never leaves half of a written
// number, and it never splits a pair of surrogates.
const safe = (value, limit = TEXT_LIMIT) => {
  const text = shownText(value ?? "");
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit).replace(/\\(?:u(?:\{[0-9a-f]*)?)?$/, "");
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + " …";
};

// A command, an argument, an address or a folder is never cut: a person must see all of it. The
// host bounds them already, and a line that is still too long is carried on in the next line.
const whole = (value) => shownText(value ?? "");

// A value that needs quoting is shown as a JSON string of the safe text. Quotes and backslashes
// inside it are written out, so a value cannot end its own quotes.
const quoted = (text) => JSON.stringify(text);
const word = (value) => {
  const text = whole(value);
  return text !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : quoted(text);
};
const written = (value) => quoted(safe(value));

const isFullPath = (path) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path);

const nameOf = (item) => (item && typeof item === "object" ? item.name : item);

const environment = (rows, notSet) => [
  ...list(rows).map((row) =>
    row && typeof row === "object"
      ? "      with " + safe(row.name) + "=" + written(row.value)
      : "      with " + safe(row),
  ),
  ...list(notSet).map((row) =>
    row && typeof row === "object" && row.why != null
      ? "      not set by Botkins: " + safe(row.name) + " (" + safe(row.why) + ")"
      : "      not set by Botkins: " + safe(nameOf(row)),
  ),
];

const place = (to) => {
  if (to && to.hook != null) return "the environment value " + safe(to.env) + " of the hook at " + safe(to.hook);
  if (to && to.header != null) return "the header " + safe(to.header) + " of the tool " + safe(to.tool) + " at " + whole(to.url);
  return "the environment value " + safe(to?.env) + " of the tool " + safe(to?.tool);
};

const setting = (field) => {
  const flags = (field.required ? " (needed)" : "") + (field.secret ? " (secret)" : "");
  const to = list(field.sentTo);
  const parts = [to.length ? "goes to " + to.map(place).join("; ") : "goes to no tool and no hook of the plugin"];
  if (!field.secret && field.default != null) parts.push("default " + written(field.default));
  return "  " + safe(field.key) + flags + ": " + parts.join("; ");
};

const isRemote = (server) => server.kind === "remote" || (server.kind == null && server.url != null && server.command == null);

// A line over the limit is carried on in the next lines, so that nothing in it is cut.
const wrapped = (line) => {
  if (line.length <= LINE_LIMIT) return [line];
  const out = [];
  let rest = line;
  while (rest.length > LINE_LIMIT) {
    let at = LINE_LIMIT - 20;
    if (/[\ud800-\udbff]/.test(rest[at - 1])) at -= 1;
    out.push(rest.slice(0, at));
    rest = "      (continued) " + rest.slice(at);
  }
  out.push(rest);
  return out;
};

/**
 * The lines of the card, built only from the description. `bots` is the text for the bots line,
 * `action` is the bot's request, `id` is the plugin's id when the description does not hold it.
 */
export function pluginCardLines(plugin, { bots, action, id } = {}) {
  const card = plugin ?? {};
  const contents = card.contents ?? {};
  const hooks = list(contents.hooks);
  const servers = list(contents.mcpServers);
  const local = servers.filter((s) => !isRemote(s));
  const remote = servers.filter(isRemote);
  const lines = [];

  if (action === "update") lines.push("After this update:");
  lines.push("Plugin: " + [safe(card.name), card.version != null ? safe(card.version) : null].filter((x) => x != null && x !== "").join(" ") + " (" + safe(id ?? card.id) + ")");
  lines.push("Bots: " + safe(String(bots ?? "").replace(/[\r\n\u2028\u2029]+/g, " ")));
  if (card.revision != null) lines.push("Revision: " + safe(card.revision));
  lines.push(
    "Holds: " +
      [
        plural(list(contents.skills).length, "skill", "skills"),
        plural(list(contents.agents).length, "agent", "agents"),
        plural(list(contents.commands).length, "command", "commands"),
      ].join(", ") +
      ".",
  );

  if (hooks.length || local.length) {
    lines.push("Runs on this computer:");
    for (const hook of hooks) {
      lines.push("  at " + safe(hook.event) + ": " + whole(hook.command));
      if (hook.timeoutSec != null) lines.push("      for at most " + plural(Number(hook.timeoutSec) || 0, "second", "seconds"));
      lines.push(...environment(hook.env, hook.envNotSet));
    }
    for (const tool of local) {
      lines.push("  the tool " + safe(tool.name) + ": " + [tool.command, ...list(tool.args)].map(word).join(" "));
      if (tool.cwd != null) {
        const cwd = String(tool.cwd);
        lines.push("      in the folder " + quoted(whole(cwd)) + (isFullPath(cwd) ? "" : " of the plugin's own copy"));
      }
      lines.push(...environment(tool.env, tool.envNotSet));
    }
  } else {
    lines.push("Runs nothing on this computer.");
  }

  if (remote.length) {
    lines.push("Reaches on the web:");
    for (const tool of remote) {
      lines.push("  the tool " + safe(tool.name) + ": " + whole(tool.url) + (tool.type === "sse" ? ", as a stream (sse)" : ""));
      for (const header of list(tool.headers))
        lines.push(
          header && typeof header === "object"
            ? "      with the header " + safe(header.name) + "=" + written(header.value)
            : "      with the header " + safe(header),
        );
      if (tool.oauth || tool.oauthClientId != null)
        lines.push("      signs in" + (tool.oauthClientId != null ? ", client id " + safe(tool.oauthClientId) : ""));
    }
  }

  const config = list(card.config);
  if (config.length) {
    lines.push("Settings:");
    for (const field of config) lines.push(setting(field));
  }

  const notRun = card.notRun;
  const rows = list(Array.isArray(notRun) ? notRun : notRun?.items);
  const notRunCount = Array.isArray(notRun) ? rows.length : Math.max(Number(notRun?.count) || 0, rows.length);
  if (notRunCount > 0) {
    lines.push("Not run by Botkins:");
    for (const row of rows) lines.push("  " + safe(row.what) + " " + safe(row.name) + ": " + safe(row.why));
    if (notRunCount > rows.length) lines.push("  and " + (notRunCount - rows.length) + " more");
  }

  const other = card.otherFiles;
  if (other && Number(other.count) > 0) {
    lines.push("Other files of the plugin: " + plural(Number(other.count), "file", "files") + ", " + plural(Number(other.bytes) || 0, "byte", "bytes") + ".");
    const marked = list(other.files).filter((f) => f && f.config);
    const shown = marked.slice(0, CONFIG_ROWS);
    for (const file of shown) lines.push("  " + safe(file.path) + (file.files != null ? " (" + plural(Number(file.files) || 0, "file", "files") + ")" : ""));
    const covered = shown.reduce((sum, f) => sum + (f.files != null ? Number(f.files) || 0 : 1), 0);
    if (shown.length && Number(other.count) > covered) lines.push("  and " + (Number(other.count) - covered) + " more");
    if (hooks.length || local.length) lines.push("A command runs with these files, and Botkins cannot show all that they make it do.");
  }

  for (const note of list(card.warnings)) lines.push("Note: " + safe(note));

  const out = lines.flatMap(wrapped);
  return out.length > LINES_LIMIT ? [...out.slice(0, LINES_LIMIT - 1), MORE_LINE] : out;
}
