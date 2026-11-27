import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interactions } from "../desktop/interactions.mjs";
import { sessionOptions } from "../desktop/providers/copilot/index.mjs";
import { OmpProvider } from "../desktop/providers/omp/index.mjs";
import { PiProvider } from "../desktop/providers/pi/index.mjs";
import { ASK, makeBotkinsExtension } from "../desktop/providers/pi/extension-shared.mjs";

const path = process.platform === "win32" ? "C:\\fixture\\note.txt" : "/fixture/note.txt";
const native = (name) => ({ name, sourceInfo: { source: "builtin", path: `builtin:${name}` } });
const visible = ({ kind, label, title, preview, remember, readOnly, managed, sandboxEscape }) =>
  ({ kind, label, title, preview, remember, readOnly, managed, sandboxEscape });

async function fixture(t, harness, { servers = {}, approval = "ask", approvals = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-permissions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const chat = { id: "fixture", approval, approvals };
  const task = {};
  const interactions = new Interactions({ state: { chats: [chat] }, notify() {}, save() {} });
  const seen = [];
  const handlers = { permission(request) { seen.push(request); return interactions.permission(chat, task, request); } };
  if (harness === "Copilot") {
    const spec = { model: { model: "synthetic" }, approval };
    const options = sessionOptions(spec, { handlers }).permissions;
    return { chat, task, interactions, seen, mode: options.mode, request: options.onRequest };
  }
  const isPi = harness === "Pi";
  const Provider = isPi ? PiProvider : OmpProvider;
  const provider = new Provider({ dataDir: dir });
  const session = await provider.openSession({ sessionId: "fixture", model: {}, tools: [], handlers, mcpServers: servers });
  session.turn = { calls: new Map() };
  t.after(async () => { session.turn = null; await provider.stop(); });
  const file = join(dir, "session.json");
  writeFileSync(file, JSON.stringify({ servers }));
  const extension = {};
  let tool;
  makeBotkinsExtension(file, { mcp: isPi })({
    registerMcpServer() {},
    getAllTools: () => tool ? [tool] : [],
    on: (name, fn) => { extension[name] = fn; },
  });
  async function request({ input, info, event = {} }) {
    tool = !isPi && info?.sourceInfo?.source === "builtin" && info.sourceInfo.path !== "builtin:mcp"
      ? { ...info, sourceInfo: { ...info.sourceInfo, path: `<${info.sourceInfo.path}>` } } : info;
    const result = await extension.tool_call({ toolCallId: "call", toolName: info?.name, input, ...event }, {
      ui: { select: async (title) => {
        assert.ok(title.startsWith(ASK + " "));
        return await session.permission(JSON.parse(title.slice(ASK.length + 1))) ? "allow" : "deny";
      } },
    });
    return result?.block ? { kind: "reject" } : { kind: "approve-once" };
  }
  return { chat, task, interactions, seen, request, session };
}

const harnesses = ["Copilot", "Pi", "OMP"];
const read = {
  copilot: { kind: "read", path },
  pi: { info: native("read"), input: { path } },
  fields: {
    kind: "read", label: "Read file", title: "Approve read?", preview: path,
    remember: ["reads of this path", path], readOnly: true, managed: false, sandboxEscape: false,
  },
};
const request = (ctx, harness, entry) => ctx.request(harness === "Copilot" ? entry.copilot : harness === "OMP" ? entry.omp ?? entry.pi : entry.pi);

test("trusted file reads show equivalent metadata and outcomes", async (t) => {
  for (const harness of harnesses) await t.test(harness, async (t) => {
    const ctx = await fixture(t, harness);
    const pending = request(ctx, harness, read);
    const [card] = ctx.interactions.snapshot();
    try {
      assert.deepEqual(visible(ctx.seen[0]), read.fields);
      assert.equal(card.preview, path);
    } finally {
      if (card) ctx.interactions.respond(card.id, { action: "deny" });
    }
    assert.equal((await pending).kind, "reject");
    ctx.chat.approval = "read";
    assert.equal((await request(ctx, harness, read)).kind, "approve-once");
    assert.equal(ctx.interactions.snapshot().length, 0);
  });
});

test("edits show both sides and remembering does not approve a different path", async (t) => {
  const preview = "-old\n+new\n-second\n+another";
  const edit = {
    copilot: { kind: "write", toolName: "edit", fileName: path, diff: preview },
    pi: { info: native("edit"), input: { path, edits: [{ oldText: "old", newText: "new" }, { oldText: "second", newText: "another" }] } },
  };
  for (const harness of harnesses) await t.test(harness, async (t) => {
    const ctx = await fixture(t, harness, { approval: "read" });
    const pending = request(ctx, harness, edit);
    const [card] = ctx.interactions.snapshot();
    assert.ok(card);
    ctx.interactions.respond(card.id, { action: "remember" });
    assert.equal((await pending).kind, "approve-once");
    assert.deepEqual(visible(ctx.seen[0]), {
      kind: "write", label: path, title: "Approve edit?", preview,
      remember: ["writes to this path", path], readOnly: false, managed: false, sandboxEscape: false,
    });
    assert.equal(card.preview, preview);
    assert.equal((await request(ctx, harness, edit)).kind, "approve-once");
    const changed = request(ctx, harness, {
      copilot: { ...edit.copilot, fileName: path + ".other" },
      pi: { ...edit.pi, input: { ...edit.pi.input, path: path + ".other" } },
    });
    ctx.interactions.respond(ctx.interactions.snapshot()[0].id, { action: "deny" });
    assert.equal((await changed).kind, "reject");
  });
});

const server = "fixture";
const tool = "lookup";
const servers = { [server]: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "fixture-only" } } };
const mcp = (mcpServerName, mcpToolName, readOnly) => {
  const ompName = `mcp__${mcpServerName}_${mcpToolName}`;
  const input = { id: 1 };
  return {
    copilot: { kind: "mcp", serverName: mcpServerName, toolName: mcpToolName, args: input, readOnly },
    pi: {
      info: { name: `mcp__${mcpServerName}__${mcpToolName}`, sourceInfo: { source: "builtin", path: "builtin:mcp" },
        mcpServerName, mcpToolName, annotations: { readOnlyHint: readOnly } },
      input,
    },
    omp: {
      info: { name: ompName, sourceInfo: { source: "mcp", path: `<mcp:${ompName}>` },
        mcpServerName, mcpToolName, mcpReadOnlyHint: readOnly },
      input,
    },
  };
};
const direct = mcp(server, tool, true);

test("authenticated direct MCP reads use explicit read-only metadata, not credentials or names", async (t) => {
  for (const harness of harnesses) await t.test(harness, async (t) => {
    const ctx = await fixture(t, harness, { servers: { ...servers, other: servers[server] } });
    const pending = request(ctx, harness, direct);
    const [card] = ctx.interactions.snapshot();
    ctx.interactions.respond(card.id, { action: "remember" });
    assert.equal((await pending).kind, "approve-once");
    assert.deepEqual(visible(ctx.seen[0]), {
      kind: "mcp", label: "fixture / lookup", title: "Approve lookup?", preview: '{\n  "id": 1\n}',
      remember: ["MCP tool fixture/lookup", server, tool], readOnly: true, managed: false, sandboxEscape: false,
    });
    assert.doesNotMatch(ctx.seen[0].detail, /fixture-only|Authorization/);
    assert.equal((await request(ctx, harness, direct)).kind, "approve-once");
    for (const changed of [mcp(server, "other", true), mcp("other", tool, true)]) {
      const pending = request(ctx, harness, changed);
      const [question] = ctx.interactions.snapshot();
      assert.ok(question, "the grant covers neither a different server nor a different tool");
      ctx.interactions.respond(question.id, { action: "deny" });
      assert.equal((await pending).kind, "reject");
    }
    ctx.chat.approval = "read";
    ctx.chat.approvals = [];
    const allowed = request(ctx, harness, direct);
    const [unexpected] = ctx.interactions.snapshot();
    if (unexpected) ctx.interactions.respond(unexpected.id, { action: "deny" });
    assert.equal((await allowed).kind, "approve-once");
    const unknown = mcp(server, tool, undefined);
    unknown.pi.input = unknown.omp.input = { readOnly: true };
    const unknownPending = request(ctx, harness, unknown);
    const [question] = ctx.interactions.snapshot();
    assert.ok(question);
    ctx.interactions.respond(question.id, { action: "deny" });
    assert.equal((await unknownPending).kind, "reject");
  });
});

test("a managed or escaping request cannot use a remembered grant", async (t) => {
  for (const harness of harnesses) await t.test(harness, async (t) => {
    const ctx = await fixture(t, harness, { approval: "read" });
    ctx.chat.approval = "ask";
    const initial = request(ctx, harness, read);
    ctx.interactions.respond(ctx.interactions.snapshot()[0].id, { action: "remember" });
    assert.equal((await initial).kind, "approve-once");
    ctx.chat.approval = "read";
    for (const [flag, field] of [
      ["managedApprovalRequired", "managed"], ["requestSandboxBypass", "sandboxEscape"],
    ]) {
      const pending = request(ctx, harness, {
        copilot: { ...read.copilot, [flag]: true },
        pi: { ...read.pi, event: { [flag]: true } },
      });
      const [card] = ctx.interactions.snapshot();
      assert.ok(card);
      assert.equal(ctx.seen.at(-1)[field], true);
      assert.equal(card.remember, null);
      ctx.interactions.cancel(ctx.chat.id);
      assert.equal((await pending).kind, "reject");
      assert.equal(ctx.chat.approvals.length, 1);
    }
  });
});

test("assisted delegates to Copilot, while unresolved Pi/OMP calls still ask", async (t) => {
  for (const harness of harnesses) await t.test(harness, async (t) => {
    const ctx = await fixture(t, harness, { approval: "assisted", servers });
    if (harness === "Copilot") assert.equal(ctx.mode, "assisted");
    // Copilot may have settled other calls in the runtime before the adapter receives them.
    const pending = request(ctx, harness, direct);
    const [card] = ctx.interactions.snapshot();
    assert.ok(card);
    ctx.interactions.respond(card.id, { action: "approve" });
    const result = await pending;
    assert.equal(result.kind, "approve-once");
    if (harness === "Copilot") assert.equal(result.approvedInteractively, true);
  });
});

test("unknown or conflicting metadata cannot auto-approve or use a guessed scope", async (t) => {
  for (const harness of harnesses) await t.test(harness, async (t) => {
    const ctx = await fixture(t, harness, { approval: "read", servers });
    const pending = request(ctx, harness, {
      copilot: { ...direct.copilot, serverName: "" },
      pi: { info: { name: direct.pi.info.name }, input: { readOnly: true }, event: { mcpServerName: server, mcpToolName: tool } },
    });
    const [card] = ctx.interactions.snapshot();
    assert.ok(card);
    assert.equal(card.remember, null);
    assert.equal(ctx.seen.at(-1).readOnly, false);
    ctx.interactions.respond(card.id, { action: "deny" });
    assert.equal((await pending).kind, "reject");
  });
});

test("stopping Pi or OMP before the approval reply cannot allow the call", async (t) => {
  for (const harness of ["Pi", "OMP"]) await t.test(harness, async (t) => {
    const ctx = await fixture(t, harness);
    const pending = request(ctx, harness, read);
    await ctx.session.abort();
    ctx.interactions.respond(ctx.interactions.snapshot()[0].id, { action: "approve" });
    assert.equal((await pending).kind, "reject");
  });
});

test("a single-file read grant does not cover a search", async (t) => {
  for (const harness of ["Pi", "OMP"]) await t.test(harness, async (t) => {
    const ctx = await fixture(t, harness);
    const initial = request(ctx, harness, read);
    ctx.interactions.respond(ctx.interactions.snapshot()[0].id, { action: "remember" });
    await initial;
    const pending = ctx.request({ info: native("grep"), input: { path, pattern: "fixture" } });
    const [card] = ctx.interactions.snapshot();
    assert.ok(card);
    assert.equal(card.remember, null);
    ctx.interactions.respond(card.id, { action: "deny" });
    assert.equal((await pending).kind, "reject");
  });
});

test("malformed Copilot file edits do not fall back to a saved single-file grant", async (t) => {
  const ctx = await fixture(t, "Copilot");
  const write = { kind: "write", fileName: path, newFileContents: "text" };
  const initial = ctx.request(write);
  ctx.interactions.respond(ctx.interactions.snapshot()[0].id, { action: "remember" });
  await initial;
  const pending = ctx.request({ ...write, fileEdits: [{ after: { content: "text" } }] });
  const [card] = ctx.interactions.snapshot();
  assert.ok(card);
  assert.equal(card.remember, null);
  ctx.interactions.respond(card.id, { action: "deny" });
  assert.equal((await pending).kind, "reject");
});

test("OMP previews its native hashline patch verbatim and never guesses its scope", async (t) => {
  const ctx = await fixture(t, "OMP", { approval: "read" });
  const input = "[one.txt#A1B2]\nPUT 1.=1:\n+new line\n[two.txt#C3D4]\nMV other.txt";
  const pending = ctx.request({ info: native("edit"), input: { input } });
  const [card] = ctx.interactions.snapshot();
  assert.ok(card);
  ctx.interactions.respond(card.id, { action: "deny" });
  assert.equal((await pending).kind, "reject");
  assert.equal(card.preview, input);
  assert.equal(card.remember, null);
  assert.equal(ctx.seen[0].kind, "write");
});
