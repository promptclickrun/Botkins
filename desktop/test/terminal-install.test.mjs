// Keeping the terminal host running and up to date: the service files it installs
// (desktop/terminal/units.mjs, manager.mjs), and how it installs a new release
// (desktop/terminal/update-install.mjs). Nothing here touches the computer's own services: every
// file goes into a folder of the test's own, and every system tool is a stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownCommand } from "../cli/commands/install.mjs";
import { keyFrom } from "../desktop/host/keystore.mjs";
import { serviceManager } from "../desktop/terminal/manager.mjs";
import { launchdJob, systemUnit, updateUnits, userUnit } from "../desktop/terminal/units.mjs";
import { applyUpdate, asOwnerOf, assetName, cleanLastUpdate, folderName, installLayout, lastUpdateFile, readLastUpdate, switchTo, takeRequest, unmanaged, writeLastUpdate } from "../desktop/terminal/update-install.mjs";
import { defaults } from "../desktop/terminal/config.mjs";
import { terminalUpdates } from "../desktop/terminal/updates.mjs";
import { AppUpdates } from "../desktop/updates.mjs";

const skip = process.platform === "win32" && "The terminal host runs on Linux and macOS.";
const tempDir = (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bk-inst-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const command = ["/opt/botkins/current/bin/botkins"];
/** Stand-ins for systemctl, loginctl, useradd, id and launchctl: every call is kept, and `answers` says how each ends. */
function tools(answers = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args].join(" "));
    for (const [prefix, answer] of Object.entries(answers)) if ([file, ...args].join(" ").startsWith(prefix)) return { code: 0, stdout: "", stderr: "", ...(typeof answer === "function" ? answer(args) : answer) };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

test("the system unit runs as its own user, writes only its data folder and gets its key as a credential", () => {
  const unit = systemUnit({ command, dataDir: "/var/lib/botkins", key: { file: "/etc/botkins/host.key" }, allowPaths: ["/srv/projects", "/srv/my notes"] });
  for (const line of [
    "User=botkins",
    "Group=botkins",
    "ExecStart=/opt/botkins/current/bin/botkins serve",
    "Restart=on-failure",
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    'ReadWritePaths=/var/lib/botkins /srv/projects "/srv/my notes"',
    "ProtectHome=true",
    "PrivateTmp=true",
    "PrivateDevices=true",
    "ProtectKernelTunables=true",
    "ProtectKernelModules=true",
    "ProtectControlGroups=true",
    "RestrictSUIDSGID=true",
    "LockPersonality=true",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
    "UMask=0077",
    "LoadCredential=botkins-key:/etc/botkins/host.key",
    "Environment=BOTKINS_KEY_SOURCE=systemd",
    "Environment=BOTKINS_DATA_DIR=/var/lib/botkins",
    "Environment=HOME=/var/lib/botkins/home",
    "WantedBy=multi-user.target",
    "After=network-online.target",
  ])
    assert.ok(unit.split("\n").includes(line), line + " is in the unit");
  // Node's compiler needs writable code pages, and the providers' tools bring sandboxes of their own.
  for (const absent of ["MemoryDenyWriteExecute", "RestrictNamespaces", "SystemCallFilter"]) assert.ok(!unit.includes(absent + "="), absent);
  assert.match(systemUnit({ command, dataDir: "/var/lib/botkins", key: { encrypted: "/etc/botkins/host.key.cred" } }), /^LoadCredentialEncrypted=botkins-key:\/etc\/botkins\/host\.key\.cred$/m);
  // Where systemd can't hand a credential over, the unit names a key file instead, and says so.
  const grouped = systemUnit({ command, dataDir: "/var/lib/botkins", key: { groupFile: "/etc/botkins/host.key" } });
  assert.ok(grouped.includes("Environment=BOTKINS_KEY_SOURCE=file\nEnvironment=BOTKINS_KEY_FILE=/etc/botkins/host.key") && !grouped.includes("LoadCredential"));
  // A checkout is started with Node and its own file; a value systemd would expand is escaped.
  assert.match(systemUnit({ command: ["/usr/bin/node", "/srv/my botkins/cli/botkins.mjs"], dataDir: "/var/lib/botkins" }), /^ExecStart=\/usr\/bin\/node "\/srv\/my botkins\/cli\/botkins\.mjs" serve$/m);
  assert.match(systemUnit({ command, dataDir: "/var/lib/botkins", env: { NOTE: "100% $HOME" } }), /^Environment="NOTE=100%% \$\$HOME"$/m);
  for (const bad of [{ command, dataDir: "relative" }, { command, dataDir: "/var/lib/../etc" }, { command, dataDir: "/var/lib/botkins", user: "root; rm -rf /" }, { command, dataDir: "/var/lib/botkins", allowPaths: ["/srv\nExecStartPre=/bin/sh"] }]) assert.throws(() => systemUnit(bad), /path in a service file|isn't a user's name/);
});

test("one person's unit and the launchd job keep the service running, and say only what is true of them", () => {
  const unit = userUnit({ command, dataDir: "/home/sam/.local/share/botkins", keyFile: "/home/sam/.config/botkins/host.key" });
  for (const line of ["ExecStart=/opt/botkins/current/bin/botkins serve", "Restart=on-failure", "NoNewPrivileges=true", "UMask=0077", "Environment=BOTKINS_KEY_FILE=/home/sam/.config/botkins/host.key", "WantedBy=default.target"]) assert.ok(unit.split("\n").includes(line), line);
  assert.ok(!unit.includes("User="), "it runs as the person, and names no other user");
  assert.ok(!unit.includes("ProtectSystem"), "it doesn't claim a protection a person's own unit can't have");
  const { "botkins-update.service": job, "botkins-update.path": watch } = updateUnits({ command, dataDir: "/var/lib/botkins" });
  assert.match(job, /^ExecStart=\/opt\/botkins\/current\/bin\/botkins update --apply$/m);
  assert.match(job, /^Type=oneshot$/m);
  assert.ok(!job.includes("User="), "the update job is root's");
  assert.match(watch, /^PathExists=\/var\/lib\/botkins\/run\/update-requested$/m);
  assert.match(watch, /^Unit=botkins-update\.service$/m);
  const agent = launchdJob({ command: ["/usr/local/bin/node", "/Users/sam/b&b/cli/botkins.mjs"], dataDir: "/Users/sam/Library/Application Support/Botkins Terminal", logFile: "/Users/sam/Library/Application Support/Botkins Terminal/logs/launchd.log" });
  assert.match(agent, /<key>Label<\/key>\n  <string>app\.botkins\.terminal<\/string>/);
  assert.match(agent, /<string>\/Users\/sam\/b&amp;b\/cli\/botkins\.mjs<\/string>\n    <string>serve<\/string>/);
  assert.match(agent, /<key>KeepAlive<\/key>\n  <dict>\n    <key>SuccessfulExit<\/key>\n    <false\/>/, "started again when it ends badly, left alone when stopped on purpose");
  assert.match(agent, /<key>RunAtLoad<\/key>\n  <true\/>/);
  assert.match(agent, /<key>Umask<\/key>\n  <integer>63<\/integer>/, "0077");
  assert.ok(!agent.includes("UserName"));
  assert.match(launchdJob({ command, dataDir: "/Library/Application Support/Botkins Terminal", logFile: "/Library/Application Support/Botkins Terminal/logs/launchd.log", user: "sam", env: { BOTKINS_KEY_FILE: "/etc/botkins/host.key" } }), /<key>UserName<\/key>\n  <string>sam<\/string>[\s\S]*<key>BOTKINS_KEY_FILE<\/key>\n    <string>\/etc\/botkins\/host\.key<\/string>/);
  if (process.platform === "darwin") {
    // macOS reads it as a property list.
    const file = join(mkdtempSync(join(tmpdir(), "bk-plist-")), "job.plist");
    writeFileSync(file, agent);
    execFileSync("/usr/bin/plutil", ["-lint", file]);
    rmSync(join(file, ".."), { recursive: true, force: true });
  }
});

test("installing for the whole computer makes the user, the folders, a root-only key and the units, and starts them", { skip }, async (t) => {
  const root = tempDir(t);
  let made = false;
  const { calls, run } = tools({ "useradd": () => ((made = true), {}), "id -u botkins": () => (made ? { stdout: "998\n" } : { code: 1 }), "id -g botkins": { stdout: "998\n" } });
  const owned = [];
  const said = [];
  const manager = serviceManager({ command, platform: "linux", uid: 0, home: "/root", user: "root", env: {}, run, root, say: (line) => said.push(line), own: (path, uid, gid) => owned.push([path.slice(root.length), uid, gid]) });
  assert.equal(manager.installed(), null);
  assert.deepEqual(await manager.status(), { installed: false, active: false, enabled: false });
  const result = await manager.install({ allowPaths: ["/srv/projects"] });
  assert.deepEqual([result.kind, result.scope, result.file, result.dataDir, result.user], ["systemd", "system", "/etc/systemd/system/botkins.service", "/var/lib/botkins", "botkins"]);
  assert.match(result.key, /root-only key file \(\/etc\/botkins\/host\.key\)/);
  assert.deepEqual(calls, [
    "id -u botkins",
    "useradd --system --user-group --home-dir /var/lib/botkins/home --no-create-home --shell /usr/sbin/nologin botkins",
    "id -u botkins",
    "id -g botkins",
    'systemd-run --quiet --wait --collect --pipe -p User=botkins -p LoadCredential=botkins-key:/etc/botkins/host.key sh -c test -r "$CREDENTIALS_DIRECTORY/botkins-key"',
    "systemctl daemon-reload",
    "systemctl enable botkins.service botkins-update.path",
    "systemctl restart botkins-update.path",
    "systemctl restart botkins.service",
  ]);
  // Root makes the data folder the service's. What is inside it (the home folder too) is made with
  // the service user's rights, and root changes no owner and no mode in there.
  assert.deepEqual(owned, [["/var/lib/botkins", 998, 998]]);
  assert.ok(existsSync(root + "/var/lib/botkins/home"));
  assert.equal(statSync(root + "/var/lib/botkins").mode & 0o777, 0o700);
  // The key: 32 random bytes, readable by root alone, and outside the data folder.
  assert.equal(statSync(root + "/etc/botkins/host.key").mode & 0o777, 0o400);
  const key = readFileSync(root + "/etc/botkins/host.key");
  assert.equal(keyFrom(key).length, 32);
  const unit = readFileSync(root + "/etc/systemd/system/botkins.service", "utf8");
  assert.match(unit, /^LoadCredential=botkins-key:\/etc\/botkins\/host\.key$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/botkins \/srv\/projects$/m);
  assert.ok(existsSync(root + "/etc/systemd/system/botkins-update.service") && existsSync(root + "/etc/systemd/system/botkins-update.path"));
  assert.deepEqual(JSON.parse(readFileSync(root + "/etc/botkins/install.json", "utf8")), { version: 1, scope: "system", dataDir: "/var/lib/botkins", user: "botkins", command });
  assert.deepEqual(manager.installed(), { kind: "systemd", scope: "system", file: "/etc/systemd/system/botkins.service" });
  // Installing again changes neither the key nor who owns what is already there.
  calls.length = 0;
  owned.length = 0;
  await manager.install({ start: false });
  assert.deepEqual(readFileSync(root + "/etc/botkins/host.key"), key);
  assert.ok(!calls.some((call) => call.startsWith("useradd") || call.includes("restart")));
  // What the computer's service manager says is passed on.
  const state = tools({ "systemctl show": { stdout: "ActiveState=active\nSubState=running\nMainPID=4242\nNRestarts=1\nActiveEnterTimestamp=Fri 2026-11-20 10:00:00 UTC\nUnitFileState=enabled\n" } });
  const status = await serviceManager({ command, platform: "linux", uid: 0, env: {}, run: state.run, root }).status();
  assert.deepEqual([status.installed, status.active, status.state, status.enabled, status.pid, status.restarts], [true, true, "active/running", true, 4242, 1]);
  // Where systemd can't hand a credential to a service, the key stays root's file and the service's group reads it.
  const boxed = tempDir(t);
  const chowned = [];
  const container = serviceManager({ command, platform: "linux", uid: 0, env: {}, run: tools({ "id -": { stdout: "998\n" }, "systemd-run": { code: 1 } }).run, root: boxed, own: (path, uid, gid) => chowned.push([path.slice(boxed.length), uid, gid]) });
  const fallback = await container.install();
  assert.match(fallback.key, /key file \(\/etc\/botkins\/host\.key, readable by root and the group botkins\)/);
  assert.equal(statSync(boxed + "/etc/botkins/host.key").mode & 0o777, 0o440);
  assert.ok(chowned.some(([path, uid, gid]) => path === "/etc/botkins/host.key" && uid === 0 && gid === 998));
  const boxedUnit = readFileSync(boxed + "/etc/systemd/system/botkins.service", "utf8");
  assert.ok(boxedUnit.includes("Environment=BOTKINS_KEY_FILE=/etc/botkins/host.key") && !boxedUnit.includes("LoadCredential"));
  await assert.rejects(serviceManager({ command, platform: "linux", uid: 0, env: {}, run: tools({ "id -": { stdout: "998\n" }, "systemd-run": { code: 1 } }).run, root: tempDir(t), own: () => {} }).install({ encryptedKey: true }), /an encrypted host key can't be used here/);
  // A name in the data folder may have been made a link by a bot's tool. An install run again
  // follows none: the home folder as a link to somewhere else leaves that place as it was.
  const planted = tempDir(t);
  const elsewhere = join(planted, "elsewhere");
  mkdirSync(elsewhere, { mode: 0o755 });
  mkdirSync(planted + "/var/lib/botkins", { recursive: true });
  symlinkSync(elsewhere, planted + "/var/lib/botkins/home");
  const touched = [];
  await serviceManager({ command, platform: "linux", uid: 0, env: {}, run: tools({ "id -": { stdout: "998\n" } }).run, root: planted, own: (path) => touched.push(path.slice(planted.length)) }).install({ start: false });
  assert.equal(statSync(elsewhere).mode & 0o777, 0o755, "the place the link points at keeps its mode");
  assert.ok(!touched.some((path) => path.includes("home")), "and root changes no owner through the link");
  // The data folder itself as a link, or as a file, is refused before anything is changed.
  for (const make of [(path) => symlinkSync(elsewhere, path), (path) => writeFileSync(path, "x")]) {
    const odd = tempDir(t);
    mkdirSync(odd + "/var/lib", { recursive: true });
    make(odd + "/var/lib/botkins");
    const changed = [];
    await assert.rejects(serviceManager({ command, platform: "linux", uid: 0, env: {}, run: tools({ "id -": { stdout: "998\n" } }).run, root: odd, own: (path) => changed.push(path) }).install(), /is not a folder \(a link or a file is in its place\)/);
    assert.deepEqual(changed, []);
    assert.equal(existsSync(odd + "/etc/systemd/system/botkins.service"), false);
  }
  assert.equal(statSync(elsewhere).mode & 0o777, 0o755);
  // Someone who isn't root is told so, and nothing is run.
  const other = tools();
  const user = serviceManager({ command, platform: "linux", uid: 1000, home: join(root, "home/sam"), user: "sam", env: {}, run: other.run, root });
  await assert.rejects(user.restart(), { code: "NEEDS_ROOT" });
  await assert.rejects(user.install({ scope: "system" }), { code: "NEEDS_ROOT" });
  assert.deepEqual(other.calls, []);
  // Removing the service leaves the data and the key.
  calls.length = 0;
  await manager.uninstall();
  assert.deepEqual(calls, ["systemctl disable --now botkins.service botkins-update.path", "systemctl daemon-reload"]);
  for (const gone of ["/etc/systemd/system/botkins.service", "/etc/systemd/system/botkins-update.path", "/etc/botkins/install.json"]) assert.equal(existsSync(root + gone), false, gone);
  assert.ok(existsSync(root + "/etc/botkins/host.key") && existsSync(root + "/var/lib/botkins"));
  await assert.rejects(manager.start(), { code: "NOT_INSTALLED" });
  // A failure of a system tool is said with the tool's own last words.
  const failing = serviceManager({ command, platform: "linux", uid: 0, env: {}, run: tools({ "systemctl daemon-reload": { code: 1, stderr: "Failed to connect to bus: No such file or directory\n" }, "id -g": { stdout: "998\n" }, "id -u": { stdout: "998\n" } }).run, root, own: () => {} });
  await assert.rejects(failing.install(), /Reloading systemd failed \(systemctl daemon-reload\): Failed to connect to bus/);
});

test("the host key can be encrypted to the machine, and is only kept that way once it reads back", { skip }, async (t) => {
  const root = tempDir(t);
  const { run, calls } = tools({
    "id -": { stdout: "998\n" },
    "systemd-creds encrypt": (args) => (writeFileSync(args[3], "ENCRYPTED"), {}),
    "systemd-creds decrypt": () => ({ stdout: readFileSync(root + "/etc/botkins/host.key", "utf8") }),
  });
  const manager = serviceManager({ command, platform: "linux", uid: 0, env: {}, run, root, own: () => {} });
  const result = await manager.install({ encryptedKey: true });
  assert.match(result.key, /encrypted with systemd-creds/);
  assert.equal(existsSync(root + "/etc/botkins/host.key"), false, "the plain key is gone");
  assert.equal(statSync(root + "/etc/botkins/host.key.cred").mode & 0o777, 0o400);
  assert.match(readFileSync(root + "/etc/systemd/system/botkins.service", "utf8"), /^LoadCredentialEncrypted=botkins-key:\/etc\/botkins\/host\.key\.cred$/m);
  assert.ok(calls.some((call) => call.startsWith("systemd-creds encrypt --name=botkins-key")));
  // A later install finds the encrypted key and makes no new one.
  await manager.install({});
  assert.equal(existsSync(root + "/etc/botkins/host.key"), false);
  const other = tempDir(t);
  const broken = serviceManager({ command, platform: "linux", uid: 0, env: {}, run: tools({ "id -": { stdout: "998\n" }, "systemd-creds encrypt": (args) => (writeFileSync(args[3], "ENCRYPTED"), {}), "systemd-creds decrypt": { stdout: "something else\n" } }).run, root: other, own: () => {} });
  await assert.rejects(broken.install({ encryptedKey: true }), /didn't read back/);
  assert.ok(existsSync(other + "/etc/botkins/host.key"), "the plain key stays when the encrypted one can't be trusted");
});

test("one person's install needs no root, lingers, and says so when lingering can't be switched on", { skip }, async (t) => {
  const root = tempDir(t);
  const home = "/home/sam";
  const { calls, run } = tools({ "loginctl enable-linger": { code: 1, stderr: "Access denied" } });
  const manager = serviceManager({ command: ["/home/sam/.local/share/botkins-terminal/current/bin/botkins"], platform: "linux", uid: 1000, home, user: "sam", env: { PATH: "/home/sam/.volta/bin:/usr/bin" }, run, root });
  const result = await manager.install();
  assert.deepEqual([result.scope, result.file, result.dataDir], ["user", "/home/sam/.config/systemd/user/botkins.service", "/home/sam/.local/share/botkins"]);
  assert.match(result.note, /sudo loginctl enable-linger sam/);
  assert.deepEqual(calls, ["systemctl --user daemon-reload", "systemctl --user enable botkins.service", "loginctl enable-linger sam", "systemctl --user restart botkins.service"]);
  assert.match(readFileSync(root + result.file, "utf8"), /^Environment=BOTKINS_KEY_FILE=\/home\/sam\/\.config\/botkins\/host\.key$/m);
  // The service finds the tools the person's own terminal finds.
  assert.match(readFileSync(root + result.file, "utf8"), /^Environment=PATH=\/home\/sam\/\.volta\/bin:\/usr\/bin$/m);
  calls.length = 0;
  await manager.stop();
  await manager.start();
  assert.deepEqual(calls, ["systemctl --user stop botkins.service", "systemctl --user start botkins.service"]);
  assert.equal((await serviceManager({ command, platform: "linux", uid: 1000, home, user: "sam", env: {}, run: tools().run, root }).install()).note, undefined);
});

test("on macOS the service is a launchd job: yours in your session, or the whole computer's as a named user", { skip }, async (t) => {
  const root = tempDir(t);
  const home = "/Users/sam";
  const { calls, run } = tools({ "launchctl print": { stdout: "\tstate = running\n\tpid = 4321\n" } });
  const manager = serviceManager({ command: ["/usr/local/bin/node", "/opt/botkins/cli/botkins.mjs"], platform: "darwin", uid: 501, home, user: "sam", env: {}, run, root });
  const result = await manager.install();
  assert.deepEqual([result.kind, result.scope, result.file, result.dataDir, result.key], ["launchd", "user", "/Users/sam/Library/LaunchAgents/app.botkins.terminal.plist", "/Users/sam/Library/Application Support/Botkins Terminal", "macOS keychain of sam"]);
  assert.deepEqual(calls, ["launchctl bootout gui/501/app.botkins.terminal", "launchctl bootstrap gui/501 " + root + result.file, "launchctl enable gui/501/app.botkins.terminal"]);
  assert.match(readFileSync(root + result.file, "utf8"), /<string>serve<\/string>/);
  assert.deepEqual(await manager.status(), { installed: true, kind: "launchd", scope: "user", file: result.file, active: true, state: "running", enabled: true, pid: 4321 });
  calls.length = 0;
  await manager.stop();
  await manager.restart();
  assert.deepEqual(calls, ["launchctl print gui/501/app.botkins.terminal", "launchctl kill SIGTERM gui/501/app.botkins.terminal", "launchctl print gui/501/app.botkins.terminal", "launchctl kickstart -k gui/501/app.botkins.terminal"]);
  // The whole computer's: a daemon that runs as a named user, with its key in a file of that user's.
  const system = tools({ "id -u sam": { stdout: "501\n" }, "id -g sam": { stdout: "20\n" }, "sh -c": { stdout: "/Users/sam\n" } });
  const owned = [];
  const daemon = serviceManager({ command, platform: "darwin", uid: 0, home: "/var/root", user: "root", env: { SUDO_USER: "sam" }, run: system.run, root: tempDir(t), own: (path, uid) => owned.push(uid) });
  const installed = await daemon.install();
  assert.deepEqual([installed.scope, installed.file, installed.user, installed.dataDir], ["system", "/Library/LaunchDaemons/app.botkins.terminal.plist", "sam", "/Library/Application Support/Botkins Terminal"]);
  assert.match(installed.key, /key file \(\/etc\/botkins\/host\.key, readable by sam only\)/);
  assert.ok(owned.every((uid) => uid === 501) && owned.length === 2, "the data folder and the key file; nothing inside the data folder");
  assert.ok(system.calls.includes("launchctl bootout system/app.botkins.terminal"));
  await assert.rejects(serviceManager({ command, platform: "darwin", uid: 0, user: "root", env: {}, run: tools().run, root: tempDir(t) }).install(), /Say which user the service runs as/);
});

/** A release tarball as scripts/package-terminal.mjs makes one, small. */
function release(dir, version, { arch = "arm64", extra = {} } = {}) {
  const name = folderName(version, "linux", arch);
  const stage = join(dir, "stage-" + version);
  for (const [file, text] of Object.entries({ "bin/botkins": "#!/bin/sh\n", "cli/botkins.mjs": "// " + version + "\n", "package.json": JSON.stringify({ version }), "desktop/linux-service/botkins-release.asc": "KEY", ...extra })) {
    mkdirSync(join(stage, name, file, ".."), { recursive: true });
    writeFileSync(join(stage, name, file), text);
  }
  const archive = join(dir, name + ".tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", stage, name]);
  return { name, archive, stage: join(stage, name) };
}
/** An install folder with `version` in use, as the installer leaves one. */
function installed(dir, version) {
  const installRoot = join(dir, "opt");
  const { stage, name } = release(dir, version);
  mkdirSync(installRoot);
  execFileSync("cp", ["-R", stage, join(installRoot, name)]);
  symlinkSync(name, join(installRoot, "current"));
  return { installRoot, entry: join(installRoot, "current", "cli", "botkins.mjs"), folder: join(installRoot, name) };
}

test("a release is told from a checkout by where it sits, and the service is started through `current`", { skip }, (t) => {
  const dir = tempDir(t);
  const { installRoot, entry, folder } = installed(dir, "1.2.3");
  assert.deepEqual(installLayout(entry), { installRoot, current: join(installRoot, "current"), folder, version: "1.2.3" });
  assert.deepEqual(ownCommand({ entry }), [join(installRoot, "current", "bin", "botkins")], "an update needs no new service file");
  const checkout = fileURLToPath(new URL("../cli/botkins.mjs", import.meta.url));
  assert.equal(installLayout(checkout), null);
  assert.deepEqual(ownCommand({ entry: checkout, node: "/usr/bin/node" }), ["/usr/bin/node", realpathSync(checkout)]);
  assert.equal(assetName("1.2.3", "linux", "arm64"), "botkins-terminal-1.2.3-linux-arm64.tar.gz");
  assert.equal(assetName("1.2.3", "darwin", "x64"), "botkins-terminal-1.2.3-macos-x64.tar.gz");
  for (const bad of [["1.2", "linux", "x64"], ["1.2.3-beta.1", "linux", "x64"], ["1.2.3", "linux", "riscv64"], ["1.2.3", "win32", "x64"]]) assert.throws(() => folderName(...bad), /no Botkins terminal host release/);
});

test("an update moves `current` to the new version in one step, and back when the new one doesn't stay up", { skip }, async (t) => {
  const dir = tempDir(t);
  const { installRoot } = installed(dir, "1.2.3");
  const next = release(dir, "1.3.0");
  const restarts = [];
  const steady = { restart: async () => void restarts.push(readlinkSync(join(installRoot, "current"))), status: async () => ({ active: true, pid: 77 }) };
  const done = await switchTo({ archive: next.archive, installRoot, version: "1.3.0", platform: "linux", arch: "arm64", manager: steady, healthMs: 60, pollMs: 10, checkOwner: false });
  assert.deepEqual(done, { version: "1.3.0", folder: join(installRoot, next.name), previous: "1.2.3" });
  assert.equal(realpathSync(join(installRoot, "current")), join(installRoot, next.name));
  assert.deepEqual(restarts, [join(installRoot, next.name)], "the service restarts once `current` is the new version");
  assert.ok(existsSync(join(installRoot, folderName("1.2.3", "linux", "arm64"))), "the old version stays on disk");
  assert.deepEqual(readFileSync(join(installRoot, "current", "cli", "botkins.mjs"), "utf8"), "// 1.3.0\n");
  // Nothing older, and nothing twice.
  await assert.rejects(switchTo({ archive: release(dir, "1.2.9").archive, installRoot, version: "1.2.9", platform: "linux", arch: "arm64", checkOwner: false }), /is not newer than the installed 1\.3\.0/);
  // A new version that dies, or keeps restarting, is taken back out.
  for (const [failure, manager] of [
    [/didn't stay running\. Botkins 1\.3\.0 was put back\./, { restart: async () => {}, status: async () => ({ active: false }) }],
    [/restarted while it was being watched\. Botkins 1\.3\.0 was put back\./, (() => { let pid = 100; return { restart: async () => {}, status: async () => ({ active: true, pid: pid++ }) }; })()],
    [/systemctl said no\. Botkins 1\.3\.0 was put back\./, (() => { let first = true; return { restart: async () => { if (first) { first = false; throw new Error("systemctl said no."); } }, status: async () => ({ active: true, pid: 1 }) }; })()],
  ]) {
    const bad = release(dir, "1.4.0");
    await assert.rejects(switchTo({ archive: bad.archive, installRoot, version: "1.4.0", platform: "linux", arch: "arm64", manager, healthMs: 40, pollMs: 5, checkOwner: false }), failure);
    assert.equal(realpathSync(join(installRoot, "current")), join(installRoot, next.name), "`current` is the version that worked");
    assert.equal(existsSync(join(installRoot, bad.name)), false, "the version that didn't work is removed");
    rmSync(join(dir, "stage-1.4.0"), { recursive: true });
  }
  // What a tarball holds is checked before any of it is used.
  const wrongVersion = release(dir, "1.5.0", { extra: { "package.json": JSON.stringify({ version: "9.9.9" }) } });
  await assert.rejects(switchTo({ archive: wrongVersion.archive, installRoot, version: "1.5.0", platform: "linux", arch: "arm64", checkOwner: false }), /own version isn't 1\.5\.0/);
  const stray = join(dir, "stray");
  mkdirSync(join(stray, folderName("1.6.0", "linux", "arm64")), { recursive: true });
  writeFileSync(join(stray, "outside.txt"), "x");
  const strayArchive = join(dir, "stray.tar.gz");
  execFileSync("tar", ["-czf", strayArchive, "-C", stray, folderName("1.6.0", "linux", "arm64"), "outside.txt"]);
  await assert.rejects(switchTo({ archive: strayArchive, installRoot, version: "1.6.0", platform: "linux", arch: "arm64", checkOwner: false }), /outside its own folder/);
  assert.equal(readdirNames(installRoot).some((name) => name.startsWith(".update-")), false, "nothing is left half unpacked");
  // As root, an install folder somebody else could write to is refused.
  await assert.rejects(switchTo({ archive: release(dir, "1.7.0").archive, installRoot, version: "1.7.0", platform: "linux", arch: "arm64", checkOwner: true }), /is not root's own/);
});
const readdirNames = (dir) => execFileSync("ls", ["-a", dir], { encoding: "utf8" }).split("\n");

test("an update is only ever the latest release, downloaded from the project's own address and verified before it is unpacked", { skip }, async (t) => {
  const dir = tempDir(t);
  const { installRoot, entry } = installed(dir, "1.2.3");
  const next = release(dir, "1.3.0");
  const assets = [next.name + ".tar.gz", "SHA256SUMS", "SHA256SUMS.asc"];
  const fetched = [];
  const fetcher = async (url) => {
    fetched.push(url);
    const file = url.split("/").at(-1);
    return new Response(file.endsWith(".tar.gz") ? readFileSync(next.archive) : "sums or signature");
  };
  const verified = [];
  const said = [];
  const options = { entry, platform: "linux", arch: "arm64", latest: async () => ({ version: "1.3.0", assets }), fetcher, verifier: async (folder, name, keyring) => void verified.push([name, existsSync(join(folder, name)), keyring.endsWith("release.gpg")]), say: (line) => said.push(line), healthMs: 20 };
  let gpg = true;
  try {
    execFileSync("gpg", ["--version"], { stdio: "ignore" });
  } catch {
    gpg = false;
  }
  if (!gpg) {
    // Without GnuPG nothing can be checked, so nothing is installed.
    await assert.rejects(applyUpdate(options), /GnuPG is needed to check a release's signature/);
    assert.equal(existsSync(join(installRoot, next.name)), false);
    return t.diagnostic("GnuPG is not installed here: the rest needs it to read the release key.");
  }
  // The key that checks a release is the one the installed copy came with. One that isn't a key stops the update.
  await assert.rejects(applyUpdate(options), /The release key couldn't be read/);
  writeFileSync(join(installRoot, folderName("1.2.3", "linux", "arm64"), "desktop/linux-service/botkins-release.asc"), readFileSync(new URL("../desktop/linux-service/botkins-release.asc", import.meta.url)));
  // A release whose signature isn't good is never unpacked.
  await assert.rejects(applyUpdate({ ...options, verifier: async () => { throw new Error("Unknown Botkins release signing key."); } }), /Unknown Botkins release signing key/);
  assert.equal(realpathSync(join(installRoot, "current")), join(installRoot, folderName("1.2.3", "linux", "arm64")));
  assert.equal(existsSync(join(installRoot, next.name)), false);
  fetched.length = 0;
  const result = await applyUpdate(options);
  assert.deepEqual(result, { status: "installed", current: "1.3.0", latest: "1.3.0", previous: "1.2.3" });
  assert.deepEqual(fetched, assets.map((file) => "https://github.com/promptclickrun/Botkins/releases/download/v1.3.0/" + file));
  assert.deepEqual(verified, [[next.name + ".tar.gz", true, true]]);
  assert.equal(realpathSync(join(installRoot, "current")), join(installRoot, next.name));
  assert.ok(said.some((line) => /Checking its signature/.test(line)));
  // Already the latest: nothing is downloaded.
  fetched.length = 0;
  assert.deepEqual(await applyUpdate({ ...options, entry: join(installRoot, "current", "cli", "botkins.mjs") }), { status: "current", current: "1.3.0" });
  assert.deepEqual(fetched, []);
  // A release with no build for this system, or without its signed checksums, is refused by name.
  for (const missing of assets) await assert.rejects(applyUpdate({ ...options, entry: join(installRoot, "current", "cli", "botkins.mjs"), latest: async () => ({ version: "1.4.0", assets: assets.map((file) => file.replace("1.3.0", "1.4.0")).filter((file) => file !== missing.replace("1.3.0", "1.4.0")) }) }), { code: "NO_BUILD" });
  assert.deepEqual(fetched, []);
  await assert.rejects(applyUpdate({ ...options, entry: fileURLToPath(new URL("../cli/botkins.mjs", import.meta.url)) }), { code: "UNMANAGED" });
});

test("the running service can only ask for an update: a request file for the root job, or the update as its own process", { skip }, async (t) => {
  const dir = tempDir(t);
  const { entry } = installed(dir, "1.2.3");
  const runDir = join(dir, "run");
  mkdirSync(runDir);
  const lines = [];
  let config = defaults();
  const service = { version: "1.2.3", paths: { runDir, root: dir }, log: { info: (line) => lines.push(line), error: (line) => lines.push(line) }, config: () => config, setConfig: async (next) => void (config = next) };
  const latest = async () => ({ version: "1.3.0", assets: ["botkins-terminal-1.3.0-linux-arm64.tar.gz", "SHA256SUMS", "SHA256SUMS.asc"] });
  const launched = [];
  const launch = (file, args) => (launched.push([file, ...args]), { unref() {} });
  const system = terminalUpdates(service, { entry, platform: "linux", arch: "arm64", latest, manager: { installed: () => ({ scope: "system" }) }, launch });
  assert.ok(system instanceof AppUpdates);
  const state = await system.check();
  assert.deepEqual([state.status, state.latest, state.canInstall], ["available", "1.3.0", true]);
  assert.match(lines[0], /Botkins 1\.3\.0 is available \(this is 1\.2\.3\)\. Install it with `botkins update`, or from a paired phone\./);
  await system.install();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(lstatSync(join(runDir, "update-requested")).size, 0, "the request says nothing but that it is there");
  assert.deepEqual(launched, []);
  // One person's service starts the update outside its own group of processes.
  const own = terminalUpdates(service, { entry, platform: "linux", arch: "arm64", latest, manager: { installed: () => ({ scope: "user" }) }, launch });
  await own.install();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(launched, [["systemd-run", "--user", "--collect", "--unit=botkins-update", process.execPath, entry, "update", "--apply"]]);
  // Not installed as a service, or not from a release: it says so and installs nothing.
  const loose = terminalUpdates(service, { entry, platform: "linux", arch: "arm64", latest, manager: { installed: () => null }, launch });
  assert.deepEqual([(await loose.check()).canInstall, /botkins service install/.test((await loose.check()).message)], [false, true]);
  await assert.rejects(loose.install(), /can't install this release by itself/);
  const checkout = terminalUpdates(service, { entry: fileURLToPath(new URL("../cli/botkins.mjs", import.meta.url)), platform: "linux", arch: "arm64", latest, manager: { installed: () => ({ scope: "system" }) }, launch });
  assert.equal((await checkout.check()).canInstall, false);
  await assert.rejects(checkout.install(), /wasn't installed from a release/);
});

test("how an install ended is kept for the service to read: installed, failed, or put back", { skip }, async (t) => {
  const dir = tempDir(t);
  const { installRoot, entry } = installed(dir, "1.2.3");
  // The record is beside the versions, in the install folder, which is root's own for the whole
  // computer's service. Nothing is written into the data folder.
  const root = installRoot;
  assert.equal(readLastUpdate(root), null);
  const next = release(dir, "1.3.0");
  const assets = [next.name + ".tar.gz", "SHA256SUMS", "SHA256SUMS.asc"];
  const reports = [];
  const at = new Date("2026-01-02T03:04:05Z");
  const options = { entry, platform: "linux", arch: "arm64", latest: async () => ({ version: "1.3.0", assets }), fetcher: async (url) => new Response(url.endsWith(".tar.gz") ? readFileSync(next.archive) : "x"), verifier: async () => {}, healthMs: 20, now: () => at, report: (record) => (reports.push(record), writeLastUpdate(root, record)) };
  // The key the installed copy came with has to be a real one for the check to start.
  writeFileSync(join(installRoot, folderName("1.2.3", "linux", "arm64"), "desktop/linux-service/botkins-release.asc"), readFileSync(new URL("../desktop/linux-service/botkins-release.asc", import.meta.url)));
  let gpg = true;
  try {
    execFileSync("gpg", ["--version"], { stdio: "ignore" });
  } catch {
    gpg = false;
  }
  if (!gpg) {
    // Nothing can be checked, so nothing is installed, and that is what is recorded.
    await assert.rejects(applyUpdate(options), /GnuPG is needed/);
    assert.deepEqual([reports[0].ok, reports[0].from, reports[0].to], [false, "1.2.3", "1.3.0"]);
    return t.diagnostic("GnuPG is not installed here: the rest needs it to read the release key.");
  }
  // A new version that doesn't stay up: the old one is put back, and the record says so in words for a person.
  const dying = { restart: async () => {}, status: async () => ({ active: false }) };
  await assert.rejects(applyUpdate({ ...options, manager: dying }), /was put back/);
  assert.deepEqual(reports.at(-1), { at: "2026-01-02T03:04:05.000Z", from: "1.2.3", to: "1.3.0", ok: false, message: "The new version didn't stay running. Botkins 1.2.3 was put back." });
  assert.deepEqual(readLastUpdate(root), reports.at(-1));
  assert.equal(statSync(lastUpdateFile(root)).mode & 0o777, 0o644, "the service's user reads it; only the installer writes it");
  // A release that can't be reached at all is an install that didn't end well, too.
  await assert.rejects(applyUpdate({ ...options, latest: async () => { throw new Error("GitHub could not check for updates (HTTP 503)."); } }), /HTTP 503/);
  assert.deepEqual([reports.at(-1).ok, reports.at(-1).from, reports.at(-1).to, reports.at(-1).message], [false, "1.2.3", "1.2.3", "GitHub could not check for updates (HTTP 503)."]);
  // One that works.
  await applyUpdate({ ...options, manager: { restart: async () => {}, status: async () => ({ active: true, pid: 5 }) } });
  assert.deepEqual(readLastUpdate(root), { at: "2026-01-02T03:04:05.000Z", from: "1.2.3", to: "1.3.0", ok: true });
  // Nothing newer, and a copy that doesn't update itself: there was no install, so nothing is recorded.
  const before = reports.length;
  assert.equal((await applyUpdate({ ...options, entry: join(installRoot, "current", "cli", "botkins.mjs") })).status, "current");
  await assert.rejects(applyUpdate({ ...options, entry: fileURLToPath(new URL("../cli/botkins.mjs", import.meta.url)) }), { code: "UNMANAGED" });
  assert.equal(reports.length, before);
  // A name that was made a link beforehand decides nothing: the place it points at is untouched,
  // whether the link is at the temporary name or at the record's own.
  const victim = join(dir, "victim.conf");
  const good = { at: "2026-01-03T00:00:00.000Z", from: "1.2.3", to: "1.3.0", ok: true };
  for (const name of [lastUpdateFile(root) + ".tmp", lastUpdateFile(root)]) {
    writeFileSync(victim, "the system's own file\n", { mode: 0o600 });
    rmSync(name, { force: true });
    symlinkSync(victim, name);
    assert.equal(writeLastUpdate(root, good), true);
    assert.equal(readFileSync(victim, "utf8"), "the system's own file\n", name + " as a link: its target is as it was");
    assert.equal(statSync(victim).mode & 0o777, 0o600);
    assert.equal(lstatSync(lastUpdateFile(root)).isFile(), true, "the record is a plain file again");
    assert.deepEqual(readLastUpdate(root), good);
  }
  // A record behind a link is not read either, and a temporary name that is a folder stops the write, with nothing changed.
  rmSync(lastUpdateFile(root));
  writeFileSync(victim, JSON.stringify(good));
  symlinkSync(victim, lastUpdateFile(root));
  assert.equal(readLastUpdate(root), null);
  rmSync(lastUpdateFile(root));
  mkdirSync(lastUpdateFile(root) + ".tmp");
  assert.equal(writeLastUpdate(root, good), false);
  rmSync(lastUpdateFile(root) + ".tmp", { recursive: true });
  // Only a record that is one is written or shown: versions that are versions, a date that is a date, a message of a sensible length.
  for (const bad of [null, {}, { ...good, at: "yesterday" }, { ...good, at: "2026-01-03T00:00:00.000Z".padEnd(60, "0") }, { ...good, from: "1.2.3; rm -rf /" }, { ...good, to: "v1.3.0" }, { ...good, to: "9".repeat(40) + ".0.0" }, { ...good, ok: "yes" }]) {
    assert.equal(cleanLastUpdate(bad), null);
    assert.equal(writeLastUpdate(root, bad), false);
  }
  assert.equal(cleanLastUpdate({ ...good, ok: false, message: "x".repeat(900) + "\u0000\n" }).message.length, 300);
  writeFileSync(lastUpdateFile(root), '{"at":5}');
  assert.equal(readLastUpdate(root), null);
  assert.equal(writeLastUpdate(join(dir, "nowhere"), good), false);
  // The request the service leaves is taken up whatever was put under its name: a file, a link
  // (the link goes, its target stays), or a folder with things in it.
  const data = join(dir, "data-folder");
  mkdirSync(join(data, "run"), { recursive: true });
  const request = join(data, "run", "update-requested");
  writeFileSync(request, "");
  assert.equal(takeRequest(data), true);
  assert.equal(existsSync(request), false);
  symlinkSync(victim, request);
  assert.equal(takeRequest(data), true);
  assert.equal(lstatSync(victim).isFile() && !existsSync(request), true);
  mkdirSync(join(request, "deep"), { recursive: true });
  writeFileSync(join(request, "deep", "file"), "x");
  assert.equal(takeRequest(data), true);
  assert.equal(existsSync(request), false);
  assert.equal(takeRequest(join(dir, "no-such-folder")), true, "nothing there is nothing to take up");
  // Not root: the work is done as who we are. (As root it is done with the folder owner's rights: test/terminal-root.test.mjs.)
  assert.equal(asOwnerOf(data, () => "done"), "done");
});

test("a host that can install tells how it stands, installs by itself only when asked to, and never during a turn", { skip }, async (t) => {
  const dir = tempDir(t);
  const { entry, installRoot } = installed(dir, "1.2.3");
  const runDir = join(dir, "run");
  mkdirSync(runDir);
  const lines = [];
  let config = defaults();
  let active = 1;
  let changes = 0;
  const service = { version: "1.2.3", paths: { runDir, root: dir }, log: { info: (line) => lines.push(line), error: (line) => lines.push(line) }, config: () => config, setConfig: async (next) => void (config = next), runtime: { workspace: { active: { get size() { return active; } } } }, changed: () => changes++ };
  let found = "1.2.3";
  const latest = async () => ({ version: found, assets: ["botkins-terminal-" + found + "-linux-arm64.tar.gz", "SHA256SUMS", "SHA256SUMS.asc"] });
  const updates = terminalUpdates(service, { entry, platform: "linux", arch: "arm64", latest, manager: { installed: () => ({ scope: "system" }) }, launch: assert.fail, env: {}, pollMs: 10, startedMs: 60_000, heardMs: 60_000, autoPollMs: 10 });
  t.after(() => updates.stopAuto());
  const requested = () => existsSync(join(runDir, "update-requested"));
  // What a phone is shown: the state, and the choice, off until someone switches it on.
  assert.deepEqual(updates.status(), { status: "idle", current: "1.2.3", canInstall: false, auto: false });
  assert.equal((await updates.check()).status, "current");
  found = "1.3.0";
  await updates.check();
  assert.deepEqual(updates.status(), { status: "available", current: "1.2.3", latest: "1.3.0", canInstall: true, installer: "linux-tarball", auto: false });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(requested(), false, "nothing is installed without being asked while the choice is off");
  // Switched on: saved as the setting, and the release waits for the turn under way to end.
  assert.equal(updates.setAuto(true).auto, true);
  assert.equal(config.updates.auto, true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(requested(), false, "a turn is never cut short for an update nobody asked for just now");
  active = 0;
  for (let tries = 0; tries < 100 && !requested(); tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requested(), true);
  assert.equal(updates.status().status, "restarting");
  assert.ok(lines.some((line) => /Installing Botkins 1\.3\.0 by itself/.test(line)));
  // The install job failed before it could restart the service: the service hears of it and says so in the job's own words.
  rmSync(join(runDir, "update-requested"));
  assert.equal(writeLastUpdate(installRoot, { at: new Date().toISOString(), from: "1.2.3", to: "1.3.0", ok: false, message: "The new version didn't stay running. Botkins 1.2.3 was put back." }), true);
  for (let tries = 0; tries < 100 && updates.status().status !== "error"; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  const status = updates.status();
  assert.deepEqual([status.status, status.message, status.last.ok, status.last.to], ["error", "The new version didn't stay running. Botkins 1.2.3 was put back.", false, "1.3.0"]);
  assert.ok(changes > 0, "a dashboard that waits is told");
  // A release that was tried and put back is not installed by itself again, however often a check finds it.
  // (It can still be installed on purpose, and the next release is a new one.)
  await updates.check();
  assert.equal(updates.status().status, "available");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(requested(), false, "no second try by itself");
  assert.ok(lines.some((line) => /was tried and put back, so it is not installed by itself again/.test(line)));
  found = "1.3.1";
  await updates.check();
  for (let tries = 0; tries < 100 && !requested(); tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requested(), true, "the release after it is tried");
  rmSync(join(runDir, "update-requested"));
  assert.equal(updates.setAuto(false).auto, false);
  assert.equal(config.updates.auto, false);
  assert.throws(() => updates.setAuto("yes"), /Say on or off/);
  // A turn that starts between the decision and the request stops an install nobody asked for; it is tried again when the turn is over.
  let late = 0;
  const idleThenBusy = terminalUpdates({ ...service, config: () => ({ updates: { auto: true } }), runtime: { workspace: { active: { get size() { return late++ === 0 ? 0 : 1; } } } } }, { entry, platform: "linux", arch: "arm64", latest, manager: { installed: () => ({ scope: "system" }) }, env: {}, pollMs: 10, autoPollMs: 10_000 });
  rmSync(lastUpdateFile(installRoot));
  await idleThenBusy.check();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(requested(), false);
  assert.equal(idleThenBusy.status().status, "available");
  idleThenBusy.stopAuto();
  // A request nobody takes up (no update job on this computer) is said, and taken back, so a job that starts later installs nothing unasked.
  const quiet = terminalUpdates(service, { entry, platform: "linux", arch: "arm64", latest, manager: { installed: () => ({ scope: "system" }) }, env: {}, pollMs: 10, startedMs: 50, heardMs: 60_000 });
  await quiet.install();
  for (let tries = 0; tries < 100 && quiet.status().status !== "error"; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(quiet.status().message, /The update did not start/);
  assert.equal(requested(), false);
  // One that was taken up and never said how it ended is said too, later.
  const silent = terminalUpdates(service, { entry, platform: "linux", arch: "arm64", latest, manager: { installed: () => ({ scope: "system" }) }, env: {}, pollMs: 10, startedMs: 60_000, heardMs: 80 });
  await silent.install();
  await new Promise((resolve) => setTimeout(resolve, 20));
  rmSync(join(runDir, "update-requested"));
  for (let tries = 0; tries < 100 && silent.status().status !== "error"; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(silent.status().message, /started and did not say how it ended/);
  // The bots' tools speak of a host, not of a desktop app.
  assert.match(updates.words.check, /Botkins on this host/);
  assert.doesNotMatch(updates.words.check + updates.words.install, /desktop|the app/);
  // A copy that can't install by itself has no such choice, and says what it is.
  const checkout = terminalUpdates(service, { entry: fileURLToPath(new URL("../cli/botkins.mjs", import.meta.url)), latest, manager: { installed: () => null }, env: {} });
  assert.equal("auto" in checkout.status(), false);
  assert.throws(() => checkout.setAuto(true), /doesn't install updates by itself/);
  const container = terminalUpdates(service, { entry: fileURLToPath(new URL("../cli/botkins.mjs", import.meta.url)), latest, manager: { installed: () => null }, env: { BOTKINS_IMAGE: "ghcr.io/promptclickrun/botkins" } });
  await assert.rejects(container.install(), /runs from a Docker image.*pull the new image \(ghcr\.io\/promptclickrun\/botkins\)/);
});

test("a container is updated by pulling its image, and the image is the one each release publishes", { skip }, async () => {
  const image = "ghcr.io/promptclickrun/botkins";
  assert.match(unmanaged({ BOTKINS_IMAGE: image }), /runs from the Docker image ghcr\.io\/promptclickrun\/botkins.*docker compose pull && docker compose up -d.*The data volume stays\./);
  assert.match(unmanaged({}), /wasn't installed from a release.*git pull/);
  await assert.rejects(applyUpdate({ entry: fileURLToPath(new URL("../cli/botkins.mjs", import.meta.url)), env: { BOTKINS_IMAGE: image } }), { code: "UNMANAGED", message: /pulling the new image/ });
  // The image names itself, and Compose uses the published one unless a checkout is built on purpose.
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^\s+BOTKINS_IMAGE=ghcr\.io\/promptclickrun\/botkins \\$/m);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini", "--", "botkins"\]\nCMD \["serve"\]\n$/, "`docker run <image> --version` prints the version");
  const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /^  botkins:\n    image: ghcr\.io\/promptclickrun\/botkins:\$\{BOTKINS_VERSION:-latest\}\n    build:\n      context: \.\n      target: terminal$/m);
});

test("the installer and the launcher are plain sh, and the installer checks before it installs", { skip }, () => {
  for (const file of ["install.sh", "botkins"]) execFileSync("sh", ["-n", fileURLToPath(new URL("../install/" + file, import.meta.url))]);
  // The check that runs after a release is published is plain sh too, and stands in for nothing: it
  // names no key and no address of its own unless it is told to try a mirror.
  const fromRelease = fileURLToPath(new URL("./terminal-e2e/from-release.sh", import.meta.url));
  execFileSync("sh", ["-n", fromRelease]);
  const check = readFileSync(fromRelease, "utf8");
  assert.match(check, /download=\$\{BOTKINS_E2E_RELEASE_URL:-https:\/\/github\.com\/\$REPO\/releases\/download\}/);
  assert.doesNotMatch(check, /--checksum-only|--release-fingerprint [0-9A-F]{40}/);
  // The old version's updater does the install, so the record of it is asked for only from a
  // version that leaves one. The script's own comparison of two releases, run as it is:
  const newerThan = /^newer_than\(\) \{.*\}$/m.exec(check)[0];
  const newer = (a, b) => execFileSync("sh", ["-c", newerThan + '\nif newer_than "$1" "$2"; then echo yes; else echo no; fi', "sh", a, b], { encoding: "utf8" }).trim();
  for (const [a, b, wanted] of [["0.16.6", "0.16.5", "yes"], ["0.17.0", "0.16.5", "yes"], ["1.0.0", "0.16.5", "yes"], ["0.16.10", "0.16.9", "yes"], ["0.16.5", "0.16.5", "no"], ["0.16.4", "0.16.5", "no"], ["0.9.99", "0.16.5", "no"]]) assert.equal(newer(a, b), wanted, a + " newer than " + b);
  assert.match(check, /^NO_RECORD_UNTIL="0\.16\.5"$/m);
  // Up to that release the record is not asked for; what stays for every release is asked before the choice.
  const choice = check.indexOf('if newer_than "$from" "$NO_RECORD_UNTIL"; then');
  assert.ok(choice > 0);
  for (const kept of ['[ "$result" = success ]', '[ ! -e "/var/lib/botkins/run/update-requested" ]', 'running_on "$to" 90', '[ -d "/opt/botkins/botkins-terminal-$from-linux-$arch" ]']) assert.ok(check.indexOf(kept) > 0 && check.indexOf(kept) < choice, kept);
  const script = readFileSync(new URL("../install/install.sh", import.meta.url), "utf8");
  // The release key's fingerprint is the one the updater checks too.
  const helper = readFileSync(new URL("../desktop/linux-service/botkins-update-helper.mjs", import.meta.url), "utf8");
  const fingerprint = /const fingerprint = "([0-9A-F]{40})"/.exec(helper)[1];
  assert.ok(script.includes('FINGERPRINT="' + fingerprint + '"'));
  // Every check comes before the first thing that is unpacked or written into the install folder.
  const first = (text) => {
    const at = script.indexOf(text);
    assert.ok(at > 0, text);
    return at;
  };
  const unpack = first('tar -xzf "$work/$archive"');
  for (const check of ['[ "$found" = "$fingerprint" ]', "gpgv --homedir", 'grep -q "^\\[GNUPG:\\] VALIDSIG $fingerprint "', '[ "$(sha256 "$work/$archive")" = "$wanted" ]', "holds files outside its own folder"]) assert.ok(first(check) < unpack, check + " comes before unpacking");
  assert.match(script, /^set -eu$/m);
  assert.doesNotMatch(script, /curl[^\n]*\|\s*(sh|bash)/, "the installer pipes nothing it downloads into a shell");
});
