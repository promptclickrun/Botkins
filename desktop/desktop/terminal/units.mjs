// The files that keep the terminal host running across restarts: a systemd unit on Linux, a
// launchd job on macOS. `botkins service install` writes one of them (desktop/terminal/manager.mjs).
// This file only makes their text, so the tests read exactly what would be installed.
//
// The systemd unit for the whole computer runs the service as its own user, `botkins`, with
// nothing it doesn't need:
//
//   - It can write only its data folder (ProtectSystem=strict, ReadWritePaths=). The rest of the
//     disk is read-only to it, /home and /root are hidden (ProtectHome=), and /tmp is its own.
//   - It can never gain a privilege it didn't start with (NoNewPrivileges=, an empty capability
//     set, no set-user-ID files), and can't touch the kernel's settings, modules, logs or clock.
//   - The host key reaches it as a credential (LoadCredential=): systemd reads a root-only file
//     and hands the service a copy in memory, so the service's user can't read the file itself.
//
// Bots do real work on the host: they write files and run tools. With this unit they do so inside
// the data folder. A project folder elsewhere has to be named when the service is installed
// (`--allow-path`), which adds it to ReadWritePaths=.
//
// What is left out, on purpose: MemoryDenyWriteExecute= (Node's compiler needs writable code
// pages), RestrictNamespaces= and SystemCallFilter= (the model providers' own tools sandbox the
// commands they run, with namespaces and filters of their own).
export const UNIT = "botkins.service";
export const UPDATE_UNIT = "botkins-update.service";
export const UPDATE_PATH_UNIT = "botkins-update.path";
export const LABEL = "app.botkins.terminal";
export const DOCS = "https://github.com/promptclickrun/Botkins/blob/main/desktop/docs/terminal.md";

// How systemd reads a value, as systemd 252 itself answered when it was asked (a unit with one
// line of each form, then `systemctl show -p Environment` and the environment the process got):
//   - "%" starts a specifier in every setting ("%n" is the unit's name), so a "%" that is meant is doubled.
//   - "$" starts a variable only in a command line (ExecStart=). In Environment= and in a path it
//     is just a "$": doubled there, it would be two.
//   - A value in double quotes is one word; inside, \" is a quote, \\ a backslash, and \n a line break.
const quoted = (text) => (/[\s"'\\]/.test(text) ? '"' + text.replace(/(["\\])/g, "\\$1") + '"' : text);
/** A value in a unit file, as one word. */
const unitValue = (value) => quoted(String(value).replace(/%/g, "%%"));
/** A word of a command line in a unit file. */
const execWord = (value) => quoted(String(value).replace(/%/g, "%%").replace(/\$/g, "$$$$"));
const environment = (env) => Object.entries(env).map(([name, value]) => "Environment=" + unitValue(name + "=" + value));
const safePath = (path) => {
  if (typeof path !== "string" || !path.startsWith("/") || /[\n\r\0]/.test(path) || path.split("/").includes("..")) throw new Error("A path in a service file is whole, from the top of the disk: " + path);
  return path;
};

/**
 * The unit for the whole computer.
 * @param options.command    How `botkins` is started: its program and any words before the command, each whole.
 * @param options.dataDir    The data folder.
 * @param options.user       The user the service runs as.
 * @param options.home       That user's home, where the providers' tools keep their sign-ins. Inside the data folder.
 * @param options.key        { file } a root-only key file handed over with LoadCredential=,
 *                           { encrypted } one encrypted with systemd-creds, handed over with
 *                           LoadCredentialEncrypted=, or { groupFile } a key file the service's
 *                           group reads itself, where systemd can't hand a credential over.
 * @param options.allowPaths More folders bots may write to (project folders).
 * @param options.env        More environment for the service.
 */
export function systemUnit({ command, dataDir, user = "botkins", group = user, home = dataDir + "/home", key, allowPaths = [], env = {} }) {
  for (const path of [...command, dataDir, home, ...allowPaths, key?.file, key?.encrypted, key?.groupFile].filter(Boolean)) safePath(path);
  // The unit says where the key comes from, so a start without it fails with one sentence
  // instead of quietly making another key somewhere else (desktop/host/keystore.mjs).
  const keyEnv = key?.groupFile ? { BOTKINS_KEY_SOURCE: "file", BOTKINS_KEY_FILE: key.groupFile } : key ? { BOTKINS_KEY_SOURCE: "systemd" } : {};
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || !/^[a-z_][a-z0-9_-]{0,31}$/.test(group)) throw new Error("That isn't a user's name: " + user);
  return [
    "# Written by `botkins service install`. Change it with `systemctl edit " + UNIT + "`, which survives the next install.",
    "[Unit]",
    "Description=Botkins terminal host",
    "Documentation=" + DOCS,
    "Wants=network-online.target",
    "After=network-online.target",
    // Five failed starts in a minute is a problem to look at, not one to keep hitting.
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "User=" + user,
    "Group=" + group,
    "WorkingDirectory=" + unitValue(dataDir),
    ...environment({ BOTKINS_DATA_DIR: dataDir, HOME: home, NODE_ENV: "production", ...keyEnv, ...env }),
    ...(key?.encrypted ? ["LoadCredentialEncrypted=botkins-key:" + key.encrypted] : key?.file ? ["LoadCredential=botkins-key:" + key.file] : []),
    "ExecStart=" + command.map(execWord).join(" ") + " serve",
    "Restart=on-failure",
    "RestartSec=3",
    // The service saves its work and closes its providers before it goes.
    "TimeoutStopSec=20",
    "KillMode=mixed",
    "UMask=0077",
    "",
    "# What the service may touch.",
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    "ReadWritePaths=" + [dataDir, ...allowPaths].map(unitValue).join(" "),
    "ProtectHome=true",
    "PrivateTmp=true",
    "PrivateDevices=true",
    "ProtectKernelTunables=true",
    "ProtectKernelModules=true",
    "ProtectKernelLogs=true",
    "ProtectControlGroups=true",
    "ProtectClock=true",
    "ProtectHostname=true",
    "RestrictSUIDSGID=true",
    "RestrictRealtime=true",
    "LockPersonality=true",
    "SystemCallArchitectures=native",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/**
 * The unit for one person (`systemctl --user`), with lingering so it runs when they are signed
 * out. It runs as that person, so it protects less than the system unit: there is no other user
 * to run as and no root to hand it a key, and its key file is the person's own.
 */
export function userUnit({ command, dataDir, keyFile, env = {} }) {
  for (const path of [...command, dataDir, keyFile].filter(Boolean)) safePath(path);
  return [
    "# Written by `botkins service install --user`. Change it with `systemctl --user edit " + UNIT + "`.",
    "[Unit]",
    "Description=Botkins terminal host",
    "Documentation=" + DOCS,
    "Wants=network-online.target",
    "After=network-online.target",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    ...environment({ BOTKINS_DATA_DIR: dataDir, ...(keyFile && { BOTKINS_KEY_FILE: keyFile }), NODE_ENV: "production", ...env }),
    "ExecStart=" + command.map(execWord).join(" ") + " serve",
    "Restart=on-failure",
    "RestartSec=3",
    "TimeoutStopSec=20",
    "KillMode=mixed",
    "UMask=0077",
    "NoNewPrivileges=true",
    "LockPersonality=true",
    "RestrictRealtime=true",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * The root job that installs a signed release, and the watch that starts it. The service runs
 * without privileges, so it can't replace its own program: it can only ask, by making an empty
 * file in its data folder. The watch sees the file and starts the job as root. The job takes
 * nothing from the file but that it is there: what it installs is the latest signed release from
 * the project's own address (desktop/terminal/update-install.mjs).
 */
export function updateUnits({ command, dataDir }) {
  for (const path of [...command, dataDir]) safePath(path);
  return {
    [UPDATE_UNIT]: [
      "# Written by `botkins service install`.",
      "[Unit]",
      "Description=Install the latest signed Botkins terminal host release",
      "Documentation=" + DOCS,
      "Wants=network-online.target",
      "After=network-online.target",
      "",
      "[Service]",
      "Type=oneshot",
      "Environment=" + unitValue("BOTKINS_DATA_DIR=" + dataDir),
      "ExecStart=" + command.map(execWord).join(" ") + " update --apply",
      "UMask=0022",
      "PrivateTmp=true",
      "",
    ].join("\n"),
    [UPDATE_PATH_UNIT]: [
      "# Written by `botkins service install`.",
      "[Unit]",
      "Description=Watch for the Botkins terminal host asking to be updated",
      "",
      "[Path]",
      "PathExists=" + unitValue(dataDir + "/run/update-requested"),
      "Unit=" + UPDATE_UNIT,
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n"),
  };
}

const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The launchd job. For one person it is a LaunchAgent in their own session, where their login
 * keychain holds the host key; with `user` it is a LaunchDaemon that runs as that user from the
 * moment the Mac starts, and keeps its key in a file (a daemon has no keychain session to ask).
 * It is started again when it ends badly, and left alone when it was stopped on purpose.
 */
export function launchdJob({ command, dataDir, logFile, user, env = {} }) {
  for (const path of [...command, dataDir, logFile]) safePath(path);
  // The service keeps its own log; launchd's file is for what Node itself says when it can't start.
  const vars = { BOTKINS_DATA_DIR: dataDir, BOTKINS_QUIET: "1", NODE_ENV: "production", ...env };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    "  <string>" + LABEL + "</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[...command, "serve"].map((word) => "    <string>" + xml(word) + "</string>"),
    "  </array>",
    ...(user ? ["  <key>UserName</key>", "  <string>" + xml(user) + "</string>"] : []),
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(vars).flatMap(([name, value]) => ["    <key>" + xml(name) + "</key>", "    <string>" + xml(value) + "</string>"]),
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    "  <string>" + xml(dataDir) + "</string>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>5</integer>",
    "  <key>ExitTimeOut</key>",
    "  <integer>20</integer>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>Umask</key>",
    "  <integer>63</integer>",
    "  <key>StandardOutPath</key>",
    "  <string>" + xml(logFile) + "</string>",
    "  <key>StandardErrorPath</key>",
    "  <string>" + xml(logFile) + "</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

// Reading a service file back.
//
// An update brings the service's files up to date with the version it installs (`refresh` in
// desktop/terminal/manager.mjs). What the person chose when they installed the service (who it
// runs as, where its data is, which folders bots may write to, where the host key comes from) is
// in no other place than the installed file, so it is read from there, and the new text is made
// from it by the functions above. Nothing is guessed: a file that doesn't say one of these, as
// `botkins service install` wrote it, is not read at all (UNREADABLE_UNIT), and is left as it is.
//
// A person may have put lines of their own into the file. What can be carried into the new text
// is carried: every environment variable the file sets beyond the ones written here (a proxy, a
// provider's variable: on a Mac the job's file is the only place for one), and every folder
// named for bots to write to. Anything else of theirs can't be carried, because the new text is
// made, not edited. So a file that holds a line no version of Botkins wrote is left as it is
// (`strange` below finds such lines), and `botkins doctor` says so.
//
// WHEN YOU CHANGE WHAT A FUNCTION ABOVE WRITES: a line that this version stops writing, or
// writes differently, is still in the files of every computer that installed an earlier version.
// Add the earlier line to ONCE_WRITTEN, or those files look changed by hand and are never
// brought up to date. test/terminal-refresh.test.mjs holds the files each release wrote
// (test/fixtures/service-files) and fails when one of them is no longer read as Botkins' own.

/** Lines an earlier version wrote that this one doesn't, by the kind of file. For launchd: "<key> <value as JSON>". */
export const ONCE_WRITTEN = { systemd: [], launchd: [] };

const unreadable = (what) => Object.assign(new Error("The installed service file doesn't say " + what + " the way `botkins service install` writes it, so it is left as it is."), { code: "UNREADABLE_UNIT" });

/**
 * The words of a unit file's value, as `unitValue` wrote them (`exec`: as `execWord` did, for a
 * command line). This reads the forms the functions above write and no others: what a person
 * may have written some other way that systemd also takes (single quotes, a line break as \n)
 * is not read here as systemd reads it. `sameForm` below is what keeps that from mattering.
 */
export function unitWords(value, { exec = false } = {}) {
  const words = [];
  const text = String(value);
  for (let at = 0; at < text.length; ) {
    if (/\s/.test(text[at])) {
      at++;
      continue;
    }
    let word = "";
    if (text[at] === '"') {
      for (at++; at < text.length && text[at] !== '"'; at++) word += text[at] === "\\" && at + 1 < text.length ? text[++at] : text[at];
      at++;
    } else for (; at < text.length && !/\s/.test(text[at]); at++) word += text[at];
    words.push((exec ? word.replace(/\$\$/g, "$") : word).replace(/%%/g, "%"));
  }
  return words;
}
/**
 * True when a value is written in a form that is read here exactly as systemd reads it, so that
 * reading it and writing it again is sure to give systemd the same thing. Those forms are few,
 * on purpose: words with no quote and no backslash in them, and words in double quotes with no
 * backslash but before a quote or another backslash; every "%" doubled; in a command line every
 * "$" doubled. A value in any other form (single quotes, \n for a line break, a specifier such
 * as %h, two quoted parts run together) is the person's own way of writing it. It is never
 * carried into a new file by guessing what it meant: the file it is in is left as it is.
 */
export function sameForm(value, exec = false) {
  const text = String(value);
  let words = 0;
  for (let at = 0; at < text.length; ) {
    if (/\s/.test(text[at])) {
      at++;
      continue;
    }
    let word = "";
    if (text[at] === '"') {
      for (at++; ; at++) {
        if (at >= text.length) return false;
        if (text[at] === '"') break;
        if (text[at] === "\\") {
          if (text[at + 1] !== '"' && text[at + 1] !== "\\") return false;
          at++;
        }
        word += text[at];
      }
      at++;
      if (at < text.length && !/\s/.test(text[at])) return false;
    } else {
      for (; at < text.length && !/\s/.test(text[at]); at++) word += text[at];
      if (/["'\\]/.test(word)) return false;
    }
    if (word.replace(/%%/g, "").includes("%") || (exec && word.replace(/\$\$/g, "").includes("$"))) return false;
    words++;
  }
  return words > 0;
}

/**
 * A unit file, line by line: { name, value } for a setting (systemd takes spaces before the name
 * and around the "="), { section } for a section's heading, { other } for a line that is none of
 * these. Blank lines and comments are left out: they change nothing systemd does.
 */
function unitFile(text) {
  const lines = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const setting = /^([^\s=\[][^\s=]*)\s*=\s*(.*)$/.exec(line);
    // A line that ends in a backslash goes on in the next one: no function here writes that.
    if (setting && !line.endsWith("\\")) lines.push({ name: setting[1], value: setting[2] });
    else if (/^\[[^\]]+\]$/.test(line)) lines.push({ section: line });
    else lines.push({ other: line });
  }
  return lines;
}
/** A unit file's settings: name → every value given for it, in order. */
function unitSettings(text) {
  const settings = {};
  for (const { name, value } of unitFile(text)) if (name) (settings[name] ??= []).push(value);
  return settings;
}
/** Every variable a unit sets, in order; a line may set several. */
const unitEnvironment = (settings) =>
  Object.fromEntries(
    (settings.Environment ?? []).flatMap((value) => unitWords(value)).map((pair) => {
      const cut = pair.indexOf("=");
      return cut > 0 ? [pair.slice(0, cut), pair.slice(cut + 1)] : [pair, ""];
    }),
  );
const without = (env, names) => Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));
/** The command a unit starts, without the word it ends with ("serve"). */
function unitCommand(settings, last) {
  const line = settings.ExecStart?.[0] ?? "";
  const words = unitWords(line, { exec: true });
  // One command, written the way it is written here, that starts with a whole path (systemd's own marks before a command, such as "-", are a person's).
  if (settings.ExecStart?.length !== 1 || !sameForm(line, true) || words.length < 2 || words.at(-1) !== last || !words[0].startsWith("/")) throw unreadable("how Botkins is started");
  return words.slice(0, -1);
}

/** What was chosen for the whole computer's service: the options of `systemUnit`. `env` is what the person added. */
export function readSystemUnit(text) {
  const settings = unitSettings(text);
  const all = unitEnvironment(settings);
  const user = settings.User?.[0];
  if (!user) throw unreadable("which user the service runs as");
  const dataDir = all.BOTKINS_DATA_DIR;
  if (!dataDir || !all.HOME) throw unreadable("where the data folder is");
  // Every folder named for writing, on however many lines and in whatever order: a line of the
  // person's own may stand before the one written here. The data folder is among them.
  const folders = (settings.ReadWritePaths ?? []).flatMap((value) => unitWords(value));
  if (!folders.includes(dataDir)) throw unreadable("which folders bots may write to");
  const allowPaths = folders.filter((path) => path !== dataDir);
  const credential = (line) => {
    const found = /^botkins-key:(\/.+)$/.exec(line ?? "");
    if (!found) throw unreadable("where the host key comes from");
    return found[1];
  };
  const group = all.BOTKINS_KEY_SOURCE === "file" && all.BOTKINS_KEY_FILE ? { groupFile: all.BOTKINS_KEY_FILE } : undefined;
  const key = settings.LoadCredentialEncrypted ? { encrypted: credential(settings.LoadCredentialEncrypted[0]) } : settings.LoadCredential ? { file: credential(settings.LoadCredential[0]) } : group;
  if (!key) throw unreadable("where the host key comes from");
  const env = without(all, ["BOTKINS_DATA_DIR", "HOME", "NODE_ENV", "BOTKINS_KEY_SOURCE", ...(group ? ["BOTKINS_KEY_FILE"] : [])]);
  return { command: unitCommand(settings, "serve"), dataDir, user, group: settings.Group?.[0] ?? user, home: all.HOME, key, allowPaths: allowPaths.filter((path, at) => allowPaths.indexOf(path) === at), env };
}

/** What was chosen for one person's service: the options of `userUnit`. `env` is their PATH and what they added. */
export function readUserUnit(text) {
  const settings = unitSettings(text);
  const all = unitEnvironment(settings);
  if (!all.BOTKINS_DATA_DIR) throw unreadable("where the data folder is");
  return { command: unitCommand(settings, "serve"), dataDir: all.BOTKINS_DATA_DIR, ...(all.BOTKINS_KEY_FILE && { keyFile: all.BOTKINS_KEY_FILE }), env: without(all, ["BOTKINS_DATA_DIR", "BOTKINS_KEY_FILE", "NODE_ENV"]) };
}

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
/** The text of an XML element, with every way XML has of writing a character read back. */
const unxml = (text) =>
  text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g, (whole, name) => {
    if (name[0] !== "#") return ENTITIES[name] ?? whole;
    const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
const PLIST_TOKEN = /<(?:key|string|integer)>[^<]*<\/(?:key|string|integer)>|<\/?(?:dict|array)>|<(?:true|false)\/>/g;
/**
 * A property list of the few kinds `launchdJob` writes: dict, array, string, integer, true and
 * false. One that holds anything else (a date, a number with a point, data, a part kept as it
 * is) is not read at all: skipping what isn't known would read a different job than launchd does.
 */
function plist(text) {
  const body = String(text)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?xml[^>]*\?>/, "")
    .replace(/<!DOCTYPE[^>]*>/, "")
    .replace(/<plist[^>]*>/, "")
    .replace(/<\/plist>/, "");
  if (body.replace(PLIST_TOKEN, "").trim()) throw unreadable("what it starts");
  const tokens = body.match(PLIST_TOKEN) ?? [];
  let at = 0;
  const value = () => {
    const token = tokens[at++];
    if (token === undefined) throw unreadable("what it starts");
    if (token === "<dict>") {
      const dict = {};
      while (tokens[at] !== "</dict>") {
        const name = /^<key>([^<]*)<\/key>$/.exec(tokens[at++] ?? "");
        if (!name) throw unreadable("what it starts");
        dict[unxml(name[1])] = value();
      }
      at++;
      return dict;
    }
    if (token === "<array>") {
      const list = [];
      while (tokens[at] !== "</array>") {
        if (at >= tokens.length) throw unreadable("what it starts");
        list.push(value());
      }
      at++;
      return list;
    }
    if (token === "<true/>") return true;
    if (token === "<false/>") return false;
    const simple = /^<(string|integer)>([^<]*)<\/\1>$/.exec(token);
    if (!simple) throw unreadable("what it starts");
    return simple[1] === "integer" ? Number(simple[2]) : unxml(simple[2]);
  };
  const whole = value();
  if (at !== tokens.length) throw unreadable("what it starts");
  return whole;
}

/** What was chosen for the launchd job: the options of `launchdJob`. `env` is what the install added (a PATH, or the daemon's key file and home) and what the person added. */
export function readLaunchdJob(text) {
  const job = plist(text);
  const words = job.ProgramArguments;
  if (!Array.isArray(words) || words.length < 2 || words.at(-1) !== "serve" || !words.every((word) => typeof word === "string")) throw unreadable("how Botkins is started");
  const vars = job.EnvironmentVariables ?? {};
  if (typeof vars.BOTKINS_DATA_DIR !== "string" || !vars.BOTKINS_DATA_DIR) throw unreadable("where the data folder is");
  if (typeof job.StandardOutPath !== "string" || !job.StandardOutPath) throw unreadable("where its log goes");
  const env = Object.fromEntries(Object.entries(without(vars, ["BOTKINS_DATA_DIR", "BOTKINS_QUIET", "NODE_ENV"])).filter(([, value]) => typeof value === "string"));
  return { command: words.slice(0, -1), dataDir: vars.BOTKINS_DATA_DIR, logFile: job.StandardOutPath, ...(typeof job.UserName === "string" && { user: job.UserName }), env };
}

/** True for a variable or a write folder that is not written in a form that can be carried: see `sameForm`. */
function oddSetting(name, value) {
  // Each word sets one variable, by a name systemd takes: a word that doesn't is one systemd drops, and is no setting to carry.
  if (name === "Environment") return !sameForm(value) || unitWords(value).some((pair) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(pair));
  // A folder marked "-" or "+", or one that is no whole path, is a setting of its own kind.
  if (name === "ReadWritePaths") return !sameForm(value) || unitWords(value).some((path) => !path.startsWith("/") || path.split("/").includes(".."));
  return false;
}
/**
 * A unit as lines that can be compared, and the lines in it that are a person's own for sure
 * (`odd`): a line that is no setting, and a variable or a write folder not written in a form
 * that can be carried. There is one compared line for each variable, and none for the write
 * folders (they are read, and written anew as one line).
 */
function unitLines(text) {
  const lines = [];
  const odd = [];
  for (const { name, value, section, other } of unitFile(text)) {
    if (other !== undefined) odd.push(other);
    else if (section) lines.push(section);
    else if (oddSetting(name, value)) odd.push(name + "=" + value);
    else if (name === "Environment") for (const pair of unitWords(value)) lines.push("Environment=" + unitValue(pair));
    else if (name !== "ReadWritePaths") lines.push(name + "=" + value);
  }
  return { lines, odd };
}
/** A unit's text without its odd lines: what is left is read for what was chosen, so one line of the person's own doesn't make the whole file unreadable. */
export function withoutOdd(text) {
  return String(text)
    .split("\n")
    .filter((raw) => {
      const [line] = unitFile(raw);
      return !line || (line.other === undefined && !(line.name && oddSetting(line.name, line.value)));
    })
    .join("\n");
}
/** A job's settings as lines that can be compared: "<key> <value as JSON>", and one line for each variable. */
function jobLines(text) {
  const job = plist(text);
  if (job === null || typeof job !== "object" || Array.isArray(job)) throw unreadable("what it starts");
  return { lines: Object.entries(job).flatMap(([name, value]) => (name === "EnvironmentVariables" && value && typeof value === "object" ? Object.entries(value).map(([variable, set]) => "EnvironmentVariables." + variable + " " + JSON.stringify(set)) : [name + " " + JSON.stringify(value)])), odd: [] };
}

/**
 * The lines of an installed file that can't be carried into a new one for sure, whatever the
 * new one would say: see `unitLines`. A file with one of these is left as it is. [] for a job on
 * macOS: what can't be read there makes the whole file unreadable.
 * @param kind  "systemd" or "launchd"
 */
export const odd = (kind, installed) => (kind === "launchd" ? jobLines : unitLines)(installed).odd;

/**
 * The settings in an installed file that no version of Botkins wrote: the `odd` ones, and those
 * not in the text this version makes from what the file itself says was chosen (`made`) nor
 * among the lines an earlier version wrote. A setting the person changed is one, and so is one
 * they added that can't be carried. [] for a file that is Botkins' own, whichever version wrote it.
 * @param kind  "systemd" or "launchd"
 */
export function strange(kind, installed, made) {
  const read = kind === "launchd" ? jobLines : unitLines;
  const mine = read(installed);
  const known = new Set([...read(made).lines, ...ONCE_WRITTEN[kind]]);
  return [...mine.odd, ...mine.lines.filter((line) => !known.has(line))];
}
