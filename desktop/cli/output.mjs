// What the command line prints: one JSON document with --json, plain text for a person otherwise.
import { stripVTControlCharacters } from "node:util";

/** Exit codes a script can test. */
export const EXIT = { ok: 0, failed: 1, usage: 2, notRunning: 3, denied: 4 };

/** An error with the exit code it ends the command with. */
export class CliError extends Error {
  constructor(message, exit = EXIT.failed, code) {
    super(message);
    this.exit = exit;
    this.code = code;
  }
}
export const usage = (message) => new CliError(message, EXIT.usage, "USAGE");

const width = (text) => stripVTControlCharacters(String(text)).length;

/** Rows as aligned columns: [[header…], [cell…], …]. Empty cells show as "-". */
export function table(headers, rows) {
  const cells = [headers.map(String), ...rows.map((row) => row.map((cell) => (cell === null || cell === undefined || cell === "" ? "-" : String(cell))))];
  const widths = headers.map((_, column) => Math.max(...cells.map((row) => width(row[column] ?? ""))));
  return cells.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell + " ".repeat(widths[column] - width(cell)))).join("  ").trimEnd()).join("\n");
}

/** "3 minutes ago", "in 2 hours", from a time. */
export function ago(time, now = Date.now()) {
  if (!time) return "never";
  const seconds = Math.round((now - new Date(time).getTime()) / 1000);
  const past = seconds >= 0;
  const amount = Math.abs(seconds);
  const [count, unit] = amount < 60 ? [amount, "second"] : amount < 3600 ? [Math.round(amount / 60), "minute"] : amount < 86400 ? [Math.round(amount / 3600), "hour"] : [Math.round(amount / 86400), "day"];
  const text = count + " " + unit + (count === 1 ? "" : "s");
  return past ? text + " ago" : "in " + text;
}

export function duration(seconds) {
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h " + Math.floor((seconds % 3600) / 60) + "m";
  return Math.floor(seconds / 86400) + "d " + Math.floor((seconds % 86400) / 3600) + "h";
}

/** Colors only for a terminal that shows them, and never when NO_COLOR is set. */
export function paint(stream, env = process.env) {
  const on = !!stream?.isTTY && !env.NO_COLOR && env.TERM !== "dumb";
  const wrap = (code) => (text) => (on ? "\u001b[" + code + "m" + text + "\u001b[0m" : String(text));
  return { on, bold: wrap("1"), dim: wrap("2"), green: wrap("32"), red: wrap("31"), yellow: wrap("33"), cyan: wrap("36") };
}
