// The commands screen of the dashboard: what it reads from the command tree, and how a line of
// words becomes a command. Nothing here draws (cli/tui/view.mjs does) or reads a key (app.mjs does).
//
// The dashboard is a way in to the named commands, not a second copy of them. So the areas, their
// commands, the usage and the options all come from the tree (cli/commands/index.mjs): a command
// that is added there shows here with no change in this file.
import { argumentsOf } from "../commands/index.mjs";
import { ago } from "../output.mjs";
import { hasUnshown, shownText } from "../../desktop/shown-text.mjs";

/**
 * Words that the screen leaves out. `tui` is this screen. `serve` runs the service in the
 * foreground and ends the whole process when it stops, so it is not something to open from here.
 * A person can still type either in the command line.
 */
const LEFT_OUT = new Set(["tui", "serve"]);

/** The areas of the command line, in the order of the tree: [{ word, summary, command }]. */
export function areasOf(tree) {
  return Object.entries(tree)
    .filter(([word, command]) => !command.hidden && !LEFT_OUT.has(word))
    .map(([word, command]) => ({ word, summary: command.summary, command }));
}

/** The commands of an area, groups opened: [{ path, name, summary, command }]. `name` is the path without the area's word. */
export function leavesOf(area) {
  const walk = (command, path) => (command.commands ? Object.entries(command.commands).filter(([, sub]) => !sub.hidden).flatMap(([name, sub]) => walk(sub, [...path, name])) : [{ path, name: path.slice(1).join(" ") || path[0], summary: command.summary, command }]);
  return walk(area.command, [area.word]);
}

/** The words a command takes, as `help --json` says them. */
export const argsOf = (leaf) => leaf.command.arguments ?? argumentsOf(leaf.command.usage, leaf.path);

/** The command that lists the area's state: `list` or `tree`, as long as it needs no word. */
export function listOf(leaves) {
  for (const name of ["list", "tree"]) {
    const leaf = leaves.find((entry) => entry.path.length === 2 && entry.path[1] === name);
    if (leaf && !argsOf(leaf).some((arg) => arg.required)) return leaf;
  }
  return null;
}

/** What a row is called to a command: its name, else its path, its title, its id. Null when that text has a character that is not shown as it is. */
export function nameOf(row) {
  const value = [row?.name, row?.path, row?.title, row?.id].find((entry) => typeof entry === "string" && entry.trim());
  return value && !hasUnshown(value) ? value : null;
}

const WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** A word as it is typed in the line: as it is, or in double quotes. */
export const quote = (word) => (WORD.test(word) ? word : '"' + word.replace(/[\\"]/g, "\\$&") + '"');

/**
 * The line that a command starts with: its words, and the picked row's name when the command's first
 * word is a thing of the area (`<bot>`), not a new name. Options are never in it: a flag, `--yes` too, is the person's to type.
 */
export function startLine(leaf, row) {
  const first = argsOf(leaf)[0];
  const name = row && first?.required && first.name !== "name" ? nameOf(row) : null;
  return leaf.path.join(" ") + " " + (name ? quote(name) + " " : "");
}

/**
 * The words of a line, as a shell splits them but with nothing expanded: spaces separate, single
 * quotes keep everything, double quotes keep everything but \\ and \", a backslash makes the next
 * character plain. A leading `botkins` is dropped.
 * @returns { words } or { error }.
 */
export function splitLine(text) {
  const words = [];
  let word = null;
  let mode = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (mode === "'") {
      if (char === "'") mode = "";
      else word += char;
    } else if (mode === '"') {
      if (char === '"') mode = "";
      else if (char === "\\" && (text[index + 1] === '"' || text[index + 1] === "\\")) word += text[++index];
      else word += char;
    } else if (char === "'" || char === '"') {
      mode = char;
      word ??= "";
    } else if (char === "\\" && index + 1 < text.length) word = (word ?? "") + text[++index];
    else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? "") + char;
  }
  if (mode) return { error: "A quote in the line is not closed." };
  if (word !== null) words.push(word);
  if (words[0] === "botkins") words.shift();
  return words.length ? { words } : { error: "The line is empty." };
}

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const TIME = /(At|Time|Run|Seen)$/;
/** One cell of a row, as text made safe. */
export function cellOf(key, value, now) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return String(value.length);
  if (isObject(value)) return "";
  if (TIME.test(key) && ((typeof value === "number" && value > 1e11) || (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value)))) return ago(value, now);
  return shownText(String(value).replace(/\s+/g, " "));
}

/**
 * What a list command said (its --json document), as something to draw: the rows (the longest list of
 * objects in the document), the keys that have a column, and the other values as lines of text.
 * Every text is made safe. A column that holds only objects is left out; a list counts as its length.
 * @returns { rows: [object], keys: [string], extras: [[key, text]] }
 */
export function rowsOf(value, now = Date.now()) {
  let list = [];
  const extras = [];
  if (Array.isArray(value)) list = value;
  else if (isObject(value)) {
    let best = null;
    for (const [key, entry] of Object.entries(value)) if (Array.isArray(entry) && entry.length && entry.every(isObject) && (!best || entry.length > value[best].length)) best = key;
    for (const [key, entry] of Object.entries(value)) {
      if (key === best) continue;
      extras.push([shownText(key), Array.isArray(entry) ? entry.length + (entry.length === 1 ? " item" : " items") : isObject(entry) ? shownText(JSON.stringify(entry)) : cellOf(key, entry, now)]);
    }
    list = best ? value[best] : [];
  } else extras.push(["", cellOf("", value, now)]);
  const rows = list.map((row) => (isObject(row) ? row : { value: row }));
  const keys = [];
  for (const row of rows.slice(0, 50)) for (const key of Object.keys(row)) if (!keys.includes(key) && !isObject(row[key])) keys.push(key);
  // A random id is no help beside a name.
  const named = keys.some((key) => ["name", "title", "path"].includes(key));
  return { rows, keys: keys.filter((key) => !(named && key === "id")), extras };
}

/** A line being edited: { text, cursor }. Returns true when the key changed it. */
export function editLine(line, { name, ch, ctrl }) {
  const { text, cursor } = line;
  const set = (next, at) => ((line.text = next), (line.cursor = Math.max(0, Math.min(next.length, at))), true);
  if (ctrl) {
    if (name === "a") return set(text, 0);
    if (name === "e") return set(text, text.length);
    if (name === "u") return set(text.slice(cursor), 0);
    if (name === "k") return set(text.slice(0, cursor), cursor);
    if (name === "w") {
      const before = text.slice(0, cursor).replace(/\s*\S*$/, "");
      return set(before + text.slice(cursor), before.length);
    }
    return false;
  }
  if (name === "left") return set(text, cursor - 1);
  if (name === "right") return set(text, cursor + 1);
  if (name === "home") return set(text, 0);
  if (name === "end") return set(text, text.length);
  if (name === "backspace") return cursor ? set(text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1) : true;
  if (name === "delete") return set(text.slice(0, cursor) + text.slice(cursor + 1), cursor);
  if (ch && ch >= " " && ch !== "\u007f") return set(text.slice(0, cursor) + ch + text.slice(cursor), cursor + ch.length);
  return false;
}
