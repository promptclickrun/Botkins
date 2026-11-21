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
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { CREDENTIAL } from "../host/keystore.mjs";
import { INSTALL_RECORD, SERVICE_USER, systemRoot, userRoot } from "./paths.mjs";
import { LABEL, launchdJob, odd, readLaunchdJob, readSystemUnit, readUserUnit, strange, systemUnit, UNIT, UPDATE_PATH_UNIT, UPDATE_UNIT, updateUnits, userUnit, withoutOdd } from "./units.mjs";
import { asOwnerOf } from "./update-install.mjs";

/** What is at a path, without following a link there; null when nothing is. */
function existing(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

export const KEY_FILE = "/etc/botkins/host.key";
/** The names the service's own files have in the service manager's folder. A person's additions (`systemctl edit` makes a folder) are not among them. */
const OWN_FILES = { systemd: /^botkins[A-Za-z0-9@_.-]*\.(service|path|timer|socket|target)$/, launchd: /^app\.botkins\.terminal[A-Za-z0-9_.-]*\.plist$/ };
const installRecordText = ({ dataDir, user, command }) => JSON.stringify({ version: 1, scope: "system", dataDir, user, command }, null, 2) + "\n";

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
export function serviceManager({ command, platform = process.platform, uid = process.getuid?.() ?? 0, home = homedir(), user = userInfo().username, env = process.env, run = tool, root = "", say = () => {}, own = chownSync, pause = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
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
    // The data folder itself sits in a folder that is root's, so its name can't be swapped under
    // this. It has to be a real folder: a link or a file in its place is refused, never followed.
    const there = existing(at(dataDir));
    if (there && !there.isDirectory()) throw new Error(dataDir + " is not a folder (a link or a file is in its place). Move it aside, or name another data folder with --data-dir.");
    if (!there) {
      mkdirSync(at(dirname(dataDir)), { recursive: true });
      mkdirSync(at(dataDir), { mode: 0o700 });
    }
    chmodSync(at(dataDir), 0o700);
    // A folder that was already there keeps what is in it as it is; only the folder itself is made the service's.
    if (!there || there.uid !== ids.uid) own(at(dataDir), ids.uid, ids.gid);
    // Everything inside the data folder is the service user's, and so is every tool a bot runs:
    // a name in there may have been made a link to anywhere. Root makes the home folder with
    // that user's rights and changes no owner or mode inside, so such a link leads nowhere new.
    asOwnerOf(at(dataDir), () => mkdirSync(at(accountHome), { recursive: true, mode: 0o700 }));
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
    write(INSTALL_RECORD, installRecordText({ dataDir, user: account, command }), 0o644);
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
    const there = existing(at(folder));
    if (there && !there.isDirectory()) throw new Error(folder + " is not a folder (a link or a file is in its place). Move it aside, or name another data folder with --data-dir.");
    const fresh = !there;
    if (fresh) mkdirSync(at(folder), { recursive: true, mode: 0o700 });
    chmodSync(at(folder), 0o700);
    let keyNote = "macOS keychain of " + account;
    const extra = system ? {} : ownPath();
    if (system) {
      const ids = { uid: Number((await must("id", ["-u", account], "Reading the user " + account)).stdout.trim()), gid: Number((await must("id", ["-g", account], "Reading the user " + account)).stdout.trim()) };
      if (fresh) own(at(folder), ids.uid, ids.gid);
      // A daemon has no keychain session to ask: its key is a file only its user reads, outside the data folder.
      if (!existsSync(at(KEY_FILE))) {
        mkdirSync(at(dirname(KEY_FILE)), { recursive: true, mode: 0o755 });
        writeFileSync(at(KEY_FILE), randomBytes(32).toString("base64") + "\n", { mode: 0o400, flag: "wx" });
        own(at(KEY_FILE), ids.uid, ids.gid);
      }
      extra.BOTKINS_KEY_FILE = KEY_FILE;
      extra.HOME = (await run("sh", ["-c", 'eval echo "~$0"', account])).stdout.trim() || "/Users/" + account;
      keyNote = "key file (" + KEY_FILE + ", readable by " + account + " only)";
      write(INSTALL_RECORD, installRecordText({ dataDir: folder, user: account, command }), 0o644);
    }
    // The log folder is inside the data folder: made with its owner's rights, as everything in there is.
    asOwnerOf(at(folder), () => mkdirSync(at(join(folder, "logs")), { recursive: true, mode: 0o700 }));
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

  // Keeping the service's files up to date.
  //
  // A release may change what a service file says: one more line that closes something off, a
  // changed way to start. `refresh` writes the files this version would install, for the service
  // that is installed, with everything the person chose when they installed it. An update runs it
  // (desktop/terminal/update-install.mjs): the old version's updater asks the new version, which
  // is in place by then, to write its own files. `snapshot` and `restore` are the other half: the
  // updater keeps what the files held, and puts that back when it puts the old version back.

  const read = (path) => {
    try {
      return lstatSync(at(path)).isFile() ? readFileSync(at(path), "utf8") : null;
    } catch {
      return null;
    }
  };
  /** Takes a launchd job out, changes its file, and loads it again: launchd reads a job's file only when it loads it. */
  async function loadAgain(scope, file, change) {
    const target = domain(scope) + "/" + LABEL;
    await run("launchctl", ["bootout", target]);
    // launchd lets go of a job only when its process has ended, and refuses to load it before that.
    for (let tries = 0; tries < 150 && (await run("launchctl", ["print", target])).code === 0; tries++) await pause(200);
    change();
    await must("launchctl", ["bootstrap", domain(scope), at(file)], "Loading the service");
    await run("launchctl", ["enable", target]);
  }

  /**
   * Puts a whole file under a name in one step: written beside it, then renamed. systemd or
   * launchd, reading the folder at that moment, finds the old file or the new one, never half
   * of one; and a link under the name is replaced, not written through.
   */
  const replace = (path, text) => {
    const temp = join(dirname(at(path)), "." + basename(path) + "." + randomBytes(6).toString("hex"));
    try {
      writeFileSync(temp, text, { mode: 0o644, flag: "wx" });
      chmodSync(temp, 0o644);
      renameSync(temp, at(path));
    } finally {
      rmSync(temp, { force: true });
    }
  };

  /**
   * The files this version would write for the installed service, from what its own file says
   * was chosen: { texts: { path: text }, kept: [{ file, lines }] }. `kept` are the files that
   * hold a setting no version of Botkins wrote: the person's own, which a new text would lose.
   * They are left as they are, and are not in `texts`.
   */
  function wanted(found) {
    const text = read(found.file);
    if (text === null) throw Object.assign(new Error("The installed service file " + found.file + " can't be read."), { code: "UNREADABLE_UNIT" });
    const kept = [];
    // A line that can't be carried into a new text for sure (a variable written in a way of the
    // person's own, a line that is no setting) decides it before any text is made: the file stays.
    const own = odd(found.kind, text);
    if (own.length) kept.push({ file: found.file, lines: own });
    const main = (make) => (own.length ? {} : { [found.file]: make() });
    let texts;
    if (found.kind === "launchd") {
      const chosen = readLaunchdJob(text);
      texts = { ...main(() => launchdJob(chosen)), ...(found.scope === "system" && chosen.user && { [INSTALL_RECORD]: installRecordText(chosen) }) };
    } else if (found.scope === "user") texts = main(() => userUnit(readUserUnit(text)));
    else {
      // The other files are made from what this one says was chosen, read without the lines that are the person's own.
      const chosen = readSystemUnit(own.length ? withoutOdd(text) : text);
      texts = { ...main(() => systemUnit(chosen)), ...Object.fromEntries(Object.entries(updateUnits(chosen)).map(([name, unit]) => ["/etc/systemd/system/" + name, unit])), [INSTALL_RECORD]: installRecordText(chosen) };
    }
    for (const path of Object.keys(texts)) {
      const now = path === INSTALL_RECORD ? null : read(path);
      if (now === null || now === texts[path]) continue;
      let lines;
      try {
        lines = strange(found.kind, now, texts[path]);
      } catch {
        // Not a file of the kind Botkins writes at all.
        lines = ["(it can't be read as a service file)"];
      }
      if (!lines.length) continue;
      kept.push({ file: path, lines });
      delete texts[path];
    }
    return { texts, kept };
  }

  /**
   * Brings the installed service's files up to date with this version.
   *
   * A file that is replaced is kept once more beside it, as <name>.bak. A file that holds a
   * setting of the person's own that can't be carried into the new text is not replaced at all.
   *
   * @param options.write    false only says which files differ, and changes nothing.
   * @param options.restart  Restart the service when a file changed, so it runs with the new one.
   *   (On macOS a changed job is loaded again either way, which starts it.)
   * @returns { kind, scope, file, changed: [paths], kept: [{ file, lines }] }
   */
  async function refresh({ write: writing = true, restart = false } = {}) {
    const found = installed();
    if (!found) throw Object.assign(new Error("Botkins isn't installed as a service here. Install it with `botkins service install`."), { code: "NOT_INSTALLED" });
    const { texts, kept } = wanted(found);
    const before = Object.fromEntries(Object.keys(texts).map((path) => [path, read(path)]));
    // Where something other than a plain file is under a name (a unit the person masked is a link), it is theirs and stays.
    const changed = Object.keys(texts).filter((path) => before[path] !== texts[path] && (before[path] !== null || !existing(at(path))));
    if (!writing || !changed.length) return { ...found, changed, kept };
    if (found.scope === "system" && uid !== 0) throw Object.assign(new Error("The Botkins service belongs to the whole computer: run this as root (with sudo)."), { code: "NEEDS_ROOT" });
    const put = () => {
      for (const path of changed) {
        mkdirSync(dirname(at(path)), { recursive: true });
        if (before[path] !== null) replace(path + ".bak", before[path]);
        replace(path, texts[path]);
      }
    };
    if (found.kind === "launchd") {
      // Only the job's own file needs launchd to load it again.
      if (changed.includes(found.file)) await loadAgain(found.scope, found.file, put);
      else put();
      return { ...found, changed, kept };
    }
    const ctl = systemctl(found.scope);
    const names = changed.filter((path) => path !== INSTALL_RECORD).map((path) => basename(path));
    // What the person switched off stays off: only a unit that starts with the computer now is linked again.
    const enabled = [];
    for (const name of names) if (before[dirname(found.file) + "/" + name] !== null && (await run(...ctl(["is-enabled", name]))).stdout.trim() === "enabled") enabled.push(name);
    put();
    if (names.length) {
      await must(...ctl(["daemon-reload"]), "Reloading systemd");
      for (const name of enabled) await must(...ctl(["reenable", name]), "Enabling " + name);
      // The watch that starts the update job. This may run inside that job, which is left alone.
      if (names.includes(UPDATE_PATH_UNIT)) {
        if (before["/etc/systemd/system/" + UPDATE_PATH_UNIT] === null) await must(...ctl(["enable", "--now", UPDATE_PATH_UNIT]), "Starting the update watch");
        else await must(...ctl(["try-restart", UPDATE_PATH_UNIT]), "Restarting the update watch");
      }
      if (restart) await must(...ctl(["restart", UNIT]), "Restarting the service");
    }
    return { ...found, changed, kept };
  }

  /** What the service's own files hold now: { kind, scope, file, dir, files: { path: text } }, or null when no service is installed. */
  function snapshot() {
    const found = installed();
    if (!found) return null;
    const dir = dirname(found.file);
    const files = {};
    for (const name of readdirSync(at(dir))) if (OWN_FILES[found.kind].test(name) && read(dir + "/" + name) !== null) files[dir + "/" + name] = read(dir + "/" + name);
    if (found.scope === "system" && read(INSTALL_RECORD) !== null) files[INSTALL_RECORD] = read(INSTALL_RECORD);
    return { ...found, dir, files };
  }

  /**
   * Puts the service's files back as a snapshot has them, and has the service manager read them
   * again: what changed since is written as it was.
   *
   * A file that was not there is removed when it has a name of the service's own and is one the
   * refresh said it wrote (`written`): a unit somebody else added meanwhile is not this update's
   * to take away. When the refresh never said what it wrote (it ended badly), nothing tells its
   * files from anyone else's, so every file with a name of the service's own that the snapshot
   * doesn't hold is taken for one it added (`written` null).
   *
   * The service manager is told every time, also when the files already are as the snapshot has
   * them. This may be the second try, after a first one that wrote the files and then failed to
   * have them read: the files on disk say nothing of what systemd or launchd has loaded.
   *
   * @returns true when a file was put back or removed.
   */
  async function restore(saved, written = null) {
    if (!saved) return false;
    const now = snapshot() ?? { files: {} };
    const added = Object.keys(now.files).filter((path) => !(path in saved.files) && (written === null || written.includes(path)));
    const back = Object.keys(saved.files).filter((path) => now.files[path] !== saved.files[path]);
    const put = () => {
      for (const path of added) rmSync(at(path), { force: true });
      // Whatever is under the name now goes: a link there is replaced, never written through.
      for (const path of back) replace(path, saved.files[path]);
    };
    if (saved.kind === "launchd") {
      await loadAgain(saved.scope, saved.file, put);
      return added.length + back.length > 0;
    }
    const ctl = systemctl(saved.scope);
    // A unit the newer version added is stopped and unlinked before its file goes.
    for (const path of added) if (path !== INSTALL_RECORD) await run(...ctl(["disable", "--now", basename(path)]));
    put();
    await must(...ctl(["daemon-reload"]), "Reloading systemd");
    // The newer version may have linked a unit to start somewhere else: the links are made again from the files that are back.
    const units = Object.keys(saved.files).filter((path) => path !== INSTALL_RECORD).map((path) => basename(path));
    for (const name of units) if ((await run(...ctl(["is-enabled", name]))).stdout.trim() === "enabled") await run(...ctl(["reenable", name]));
    if (units.includes(UPDATE_PATH_UNIT)) await run(...ctl(["try-restart", UPDATE_PATH_UNIT]));
    return added.length + back.length > 0;
  }

  /** Removes the service's files. The data folder, the key and the user stay: they are the person's to remove. */
  async function uninstall() {
    const found = need();
    // Each file goes with the copy a refresh may have kept beside it (<name>.bak).
    const gone = (path) => {
      for (const file of [path, path + ".bak"]) rmSync(at(file), { force: true });
    };
    if (found.kind === "launchd") {
      await run("launchctl", ["bootout", domain(found.scope) + "/" + LABEL]);
      gone(found.file);
    } else {
      const ctl = systemctl(found.scope);
      await run(...ctl(["disable", "--now", UNIT, ...(found.scope === "system" ? [UPDATE_PATH_UNIT] : [])]));
      gone(found.file);
      if (found.scope === "system") for (const name of [UPDATE_UNIT, UPDATE_PATH_UNIT]) gone("/etc/systemd/system/" + name);
      await run(...ctl(["daemon-reload"]));
    }
    if (found.scope === "system") gone(INSTALL_RECORD);
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

  return { installed, install, uninstall, refresh, snapshot, restore, start: () => act("start"), stop: () => act("stop"), restart: () => act("restart"), status, files };
}
