import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./starter.mjs";
import { CUA_DRIVER_ASSETS, CUA_DRIVER_TAG, CUA_DRIVER_VERSION, resolveBundledCuaDriver } from "../desktop/cua-driver-bundle.mjs";
import { Screen } from "../desktop/link/screen.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-cua-driver.mjs", import.meta.url));
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

function makeWorkspace(t, { computerUse = false, approval = "ask", screenHost } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-cua-"));
  const logFile = join(dir, "cua-calls.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const client = async () => ({
    createSession: async () => ({ setTools: async () => {}, on: () => () => {}, disconnect: async () => {}, send: async () => "m1" }),
    resumeSession: async () => ({ setTools: async () => {}, on: () => () => {}, disconnect: async () => {}, send: async () => "m1" }),
    deleteSession: async () => {},
  });

  const ws = new Workspace(dir, client, () => {}, {
    computerUse: {
      command: process.execPath,
      args: [FIXTURE],
      env: { FAKE_CUA_LOG: logFile },
      onActivity: (activity, frame) => screenHost?.noteBotActivity(activity, frame),
    },
  });
  t.after(() => ws.computerUse.close());

  ws.setPreferences({ computerUse, approval });
  const chatId = ws.createChat("pip");
  const chat = ws.chat(chatId);
  const bot = ws.bot("pip");
  const run = { id: "run-1", chatId, botId: bot.id };
  const task = { stopped: false, run };
  ws.active.set(chatId, task);
  t.after(() => ws.active.delete(chatId));

  const readLog = () => {
    try {
      return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { ws, chat, bot, run, task, readLog };
}

test("cua-driver manifest pins v0.63.2 with SHA-256 checksums for all targets and honors env override", () => {
  assert.equal(CUA_DRIVER_VERSION, "0.63.2");
  assert.equal(CUA_DRIVER_TAG, "cua-driver-rs-v0.63.2");
  for (const key of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"]) {
    const asset = CUA_DRIVER_ASSETS[key];
    assert.ok(asset, `missing asset for ${key}`);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, `invalid sha256 for ${key}`);
    assert.ok(asset.url.includes(CUA_DRIVER_TAG));
  }
  const resolved = resolveBundledCuaDriver({ env: { BOTKINS_CUA_DRIVER_BIN: FIXTURE } });
  assert.ok(resolved);
  assert.equal(resolved.source, "env");
  assert.equal(resolved.path, FIXTURE);
});

test("computerUse defaults to false and tools are exposed only in owner chats when enabled", (t) => {
  const { ws, chat, bot, run, task } = makeWorkspace(t, { computerUse: false });
  assert.equal(ws.state.settings.computerUse, false);
  const offTools = ws.sessionTools(bot, chat, run, task).map((tool) => tool.name);
  for (const name of ["computer_apps", "computer_observe", "computer_act", "computer_desktop"]) {
    assert.ok(!offTools.includes(name), `${name} must not be exposed when computerUse is off`);
  }

  ws.setPreferences({ computerUse: true });
  const onTools = ws.sessionTools(bot, chat, run, task).map((tool) => tool.name);
  for (const name of ["computer_apps", "computer_observe", "computer_act", "computer_desktop"]) {
    assert.ok(onTools.includes(name), `${name} must be exposed in owner chat when computerUse is on`);
  }

  // Non-owner / member / group / helper chats never receive local computer_* tools.
  const memberChat = { ...chat, createdBy: "member-1" };
  const memberTools = ws.sessionTools(bot, memberChat, run, task).map((tool) => tool.name);
  assert.ok(!memberTools.includes("computer_act"));

  const helperChat = { ...chat, helper: true };
  const helperTools = ws.sessionTools(bot, helperChat, run, task).map((tool) => tool.name);
  assert.ok(!helperTools.includes("computer_act"));
});

test("curated tools observe without screenshots by default, default actions to background, gate approvals, pass effect/escalation verbatim, and emit Screen frames", async (t) => {
  const screenHost = new Screen({
    mode: () => "view",
    platform: "linux",
    dirs: [],
    adapter: () => ({
      displays: async () => [{ id: "main", label: "Main", width: 1440, height: 900, primary: true }],
      capture: async () => ({ jpeg: TINY_JPEG, width: 1, height: 1 }),
      input: async () => {},
    }),
  });
  const { ws, chat, bot, run, task, readLog } = makeWorkspace(t, { computerUse: true, approval: "ask", screenHost });
  const tools = new Map(ws.sessionTools(bot, chat, run, task).map((tool) => [tool.name, tool]));

  // 1. computer_apps lists apps via fake stdio driver.
  const appsRes = JSON.parse(await tools.get("computer_apps").handler({}));
  assert.equal(appsRes.apps.length, 2);
  assert.equal(appsRes.apps[0].pid, 4242);

  // 2. computer_observe omits screenshot by default; returns element tokens.
  const obs = JSON.parse(await tools.get("computer_observe").handler({ pid: 4242 }));
  assert.equal(obs.window_id, "win-1");
  assert.equal(obs.screenshot, undefined);
  assert.ok(obs.elements.some((el) => el.element_token === "tok-submit"));

  // 3. computer_observe with include_screenshot: true returns the JPEG.
  const obsShot = JSON.parse(await tools.get("computer_observe").handler({ pid: 4242, include_screenshot: true }));
  assert.equal(obsShot.screenshot.mimeType, "image/jpeg");
  assert.ok(obsShot.screenshot.data.length > 10);

  // 4. computer_act requires Botkins approval when approval="ask"; denying blocks execution.
  const deniedPromise = tools.get("computer_act").handler({ action: "click", pid: 4242, element_token: "tok-submit" });
  const pendingDeny = ws.interactions.snapshot().find((r) => r.kind === "permission");
  assert.ok(pendingDeny, "computer_act must prompt for approval");
  ws.interactions.respond(pendingDeny.id, { action: "deny" });
  await assert.rejects(() => deniedPromise, /declined/i);
  assert.equal(readLog().filter((c) => c.name === "click").length, 0);

  // 5. Approving executes with delivery_mode: "background" by default, passes effect/escalation verbatim, and emits to ScreenHost!
  const okPromise = tools.get("computer_act").handler({ action: "click", pid: 4242, element_token: "tok-needs-escalation" });
  const pendingAllow = ws.interactions.snapshot().find((r) => r.kind === "permission");
  assert.ok(pendingAllow);
  ws.interactions.respond(pendingAllow.id, { action: "approve" });
  const okRes = JSON.parse(await okPromise);
  assert.equal(okRes.delivery_mode, "background");
  assert.deepEqual(okRes.effect, { delivered: true, method: "ax_action", pointer_moved: false, focus_changed: false });
  assert.equal(okRes.escalation.suggested, true);
  assert.match(okRes.escalation.reason, /foreground/);

  const clickLog = readLog().find((c) => c.name === "click");
  assert.equal(clickLog.args.delivery_mode, "background");

  // Screen stream received the fresh CUA background frame + live activity marker!
  const frame = await screenHost.frame("phone-1", { display: "main", wait: false });
  assert.ok(frame.jpeg && frame.jpeg.length > 10);
  assert.equal(frame.activity.action, "click");
  assert.equal(frame.activity.botName, bot.name);
  assert.equal(frame.activity.deliveryMode, "background");
  assert.equal(frame.activity.pointerUntouched, true);
});

test("computer_act refuses type_text into secure/password fields before approval, and vault native_fill sets the secret without exposing it to the bot", async (t) => {
  const { ws, chat, bot, run, task, readLog } = makeWorkspace(t, { computerUse: true, approval: "ask" });
  const tools = new Map(ws.sessionTools(bot, chat, run, task).map((tool) => [tool.name, tool]));

  // Observe first so ComputerUse records tok-password as AXSecureTextField / secure: true.
  await tools.get("computer_observe").handler({ pid: 4242 });

  // Attempt to type_text into tok-password: refused immediately WITHOUT opening an approval prompt!
  await assert.rejects(
    () => tools.get("computer_act").handler({ action: "type_text", pid: 4242, element_token: "tok-password", text: "hunter2" }),
    /Refused type_text on secure\/password field.*request_secure_input.*native_fill/i,
  );
  assert.equal(ws.interactions.snapshot().length, 0, "secure-field refusal must happen before approval");
  assert.equal(readLog().filter((c) => c.name === "type_text").length, 0);

  // Now use Botkins secure-input vault path with operation: "native_fill" (no url required).
  const reqPromise = tools.get("request_secure_input").handler({
    title: "Sign in to Safari",
    reason: "Fill the native password field via CUA vault path",
    operation: "native_fill",
    target: { pid: 4242, window_id: "win-1", element_token: "tok-password", app: "Safari" },
    fields: [{ key: "password", label: "Password", kind: "password" }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  const pending = ws.interactions.snapshot().find((r) => r.kind === "secure");
  assert.ok(pending, "request_secure_input created a secure request");
  const secretValue = "s3cr3t-vault-pass-9876";
  ws.interactions.respond(pending.id, { action: "accept", content: { password: secretValue } });

  const requested = JSON.parse(await reqPromise);
  assert.ok(requested.handles.password);
  assert.ok(!JSON.stringify(requested).includes(secretValue), "bot must never see secret in request_secure_input response");

  const usedRaw = await tools.get("use_secure_input").handler({ handles: requested.handles });
  const used = JSON.parse(usedRaw);
  assert.equal(used.applied, true);
  assert.ok(!usedRaw.includes(secretValue), "bot must never see secret in use_secure_input response");

  // Fake cua-driver received set_value with the actual secret value!
  const setCall = readLog().find((c) => c.name === "set_value");
  assert.ok(setCall, "driver received set_value");
  assert.equal(setCall.args.pid, 4242);
  assert.equal(setCall.args.element_token, "tok-password");
  assert.equal(setCall.args.value, secretValue);
  assert.equal(setCall.args.delivery_mode, "background");
});

test("desktop and mobile link-host/screen.mjs both expose CUA bot activity markers", async () => {
  const { Screen: MobileScreen } = await import("../../mobile/link-host/screen.mjs");
  const m = new MobileScreen({ mode: () => "view", platform: "linux", dirs: [] });
  const marked = m.noteBotActivity(
    { botName: "Glory", action: "click", app: "Safari", deliveryMode: "background", pointerUntouched: true },
    { jpeg: TINY_JPEG, width: 1, height: 1 },
  );
  assert.equal(marked.action, "click");
  assert.equal(m.recentActivity().pointerUntouched, true);
  const frame = await m.frame("phone-1", { wait: false });
  assert.ok(frame.jpeg);
  assert.equal(frame.activity.botName, "Glory");
});
