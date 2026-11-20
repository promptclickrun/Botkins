// The terminal host's log: the last lines in memory for `botkins logs`, the same lines in a file
// (<root>/logs/botkins.log, readable by the service's user only) and on standard output, where
// systemd's journal or launchd picks them up.
//
// No secret belongs in a log. The service never logs a pairing code, a token or a key on purpose;
// `scrub` is the second line of defence, for a line written by a tool or a library the service
// doesn't control: what looks like a credential is replaced before the line is kept anywhere.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";

export const LEVELS = ["error", "info", "debug"];
const MAX_LINE = 4000;
const MAX_FILE = 5 * 1024 * 1024;
const KEPT_FILES = 3;

const HIDDEN = "[hidden]";
const PATTERNS = [
  // A pairing or invite link: the code and the key it carries.
  [/\bbotkins:\/\/[^\s"'<>]+/gi, "botkins://" + HIDDEN],
  // Authorization headers and bearer tokens.
  [/\b(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s"',;]+/gi, "$1" + HIDDEN],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer " + HIDDEN],
  // name=value and "name": "value" for names that hold secrets.
  [/((?:^|[\s"'{,(?&])["']?[\w.-]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key|credential|cookie|session[_-]?id)[\w.-]*["']?\s*[:=]\s*["']?)[^\s"',;&})]{4,}/gi, "$1" + HIDDEN],
  // Well-known token shapes: OpenAI and Anthropic keys, GitHub, Slack, Google, AWS, JSON web tokens.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, HIDDEN],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, HIDDEN],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, HIDDEN],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, HIDDEN],
  [/\bAKIA[A-Z0-9]{16}\b/g, HIDDEN],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, HIDDEN],
  // A sign-in in an address: https://user:password@host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1" + HIDDEN + "@"],
  // The host key store's own wrapped values.
  [/\bbk1\.[A-Za-z0-9+/=]{20,}/g, "bk1." + HIDDEN],
];

/** A line with whatever looks like a credential replaced by "[hidden]". */
export function scrub(line) {
  let text = String(line);
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

/**
 * @param options.file    The log file, or nothing to keep lines in memory only.
 * @param options.lines   How many recent lines `read` can still return.
 * @param options.level   "error", "info" or "debug": lines above it are dropped.
 * @param options.out     (text) → standard output, or nothing to stay quiet (tests).
 * @returns { error, info, debug, write, read, wait, setLevel, capture }
 */
export function createLog({ file, lines = 5000, level = "info", out, now = () => Date.now() } = {}) {
  const kept = [];
  const waiting = new Set();
  let serial = 0;
  let threshold = Math.max(0, LEVELS.indexOf(level));
  let size = -1;
  if (file) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const toFile = (text) => {
    if (!file) return;
    try {
      if (size < 0) size = existsSync(file) ? statSync(file).size : 0;
      if (size > MAX_FILE) {
        // botkins.log → botkins.log.1 → … ; the oldest goes.
        rmSync(file + "." + KEPT_FILES, { force: true });
        for (let index = KEPT_FILES - 1; index >= 1; index--) if (existsSync(file + "." + index)) renameSync(file + "." + index, file + "." + (index + 1));
        renameSync(file, file + ".1");
        size = 0;
      }
      appendFileSync(file, text, { mode: 0o600 });
      size += Buffer.byteLength(text);
    } catch {
      // A log that can't be written (a full disk) must not stop the service.
    }
  };
  const write = (kind, ...parts) => {
    const at = LEVELS.indexOf(kind);
    if (at < 0 || at > threshold) return;
    const stamp = new Date(now()).toISOString();
    for (const raw of format(...parts).split("\n")) {
      if (!raw.trim()) continue;
      const entry = { n: ++serial, time: stamp, level: kind, text: scrub(raw).slice(0, MAX_LINE) };
      kept.push(entry);
      if (kept.length > lines) kept.splice(0, kept.length - lines);
      const line = stamp + " " + kind.padEnd(5) + " " + entry.text + "\n";
      toFile(line);
      out?.(line);
    }
    for (const wake of [...waiting]) wake();
  };
  /** The entries after `after` (a number from an earlier read; 0 for all that are kept). `tail` keeps only the last so many. */
  const read = ({ after = 0, tail } = {}) => {
    let entries = kept.filter((entry) => entry.n > after);
    if (Number.isInteger(tail) && tail >= 0) entries = entries.slice(-tail || entries.length);
    return { entries, next: serial };
  };
  return {
    write,
    error: (...parts) => write("error", ...parts),
    info: (...parts) => write("info", ...parts),
    debug: (...parts) => write("debug", ...parts),
    read,
    /** Resolves with the entries after `after`, at once when there are some, else when one is written or `ms` have passed. */
    wait({ after = 0, ms = 25_000, signal } = {}) {
      const ready = read({ after });
      if (ready.entries.length || signal?.aborted) return Promise.resolve(ready);
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiting.delete(done);
          signal?.removeEventListener("abort", done);
          resolve(read({ after }));
        };
        const timer = setTimeout(done, ms);
        waiting.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    },
    setLevel(next) {
      if (LEVELS.includes(next)) threshold = LEVELS.indexOf(next);
    },
    get level() {
      return LEVELS[threshold];
    },
    /** Sends what the workspace's own modules print (console.log, console.error) through this log. Returns a function that puts the console back. */
    capture(target = console) {
      const original = { log: target.log, info: target.info, warn: target.warn, error: target.error, debug: target.debug };
      target.log = target.info = (...parts) => write("info", ...parts);
      target.warn = target.error = (...parts) => write("error", ...parts);
      target.debug = (...parts) => write("debug", ...parts);
      return () => Object.assign(target, original);
    },
  };
}
