// Installing the terminal host as a service that starts with the computer and comes back when it
// fails: systemd on Linux, launchd on macOS. `botkins service install|uninstall|start|stop|
// restart|status` are thin over this file.
//
//   Linux, the whole computer (as root)   /etc/systemd/system/botkins.service, run as the user
//                                         `botkins`, with the data in /var/lib/botkins and the
//                                         host key in /etc/botkins/host.key, which only root reads.
//   Linux, one person (--user)            ~/.config/systemd/user/botkins.service, with lingering
//                                         so it runs while they are signed out.
//   macOS, one person                     ~/Library/LaunchAgents/app.botkins.terminal.plist, in
//                                         their session, with the host key in their keychain.
//   macOS, the whole computer (as root)   /Library/LaunchDaemons/app.botkins.terminal.plist, run
//                                         as a named user from the moment the Mac starts.
//
// Everything here is done with the system's own tools (systemctl, loginctl, useradd, launchctl),
// each started without a shell. `run` and `root` are replaceable, so the tests install into a
// folder of their own and nothing on the computer changes.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { CREDENTIAL } from "../host/keystore.mjs";
import { INSTALL_RECORD, SERVICE_USER, systemRoot, userRoot } from "./paths.mjs";
import { LABEL, launchdJob, systemUnit, UNIT, UPDATE_PATH_UNIT, UPDATE_UNIT, updateUnits, userUnit } from "./units.mjs";

export const KEY_FILE = "/etc/botkins/host.key";

/** Runs a tool to the end, without a shell: { code, stdout, stderr }. A tool that isn't there is code 127. */
function tool(file, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error ? (error.code === "ENOENT" ? 127 : typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

/**
 * @param options.command   How this copy of `botkins` is started: [program, ...words].
 * @param options.platform, options.uid, options.home, options.user  Who and where; tests pass their own.
 * @param options.run       (file, args, { input }) → { code, stdout, stderr }.
 * @param options.root      A folder that stands in for "/" for every file written (tests).
 * @param options.say       (line) → what is being done, for the person installing.
 */
export function serviceManager({ command, platform = process.platform, uid = process.getuid?.() ?? 0, home = homedir(), user = userInfo().username, env = process.env, run = tool, root = "", say = () => {}, own = chownSync } = {}) {
  const at = (path) => root + path;
  const must = async (file, args, what, options) => {
    const result = await run(file, args, options);
    if (result.code !== 0) throw new Error(what + " failed (" + file + " " + args.join(" ") + "): " + (result.stderr.trim() || result.stdout.trim() || "exit " + result.code).split("\n").at(-1));
    return result;
  };
  const write = (path, text, mode) => {
    mkdirSync(dirname(at(path)), { recursive: true });
    writeFileSync(at(path), text, { mode });
    chmodSync(at(path), mode);
  };
  const files = {
    systemd: { system: "/etc/systemd/system/" + UNIT, user: join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", UNIT) },
    launchd: { system: "/Library/LaunchDaemons/" + LABEL + ".plist", user: join(home, "Library", "LaunchAgents", LABEL + ".plist") },
  };
  const kind = platform === "darwin" ? "launchd" : "systemd";
  const systemctl = (scope) => (args) => ["systemctl", scope === "user" ? ["--user", ...args] : args];
  /** launchd's name for where a job lives: the whole computer, or one person's session. */
  const domain = (scope) => (scope === "system" ? "system" : "gui/" + uid);

  /**
   * One person's service finds the tools that person does: it is given the PATH of the terminal
   * it was installed from, where a provider's command-line tool may be (a version manager's
   * folder, say). The whole computer's service has the system's own PATH.
   */
  const ownPath = () => (typeof env.PATH === "string" && env.PATH && !/[\n\r\0]/.test(env.PATH) ? { PATH: env.PATH } : {});

  /** The installed service, if there is one: { kind, scope, file }. The whole computer's wins when both are there. */
  function installed() {
    for (const scope of ["system", "user"]) if (existsSync(at(files[kind][scope]))) return { kind, scope, file: files[kind][scope] };
    return null;
  }
  const need = () => {
    const found = installed();
    if (!found) throw Object.assign(new Error("Botkins isn't installed as a service here. Install it with `botkins service install`."), { code: "NOT_INSTALLED" });
    if (found.scope === "system" && uid !== 0) throw Object.assign(new Error("The Botkins service belongs to the whole computer: run this as root (with sudo)."), { code: "NEEDS_ROOT" });
    return found;
  };

  /**
   * Installs the service and (unless `start` is false) starts it.
   * @param options.scope       "system" (the whole computer; needs root) or "user". Root gets "system" unless told otherwise.
   * @param options.dataDir     The data folder. The usual one for the scope when left out.
   * @param options.runAs       The user the whole computer's service runs as ("botkins" on Linux; on macOS the person who ran sudo).
   * @param options.allowPaths  Linux, the whole computer: more folders bots may write to.
   * @param options.encryptedKey  Linux, the whole computer: encrypt the host key to this machine with systemd-creds.
   * @returns { kind, scope, file, dataDir, user, key }
   */
  async function install({ scope = uid === 0 ? "system" : "user", dataDir, runAs, allowPaths = [], encryptedKey = false, start = true } = {}) {
    if (!["system", "user"].includes(scope)) throw new Error("A service is installed for the whole computer (--system) or for one person (--user).");
    if (scope === "system" && uid !== 0) throw Object.assign(new Error("Installing for the whole computer needs root. Run it with sudo, or install for yourself with `botkins service install --user`."), { code: "NEEDS_ROOT" });
    const result = kind === "launchd" ? await installLaunchd({ scope, dataDir, runAs, start }) : scope === "system" ? await installSystem({ dataDir, runAs, allowPaths, encryptedKey, start }) : await installUser({ dataDir, start });
    return { kind, scope, ...result };
  }

  async function installSystem({ dataDir = systemRoot("linux"), runAs = SERVICE_USER, allowPaths, encryptedKey, start }) {
    const account = runAs;
    const accountHome = dataDir + "/home";
    // The service's own user: no password, no shell, its home inside the data folder.
    if ((await run("id", ["-u", account])).code !== 0) {
      say("Creating the user " + account + ".");
      await must("useradd", ["--system", "--user-group", "--home-dir", accountHome, "--no-create-home", "--shell", "/usr/sbin/nologin", account], "Creating the user " + account);
    }
    const ids = { uid: Number((await must("id", ["-u", account], "Reading the user " + account)).stdout.trim()), gid: Number((await must("id", ["-g", account], "Reading the user " + account)).stdout.trim()) };
    for (const dir of [dataDir, accountHome]) {
      const fresh = !existsSync(at(dir));
      mkdirSync(at(dir), { recursive: true, mode: 0o700 });
      chmodSync(at(dir), 0o700);
      // A folder that was already there keeps what is in it as it is; only the folder itself is made the service's.
      if (fresh || statSync(at(dir)).uid !== ids.uid) own(at(dir), ids.uid, ids.gid);
    }
    // The host key: 32 random bytes only root can read. systemd hands the service a copy when it starts.
    let key = { file: KEY_FILE };
    const encrypted = KEY_FILE + ".cred";
    if (existsSync(at(encrypted))) key = { encrypted };
    else if (!existsSync(at(KEY_FILE))) {
      say("Making the host key (" + KEY_FILE + ", readable by root only).");
      mkdirSync(at(dirname(KEY_FILE)), { recursive: true, mode: 0o755 });
      writeFileSync(at(KEY_FILE), randomBytes(32).toString("base64") + "\n", { mode: 0o400, flag: "wx" });
    }
    if (key.file) chmodSync(at(KEY_FILE), 0o400);
    // Can systemd here hand a credential to a service? In some containers it can't (it has no way
    // to make the memory-only folder), and says nothing: the service would start without its key.
    const probe = await run("systemd-run", ["--quiet", "--wait", "--collect", "--pipe", "-p", "User=" + account, "-p", (key.encrypted ? "LoadCredentialEncrypted=" : "LoadCredential=") + CREDENTIAL + ":" + (key.encrypted ?? KEY_FILE), "sh", "-c", 'test -r "$CREDENTIALS_DIRECTORY/' + CREDENTIAL + '"']);
    let keyNote;
    if (probe.code !== 0) {
      if (key.encrypted || encryptedKey) throw new Error("systemd on this computer can't hand a credential to a service, so an encrypted host key can't be used here. Install without --encrypted-key.");
      // The next best: the file stays root's, outside the data folder, and the service's group may read it.
      say("systemd here can't hand a credential to a service (usual inside a container): the service's group reads the key file instead.");
      own(at(KEY_FILE), 0, ids.gid);
      chmodSync(at(KEY_FILE), 0o440);
      key = { groupFile: KEY_FILE };
      keyNote = "key file (" + KEY_FILE + ", readable by root and the group " + account + ")";
    }
    if (encryptedKey && key.file) {
      // Encrypted to this machine (its TPM when it has one, else its own secret): a copy of the file is useless elsewhere.
      say("Encrypting the host key to this machine with systemd-creds.");
      await must("systemd-creds", ["encrypt", "--name=" + CREDENTIAL, at(KEY_FILE), at(encrypted)], "Encrypting the host key");
      chmodSync(at(encrypted), 0o400);
      const back = await must("systemd-creds", ["decrypt", "--name=" + CREDENTIAL, at(encrypted), "-"], "Checking the encrypted host key");
      if (back.stdout.trim() !== readFileSync(at(KEY_FILE), "utf8").trim()) throw new Error("The encrypted host key didn't read back as it was written. Nothing was changed.");
      rmSync(at(KEY_FILE));
      key = { encrypted };
    }
    write(files.systemd.system, systemUnit({ command, dataDir, user: account, home: accountHome, key, allowPaths }), 0o644);
    for (const [name, text] of Object.entries(updateUnits({ command, dataDir }))) write("/etc/systemd/system/" + name, text, 0o644);
    write(INSTALL_RECORD, JSON.stringify({ version: 1, scope: "system", dataDir, user: account, command }, null, 2) + "\n", 0o644);
    await must("systemctl", ["daemon-reload"], "Reloading systemd");
    await must("systemctl", ["enable", UNIT, UPDATE_PATH_UNIT], "Enabling the service");
    if (start) {
      await must("systemctl", ["restart", UPDATE_PATH_UNIT], "Starting the update watch");
      await must("systemctl", ["restart", UNIT], "Starting the service");
    }
    return { file: files.systemd.system, dataDir, user: account, key: keyNote ?? (key.encrypted ? "encrypted with systemd-creds (" + key.encrypted + "), handed over as a systemd credential" : "root-only key file (" + KEY_FILE + "), handed over as a systemd credential") };
  }

  async function installUser({ dataDir = userRoot({ platform: "linux", env, home }), start }) {
    const keyFile = join(env.XDG_CONFIG_HOME || join(home, ".config"), "botkins", "host.key");
    mkdirSync(at(dataDir), { recursive: true, mode: 0o700 });
    write(files.systemd.user, userUnit({ command, dataDir, keyFile, env: ownPath() }), 0o644);
    await must(...systemctl("user")(["daemon-reload"]), "Reloading systemd");
    await must(...systemctl("user")(["enable", UNIT]), "Enabling the service");
    // Lingering keeps a person's services running while they are signed out, and starts them with the computer.
    const linger = await run("loginctl", ["enable-linger", user]);
    if (start) await must(...systemctl("user")(["restart", UNIT]), "Starting the service");
    return { file: files.systemd.user, dataDir, user, key: "key file (" + keyFile + ")", ...(linger.code !== 0 && { note: "Lingering couldn't be switched on, so the service stops when you sign out. Switch it on with: sudo loginctl enable-linger " + user }) };
  }

  async function installLaunchd({ scope, dataDir, runAs, start }) {
    const system = scope === "system";
    const account = system ? (runAs ?? env.SUDO_USER) : user;
    if (system && (!account || account === "root")) throw new Error("Say which user the service runs as: `sudo botkins service install --system --run-as <user>`.");
    const folder = dataDir ?? (system ? systemRoot("darwin") : userRoot({ platform: "darwin", home }));
    const logFile = join(folder, "logs", "launchd.log");
    const fresh = !existsSync(at(folder));
    mkdirSync(at(join(folder, "logs")), { recursive: true, mode: 0o700 });
    chmodSync(at(folder), 0o700);
    let keyNote = "macOS keychain of " + account;
    const extra = system ? {} : ownPath();
    if (system) {
      const ids = { uid: Number((await must("id", ["-u", account], "Reading the user " + account)).stdout.trim()), gid: Number((await must("id", ["-g", account], "Reading the user " + account)).stdout.trim()) };
      if (fresh) for (const dir of [folder, join(folder, "logs")]) own(at(dir), ids.uid, ids.gid);
      // A daemon has no keychain session to ask: its key is a file only its user reads, outside the data folder.
      if (!existsSync(at(KEY_FILE))) {
        mkdirSync(at(dirname(KEY_FILE)), { recursive: true, mode: 0o755 });
        writeFileSync(at(KEY_FILE), randomBytes(32).toString("base64") + "\n", { mode: 0o400, flag: "wx" });
        own(at(KEY_FILE), ids.uid, ids.gid);
      }
      extra.BOTKINS_KEY_FILE = KEY_FILE;
      extra.HOME = (await run("sh", ["-c", 'eval echo "~$0"', account])).stdout.trim() || "/Users/" + account;
      keyNote = "key file (" + KEY_FILE + ", readable by " + account + " only)";
      write(INSTALL_RECORD, JSON.stringify({ version: 1, scope: "system", dataDir: folder, user: account, command }, null, 2) + "\n", 0o644);
    }
    const file = files.launchd[scope];
    // A job that is loaded is taken out first, so the new file is the one that runs.
    await run("launchctl", ["bootout", domain(scope) + "/" + LABEL]);
    write(file, launchdJob({ command, dataDir: folder, logFile, ...(system && { user: account }), env: extra }), 0o644);
    if (start) {
      await must("launchctl", ["bootstrap", domain(scope), at(file)], "Loading the service");
      await run("launchctl", ["enable", domain(scope) + "/" + LABEL]);
    }
    return { file, dataDir: folder, user: account, key: keyNote };
  }

  /** Removes the service's files. The data folder, the key and the user stay: they are the person's to remove. */
  async function uninstall() {
    const found = need();
    if (found.kind === "launchd") {
      await run("launchctl", ["bootout", domain(found.scope) + "/" + LABEL]);
      rmSync(at(found.file), { force: true });
    } else {
      const ctl = systemctl(found.scope);
      await run(...ctl(["disable", "--now", UNIT, ...(found.scope === "system" ? [UPDATE_PATH_UNIT] : [])]));
      rmSync(at(found.file), { force: true });
      if (found.scope === "system") for (const name of [UPDATE_UNIT, UPDATE_PATH_UNIT]) rmSync(at("/etc/systemd/system/" + name), { force: true });
      await run(...ctl(["daemon-reload"]));
    }
    if (found.scope === "system") rmSync(at(INSTALL_RECORD), { force: true });
    return found;
  }

  async function act(verb) {
    const found = need();
    if (found.kind === "systemd") return void (await must(...systemctl(found.scope)([verb, UNIT]), verb[0].toUpperCase() + verb.slice(1) + "ing the service"));
    const target = domain(found.scope) + "/" + LABEL;
    const loaded = (await run("launchctl", ["print", target])).code === 0;
    if (verb === "stop") {
      // Ended on purpose: launchd leaves a job that ended well alone until it is started again.
      if (loaded) await must("launchctl", ["kill", "SIGTERM", target], "Stopping the service");
      return;
    }
    if (!loaded) await must("launchctl", ["bootstrap", domain(found.scope), at(found.file)], "Loading the service");
    await must("launchctl", ["kickstart", ...(verb === "restart" ? ["-k"] : []), target], verb === "restart" ? "Restarting the service" : "Starting the service");
  }

  /** { installed, kind?, scope?, file?, active, enabled, pid?, since?, restarts? } */
  async function status() {
    const found = installed();
    if (!found) return { installed: false, active: false, enabled: false };
    if (found.kind === "systemd") {
      const ctl = systemctl(found.scope);
      const show = await run(...ctl(["show", UNIT, "--property=ActiveState,SubState,MainPID,NRestarts,ActiveEnterTimestamp,UnitFileState"]));
      const fields = Object.fromEntries(show.stdout.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
      return { installed: true, ...found, active: fields.ActiveState === "active", state: [fields.ActiveState, fields.SubState].filter(Boolean).join("/") || "unknown", enabled: fields.UnitFileState === "enabled", ...(Number(fields.MainPID) > 0 && { pid: Number(fields.MainPID) }), ...(fields.NRestarts !== undefined && { restarts: Number(fields.NRestarts) }), ...(fields.ActiveEnterTimestamp && { since: fields.ActiveEnterTimestamp }) };
    }
    const print = await run("launchctl", ["print", domain(found.scope) + "/" + LABEL]);
    const pid = Number(/^\s*pid = (\d+)/m.exec(print.stdout)?.[1] ?? 0);
    const state = /^\s*state = (\S+)/m.exec(print.stdout)?.[1] ?? (print.code === 0 ? "loaded" : "not loaded");
    return { installed: true, ...found, active: pid > 0, state, enabled: print.code === 0, ...(pid > 0 && { pid }) };
  }

  return { installed, install, uninstall, start: () => act("start"), stop: () => act("stop"), restart: () => act("restart"), status, files };
}
