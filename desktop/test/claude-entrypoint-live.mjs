// Isolated release check. Give the path to an installed Claude Code executable.
// Both clients make one request to a loopback fixture using a synthetic API key.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.argv[2];
if (!binary) throw new Error("Pass the absolute path to Claude Code.");
if (process.argv[3] !== "--fixture") {
  const home = mkdtempSync(join(tmpdir(), "botkins-claude-label-"));
  try {
    const env = {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, "config"),
      PATH: [dirname(binary), dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    };
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), binary, "--fixture"], {
      env,
      stdio: "inherit",
      timeout: 60000,
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
} else {
  const { ClaudeProvider } = await import("../desktop/providers/claude/index.mjs");
  const { claudeTurn } = await import("../desktop/harness/claude.mjs");
  const { ToolBridge } = await import("../desktop/providers/toolbridge.mjs");
  const requests = [];
  let route = "direct";
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.url.split("?")[0] === "/v1/messages") {
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push({ route, agent: req.headers["user-agent"], system: JSON.stringify(body.system) });
    }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Local fixture received request" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:" + server.address().port;
  process.env.ANTHROPIC_API_KEY = "synthetic-local-test-key";
  const bridge = new ToolBridge();
  try {
    const provider = new ClaudeProvider({ binary, bridge });
    const { query } = await provider.sdk();
    const options = {
      cwd: process.env.HOME,
      env: await provider.env(),
      pathToClaudeCodeExecutable: binary,
      settingSources: [],
      maxTurns: 1,
      model: "sonnet",
      tools: [],
      persistSession: false,
    };
    try {
      for await (const event of query({ prompt: "Botkins fixture", options })) {
      }
    } catch {}
    route = "plan";
    try {
      await claudeTurn(
        { model: "sonnet", messages: [{ role: "user", content: "Botkins fixture" }], tools: [] },
        {
          file: binary,
          env: process.env,
          cwd: process.env.HOME,
          bridge,
          emit() {},
          idleMs: 10000,
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {}
    for (const path of ["direct", "plan"]) {
      const matching = requests.filter((req) => req.route === path);
      assert.ok(matching.length, "No model request for the " + path + " route");
      for (const req of matching) {
        assert.match(req.agent, /\bbotkins\b/i, path + " User-Agent");
        assert.ok(!/\bsdk-(?:cli|ts)\b/.test(req.agent), path + " used a generic SDK entrypoint");
      }
      console.log(path + " User-Agent: " + matching[0].agent);
    }
  } finally {
    await bridge.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
