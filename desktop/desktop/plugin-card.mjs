// The text of the card that a person reads before a bot's plugin change is applied.
//
// The card is built from the whole description of the plugin (what ws.plugins.preview or
// ws.plugins.list gives), so a person who says yes has seen what the plugin starts, where it
// sends their settings, what it does not run, and which of its other files could change that.
// Every piece of text that comes from the plugin goes through shownText (shown-text.mjs): a
// character that hides or turns text is written as its number, so a line cannot look like
// another line.
//
// Nothing that decides what a plugin does is ever shortened: a command, an argument, a folder, an
// address, a value, a default and every name are shown whole. Only free text that decides nothing
// (a "why" sentence, a warning) is cut, and the cut is marked outside any quotes. When the card
// still cannot show the whole description (it would need more lines than the limit, or the
// description itself holds less than it counts), `whole` is false and the caller must not offer
// a yes on it.
import { shownText } from "./shown-text.mjs";

const LINE_LIMIT = 4200;
const TEXT_LIMIT = 1000;
const LINES_LIMIT = 400;
const CONFIG_ROWS = 12;
const MORE_LINE = "and more: look at the plugin in Settings";

const list = (value) => (Array.isArray(value) ? value : []);
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

// Text from the plugin, made safe and never cut.
const safe = (value) => shownText(value ?? "");

// Text from the plugin, made safe and cut at the limit, for text that decides nothing or that is
// shown outside the card. The cut never leaves half of a written number, and it never splits a
// pair of surrogates. `mark` is false for a name, which a person sees whole in the card.
export const shownCut = (value, limit, mark = true) => {
  const text = shownText(value ?? "");
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit).replace(/\\(?:u(?:\{[0-9a-f]*)?)?$/, "");
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return mark ? cut + " …" : cut;
};
const free = (value) => shownCut(value, TEXT_LIMIT);

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
      ? "      not set by Botkins: " + safe(row.name) + " (" + free(row.why) + ")"
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

const NAMES_LIMIT = 30;
const SERVERS_LIMIT = 20;

// The name a person knows a file of the plugin by: a skill is its folder, an agent or a command is
// its file. `null` is a file that is not the named kind (a script or a paper of a skill).
const skillName = (path) => (/(?:^|\/)SKILL\.md$/.test(path) ? path.replace(/^skills\//, "").replace(/\/?SKILL\.md$/, "") || null : null);
const markdownName = (folder) => (path) => (/\.md$/.test(path) ? path.replace(new RegExp("^" + folder + "/"), "") : null);

// How many of the files are the named kind: a skill is one SKILL.md, not each script or paper beside it.
const countNamed = (paths, pick) => list(paths).filter((path) => pick(String(path ?? "")) != null).length;

// The names of one kind of file, and a count of the files that are not named. These lines only
// tell a person what the files are called: a name decides nothing that the plugin starts (that is
// in the lines about hooks and tools). So a cut list does not make the card not whole.
const nameLines = (title, kind, paths, pick) => {
  const files = paths.map((path) => String(path ?? ""));
  const names = files.map(pick).filter((name) => name != null);
  const others = files.length - names.length;
  if (!names.length && !others) return [];
  const out = [title + ":"];
  for (const name of names.slice(0, NAMES_LIMIT)) out.push("  " + safe(name));
  if (names.length > NAMES_LIMIT) out.push("  and " + (names.length - NAMES_LIMIT) + " more");
  if (others) out.push("  and " + plural(others, "other file", "other files") + " of these " + kind);
  return out;
};

/**
 * The card, built only from the description: its lines, and whether they are the whole of it.
 * `bots` is the text for the bots line, `action` is the bot's request, `id` is the plugin's id
 * when the description does not hold it.
 */
export function pluginCard(plugin, { bots, action, id } = {}) {
  const card = plugin ?? {};
  const contents = card.contents ?? {};
  const hooks = list(contents.hooks);
  const servers = list(contents.mcpServers);
  const local = servers.filter((s) => !isRemote(s));
  const remote = servers.filter(isRemote);
  const lines = [];
  let complete = true;

  if (action === "update") lines.push("After this update:");
  lines.push("Plugin: " + [safe(card.name), card.version != null ? safe(card.version) : null].filter((x) => x != null && x !== "").join(" ") + " (" + safe(id ?? card.id) + ")");
  lines.push("Bots: " + safe(String(bots ?? "").replace(/[\r\n\u2028\u2029]+/g, " ")));
  if (card.revision != null) lines.push("Revision: " + safe(card.revision));
  lines.push(
    "Holds: " +
      [
        plural(countNamed(contents.skills, skillName), "skill", "skills"),
        plural(countNamed(contents.agents, markdownName("agents")), "agent", "agents"),
        plural(countNamed(contents.commands, markdownName("commands")), "command", "commands"),
      ].join(", ") +
      ".",
  );
  lines.push(...nameLines("Skills", "skills", list(contents.skills), skillName));
  lines.push(...nameLines("Agents", "agents", list(contents.agents), markdownName("agents")));
  lines.push(...nameLines("Commands", "commands", list(contents.commands), markdownName("commands")));

  // Botkins starts nothing from these, so a cut list loses nothing that runs.
  const lsp = list(contents.lspServers);
  if (lsp.length) {
    const shown = lsp.slice(0, SERVERS_LIMIT).map((name) => safe(nameOf(name)));
    lines.push("Language servers (Botkins starts none of them): " + shown.join(", ") + (lsp.length > SERVERS_LIMIT ? ", and " + (lsp.length - SERVERS_LIMIT) + " more" : ""));
  }

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

  // The host puts these two under contents; a bare description may hold them at the top.
  const notRun = contents.notRun ?? card.notRun;
  const rows = list(Array.isArray(notRun) ? notRun : notRun?.items);
  const notRunCount = Array.isArray(notRun) ? rows.length : Math.max(Number(notRun?.count) || 0, rows.length);
  if (notRunCount > 0) {
    lines.push("Not run by Botkins:");
    for (const row of rows) lines.push("  " + safe(row.what) + " " + safe(row.name) + ": " + free(row.why));
    if (notRunCount > rows.length) {
      lines.push("  and " + (notRunCount - rows.length) + " more");
      complete = false;
    }
  }

  const other = contents.otherFiles ?? card.otherFiles;
  if (other && Number(other.count) > 0) {
    lines.push("Other files of the plugin: " + plural(Number(other.count), "file", "files") + ", " + plural(Number(other.bytes) || 0, "byte", "bytes") + ".");
    const marked = list(other.files).filter((f) => f && f.config);
    const shown = marked.slice(0, CONFIG_ROWS);
    if (marked.length > shown.length) complete = false;
    for (const file of shown) lines.push("  " + safe(file.path) + (file.files != null ? " (" + plural(Number(file.files) || 0, "file", "files") + ")" : ""));
    const covered = shown.reduce((sum, f) => sum + (f.files != null ? Number(f.files) || 0 : 1), 0);
    if (shown.length && Number(other.count) > covered) lines.push("  and " + (Number(other.count) - covered) + " more");
    if (hooks.length || local.length) lines.push("A command runs with these files, and Botkins cannot show all that they make it do.");
  }

  for (const note of list(card.warnings)) lines.push("Note: " + free(note));

  const out = lines.flatMap(wrapped);
  if (out.length <= LINES_LIMIT) return { lines: out, whole: complete };
  return { lines: [...out.slice(0, LINES_LIMIT - 1), MORE_LINE], whole: false };
}

/** The lines of the card, for a caller that does not ask whether they are the whole. */
export const pluginCardLines = (plugin, options) => pluginCard(plugin, options).lines;
