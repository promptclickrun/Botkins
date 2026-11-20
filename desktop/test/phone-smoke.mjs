// The phone smoke: the real phone link inside the real app, in a folder of the test's own.
//   - Settings › Phone turns phone access on and shows a pairing code; a stand-in phone (this
//     process, with Node's own cipher) pairs with it over the local address, opens a session and
//     makes a sealed call. The app's side runs on Electron, whose cipher is another one: this is
//     the check that would have caught "That code isn't right" on every real phone.
//   - The page lists the three ways to pair and then shows the phone as paired.
//   - On macOS, the computer is announced on the local network (Bonjour) under its name while
//     phone access is on, and no longer after it is turned off (BOTKINS_NEARBY=1 lets a test be heard).
//   - Settings › General: "Run at startup" writes the entry that starts the app quietly (inside the
//     test's folder, never the system's), and the app stays on when its window is closed.
// No model turn, no relay, nothing outside this computer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { agree, b64u, box, cleanCode, hkdf, INFO, newKeyPair, open, random, seal, seqNonce, unb64u, unbox, CIPHER } from "../desktop/link/crypto.mjs";
import { signedInAs, skipWelcome } from "./welcome-helper.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-phone-"));
seedApp(dir);
const env = { ...process.env, BOTKINS_DATA_DIR: dir, COMMANDER_DATA_DIR: dir, BOTKINS_PROVIDERS: "copilot", COMMANDER_PROVIDERS: "copilot", BOTKINS_NEARBY: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const binary = process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY;
const errors = [];
let app;
const post = (base, route, body, headers = {}) => fetch(base + route, { method: "POST", headers: { "content-type": typeof body === "string" ? "application/json" : "application/octet-stream", ...headers }, body });
/** What macOS's own Bonjour browser sees of Botkins computers, for a moment. */
const browse = (ms = 3000) =>
  new Promise((resolve) => {
    const child = spawn("/usr/bin/dns-sd", ["-B", "_botkins._tcp", "local."]);
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    setTimeout(() => (child.kill(), resolve(text)), ms);
  });

try {
  app = await _electron.launch({ args: binary ? [] : ["."], executablePath: binary, env });
  let page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await signedInAs(app);
  await page.reload();
  page = await skipWelcome(page);
  assert.equal(CIPHER, "node", "this side of the test seals with Node's own cipher");
  assert.equal(await app.evaluate(() => !!process.versions.electron), true);

  // ---- Settings › Phone: on, then a code.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tablist", { name: "Settings" }).getByRole("tab", { name: "Phone", exact: true }).click();
  await settings.getByRole("switch", { name: "Let a phone connect" }).click();
  await settings.getByRole("button", { name: "Pair a phone", exact: true }).click();
  const status = await page.evaluate(() => window.botkins.phoneLink());
  assert.ok(status.listening && status.pairing, "phone access is on and a code is open");
  assert.equal(status.relay.enabled, false, "away from home stays off until the person turns it on");
  const ways = await settings.getByRole("list", { name: "Ways to pair" }).getByRole("listitem").allTextContents();
  assert.equal(ways.length, 3);
  assert.match(ways[0], /camera/);
  assert.ok(ways[1].includes(status.name), "the computer's name is on the page: " + ways[1]);
  assert.ok(ways[2].includes(":" + status.port), "and its address with the port: " + ways[2]);
  assert.ok(!/\.ts\.net|\.local$/.test(status.name), "the computer goes by its own name, not a network's: " + status.name);

  // ---- A stand-in phone pairs with the code on the page.
  const base = "http://127.0.0.1:" + status.port + "/botkins/v1/";
  const hello = await (await fetch(base + "hello")).json();
  assert.equal(hello.pairing, true);
  assert.equal(hello.app, "botkins");
  const mine = newKeyPair();
  const pairKey = (code) => hkdf(agree(mine, unb64u(hello.publicKey)), Buffer.from(cleanCode(code), "utf8"), INFO.pair);
  const tryPair = (code) => post(base, "pair", JSON.stringify({ publicKey: b64u(mine.publicKey), box: box(pairKey(code), { name: "Sam's iPhone", platform: "ios" }, "pair:" + hello.serverId) }));
  const wrong = await tryPair("WRONGCODE234");
  assert.deepEqual([wrong.status, (await wrong.json()).error], [403, "pair_failed"], "a wrong code is refused as a wrong code");
  const paired = await tryPair(status.pairing.code);
  assert.equal(paired.status, 200, "the code on the page pairs: " + paired.status);
  const made = unbox(pairKey(status.pairing.code), (await paired.json()).box, "paired:" + hello.serverId);
  assert.equal(made.serverId, hello.serverId);
  assert.ok(made.hosts.some((host) => host.endsWith(":" + status.port)));

  // ---- A session, and one sealed call each way.
  const deviceKey = hkdf(agree(mine, unb64u(hello.publicKey)), Buffer.from(made.device, "utf8"), INFO.device);
  const eph = newKeyPair();
  const nonce = random(16);
  const opened = await post(base, "session", JSON.stringify({ device: made.device, eph: b64u(eph.publicKey), box: box(deviceKey, { eph: b64u(eph.publicKey), nonce: b64u(nonce) }, "session:" + hello.serverId) }));
  assert.equal(opened.status, 200, "a session opens: " + opened.status);
  const session = unbox(deviceKey, (await opened.json()).box, "session-ok:" + hello.serverId);
  const salt = Buffer.concat([nonce, unb64u(session.nonce)]);
  const master = hkdf(Buffer.concat([agree(eph, unb64u(session.eph)), deviceKey]), salt, "botkins/session/v1");
  const [toHost, toPhone] = [hkdf(master, salt, INFO.toHost), hkdf(master, salt, INFO.toPhone)];
  const seq = Buffer.alloc(8);
  seq.writeBigUInt64BE(1n);
  const call = await post(base, "rpc", Buffer.concat([seq, seal(toHost, seqNonce(1), Buffer.from(JSON.stringify({ m: "appInfo", a: [] }), "utf8"), "rpc:" + session.session)]), { "x-botkins-session": session.session });
  assert.equal(call.status, 200, "a sealed call is answered: " + call.status);
  const answer = JSON.parse(open(toPhone, seqNonce(1), Buffer.from(await call.arrayBuffer()), "ok:" + session.session).toString("utf8"));
  assert.ok(answer.r && !answer.e, "the call's answer opens: " + JSON.stringify(answer).slice(0, 200));
  console.log("A stand-in phone paired with the code on the page, opened a session and made a sealed call (Node's cipher on one side, Electron's on the other).");

  // ---- The page shows the phone.
  await expect(settings.getByText("Sam's iPhone", { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Pair a phone", exact: true })).toBeVisible();
  console.log("The page lists three ways to pair and shows the paired phone.");

  // ---- The computer is announced on the local network while phone access is on.
  if (process.platform === "darwin") {
    const label = status.name.replace(/\./g, " ");
    await expect.poll(async () => (await browse()).includes(label), { timeout: 20000 }).toBe(true);
    await settings.getByRole("switch", { name: "Let a phone connect" }).click();
    await expect.poll(async () => (await page.evaluate(() => window.botkins.phoneLink())).listening).toBe(false);
    await expect.poll(async () => /\bAdd\b.*_botkins\._tcp\.\s+\S/.test((await browse(2500)).split("\n").filter((line) => line.includes(label)).at(-1) ?? "Rmv"), { timeout: 20000 }).toBe(false);
    console.log("While phone access is on the computer is announced over Bonjour as " + JSON.stringify(label) + ", and not after it is turned off.");
  }

  // ---- Settings › General: Run at startup, in the test's own folder; and staying on.
  await settings.getByRole("tablist", { name: "Settings" }).getByRole("tab", { name: "General", exact: true }).click();
  const harness = settings.getByRole("radiogroup", { name: "Harness" });
  assert.deepEqual(await harness.getByRole("radio").allTextContents(), ["Copilot SDK", "Provider default"]);
  assert.equal(await harness.getByRole("radio", { name: "Copilot SDK" }).getAttribute("aria-checked"), "true", "one harness is the usual choice");
  const keep = settings.getByRole("switch", { name: "Keep running when the window is closed" });
  const startup = settings.getByRole("switch", { name: "Run at startup" });
  await expect(keep).toBeChecked();
  await expect(startup).not.toBeChecked();
  await startup.click();
  await expect(startup).toBeChecked();
  const entry = process.platform === "darwin" ? join(dir, "startup", "Library", "LaunchAgents", "app.botkins.desktop.startup.plist") : process.platform === "win32" ? join(dir, "startup", "startup.json") : join(dir, "startup", ".config", "autostart", "botkins.desktop");
  await expect.poll(() => existsSync(entry)).toBe(true);
  const written = readFileSync(entry, "utf8");
  assert.ok(written.includes("--hidden"), "the entry starts the app without a window");
  assert.ok(written.includes(await app.evaluate(() => process.execPath)), "and names this program");
  await startup.click();
  await expect.poll(() => existsSync(entry)).toBe(false);
  await expect.poll(async () => (await page.evaluate(() => window.botkins.snapshot())).settings.background).toEqual({ keepRunning: true, runAtStartup: false });
  console.log("Run at startup writes an entry that starts the app quietly, and removes it again.");

  // Closing the window leaves the app running, with its icon; opening it again brings the window back.
  await settings.getByRole("button", { name: "Close dialog" }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(0);
  assert.equal(await app.evaluate(({ app }) => app.isReady()), true, "the app is still running");
  await app.evaluate(({ app }) => app.emit("activate"));
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(1);
  console.log("Closing the window leaves Botkins running; opening it again brings the window back.");

  assert.deepEqual(errors, [], "no page errors");
  console.log("phone smoke: ok");
} finally {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
