// Keeping the service's files up to date with the version an update installs
// (desktop/terminal/units.mjs, manager.mjs, update-install.mjs): what was chosen at install time
// is read back from the installed file, the new version writes its own files before the service
// restarts, and what the files held goes back when the old version does. Nothing here touches
// the computer's own services: every file goes into a folder of the test's own, and every system
// tool is a stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { examine } from "../cli/commands/service.mjs";
import { serviceManager } from "../desktop/terminal/manager.mjs";
import { launchdJob, odd, ONCE_WRITTEN, readLaunchdJob, readSystemUnit, readUserUnit, sameForm, strange, systemUnit, unitWords, updateUnits, userUnit } from "../desktop/terminal/units.mjs";
import { applyUpdate, folderName, switchTo } from "../desktop/terminal/update-install.mjs";

const skip = process.platform === "win32" && "The terminal host runs on Linux and macOS.";
const tempDir = (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bk-refresh-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const command = ["/opt/botkins/current/bin/botkins"];
/** Stand-ins for the system's tools: every call is kept, and `answers` says how each ends. */
function tools(answers = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args].join(" "));
    for (const [prefix, answer] of Object.entries(answers)) if ([file, ...args].join(" ").startsWith(prefix)) return { code: 0, stdout: "", stderr: "", ...(typeof answer === "function" ? answer(args) : answer) };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}
const ids = { "id -u": { stdout: "998\n" }, "id -g": { stdout: "998\n" } };
/** The whole computer's service, installed into `root` by a manager whose tools are stand-ins. */
async function systemInstall(root, { answers = {}, uid = 0, ...options } = {}) {
  const made = tools({ ...ids, ...answers });
  await serviceManager({ command, platform: "linux", uid: 0, home: "/root", user: "root", env: {}, run: made.run, root, own: () => {} }).install(options);
  // As systemd answers: the service and the watch start with the computer; the job has nothing to link.
  const kept = tools({ "systemctl is-enabled botkins-update.service": { stdout: "static\n" }, "systemctl is-enabled": { stdout: "enabled\n" }, ...answers });
  return { ...kept, manager: serviceManager({ command: ["/somewhere/else/botkins"], platform: "linux", uid, home: "/root", user: "root", env: {}, run: kept.run, root, own: () => {}, pause: async () => {} }) };
}
const UNIT = "/etc/systemd/system/botkins.service";
const WATCH = "/etc/systemd/system/botkins-update.path";
const JOB = "/etc/systemd/system/botkins-update.service";
const RECORD = "/etc/botkins/install.json";
const agent0 = () => ({ command, dataDir: "/Users/sam/Library/Application Support/Botkins Terminal", logFile: "/Users/sam/Library/Application Support/Botkins Terminal/logs/launchd.log" });
/** A unit file as a version before this one could have written it: one line of today's is not there yet. */
const older = (text) => {
  assert.ok(text.includes("\nProtectClock=true\n"));
  return text.replace("\nProtectClock=true\n", "\n");
};

test("what was chosen at install time is read back from the installed file, whole, and never guessed", { skip }, () => {
  // Everything `botkins service install` can be told, with paths that need quoting and escaping.
  for (const key of [{ file: "/etc/botkins/host.key" }, { encrypted: "/etc/botkins/host.key.cred" }, { groupFile: "/etc/botkins/host.key" }]) {
    for (const allowPaths of [[], ["/srv/my projects", "/srv/a$b%c", '/srv/quo"te']]) {
      const chosen = { command, dataDir: "/var/lib/bot kins", user: "bots", group: "staff", home: "/var/lib/bot kins/home", key, allowPaths, env: {} };
      assert.deepEqual(readSystemUnit(systemUnit(chosen)), chosen);
      assert.equal(systemUnit(readSystemUnit(systemUnit(chosen))), systemUnit(chosen));
    }
  }
  const person = { command: ["/usr/bin/node", "/home/a b/cli/botkins.mjs"], dataDir: "/home/a b/.local/share/botkins", keyFile: "/home/a b/.config/botkins/host.key", env: { PATH: '/a:/b c:/d"e:/f$g' } };
  assert.deepEqual(readUserUnit(userUnit(person)), person);
  assert.deepEqual(readUserUnit(userUnit({ command, dataDir: "/data" })), { command, dataDir: "/data", env: {} });
  // What a person added that can be carried is carried: a variable (a proxy, a provider's key
  // file), however they quoted it, and a folder for bots on a line of its own.
  const plain = systemUnit({ command, dataDir: "/var/lib/botkins", key: { file: "/etc/botkins/host.key" }, allowPaths: ["/srv/projects"] });
  const theirs = plain.replace("\nExecStart=", '\nEnvironment=HTTPS_PROXY=http://proxy.example:3128\nEnvironment="NO_PROXY=localhost, 10.0.0.0/8" EXTRA=1\nExecStart=').replace("\nProtectHome=true\n", "\nReadWritePaths=/srv/more\nProtectHome=true\n");
  const read = readSystemUnit(theirs);
  assert.deepEqual(read.env, { HTTPS_PROXY: "http://proxy.example:3128", NO_PROXY: "localhost, 10.0.0.0/8", EXTRA: "1" });
  assert.deepEqual(read.allowPaths, ["/srv/projects", "/srv/more"]);
  const made = systemUnit(read);
  for (const line of ["Environment=HTTPS_PROXY=http://proxy.example:3128", 'Environment="NO_PROXY=localhost, 10.0.0.0/8"', "Environment=EXTRA=1", "ReadWritePaths=/var/lib/botkins /srv/projects /srv/more"]) assert.ok(made.includes("\n" + line + "\n"), line);
  assert.deepEqual(strange("systemd", theirs, made), [], "nothing of theirs is lost, so the file can be written anew");
  assert.deepEqual(readSystemUnit(made), read, "and what was carried is carried again the next time");
  assert.deepEqual(readUserUnit(userUnit({ command, dataDir: "/data", env: { PATH: "/usr/bin", OPENAI_BASE_URL: "http://localhost:1234" } })).env, { PATH: "/usr/bin", OPENAI_BASE_URL: "http://localhost:1234" });
  const proxied = launchdJob({ ...agent0(), env: { PATH: "/usr/bin", HTTPS_PROXY: "http://proxy.example:3128", "ODD&NAME": "a<b" } });
  assert.deepEqual(readLaunchdJob(proxied).env, { PATH: "/usr/bin", HTTPS_PROXY: "http://proxy.example:3128", "ODD&NAME": "a<b" });
  assert.equal(launchdJob(readLaunchdJob(proxied)), proxied);
  // What can't be carried is found: a setting they changed, one they added, a variable of Botkins' own they changed.
  assert.deepEqual(strange("systemd", plain.replace("RestartSec=3", "RestartSec=30"), plain), ["RestartSec=30"]);
  assert.deepEqual(strange("systemd", plain.replace("\n[Install]", "MemoryMax=1G\n\n[Install]"), plain), ["MemoryMax=1G"]);
  assert.deepEqual(strange("systemd", plain.replace("NODE_ENV=production", "NODE_ENV=development"), systemUnit(readSystemUnit(plain.replace("NODE_ENV=production", "NODE_ENV=development")))), ["Environment=NODE_ENV=development"]);
  assert.deepEqual(strange("systemd", plain.replace("\nProtectClock=true\n", "\n").replace(/^# .*\n/, "# their own note\n"), plain), [], "a line that isn't there yet, and a comment, are nothing of theirs to keep");
  const job = launchdJob(agent0());
  assert.deepEqual(strange("launchd", job.replace("<integer>5</integer>", "<integer>60</integer>"), job), ["ThrottleInterval 60"]);
  assert.deepEqual(strange("launchd", job.replace("  <key>RunAtLoad</key>", "  <key>Nice</key>\n  <integer>5</integer>\n  <key>RunAtLoad</key>"), job), ["Nice 5"]);
  assert.deepEqual(strange("launchd", job.replace("<string>production</string>", "<string>development</string>"), job), ['EnvironmentVariables.NODE_ENV "development"']);
  assert.deepEqual(strange("launchd", job.replace("  <key>ThrottleInterval</key>\n  <integer>5</integer>\n", ""), job), []);
  const agent = { command: ["/opt/b&c/current/bin/botkins"], dataDir: "/Users/sam/Library/Application Support/Botkins Terminal", logFile: "/Users/sam/Library/Application Support/Botkins Terminal/logs/launchd.log", env: { PATH: "/a:/b<c>&d" } };
  assert.deepEqual(readLaunchdJob(launchdJob(agent)), agent);
  const daemon = { command, dataDir: "/Library/Application Support/Botkins Terminal", logFile: "/Library/Application Support/Botkins Terminal/logs/launchd.log", user: "sam", env: { BOTKINS_KEY_FILE: "/etc/botkins/host.key", HOME: "/Users/sam" } };
  assert.deepEqual(readLaunchdJob(launchdJob(daemon)), daemon);
  assert.equal(launchdJob(readLaunchdJob(launchdJob(daemon))), launchdJob(daemon));
  // A value is read back as systemd reads it: "%%" is a "%" everywhere; "$$" is a "$" only in a command line.
  assert.deepEqual(unitWords('plain "two words" "a \\"quote\\" and a \\\\" $$HOME 100%%'), ["plain", "two words", 'a "quote" and a \\', "$$HOME", "100%"]);
  assert.deepEqual(unitWords('plain "two words" $$HOME 100%%', { exec: true }), ["plain", "two words", "$HOME", "100%"]);
  // A file that doesn't say one of the choices is not read at all: nothing is filled in for it.
  const unit = systemUnit({ command, dataDir: "/var/lib/botkins", key: { file: "/etc/botkins/host.key" }, allowPaths: ["/srv/projects"] });
  const without = (pattern) => unit.split("\n").filter((line) => !pattern.test(line)).join("\n");
  for (const [pattern, what] of [[/^User=/, /which user/], [/^Environment=BOTKINS_DATA_DIR=/, /data folder/], [/^Environment=HOME=/, /data folder/], [/^ReadWritePaths=/, /folders bots may write/], [/^LoadCredential=/, /host key/], [/^ExecStart=/, /how Botkins is started/]]) {
    assert.throws(() => readSystemUnit(without(pattern)), (error) => error.code === "UNREADABLE_UNIT" && what.test(error.message), String(pattern));
  }
  assert.throws(() => readSystemUnit(unit.replace("ReadWritePaths=/var/lib/botkins ", "ReadWritePaths=/elsewhere ")), { code: "UNREADABLE_UNIT" });
  assert.throws(() => readSystemUnit(unit.replace(/^ExecStart=.*$/m, "ExecStart=/usr/bin/other")), { code: "UNREADABLE_UNIT" });
  assert.throws(() => readSystemUnit(unit.replace("LoadCredential=botkins-key:", "LoadCredential=other-key:")), { code: "UNREADABLE_UNIT" });
  assert.throws(() => readUserUnit("[Service]\nExecStart=/x serve\n"), { code: "UNREADABLE_UNIT" });
  for (const bad of ["", "<plist><dict></dict></plist>", launchdJob(agent).replace("<string>serve</string>", "<string>other</string>"), launchdJob(agent).replace("BOTKINS_DATA_DIR", "OTHER"), launchdJob(agent).replace(/<key>StandardOutPath<\/key>\s*<string>[^<]*<\/string>/, "")]) assert.throws(() => readLaunchdJob(bad), { code: "UNREADABLE_UNIT" });
});

test("a service that was just installed is up to date, whichever way it was installed", { skip }, async (t) => {
  // The whole computer's, with its key as a credential; with the key read by the group; encrypted; on another folder and user.
  for (const [options, answers] of [
    [{ allowPaths: ["/srv/projects", "/srv/more projects"] }, {}],
    [{}, { "systemd-run": { code: 1 } }],
    [{ encryptedKey: true }, { "systemd-creds decrypt": () => ({ stdout: "" }) }],
    [{ dataDir: "/data/bot kins", runAs: "bots" }, {}],
  ]) {
    const root = tempDir(t);
    if (options.encryptedKey) {
      // The stand-in for systemd-creds: the encrypted file is there, and reads back as the key.
      mkdirSync(root + "/etc/botkins", { recursive: true });
      writeFileSync(root + "/etc/botkins/host.key.cred", "sealed");
    }
    const { manager, calls } = await systemInstall(root, { ...options, answers });
    assert.deepEqual((await manager.refresh({ write: false })).changed, [], JSON.stringify(options));
    assert.deepEqual((await manager.refresh()).changed, []);
    assert.deepEqual(calls, [], "nothing to write, so nothing is reloaded");
  }
  // One person's, on Linux and on macOS; and the whole Mac's.
  const linux = tempDir(t);
  const own = tools({ "systemctl --user is-enabled": { stdout: "enabled\n" } });
  const mine = serviceManager({ command, platform: "linux", uid: 1000, home: "/home/sam", user: "sam", env: { PATH: "/home/sam/.local/bin:/usr/bin" }, run: own.run, root: linux });
  const { file } = await mine.install();
  assert.deepEqual((await mine.refresh()).changed, []);
  // An older file of a person's own service is written by that person, through their own systemd, with their PATH kept.
  const theirs = readFileSync(linux + file, "utf8");
  writeFileSync(linux + file, theirs.replace("\nLockPersonality=true\n", "\n"));
  own.calls.length = 0;
  assert.deepEqual((await mine.refresh({ restart: true })).changed, [file]);
  assert.equal(readFileSync(linux + file, "utf8"), theirs);
  assert.match(theirs, /^Environment=PATH=\/home\/sam\/\.local\/bin:\/usr\/bin$/m);
  assert.deepEqual(own.calls, ["systemctl --user is-enabled botkins.service", "systemctl --user daemon-reload", "systemctl --user reenable botkins.service", "systemctl --user restart botkins.service"]);
  const mac = tempDir(t);
  const agent = serviceManager({ command, platform: "darwin", uid: 501, home: "/Users/sam", user: "sam", env: { PATH: "/opt/homebrew/bin:/usr/bin" }, run: tools().run, root: mac });
  await agent.install();
  assert.deepEqual((await agent.refresh()).changed, []);
  const whole = tempDir(t);
  const daemon = serviceManager({ command, platform: "darwin", uid: 0, home: "/var/root", user: "root", env: { SUDO_USER: "sam" }, run: tools({ "id -u sam": { stdout: "501\n" }, "id -g sam": { stdout: "20\n" }, "sh -c": { stdout: "/Users/sam\n" } }).run, root: whole, own: () => {} });
  await daemon.install();
  assert.deepEqual((await daemon.refresh()).changed, []);
  // No service, nothing to refresh.
  await assert.rejects(serviceManager({ command, platform: "linux", uid: 0, env: {}, run: tools().run, root: tempDir(t) }).refresh(), { code: "NOT_INSTALLED" });
});

test("files an earlier version wrote are written as this version writes them, with every choice kept", { skip }, async (t) => {
  const root = tempDir(t);
  const { manager, calls } = await systemInstall(root, { dataDir: "/data/bot kins", runAs: "bots", allowPaths: ["/srv/projects", "/srv/more projects"], answers: { "systemd-run": { code: 1 } } });
  const fresh = readFileSync(root + UNIT, "utf8");
  writeFileSync(root + UNIT, older(fresh));
  // Asked only whether they differ: the answer, and no change.
  const looked = await manager.refresh({ write: false });
  assert.deepEqual([looked.kind, looked.scope, looked.file, looked.changed], ["systemd", "system", UNIT, [UNIT]]);
  assert.equal(readFileSync(root + UNIT, "utf8"), older(fresh));
  assert.deepEqual(calls, []);
  // Only root writes the whole computer's files.
  const person = serviceManager({ command, platform: "linux", uid: 1000, env: {}, run: tools().run, root });
  assert.deepEqual((await person.refresh({ write: false })).changed, [UNIT], "anyone may look");
  await assert.rejects(person.refresh(), { code: "NEEDS_ROOT" });
  // Written: the file is the one this version installs, for the same user, folders and key.
  assert.deepEqual((await manager.refresh()).changed, [UNIT]);
  const written = readFileSync(root + UNIT, "utf8");
  assert.equal(written, fresh);
  for (const line of ["User=bots", 'ReadWritePaths="/data/bot kins" /srv/projects "/srv/more projects"', "Environment=BOTKINS_KEY_SOURCE=file", "Environment=BOTKINS_KEY_FILE=/etc/botkins/host.key", "ExecStart=/opt/botkins/current/bin/botkins serve", "ProtectClock=true"]) assert.ok(written.includes("\n" + line + "\n"), line);
  assert.equal(lstatSync(root + UNIT).mode & 0o777, 0o644);
  // What was there is kept once, beside it; and nothing is left of the writing itself.
  assert.equal(readFileSync(root + UNIT + ".bak", "utf8"), older(fresh));
  assert.deepEqual(readdirSync(root + "/etc/systemd/system").sort(), ["botkins-update.path", "botkins-update.service", "botkins.service", "botkins.service.bak"]);
  // systemd reads the files again, a unit that starts with the computer is linked again, and
  // the service is not restarted unless that was asked for: an update restarts it itself.
  assert.deepEqual(calls, ["systemctl is-enabled botkins.service", "systemctl daemon-reload", "systemctl reenable botkins.service"]);
  calls.length = 0;
  writeFileSync(root + UNIT, older(fresh));
  await manager.refresh({ restart: true });
  assert.deepEqual(calls, ["systemctl is-enabled botkins.service", "systemctl daemon-reload", "systemctl reenable botkins.service", "systemctl restart botkins.service"]);
  // The update job's own files and the install record are kept up to date the same way. The
  // watch is started again; the job, which may be the one running this, is left alone.
  calls.length = 0;
  writeFileSync(root + WATCH, readFileSync(root + WATCH, "utf8").replace(/^Description=.*\n/m, ""));
  writeFileSync(root + JOB, readFileSync(root + JOB, "utf8").replace("UMask=0022\n", ""));
  writeFileSync(root + RECORD, "{}\n");
  assert.deepEqual((await manager.refresh()).changed, [JOB, WATCH, RECORD]);
  assert.match(readFileSync(root + WATCH, "utf8"), /^Description=Watch for the Botkins terminal host/m);
  assert.match(readFileSync(root + WATCH, "utf8"), /PathExists="\/data\/bot kins\/run\/update-requested"/);
  assert.deepEqual(JSON.parse(readFileSync(root + RECORD, "utf8")), { version: 1, scope: "system", dataDir: "/data/bot kins", user: "bots", command });
  assert.deepEqual(calls, ["systemctl is-enabled botkins-update.service", "systemctl is-enabled botkins-update.path", "systemctl daemon-reload", "systemctl reenable botkins-update.path", "systemctl try-restart botkins-update.path"]);
  assert.ok(!calls.some((call) => /(restart|stop|start) botkins-update\.service/.test(call)));
  // A watch that was never there is made and started.
  calls.length = 0;
  rmSync(root + WATCH);
  await manager.refresh();
  assert.deepEqual(calls, ["systemctl daemon-reload", "systemctl enable --now botkins-update.path"]);
});

test("what the person changed about the service stays as they left it", { skip }, async (t) => {
  // A service switched off on purpose is not switched on again.
  const off = tempDir(t);
  const disabled = await systemInstall(off, { answers: { "systemctl is-enabled": { stdout: "disabled\n", code: 1 } } });
  writeFileSync(off + UNIT, older(readFileSync(off + UNIT, "utf8")));
  await disabled.manager.refresh();
  assert.deepEqual(disabled.calls, ["systemctl is-enabled botkins.service", "systemctl daemon-reload"]);
  // A unit they masked is a link to nothing. It is not written through, and stays a link.
  const root = tempDir(t);
  const { manager, calls } = await systemInstall(root);
  rmSync(root + WATCH);
  writeFileSync(join(root, "nothing"), "");
  symlinkSync(join(root, "nothing"), root + WATCH);
  assert.deepEqual((await manager.refresh()).changed, []);
  assert.equal(lstatSync(root + WATCH).isSymbolicLink(), true);
  assert.equal(readFileSync(join(root, "nothing"), "utf8"), "");
  assert.deepEqual(calls, []);
  // Their own additions (`systemctl edit` makes this folder) are no file of the service's.
  mkdirSync(root + UNIT + ".d");
  writeFileSync(root + UNIT + ".d/override.conf", "[Service]\nMemoryMax=1G\n");
  writeFileSync(root + UNIT, older(readFileSync(root + UNIT, "utf8")));
  const saved = manager.snapshot();
  assert.deepEqual(Object.keys(saved.files).sort(), [RECORD, UNIT, JOB].sort(), "the masked watch and the additions are not in it");
  await manager.refresh();
  await manager.restore(saved);
  assert.equal(readFileSync(root + UNIT + ".d/override.conf", "utf8"), "[Service]\nMemoryMax=1G\n");
  // A main unit that is masked, or that somebody rewrote by hand, is not one to rewrite.
  const edited = tempDir(t);
  const hand = await systemInstall(edited);
  writeFileSync(edited + UNIT, readFileSync(edited + UNIT, "utf8").replace(/^User=.*\n/m, ""));
  await assert.rejects(hand.manager.refresh(), { code: "UNREADABLE_UNIT" });
  assert.deepEqual(hand.calls, []);
});

test("a file with a setting of the person's own that can't be carried is left as it is, and the others are still written", { skip }, async (t) => {
  const root = tempDir(t);
  const { manager, calls } = await systemInstall(root, { allowPaths: ["/srv/projects"] });
  const fresh = readFileSync(root + UNIT, "utf8");
  // An older unit, with a variable of theirs: carried, so the file is written anew and keeps it.
  writeFileSync(root + UNIT, older(fresh).replace("\nExecStart=", "\nEnvironment=HTTPS_PROXY=http://proxy.example:3128\nExecStart="));
  let result = await manager.refresh();
  assert.deepEqual([result.changed, result.kept], [[UNIT], []]);
  const carried = readFileSync(root + UNIT, "utf8");
  assert.ok(carried.includes("\nEnvironment=HTTPS_PROXY=http://proxy.example:3128\n") && carried.includes("\nProtectClock=true\n") && carried.includes("\nReadWritePaths=/var/lib/botkins /srv/projects\n"));
  assert.deepEqual((await manager.refresh()).changed, [], "and it is up to date from then on");
  // An older unit with a limit of theirs, which a new text would lose: not written, and said.
  const own = older(carried).replace("\n[Install]", "MemoryMax=1G\n\n[Install]");
  writeFileSync(root + UNIT, own);
  writeFileSync(root + JOB, readFileSync(root + JOB, "utf8").replace("UMask=0022\n", ""));
  calls.length = 0;
  result = await manager.refresh();
  assert.deepEqual(result.changed, [JOB], "the update job's file is nobody's but Botkins', and is written");
  assert.deepEqual(result.kept, [{ file: UNIT, lines: ["MemoryMax=1G"] }]);
  assert.equal(readFileSync(root + UNIT, "utf8"), own);
  assert.ok(!calls.some((call) => call.includes("botkins.service")), calls.join("; "));
  // The same for the update job's own file, and for a file that is no unit at all.
  writeFileSync(root + JOB, readFileSync(root + JOB, "utf8").replace("UMask=0022", "UMask=0077"));
  writeFileSync(root + WATCH, "not a unit\n[Path\nPathExists=/somewhere/else\n");
  result = await manager.refresh({ write: false });
  assert.deepEqual(result.kept.map((entry) => [entry.file, entry.lines]), [[UNIT, ["MemoryMax=1G"]], [JOB, ["UMask=0077"]], [WATCH, ["not a unit", "[Path", "PathExists=/somewhere/else"]]]);
  assert.deepEqual(result.changed, []);
  // Doctor says which file, why, and where such a setting is kept by every update.
  const paths = { root: join(root, "data"), config: join(root, "data", "config.json"), socket: join(root, "data", "run", "botkins.sock") };
  const client = { call: async () => { throw Object.assign(new Error("not running"), { code: "NOT_RUNNING" }); } };
  const report = await examine({ paths, client, env: {}, fetcher: async () => new Response(""), node: "24.1.0", units: () => manager.refresh({ write: false }) });
  const said = report.checks.filter((entry) => entry.name.startsWith("Service file"));
  assert.deepEqual(said.map((entry) => [entry.name, entry.ok]), [["Service file " + UNIT, null], ["Service file " + JOB, null], ["Service file " + WATCH, null]]);
  assert.match(said[0].detail, /settings that Botkins did not write \(MemoryMax=1G\), so no update replaces it/);
  assert.match(said[0].fix, /`systemctl edit botkins\.service`, which every update keeps.*`sudo botkins service refresh`/);
  // On a Mac the job's file is the only place for a variable, and every one of theirs is kept.
  const mac = tempDir(t);
  const agent = serviceManager({ command, platform: "darwin", uid: 501, home: "/Users/sam", user: "sam", env: { PATH: "/usr/bin" }, run: tools({ "launchctl print": { code: 113 } }).run, root: mac, pause: async () => {} });
  const { file } = await agent.install();
  const job = readFileSync(mac + file, "utf8");
  const proxied = job.replace("    <key>PATH</key>", "    <key>HTTPS_PROXY</key>\n    <string>http://proxy.example:3128</string>\n    <key>PATH</key>");
  writeFileSync(mac + file, proxied.replace("  <key>ThrottleInterval</key>\n  <integer>5</integer>\n", ""));
  result = await agent.refresh();
  assert.deepEqual([result.changed, result.kept], [[file], []]);
  const written = readFileSync(mac + file, "utf8");
  assert.match(written, /<key>HTTPS_PROXY<\/key>\n\s*<string>http:\/\/proxy\.example:3128<\/string>/);
  assert.match(written, /<key>ThrottleInterval<\/key>/);
  assert.equal(readFileSync(mac + file + ".bak", "utf8"), proxied.replace("  <key>ThrottleInterval</key>\n  <integer>5</integer>\n", ""));
  // A setting of theirs that isn't a variable: the job's file is left as it is.
  const nice = written.replace("  <key>RunAtLoad</key>", "  <key>Nice</key>\n  <integer>5</integer>\n  <key>RunAtLoad</key>").replace("  <key>ThrottleInterval</key>\n  <integer>5</integer>\n", "");
  writeFileSync(mac + file, nice);
  result = await agent.refresh();
  assert.deepEqual([result.changed, result.kept], [[], [{ file, lines: ["Nice 5"] }]]);
  assert.equal(readFileSync(mac + file, "utf8"), nice);
});

test("a line is carried only when it is written in a form that is read as systemd reads it; any other form leaves the file alone", { skip }, async (t) => {
  // The forms of an Environment= line, and how systemd 252 itself reads each (asked of it with a
  // unit of these lines, `systemctl show -p Environment` and the environment the process got;
  // test/terminal-e2e/units.sh asks it again at each run). `true`: read here exactly as systemd
  // reads it, so it can be written anew. `false`: the person's own way of writing it.
  for (const [value, carried, why] of [
    ["A=plain", true],
    ['"B=two words"', true],
    ['"A=plain"', true, "quotes that are not needed change nothing"],
    ["D=a$b", true, 'a "$" is only a "$" in a variable'],
    ["E=a$$b", true, "and two are two"],
    ["F=100%%", true, 'a doubled "%" is a "%"'],
    ['"G=q\\"uote"', true],
    ['"H=back\\\\slash"', true],
    ["J=one K=two", true, "two variables on a line"],
    ["'C=single quoted'", false, "systemd reads single quotes as quotes"],
    ['"I=line\\nbreak"', false, "systemd reads \\n in quotes as a line break"],
    ["L=%n", false, "a specifier: systemd puts the unit's name there"],
    ['"M=a"b', false, "two parts run together"],
    ['"N=open', false],
    ["O=a\\b", false],
    ["", false, "an empty value takes away what was set before"],
  ]) assert.equal(sameForm(value), carried, value + (why ? ": " + why : ""));
  assert.equal(sameForm("/opt/a$$b/botkins serve", true), true);
  assert.equal(sameForm("/opt/a$b/botkins serve", true), false, 'in a command line a single "$" starts a variable');
  // What is carried comes back with the same meaning, in the form written here.
  const plain = systemUnit({ command, dataDir: "/var/lib/botkins", key: { file: "/etc/botkins/host.key" }, allowPaths: ["/srv/projects"] });
  const add = (lines) => plain.replace("\nExecStart=", "\n" + lines.join("\n") + "\nExecStart=");
  const kept = add(['Environment="HTTPS_PROXY=http://proxy.example:3128"', "  Environment = PRICE=a$b RATE=100%%", 'Environment="NOTE=two words" OTHER=x']);
  assert.deepEqual(odd("systemd", kept), []);
  assert.deepEqual(readSystemUnit(kept).env, { HTTPS_PROXY: "http://proxy.example:3128", PRICE: "a$b", RATE: "100%", NOTE: "two words", OTHER: "x" });
  const made = systemUnit(readSystemUnit(kept));
  for (const line of ["Environment=HTTPS_PROXY=http://proxy.example:3128", "Environment=PRICE=a$b", "Environment=RATE=100%%", 'Environment="NOTE=two words"', "Environment=OTHER=x"]) assert.ok(made.includes("\n" + line + "\n"), line);
  assert.deepEqual(strange("systemd", kept, made), []);
  // A folder of theirs on a line that stands before the one written here is one more folder, not an unreadable file.
  assert.deepEqual(readSystemUnit(add(["ReadWritePaths=/srv/more /srv/projects"])).allowPaths, ["/srv/more", "/srv/projects"]);
  // What is not: each of these is found, by its own line, before any new text is made.
  for (const line of ["Environment='HTTPS_PROXY=http://proxy.example:3128'", 'Environment="GREETING=hello\\nworld"', "Environment=HOME_OF=%h", "Environment=", "Environment=NOT_A_SETTING", "Environment=1ST=x", "ReadWritePaths=-/srv/maybe", "ReadWritePaths=+/srv/x", "ReadWritePaths=", "ReadWritePaths=relative/path", "this is no setting", "ExecStartPre=/bin/true \\"]) {
    assert.deepEqual(odd("systemd", add([line])), [line.trim()], line);
  }
  // Settings systemd takes that a narrow look would pass over: a space before the name or around
  // the "=", a name with a "-" in it. Each is a setting, and a changed or added one is the person's.
  assert.deepEqual(strange("systemd", plain.replace("RestartSec=3", "  RestartSec=30"), plain), ["RestartSec=30"]);
  assert.deepEqual(strange("systemd", plain.replace("Restart=on-failure", "Restart = always"), plain), ["Restart=always"]);
  assert.deepEqual(strange("systemd", plain.replace("\n[Install]", "X-Note=mine\n\n[Install]"), plain), ["X-Note=mine"]);
  assert.deepEqual(strange("systemd", plain.replace("\n[Install]", "\n[X-Mine]\nKey=1\n\n[Install]"), plain), ["[X-Mine]", "Key=1"]);
  assert.deepEqual(strange("systemd", plain.replace("RestartSec=3", "  RestartSec = 3").replace("[Service]", "  [Service]  ") + "; a note\n", plain), [], "the same settings, spaced another way, are the same settings");
  // A command with one of systemd's marks before it, or two commands, is not read as how Botkins is started.
  assert.throws(() => readSystemUnit(plain.replace("ExecStart=/opt", "ExecStart=-/opt")), { code: "UNREADABLE_UNIT" });
  assert.throws(() => readSystemUnit(plain.replace("\nExecStart=", "\nExecStart=/bin/true serve\nExecStart=")), { code: "UNREADABLE_UNIT" });

  // With the whole computer's service installed: a file with such a line is not written and not
  // thrown at; it is left, named, and the other files are still brought up to date.
  const root = tempDir(t);
  const { manager, calls } = await systemInstall(root, { allowPaths: ["/srv/projects"] });
  const fresh = readFileSync(root + UNIT, "utf8");
  for (const line of ["Environment='HTTPS_PROXY=http://proxy.example:3128'", "ReadWritePaths=-/srv/maybe", "Environment=PRICE=%h/x"]) {
    const theirs = older(fresh).replace("\nExecStart=", "\n" + line + "\nExecStart=");
    writeFileSync(root + UNIT, theirs);
    writeFileSync(root + JOB, readFileSync(root + JOB, "utf8").replace("UMask=0022\n", ""));
    calls.length = 0;
    const result = await manager.refresh();
    assert.deepEqual([result.changed, result.kept], [[JOB], [{ file: UNIT, lines: [line] }]], line);
    assert.equal(readFileSync(root + UNIT, "utf8"), theirs);
    assert.equal(existsSync(root + UNIT + ".bak"), false);
  }
  // A variable they quoted without need is carried: the new file has it, and the copy of the old one is beside it.
  const quoted = older(fresh).replace("\nExecStart=", '\nEnvironment="HTTPS_PROXY=http://proxy.example:3128"\nExecStart=');
  writeFileSync(root + UNIT, quoted);
  assert.deepEqual((await manager.refresh()).changed, [UNIT]);
  assert.ok(readFileSync(root + UNIT, "utf8").includes("\nEnvironment=HTTPS_PROXY=http://proxy.example:3128\n"));
  assert.equal(readFileSync(root + UNIT + ".bak", "utf8"), quoted);
  // Uninstalling takes the kept copies away with the files.
  await manager.uninstall();
  assert.deepEqual(readdirSync(root + "/etc/systemd/system"), []);
});

test("a job file on macOS is read whole or not at all", { skip }, () => {
  const job = launchdJob(agent0());
  // Every way XML has of writing a character is read back, and written the one way it is written here.
  const entities = job.replace("    <key>NODE_ENV</key>", "    <key>GREETING</key>\n    <string>&quot;hi&quot; &apos;there&apos; &#65;&#x42; a&amp;b &lt;c&gt;</string>\n    <key>NODE_ENV</key>");
  assert.deepEqual(readLaunchdJob(entities).env, { GREETING: '"hi" \'there\' AB a&b <c>' });
  assert.match(launchdJob(readLaunchdJob(entities)), /<string>"hi" 'there' AB a&amp;b &lt;c&gt;<\/string>/);
  assert.deepEqual(strange("launchd", entities, launchdJob(readLaunchdJob(entities))), []);
  // A comment changes nothing launchd does.
  assert.deepEqual(readLaunchdJob(job.replace("<dict>", "<dict>\n  <!-- mine -->")), readLaunchdJob(job));
  // Kinds of value that are not written here, a part kept as it is, or anything after the end: the file is not read.
  for (const bad of [
    job.replace("  <key>RunAtLoad</key>", "  <key>Nice</key>\n  <real>1.5</real>\n  <key>RunAtLoad</key>"),
    job.replace("  <key>RunAtLoad</key>", "  <key>StartCalendarInterval</key>\n  <date>2026-01-01T00:00:00Z</date>\n  <key>RunAtLoad</key>"),
    job.replace("<string>production</string>", "<string><![CDATA[production]]></string>"),
    job.replace("</plist>", "</plist>\n<dict/>"),
    job.replace("</plist>", "<string>more</string>\n</plist>"),
  ]) assert.throws(() => readLaunchdJob(bad), { code: "UNREADABLE_UNIT" });
});

test("the files every release wrote are still read as Botkins' own, so an update brings them up to date", { skip }, () => {
  // test/fixtures/service-files/<version> holds what that release's own code wrote. When a
  // function in units.mjs stops writing a line, or writes it differently, the earlier line has
  // to go into ONCE_WRITTEN there: without it, every computer that installed that release has a
  // file that looks changed by hand, and no update would ever replace it.
  //
  // This pins nothing today. The functions write what 0.16.5 wrote, so ONCE_WRITTEN is rightly
  // empty and these files pass by being the same. It is a guard for the next change to those
  // functions, and its passing now is no proof of anything about a change not yet made.
  const folder = new URL("./fixtures/service-files/", import.meta.url);
  const versions = readdirSync(folder).filter((name) => /^\d+\.\d+\.\d+$/.test(name));
  assert.ok(versions.includes("0.16.5"));
  const choices = { command, dataDir: "/var/lib/botkins" };
  for (const version of versions) {
    for (const name of readdirSync(new URL(version + "/", folder))) {
      const text = readFileSync(new URL(version + "/" + name, folder), "utf8");
      const [kind, made] = name.endsWith(".plist") ? ["launchd", launchdJob(readLaunchdJob(text))] : name === "user.service" ? ["systemd", userUnit(readUserUnit(text))] : name.startsWith("botkins-update.") ? ["systemd", updateUnits(choices)[name]] : ["systemd", systemUnit(readSystemUnit(text))];
      assert.deepEqual(strange(kind, text, made), [], version + "/" + name + ": add the earlier line to ONCE_WRITTEN in desktop/terminal/units.mjs");
    }
  }
  // What the list is for: a line this version no longer writes is one of Botkins' own, not the person's.
  const unit = systemUnit({ ...choices, key: { file: "/etc/botkins/host.key" } });
  assert.deepEqual(strange("systemd", unit.replace("RestartSec=3", "RestartSec=2"), unit), ["RestartSec=2"]);
  ONCE_WRITTEN.systemd.push("RestartSec=2");
  try {
    assert.deepEqual(strange("systemd", unit.replace("RestartSec=3", "RestartSec=2"), unit), []);
  } finally {
    ONCE_WRITTEN.systemd.pop();
  }
});

test("the files go back as they were, and what a newer version added is taken out", { skip }, async (t) => {
  const root = tempDir(t);
  const { manager, calls } = await systemInstall(root, { allowPaths: ["/srv/projects"] });
  const before = { unit: older(readFileSync(root + UNIT, "utf8")), watch: readFileSync(root + WATCH, "utf8"), record: readFileSync(root + RECORD, "utf8") };
  writeFileSync(root + UNIT, before.unit);
  const saved = manager.snapshot();
  assert.deepEqual([saved.kind, saved.scope, saved.file], ["systemd", "system", UNIT]);
  // Nothing changed: no file is written. systemd is told to read the files all the same, and the
  // units that start with the computer are linked again: this may be a second try after one that
  // wrote the files and then could not have them read, and the files say nothing of what systemd has loaded.
  assert.equal(await manager.restore(saved), false);
  assert.deepEqual(calls, ["systemctl daemon-reload", "systemctl is-enabled botkins-update.path", "systemctl reenable botkins-update.path", "systemctl is-enabled botkins-update.service", "systemctl is-enabled botkins.service", "systemctl reenable botkins.service", "systemctl try-restart botkins-update.path"]);
  // What a newer version did: its own text in the files, a changed watch and record, and one more unit.
  await manager.refresh();
  writeFileSync(root + WATCH, before.watch.replace("update-requested", "another-name"));
  writeFileSync(root + RECORD, '{"version":2}\n');
  writeFileSync(root + "/etc/systemd/system/botkins-tidy.timer", "[Timer]\nOnCalendar=daily\n");
  // Somebody else's unit, added meanwhile, is not the service's.
  writeFileSync(root + "/etc/systemd/system/other.service", "[Service]\nExecStart=/bin/true\n");
  // And a unit with a name like the service's own that the update did not write: not this update's to take away.
  writeFileSync(root + "/etc/systemd/system/botkins-backup.timer", "[Timer]\nOnCalendar=weekly\n");
  calls.length = 0;
  // The new version said which files it wrote. Only those of them that were not there before are removed.
  assert.equal(await manager.restore(saved, [UNIT, WATCH, RECORD, "/etc/systemd/system/botkins-tidy.timer", "/etc/passwd", "/etc/systemd/system/other.service"]), true);
  assert.equal(readFileSync(root + UNIT, "utf8"), before.unit);
  assert.equal(readFileSync(root + WATCH, "utf8"), before.watch);
  assert.equal(readFileSync(root + RECORD, "utf8"), before.record);
  assert.equal(existsSync(root + "/etc/systemd/system/botkins-tidy.timer"), false);
  assert.equal(existsSync(root + "/etc/systemd/system/other.service"), true);
  assert.equal(existsSync(root + "/etc/systemd/system/botkins-backup.timer"), true);
  // systemd reads the files again, and a unit that starts with the computer is linked again from
  // the file that is back: the newer version may have linked it somewhere else.
  assert.deepEqual(calls, ["systemctl disable --now botkins-tidy.timer", "systemctl daemon-reload", "systemctl is-enabled botkins-update.path", "systemctl reenable botkins-update.path", "systemctl is-enabled botkins-update.service", "systemctl is-enabled botkins.service", "systemctl reenable botkins.service", "systemctl try-restart botkins-update.path"]);
  // Told that it wrote no file, nothing is removed.
  writeFileSync(root + "/etc/systemd/system/botkins-tidy.timer", "[Timer]\nOnCalendar=daily\n");
  writeFileSync(root + UNIT, before.unit + "# changed again\n");
  await manager.restore(saved, []);
  assert.equal(existsSync(root + "/etc/systemd/system/botkins-tidy.timer"), true);
  assert.equal(readFileSync(root + UNIT, "utf8"), before.unit);
  // Never told what it wrote (the new version's program ended badly, or said something that is no
  // answer): it may have added files all the same. Nothing tells them from anyone else's, so every
  // file with a name of the service's own that was not there before goes. Other names stay.
  calls.length = 0;
  assert.equal(await manager.restore(saved), true);
  assert.equal(existsSync(root + "/etc/systemd/system/botkins-tidy.timer"), false);
  assert.equal(existsSync(root + "/etc/systemd/system/botkins-backup.timer"), false);
  assert.equal(existsSync(root + "/etc/systemd/system/other.service"), true);
  assert.deepEqual(calls.slice(0, 3), ["systemctl disable --now botkins-backup.timer", "systemctl disable --now botkins-tidy.timer", "systemctl daemon-reload"]);
  assert.equal(await manager.restore(null), false);
});

test("on macOS a changed job is taken out and loaded again, because launchd reads its file only then", { skip }, async (t) => {
  const root = tempDir(t);
  const home = "/Users/sam";
  let loaded = 2;
  // launchd takes a moment to let go of the job: the first looks after a bootout still find it.
  const { calls, run } = tools({ "launchctl print": () => (loaded-- > 0 ? {} : { code: 113 }) });
  const waits = [];
  const manager = serviceManager({ command, platform: "darwin", uid: 501, home, user: "sam", env: { PATH: "/opt/homebrew/bin:/usr/bin" }, run, root, pause: async (ms) => void waits.push(ms) });
  const { file } = await manager.install();
  const fresh = readFileSync(root + file, "utf8");
  const old = fresh.replace("  <key>ThrottleInterval</key>\n  <integer>5</integer>\n", "");
  assert.notEqual(old, fresh);
  writeFileSync(root + file, old);
  const saved = manager.snapshot();
  calls.length = 0;
  assert.deepEqual((await manager.refresh({ write: false })).changed, [file]);
  assert.deepEqual(calls, []);
  assert.deepEqual((await manager.refresh()).changed, [file]);
  assert.equal(readFileSync(root + file, "utf8"), fresh);
  assert.match(fresh, /<key>PATH<\/key>\n\s*<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  assert.deepEqual(calls, ["launchctl bootout gui/501/app.botkins.terminal", "launchctl print gui/501/app.botkins.terminal", "launchctl print gui/501/app.botkins.terminal", "launchctl print gui/501/app.botkins.terminal", "launchctl bootstrap gui/501 " + root + file, "launchctl enable gui/501/app.botkins.terminal"]);
  assert.deepEqual(waits, [200, 200], "it waits for launchd, and no longer than it has to");
  // And back.
  calls.length = 0;
  loaded = 0;
  assert.equal(await manager.restore(saved), true);
  assert.equal(readFileSync(root + file, "utf8"), old);
  assert.deepEqual(calls, ["launchctl bootout gui/501/app.botkins.terminal", "launchctl print gui/501/app.botkins.terminal", "launchctl bootstrap gui/501 " + root + file, "launchctl enable gui/501/app.botkins.terminal"]);
  // The desktop app's own job, should it have one beside this, is not the terminal host's.
  writeFileSync(root + home + "/Library/LaunchAgents/app.botkins.desktop.plist", "x");
  assert.deepEqual(Object.keys(manager.snapshot().files), [file]);
});

/** A release tarball as scripts/package-terminal.mjs makes one, small. */
function release(dir, version) {
  const name = folderName(version, "linux", "arm64");
  const stage = join(dir, "stage-" + version);
  for (const [file, text] of Object.entries({ "bin/botkins": "#!/bin/sh\n", "cli/botkins.mjs": "// " + version + "\n", "package.json": JSON.stringify({ version }), "desktop/linux-service/botkins-release.asc": "KEY" })) {
    mkdirSync(join(stage, name, file, ".."), { recursive: true });
    writeFileSync(join(stage, name, file), text);
  }
  const archive = join(dir, name + ".tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", stage, name]);
  return { name, archive };
}
function installed(dir, version) {
  const installRoot = join(dir, "opt");
  const { name } = release(dir, version);
  mkdirSync(installRoot);
  execFileSync("tar", ["-xzf", join(dir, name + ".tar.gz"), "-C", installRoot]);
  symlinkSync(name, join(installRoot, "current"));
  return { installRoot, entry: join(installRoot, "current", "cli", "botkins.mjs") };
}

test("an update has the new version write the service's files before the restart, and puts them back with the old version", { skip }, async (t) => {
  const dir = tempDir(t);
  const { installRoot } = installed(dir, "1.2.3");
  const versionOf = (folder) => /botkins-terminal-([\d.]+)-/.exec(folder)[1];
  const current = () => versionOf(realpathSync(join(installRoot, "current")));
  // A service with one file, and a log of what is done to it, in order.
  const files = { unit: "as 1.2.3 wrote it" };
  const steps = [];
  const service = (status) => ({
    snapshot: () => (steps.push("snapshot"), { ...files }),
    restore: async (saved, written) => void (steps.push("restore" + (written ? " (it wrote " + written.join(", ") + ")" : " (it never said what it wrote)")), Object.assign(files, saved)),
    restart: async () => void steps.push("restart on " + current() + " under: " + files.unit),
    status,
  });
  const steady = async () => ({ active: true, pid: 7 });
  const writes = (folder) => (steps.push("refresh by " + versionOf(folder)), (files.unit = "as " + versionOf(folder) + " writes it"), ["/unit", "/added-by-" + versionOf(folder)]);
  const options = { installRoot, platform: "linux", arch: "arm64", healthMs: 40, pollMs: 5, checkOwner: false };
  // The new version is in place and is the one asked; the service then starts under its files.
  const done = await switchTo({ ...options, archive: release(dir, "1.3.0").archive, version: "1.3.0", manager: service(steady), refresh: writes });
  assert.deepEqual(done, { version: "1.3.0", folder: join(installRoot, folderName("1.3.0", "linux", "arm64")), previous: "1.2.3" });
  assert.deepEqual(steps, ["snapshot", "refresh by 1.3.0", "restart on 1.3.0 under: as 1.3.0 writes it"]);
  // By default the one asked is the new version's own program, told not to restart anything.
  const ran = [];
  const exec = async (file, args, opts) => (file === "tar" ? { stdout: execFileSync(file, args, { encoding: "utf8", ...opts }) } : (ran.push([file, ...args].join(" ")), { stdout: "{}" }));
  await switchTo({ ...options, archive: release(dir, "1.3.1").archive, version: "1.3.1", manager: service(steady), exec });
  assert.deepEqual(ran, [join(installRoot, folderName("1.3.1", "linux", "arm64"), "bin", "botkins") + " service refresh --no-restart --json"]);
  // A new version that doesn't stay up: the old one is back, under the files it had.
  steps.length = 0;
  files.unit = "as 1.3.1 wrote it";
  await assert.rejects(switchTo({ ...options, archive: release(dir, "1.4.0").archive, version: "1.4.0", manager: service(async () => ({ active: false })), refresh: writes }), /didn't stay running\. Botkins 1\.3\.1 was put back\.$/);
  // The old version's updater is told which files the new version wrote, so it takes away the ones that were added and no others.
  assert.deepEqual(steps, ["snapshot", "refresh by 1.4.0", "restart on 1.4.0 under: as 1.4.0 writes it", "restore (it wrote /unit, /added-by-1.4.0)", "restart on 1.3.1 under: as 1.3.1 wrote it"]);
  assert.equal(current(), "1.3.1");
  // A new version that can't write its files: they are left as they were, whatever it had
  // half done, and the update goes on. The person is told, and so is `botkins doctor`.
  steps.length = 0;
  const half = () => {
    files.unit = "half written";
    throw Object.assign(new Error("Command failed"), { stderr: "something earlier\nbotkins: The installed service file doesn't say which user the service runs as.\n" });
  };
  const noted = await switchTo({ ...options, archive: release(dir, "1.5.0").archive, version: "1.5.0", manager: service(steady), refresh: half });
  assert.equal(noted.note, "The service's files could not be brought up to date with Botkins 1.5.0 (The installed service file doesn't say which user the service runs as.). On the computer, `botkins doctor` says what to do.");
  // It never said which files it wrote, so the updater knows of none it may leave: every one it may have added goes.
  assert.deepEqual(steps, ["snapshot", "restore (it never said what it wrote)", "restart on 1.5.0 under: as 1.3.1 wrote it"]);
  // When that version then doesn't stay up either, the reason is said with it, and nothing is restored twice.
  steps.length = 0;
  await assert.rejects(switchTo({ ...options, archive: release(dir, "1.6.0").archive, version: "1.6.0", manager: service(async () => ({ active: false })), refresh: half }), /didn't stay running\. The service's files could not be brought up to date with Botkins 1\.6\.0 \(.*\)\. Botkins 1\.5\.0 was put back\.$/);
  assert.deepEqual(steps, ["snapshot", "restore (it never said what it wrote)", "restart on 1.6.0 under: as 1.3.1 wrote it", "restart on 1.5.0 under: as 1.3.1 wrote it"]);
  // A new version that can't write its files, and files that then can't be put back either:
  // nobody knows what the service would start under, so this update does not go on. The old
  // version is put back, the files are tried once more, and the update is one that failed.
  steps.length = 0;
  let tries = 0;
  const broken = { ...service(steady), restore: async () => { steps.push("restore, try " + ++tries); throw new Error("Reloading systemd failed"); } };
  await assert.rejects(switchTo({ ...options, archive: release(dir, "1.6.1").archive, version: "1.6.1", manager: broken, refresh: half }), /^Error: The service's files could not be brought up to date with Botkins 1\.6\.1 \(The installed service file doesn't say which user the service runs as\.\)\. The service's files could not be put back as Botkins 1\.5\.0 had them \(Reloading systemd failed\)\. On the computer, `botkins doctor` says what to do\. Botkins 1\.5\.0 was put back\.$/);
  assert.deepEqual(steps, ["snapshot", "restore, try 1", "restore, try 2", "restart on 1.5.0 under: half written"]);
  assert.equal(current(), "1.5.0");
  assert.equal(existsSync(join(installRoot, folderName("1.6.1", "linux", "arm64"))), false);
  // The second try may work (the old version is `current` again by then): the files are as they were, and the update still failed.
  steps.length = 0;
  tries = 0;
  const second = { ...service(steady), restore: async (saved) => { steps.push("restore, try " + ++tries); if (tries === 1) throw new Error("Reloading systemd failed"); Object.assign(files, saved); } };
  files.unit = "as 1.3.1 wrote it";
  await assert.rejects(switchTo({ ...options, archive: release(dir, "1.6.2").archive, version: "1.6.2", manager: second, refresh: half }), /^Error: The service's files could not be brought up to date with Botkins 1\.6\.2 \(.*\)\. Botkins 1\.5\.0 was put back\.$/);
  assert.deepEqual(steps, ["snapshot", "restore, try 1", "restore, try 2", "restart on 1.5.0 under: as 1.3.1 wrote it"]);
  // Files that can't be put back are said too: the old version then runs under the newer ones.
  const stuck = { ...service(async () => ({ active: false })), restore: async () => { throw new Error("Reloading systemd failed"); } };
  await assert.rejects(switchTo({ ...options, archive: release(dir, "1.6.3").archive, version: "1.6.3", manager: stuck, refresh: writes }), /didn't stay running\. The service's files could not be put back as Botkins 1\.5\.0 had them \(Reloading systemd failed\)\. On the computer, `botkins doctor` says what to do\. Botkins 1\.5\.0 was put back\.$/);
  files.unit = "as 1.3.1 wrote it";
  steps.length = 0;
  // A service manager from before this (or a test's stand-in) is restarted as it always was.
  steps.length = 0;
  await switchTo({ ...options, archive: release(dir, "1.7.0").archive, version: "1.7.0", manager: { restart: async () => void steps.push("restart"), status: steady }, refresh: writes });
  assert.deepEqual(steps, ["restart"]);
  // With no service installed there are no files to keep up to date.
  await switchTo({ ...options, archive: release(dir, "1.8.0").archive, version: "1.8.0", refresh: writes });
  assert.deepEqual(steps, ["restart"]);
});

test("with the real service manager: what a failed refresh added is taken away, and a second put-back has systemd read the files again", { skip }, async (t) => {
  const dir = tempDir(t);
  const root = join(dir, "root");
  mkdirSync(root);
  // systemd as the manager asks it: the service is up, and at one point reloading fails once.
  let reloadFails = 0;
  const answers = { "systemctl show": { stdout: "ActiveState=active\nSubState=running\nMainPID=7\n" }, "systemctl daemon-reload": () => (reloadFails-- > 0 ? { code: 1, stderr: "Failed to reload daemon: Connection timed out" } : {}) };
  const { manager, calls } = await systemInstall(root, { answers });
  const { installRoot } = installed(dir, "1.2.3");
  const before = readFileSync(root + UNIT, "utf8");
  const tidy = root + "/etc/systemd/system/botkins-tidy.timer";
  const options = { installRoot, platform: "linux", arch: "arm64", healthMs: 30, pollMs: 5, checkOwner: false, manager };
  // The new version's program changes a file, adds a unit of its own, and then ends badly without
  // saying what it wrote. (Nothing adds a unit today; a later version may.)
  const half = async () => {
    writeFileSync(root + UNIT, before + "# half written\n");
    writeFileSync(tidy, "[Timer]\nOnCalendar=daily\n");
    throw Object.assign(new Error("Command failed"), { stderr: "botkins: it broke\n" });
  };
  const done = await switchTo({ ...options, archive: release(dir, "1.3.0").archive, version: "1.3.0", refresh: half });
  assert.match(done.note, /could not be brought up to date with Botkins 1\.3\.0 \(it broke\)/);
  assert.equal(readFileSync(root + UNIT, "utf8"), before);
  assert.equal(existsSync(tidy), false, "the unit it added is not left behind");
  assert.deepEqual(calls.slice(0, 3), ["systemctl disable --now botkins-tidy.timer", "systemctl daemon-reload", "systemctl is-enabled botkins-update.path"]);
  assert.ok(calls.indexOf("systemctl restart botkins.service") > calls.indexOf("systemctl daemon-reload"), "the service starts under files systemd has read again");
  // Now the put-back writes the files and systemd then can't be made to read them. The update
  // does not go on. The old version comes back, and the second put-back, which finds the files
  // already as they were, still has systemd read them and links the units again: without that
  // the old files would be on disk and the new units loaded, with nothing said.
  calls.length = 0;
  reloadFails = 1;
  await assert.rejects(switchTo({ ...options, archive: release(dir, "1.4.0").archive, version: "1.4.0", refresh: half }), /^Error: The service's files could not be brought up to date with Botkins 1\.4\.0 \(it broke\)\. Botkins 1\.3\.0 was put back\.$/);
  assert.equal(readFileSync(root + UNIT, "utf8"), before);
  assert.equal(existsSync(tidy), false);
  const reloads = calls.flatMap((call, at) => (call === "systemctl daemon-reload" ? [at] : []));
  assert.equal(reloads.length, 2, "tried again after the one that failed");
  assert.deepEqual(calls.slice(reloads[1], reloads[1] + 3), ["systemctl daemon-reload", "systemctl is-enabled botkins-update.path", "systemctl reenable botkins-update.path"]);
  assert.ok(calls.slice(reloads[1]).includes("systemctl reenable botkins.service"));
  assert.ok(calls.lastIndexOf("systemctl restart botkins.service") > reloads[1], "and only then is the old version started");
  assert.equal(realpathSync(join(installRoot, "current")), join(installRoot, folderName("1.3.0", "linux", "arm64")));
  // When systemd can't be made to read them the second time either, that is said: the old version runs under whatever is loaded.
  reloadFails = 2;
  await assert.rejects(switchTo({ ...options, archive: release(dir, "1.5.0").archive, version: "1.5.0", refresh: half }), /could not be brought up to date with Botkins 1\.5\.0 \(it broke\)\. The service's files could not be put back as Botkins 1\.3\.0 had them \(Reloading systemd failed .*Connection timed out\)\. On the computer, `botkins doctor` says what to do\. Botkins 1\.3\.0 was put back\.$/);
});

test("an install that went well, with files that could not be written, says so in its record", { skip }, async (t) => {
  const dir = tempDir(t);
  const { entry } = installed(dir, "1.2.3");
  const next = release(dir, "1.3.0");
  const fetcher = async (url) => {
    const file = url.split("/").at(-1);
    const body = file === next.name + ".tar.gz" ? readFileSync(next.archive) : Buffer.from("sums");
    return new Response(body, { status: 200 });
  };
  const records = [];
  // The key the installed copy came with has to be a real one for the check to start, and GnuPG has to be there to read it.
  writeFileSync(join(dir, "opt", folderName("1.2.3", "linux", "arm64"), "desktop/linux-service/botkins-release.asc"), readFileSync(new URL("../desktop/linux-service/botkins-release.asc", import.meta.url)));
  try {
    execFileSync("gpg", ["--version"], { stdio: "ignore" });
  } catch {
    return t.skip("GnuPG is not installed here, and an update needs it to read the release key.");
  }
  const manager = { snapshot: () => ({}), restore: async () => {}, restart: async () => {}, status: async () => ({ active: true, pid: 1 }) };
  // The stand-in for the new version's program fails: its tarball holds only a line of sh.
  const result = await applyUpdate({ entry, platform: "linux", arch: "arm64", manager, healthMs: 30, latest: async () => ({ version: "1.3.0", assets: [next.name + ".tar.gz", "SHA256SUMS", "SHA256SUMS.asc"] }), fetcher, verifier: async () => {}, report: (record) => records.push(record), now: () => new Date("2026-02-03T04:05:06Z") });
  assert.equal(result.status, "installed");
  assert.match(result.note, /^The service's files could not be brought up to date with Botkins 1\.3\.0 \(.+\)\. On the computer, `botkins doctor` says what to do\.$/);
  assert.deepEqual(records, [{ at: "2026-02-03T04:05:06.000Z", from: "1.2.3", to: "1.3.0", ok: true, message: result.note }]);
});

test("`botkins doctor` says when the service runs under files an earlier version wrote", { skip }, async (t) => {
  const root = tempDir(t);
  const paths = { root: join(root, "data"), config: join(root, "data", "config.json"), socket: join(root, "data", "run", "botkins.sock") };
  const client = { call: async () => { throw Object.assign(new Error("not running"), { code: "NOT_RUNNING" }); } };
  const look = async (units) => (await examine({ paths, client, env: {}, fetcher: async () => new Response(""), node: "24.1.0", units })).checks.find((entry) => entry.name === "Service files");
  assert.deepEqual(await look(async () => ({ scope: "system", file: UNIT, changed: [] })), { name: "Service files", ok: true, detail: UNIT + " is as this version of Botkins writes it." });
  const stale = await look(async () => ({ scope: "system", file: UNIT, changed: [UNIT, WATCH] }));
  assert.equal(stale.ok, false);
  assert.match(stale.detail, /Not the ones this version of Botkins writes: \/etc\/systemd\/system\/botkins\.service, \/etc\/systemd\/system\/botkins-update\.path\./);
  assert.match(stale.fix, /`sudo botkins service refresh`/);
  assert.match((await look(async () => ({ scope: "user", file: "/home/sam/.config/systemd/user/botkins.service", changed: ["x"] }))).fix, /`botkins service refresh`/);
  // Not installed as a service: nothing to say. A file that can't be read back: said, and not as a failure.
  assert.equal(await look(async () => { throw Object.assign(new Error("none"), { code: "NOT_INSTALLED" }); }), undefined);
  const unread = await look(async () => { throw Object.assign(new Error("The installed service file doesn't say which user the service runs as."), { code: "UNREADABLE_UNIT" }); });
  assert.deepEqual([unread.ok, unread.detail], [null, "The installed service file doesn't say which user the service runs as."]);
  // The real look, at a real install in a folder of the test's own.
  const { manager } = await systemInstall(root);
  assert.equal((await look(() => manager.refresh({ write: false }))).ok, true);
  writeFileSync(root + UNIT, older(readFileSync(root + UNIT, "utf8")));
  assert.equal((await look(() => manager.refresh({ write: false }))).ok, false);
});
