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
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

import {
  A2UI_BASIC_CATALOG_ID,
  A2UI_BOTKINS_CATALOG_ID,
  A2UI_SUPPORTED_CATALOG_IDS,
  A2UI_VERSION,
  applyA2uiMessages,
  buildCallAgentFunctionEnvelope,
  buildRendererActionEnvelope,
  buildRendererFunctionResponseEnvelope,
  evaluateChecks,
  executeRendererFunctionCall,
  getA2uiRendererCapabilities,
  hasUnsupportedA2uiComponent,
  isSafeA2uiMediaUrl,
  isSafeA2uiUrl,
  resolveDynamicString,
  summarizeA2uiSurface,
  validateA2uiActionPayload,
  validateA2uiMessage,
  validateA2uiMessages,
  validateCatalogDefinition,
  validateRendererToAgentMessage,
} from "../desktop/link/a2ui.mjs";
import {
  a2uiTools,
  applyBotA2uiMessages,
  attachRunA2uiSurfaces,
  handleChatA2uiAction,
  handleChatA2uiFunction,
  settleAgentFunctionResponse,
  waitForRendererFunctionResponse,
} from "../desktop/a2ui-host.mjs";
import { Workflows } from "../desktop/workflows.mjs";
import { validateWorkflow } from "../desktop/workflow-fields.mjs";
import { remoteArgs } from "../desktop/link/methods.mjs";
import { authorize } from "../desktop/link/team.mjs";

// ── Parity between desktop/link and mobile/link-host ───────────────────────

test("mirror drift: desktop/desktop/link and mobile/link-host A2UI & catalog files are byte-identical", () => {
  for (const file of ["a2ui.mjs", "a2ui.d.mts", "a2ui-botkins-catalog.json", "methods.mjs", "team.mjs", "server.mjs"]) {
    const d = readFileSync(new URL("../desktop/link/" + file, import.meta.url));
    const m = readFileSync(new URL("../../mobile/link-host/" + file, import.meta.url));
    assert.equal(Buffer.compare(d, m), 0, `${file} drifted between desktop/desktop/link and mobile/link-host`);
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
    teamOf() {
      return {
        roles: [
          { id: "r_guest", name: "Guest", perms: { agents: ["view", "chat"], today: ["view"] }, bots: "all" },
          { id: "r_collab", name: "Collaborator", perms: { agents: ["view", "chat"], today: ["view", "use"] }, bots: "all" },
        ],
        groups: [
          { id: "g_guest", name: "Guests", roleId: "r_guest" },
          { id: "g_collab", name: "Collabs", roleId: "r_collab" },
        ],
        members: [
          { id: "m_guest", name: "Guest Member", groupId: "g_guest" },
          { id: "m_collab", name: "Collab Member", groupId: "g_collab" },
        ],
      };
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
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, "render_ui");
  assert.equal(tools[1].name, "a2ui_respond");

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

test("workflow ACL, explicit approval decisions, and fixed input precedence (a2uiAction & a2uiFunction)", async () => {
  const { ws } = makeFakeWorkspace();
  const chat = ws.chat("chat-main");

  // 1) Approval workflow (Output resume surface -> Approval gate -> Output)
  const approvalWf = ws.workflows.create({
    name: "Deploy Approval",
    enabled: true,
    nodes: [
      { id: "t1", kind: "trigger", triggerKind: "manual", config: { inputs: [{ name: "env" }] } },
      { id: "ap1", kind: "approval", config: { message: "Approve deploy to {{env}}?" } },
      { id: "o_ok", kind: "output", config: { destination: "chat", botName: "Alfie", template: "Approved {{env}}" } },
      { id: "o_no", kind: "output", config: { destination: "chat", botName: "Alfie", template: "Rejected {{env}}" } },
    ],
    edges: [
      { from: "t1", to: "ap1", branch: "default" },
      { from: "ap1", to: "o_ok", branch: "approved" },
      { from: "ap1", to: "o_no", branch: "rejected" },
    ],
  });
  const waitingRun = ws.workflows.runManual(approvalWf.id, { inputs: { env: "prod" }, triggeredBy: "owner" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ws.workflows.getRun(waitingRun.id).status, "waiting_approval");

  const wfFnCatalog = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://example.com/a2ui/wf-gate.json",
    protocolVersion: "1.0",
    catalogId: "https://example.com/a2ui/wf-gate.json",
    functions: {
      approve: { type: "object", properties: { "@call": { const: "approve" } }, required: ["@call"], returnType: "object", allowedCallers: "rendererOrAgent" },
      reject: { type: "object", properties: { "@call": { const: "reject" } }, required: ["@call"], returnType: "object", allowedCallers: "rendererOrAgent" },
      cancel: { type: "object", properties: { "@call": { const: "cancel" } }, required: ["@call"], returnType: "object", allowedCallers: "rendererOrAgent" },
      ship: {
        type: "object",
        properties: {
          "@call": { const: "ship" },
          args: { type: "object", properties: { function_name: { type: "string" }, surface_id: { type: "string" }, env: { type: "string" } } },
        },
        required: ["@call"],
        returnType: "object",
        allowedCallers: "rendererOrAgent",
      },
    },
  };

  // Attach default (owner-only) resume surface to chat
  chat.messages.push({
    role: "assistant",
    text: "Approval gate",
    time: Date.now(),
    a2uiSurfaces: [
      {
        surfaceId: "gate-owner-only",
        version: "1.0",
        catalogId: A2UI_BASIC_CATALOG_ID,
        inlineCatalogs: [wfFnCatalog],
        sendDataModel: true,
        components: [{ id: "root", component: "Text", text: "Deploy gate" }],
        dataModel: {},
        workflow: { workflowId: approvalWf.id, workflowName: approvalWf.name, runId: waitingRun.id, onAction: "resume" },
      },
    ],
  });

  // 1a) Member pressing approve on a workflow resume surface is rejected and run stays waiting_approval
  assert.throws(
    () =>
      handleChatA2uiAction(
        ws,
        chat.id,
        { surfaceId: "gate-owner-only", sourceComponentId: "root", name: "approve", actionId: "m-ap-1" },
        "member:m_collab",
      ),
    /Only the host owner/,
  );
  assert.equal(ws.workflows.getRun(waitingRun.id).status, "waiting_approval");

  // Same for a2uiFunction path
  assert.throws(
    () =>
      handleChatA2uiFunction(
        ws,
        chat.id,
        {
          kind: "callAgentFunction",
          surfaceId: "gate-owner-only",
          functionCallId: "m-fn-ap-1",
          callFunction: { "@call": "approve", catalogId: wfFnCatalog.catalogId },
        },
        "member:m_collab",
      ),
    /Only the host owner/,
  );
  assert.equal(ws.workflows.getRun(waitingRun.id).status, "waiting_approval");

  // 1b) Even with allowMembers: true, a Guest without today/use is rejected on both action & function paths
  const gateSurface = chat.messages.at(-1).a2uiSurfaces[0];
  gateSurface.allowMembers = true;
  assert.throws(
    () =>
      handleChatA2uiAction(
        ws,
        chat.id,
        { surfaceId: "gate-owner-only", sourceComponentId: "root", name: "approve", actionId: "g-ap-1" },
        "member:m_guest",
      ),
    /team role doesn't allow/,
  );
  assert.equal(ws.workflows.getRun(waitingRun.id).status, "waiting_approval");
  assert.throws(
    () =>
      handleChatA2uiFunction(
        ws,
        chat.id,
        {
          kind: "callAgentFunction",
          surfaceId: "gate-owner-only",
          functionCallId: "g-fn-ap-1",
          callFunction: { "@call": "approve", catalogId: wfFnCatalog.catalogId },
        },
        "member:m_guest",
      ),
    /team role doesn't allow/,
  );
  assert.equal(ws.workflows.getRun(waitingRun.id).status, "waiting_approval");

  // 1c) A "cancel" action / function on a resume surface throws and does NOT approve the gate
  assert.throws(
    () =>
      handleChatA2uiAction(
        ws,
        chat.id,
        { surfaceId: "gate-owner-only", sourceComponentId: "root", name: "cancel", actionId: "o-cancel-1" },
        "owner",
      ),
    /not a valid workflow approval decision/,
  );
  assert.equal(ws.workflows.getRun(waitingRun.id).status, "waiting_approval");
  assert.throws(
    () =>
      handleChatA2uiFunction(
        ws,
        chat.id,
        {
          kind: "callAgentFunction",
          surfaceId: "gate-owner-only",
          functionCallId: "o-fn-cancel-1",
          callFunction: { "@call": "cancel", catalogId: wfFnCatalog.catalogId },
        },
        "owner",
      ),
    /not a valid workflow approval decision/,
  );
  assert.equal(ws.workflows.getRun(waitingRun.id).status, "waiting_approval");

  // 1d) Member WITH allowMembers: true AND today/use CAN explicitly approve via a2uiFunction
  const fnApproved = handleChatA2uiFunction(
    ws,
    chat.id,
    {
      kind: "callAgentFunction",
      surfaceId: "gate-owner-only",
      functionCallId: "c-fn-ap-1",
      callFunction: { "@call": "approve", catalogId: wfFnCatalog.catalogId },
    },
    "member:m_collab",
  );
  assert.equal(fnApproved.route, "workflow");
  assert.equal(fnApproved.mode, "resume");
  assert.equal(fnApproved.decision, "approved");
  await ws.workflows.waitForRun(waitingRun.id);
  assert.equal(ws.workflows.getRun(waitingRun.id).status, "completed");

  // 1e) Second waiting run: declared decision map in workflow meta works, and explicit reject works on a2uiAction
  const waitingRun2 = ws.workflows.runManual(approvalWf.id, { inputs: { env: "staging" }, triggeredBy: "owner" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ws.workflows.getRun(waitingRun2.id).status, "waiting_approval");
  const latestGateMsg = chat.messages.find((m) => m.a2uiSurfaces?.some((s) => s.surfaceId === "gate-owner-only"));
  latestGateMsg.a2uiSurfaces[0].workflow = {
    workflowId: approvalWf.id,
    workflowName: approvalWf.name,
    runId: waitingRun2.id,
    onAction: "resume",
    decisions: { ship_now: "approved" },
  };
  const declaredOk = handleChatA2uiAction(
    ws,
    chat.id,
    { surfaceId: "gate-owner-only", sourceComponentId: "root", name: "ship_now", actionId: "o-ship-now" },
    "owner",
  );
  assert.equal(declaredOk.decision, "approved");
  await ws.workflows.waitForRun(waitingRun2.id);
  assert.equal(ws.workflows.getRun(waitingRun2.id).status, "completed");

  // 2) Trigger workflow ACL + fixed input key precedence (a2uiAction & a2uiFunction)
  const triggerWf = ws.workflows.create({
    name: "Trigger Target",
    enabled: true,
    nodes: [
      { id: "t1", kind: "trigger", triggerKind: "manual", config: { inputs: [{ name: "env" }] } },
      { id: "o1", kind: "output", config: { destination: "chat", botName: "Alfie", template: "Triggered {{env}}" } },
    ],
    edges: [{ from: "t1", to: "o1", branch: "default" }],
  });
  chat.messages.push({
    role: "assistant",
    text: "Trigger card",
    time: Date.now(),
    a2uiSurfaces: [
      {
        surfaceId: "trig-owner-only",
        version: "1.0",
        catalogId: A2UI_BASIC_CATALOG_ID,
        inlineCatalogs: [wfFnCatalog],
        sendDataModel: true,
        components: [{ id: "root", component: "Text", text: "Trigger" }],
        dataModel: {},
        workflow: { workflowId: triggerWf.id, workflowName: triggerWf.name, onAction: "trigger" },
      },
    ],
  });

  const runsBefore = ws.workflows.runs.filter((r) => r.workflowId === triggerWf.id).length;

  // 2a) Member on default trigger surface is rejected and NO run gets created (action + function)
  assert.throws(
    () =>
      handleChatA2uiAction(
        ws,
        chat.id,
        { surfaceId: "trig-owner-only", sourceComponentId: "root", name: "ship", actionId: "m-tr-1" },
        "member:m_collab",
      ),
    /Only the host owner/,
  );
  assert.throws(
    () =>
      handleChatA2uiFunction(
        ws,
        chat.id,
        {
          kind: "callAgentFunction",
          surfaceId: "trig-owner-only",
          functionCallId: "m-fn-tr-1",
          callFunction: { "@call": "ship", catalogId: wfFnCatalog.catalogId, args: { env: "prod" } },
        },
        "member:m_collab",
      ),
    /Only the host owner/,
  );
  assert.equal(ws.workflows.runs.filter((r) => r.workflowId === triggerWf.id).length, runsBefore);

  // 2b) Context / args trying to override fixed keys (`action_name`, `surface_id`, `function_name`, `function_call_id`) cannot override them
  const trigAct = handleChatA2uiAction(
    ws,
    chat.id,
    {
      surfaceId: "trig-owner-only",
      sourceComponentId: "root",
      name: "real_action",
      actionId: "o-tr-override",
      context: {
        action_name: "spoofed_action",
        surface_id: "spoofed-surface",
        component_id: "spoofed-comp",
        action_context: "spoofed-ctx",
        env: "staging",
      },
    },
    "owner",
  );
  await ws.workflows.waitForRun(trigAct.workflowRunId);
  const actRun = ws.workflows.getRun(trigAct.workflowRunId);
  assert.equal(actRun.context.action_name, "real_action");
  assert.equal(actRun.context.surface_id, "trig-owner-only");
  assert.equal(actRun.context.component_id, "root");
  assert.notEqual(actRun.context.action_context, "spoofed-ctx");
  assert.equal(actRun.context.env, "staging");

  const trigFn = handleChatA2uiFunction(
    ws,
    chat.id,
    {
      kind: "callAgentFunction",
      surfaceId: "trig-owner-only",
      functionCallId: "o-fn-override",
      callFunction: {
        "@call": "ship",
        catalogId: wfFnCatalog.catalogId,
        args: {
          function_name: "spoofed_fn",
          function_call_id: "spoofed-call",
          surface_id: "spoofed-surface",
          function_args: "spoofed-args",
          env: "canary",
        },
      },
    },
    "owner",
  );
  await ws.workflows.waitForRun(trigFn.workflowRunId);
  const fnRun = ws.workflows.getRun(trigFn.workflowRunId);
  assert.equal(fnRun.context.function_name, "ship");
  assert.equal(fnRun.context.function_call_id, "o-fn-override");
  assert.equal(fnRun.context.surface_id, "trig-owner-only");
  assert.notEqual(fnRun.context.function_args, "spoofed-args");
  assert.equal(fnRun.context.env, "canary");
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

  // Botkins Catalog surface: BotAvatar, Badge, StatusBadge, Metric, Progress, Chart (bar + line), Table, TaskCard, ApprovalCard
  const botkinsSurface = {
    surfaceId: "botkins-ops-1",
    version: "1.0",
    catalogId: A2UI_BOTKINS_CATALOG_ID,
    components: [
      { id: "root", component: "Column", children: ["av", "badges", "metrics", "prog", "bar", "line", "tbl", "task", "appr"] },
      { id: "av", component: "BotAvatar", name: "Glory", role: "Coding partner", status: "working" },
      { id: "badges", component: "Row", children: ["b1", "b2"] },
      { id: "b1", component: "Badge", label: "PR #346", tone: "accent" },
      { id: "b2", component: "StatusBadge", label: "CI Green", tone: "positive", pulse: true },
      { id: "metrics", component: "Row", children: ["m1", "m2"] },
      { id: "m1", component: "Metric", label: "Tests", value: "1,245", delta: "+31", tone: "positive" },
      { id: "m2", component: "Metric", label: "Latency", value: "142ms", note: "p95" },
      { id: "prog", component: "Progress", label: "Rollout", value: 75, max: 100, tone: "positive" },
      {
        id: "bar",
        component: "Chart",
        kind: "bar",
        title: "Requests by region",
        items: [{ label: "US-East", value: 420 }, { label: "EU-West", value: 280 }],
        unit: "rps",
      },
      {
        id: "line",
        component: "Chart",
        kind: "line",
        title: "Success rate",
        labels: ["Mon", "Tue", "Wed"],
        series: [{ name: "API", values: [99.1, 99.6, 99.9] }],
      },
      {
        id: "tbl",
        component: "Table",
        title: "Deploy targets",
        columns: ["Env", "Version", "Status"],
        rows: [["Staging", "0.18.0", "Healthy"], ["Prod", "0.17.23", "Pending"]],
      },
      {
        id: "task",
        component: "TaskCard",
        title: "Cut release tag",
        summary: "Tag v0.18.0 after approval",
        priority: "high",
        status: "Ready",
        botName: "Alfie",
        actionLabel: "Start",
        action: { event: { name: "start_tag" } },
      },
      {
        id: "appr",
        component: "ApprovalCard",
        title: "Approve production deploy",
        summary: "Ships relay + desktop + mobile A2UI v1.0",
        risk: "medium",
        status: "pending",
        approveAction: { event: { name: "approve" } },
        rejectAction: { event: { name: "reject" } },
      },
    ],
    dataModel: {},
  };
  const botkinsHtml = renderToStaticMarkup(React.createElement(mod.A2uiSurface, { chatId: "chat-1", surface: botkinsSurface, rich: true }));
  assert.match(botkinsHtml, /Glory/);
  assert.match(botkinsHtml, /CI Green/);
  assert.match(botkinsHtml, /1,245/);
  assert.match(botkinsHtml, /Requests by region/);
  assert.match(botkinsHtml, /<svg/);
  assert.match(botkinsHtml, /<table/);
  assert.match(botkinsHtml, /Cut release tag/);
  assert.match(botkinsHtml, /Approve production deploy/);

  // Inline Video & Audio players (https allowed with controls & no autoplay; data:video blocked to fallback)
  const mediaSurface = {
    surfaceId: "media-1",
    version: "1.0",
    components: [
      { id: "root", component: "Column", children: ["vid", "aud", "bad_vid"] },
      { id: "vid", component: "Video", url: "https://media.botkins.app/demo.mp4", posterUrl: "https://media.botkins.app/poster.png" },
      { id: "aud", component: "AudioPlayer", url: "https://media.botkins.app/briefing.mp3", description: "Morning brief" },
      { id: "bad_vid", component: "Video", url: "data:video/mp4;base64,AAAA" },
    ],
    dataModel: {},
  };
  const mediaHtml = renderToStaticMarkup(React.createElement(mod.A2uiSurface, { chatId: "chat-1", surface: mediaSurface, rich: true }));
  assert.match(mediaHtml, /<video[^>]*controls/);
  assert.doesNotMatch(mediaHtml, /<video[^>]*autoplay/i);
  assert.match(mediaHtml, /<audio[^>]*controls/);
  assert.match(mediaHtml, /Morning brief/);
  assert.match(mediaHtml, /Unsupported media URL/);
  assert.doesNotMatch(mediaHtml, /data:video\/mp4/);

  // Unknown catalog / component gracefully falls back to plain-text + action buttons without crashing
  const unknownSurface = {
    surfaceId: "unknown-1",
    version: "1.0",
    catalogId: "https://example.com/unknown/catalog.json",
    components: [
      { id: "root", component: "Column", "@catalogId": A2UI_BASIC_CATALOG_ID, children: ["w1", "btn"] },
      { id: "w1", component: "HologramWidget", title: "3D Telemetry" },
      { id: "btn", component: "Button", "@catalogId": A2UI_BASIC_CATALOG_ID, child: "btn_t", action: { event: { name: "ack" } } },
      { id: "btn_t", component: "Text", "@catalogId": A2UI_BASIC_CATALOG_ID, text: "Acknowledge" },
    ],
    dataModel: {},
  };
  assert.equal(hasUnsupportedA2uiComponent(unknownSurface), true);
  const unknownHtml = renderToStaticMarkup(React.createElement(mod.A2uiSurface, { chatId: "chat-1", surface: unknownSurface, rich: true }));
  assert.match(unknownHtml, /a2ui-fallback/);
  assert.match(unknownHtml, /3D Telemetry/);
  assert.match(unknownHtml, /Acknowledge/);
});

// ── Round 2: Two-way Function Calls ────────────────────────────────────────

function makeMockWorkspace() {
  const { ws, submitted } = makeFakeWorkspace();
  const bot = ws.state.bots[0];
  const chat = ws.chat("chat-main");
  const run = { id: "run-r2-1", chatId: chat.id, status: "Working" };
  ws.state.runs.push(run);
  ws.submissions = submitted;
  return { ws, bot, chat, run };
}

test("two-way function calls: callAgentFunction round trip, timeout, unknown function, invalid response, and replay idempotency", async () => {
  const { ws, bot, chat, run } = makeMockWorkspace();
  const customCatalog = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://example.com/a2ui/calc.json",
    protocolVersion: "1.0",
    catalogId: "https://example.com/a2ui/calc.json",
    components: {
      CalcBox: {
        type: "object",
        properties: {
          component: { const: "CalcBox" },
          child: { $ref: "common_types.json#/$defs/Child" },
        },
        required: ["component"],
      },
    },
    functions: {
      estimateCost: {
        type: "object",
        properties: {
          "@call": { const: "estimateCost" },
          args: { type: "object", properties: { units: { type: "number" } } },
        },
        required: ["@call"],
        returnType: "number",
        allowedCallers: "rendererOrAgent",
      },
      localOnlyFn: {
        type: "object",
        properties: { "@call": { const: "localOnlyFn" } },
        required: ["@call"],
        returnType: "string",
        allowedCallers: "rendererOnly",
      },
    },
  };

  applyBotA2uiMessages(
    ws,
    bot,
    chat,
    run,
    [
      {
        version: "1.0",
        createSurface: {
          surfaceId: "calc-1",
          catalogId: A2UI_BOTKINS_CATALOG_ID,
          sendDataModel: true,
          components: [
            { id: "root", component: "Column", children: ["t"] },
            { id: "t", component: "Text", text: "Calculator" },
          ],
          dataModel: { units: 4 },
        },
      },
    ],
    { inlineCatalogs: [customCatalog] },
  );
  attachRunA2uiSurfaces(chat, run, bot.id);

  // 1) Round trip: callAgentFunction -> bot turn with untrusted framing -> a2ui_respond -> settled envelope
  const call1 = handleChatA2uiFunction(ws, chat.id, {
    kind: "callAgentFunction",
    surfaceId: "calc-1",
    functionCallId: "fn-rt-1",
    callFunction: { "@call": "estimateCost", catalogId: "https://example.com/a2ui/calc.json", args: { units: 4 } },
    timeoutMs: 5000,
  });
  assert.equal(call1.ok, true);
  assert.equal(call1.status, "pending");
  assert.equal(ws.submissions.length, 1);
  assert.match(ws.submissions[0].prompt, /untrusted user input data/i);
  assert.match(ws.submissions[0].prompt, /fn-rt-1/);

  // 2) Invalid response type rejected (string instead of declared returnType: "number")
  assert.throws(
    () => settleAgentFunctionResponse(ws, chat.id, { functionCallId: "fn-rt-1", value: "not-a-number" }),
    /INVALID_RESPONSE/,
  );

  // Valid response settles & matches spec
  const settled = settleAgentFunctionResponse(ws, chat.id, { functionCallId: "fn-rt-1", value: 42.5 });
  assert.equal(settled.ok, true);
  assert.equal(settled.idempotent, false);
  const waited = await call1.wait();
  assert.deepEqual(waited, {
    version: "1.0",
    agentFunctionResponse: { functionCallId: "fn-rt-1", value: 42.5 },
  });

  // 3) Replayed functionCallId is idempotent (no second bot turn)
  const replay = handleChatA2uiFunction(ws, chat.id, {
    kind: "callAgentFunction",
    surfaceId: "calc-1",
    functionCallId: "fn-rt-1",
    callFunction: { "@call": "estimateCost", catalogId: "https://example.com/a2ui/calc.json", args: { units: 4 } },
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.envelope.agentFunctionResponse.value, 42.5);
  assert.equal(ws.submissions.length, 1);

  // 4) Unknown function returns structured UNKNOWN_FUNCTION error without starting a bot turn
  const unknownRes = handleChatA2uiFunction(ws, chat.id, {
    kind: "callAgentFunction",
    surfaceId: "calc-1",
    functionCallId: "fn-unk-1",
    callFunction: { "@call": "doesNotExist", catalogId: A2UI_BASIC_CATALOG_ID },
  });
  assert.equal(unknownRes.ok, false);
  assert.equal(unknownRes.envelope.agentFunctionResponse.error.code, "UNKNOWN_FUNCTION");
  assert.equal(ws.submissions.length, 1);

  // 5) rendererOnly function refused on agent
  const authRes = handleChatA2uiFunction(ws, chat.id, {
    kind: "callAgentFunction",
    surfaceId: "calc-1",
    functionCallId: "fn-auth-1",
    callFunction: { "@call": "localOnlyFn", catalogId: "https://example.com/a2ui/calc.json" },
  });
  assert.equal(authRes.ok, false);
  assert.equal(authRes.envelope.agentFunctionResponse.error.code, "UNAUTHORIZED_CALLER");

  // 6) Timeout settles with TIMEOUT error
  const timedCall = handleChatA2uiFunction(ws, chat.id, {
    kind: "callAgentFunction",
    surfaceId: "calc-1",
    functionCallId: "fn-to-1",
    callFunction: { "@call": "estimateCost", catalogId: "https://example.com/a2ui/calc.json", args: { units: 9 } },
    timeoutMs: 60,
  });
  const timeoutEnv = await timedCall.wait();
  assert.equal(timeoutEnv.agentFunctionResponse.error.code, "TIMEOUT");
});

test("two-way function calls: callRendererFunction -> rendererFunctionResponse round trip, side-effect confirm, invalid response, timeout, replay", async () => {
  const { ws, bot, chat, run } = makeMockWorkspace();
  applyBotA2uiMessages(ws, bot, chat, run, [
    {
      version: "1.0",
      createSurface: {
        surfaceId: "rf-1",
        catalogId: A2UI_BOTKINS_CATALOG_ID,
        components: [
          { id: "root", component: "Text", text: "Theme check" },
        ],
        dataModel: {},
      },
    },
    {
      version: "1.0",
      callRendererFunction: {
        surfaceId: "rf-1",
        functionCallId: "rcall-1",
        callFunction: { "@call": "getThemeMode", catalogId: A2UI_BOTKINS_CATALOG_ID },
      },
    },
  ]);
  attachRunA2uiSurfaces(chat, run, bot.id);

  // Renderer executes declared function and produces spec-compliant rendererFunctionResponse
  const execEnv = await executeRendererFunctionCall(
    {
      version: "1.0",
      callRendererFunction: {
        surfaceId: "rf-1",
        functionCallId: "rcall-1",
        callFunction: { "@call": "getThemeMode", catalogId: A2UI_BOTKINS_CATALOG_ID },
      },
    },
    { surfaceCatalogId: A2UI_BOTKINS_CATALOG_ID, themeMode: "dark" },
  );
  assert.deepEqual(execEnv, { version: "1.0", rendererFunctionResponse: { functionCallId: "rcall-1", value: "dark" } });
  // Validate emitted envelope against renderer_to_agent.json rules
  validateRendererToAgentMessage(execEnv);

  // Invalid renderer response type (number when string declared) is rejected
  assert.throws(
    () =>
      handleChatA2uiFunction(ws, chat.id, {
        kind: "rendererFunctionResponse",
        surfaceId: "rf-1",
        response: { functionCallId: "rcall-1", value: 12345 },
      }),
    /INVALID_RESPONSE/,
  );

  // Valid rendererFunctionResponse settles and unblocks waitForRendererFunctionResponse
  const waiter = waitForRendererFunctionResponse(ws, "rcall-1");
  const ack = handleChatA2uiFunction(ws, chat.id, {
    kind: "rendererFunctionResponse",
    surfaceId: "rf-1",
    response: execEnv.rendererFunctionResponse,
  });
  assert.equal(ack.ok, true);
  assert.equal(ack.idempotent, false);
  const resolved = await waiter;
  assert.equal(resolved.rendererFunctionResponse.value, "dark");

  // Replay of same functionCallId is idempotent
  const replay = handleChatA2uiFunction(ws, chat.id, {
    kind: "rendererFunctionResponse",
    surfaceId: "rf-1",
    response: execEnv.rendererFunctionResponse,
  });
  assert.equal(replay.idempotent, true);

  // Side-effecting function (openUrl) requires confirmation and respects user decline
  let confirmed = 0;
  let opened = 0;
  const declinedEnv = await executeRendererFunctionCall(
    {
      version: "1.0",
      callRendererFunction: {
        functionCallId: "rcall-open-1",
        callFunction: { "@call": "openUrl", catalogId: A2UI_BASIC_CATALOG_ID, args: { url: "https://botkins.app" } },
      },
    },
    {
      handlers: {
        confirmSideEffect: () => {
          confirmed++;
          return false;
        },
        openUrl: () => {
          opened++;
        },
      },
    },
  );
  assert.equal(confirmed, 1);
  assert.equal(opened, 0);
  assert.equal(declinedEnv.rendererFunctionResponse.error.code, "USER_DECLINED");

  // Unknown renderer function is rejected on host and renderer
  assert.throws(
    () =>
      applyBotA2uiMessages(ws, bot, chat, run, [
        {
          version: "1.0",
          callRendererFunction: {
            functionCallId: "rcall-bad",
            callFunction: { "@call": "stealSecrets", catalogId: A2UI_BASIC_CATALOG_ID },
          },
        },
      ]),
    /Unknown renderer function/,
  );

  // Renderer call timeout settles with TIMEOUT
  applyBotA2uiMessages(
    ws,
    bot,
    chat,
    run,
    [
      {
        version: "1.0",
        callRendererFunction: {
          surfaceId: "rf-1",
          functionCallId: "rcall-timeout",
          callFunction: { "@call": "getThemeMode", catalogId: A2UI_BOTKINS_CATALOG_ID },
        },
      },
    ],
    { timeoutMs: 60 },
  );
  const timedOut = await waitForRendererFunctionResponse(ws, "rcall-timeout");
  assert.equal(timedOut.rendererFunctionResponse.error.code, "TIMEOUT");
});

// ── Round 2: Bot-turn Trigger ACL (owner-default + allowMembers + rate limit) ──

test("bot-turn trigger ACL: owner-only by default, allowMembers opt-in is rate-limited, dispatch/dismiss stay owner-only", () => {
  const { ws, bot, chat, run } = makeMockWorkspace();
  ws.memberAuthor = (id) => ({ memberId: id, name: "Sam" });

  // Default surface (allowMembers omitted -> false): owner allowed, member blocked
  applyBotA2uiMessages(ws, bot, chat, run, [
    {
      version: "1.0",
      createSurface: {
        surfaceId: "acl-default",
        components: [
          { id: "root", component: "Button", child: "lbl", action: { event: { name: "ping" } } },
          { id: "lbl", component: "Text", text: "Ping" },
        ],
        dataModel: {},
      },
    },
  ]);
  attachRunA2uiSurfaces(chat, run, bot.id);

  assert.throws(
    () => handleChatA2uiAction(ws, chat.id, { surfaceId: "acl-default", sourceComponentId: "root", name: "ping", actionId: "m-1" }, "member:m1"),
    /Only the host owner/,
  );
  const ownerOk = handleChatA2uiAction(ws, chat.id, { surfaceId: "acl-default", sourceComponentId: "root", name: "ping", actionId: "o-1" }, "owner");
  assert.equal(ownerOk.route, "bot");

  // Opt-in surface (allowMembers: true): member allowed up to rate limit; dispatch/dismiss still owner-only
  const run2 = { id: "run-2", chatId: chat.id, status: "Working" };
  ws.state.runs.push(run2);
  applyBotA2uiMessages(
    ws,
    bot,
    chat,
    run2,
    [
      {
        version: "1.0",
        createSurface: {
          surfaceId: "acl-shared",
          components: [
            { id: "root", component: "Button", child: "lbl", action: { event: { name: "vote" } } },
            { id: "lbl", component: "Text", text: "Vote" },
          ],
          dataModel: {},
        },
      },
    ],
    { allowMembers: true },
  );
  attachRunA2uiSurfaces(chat, run2, bot.id);

  // Dispatch/dismiss remain strictly owner-only even when allowMembers is true
  assert.throws(
    () => handleChatA2uiAction(ws, chat.id, { surfaceId: "acl-shared", sourceComponentId: "root", name: "dismiss", actionId: "m-dismiss" }, "member:m1"),
    /Only the host owner/,
  );

  // Member triggers succeed up to the per-window cap (6), then hit rate limit on 7th
  for (let i = 1; i <= 6; i++) {
    const r = handleChatA2uiAction(
      ws,
      chat.id,
      { surfaceId: "acl-shared", sourceComponentId: "root", name: "vote", actionId: `m-vote-${i}` },
      "member:m1",
    );
    assert.equal(r.route, "bot");
  }
  assert.throws(
    () =>
      handleChatA2uiAction(
        ws,
        chat.id,
        { surfaceId: "acl-shared", sourceComponentId: "root", name: "vote", actionId: "m-vote-7" },
        "member:m1",
      ),
    /Rate limit exceeded/,
  );
});

// ── Round 2: Multi-catalog mixing & capabilities ───────────────────────────

test("catalogs beyond Basic: @catalogId mixing, Botkins catalog schema, inline catalogs, and capability advertisement", () => {
  const botkinsCat = JSON.parse(readFileSync(new URL("../desktop/link/a2ui-botkins-catalog.json", import.meta.url), "utf8"));
  const validatedCat = validateCatalogDefinition(botkinsCat);
  assert.equal(validatedCat.catalogId, A2UI_BOTKINS_CATALOG_ID);
  assert.ok(validatedCat.components.Chart);
  assert.ok(validatedCat.components.ApprovalCard);

  // Per-component @catalogId mixing (Basic root + Botkins Metric + Botkins ApprovalCard)
  const mixed = applyA2uiMessages([], [
    {
      version: "1.0",
      createSurface: {
        surfaceId: "mixed-1",
        catalogId: A2UI_BASIC_CATALOG_ID,
        components: [
          { id: "root", component: "Column", children: ["hdr", "kpi", "appr"] },
          { id: "hdr", component: "Text", text: "Release Readiness", variant: "h2" },
          { id: "kpi", "@catalogId": A2UI_BOTKINS_CATALOG_ID, component: "Metric", label: "Pass Rate", value: "100%", tone: "positive" },
          {
            id: "appr",
            "@catalogId": A2UI_BOTKINS_CATALOG_ID,
            component: "ApprovalCard",
            title: "Ship v0.18",
            approveAction: { event: { name: "approve" } },
          },
        ],
        dataModel: {},
      },
    },
  ]);
  assert.equal(mixed.createdIds[0], "mixed-1");

  // Inline catalog ComponentId/ChildList & allowedParents/allowedChildren validation
  const strictCat = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://example.com/a2ui/strict.json",
    protocolVersion: "1.0",
    catalogId: "https://example.com/a2ui/strict.json",
    components: {
      Board: {
        type: "object",
        allowedParents: ["Surface"],
        allowedChildren: ["Tile"],
        properties: {
          component: { const: "Board" },
          tiles: { $ref: "common_types.json#/$defs/ChildList" },
        },
        required: ["component", "tiles"],
      },
      Tile: {
        type: "object",
        allowedParents: ["Board"],
        properties: {
          component: { const: "Tile" },
          label: { type: "string" },
        },
        required: ["component", "label"],
      },
    },
  };
  assert.doesNotThrow(() =>
    applyA2uiMessages(
      [],
      [
        {
          version: "1.0",
          createSurface: {
            surfaceId: "strict-ok",
            catalogId: "https://example.com/a2ui/strict.json",
            components: [
              { id: "root", component: "Board", tiles: ["t1"] },
              { id: "t1", component: "Tile", label: "A" },
            ],
          },
        },
      ],
      { inlineCatalogs: [strictCat] },
    ),
  );
  // Missing referenced child ID in custom ChildList slot fails tree check
  assert.throws(
    () =>
      applyA2uiMessages(
        [],
        [
          {
            version: "1.0",
            createSurface: {
              surfaceId: "strict-missing",
              catalogId: "https://example.com/a2ui/strict.json",
              components: [{ id: "root", component: "Board", tiles: ["missing-tile"] }],
            },
          },
        ],
        { inlineCatalogs: [strictCat] },
      ),
    /missing tiles/,
  );

  // Capabilities advertisement per renderer_capabilities.json and render_ui tool description
  const caps = getA2uiRendererCapabilities();
  assert.deepEqual(caps["1.0"].supportedCatalogIds, [...A2UI_SUPPORTED_CATALOG_IDS]);
  const { ws, bot, chat, run } = makeMockWorkspace();
  const tools = a2uiTools(ws, bot, chat, run, { stopped: false });
  const renderUi = tools.find((t) => t.name === "render_ui");
  const respondTool = tools.find((t) => t.name === "a2ui_respond");
  assert.ok(renderUi && respondTool);
  assert.ok(renderUi.description.includes(A2UI_BASIC_CATALOG_ID));
  assert.ok(renderUi.description.includes(A2UI_BOTKINS_CATALOG_ID));
});

// ── Round 2: Media URL safety & Spec Conformance Fixtures ──────────────────

test("isSafeA2uiMediaUrl allows https and Botkins-served URLs only (rejects data:video, file:, javascript:, arbitrary http)", () => {
  assert.equal(isSafeA2uiMediaUrl("https://cdn.example.com/demo.mp4"), true);
  assert.equal(isSafeA2uiMediaUrl("botkins-media://clip-1.mp4"), true);
  assert.equal(isSafeA2uiMediaUrl("/media/clip-1.mp3"), true);
  assert.equal(isSafeA2uiMediaUrl("http://127.0.0.1:4123/artifacts/demo.mp4"), true);
  assert.equal(isSafeA2uiMediaUrl("data:video/mp4;base64,AAAA"), false);
  assert.equal(isSafeA2uiMediaUrl("data:audio/mpeg;base64,AAAA"), false);
  assert.equal(isSafeA2uiMediaUrl("file:///etc/passwd"), false);
  assert.equal(isSafeA2uiMediaUrl("javascript:alert(1)"), false);
  assert.equal(isSafeA2uiMediaUrl("http://untrusted.example.com/clip.mp4"), false);
});

test("spec conformance: official v1.0 schemas, all 43 Basic Catalog examples, contact_form_example.jsonl, invalid cases, and emitted renderer_to_agent envelopes", () => {
  const fixtureRoot = new URL("./fixtures/a2ui-v1_0/", import.meta.url);
  // 1) Vendored official schemas parse cleanly and carry official v1.0 $ids
  for (const schemaFile of ["agent_to_renderer.json", "renderer_to_agent.json", "common_types.json", "catalog_definition.json", "renderer_capabilities.json", "catalogs/basic/catalog.json"]) {
    const schema = JSON.parse(readFileSync(new URL(schemaFile, fixtureRoot), "utf8"));
    assert.ok(schema.$id && schema.$schema, `${schemaFile} must have $id and $schema`);
  }

  // 2) Every official Basic Catalog v1 example must pass validation & surface application
  const examplesDir = new URL("./examples/", fixtureRoot);
  const exampleFiles = readdirSync(examplesDir).filter((f) => f.endsWith(".json")).sort();
  assert.ok(exampleFiles.length >= 40, `Expected official Basic examples, got ${exampleFiles.length}`);
  for (const file of exampleFiles) {
    const raw = JSON.parse(readFileSync(new URL(file, examplesDir), "utf8"));
    const msgs = Array.isArray(raw) ? raw : Array.isArray(raw.messages) ? raw.messages : [raw];
    assert.doesNotThrow(() => applyA2uiMessages([], msgs), `Official example ${file} must pass`);
  }

  // 3) Official contact_form_example.jsonl must pass
  const contactLines = readFileSync(new URL("./cases/contact_form_example.jsonl", fixtureRoot), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.doesNotThrow(() => applyA2uiMessages([], contactLines));

  // 4) Known-invalid v1.0 cases must fail (e.g. v0.9 theme on createSurface, missing catalogId on callRendererFunction)
  assert.throws(
    () =>
      validateA2uiMessage({
        version: "1.0",
        createSurface: { surfaceId: "s1", theme: { primaryColor: "#000" }, components: [{ id: "root", component: "Text", text: "hi" }] },
      }),
    /theme/,
  );
  const callFnCases = JSON.parse(readFileSync(new URL("./cases/call_function_message.json", fixtureRoot), "utf8"));
  for (const tc of callFnCases.tests) {
    if (tc.description.includes("missing catalogId")) {
      assert.throws(() => validateA2uiMessage(tc.data), `Expected invalid case to fail: ${tc.description}`);
    }
  }

  // 5) Official renderer_messages.json & function_response.json positive/negative cases match validateRendererToAgentMessage
  const rendererMsgCases = JSON.parse(readFileSync(new URL("./cases/renderer_messages.json", fixtureRoot), "utf8"));
  for (const tc of rendererMsgCases.tests) {
    if (tc.valid) {
      assert.doesNotThrow(() => validateRendererToAgentMessage(tc.data), `Expected valid renderer msg: ${tc.description}`);
    } else {
      assert.throws(() => validateRendererToAgentMessage(tc.data), `Expected invalid renderer msg: ${tc.description}`);
    }
  }
  const fnRespCases = JSON.parse(readFileSync(new URL("./cases/function_response.json", fixtureRoot), "utf8"));
  for (const tc of fnRespCases.tests) {
    if (tc.valid) {
      assert.doesNotThrow(() => validateRendererToAgentMessage(tc.data), `Expected valid function_response: ${tc.description}`);
    } else {
      assert.throws(() => validateRendererToAgentMessage(tc.data), `Expected invalid function_response: ${tc.description}`);
    }
  }

  // 6) Action and function envelopes we emit conform strictly to renderer_to_agent.json
  const emittedAction = buildRendererActionEnvelope({
    name: "deploy",
    surfaceId: "deploy-confirm",
    sourceComponentId: "go_btn",
    userMessage: "Deploy now",
    context: { service: "relay" },
  });
  assert.doesNotThrow(() => validateRendererToAgentMessage(emittedAction));
  const emittedCall = buildCallAgentFunctionEnvelope({
    surfaceId: "calc-1",
    functionCallId: "call-1",
    callFunction: { "@call": "computeSummary", catalogId: A2UI_BOTKINS_CATALOG_ID, args: { topic: "release" } },
  });
  assert.doesNotThrow(() => validateRendererToAgentMessage(emittedCall));
  const emittedResp = buildRendererFunctionResponseEnvelope({
    functionCallId: "rcall-1",
    value: "dark",
  });
  assert.doesNotThrow(() => validateRendererToAgentMessage(emittedResp));
});
