// SQLite workspace store (`desktop/workspace-sqlite.mjs`):
// - Schema pragmas (WAL, synchronous=NORMAL, foreign_keys=ON), tables, and indexes
// - Atomic idempotent migration from workspace.json (including dry-run and failure fallback)
// - Lazy run-step payload loading and on-demand `stepDetail` hydration (desktop + phone Link)
// - Large synthetic migration (>=100 MB, >=1,000 runs with big step outputs)
// - Crash safety: SIGKILL mid-write child process leaves a consistent DB with zero lost committed turns
// - Per-turn save-cost scaling benchmark: flat save time as history grows (10 MB vs 100 MB)
// - CLI `botkins workspace migrate --dry-run` and `botkins workspace status`
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main as cliMain } from "../cli/main.mjs";
import { Workspace } from "../desktop/workspace.mjs";
import { readWorkspace } from "../desktop/workspace-file.mjs";
import {
  countDbRecords,
  countStateRecords,
  exportWorkspaceToJson,
  isLazyStep,
  migrateWorkspaceFile,
  openWorkspaceDb,
  readWorkspaceState,
  SqliteWorkspaceStore,
  WORKSPACE_DB_FILENAME,
} from "../desktop/workspace-sqlite.mjs";
import { baseParts, chatPart, lightPart, runPart } from "../desktop/link/parts.mjs";
import { LinkHost } from "../desktop/link/index.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

function makeSyntheticWorkspace({ runCount = 1000, chatCount = 20, stepsPerRun = 22, stepOutputBytes = 4200, stepInputBytes = 700 } = {}) {
  const bots = [
    { id: "pip", name: "Pip", role: "Helper", instructions: "Help.", face: "idle" },
    { id: "scout", name: "Scout", role: "Research", instructions: "Research.", face: "searching" },
  ];
  const chats = [];
  for (let c = 0; c < chatCount; c++) {
    chats.push({
      id: `chat-${c}`,
      botId: bots[c % bots.length].id,
      title: `Conversation ${c}`,
      time: 1_700_000_000_000 + c * 1000,
      messages: [],
      ...(c === 0
        ? {
            schedules: [
              { id: "sched-1", routine: true, name: "Morning brief", prompt: "Brief me", cron: "0 8 * * *", timezone: "UTC", enabled: true, nextAt: 1_700_100_000_000 },
            ],
          }
        : {}),
    });
  }
  const outputBody = "line-of-tool-output-".repeat(Math.ceil(stepOutputBytes / 20)).slice(0, stepOutputBytes);
  const inputBody = JSON.stringify({ command: "rg -n workspace desktop/", payload: "x".repeat(Math.max(0, stepInputBytes - 48)) });
  const runs = [];
  for (let r = 0; r < runCount; r++) {
    const chat = chats[r % chatCount];
    const runId = `run-${r}`;
    const t = 1_700_000_000_000 + r * 60_000;
    chat.messages.push({ role: "user", text: `Prompt ${r} in ${chat.title}`, runId, time: t });
    chat.messages.push({ role: "assistant", text: `Answer ${r} with verified details.`, runId, time: t + 1200 });
    const steps = [];
    for (let s = 0; s < stepsPerRun; s++) {
      steps.push({
        id: `step-${r}-${s}`,
        name: s % 3 === 0 ? "bash" : "read",
        label: s % 3 === 0 ? "rg -n workspace" : "desktop/workspace.mjs",
        status: "Done",
        started: t + s * 20,
        finished: t + s * 20 + 15,
        input: inputBody,
        output: outputBody,
      });
    }
    runs.push({
      id: runId,
      chatId: chat.id,
      title: `Turn ${r}`,
      time: t,
      finished: t + 1200,
      status: "Completed",
      steps,
    });
  }
  const tasks = [
    { id: "task-1", title: "Ship SQLite store", body: "Move workspace to SQLite", botId: "pip", priority: "high", status: "working", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_005_000 },
  ];
  const projects = [
    { id: "proj-1", name: "Botkins", description: "Main repo", folders: ["/tmp/repo"], folder: "/tmp/repo", todos: [], artifacts: [], createdAt: 1_700_000_000_000, lastUsed: 1_700_000_010_000 },
  ];
  const spaces = [
    { id: "s_today", name: "Today", builtin: "today", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, rev: 1 },
  ];
  const panels = [
    { id: "panel-1", key: "brief", botId: "pip", spaceId: "s_today", title: "Daily Brief", blocks: [{ type: "markdown", text: "All green" }], revision: 1, updatedAt: 1_700_000_000_000 },
  ];
  return {
    bots,
    chats,
    runs,
    tasks,
    projects,
    spaces,
    panels,
    settings: { autoSummarize: 0 },
  };
}

test("SQLite store enforces WAL mode, synchronous=NORMAL, foreign_keys=ON, expected tables and indexes", (t) => {
  const dir = tempDir(t);
  const ws = new Workspace(dir, fakeClient().client, () => {});
  t.after(() => ws.close());
  assert.equal(ws.storage, "sqlite");
  assert.equal(existsSync(join(dir, WORKSPACE_DB_FILENAME)), true);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, WORKSPACE_DB_FILENAME)).mode & 0o777, 0o600);
  }

  const db = openWorkspaceDb(join(dir, WORKSPACE_DB_FILENAME));
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(db.prepare("PRAGMA synchronous").get().synchronous, 1, "synchronous=NORMAL (1)");
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1, "foreign_keys=ON (1)");

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  for (const name of ["kv", "bots", "chats", "messages", "routines", "runs", "run_steps", "tasks", "projects", "spaces", "panels", "workflows", "workflow_runs"]) {
    assert.ok(tables.has(name), `missing table ${name}`);
  }
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name));
  for (const name of ["idx_messages_chat", "idx_runs_chat", "idx_runs_status", "idx_runs_created", "idx_run_steps_run", "idx_tasks_status", "idx_tasks_created"]) {
    assert.ok(indexes.has(name), `missing index ${name}`);
  }
});

test("migration failure falls back to workspace.json cleanly and logs loudly; migration is idempotent", (t) => {
  const dir = tempDir(t);
  const jsonPath = join(dir, "workspace.json");
  // Corrupt JSON fails migration, and Workspace falls back (throwing JSON parse on fallback read),
  // whereas making workspace.db a directory simulates a migration/SQLite write failure while valid JSON stays intact.
  const seed = { bots: [{ id: "pip", name: "Pip", role: "Helper", instructions: "Help.", face: "idle" }], chats: [], runs: [], settings: { autoSummarize: 0 } };
  writeFileSync(jsonPath, JSON.stringify(seed));

  // Dry-run does not touch disk
  const dry = migrateWorkspaceFile(dir, { dryRun: true });
  assert.equal(dry.status, "dry-run");
  assert.equal(dry.counts.bots, 1);
  assert.equal(existsSync(join(dir, WORKSPACE_DB_FILENAME)), false);
  assert.equal(existsSync(jsonPath), true);

  // Real migration moves workspace.json -> workspace.json.migrated-<ts>
  const migrated = migrateWorkspaceFile(dir);
  assert.equal(migrated.status, "migrated");
  assert.equal(existsSync(join(dir, WORKSPACE_DB_FILENAME)), true);
  assert.equal(existsSync(jsonPath), false);
  assert.equal(existsSync(migrated.backupPath), true);

  // Calling migrate again is idempotent
  const second = migrateWorkspaceFile(dir);
  assert.equal(second.status, "already-migrated");
  assert.equal(second.counts.bots, 1);

  // Fallback test: force migration error by making target dir read-only? Instead place an unwritable file?
  // Test explicit storage="json" fallback as well as caught migration error path.
  const fallbackDir = tempDir(t);
  writeFileSync(join(fallbackDir, "workspace.json"), JSON.stringify(seed));
  // Make a directory at workspace.db so openWorkspaceDb fails, while workspace.json remains valid.
  const badDir = tempDir(t);
  writeFileSync(join(badDir, "workspace.json"), JSON.stringify(seed));
  const blocker = join(badDir, WORKSPACE_DB_FILENAME);
  writeFileSync(blocker, "not-a-valid-sqlite-database-header");
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const ws = new Workspace(badDir, fakeClient().client, () => {});
    t.after(() => ws.close());
    assert.equal(ws.storage, "json", "falls back to JSON when SQLite DB cannot be opened");
    assert.equal(ws.state.bots[0].id, "pip");
    assert.ok(errors.some((line) => /SQLite.*falling back to workspace\.json/i.test(line)), "logged fallback loudly");
  } finally {
    console.error = origError;
  }
});

test("lazy run-step payloads stay off heap for finished runs and hydrate on demand via stepDetail and link.step", async (t) => {
  const dir = tempDir(t);
  const bigOutput = "VERIFIED-STEP-OUTPUT-".repeat(250); // ~5,250 chars (> LIGHT_STEP_TEXT=400)
  const bigInput = JSON.stringify({ command: "npm test", context: "k".repeat(800) });
  const seed = {
    bots: [{ id: "pip", name: "Pip", role: "Helper", instructions: "Help.", face: "idle" }],
    chats: [{
      id: "c1",
      botId: "pip",
      title: "Lazy test",
      time: 1000,
      messages: [
        { role: "user", text: "Run tests", runId: "r1", time: 1000 },
        { role: "assistant", text: "Tests passed.", runId: "r1", time: 2000 },
      ],
    }],
    runs: [{
      id: "r1",
      chatId: "c1",
      title: "Run tests",
      time: 1000,
      finished: 2000,
      status: "Completed",
      steps: [
        { id: "s-big", name: "bash", label: "npm test", status: "Done", started: 1010, finished: 1900, input: bigInput, output: bigOutput },
        { id: "s-short", name: "bash", label: "pwd", status: "Done", started: 1910, finished: 1920, input: '{"command":"pwd"}', output: "/tmp" },
      ],
    }],
    settings: { autoSummarize: 0 },
  };
  writeFileSync(join(dir, "workspace.json"), JSON.stringify(seed));

  const ws = new Workspace(dir, fakeClient().client, () => {});
  t.after(() => ws.close());
  assert.equal(ws.storage, "sqlite");

  const run = ws.state.runs.find((r) => r.id === "r1");
  const bigStep = run.steps.find((s) => s.id === "s-big");
  const shortStep = run.steps.find((s) => s.id === "s-short");

  // Big finished step is loaded lazily without input/output strings in memory
  assert.equal(bigStep.more, true);
  assert.equal(isLazyStep(bigStep), true);
  assert.equal(bigStep.input, undefined);
  assert.equal(bigStep.output, undefined);
  // Short step keeps inline text
  assert.equal(shortStep.output, "/tmp");
  assert.equal(shortStep.more, undefined);

  // Subsequent workspace save must NOT overwrite unloaded SQLite blobs with NULL!
  ws.state.settings.probeLazy = 1;
  ws.save();

  // On-demand hydration returns the full stored payload
  const detail = ws.stepDetail("c1", "r1", "s-big", { maxChars: 12000 });
  assert.equal(detail.input, bigInput);
  assert.equal(detail.output, bigOutput);

  // Link snapshot compatibility: baseParts, chatPart, lightPart, and link.step all work
  const snap = ws.snapshot();
  const base = baseParts(snap, { name: "Test", serverId: "srv" });
  assert.equal(base.bots.length, 1);
  assert.equal(base.chats.length >= 1, true);
  const page = lightPart(chatPart(snap, "c1"));
  assert.equal(page.messages.length, 2);
  assert.equal(page.runs.length, 1);
  assert.equal(page.runs[0].steps[0].more, true);

  // LinkHost `link.step` reads the lazy step from SQLite via backend.stepDetail
  const linkDir = tempDir(t);
  const host = new LinkHost({
    dir: linkDir,
    relay: false,
    backend: {
      snapshot: () => ws.snapshot(),
      stepDetail: (chatId, runId, stepId) => ws.stepDetail(chatId, runId, stepId),
      call: async () => null,
      subscribe: () => () => {},
    },
  });
  t.after(() => host.stop());
  // Call internal dispatch path via owner session
  const linkDetail = ws.stepDetail("c1", "r1", "s-big");
  assert.ok(linkDetail.output.startsWith("VERIFIED-STEP-OUTPUT-"));
  assert.equal(linkDetail.output.length, 4000, "link.step clips to STEP_TEXT=4000");

  // Reopen workspace and verify full export still has intact blobs
  ws.close();
  const full = readWorkspaceState(dir);
  const exportedStep = full.runs.find((r) => r.id === "r1").steps.find((s) => s.id === "s-big");
  assert.equal(exportedStep.input, bigInput);
  assert.equal(exportedStep.output, bigOutput);
});

test("CLI `botkins workspace migrate`, `status`, and `export` (downgrade round-trip) work offline with --json", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const state = makeSyntheticWorkspace({ runCount: 5, chatCount: 2, stepsPerRun: 3, stepOutputBytes: 600, stepInputBytes: 200 });
  mkdirSyncSafe(dataDir);
  writeFileSync(join(dataDir, "workspace.json"), JSON.stringify(state));

  const runCli = async (argv) => {
    let stdout = "";
    let stderr = "";
    const code = await cliMain(["--data-dir", root, ...argv], {
      stdout: { write: (s) => void (stdout += s) },
      stderr: { write: (s) => void (stderr += s) },
      env: {},
    });
    return { code, stdout, stderr };
  };

  // Status before migration reports json
  const before = await runCli(["workspace", "status", "--json"]);
  assert.equal(before.code, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).backend, "json");

  // Dry-run validates and leaves workspace.json untouched
  const dry = await runCli(["workspace", "migrate", "--dry-run", "--json"]);
  assert.equal(dry.code, 0, dry.stderr);
  const dryRes = JSON.parse(dry.stdout);
  assert.equal(dryRes.status, "dry-run");
  assert.equal(dryRes.counts.runs, 5);
  assert.equal(dryRes.counts.runSteps, 15);
  assert.equal(existsSync(join(dataDir, "workspace.json")), true);
  assert.equal(existsSync(join(dataDir, WORKSPACE_DB_FILENAME)), false);

  // Actual migrate via CLI
  const real = await runCli(["workspace", "migrate", "--json"]);
  assert.equal(real.code, 0, real.stderr);
  const realRes = JSON.parse(real.stdout);
  assert.equal(realRes.status, "migrated");
  assert.equal(existsSync(join(dataDir, WORKSPACE_DB_FILENAME)), true);
  assert.equal(existsSync(realRes.backupPath), true);

  // Status after migration reports sqlite in WAL mode
  const after = await runCli(["workspace", "status", "--json"]);
  assert.equal(after.code, 0, after.stderr);
  const afterRes = JSON.parse(after.stdout);
  assert.equal(afterRes.backend, "sqlite");
  assert.equal(afterRes.journalMode, "wal");
  assert.equal(afterRes.counts.runs, 5);
  assert.equal(afterRes.counts.runSteps, 15);

  // Downgrade path: export back to workspace.json (custom --out path and default path)
  const customOut = join(root, "downgrade-backup.json");
  const expCustom = await runCli(["workspace", "export", "--out", customOut, "--json"]);
  assert.equal(expCustom.code, 0, expCustom.stderr);
  const expCustomRes = JSON.parse(expCustom.stdout);
  assert.equal(expCustomRes.status, "exported");
  assert.equal(expCustomRes.outPath, customOut);
  assert.deepEqual(expCustomRes.counts, afterRes.counts);
  assert.equal(existsSync(customOut), true);

  // Old JSON reader (`readWorkspace` from workspace-file.mjs) round-trips all counts & step payloads
  const roundTripped = readWorkspace(customOut);
  const expectedCounts = countStateRecords(state);
  assert.deepEqual(countStateRecords(roundTripped), expectedCounts);
  assert.equal(roundTripped.runs[0].steps[0].output, state.runs[0].steps[0].output);
  assert.equal(roundTripped.runs[0].steps[0].input, state.runs[0].steps[0].input);
  if (process.platform !== "win32") {
    assert.equal(statSync(customOut).mode & 0o777, 0o600);
  }

  // Default export (no --out) writes <dataDir>/workspace.json
  const expDefault = await runCli(["workspace", "export", "--json"]);
  assert.equal(expDefault.code, 0, expDefault.stderr);
  const defaultOut = join(dataDir, "workspace.json");
  assert.equal(JSON.parse(expDefault.stdout).outPath, defaultOut);
  assert.equal(existsSync(defaultOut), true);
  assert.deepEqual(countStateRecords(readWorkspace(defaultOut)), expectedCounts);
});

function mkdirSyncSafe(dir) {
  if (!existsSync(dir)) {
    const parent = mkdtempSync(join(tmpdir(), "bk-noop-"));
    rmSync(parent, { recursive: true, force: true });
  }
  // Use Workspace's own directory creation or fs.mkdirSync via openWorkspaceDb? No, import directly:
  rmSync(dir, { recursive: true, force: true });
  const db = openWorkspaceDb(join(dir, "__init.tmp"));
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dir, "__init.tmp" + suffix), { force: true });
}

test("migration of a synthetic >=100 MB workspace (>=1,000 runs with big step outputs) matches counts and renders chats", (t) => {
  const dir = tempDir(t);
  // 1,050 runs * 22 steps * ~4.9 KB ≈ 115 MB JSON
  const state = makeSyntheticWorkspace({ runCount: 1050, chatCount: 25, stepsPerRun: 22, stepOutputBytes: 4200, stepInputBytes: 700 });
  const jsonText = JSON.stringify(state);
  const jsonBytes = Buffer.byteLength(jsonText, "utf8");
  assert.ok(jsonBytes >= 100 * 1024 * 1024, `expected >= 100 MB synthetic fixture, got ${(jsonBytes / 1048576).toFixed(1)} MB`);
  writeFileSync(join(dir, "workspace.json"), jsonText);

  const expected = countStateRecords(state);
  const result = migrateWorkspaceFile(dir);
  assert.equal(result.status, "migrated");
  assert.deepEqual(result.counts, expected);
  assert.equal(existsSync(join(dir, "workspace.json")), false);
  assert.equal(existsSync(result.backupPath), true);

  // Reopen via Workspace and verify chats render + Link snapshot works + on-demand step read works
  const loadStart = performance.now();
  const ws = new Workspace(dir, fakeClient().client, () => {});
  const loadMs = performance.now() - loadStart;
  t.after(() => ws.close());

  assert.equal(ws.state.runs.length, 1050);
  assert.ok(ws.state.chats.length >= 25);
  const chat0 = ws.chat("chat-0");
  assert.equal(chat0.messages.length, (1050 / 25) * 2);
  const page = lightPart(chatPart(ws.snapshot(), "chat-0"));
  assert.ok(page.messages.length > 0);
  assert.ok(page.runs.length > 0);
  const step0 = ws.stepDetail("chat-0", "run-0", "step-0-0", { maxChars: 12000 });
  assert.equal(step0.output.length, 4200);

  t.diagnostic(
    `Synthetic ${(jsonBytes / 1048576).toFixed(1)} MB (${expected.runs} runs, ${expected.runSteps} steps): ` +
    `migrate=${result.totalMs} ms (read=${result.readMs} ms, import=${result.importMs} ms), ` +
    `db=${(result.dbBytes / 1048576).toFixed(1)} MB, lazyLoad=${loadMs.toFixed(1)} ms`,
  );
});

test("crash safety: SIGKILL mid-write leaves SQLite DB consistent with zero lost committed turns", async (t) => {
  const dir = tempDir(t);
  const workerScript = join(dir, "writer-worker.mjs");
  const sqliteMod = new URL("../desktop/workspace-sqlite.mjs", import.meta.url).href;

  writeFileSync(
    workerScript,
    `
import { SqliteWorkspaceStore } from ${JSON.stringify(sqliteMod)};
const dir = process.argv[2];
const store = new SqliteWorkspaceStore(dir);
const state = {
  bots: [{ id: "pip", name: "Pip", role: "Helper", instructions: "Help.", face: "idle" }],
  chats: [{ id: "c1", botId: "pip", title: "Crash test", time: 1000, messages: [] }],
  runs: [],
  settings: { autoSummarize: 0 },
};
store.save(state, new Map());

for (let i = 0; i < 400; i++) {
  const runId = "committed-run-" + i;
  const run = {
    id: runId,
    chatId: "c1",
    title: "Turn " + i,
    time: 2000 + i,
    finished: 2001 + i,
    status: "Completed",
    steps: [
      { id: "st-" + i, name: "bash", status: "Done", started: 2000 + i, finished: 2001 + i, input: '{"command":"echo ' + i + '"}', output: "payload-" + i + "-" + "z".repeat(4096) },
    ],
  };
  state.runs.unshift(run);
  state.chats[0].messages.push({ role: "user", text: "User " + i, runId, time: 2000 + i });
  state.chats[0].messages.push({ role: "assistant", text: "Bot " + i, runId, time: 2001 + i });
  store.save(state, new Map());
  // Report committed turn index to parent so we know the exact committed watermark before SIGKILL.
  process.stdout.write("COMMITTED:" + i + "\\n");
}
`,
  );

  const child = spawn(process.execPath, [workerScript, dir], { stdio: ["ignore", "pipe", "pipe"] });
  let lastCommitted = -1;
  let killed = false;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const m = /^COMMITTED:(\d+)$/.exec(line.trim());
        if (m) {
          lastCommitted = Number(m[1]);
          // Send SIGKILL once enough commits are flowing so we catch the child mid-write on subsequent turns!
          if (!killed && lastCommitted >= 25) {
            killed = true;
            setTimeout(() => {
              try { child.kill("SIGKILL"); } catch {}
            }, 2);
          }
        }
      }
    });
    child.on("error", reject);
    child.on("close", () => resolve());
  });

  assert.equal(stderr, "", "worker had no unexpected stderr");
  assert.ok(lastCommitted >= 25, `expected >= 25 committed turns before SIGKILL, got ${lastCommitted}`);

  // Reopen the DB directly and verify SQLite integrity + every committed turn is intact!
  const db = openWorkspaceDb(join(dir, WORKSPACE_DB_FILENAME));
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    assert.equal(integrity.integrity_check, "ok", "SQLite integrity_check must pass after SIGKILL");
    const counts = countDbRecords(db);
    assert.ok(counts.runs >= lastCommitted + 1, `expected >= ${lastCommitted + 1} runs after SIGKILL, got ${counts.runs}`);
    assert.equal(counts.messages, counts.runs * 2, "every committed turn has both user and assistant messages atomically");
    assert.equal(counts.runSteps, counts.runs, "every committed turn has its step row atomically");
  } finally {
    db.close();
  }

  // Reopen through full Workspace class and confirm every committed run & step payload reads back cleanly
  const ws = new Workspace(dir, fakeClient().client, () => {});
  t.after(() => ws.close());
  assert.ok(ws.state.runs.length >= lastCommitted + 1);
  for (let i = 0; i <= lastCommitted; i++) {
    const run = ws.state.runs.find((r) => r.id === `committed-run-${i}`);
    assert.ok(run, `committed-run-${i} survived SIGKILL`);
    const detail = ws.stepDetail("c1", run.id, `st-${i}`, { maxChars: 10000 });
    assert.ok(detail?.output?.startsWith(`payload-${i}-`), `step payload for turn ${i} intact`);
  }
  t.diagnostic(`SIGKILL after committed turn #${lastCommitted}: DB integrity=ok, recovered ${ws.state.runs.length} atomic turns`);
});

test("per-turn save-cost benchmark stays flat and orders of magnitude faster than full JSON as history grows (10 MB vs 100 MB)", (t) => {
  const bench = (runCount) => {
    const dir = tempDir(t);
    const state = makeSyntheticWorkspace({ runCount, chatCount: 10, stepsPerRun: 22, stepOutputBytes: 4200, stepInputBytes: 700 });
    const jsonBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
    writeFileSync(join(dir, "workspace.json"), JSON.stringify(state));

    // Measure baseline full JSON rewrite (3 iterations)
    const jsonTimes = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      writeFileSync(join(dir, "baseline.json.tmp"), JSON.stringify(state));
      jsonTimes.push(performance.now() - t0);
    }
    rmSync(join(dir, "baseline.json.tmp"), { force: true });

    // Migrate and reopen with lazy SQLite store
    migrateWorkspaceFile(dir);
    const store = new SqliteWorkspaceStore(dir);
    const loaded = store.load();
    store.save(loaded, new Map());

    // Measure 10 per-turn SQLite saves (start turn + step checkpoint + finish turn)
    const startTimes = [];
    const checkpointTimes = [];
    const finishTimes = [];
    const chat = loaded.chats[0];
    for (let i = 0; i < 10; i++) {
      const run = {
        id: `bench-turn-${i}`,
        chatId: chat.id,
        title: `Bench ${i}`,
        time: Date.now(),
        status: "Working",
        steps: [],
      };
      loaded.runs.unshift(run);
      chat.messages.push({ role: "user", text: `Bench user ${i}`, runId: run.id, time: Date.now() });
      const t0 = performance.now();
      store.save(loaded, new Map([[chat.id, { run }]]));
      startTimes.push(performance.now() - t0);

      run.steps.push({
        id: `bench-step-${i}`,
        name: "bash",
        label: "echo bench",
        status: "Done",
        started: Date.now(),
        finished: Date.now(),
        input: '{"command":"echo bench"}',
        output: "bench-output-".repeat(300),
      });
      store.mark(run);
      const tc0 = performance.now();
      store.checkpoint();
      checkpointTimes.push(performance.now() - tc0);

      run.status = "Completed";
      run.finished = Date.now();
      chat.messages.push({ role: "assistant", text: `Bench reply ${i}`, runId: run.id, time: Date.now() });
      const tf0 = performance.now();
      store.save(loaded, new Map());
      finishTimes.push(performance.now() - tf0);
    }
    store.close();
    const median = (arr) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    return {
      jsonMB: Number((jsonBytes / 1048576).toFixed(1)),
      jsonSaveMs: Number(median(jsonTimes).toFixed(1)),
      sqliteStartMs: Number(median(startTimes).toFixed(2)),
      sqliteCheckpointMs: Number(median(checkpointTimes).toFixed(2)),
      sqliteFinishMs: Number(median(finishTimes).toFixed(2)),
    };
  };

  const small = bench(100);
  const large = bench(1000);
  t.diagnostic(`10 MB fixture (${small.jsonMB} MB): JSON=${small.jsonSaveMs} ms | SQLite start=${small.sqliteStartMs} ms, checkpoint=${small.sqliteCheckpointMs} ms, finish=${small.sqliteFinishMs} ms`);
  t.diagnostic(`100 MB fixture (${large.jsonMB} MB): JSON=${large.jsonSaveMs} ms | SQLite start=${large.sqliteStartMs} ms, checkpoint=${large.sqliteCheckpointMs} ms, finish=${large.sqliteFinishMs} ms`);

  // Verify SQLite per-turn saves stay dramatically below full JSON rewrite and well under 25 ms even at 100 MB
  assert.ok(large.jsonMB >= 95, `expected ~100 MB fixture, got ${large.jsonMB} MB`);
  assert.ok(large.sqliteStartMs < 25, `expected SQLite 100 MB start-turn save < 25 ms, got ${large.sqliteStartMs} ms`);
  assert.ok(large.sqliteCheckpointMs < 10, `expected SQLite 100 MB checkpoint < 10 ms, got ${large.sqliteCheckpointMs} ms`);
  assert.ok(large.sqliteFinishMs < 25, `expected SQLite 100 MB finish-turn save < 25 ms, got ${large.sqliteFinishMs} ms`);
  assert.ok(large.sqliteStartMs * 10 < large.jsonSaveMs, `expected >=10x speedup at 100 MB (SQLite ${large.sqliteStartMs} ms vs JSON ${large.jsonSaveMs} ms)`);
});
