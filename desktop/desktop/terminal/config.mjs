// The terminal host's settings: one JSON file, <root>/config.json, that `botkins config get`,
// `set` and `edit` read and write, checked whole before it is saved or used.
//
// Only what belongs to the host is here: how phones reach it, where its keys are kept, how much
// it logs. Bots, chats, routines, tools and model choices are the workspace's own and are changed
// with their own commands (or from a paired phone), as in the desktop app.
//
// Every setting has a default, so a file that is missing, or names only some, is fine. A file
// that names something unknown, or gives a value of the wrong kind, is refused with one line for
// each problem: the service doesn't start on a file it only half understands.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_RELAY_URL, cleanRelayUrl } from "../link/relay.mjs";
import { DEFAULT_PORT } from "../link/store.mjs";
import { SOURCES } from "../host/keystore.mjs";

const text = (max) => (value) => (typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? null : "a line of text, " + max + " characters at most");
const flag = (value) => (typeof value === "boolean" ? null : "true or false");
const oneOf = (list) => (value) => (list.includes(value) ? null : "one of: " + list.join(", "));
const whole = (low, high) => (value) => (Number.isInteger(value) && value >= low && value <= high ? null : "a whole number from " + low + " to " + high);
const list = (item, max) => (value) => (Array.isArray(value) && value.length <= max && value.every((entry) => item(entry) === null) ? null : "a list of up to " + max + " entries, each " + item(undefined));
// A name or an IPv4 address, with no port: phones use the link's own port at every address (desktop/link/server.mjs, hosts()).
const address = (value) => (typeof value === "string" && /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(value) ? null : "a name or address a phone can reach, without a port, such as server.example.com");
const providerId = (value) => (typeof value === "string" && /^[a-z0-9-]{1,40}$/.test(value) ? null : "a provider's id, such as claude");
const relayUrl = (value) => {
  try {
    cleanRelayUrl(value);
    return null;
  } catch {
    return "the relay's https address";
  }
};

/**
 * Every setting, by its dotted name: { check(value) → null or what it should be, default, about,
 * restart? }. `restart` marks one the running service picks up only when it starts.
 */
export const SETTINGS = {
  name: { check: text(60), default: "", about: "The name phones show for this computer. Empty: the computer's own name." },
  "link.enabled": { check: flag, default: true, about: "Phone access: whether paired phones can reach this host." },
  "link.port": { check: whole(1, 65535), default: DEFAULT_PORT, restart: true, about: "The port the phone link listens on." },
  "link.announce": { check: flag, default: true, restart: true, about: "Announce the host on the local network (Bonjour), so a phone finds it by itself." },
  "link.addresses": { check: list(address, 8), default: [], restart: true, about: "More names or addresses to offer phones in a pairing code, such as a public name or a tailnet address. Phones use the link's port at each." },
  "relay.enabled": { check: flag, default: false, about: "Away from home: keep one outgoing connection to the Botkins relay, so a phone on another network reaches this host." },
  "relay.url": { check: relayUrl, default: DEFAULT_RELAY_URL, about: "The relay's address." },
  "providers.only": { check: list(providerId, 20), default: [], restart: true, about: "Start only these model providers. Empty: all of them." },
  "secrets.source": { check: oneOf(SOURCES), default: "auto", restart: true, about: "Where the host key that wraps secrets at rest comes from: auto, systemd, keychain or file." },
  "secrets.keyFile": { check: (value) => (value === null ? null : text(1024)(value)), default: null, restart: true, about: "The key file for the source \"file\". Empty: host.key in the data folder." },
  "updates.check": { check: flag, default: true, restart: true, about: "Look for a new release now and then, and tell the paired phones when there is one." },
  "updates.auto": { check: flag, default: false, about: "Install a new signed release without being asked, once no bot is in the middle of a turn." },
  "logs.level": { check: oneOf(["error", "info", "debug"]), default: "info", about: "How much the service logs." },
  "logs.lines": { check: whole(100, 100000), default: 5000, restart: true, about: "How many recent log lines the service keeps in memory for `botkins logs`." },
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** The value at a dotted name, or undefined. */
export function read(config, key) {
  let value = config;
  for (const step of key.split(".")) value = isObject(value) ? value[step] : undefined;
  return value;
}
function write(config, key, value) {
  const steps = key.split(".");
  let at = config;
  for (const step of steps.slice(0, -1)) at = at[step] = isObject(at[step]) ? at[step] : {};
  at[steps.at(-1)] = value;
}

/** Every setting at its default. */
export function defaults() {
  const config = {};
  for (const [key, setting] of Object.entries(SETTINGS)) write(config, key, clone(setting.default));
  return config;
}

/**
 * Checks a whole config as it was read from a file.
 * @returns { config, problems }: `config` has every setting (what the file names, else the
 *   default); `problems` is one sentence for each thing wrong, and empty for a good file.
 */
export function validate(input) {
  const problems = [];
  const config = defaults();
  if (!isObject(input)) return { config, problems: ["The config is one JSON object, such as { \"name\": \"Studio server\" }."] };
  const walk = (value, prefix) => {
    for (const [name, inner] of Object.entries(value)) {
      const key = prefix ? prefix + "." + name : name;
      if (Object.hasOwn(SETTINGS, key)) {
        const wanted = SETTINGS[key].check(inner);
        if (wanted) problems.push(key + " must be " + wanted + ".");
        else write(config, key, clone(inner));
      } else if (isObject(inner) && Object.keys(SETTINGS).some((known) => known.startsWith(key + "."))) walk(inner, key);
      else problems.push(key + " is not a setting. Run `botkins config get` to see them all.");
    }
  };
  walk(input, "");
  return { config, problems };
}

/** A value typed on a command line, as the setting's kind: JSON when it reads as JSON, else the text itself. */
export function parseValue(key, raw) {
  if (!Object.hasOwn(SETTINGS, key)) throw new Error(key + " is not a setting. Run `botkins config get` to see them all.");
  if (typeof raw !== "string") return raw;
  const kind = typeof SETTINGS[key].default;
  const trimmed = raw.trim();
  if (Array.isArray(SETTINGS[key].default)) {
    if (trimmed.startsWith("[")) return JSON.parse(trimmed);
    return trimmed ? trimmed.split(",").map((item) => item.trim()).filter(Boolean) : [];
  }
  if (kind === "boolean") {
    if (/^(true|on|yes|1)$/i.test(trimmed)) return true;
    if (/^(false|off|no|0)$/i.test(trimmed)) return false;
    return raw;
  }
  if (kind === "number") return /^-?\d+$/.test(trimmed) ? Number(trimmed) : raw;
  if (SETTINGS[key].default === null && /^(null|none|)$/i.test(trimmed)) return null;
  return raw;
}

/** A config with one setting changed. Throws one sentence when the value is not that setting's kind. */
export function withSetting(config, key, value) {
  if (!Object.hasOwn(SETTINGS, key)) throw new Error(key + " is not a setting. Run `botkins config get` to see them all.");
  const wanted = SETTINGS[key].check(value);
  if (wanted) throw new Error(key + " must be " + wanted + ".");
  const next = clone(config);
  write(next, key, clone(value));
  return next;
}

/** The settings whose values differ between two configs, by name. */
export function changed(before, after) {
  return Object.keys(SETTINGS).filter((key) => JSON.stringify(read(before, key)) !== JSON.stringify(read(after, key)));
}

/**
 * Reads the config file. A missing file is every default. A file that can't be read as JSON, or
 * that has a problem, throws an error whose `problems` lists them.
 */
export function loadConfig(file) {
  if (!existsSync(file)) return defaults();
  let input;
  try {
    input = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw Object.assign(new Error("The config file " + file + " is not JSON: " + error.message), { problems: ["The file is not JSON: " + error.message] });
  }
  const { config, problems } = validate(input);
  if (problems.length) throw Object.assign(new Error("The config file " + file + " has " + (problems.length === 1 ? "a problem" : problems.length + " problems") + ":\n  " + problems.join("\n  ")), { problems });
  return config;
}

/** Writes the whole config, readable by the service's user only. */
export function saveConfig(file, config) {
  const { config: whole, problems } = validate(config);
  if (problems.length) throw Object.assign(new Error(problems.join(" ")), { problems });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file + ".tmp", JSON.stringify(whole, null, 2) + "\n", { mode: 0o600 });
  renameSync(file + ".tmp", file);
  return whole;
}
