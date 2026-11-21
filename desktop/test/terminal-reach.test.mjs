// How a bot's shell finds the `botkins` command and the control socket (desktop/terminal/reach.mjs),
// on the terminal host and in the desktop app (desktop/terminal/control-start.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { examine } from "../cli/commands/service.mjs";
import { headlessHost } from "../desktop/host/headless.mjs";
import { createRuntime } from "../desktop/runtime.mjs";
import { startAppControl } from "../desktop/terminal/control-start.mjs";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { launcherText, prepareReach, reachable } from "../desktop/terminal/reach.mjs";
import { startService } from "../desktop/terminal/serve.mjs";
import { controlClient } from "../desktop/terminal/socket.mjs";

const skip = process.platform === "win32" && "The command and its socket are for Linux and macOS.";
const run = promisify(execFile);
const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

test("a shell with the service's environment finds `botkins` by its bare name, reaches that service, and doctor says so", { skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-reach-"));
  // A space in the folder: the launcher has to quote it.
  const paths = terminalPaths({ root: join(dir, "a b"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ providers: { only: ["grok"] }, link: { port: await freePort(), announce: false } }));
  // The service's own environment is what a bot's shell gets, so this process's is what is looked at here.
  const before = { PATH: process.env.PATH, BOTKINS_SOCKET: process.env.BOTKINS_SOCKET };
  t.after(() => {
    for (const [name, value] of Object.entries(before)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  assert.equal(reachable(process.env), false);
  const running = await startService({ paths, version: "9.9.9", trial: true, reach: true });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const launcher = join(paths.root, "run", "bin", "botkins");
  assert.equal(statSync(launcher).mode & 0o777, 0o755);
  assert.equal(statSync(join(paths.root, "run", "bin")).mode & 0o777, 0o700);
  assert.equal(process.env.BOTKINS_SOCKET, paths.socket);
  assert.equal(process.env.PATH.split(":")[0], join(paths.root, "run", "bin"));
  assert.equal(reachable(process.env), true);
  assert.equal(reachable({ PATH: process.env.PATH }), false, "no socket named, no reach");

  // A shell that is a child of the service, by the command's bare name. (Not a sync call: the service answers it.)
  const { stdout } = await run("/bin/sh", ["-c", "command -v botkins && botkins status --json"], { env: { ...process.env } });
  const [found, ...rest] = stdout.split("\n");
  assert.equal(found, launcher);
  assert.equal(JSON.parse(rest.join("\n")).pid, process.pid, "the command reached this service");

  const client = controlClient(paths.socket, { timeout: 40_000 });
  const seen = await client.call("doctor");
  assert.deepEqual(seen.botShell, { ok: true, launcher, pid: process.pid });
  const report = await examine({ paths, client, env: {}, fetcher: async () => new Response(""), freePort: async () => true, node: "24.1.0" });
  const line = report.checks.find((entry) => entry.name === "A bot's shell");
  assert.equal(line.ok, true);
  assert.match(line.detail, /^Finds `.*botkins` at .*, and it reaches this service \(process \d+\)\.$/);

  // A shell that lacks the command is told what it lacks.
  process.env.PATH = process.env.PATH.split(":").slice(1).join(":");
  const without = (await client.call("doctor")).botShell;
  assert.equal(without.ok, false);
  assert.match(without.problem, /finds no `botkins` command on its PATH/);
});

test("the window's app has the same socket, refuses what the terminal host's refuses, and a socket that does not start does not stop it", { skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-app-"));
  const root = join(dir, "app");
  const runtime = await createRuntime({ host: headlessHost({ version: "9.9.9" }), dataDir: join(root, "data"), trial: true, link: { port: await freePort(), announce: false } });
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  // The app's own environment, as a private copy: this test does not change the one it runs in.
  const env = { PATH: "/usr/bin:/bin" };
  const said = [];
  const control = await startAppControl({ runtime, root, version: "9.9.9", env, say: (line) => said.push(line) });
  assert.ok(control, said.join("\n"));
  const socket = join(root, "run", "botkins.sock");
  assert.equal(control.socket, socket);
  assert.deepEqual([statSync(socket).mode & 0o777, statSync(join(root, "run")).mode & 0o777], [0o600, 0o700]);
  assert.deepEqual([env.BOTKINS_SOCKET, reachable(env)], [socket, true]);
  assert.equal(statSync(join(root, "run", "bin", "botkins")).mode & 0o777, 0o755);

  const client = controlClient(socket, { timeout: 40_000 });
  assert.equal((await client.call("status")).pid, process.pid);
  // What the terminal host's socket refuses, this one refuses the same way: there is no `call` that reaches a password manager's unlock, and no other call for it.
  await assert.rejects(client.call("call", "unlockPasswordManager"), { code: "UNKNOWN_METHOD", message: /no call named call/ });
  await assert.rejects(client.call("credentials.unlock"), { code: "UNKNOWN_METHOD" });
  // The app has no `config set`, so the sentence for phone access that is off says where the app has it.
  await runtime.link.setEnabled(false);
  await assert.rejects(client.call("pair.start"), { code: "LINK_OFF", message: /Turn it on in the app's Settings, under Phone\./ });
  // What only the terminal host's service has is refused, and the app goes on.
  await assert.rejects(client.call("stop"), { code: "NOT_IN_THE_APP" });
  await assert.rejects(client.call("config.get"), { code: "NOT_IN_THE_APP" });
  assert.equal((await client.call("status")).running, true);

  // A second start on the same folder does not take a live socket away.
  const second = await startAppControl({ runtime, root, version: "9.9.9", env: { PATH: "/usr/bin" }, say: (line) => said.push(line) });
  assert.equal(second, null);
  assert.match(said.at(-1), /Control socket: not started \(Botkins is already running on this data folder\.\)/);
  assert.equal((await client.call("status")).pid, process.pid);

  // A socket that cannot start (a path too long for the system) is one line, no change to the environment, and the runtime goes on.
  const long = join(dir, "x".repeat(100));
  const lines = [];
  const other = { PATH: "/usr/bin" };
  assert.equal(await startAppControl({ runtime, root: long, version: "9.9.9", env: other, say: (line) => lines.push(line) }), null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Control socket: not started\. The path .* is longer than 100 bytes, which is too long for this system\. A bot's shell has no `botkins` command until the app's data folder has a shorter path\.$/);
  assert.deepEqual([other.BOTKINS_SOCKET, reachable(other), existsSync(long)], [undefined, false, false]);
  assert.ok(Array.isArray(runtime.workspace.state.bots));

  await control.close();
  assert.equal(existsSync(socket), false);
});

test("the app's change log is a file that stays after a quit, in a folder that is this user's own", { skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-applog-"));
  const root = join(dir, "app");
  // A folder that is there already, open to others: the start closes it.
  mkdirSync(join(root, "run"), { recursive: true, mode: 0o755 });
  chmodSync(join(root, "run"), 0o755);
  const runtime = await createRuntime({ host: headlessHost({ version: "9.9.9" }), dataDir: join(root, "data"), trial: true, link: { port: await freePort(), announce: false } });
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const said = [];
  const control = await startAppControl({ runtime, root, version: "9.9.9", env: { PATH: "/usr/bin:/bin" }, say: (line) => said.push(line) });
  assert.ok(control, said.join("\n"));
  assert.equal(statSync(join(root, "run")).mode & 0o777, 0o700);
  // One change through the socket. A value is never in the log.
  await controlClient(control.socket, { timeout: 40_000 }).call("bots.add", { name: "Nova", instructions: "SECRET-INSTRUCTIONS" });
  await control.close();
  // The app quits and starts again: the line is still there, in the file that `botkins logs` reads when no service holds it.
  const file = join(root, "logs", "botkins.log");
  const text = readFileSync(file, "utf8");
  assert.match(text, / info +Changed from the command line: bots\.add Nova\n/);
  assert.equal(text.includes("SECRET"), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(file, terminalPaths({ root, env: {} }).logFile);
  const again = await startAppControl({ runtime, root, version: "9.9.9", env: { PATH: "/usr/bin:/bin" }, say: (line) => said.push(line) });
  assert.ok(again, said.join("\n"));
  await again.close();
  assert.match(readFileSync(file, "utf8"), /Changed from the command line: bots\.add Nova\n[\s\S]*Control socket: /);
});

test("the app's own launcher tells the command that it is the app's, so the advice for a missing service is to open the app", { skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-launch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match(launcherText({ node: "/usr/bin/node", cli: "/x/botkins.mjs", electron: false, app: true }), /\nBOTKINS_LAUNCHED_BY=app exec '\/usr\/bin\/node'/);
  assert.doesNotMatch(launcherText({ node: "/usr/bin/node", cli: "/x/botkins.mjs", electron: false }), /BOTKINS_LAUNCHED_BY/);
  // Nothing listens: the command that each host's launcher runs says what to do about it.
  const status = async (app) => {
    const root = join(dir, app ? "app" : "host");
    const env = { PATH: "/usr/bin:/bin" };
    const { command } = prepareReach({ dataDir: root, socket: join(root, "run", "botkins.sock"), env, app });
    const launched = await run(command, ["status"], { env: { PATH: env.PATH, BOTKINS_SOCKET: env.BOTKINS_SOCKET, BOTKINS_DATA_DIR: root } }).catch((error) => error);
    return String(launched.stdout);
  };
  assert.match(await status(true), /Botkins is not running \(data folder .*\)\.\nThe Botkins app is not running\. Open it\.\n$/);
  assert.doesNotMatch(await status(true), /botkins service start/);
  assert.match(await status(false), /Start it with `botkins service start`, or `botkins serve` in another terminal\.\n$/);
  // The doctor says it too.
  const client = { call: async () => Promise.reject(Object.assign(new Error("not running"), { code: "NOT_RUNNING" })) };
  const doctor = async (env) => (await examine({ paths: terminalPaths({ root: join(dir, "doc"), env: {} }), client, env, fetcher: async () => new Response(""), freePort: async () => true, node: "24.1.0" })).checks.find((entry) => entry.name === "Service").detail;
  assert.match(await doctor({ BOTKINS_LAUNCHED_BY: "app" }), /can't be asked\. The Botkins app is not running\. Open it\.$/);
  assert.match(await doctor({}), /Start it with `botkins service start` or `botkins serve`\.$/);
});
