// Live runtime verification for #317: compares PiSession.inventory() against real bundled Pi
// and real OMP across connected, 0-tool connected, pending, failed, needs-auth, unavailable,
// unobservable, direct vs indirect exposure, cold and warm reuse, changed access, active turns,
// and slash commands.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolBridge } from "../desktop/providers/toolbridge.mjs";
import { PiProvider, PI_ID, OMP_ID } from "../desktop/providers/pi/index.mjs";

function jsonRpcMcpServer({ tools = [], status = 200, headers = {}, hang = false } = {}) {
  let releaseHang = () => {};
  const hangGate = new Promise((resolve) => { releaseHang = resolve; });
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    if (hang) {
      await hangGate;
      if (!res.writableEnded) { res.writeHead(503); res.end(); }
      return;
    }
    if (status !== 200) {
      res.writeHead(status, { "Content-Type": "text/plain", ...headers });
      res.end("status " + status);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (msg.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    let response;
    if (msg.method === "initialize") {
      response = {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        },
      };
    } else if (msg.method === "tools/list") {
      response = {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: { type: "object", properties: {} },
          })),
        },
      };
    } else {
      response = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        release: () => releaseHang(),
        close: () => {
          releaseHang();
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

function baseInference() {
  return {
    providers: [{
      name: "test-local",
      config: {
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "unused",
        api: "openai-completions",
        models: [{ id: "stub-model", name: "Stub", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 1024 }],
      },
    }],
  };
}

function makeBotkinsTools() {
  return [
    { name: "alpha_note", description: "Read alpha note", parameters: { type: "object", properties: {} }, handler: async () => "ok" },
    { name: "beta_note", description: "Read beta note", parameters: { type: "object", properties: {} }, handler: async () => "ok" },
  ];
}

async function runSuite(runtime) {
  const dir = mkdtempSync(join(tmpdir(), `botkins-inv-live-${runtime}-`));
  const pkgDir = join(dir, "pkg");
  const skillDir = join(dir, "skills", "local-skill");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: local-skill\ndescription: Local skill fixture\n---\nBody\n");
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "live-pkg", pi: { extensions: ["./index.mjs"] } }));
  writeFileSync(join(pkgDir, "index.mjs"), `export default function(pi) {
    pi.registerCommand("live-check", { description: "Live package slash command", handler: async () => {} });
  }`);

  const ok = await jsonRpcMcpServer({ tools: [{ name: "ping", description: "Ping fixture" }] });
  const ok2 = await jsonRpcMcpServer({ tools: [{ name: "pong", description: "Pong fixture" }] });
  const empty = await jsonRpcMcpServer({ tools: [] });
  const fail = await jsonRpcMcpServer({ status: 500 });
  const auth = await jsonRpcMcpServer({ status: 401, headers: { "WWW-Authenticate": 'Bearer realm="test"' } });
  const pend = await jsonRpcMcpServer({ hang: true });

  const bridge = new ToolBridge();
  const provider = new PiProvider({ dataDir: join(dir, "data"), bridge, runtime });
  const status = await provider.status();
  if (!status.installed) {
    console.log(`[${runtime}] skipped (not installed)`);
    await Promise.all([ok.close(), ok2.close(), empty.close(), fail.close(), auth.close(), pend.close()]);
    rmSync(dir, { recursive: true, force: true });
    return { runtime, skipped: true };
  }
  console.log(`[${runtime}] testing against ${status.version}`);

  const makeSpec = (sessionId, mcpServers, tools = makeBotkinsTools(), overrides = {}) => ({
    sessionId,
    folder: dir,
    temporary: false,
    established: false,
    model: { model: "stub-model", source: "test-local", reasoningEffort: "low" },
    inference: baseInference(),
    instructions: "Test session.",
    tools,
    mcpServers,
    skills: { directories: [join(dir, "skills")] },
    ...overrides,
  });

  try {
    // 1. Cold inspection with connected, 0-tool connected, failed, needs-auth, and unsupported/unavailable fixtures.
    const serversA = {
      ok_srv: { type: "http", url: ok.url },
      empty_srv: { type: "http", url: empty.url },
      fail_srv: { type: "http", url: fail.url },
      auth_srv: { type: "http", url: auth.url },
      unavail_srv: runtime === PI_ID ? { type: "sse", url: ok.url } : { type: "http" },
    };
    const origActive = provider.packages.activePaths.bind(provider.packages);
    provider.packages.activePaths = () => [pkgDir];

    const sessionA = await provider.openSession(makeSpec("s-cold-warm", serversA));
    const cold = await sessionA.inventory();
    console.log(`[${runtime}] cold servers:`, cold.servers);
    const byName = (inv) => Object.fromEntries(inv.servers.map((s) => [s.name, s.status]));
    assert.equal(byName(cold).ok_srv, "connected", `${runtime} cold ok_srv`);
    assert.equal(byName(cold).empty_srv, "connected", `${runtime} cold empty_srv (0 tools)`);
    assert.equal(byName(cold).fail_srv, "failed", `${runtime} cold fail_srv`);
    assert.equal(byName(cold).auth_srv, "needs-auth", `${runtime} cold auth_srv`);
    assert.equal(byName(cold).unavail_srv, "unavailable", `${runtime} cold unavail_srv`);

    const pingCold = cold.choices.find((c) => c.kind === "Tool" && c.source === "ok_srv" && c.name === "ping");
    assert.ok(pingCold, `${runtime} cold ok_srv ping tool exposed`);
    assert.ok(pingCold.exposure === (runtime === PI_ID ? "direct" : "indirect"), `${runtime} ping exposure=${pingCold.exposure}`);

    const alphaCold = cold.choices.find((c) => c.kind === "Tool" && c.source === "Botkins" && c.name === "alpha_note");
    assert.ok(alphaCold, `${runtime} cold Botkins alpha_note tool exposed`);
    assert.ok(alphaCold.exposure === (runtime === PI_ID ? "direct" : "indirect"), `${runtime} alpha_note exposure=${alphaCold.exposure}`);

    // No tools from failed/needs-auth/unavailable/empty servers.
    assert.ok(!cold.choices.some((c) => ["fail_srv", "auth_srv", "unavail_srv", "empty_srv"].includes(c.source)), `${runtime} no tools from non-tool/failed servers`);

    // Slash commands preserved: Botkins built-in, skill, and Marketplace package command.
    assert.ok(cold.choices.some((c) => c.command === "help" && c.kind === "Command"), `${runtime} /help preserved`);
    assert.ok(cold.choices.some((c) => c.command === "compact" && c.kind === "Command"), `${runtime} /compact preserved`);
    assert.ok(cold.choices.some((c) => c.command === "local-skill" && c.kind === "Skill"), `${runtime} skill preserved`);
    assert.ok(cold.choices.some((c) => c.command === "live-check" && c.native === true), `${runtime} package slash command preserved`);

    // 2. Warm inspection reuses the running process and preserves exact state.
    const liveBeforeWarm = sessionA.live;
    const warm = await sessionA.inventory();
    assert.equal(sessionA.live, liveBeforeWarm, `${runtime} warm inventory reuses live process`);
    assert.deepEqual(warm.servers, cold.servers, `${runtime} warm servers match cold`);

    // 3. Changed access: remove ok_srv, add ok2_srv; never present stale tools as callable.
    sessionA.spec = makeSpec("s-cold-warm", { ok2_srv: { type: "http", url: ok2.url } }, [makeBotkinsTools()[0]]);
    const changed = await sessionA.inventory();
    console.log(`[${runtime}] changed access servers:`, changed.servers);
    assert.ok(!changed.servers.some((s) => s.name === "ok_srv"), `${runtime} removed ok_srv absent`);
    assert.ok(!changed.choices.some((c) => c.source === "ok_srv" || c.name === "ping"), `${runtime} stale ping tool absent`);
    assert.ok(!changed.choices.some((c) => c.source === "Botkins" && c.name === "beta_note"), `${runtime} removed Botkins tool absent`);
    if (runtime === OMP_ID) {
      assert.equal(byName(changed).ok2_srv, "connected", "omp restarted cleanly for new server");
      assert.ok(changed.choices.some((c) => c.source === "ok2_srv" && c.name === "pong"), "omp new server tool visible");
    } else {
      assert.equal(byName(changed).ok2_srv, "configured", "warm pi reports newly added unregistered server as configured");
      assert.ok(!changed.choices.some((c) => c.source === "ok2_srv"), "warm pi does not claim unregistered server tools are callable");
    }
    await assert.rejects(() => sessionA.resolvePrompt("/tool:ping", {}, {}, {}), /unavailable/i);

    // 4. Active turn must NEVER restart the process even when packages/servers change.
    const liveDuringTurn = sessionA.live;
    sessionA.turn = { text: "", parts: [], calls: new Map(), rows: new Map() };
    provider.packages.activePaths = () => [];
    const duringTurn = await sessionA.inventory();
    assert.equal(sessionA.live, liveDuringTurn, `${runtime} active turn does not restart process`);
    assert.ok(!liveDuringTurn.rpc.closed, `${runtime} active turn process remains open`);
    if (runtime === OMP_ID) {
      // On OMP during an active turn, an unprobed 0-tool server cannot be probed safely and reports unobservable, distinct from unavailable.
      sessionA.spec = makeSpec("s-cold-warm", {
        ghost_srv: { type: "http", url: empty.url },
        unavail_srv: { type: "http" },
      });
      const activeStates = Object.fromEntries((await sessionA.inventory()).servers.map((s) => [s.name, s.status]));
      assert.equal(activeStates.unavail_srv, "unavailable", "omp active turn distinguishes unavailable");
      assert.equal(activeStates.ghost_srv, "unobservable", "omp active turn distinguishes unobservable");
      assert.equal(sessionA.live, liveDuringTurn, "omp active turn still did not restart");
    }
    sessionA.turn = null;
    provider.packages.activePaths = origActive;
    await sessionA.close({ discard: true });

    // 5. Pending fixture (cold): hanging MCP server reports "pending" and never exposes tools.
    const sessionP = await provider.openSession(makeSpec("s-pending", {
      ok_srv: { type: "http", url: ok.url },
      pend_srv: { type: "http", url: pend.url },
    }));
    const pendingInv = await sessionP.inventory();
    console.log(`[${runtime}] pending fixture servers:`, pendingInv.servers);
    assert.equal(byName(pendingInv).ok_srv, "connected", `${runtime} ok_srv connected alongside pending`);
    assert.equal(byName(pendingInv).pend_srv, "pending", `${runtime} pend_srv reported as pending`);
    assert.ok(!pendingInv.choices.some((c) => c.source === "pend_srv"), `${runtime} pending server exposes no tools`);
    await sessionP.close({ discard: true });

    console.log(`[${runtime}] ALL LIVE CHECKS PASSED`);
    return { runtime, passed: true };
  } finally {
    await provider.stop();
    await bridge.stop?.().catch?.(() => {});
    await Promise.all([ok.close(), ok2.close(), empty.close(), fail.close(), auth.close(), pend.close()]);
    rmSync(dir, { recursive: true, force: true });
  }
}

await runSuite(PI_ID);
await runSuite(OMP_ID);
process.exit(0);
