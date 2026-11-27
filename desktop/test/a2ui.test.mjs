// A2UI v1.0 host tests:
// - schema validation (good & bad payloads, v1.0 theme rejection, size caps, unknown components)
// - data binding, JSON Pointer updates, Basic Catalog functions & @checks
// - bot tool (`render_ui`) creation + live updateDataModel / updateComponents + ownership
// - workflow Output step (`a2ui`) templating + validation
// - action routing: (a) owning bot turn, (b) built-in dispatch/dismiss + owner ACL, (c) workflow resume/trigger
// - idempotency per (surfaceId, actionId)
// - desktop/link/a2ui.mjs <-> mobile/link-host/a2ui.mjs byte-for-byte parity
// - Desktop React SSR render test (Basic Catalog components, rich-cards-off fallback, unsafe URL blocking)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

import {
  A2UI_BASIC_CATALOG_ID,
  A2UI_VERSION,
  applyA2uiMessages,
  evaluateChecks,
  isSafeA2uiUrl,
  resolveDynamicString,
  summarizeA2uiSurface,
  validateA2uiActionPayload,
  validateA2uiMessage,
  validateA2uiMessages,
} from "../desktop/link/a2ui.mjs";
import { a2uiTools, applyBotA2uiMessages, attachRunA2uiSurfaces, handleChatA2uiAction } from "../desktop/a2ui-host.mjs";
import { Workflows } from "../desktop/workflows.mjs";
import { validateWorkflow } from "../desktop/workflow-fields.mjs";
import { remoteArgs } from "../desktop/link/methods.mjs";
import { authorize } from "../desktop/link/team.mjs";

// ── Parity between desktop/link and mobile/link-host ───────────────────────

test("desktop/desktop/link/a2ui.mjs and .d.mts match mobile/link-host byte-for-byte", () => {
  for (const file of ["a2ui.mjs", "a2ui.d.mts", "methods.mjs", "team.mjs"]) {
    const d = readFileSync(new URL("../desktop/link/" + file, import.meta.url), "utf8");
    const m = readFileSync(new URL("../../mobile/link-host/" + file, import.meta.url), "utf8");
    assert.equal(d, m, `${file} must match between desktop/desktop/link and mobile/link-host`);
  }
});

// ── Schema validation (good & bad payloads) ────────────────────────────────

test("validates single-message A2UI v1.0 createSurface with Basic Catalog components and dataModel", () => {
  const msg = {
    version: "1.0",
    createSurface: {
      surfaceId: "deploy-confirm",
      catalogId: A2UI_BASIC_CATALOG_ID,
      sendDataModel: true,
      components: [
        { id: "root", component: "Column", children: ["title", "env", "confirm_chk", "actions"] },
        { id: "title", component: "Text", text: { "@call": "formatString", args: { value: "Deploy ${/service}" } }, variant: "body" },
        {
          id: "env",
          component: "ChoicePicker",
          label: "Target environment",
          variant: "mutuallyExclusive",
          displayStyle: "chips",
          options: [
            { label: "Staging", value: "staging" },
            { label: "Production", value: "prod" },
          ],
          value: { "@path": "/env" },
        },
        { id: "confirm_chk", component: "CheckBox", label: "Run smoke tests", value: { "@path": "/smoke" } },
        { id: "actions", component: "Row", children: ["go_btn", "cancel_btn"] },
        {
          id: "go_btn",
          component: "Button",
          child: "go_lbl",
          variant: "primary",
          action: {
            event: {
              name: "deploy",
              userMessage: "Deploy now",
              context: { service: { "@path": "/service" }, env: { "@path": "/env" } },
            },
          },
        },
        { id: "go_lbl", component: "Text", text: "Deploy" },
        {
          id: "cancel_btn",
          component: "Button",
          child: "cancel_lbl",
          variant: "borderless",
          action: { event: { name: "dismiss" } },
        },
        { id: "cancel_lbl", component: "Text", text: "Dismiss" },
      ],
      dataModel: { service: "relay", env: ["staging"], smoke: true },
    },
  };

  const validated = validateA2uiMessages([msg]);
  assert.equal(validated.length, 1);
  const applied = applyA2uiMessages([], [msg], { botId: "bot-1" });
  assert.deepEqual(applied.createdIds, ["deploy-confirm"]);
  const surface = applied.surfaces.get("deploy-confirm");
  assert.equal(surface.version, A2UI_VERSION);
  assert.equal(resolveDynamicString(surface.components[1].text, surface.dataModel), "Deploy relay");
  const summary = summarizeA2uiSurface(surface);
  assert.ok(summary.lines.includes("Deploy relay"));
  assert.equal(summary.actions.length, 2);
  assert.equal(summary.actions[0].label, "Deploy");
});

test("rejects invalid A2UI payloads (wrong version, v0.9 theme, unknown component, missing root, cycles, prototype pollution)", () => {
  // Wrong version
  assert.throws(() => validateA2uiMessage({ version: "0.9", createSurface: { surfaceId: "s1" } }), /Unsupported A2UI version/);
  // v1.0 forbids createSurface.theme
  assert.throws(
    () =>
      validateA2uiMessage({
        version: "1.0",
        createSurface: {
          surfaceId: "s1",
          theme: { primaryColor: "#ff0000" },
          components: [{ id: "root", component: "Text", text: "hi" }],
        },
      }),
    /must not include "theme"/,
  );
  // Unknown component rejected by default
  assert.throws(
    () =>
      validateA2uiMessage({
        version: "1.0",
        createSurface: {
          surfaceId: "s1",
          components: [{ id: "root", component: "ScriptTag", code: "alert(1)" }],
        },
      }),
    /unsupported component "ScriptTag"/,
  );
  // Missing root
  assert.throws(
    () =>
      applyA2uiMessages([], [
        {
          version: "1.0",
          createSurface: {
            surfaceId: "s-no-root",
            components: [{ id: "not-root", component: "Text", text: "orphan" }],
          },
        },
      ]),
    /id "root"/,
  );
  // Missing referenced child
  assert.throws(
    () =>
      applyA2uiMessages([], [
        {
          version: "1.0",
          createSurface: {
            surfaceId: "s-missing-child",
            components: [{ id: "root", component: "Card", child: "does-not-exist" }],
          },
        },
      ]),
    /missing child "does-not-exist"/,
  );
  // Cycle detection
  assert.throws(
    () =>
      applyA2uiMessages([], [
        {
          version: "1.0",
          createSurface: {
            surfaceId: "s-cycle",
            components: [
              { id: "root", component: "Card", child: "c1" },
              { id: "c1", component: "Card", child: "root" },
            ],
          },
        },
      ]),
    /cycle/,
  );
  // Duplicate createSurface without deleteSurface
  const first = applyA2uiMessages([], [
    {
      version: "1.0",
      createSurface: {
        surfaceId: "dup",
        components: [{ id: "root", component: "Text", text: "first" }],
      },
    },
  ]);
  assert.throws(
    () =>
      applyA2uiMessages([...first.surfaces.values()], [
        {
          version: "1.0",
          createSurface: {
            surfaceId: "dup",
            components: [{ id: "root", component: "Text", text: "second" }],
          },
        },
      ]),
    /INTEGRITY_ERROR/,
  );
  // Prototype pollution rejected
  assert.throws(
    () =>
      validateA2uiMessage({
        version: "1.0",
        createSurface: {
          surfaceId: "s-proto",
          components: [{ id: "root", component: "Text", text: "hi" }],
          dataModel: JSON.parse('{"__proto__":{"polluted":true}}'),
        },
      }),
    /Forbidden property name/,
  );
  // Unsafe URL schemes rejected
  assert.equal(isSafeA2uiUrl("javascript:alert(1)"), false);
  assert.equal(isSafeA2uiUrl("file:///etc/passwd"), false);
  assert.equal(isSafeA2uiUrl("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isSafeA2uiUrl("https://botkins.app"), true);
});

test("evaluates Basic Catalog validation functions and @checks", () => {
  const emailComp = {
    id: "email",
    component: "TextField",
    label: "Email",
    value: { "@path": "/email" },
    "@checks": [
      { condition: { "@call": "required", args: { value: { "@path": "/email" } } }, message: "Required" },
      { condition: { "@call": "email", args: { value: { "@path": "/email" } } }, message: "Must be email" },
    ],
  };
  assert.deepEqual(evaluateChecks(emailComp, { email: "" }), ["Required", "Must be email"]);
  assert.deepEqual(evaluateChecks(emailComp, { email: "nope" }), ["Must be email"]);
  assert.deepEqual(evaluateChecks(emailComp, { email: "colt@example.com" }), []);
});

// ── Host bot tool + surface lifecycle + action routing + idempotency ───────

function makeFakeWorkspace() {
  const saved = { count: 0 };
  const submitted = [];
  const ws = {
    closing: false,
    active: new Map(),
    state: {
      bots: [
        { id: "bot-alfie", name: "Alfie" },
        { id: "bot-glory", name: "Glory" },
      ],
      chats: [
        {
          id: "chat-main",
          botId: "bot-alfie",
          main: true,
          title: "Alfie",
          messages: [],
          time: Date.now(),
        },
      ],
      runs: [],
      workflows: [],
      workflowRuns: [],
    },
    events: {
      emitted: [],
      emit(name, data) {
        this.emitted.push({ name, data });
      },
      on() {},
    },
    chat(id) {
      const c = this.state.chats.find((x) => x.id === id);
      if (!c) throw new Error("Chat not found: " + id);
      return c;
    },
    createChat(botId, title) {
      const id = "chat-" + (this.state.chats.length + 1);
      this.state.chats.push({ id, botId, title, messages: [], time: Date.now() });
      return id;
    },
    submit(chatId, prompt, opts) {
      submitted.push({ chatId, prompt, opts });
      return Promise.resolve();
    },
    save() {
      saved.count++;
    },
    memberAuthor(id) {
      return { memberId: id, name: "Member " + id };
    },
  };
  ws.workflows = new Workflows(ws, { githubAuth: { status: async () => ({ installed: false }) } });
  return { ws, saved, submitted };
}

test("render_ui creates, attaches to message, updates live by same bot, and blocks other bots", async () => {
  const { ws } = makeFakeWorkspace();
  const chat = ws.chat("chat-main");
  const bot = ws.state.bots[0];
  const run = { id: "run-1", chatId: chat.id, status: "Working" };
  const task = { stopped: false, run };
  ws.state.runs.push(run);
  ws.active.set(chat.id, task);

  const tools = a2uiTools(ws, bot, chat, run, task);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "render_ui");

  const resRaw = await tools[0].handler({
    messages: [
      {
        version: "1.0",
        createSurface: {
          surfaceId: "live-status",
          sendDataModel: true,
          components: [
            { id: "root", component: "Column", children: ["txt", "btn"] },
            { id: "txt", component: "Text", text: { "@path": "/status" } },
            { id: "btn", component: "Button", child: "btn_t", action: { event: { name: "refresh" } } },
            { id: "btn_t", component: "Text", text: "Refresh" },
          ],
          dataModel: { status: "Building..." },
        },
      },
    ],
  });
  const res = JSON.parse(resRaw);
  assert.deepEqual(res.created, ["live-status"]);
  assert.equal(run.a2uiSurfaces.length, 1);

  // Attach to committed assistant message when turn finishes
  attachRunA2uiSurfaces(chat, run, bot.id);
  assert.equal(run.a2uiSurfaces, undefined);
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0].a2uiSurfaces.length, 1);
  assert.equal(chat.messages[0].text, "Building...");

  // Same bot can updateDataModel in a later turn
  const run2 = { id: "run-2", chatId: chat.id, status: "Working" };
  applyBotA2uiMessages(ws, bot, chat, run2, [
    { version: "1.0", updateDataModel: { surfaceId: "live-status", path: "/status", value: "Passed!" } },
  ]);
  assert.equal(chat.messages[0].a2uiSurfaces[0].dataModel.status, "Passed!");

  // Different bot cannot overwrite another bot's surface
  assert.throws(
    () =>
      applyBotA2uiMessages(ws, ws.state.bots[1], chat, run2, [
        { version: "1.0", updateDataModel: { surfaceId: "live-status", path: "/status", value: "Hijacked" } },
      ]),
    /belongs to another bot/,
  );
});

test("action routing: bot turn + dataModel + idempotency per (surfaceId, actionId)", () => {
  const { ws, submitted } = makeFakeWorkspace();
  const chat = ws.chat("chat-main");
  const applied = applyA2uiMessages([], [
    {
      version: "1.0",
      createSurface: {
        surfaceId: "form-1",
        sendDataModel: true,
        components: [
          { id: "root", component: "Column", children: ["f", "b"] },
          { id: "f", component: "TextField", label: "Note", value: { "@path": "/note" } },
          { id: "b", component: "Button", child: "bt", action: { event: { name: "save_note", context: { note: { "@path": "/note" } } } } },
          { id: "bt", component: "Text", text: "Save" },
        ],
        dataModel: { note: "" },
      },
    },
  ], { botId: "bot-alfie" });

  chat.messages.push({ role: "assistant", text: "Form", time: Date.now(), a2uiSurfaces: [applied.surfaces.get("form-1")] });

  const first = handleChatA2uiAction(ws, chat.id, {
    surfaceId: "form-1",
    sourceComponentId: "b",
    name: "save_note",
    actionId: "act-1",
    context: { note: "Ship v1" },
    dataModel: { note: "Ship v1" },
  });
  assert.equal(first.ok, true);
  assert.equal(first.idempotent, false);
  assert.equal(first.route, "bot");
  assert.equal(submitted.length, 1);
  assert.match(submitted[0].prompt, /"save_note"/);
  assert.match(submitted[0].prompt, /"dataModel"/);
  assert.match(submitted[0].prompt, /Ship v1/);

  // Re-sending same actionId is idempotent — does NOT trigger a second turn
  const second = handleChatA2uiAction(ws, chat.id, {
    surfaceId: "form-1",
    sourceComponentId: "b",
    name: "save_note",
    actionId: "act-1",
    context: { note: "Ship v1" },
  });
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(submitted.length, 1);
});

test("action routing: built-in dispatch/dismiss enforces owner ACL and is idempotent", () => {
  const { ws, submitted } = makeFakeWorkspace();
  const chat = ws.chat("chat-main");
  const applied = applyA2uiMessages([], [
    {
      version: "1.0",
      createSurface: {
        surfaceId: "triage-1",
        components: [
          { id: "root", component: "Row", children: ["d_btn", "x_btn"] },
          { id: "d_btn", component: "Button", child: "d_lbl", variant: "primary", action: { event: { name: "dispatch" } } },
          { id: "d_lbl", component: "Text", text: "Dispatch to Glory" },
          { id: "x_btn", component: "Button", child: "x_lbl", action: { event: { name: "dismiss" } } },
          { id: "x_lbl", component: "Text", text: "Dismiss" },
        ],
        dataModel: {},
      },
    },
  ], {
    botId: "bot-alfie",
    dispatch: { botName: "Glory", chatTitle: "Fix #400", prompt: "Fix issue #400" },
  });
  chat.messages.push({ role: "assistant", text: "Triage", time: Date.now(), a2uiSurfaces: [applied.surfaces.get("triage-1")] });

  // Non-owner member cannot run built-in dispatch
  assert.throws(
    () => handleChatA2uiAction(ws, chat.id, { surfaceId: "triage-1", sourceComponentId: "d_btn", name: "dispatch", actionId: "d1" }, "member:m1"),
    /Only the host owner/,
  );

  // Owner dispatches -> creates chat with Glory & submits prompt
  const dispatched = handleChatA2uiAction(ws, chat.id, { surfaceId: "triage-1", sourceComponentId: "d_btn", name: "dispatch", actionId: "d1" }, "owner");
  assert.equal(dispatched.route, "builtin");
  assert.equal(dispatched.state, "dispatched");
  assert.equal(dispatched.botName, "Glory");
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].prompt, "Fix issue #400");

  // Second dispatch with different actionId still returns alreadyDispatched without creating a second chat
  const again = handleChatA2uiAction(ws, chat.id, { surfaceId: "triage-1", sourceComponentId: "d_btn", name: "dispatch", actionId: "d2" }, "owner");
  assert.equal(again.alreadyDispatched, true);
  assert.equal(again.chatId, dispatched.chatId);
  assert.equal(submitted.length, 1);
});

test("workflow Output step renders templated A2UI v1.0 surface and routes workflow actions (trigger & resume)", async () => {
  const { ws } = makeFakeWorkspace();
  const wf = ws.workflows.create({
    name: "Release Gate",
    enabled: true,
    nodes: [
      { id: "t1", kind: "trigger", triggerKind: "manual", config: { inputs: [{ name: "release_tag" }] } },
      {
        id: "o1",
        kind: "output",
        config: {
          destination: "chat",
          botName: "Alfie",
          a2ui: {
            onAction: "trigger",
            messages: [
              {
                version: "1.0",
                createSurface: {
                  surfaceId: "release-card",
                  sendDataModel: true,
                  components: [
                    { id: "root", component: "Column", children: ["hdr", "go"] },
                    { id: "hdr", component: "Text", text: "Release {{release_tag}} ready" },
                    {
                      id: "go",
                      component: "Button",
                      child: "go_t",
                      variant: "primary",
                      action: { event: { name: "approve_release", context: { tag: "{{release_tag}}" } } },
                    },
                    { id: "go_t", component: "Text", text: "Ship {{release_tag}}" },
                  ],
                  dataModel: { tag: "{{release_tag}}" },
                },
              },
            ],
          },
        },
      },
    ],
    edges: [{ from: "t1", to: "o1", branch: "default" }],
  });

  const check = validateWorkflow(wf, { strictFields: true });
  assert.equal(check.valid, true, check.errors.join("; "));

  const run = ws.workflows.runManual(wf.id, { inputs: { release_tag: "v0.18.0" }, triggeredBy: "owner" });
  await ws.workflows.waitForRun(run.id);
  assert.equal(run.status, "completed");

  const chat = ws.chat("chat-main");
  const msg = chat.messages.at(-1);
  assert.equal(msg.a2uiSurfaces.length, 1);
  const surface = msg.a2uiSurfaces[0];
  assert.equal(surface.components[1].text, "Release v0.18.0 ready");
  assert.equal(surface.dataModel.tag, "v0.18.0");
  assert.equal(surface.workflow.onAction, "trigger");

  // Clicking the surface action triggers the workflow with the action payload as input
  const triggered = handleChatA2uiAction(ws, chat.id, {
    surfaceId: surface.surfaceId,
    sourceComponentId: "go",
    name: "approve_release",
    actionId: "wf-act-1",
    context: { tag: "v0.18.0" },
  });
  assert.equal(triggered.route, "workflow");
  assert.equal(triggered.mode, "trigger");
  assert.ok(triggered.workflowRunId);
  await ws.workflows.waitForRun(triggered.workflowRunId);
  const secondRun = ws.workflows.getRun(triggered.workflowRunId);
  assert.equal(secondRun.context.action_name, "approve_release");
  assert.equal(secondRun.context.tag, "v0.18.0");
});

test("Link remoteArgs & team ACL permit owner and chat-member chat.a2uiAction", () => {
  const checked = remoteArgs("chat.a2uiAction", [
    "chat-1",
    { surfaceId: "s1", sourceComponentId: "b1", name: "go", context: { ok: true } },
  ]);
  assert.equal(checked[0], "chat-1");
  assert.equal(checked[1].surfaceId, "s1");

  const team = {
    roles: [{ id: "r1", name: "Member", perms: { agents: ["view", "chat"] }, bots: "all" }],
    groups: [{ id: "g1", name: "Members", roleId: "r1" }],
    members: [{ id: "m1", name: "Sam", groupId: "g1" }],
    chats: { "chat-1": ["m1"] },
  };
  const chat = { id: "chat-1", botId: "b1", createdBy: "owner" };
  const member = { kind: "member", memberId: "m1", name: "Sam", groupId: "g1" };
  const refusal = authorize(member, team, "chat.a2uiAction", ["chat-1", { surfaceId: "s1", sourceComponentId: "b1", name: "go" }], {
    chat: () => chat,
    bot: () => ({ id: "b1", name: "Alfie" }),
  });
  assert.equal(refusal, "");
  // A member NOT invited to the chat is refused
  const outsider = { kind: "member", memberId: "m2", name: "Alex", groupId: "g1" };
  const outsiderTeam = { ...team, members: [...team.members, { id: "m2", name: "Alex", groupId: "g1" }] };
  const refused = authorize(outsider, outsiderTeam, "chat.a2uiAction", ["chat-1", { surfaceId: "s1", sourceComponentId: "b1", name: "go" }], {
    chat: () => chat,
    bot: () => ({ id: "b1", name: "Alfie" }),
  });
  assert.ok(refused, "Outsider member must be refused chat.a2uiAction");
});

// ── Desktop React renderer SSR test ────────────────────────────────────────

test("Desktop A2uiSurface renders Basic Catalog components, rich-cards-off fallback, and blocks unsafe URLs", async () => {
  const outFile = join(new URL(".", import.meta.url).pathname, `.a2ui-desktop-bundle-${process.pid}.mjs`);
  const srcDir = new URL("../src/", import.meta.url).pathname;
  await build({
    stdin: {
      contents: `export { default as A2uiSurface } from "./A2uiSurface";`,
      resolveDir: srcDir,
      loader: "ts",
    },
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react-dom", "react-dom/server", "react/jsx-runtime"],
    plugins: [
      {
        name: "css-stub",
        setup(b) {
          b.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
        },
      },
    ],
  });
  let mod;
  try {
    mod = await import(pathToFileURL(outFile).href);
  } finally {
    try { unlinkSync(outFile); } catch {}
  }

  const surface = {
    surfaceId: "desk-1",
    version: "1.0",
    sendDataModel: true,
    components: [
      { id: "root", component: "Column", children: ["heading", "bad_img", "input", "chk", "picker", "slider", "dt", "div", "tabs", "btn"] },
      { id: "heading", component: "Text", text: { "@path": "/title" }, variant: "h2" },
      { id: "bad_img", component: "Image", url: "javascript:alert(1)", description: "Blocked image" },
      { id: "input", component: "TextField", label: "Summary", value: { "@path": "/summary" } },
      { id: "chk", component: "CheckBox", label: "Notify team", value: { "@path": "/notify" } },
      {
        id: "picker",
        component: "ChoicePicker",
        label: "Channel",
        displayStyle: "chips",
        options: [{ label: "Alpha", value: "alpha" }, { label: "Beta", value: "beta" }],
        value: { "@path": "/channels" },
      },
      { id: "slider", component: "Slider", label: "Rollout %", min: 0, max: 100, value: { "@path": "/pct" } },
      { id: "dt", component: "DateTimeInput", label: "Schedule", enableDate: true, value: { "@path": "/when" } },
      { id: "div", component: "Divider" },
      { id: "tabs", component: "Tabs", tabs: [{ title: "Overview", child: "tab_body" }] },
      { id: "tab_body", component: "Text", text: "Inside tab" },
      { id: "btn", component: "Button", child: "btn_t", variant: "primary", action: { event: { name: "submit" } } },
      { id: "btn_t", component: "Text", text: "Submit Release" },
    ],
    dataModel: { title: "Ship 0.18", summary: "Ready", notify: true, channels: ["alpha"], pct: 50, when: "2026-12-01" },
  };

  const richHtml = renderToStaticMarkup(React.createElement(mod.A2uiSurface, { chatId: "chat-1", surface, rich: true }));
  assert.match(richHtml, /Ship 0\.18/);
  assert.match(richHtml, /Blocked image/);
  assert.doesNotMatch(richHtml, /javascript:/i);
  assert.match(richHtml, /Notify team/);
  assert.match(richHtml, /Alpha/);
  assert.match(richHtml, /Inside tab/);
  assert.match(richHtml, /Submit Release/);

  // Rich-cards-off fallback renders plain text + interactive action button
  const plainHtml = renderToStaticMarkup(React.createElement(mod.A2uiSurface, { chatId: "chat-1", surface, rich: false }));
  assert.match(plainHtml, /a2ui-fallback/);
  assert.match(plainHtml, /Ship 0\.18/);
  assert.match(plainHtml, /Submit Release/);
});
