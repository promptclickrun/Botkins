// What the dashboard draws: the whole screen as lines of text, from what the service last said.
// Nothing here reads a key or writes to a terminal (cli/tui/app.mjs does), so the tests draw a
// screen of any size from a state of their own and read it.
import { stripVTControlCharacters } from "node:util";
import { shownText } from "../../desktop/shown-text.mjs";
import { ago, duration } from "../output.mjs";
import { argsOf, cellOf } from "./menu.mjs";

export const TABS = ["Overview", "Devices", "Bots", "Chats", "Routines", "Logs"];
/** What each tab's keys do, for the line at the bottom and the help. */
export const KEYS = {
  Overview: [["R", "relay on/off"], ["p", "pair a phone"]],
  Devices: [["p", "pair a phone"], ["r", "rename"], ["s", "set person"], ["x", "unpair"]],
  Bots: [["a", "add"], ["e", "edit"], ["m", "model"], ["c", "chat"], ["x", "remove"]],
  Chats: [["enter", "read"], ["c", "reply"], ["S", "stop"]],
  Routines: [["r", "run now"], ["space", "pause/resume"]],
  Logs: [["f", "follow on/off"], ["↑↓ PgUp PgDn", "scroll"]],
};
export const GLOBAL_KEYS = [["←→ or 1-6", "tabs"], ["↑↓", "select"], ["?", "help"], ["q", "quit"]];
/** The keys of the commands screen, for each of its levels. */
export const MENU_KEYS = {
  areas: [["enter", "open"], ["↑↓", "select"], ["esc", "back"], ["q", "quit"]],
  state: [["enter", "commands"], ["↑↓", "select"], ["r", "reload"], ["tab", "commands"], ["esc", "back"], ["q", "quit"]],
  commands: [["enter", "pick"], ["↑↓", "select"], ["tab", "state"], ["esc", "back"], ["q", "quit"]],
  command: [["enter", "run"], ["←→", "move"], ["^U", "clear"], ["esc", "back"]],
};
/** The key list of the commands screen as it is now. */
export const menuKeys = (menu) => MENU_KEYS[menu.level === "area" ? (menu.view === "commands" ? "commands" : "state") : menu.level];

const ESC = "\u001b[";
const style = (code) => (text, on = true) => (on ? ESC + code + "m" + text + ESC + "0m" : String(text));
export const paint = { on: true, bold: style("1"), dim: style("2"), invert: style("7"), green: style("32"), red: style("31"), yellow: style("33"), cyan: style("36") };
const plain = (colors) => (colors ? paint : { on: false, ...Object.fromEntries(Object.keys(paint).filter((name) => name !== "on").map((name) => [name, (text) => String(text)])) });

/** How many columns a text takes, without its colors. */
export const width = (text) => stripVTControlCharacters(String(text)).length;
/** A text cut to fit, with … when something was cut. Colors are dropped from a cut text. */
export function fit(text, columns) {
  const value = String(text).replace(/[\r\n\t]+/g, " ");
  if (columns <= 0) return "";
  if (width(value) <= columns) return value + " ".repeat(columns - width(value));
  const bare = stripVTControlCharacters(value);
  return bare.slice(0, Math.max(0, columns - 1)) + "…";
}
/** Rows as columns that share the width: the last column takes what is left. */
function columns(rows, total, { head, selected = -1, c, height }) {
  if (!rows.length && !head) return [];
  // Without colors the selected row cannot be inverted, so a mark in a gutter shows it.
  const gutter = !c.on && selected >= 0 ? 2 : 0;
  total -= gutter;
  const all = head ? [head, ...rows] : rows;
  const count = Math.max(...all.map((row) => row.length));
  const widths = [];
  let left = total;
  for (let column = 0; column < count; column++) {
    const wanted = Math.max(...all.map((row) => width(row[column] ?? ""))) + 2;
    const given = column === count - 1 ? left : Math.min(wanted, Math.max(6, Math.floor(total / 2)), left);
    widths.push(Math.max(0, given));
    left -= widths[column];
  }
  // A cell that is cut leaves two columns of room before the next one.
  const line = (row) => row.map((cell, column) => (column < count - 1 && width(cell ?? "") > widths[column] - 2 && widths[column] > 3 ? fit(fit(cell, widths[column] - 2), widths[column]) : fit(cell ?? "", widths[column]))).join("");
  const out = [];
  if (head) out.push(c.dim(" ".repeat(gutter) + line(head)));
  // With a height, a long list shows the part that holds the selected row.
  const room = height ? Math.max(1, height - out.length) : rows.length;
  const start = Math.max(0, Math.min(rows.length - room, selected - Math.floor(room / 2)));
  rows.forEach((row, index) => {
    if (index >= start && index < start + room) out.push(index === selected ? c.invert((gutter ? "> " : "") + line(row)) : " ".repeat(gutter) + line(row));
  });
  return out;
}

const tabLines = {
  Overview(state, size, c) {
    const { status, providers = [], runs = [], logs = [] } = state;
    if (!status) return [c.dim("Asking the service…")];
    const relay = !status.relay.enabled ? "off" : status.relay.connected ? c.green("connected") : c.yellow("on, not connected");
    const lines = columns(
      [
        ["Phone link", !status.link.enabled ? "off" : status.link.listening ? "“" + status.link.name + "” on port " + status.link.port + "  " + c.dim(status.link.addresses.join(", ")) : c.red("on, not listening")],
        ["Relay", relay],
        ["Devices", status.link.devices + " paired, " + status.link.connected + " connected" + (status.link.pairing ? "  (a pairing code is open)" : "")],
        ...(status.nodeHost?.enabled
          ? [
              ["Node host", "“" + status.nodeHost.name + "” · " + (status.nodeHost.paused ? c.yellow("Paused") : c.green("Online"))],
              ["Shared folders", status.nodeHost.sharedProjects?.length ? status.nodeHost.sharedProjects.map((project) => project.name).join(", ") : c.dim("none")],
              ["Last node job", status.nodeHost.lastCompleted ? status.nodeHost.lastCompleted.sourceBotName + " on " + status.nodeHost.lastCompleted.sourceHostName + " · " + status.nodeHost.lastCompleted.operation + " (" + status.nodeHost.lastCompleted.resourceName + ")  " + c.dim(ago(status.nodeHost.lastCompleted.at, state.now)) : c.dim("none yet")],
            ]
          : []),
        ["Workspace", status.workspace.bots + " bots, " + status.workspace.chats + " chats, " + status.workspace.routines + " routines" + (status.workspace.working ? ", " + c.cyan(status.workspace.working + " working") : "") + (status.workspace.waiting ? ", " + c.yellow(status.workspace.waiting + " waiting for an answer") : "")],
        ["Secrets", status.vault.locked ? c.red("vault locked") : "wrapped by the " + status.secrets.where],
        ["Memory", status.memory.rssMb + " MB"],
        ["Data folder", status.dataDir],
      ],
      size.width,
      { c },
    );
    lines.push("", c.bold("Model providers"));
    lines.push(...columns(providers.filter((entry) => entry.enabled).map((entry) => ["  " + entry.name, !entry.installed ? c.dim("not installed") : entry.connected ? c.green("signed in") : entry.error ? c.red("error") : c.yellow("signed out"), [entry.account, entry.plan].filter(Boolean).join(", ")]), size.width, { c }));
    if (!providers.some((entry) => entry.enabled && entry.connected)) lines.push(c.yellow("  No provider is signed in: run `botkins providers login <provider>`."));
    lines.push("", c.bold("Latest runs"));
    lines.push(...(runs.length ? columns(runs.slice(0, 5).map((run) => ["  " + (run.bot ?? ""), runStatus(run.status, c), run.title, ago(run.time, state.now)]), size.width, { c }) : [c.dim("  Nothing has run yet.")]));
    lines.push("", c.bold("Log"));
    lines.push(...logs.slice(-Math.max(3, size.height - lines.length - 1)).map((entry) => logLine(entry, size.width, c)));
    return lines;
  },
  Devices(state, size, c) {
    const devices = state.devices ?? [];
    if (!devices.length) return [c.dim("No device is paired. Press p to show a pairing code.")];
    return columns(devices.map((device) => [device.name, device.person ?? "", device.kind, device.platform, device.connected ? c.green("connected") : "last seen " + ago(device.lastSeenAt, state.now)]), size.width, { head: ["NAME", "PERSON", "KIND", "PLATFORM", "STATE"], selected: state.selected, c });
  },
  Bots(state, size, c) {
    const bots = state.bots ?? [];
    if (!bots.length) return [c.dim("There are no bots yet. Press a to add one.")];
    return columns(bots.map((bot) => [bot.name + (bot.working ? c.cyan(" (working)") : ""), bot.role, bot.model ? (bot.model.provider ? bot.model.provider + "/" : "") + bot.model.model : "default", String(bot.chats)]), size.width, { head: ["NAME", "ROLE", "MODEL", "CHATS"], selected: state.selected, c });
  },
  Chats(state, size, c) {
    const chats = state.chats ?? [];
    if (state.reading) {
      const { reading } = state;
      const lines = [c.bold(reading.title) + c.dim("  (esc to go back, c to reply)"), ""];
      const body = [];
      for (const message of reading.messages) {
        const who = message.role === "user" ? c.cyan("you") : c.green(reading.bot ?? "bot");
        const text = String(message.text ?? "").split("\n");
        text.forEach((part, index) => body.push((index ? "     " : fit(who, 4) + " ") + part));
        body.push("");
      }
      if (reading.working) body.push(c.green(reading.bot ?? "bot") + "  " + (reading.stream || c.dim("working…")));
      const wrapped = body.flatMap((line) => wrap(line, size.width));
      return [...lines, ...wrapped.slice(-Math.max(1, size.height - 2))];
    }
    if (!chats.length) return [c.dim("There are no chats yet. Start one from the Bots tab (c), or with `botkins chat <bot>`.")];
    return columns(chats.map((chat) => [chat.title, chat.bot ?? "", String(chat.messages), chat.working ? c.cyan("working") : ""]), size.width, { head: ["CHAT", "BOT", "MESSAGES", ""], selected: state.selected, c });
  },
  Routines(state, size, c) {
    const routines = state.routines ?? [];
    if (!routines.length) return [c.dim("There are no routines. A bot makes one when you ask it to do something on a schedule.")];
    return columns(routines.map((entry) => [entry.name, entry.bot ?? "", entry.cadence, entry.running ? c.cyan("running") : entry.finished ? "finished" : entry.enabled ? c.green("on") : c.yellow("paused"), entry.nextRun ? ago(entry.nextRun, state.now) : ""]), size.width, { head: ["ROUTINE", "BOT", "WHEN", "STATE", "NEXT RUN"], selected: state.selected, c });
  },
  Logs(state, size, c) {
    const logs = state.logs ?? [];
    if (!logs.length) return [c.dim("The log is empty.")];
    const end = state.follow === false ? Math.max(size.height, logs.length - (state.scroll ?? 0)) : logs.length;
    return logs.slice(Math.max(0, end - size.height), end).map((entry) => logLine(entry, size.width, c));
  },
};
const runStatus = (status, c) => (status === "Completed" ? c.green(status) : status === "Working" ? c.cyan(status) : status === "Stopped" ? c.dim(status) : c.red(status));
const logLine = (entry, total, c) => fit(c.dim(String(entry.time).slice(11, 19)) + " " + (entry.level === "error" ? c.red("error ") : "") + entry.text, total);
/** The commands screen: the areas of the command line, one area with its state and its commands, one command with its line. */
function menuLines(menu, room, c, now) {
  if (menu.level === "areas") return [c.bold("Commands") + c.dim("  each area of the command line; enter opens one"), ...columns(menu.areas.map((area) => [area.word, area.summary]), room.width, { selected: menu.selected, c, height: room.height - 1 })];
  const area = menu.areas.find((entry) => entry.word === menu.word);
  const head = c.bold(area.word) + "  " + area.summary;
  if (menu.level === "area") {
    const views = [["State" + (menu.list ? " (botkins " + menu.list.path.join(" ") + ")" : ""), "state"], ["Commands", "commands"]].map(([name, view]) => (menu.view === view ? c.invert(c.on ? " " + name + " " : "[" + name + "]") : " " + name + " ")).join("");
    const top = [head, views];
    const height = room.height - top.length;
    if (menu.view === "commands") return [...top, ...columns(menu.leaves.map((leaf) => [leaf.name, leaf.summary]), room.width, { selected: menu.picked, c, height })];
    const { data } = menu;
    if (!menu.list) return [...top, c.dim("This area has no list of its own. Press tab to see its commands.")];
    if (!data || data.loading) return [...top, c.dim("Asking the service…")];
    if (data.error) return [...top, c.red(shownText(data.error))];
    const extras = data.extras.map(([key, text]) => c.dim(key ? key + "  " : "") + text);
    if (!data.rows.length) return [...top, ...extras, c.dim("Nothing is here yet.")];
    // As many columns as fit: each is as wide as its longest cell, up to 28, and the last takes the rest.
    const shown = [];
    let used = 0;
    for (const key of data.keys) {
      const wide = Math.min(28, Math.max(key.length, ...data.rows.map((row) => cellOf(key, row[key], now).length))) + 2;
      if (shown.length && used + wide > room.width - 2) break;
      shown.push(key);
      used += wide;
    }
    return [...top, ...extras, ...columns(data.rows.map((row) => shown.map((key) => cellOf(key, row[key], now))), room.width, { head: shown.map((key) => key.toUpperCase()), selected: menu.row, c, height: height - extras.length })];
  }
  // One command: what it is, then the line to run, with the cursor in it.
  const { leaf, line } = menu;
  const { command } = leaf;
  const info = [c.bold("botkins " + leaf.path.join(" ")) + "  " + command.summary, "", ...wrap("Usage: " + (command.usage ?? "botkins " + leaf.path.join(" ")), room.width)];
  const asks = command.asks ?? (command.options?.yes ? "--yes" : "");
  if (asks) info.push("", c.yellow("It asks first. Its question comes on this terminal, and you answer it."));
  const options = Object.entries(command.options ?? {});
  if (options.length) {
    info.push("", c.bold("Options"));
    for (const [name, spec] of options) info.push(...wrap("  --" + name + (spec.type === "string" ? " <" + (spec.value ?? "value") + ">" : "") + "  " + (spec.about ?? ""), room.width));
  }
  if (command.details) info.push("", ...String(command.details).split("\n").flatMap((part) => wrap(part, room.width)));
  const rows = room.height - 3;
  const out = info.length > rows ? [...info.slice(0, rows - 1), c.dim("… more with `botkins help " + leaf.path.join(" ") + "`")] : info;
  while (out.length < rows) out.push("");
  out.push(menu.last ? c.dim("Last run: " + shownText(menu.last.words) + " ended with exit code " + menu.last.exit + ".") : "");
  const prefix = "botkins ";
  const space = Math.max(5, room.width - prefix.length - 1);
  // The part of the line that holds the cursor, when the line is longer than the screen.
  const from = Math.max(0, Math.min(line.cursor - space + 1, line.text.length - space + 1));
  const text = shownText(line.text.slice(from, from + space));
  const at = line.cursor - from;
  // With no colors, a bar marks the cursor.
  const typed = c.on ? text.slice(0, at) + c.invert(text[at] ?? " ") + text.slice(at + 1) : text.slice(0, at) + "|" + text.slice(at);
  out.push(c.bold(prefix) + typed);
  return out;
}

/** A long line as several, cut at spaces where it can be. */
export function wrap(line, total) {
  if (width(line) <= total || total < 8) return [line];
  const out = [];
  let rest = stripVTControlCharacters(line);
  while (rest.length > total) {
    let at = rest.lastIndexOf(" ", total);
    if (at < total / 2) at = total;
    out.push(rest.slice(0, at));
    rest = "     " + rest.slice(at).trimStart();
  }
  out.push(rest);
  return out;
}

/**
 * The whole screen.
 * @param state  { tab, selected, status, providers, devices, bots, chats, routines, runs, logs,
 *                 follow, scroll, reading, message, error, prompt, overlay, help, now }
 * @param size   { width, height } of the terminal.
 * @returns the lines, exactly `height` of them, each exactly `width` columns.
 */
export function render(state, size, { colors = true } = {}) {
  const c = plain(colors);
  const columnsWide = Math.max(20, size.width);
  const rows = Math.max(8, size.height);
  const { status } = state;
  const title = status ? c.bold("Botkins " + status.version) + "  " + status.link.name + "  " + c.green("running") + " " + duration(status.uptimeSeconds) + "  " + status.memory.rssMb + " MB" : state.offline ? c.bold("Botkins") + "  " + c.red("not running") : c.bold("Botkins");
  const tabs = TABS.map((name, index) => (name === state.tab && !state.menu ? c.invert(" " + (index + 1) + " " + name + " ") : " " + (index + 1) + " " + name + " ")).join("") + (state.menu ? c.invert(" : Commands ") : c.dim("  : commands"));
  const top = [fit(title, columnsWide), fit(tabs, columnsWide), c.dim("─".repeat(columnsWide))];
  // The bottom: a question being answered, else what just happened, and the keys.
  const keys = (state.menu ? menuKeys(state.menu) : [...(KEYS[state.tab] ?? []), ...GLOBAL_KEYS]).map(([key, what]) => c.bold(key) + " " + what).join("  ");
  const note = state.prompt ? c.bold(state.prompt.question + " ") + state.prompt.value + c.invert(" ") : state.error ? c.red(state.error) : state.message ? c.green(state.message) : "";
  const bottom = [c.dim("─".repeat(columnsWide)), fit(note, columnsWide), fit(keys, columnsWide)];
  const room = { width: columnsWide, height: rows - top.length - bottom.length };
  let body;
  if (state.menu && !state.help) body = menuLines(state.menu, room, c, state.now);
  else if (state.offline) body = ["", "Botkins is not running on this data folder.", "", "Start it with `botkins service start`, or `botkins serve` in another terminal.", c.dim("This screen comes back by itself when the service answers.")];
  else if (state.help)
    // One line for each tab, so the whole list fits a small terminal.
    body = [c.bold("Keys"), "", ...Object.entries(KEYS).map(([tab, list]) => fit(tab, 11) + list.map(([key, what]) => c.bold(key) + " " + what).join("   ")), "", fit("Everywhere", 11) + [...GLOBAL_KEYS, [":", "commands: every command of the command line"], ["esc", "back, or cancel a question"]].map(([key, what]) => c.bold(key) + " " + what).join("   ")].flatMap((line) => wrap(line, columnsWide));
  else if (state.overlay) body = state.overlay.lines;
  else body = tabLines[state.tab](state, room, c);
  const shown = body.slice(0, room.height).map((line) => fit(line, columnsWide));
  while (shown.length < room.height) shown.push(" ".repeat(columnsWide));
  return [...top, ...shown, ...bottom];
}
