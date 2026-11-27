import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./starter.mjs";
import { CUA_DRIVER_ASSETS, CUA_DRIVER_TAG, CUA_DRIVER_VERSION, resolveBundledCuaDriver } from "../desktop/cua-driver-bundle.mjs";
import { CuaDriverClient } from "../desktop/computer-use.mjs";
import { Screen } from "../desktop/link/screen.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-cua-driver.mjs", import.meta.url));
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

function makeWorkspace(t, { computerUse = false, approval = "ask", screenHost, env = {}, timeoutMs, onActivity } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-cua-"));
  const logFile = join(dir, "cua-calls.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const client = async () => ({
    createSession: async () => ({ setTools: async () => {}, on: () => () => {}, disconnect: async () => {}, send: async () => "m1" }),
    resumeSession: async () => ({ setTools: async () => {}, on: () => () => {}, disconnect: async () => {}, send: async () => "m1" }),
    deleteSession: async () => {},
  });

  const driverEnv = { FAKE_CUA_LOG: logFile, ...env };
  const cuaClient = timeoutMs
    ? new CuaDriverClient({ command: process.execPath, args: [FIXTURE], env: driverEnv, timeoutMs })
    : undefined;

  const ws = new Workspace(dir, client, () => {}, {
    computerUse: {
      ...(cuaClient ? { client: cuaClient } : { command: process.execPath, args: [FIXTURE], env: driverEnv }),
      onActivity: (activity, frame) => {
        onActivity?.(activity, frame);
        screenHost?.noteBotActivity(activity, frame);
      },
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
  return { ws, chat, bot, run, task, readLog, dir };
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
  await new Promise((r) => setImmediate(r));
  const pendingDeny = ws.interactions.snapshot().find((r) => r.kind === "permission");
  assert.ok(pendingDeny, "computer_act must prompt for approval");
  ws.interactions.respond(pendingDeny.id, { action: "deny" });
  await assert.rejects(() => deniedPromise, /declined/i);
  assert.equal(readLog().filter((c) => c.name === "click").length, 0);

  // 5. Approving executes with delivery_mode: "background" by default, passes effect/escalation verbatim, and emits to ScreenHost!
  const okPromise = tools.get("computer_act").handler({ action: "click", pid: 4242, element_token: "tok-needs-escalation" });
  await new Promise((r) => setImmediate(r));
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

test("native_fill refuses non-secure or unobserved tokens, ignores model-supplied app/window_title, re-verifies before set_value, and omits Screen frame/secret", async (t) => {
  const activities = [];
  const mutateFile = join(tmpdir(), `botkins-cua-mutate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  t.after(() => rmSync(mutateFile, { force: true }));

  const { ws, chat, bot, run, task, readLog } = makeWorkspace(t, {
    computerUse: true,
    approval: "ask",
    env: { FAKE_CUA_MUTATE_SECURE_FILE: mutateFile },
    onActivity: (activity, frame) => activities.push({ activity, frame }),
  });
  const tools = new Map(ws.sessionTools(bot, chat, run, task).map((tool) => [tool.name, tool]));

  // Unobserved token is refused before opening any secure approval card.
  await assert.rejects(
    () =>
      tools.get("request_secure_input").handler({
        title: "Unobserved fill",
        operation: "native_fill",
        target: { pid: 4242, element_token: "tok-password", app: "SpoofedApp", window_title: "SpoofedWindow" },
        fields: [{ key: "password", label: "Password", kind: "password" }],
      }),
    /not a verified secure\/password field/i,
  );
  assert.equal(ws.interactions.snapshot().length, 0);

  // Observe window: tok-search is non-secure, tok-password is secure.
  await tools.get("computer_observe").handler({ pid: 4242 });

  // Non-secure token (tok-search) MUST be refused by request_secure_input.
  await assert.rejects(
    () =>
      tools.get("request_secure_input").handler({
        title: "Exfil attempt",
        operation: "native_fill",
        target: { pid: 4242, element_token: "tok-search", app: "BankApp", window_title: "Login" },
        fields: [{ key: "password", label: "Password", kind: "password" }],
      }),
    /not a verified secure\/password field/i,
  );
  assert.equal(ws.interactions.snapshot().length, 0);

  // Valid secure token with spoofed model app/window_title: approval detail MUST show cached Safari info, never spoofed values.
  const reqPromise = tools.get("request_secure_input").handler({
    title: "Fill password",
    operation: "native_fill",
    target: { pid: 4242, element_token: "tok-password", app: "SpoofedBank", window_title: "SpoofedTitle" },
    fields: [{ key: "password", label: "Password", kind: "password" }],
  });
  await new Promise((r) => setImmediate(r));
  const pending = ws.interactions.snapshot().find((r) => r.kind === "secure");
  assert.ok(pending);
  assert.match(pending.detail, /Safari/);
  assert.match(pending.detail, /Safari — Sign In/);
  assert.ok(!pending.detail.includes("SpoofedBank"), "approval detail must ignore model-supplied app");
  assert.ok(!pending.detail.includes("SpoofedTitle"), "approval detail must ignore model-supplied window_title");
  const secretValue = "ultra-secret-vault-value-42";
  ws.interactions.respond(pending.id, { action: "accept", content: { password: secretValue } });
  const { handles } = JSON.parse(await reqPromise);

  // Use secure input: Screen stream secure_fill must NOT contain a frame or the secret value.
  activities.length = 0;
  const used = JSON.parse(await tools.get("use_secure_input").handler({ handles }));
  assert.equal(used.applied, true);
  const fillEvent = activities.find((e) => e.activity.action === "secure_fill");
  assert.ok(fillEvent, "secure_fill emitted activity marker");
  assert.equal(fillEvent.frame, null, "secure_fill must not attach a screenshot frame to the Screen stream");
  assert.ok(!JSON.stringify(fillEvent).includes(secretValue), "secure_fill marker must never contain the secret");

  // TOCTOU: if tok-password stops being secure after approval, secureSetValue fails closed before calling set_value.
  const req2 = tools.get("request_secure_input").handler({
    title: "Fill password 2",
    operation: "native_fill",
    target: { pid: 4242, element_token: "tok-password" },
    fields: [{ key: "password", label: "Password", kind: "password" }],
  });
  await new Promise((r) => setImmediate(r));
  const pending2 = ws.interactions.snapshot().find((r) => r.kind === "secure");
  ws.interactions.respond(pending2.id, { action: "accept", content: { password: "second-secret" } });
  const { handles: handles2 } = JSON.parse(await req2);

  // Mutate the window so tok-password becomes a plain text field before use_secure_input executes.
  writeFileSync(mutateFile, "1");
  const setCallsBefore = readLog().filter((c) => c.name === "set_value").length;
  await assert.rejects(
    () => tools.get("use_secure_input").handler({ handles: handles2 }),
    /no longer a secure\/password field/i,
  );
  assert.equal(readLog().filter((c) => c.name === "set_value").length, setCallsBefore, "must not call set_value after field stops being secure");
});

test("secure-field refusal fails closed: click secure then type, filtered observe keeps flag, unknown token refused, UIA is_password/isPassword refused", async (t) => {
  const { ws, chat, bot, run, task, readLog } = makeWorkspace(t, {
    computerUse: true,
    approval: "all",
  });
  const tools = new Map(ws.sessionTools(bot, chat, run, task).map((tool) => [tool.name, tool]));

  // Observe first.
  await tools.get("computer_observe").handler({ pid: 4242 });

  // 1. UIA is_password and isPassword nodes are refused before approval.
  await assert.rejects(
    () => tools.get("computer_act").handler({ action: "type_text", pid: 4242, element_token: "tok-uia-pass", text: "1234" }),
    /Refused type_text on secure\/password field/i,
  );
  await assert.rejects(
    () => tools.get("computer_act").handler({ action: "set_value", pid: 4242, element_token: "tok-uia-pass2", text: "5678" }),
    /Refused set_value on secure\/password field/i,
  );

  // 2. Unknown / evicted token is refused fail-closed.
  await assert.rejects(
    () => tools.get("computer_act").handler({ action: "type_text", pid: 4242, element_token: "tok-unknown-999", text: "hello" }),
    /could not be resolved/i,
  );

  // 3. Click secure password token, then query-filtered observe (which omits tok-password), then type_text with no token: MUST be refused!
  await tools.get("computer_act").handler({ action: "click", pid: 4242, element_token: "tok-password" });
  const filteredObs = JSON.parse(await tools.get("computer_observe").handler({ pid: 4242, query: "Search" }));
  assert.equal(filteredObs.elements.length, 1);
  assert.equal(filteredObs.elements[0].element_token, "tok-search");

  await assert.rejects(
    () => tools.get("computer_act").handler({ action: "type_text", pid: 4242, text: "hunter2" }),
    /Refused type_text because the focused field \(tok-password\) is a secure\/password field/i,
  );
  assert.equal(readLog().filter((c) => c.name === "type_text").length, 0);

  // 4. Click a non-secure token so focus moves to tok-search, then token-less type_text succeeds.
  await tools.get("computer_act").handler({ action: "click", pid: 4242, element_token: "tok-search" });
  const typed = JSON.parse(await tools.get("computer_act").handler({ action: "type_text", pid: 4242, text: "cats" }));
  assert.equal(typed.ok, true);
});

test("query-filtered observe preserves #focusedSecure even when driver does not report focus flags", async (t) => {
  const { ws, chat, bot, run, task, readLog } = makeWorkspace(t, {
    computerUse: true,
    approval: "all",
    env: { FAKE_CUA_NO_FOCUS_REPORT: "1" },
  });
  const tools = new Map(ws.sessionTools(bot, chat, run, task).map((tool) => [tool.name, tool]));

  await tools.get("computer_observe").handler({ pid: 4242, window_id: "win-1" });
  // Click secure field with window_id: "win-1".
  await tools.get("computer_act").handler({ action: "click", pid: 4242, window_id: "win-1", element_token: "tok-password" });
  // Query-filtered observe (no window_id) must NOT clear the focused-secure flag!
  await tools.get("computer_observe").handler({ pid: 4242, query: "Search" });
  // type_text with omitted window_id (previously mismatched pid:win-1 vs pid:) MUST still be refused!
  await assert.rejects(
    () => tools.get("computer_act").handler({ action: "type_text", pid: 4242, text: "leak" }),
    /Refused type_text because the focused field \(tok-password\) is a secure\/password field/i,
  );
  assert.equal(readLog().filter((c) => c.name === "type_text").length, 0);
});

test("approval preview shows typed text with visible control characters and omits remember grant for type_text, set_value, and hotkey", async (t) => {
  const { ws, chat, bot, run, task } = makeWorkspace(t, { computerUse: true, approval: "ask" });
  const tools = new Map(ws.sessionTools(bot, chat, run, task).map((tool) => [tool.name, tool]));

  await tools.get("computer_observe").handler({ pid: 4242 });
  async function denyWithPrompt(args) {
    let prompt;
    const deny = (request) => {
      prompt = request;
      ws.interactions.respond(request.id, { action: "deny" });
    };
    ws.events.once("request", deny);
    try {
      await assert.rejects(() => tools.get("computer_act").handler(args), /declined/i);
    } finally {
      ws.events.off("request", deny);
    }
    assert.equal(prompt?.kind, "permission", `${args.action} opens an approval prompt`);
    return prompt;
  }

  // type_text shows visible control chars (\n, \t, \x03) and omits remember grant.
  const longText = `hello\nworld\t\x03 ${"a".repeat(250)}`;
  const typePending = await denyWithPrompt({
    action: "type_text",
    pid: 4242,
    element_token: "tok-search",
    text: longText,
  });
  assert.match(typePending.preview, /hello\\nworld\\t\\x03/);
  assert.ok(typePending.preview.includes("…"), "long typed text is truncated in preview");
  assert.ok(!typePending.remember, "type_text must NOT offer 'Allow computer actions in this chat' remember grant");

  // set_value also shows typed text and omits remember grant.
  const setPending = await denyWithPrompt({
    action: "set_value",
    pid: 4242,
    element_token: "tok-search",
    text: "line1\r\nline2",
  });
  assert.match(setPending.preview, /line1\\r\\nline2/);
  assert.ok(!setPending.remember, "set_value must NOT offer remember grant");

  // hotkey omits remember grant.
  const hotkeyPending = await denyWithPrompt({
    action: "hotkey",
    pid: 4242,
    keys: ["cmd", "v"],
  });
  assert.ok(!hotkeyPending.remember, "hotkey must NOT offer remember grant");

  // click still offers remember grant.
  const clickPending = await denyWithPrompt({
    action: "click",
    pid: 4242,
    element_token: "tok-submit",
  });
  assert.ok(clickPending.remember, "click keeps remember grant");
});

test("request timeout stops hung driver and respawns a fresh process on the next call", async (t) => {
  const hangOnceFile = join(tmpdir(), `botkins-cua-hang-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  t.after(() => rmSync(hangOnceFile, { force: true }));

  const { ws, chat, bot, run, task } = makeWorkspace(t, {
    computerUse: true,
    approval: "all",
    timeoutMs: 150,
    env: { FAKE_CUA_HANG_ONCE_FILE: hangOnceFile },
  });
  const tools = new Map(ws.sessionTools(bot, chat, run, task).map((tool) => [tool.name, tool]));

  // First call hangs and times out -> stops the hung driver.
  await assert.rejects(() => tools.get("computer_apps").handler({}), /timed out/i);
  assert.equal(ws.computerUse.client.isRunning(), false, "hung driver must be stopped on timeout");
  const hungPid = Number(readFileSync(hangOnceFile, "utf8").trim());
  assert.ok(hungPid > 0);

  // Next call respawns a brand-new driver process and succeeds!
  const res = JSON.parse(await tools.get("computer_apps").handler({}));
  assert.equal(res.apps.length, 2);
  assert.notEqual(res.driver_pid, hungPid, "fresh driver process must be spawned after timeout");
});

test("stopping the turn aborts an in-flight computer_apps call via the turn signal", async (t) => {
  const { ws, chat, bot, run, task } = makeWorkspace(t, {
    computerUse: true,
    approval: "all",
    timeoutMs: 10_000,
    env: { FAKE_CUA_HANG_ALWAYS: "1" },
  });
  const tools = new Map(ws.sessionTools(bot, chat, run, task).map((tool) => [tool.name, tool]));

  const pending = tools.get("computer_apps").handler({});
  setTimeout(() => {
    task.stopped = true;
  }, 50);
  await assert.rejects(() => pending, /aborted/i);
});

test("JSON-RPC client replies -32601 to server-initiated requests with colliding IDs without resolving pending calls", async (t) => {
  const { ws, chat, bot, run, task, readLog } = makeWorkspace(t, {
    computerUse: true,
    approval: "all",
    env: { FAKE_CUA_COLLIDING_SERVER_REQ: "1" },
  });
  const tools = new Map(ws.sessionTools(bot, chat, run, task).map((tool) => [tool.name, tool]));

  const res = JSON.parse(await tools.get("computer_apps").handler({}));
  assert.equal(res.apps.length, 2);
  assert.equal(res.apps[0].pid, 4242);

  // Give the fake driver a moment to log the client's -32601 reply.
  await new Promise((r) => setTimeout(r, 30));
  const replies = readLog().filter((e) => e.client_reply);
  assert.ok(replies.length >= 1, "client replied to server-initiated request");
  assert.equal(replies[0].client_reply.error?.code, -32601);
});
