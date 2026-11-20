// The terminal host's settings (desktop/terminal/config.mjs) and its log (desktop/terminal/logs.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changed, defaults, loadConfig, parseValue, read, saveConfig, SETTINGS, validate, withSetting } from "../desktop/terminal/config.mjs";
import { createLog, scrub } from "../desktop/terminal/logs.mjs";
import { systemRoot, terminalPaths, userRoot } from "../desktop/terminal/paths.mjs";

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-conf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("every setting has a default that is valid, and a line that says what it is", () => {
  const config = defaults();
  assert.deepEqual(validate(config), { config, problems: [] });
  for (const [key, setting] of Object.entries(SETTINGS)) {
    assert.equal(setting.check(setting.default), null, key);
    assert.ok(setting.about.length > 10, key);
  }
  assert.equal(config.link.enabled, true, "a terminal host is there to be reached by phones");
  assert.equal(config.relay.enabled, false, "the relay is off until the person turns it on");
  assert.equal(config.secrets.source, "auto");
});

test("a config names only what it changes, and anything wrong is said one line each", () => {
  assert.deepEqual(validate({ name: "Studio", link: { port: 5000 } }).config, { ...defaults(), name: "Studio", link: { ...defaults().link, port: 5000 } });
  const { problems } = validate({ name: 5, link: { port: 70000, bogus: true }, relay: { url: "http://example.com" }, extra: {}, secrets: { source: "tpm" }, providers: { only: ["Claude!"] } });
  assert.deepEqual(problems.sort(), [
    "extra is not a setting. Run `botkins config get` to see them all.",
    "link.bogus is not a setting. Run `botkins config get` to see them all.",
    "link.port must be a whole number from 1 to 65535.",
    "name must be a line of text, 60 characters at most.",
    "providers.only must be a list of up to 20 entries, each a provider's id, such as claude.",
    "relay.url must be the relay's https address.",
    "secrets.source must be one of: auto, systemd, keychain, file.",
  ]);
  for (const bad of [null, [], "text", 5]) assert.equal(validate(bad).problems.length, 1);
  // A group given as something else is a problem, not a crash.
  assert.match(validate({ link: true }).problems[0], /link is not a setting/);
});

test("a value typed on a command line becomes the setting's kind", () => {
  assert.equal(parseValue("link.enabled", "off"), false);
  assert.equal(parseValue("link.enabled", "yes"), true);
  assert.equal(parseValue("link.port", "47611"), 47611);
  assert.equal(parseValue("link.port", "abc"), "abc", "left as typed, so the check names the problem");
  assert.deepEqual(parseValue("link.addresses", "a.example.com, 10.0.0.5"), ["a.example.com", "10.0.0.5"]);
  // A port is not part of an address: phones use the link's own.
  assert.throws(() => withSetting(defaults(), "link.addresses", ["a.example.com:47610"]), /without a port/);
  assert.deepEqual(parseValue("link.addresses", '["a.example.com"]'), ["a.example.com"]);
  assert.deepEqual(parseValue("providers.only", ""), []);
  assert.equal(parseValue("secrets.keyFile", "none"), null);
  assert.equal(parseValue("secrets.keyFile", "/etc/botkins/host.key"), "/etc/botkins/host.key");
  assert.equal(parseValue("name", "true"), "true", "a name is text, whatever it looks like");
  assert.throws(() => parseValue("nope", "1"), /nope is not a setting/);
  const next = withSetting(defaults(), "relay.enabled", true);
  assert.equal(next.relay.enabled, true);
  assert.deepEqual(changed(defaults(), next), ["relay.enabled"]);
  assert.throws(() => withSetting(defaults(), "link.port", "abc"), /link\.port must be a whole number/);
  assert.throws(() => withSetting(defaults(), "link.addresses", ["not an address!"]), /link\.addresses must be a list/);
  assert.equal(read(next, "link.port"), SETTINGS["link.port"].default);
});

test("the config file is the service's own, and a broken one is refused whole", (t) => {
  const file = join(tempDir(t), "root", "config.json");
  assert.deepEqual(loadConfig(file), defaults(), "no file is every default");
  const saved = saveConfig(file, { name: "Studio" });
  assert.equal(saved.name, "Studio");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadConfig(file), saved);
  writeFileSync(file, '{ "name": "Studio", ');
  assert.throws(() => loadConfig(file), /is not JSON/);
  writeFileSync(file, JSON.stringify({ name: "Studio", link: { port: 0 } }));
  assert.throws(() => loadConfig(file), (error) => error.problems.length === 1 && /link\.port/.test(error.message));
  assert.throws(() => saveConfig(file, { nope: 1 }), /nope is not a setting/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).link.port, 0, "a refused save leaves the file as it was");
});

test("the data folder is the system's for the service's user and a person's own otherwise, never the desktop app's", () => {
  const none = () => false;
  const record = () => null;
  assert.equal(terminalPaths({ env: {}, platform: "linux", home: "/home/sam", uid: 1000, owns: none, record }).root, "/home/sam/.local/share/botkins");
  assert.equal(terminalPaths({ env: { XDG_DATA_HOME: "/data" }, platform: "linux", home: "/home/sam", uid: 1000, owns: none, record }).root, "/data/botkins");
  assert.equal(terminalPaths({ env: {}, platform: "linux", home: "/root", uid: 0, owns: none, record }).root, "/var/lib/botkins");
  const service = terminalPaths({ env: {}, platform: "linux", home: "/var/lib/botkins", uid: 998, owns: (path, uid) => path === "/var/lib/botkins" && uid === 998, record });
  // A whole-computer service installed on a folder of its own choosing is found through its record.
  const moved = { record: () => ({ dataDir: "/srv/botkins" }) };
  assert.equal(terminalPaths({ env: {}, platform: "linux", uid: 0, owns: none, ...moved }).root, "/srv/botkins");
  // Someone else on that computer means the whole computer's service, unless they run one of their own.
  assert.equal(terminalPaths({ env: {}, platform: "linux", home: "/home/sam", uid: 1000, owns: none, exists: () => false, ...moved }).root, "/srv/botkins");
  assert.equal(terminalPaths({ env: {}, platform: "linux", home: "/home/sam", uid: 1000, owns: none, exists: () => true, ...moved }).root, "/home/sam/.local/share/botkins");
  assert.deepEqual([service.root, service.scope, service.socket, service.dataDir], ["/var/lib/botkins", "system", "/var/lib/botkins/run/botkins.sock", "/var/lib/botkins/data"]);
  const mac = terminalPaths({ env: {}, platform: "darwin", home: "/Users/sam", uid: 501, owns: none, record });
  assert.equal(mac.root, "/Users/sam/Library/Application Support/Botkins Terminal");
  assert.notEqual(userRoot({ platform: "darwin", home: "/Users/sam" }), "/Users/sam/Library/Application Support/Botkins");
  assert.equal(systemRoot("darwin"), "/Library/Application Support/Botkins Terminal");
  const named = terminalPaths({ root: "/srv/b", env: { BOTKINS_DATA_DIR: "/ignored", BOTKINS_SOCKET: "/run/b.sock" }, platform: "linux", uid: 1000, owns: none, record });
  assert.deepEqual([named.root, named.scope, named.socket, named.config, named.logFile], ["/srv/b", "custom", "/run/b.sock", "/srv/b/config.json", "/srv/b/logs/botkins.log"]);
  assert.equal(terminalPaths({ env: { BOTKINS_DATA_DIR: "/srv/c" }, platform: "linux", uid: 1000, owns: none, record }).socket, "/srv/c/run/botkins.sock");
});

test("what looks like a credential never reaches the log", () => {
  const hidden = [
    ["pairing botkins://pair?v=1&s=abc&k=KEYKEYKEY&c=ABCDEFGH12&h=10.0.0.2:47610 opened", /KEYKEYKEY|ABCDEFGH12/],
    ["Authorization: Bearer abc.def-ghi_jkl123456", /abc\.def/],
    ["request failed with header authorization=Basic dXNlcjpwYXNz", /dXNlcjpwYXNz/],
    ['{"access_token":"ya29.a0AfH6SMBx-secret-value","expires_in":3600}', /ya29|secret-value/],
    ["OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345", /abcdefghijklmnop/],
    ["using sk-ant-oat01-abcdefghijklmnopqrstuvwxyz for claude", /abcdefghijklmnop/],
    ["git token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected", /ghp_abcdef/],
    ["github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz was used", /11ABCDEFG0/],
    ["slack xoxb-123456789012-abcdefghijkl", /123456789012/],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV", /SflKxwRJSMeKK/],
    ["fetch https://sam:hunter2secret@example.com/path failed", /hunter2secret/],
    ["password: correct-horse-battery", /correct-horse/],
    ["client_secret=s3cr3tv4lue&grant_type=refresh", /s3cr3tv4lue/],
    ["wrapped bk1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", /AAAAAAAAAAAAAAAA/],
    ["AWS key AKIAIOSFODNN7EXAMPLE in use", /AKIAIOSFODNN7EXAMPLE/],
  ];
  for (const [line, leaked] of hidden) {
    const clean = scrub(line);
    assert.doesNotMatch(clean, leaked, line);
    assert.match(clean, /\[hidden\]/, line);
  }
  // Ordinary lines stay as they are.
  for (const line of ["link listening on 47610", "Routine run: This routine is already running", "Ready. Control socket: /var/lib/botkins/run/botkins.sock. Phone link on port 47610.", "GitHub Copilot models: Pending response rejected since connection got disposed", "paired device O2_Dpg0--d6q (Fixture phone)"]) assert.equal(scrub(line), line);
});

test("the log keeps the last lines, in a file only its user reads, and hands new ones to whoever waits", async (t) => {
  const file = join(tempDir(t), "logs", "botkins.log");
  const shown = [];
  let clock = Date.UTC(2026, 0, 2, 3, 4, 5);
  const log = createLog({ file, lines: 100, level: "info", out: (line) => shown.push(line), now: () => clock });
  log.info("first line");
  log.error("a problem with token=abcdefgh12345678");
  log.debug("not kept at this level");
  log.info("two\nlines");
  assert.deepEqual(log.read().entries.map((entry) => [entry.n, entry.level, entry.text]), [[1, "info", "first line"], [2, "error", "a problem with token=[hidden]"], [3, "info", "two"], [4, "info", "lines"]]);
  assert.equal(log.read().entries[0].time, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(log.read({ after: 2 }).entries.map((entry) => entry.text), ["two", "lines"]);
  assert.deepEqual(log.read({ tail: 1 }).entries.map((entry) => entry.text), ["lines"]);
  assert.deepEqual(log.read({ tail: 0 }).entries, []);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8"), shown.join(""));
  assert.doesNotMatch(readFileSync(file, "utf8"), /abcdefgh12345678/);
  // Someone who waits hears the next line, and nothing when none comes.
  const waiting = log.wait({ after: 4, ms: 5000 });
  log.info("the line they waited for");
  assert.deepEqual((await waiting).entries.map((entry) => entry.text), ["the line they waited for"]);
  assert.deepEqual((await log.wait({ after: 5, ms: 20 })).entries, []);
  const gone = new AbortController();
  const abandoned = log.wait({ after: 5, ms: 60_000, signal: gone.signal });
  gone.abort();
  assert.deepEqual((await abandoned).entries, []);
  log.setLevel("debug");
  log.debug("kept now");
  assert.equal(log.read({ tail: 1 }).entries[0].level, "debug");
  // What the workspace's own modules print goes through the same log, and the console is put back after.
  const target = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const original = target.log;
  const restore = log.capture(target);
  target.log("link listening on %d", 47610);
  target.error("Phone link:", "bind failed");
  assert.deepEqual(log.read({ tail: 2 }).entries.map((entry) => [entry.level, entry.text]), [["info", "link listening on 47610"], ["error", "Phone link: bind failed"]]);
  restore();
  assert.equal(target.log, original);
  // Only so many lines are kept in memory.
  const small = createLog({ lines: 100 });
  for (let index = 0; index < 150; index++) small.info("line " + index);
  assert.deepEqual([small.read().entries.length, small.read().entries[0].text, small.read().next], [100, "line 50", 150]);
});
