// A check with the real SDK runtime: the secure request chain. A bot asks for a secret with the app's own two
// tools (`request_secure_input` and `use_secure_input`), the person gives it on the card, and the value goes to its
// place of use and never to the model.
//
// Run with:
//   node test/secure-request-live.mjs
//
// It ends with 0 only when every condition holds, and its last line is `PASSED` or `FAILED: <cases>`.
// It is part of `npm run test:runtime`, not of `npm test`: it starts the real runtime. It needs no account, no
// token and no network (the model is this script, on 127.0.0.1), and it writes only below the system's temporary
// folder, which it removes at the end.
//
// The outer process creates a clean HOME/COPILOT_HOME; the isolated child starts the REAL Copilot runtime against a
// local OpenAI-compatible endpoint that this script serves. The "model" is a script. The two tools are the app's own
// (`SecureInputs.tools()` of desktop/secure-input.mjs, given to the session as `tools`, as the workspace does), made
// on the smallest real pieces they need: the app's own `Interactions` (the card), and a `SecureInputs` whose place
// of use is the real `performSecureUse` with a recording stand-in for the network. This script answers the card as
// the person, with made-up values that are not real secrets. The session options come from Botkins' own sessionOptions().
//
// Cases (each is a separate real session, in one chat each):
//   A  the model calls request_secure_input; the person fills the card; the model calls use_secure_input with the
//      handles that it got
//   B  the model calls request_secure_input only (the handles stay open)
//   C  another chat and turn: the model calls use_secure_input with the handles of case B
//
// What must hold (each is a line of the last part of the output, and a case of the last line):
//   1  the runtime offered the two tools to the model, and the handlers of both ran
//   2  the person's card was raised, of the kind "secure", with the fields that the bot asked for
//   3  the values reached the place of use, as the operation that the person approved (a POST of the form), once
//   4  the values are in NO request that reached the model endpoint, and in no file below the temporary HOME or
//      this run's own folders (the search itself is shown to find a value that is planted)
//   5  the model got handles only (a handle for each field), then `{"applied":true}`, and nothing else
//   6  a handle of another chat and turn is refused, and the place of use is not reached
//
// The temporary folders are made in the system's own temporary folder (TMPDIR, else os.tmpdir()).
//
// Environment: BOTKINS_PROBE_LIMIT_MS (whole run, default 300000), BOTKINS_PROBE_CASE_MS (one session,
// default 90000), BOTKINS_PROBE_DEBUG=1 (print what the handlers and the model saw).
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const LIMIT_MS = Number(process.env.BOTKINS_PROBE_LIMIT_MS) || 300_000;
const CASE_MS = Number(process.env.BOTKINS_PROBE_CASE_MS) || 90_000;

if (process.argv[2] !== "--isolated") {
  const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "botkins-secure-request-live-"));
  try {
    const env = {
      HOME: home,
      USERPROFILE: home,
      COPILOT_HOME: join(home, "copilot"),
      BOTKINS_DATA_DIR: join(home, "botkins"),
      BOTKINS_PROBE_CASE_MS: String(CASE_MS),
      PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter),
    };
    if (process.env.BOTKINS_PROBE_DEBUG) env.BOTKINS_PROBE_DEBUG = process.env.BOTKINS_PROBE_DEBUG;
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
    const result = spawnSync(process.execPath, [script, "--isolated"], { env, stdio: "inherit", timeout: LIMIT_MS, cwd: dirname(dirname(script)) });
    if (result.error) {
      console.log("FAILED: the run did not finish (" + result.error.message + ")");
      process.exitCode = 1;
    } else {
      // (A child that a signal ended has no status, and it did not print its last line.)
      if (result.status === null) console.log("FAILED: the run was ended by " + (result.signal ?? "a signal"));
      process.exitCode = result.status ?? 1;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
} else {
  // An error that nothing caught (the runtime died, a write to it failed) ends the run with the same last line as a
  // case that did not hold. Without this, Node would print its own trace and the last line would not say FAILED.
  for (const event of ["uncaughtException", "unhandledRejection"])
    process.on(event, (error) => {
      console.log("FAILED: the script itself stopped: " + String(error?.stack ?? error).slice(0, 400).replace(/\s*\n\s*/g, " | "));
      process.exit(1);
    });
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "botkins-secure-request-live-inner-"));
  const home = process.env.HOME;
  const DEBUG = !!process.env.BOTKINS_PROBE_DEBUG;
  const t0 = performance.now();

  // The values that the person gives: made up for this run, and told apart by their prefix.
  const nonce = randomBytes(6).toString("hex");
  const VALUES = { username: "canary-user-" + nonce, password: "canary-pass-" + nonce };
  const ASKED = {
    title: "Sign in to the example site",
    operation: "https_form",
    url: "https://example.org/sign-in",
    fields: [
      { key: "username", label: "Username", kind: "text" },
      { key: "password", label: "Password", kind: "password" },
    ],
  };

  // Per-case state the model endpoint reads. Only one case runs at a time.
  let current = null;
  const offered = new Set();
  const bodies = []; // every request body that reached the model endpoint, to the end of the run

  const sse = (response, events) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const event of events) response.write("data: " + JSON.stringify(event) + "\n\n");
    response.end("data: [DONE]\n\n");
  };
  const chunk = (delta, finish, usage) => ({
    id: "probe-chat", object: "chat.completion.chunk", model: "local",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage && { usage }),
  });
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const say = (response, text) => sse(response, [chunk({ role: "assistant", content: text }, null), chunk({}, "stop", usage)]);
  const call = (response, id, name, args) =>
    sse(response, [
      chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null),
      chunk({}, "tool_calls", usage),
    ]);
  const textOf = (message) => typeof message.content === "string" ? message.content : (message.content ?? []).map((p) => p.text ?? "").join("");
  /** The tool result that came back to the model for one of its calls, as text (or null). */
  const resultOf = (messages, id) => {
    const found = messages.find((m) => m.role === "tool" && m.tool_call_id === id);
    return found ? textOf(found) : null;
  };
  const jsonIn = (text) => {
    const found = /\{[\s\S]*\}/.exec(text ?? "");
    try { return found ? JSON.parse(found[0]) : undefined; } catch { return undefined; }
  };

  // The scripted model: the case's calls, one at a time, then DONE. A step is (messages) → { name, args }.
  const model = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    bodies.push(body);
    let parsed;
    try { parsed = JSON.parse(body); } catch { response.writeHead(400); response.end(); return; }
    const tools = parsed.tools ?? [];
    for (const tool of tools) offered.add(tool.function?.name ?? tool.name);
    const messages = parsed.messages ?? [];
    if (!current) return say(response, "No case running.");
    current.modelRequests += 1;
    const calls = messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []);
    const step = current.plan[calls.length];
    if (!step) {
      current.results = calls.map((c) => ({ name: c.function?.name, text: resultOf(messages, c.id) }));
      return say(response, "DONE");
    }
    const wanted = tools.find((t) => (t.function?.name ?? t.name) === step.name);
    if (!wanted) return say(response, "The tool " + step.name + " was not offered.");
    current.offeredNow = tools.map((t) => t.function?.name ?? t.name);
    const args = step.args(messages, calls);
    current.called.push(step.name);
    return call(response, "call_" + (calls.length + 1), step.name, args);
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));

  // Every file below these folders, as bytes: is a value in one of them?
  const filesWith = (folder, needles) => {
    const found = [];
    const walk = (path) => {
      let entries;
      try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          let bytes;
          try { if (statSync(full).size > 64 * 1024 * 1024) continue; bytes = readFileSync(full); } catch { continue; }
          for (const needle of needles) if (bytes.includes(needle)) found.push(full + " has " + needle.slice(0, 12) + "...");
        }
      }
    };
    walk(folder);
    return found;
  };

  let client;
  try {
    const { CopilotClient, RuntimeConnection } = await import("@microsoft/copilot-sdk");
    const { sessionOptions } = await import("../desktop/providers/copilot/index.mjs");
    const { decide } = await import("../desktop/providers/copilot/permissions.mjs");
    const { planModel } = await import("../desktop/harness/index.mjs");
    const { SecureInputs, performSecureUse } = await import("../desktop/secure-input.mjs");
    const { Interactions } = await import("../desktop/interactions.mjs");

    // ---- The smallest real pieces the two tools need (as desktop/test/secure-input.test.mjs makes them).
    const ws = { active: new Map(), notify() {}, save() {}, closing: false, events: new EventEmitter() };
    ws.interactions = new Interactions(ws);
    // The place of use: the real performSecureUse, with a stand-in for the network that records what it was given.
    const used = [];
    const place = async (plan, values, adapters) => {
      await performSecureUse(plan, values, {
        ...adapters,
        fetch: async (url, init) => {
          used.push({ url, method: init.method, redirect: init.redirect, credentials: init.credentials, values: Object.fromEntries(init.body), plan: { operation: plan.operation, url: plan.url } });
          return new Response(null, { status: 204 });
        },
      });
    };
    ws.secureInputs = new SecureInputs(ws, place);
    // The person: answers each card with the values, and keeps what the card showed.
    const cards = [];
    ws.events.on("request", (view) => {
      cards.push(JSON.parse(JSON.stringify(view)));
      queueMicrotask(() => ws.interactions.respond(view.id, { action: "accept", content: Object.fromEntries(view.fields.map((f) => [f.key, VALUES[f.key]])) }));
    });

    const workingDirectory = join(root, "work");
    mkdirSync(workingDirectory, { recursive: true });
    const inference = {
      providers: [{ name: "fixture", type: "openai", baseUrl: `http://127.0.0.1:${model.address().port}/v1`, bearerToken: "synthetic-model-token" }],
      models: [planModel("fixture", { id: "local", name: "Local fixture", tools: true, contextWindow: 64_000, maxOutput: 4_096 })],
    };
    client = new CopilotClient({
      mode: "coding-agent",
      github: { useLoggedInUser: false },
      runtime: RuntimeConnection.forSpawnedStdio({ baseDirectory: join(root, "copilot"), workingDirectory }),
    });
    await client.start();

    let counter = 0;
    /**
     * @param {object} spec
     * @param {string} spec.label
     * @param {{name: string, args: (messages: object[], calls: object[]) => object}[]} spec.plan the model's calls, in order
     */
    const runCase = async (spec) => {
      const id = ++counter;
      const chat = { id: "chat-" + id, botId: "bot", messages: [] };
      const task = {};
      ws.active.set(chat.id, task);
      // The app's own tools for this chat and turn, each wrapped only to record that its handler ran and what it threw.
      const state = { label: spec.label, plan: spec.plan, called: [], handlerRan: [], handlerErrors: [], modelRequests: 0, results: [], chat };
      const tools = ws.secureInputs.tools({ id: "bot" }, chat, { id: "run-" + id }, task).map((tool) => ({
        ...tool,
        handler: async (args, invocation) => {
          state.handlerRan.push(tool.name);
          try {
            return await tool.handler(args, invocation);
          } catch (error) {
            state.handlerErrors.push({ tool: tool.name, message: String(error?.message ?? error) });
            throw error;
          }
        },
      }));
      // [tools made]
      state.toolNames = tools.map((tool) => tool.name);
      current = state;
      const options = sessionOptions({
        sessionId: "probe-" + id,
        folder: workingDirectory,
        model: { model: "local", source: "fixture" },
        inference,
        approval: "read",
        instructions: "Follow the user's request exactly.",
        tools,
        skills: { directories: [], disabled: [] },
      }, { handlers: {} });
      options.permissions = { ...options.permissions, onRequest: (request, invocation) => decide(() => ({ allow: true }), request, invocation) };
      let session;
      let outcome = "ok";
      try {
        session = await client.createSession({ ...options, github: { capi: { enabled: false } } });
        await session.sendAndWait({ prompt: "PROBE" }, CASE_MS);
      } catch (error) {
        outcome = "error: " + String(error?.message ?? error).slice(0, 160);
      } finally {
        await session?.disconnect?.().catch(() => {});
        current = null;
        ws.active.delete(chat.id);
      }
      if (DEBUG) console.log(`  [debug] ${spec.label}: called=${state.called} ran=${state.handlerRan} errors=${JSON.stringify(state.handlerErrors)} results=${JSON.stringify(state.results)}`);
      return { label: spec.label, outcome, state };
    };
    const runWithRetry = async (spec) => {
      let row = await runCase(spec);
      if (/timed out|timeout/i.test(row.outcome) && !row.state.called.length) row = { ...(await runCase(spec)), retried: true };
      return row;
    };
    const tail = (row) => `session=${row.outcome}${row.retried ? " (retried)" : ""}`;
    const handlesIn = (messages) => Object.values(jsonIn(resultOf(messages, "call_1"))?.handles ?? {});

    // ---- A: ask, fill the card, use
    const A = await runWithRetry({
      label: "A",
      plan: [
        { name: "request_secure_input", args: () => ASKED },
        { name: "use_secure_input", args: (messages) => ({ handles: handlesIn(messages) }) },
      ],
    });
    const cardsAfterA = cards.length;
    const usedAfterA = used.length;
    // ---- B: ask only; the handles stay open. They are read from the result that came back to the model.
    const B = await runWithRetry({ label: "B", plan: [{ name: "request_secure_input", args: () => ASKED }] });
    const openHandles = Object.values(jsonIn(B.state.results[0]?.text)?.handles ?? {});
    // ---- C: another chat and turn uses the handles of B
    const C = await runWithRetry({ label: "C", plan: [{ name: "use_secure_input", args: () => ({ handles: openHandles }) }] });
    const usedAfterC = used.length;

    await client.stop().catch(() => {});
    client = null;

    // ---- The search. First a positive control: a planted value must be found, and a planted request body must show.
    const needles = Object.values(VALUES).map((value) => Buffer.from(value));
    const control = join(root, "control");
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, "planted.txt"), "x " + VALUES.password + " y");
    const searchWorks = filesWith(control, needles).length === 1;
    rmSync(control, { recursive: true, force: true });
    const bodiesText = bodies.join("\n");
    const inBodies = Object.entries(VALUES).filter(([, value]) => bodiesText.includes(value)).map(([key]) => key);
    const inFiles = [...new Set([...filesWith(home, needles), ...filesWith(root, needles)])];
    const bodiesShowTheAsk = bodiesText.includes(ASKED.title) && bodiesText.includes("request_secure_input");

    const askResult = jsonIn(A.state.results[0]?.text);
    const useResult = jsonIn(A.state.results[1]?.text);
    const card = cards[0];
    console.log(`1 tools: offered to the model=[${[...offered].filter((n) => /secure/.test(n)).sort().join(", ")}]; handlers ran in A=[${A.state.handlerRan.join(", ")}], B=[${B.state.handlerRan.join(", ")}], C=[${C.state.handlerRan.join(", ")}]`);
    console.log(`2 card: kind=${card?.kind} title=${JSON.stringify(card?.title)} fields=${JSON.stringify((card?.fields ?? []).map((f) => f.key + ":" + f.kind + ":" + f.label))} cards raised=${cards.length}`);
    console.log(`3 place of use: ${used.length} use(s) in all, ${usedAfterC} after C; first: ${used[0] ? used[0].method + " " + used[0].url + " fields=" + Object.keys(used[0].values).join(",") + " same values=" + Object.entries(VALUES).every(([k, v]) => used[0].values[k] === v) : "none"}`);
    console.log(`4 search: ${bodies.length} request(s) to the model searched (${bodiesText.length} characters, show the ask: ${bodiesShowTheAsk}), values found in them: ${inBodies.join(",") || "none"}; files below the HOME and this run's folders: ${inFiles.length ? inFiles.join("; ") : "none"}; the search finds a planted value: ${searchWorks}`);
    console.log(`5 model got: request -> ${JSON.stringify(A.state.results[0]?.text)?.slice(0, 200)}; use -> ${JSON.stringify(A.state.results[1]?.text)?.slice(0, 120)}`);
    console.log(`6 other chat: C's handler ran=[${C.state.handlerRan.join(", ")}] errors=${JSON.stringify(C.state.handlerErrors)}; uses after A=${usedAfterA}, after C=${usedAfterC}; open handles tried=${openHandles.length}`);
    console.log(`  (${Math.round(performance.now() - t0)} ms; model requests A=${A.state.modelRequests} B=${B.state.modelRequests} C=${C.state.modelRequests}; ${tail(A)} ${tail(B)} ${tail(C)})`);

    // ---- What must hold. Each failed condition is one entry of the last line.
    const failed = [];
    const hold = (name, ok, got) => { if (!ok) failed.push(name + (got ? " [" + got + "]" : "")); };
    const ran = (row) => row.outcome === "ok";
    hold("0: the three sessions ran", ran(A) && ran(B) && ran(C), `${tail(A)} ${tail(B)} ${tail(C)}`);
    hold("1: the runtime offered the two tools and called them", ["request_secure_input", "use_secure_input"].every((n) => offered.has(n) && A.state.toolNames.includes(n) && A.state.handlerRan.includes(n)) && A.state.called.join() === "request_secure_input,use_secure_input", `offered=${[...offered].join(",")}, called=${A.state.called}, ran=${A.state.handlerRan}`);
    hold("2: the card was raised with the fields that the bot asked for", card?.kind === "secure" && card.title === ASKED.title && JSON.stringify(card.fields) === JSON.stringify(ASKED.fields) && /https:\/\/example\.org\/sign-in/.test(card.detail ?? "") && cardsAfterA === 1, JSON.stringify(card)?.slice(0, 300));
    hold("3: the values reached the place of use, once, as the operation that was approved", used.length === 1 && used[0].method === "POST" && used[0].url === ASKED.url && used[0].redirect === "error" && used[0].credentials === "omit" && JSON.stringify(used[0].values) === JSON.stringify(VALUES), `uses=${used.length}`);
    hold("4: a value is in a request that reached the model", inBodies.length === 0, inBodies.join(","));
    hold("4: a value is in a file below the HOME or this run's folders", inFiles.length === 0, inFiles.join("; "));
    hold("4: the search is real (it finds a planted value, and the requests that it searched hold the ask)", searchWorks && bodiesShowTheAsk && bodies.length >= 5, `planted found=${searchWorks}, ask shown=${bodiesShowTheAsk}, requests=${bodies.length}`);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    hold("5: the model got handles only, and then {applied:true}", JSON.stringify(Object.keys(askResult?.handles ?? {})) === JSON.stringify(["username", "password"]) && Object.keys(askResult).length === 1 && Object.values(askResult.handles).every((h) => uuid.test(h)) && JSON.stringify(useResult) === '{"applied":true}', `request=${A.state.results[0]?.text?.slice(0, 160)}, use=${A.state.results[1]?.text?.slice(0, 80)}`);
    hold("6: a handle of another chat and turn is refused, and the place of use is not reached", ran(C) && openHandles.length === 2 && C.state.handlerRan.join() === "use_secure_input" && C.state.handlerErrors.length === 1 && /incomplete, expired or unavailable for this turn/.test(C.state.handlerErrors[0].message) && usedAfterC === 1, `handles=${openHandles.length}, ran=${C.state.handlerRan}, errors=${JSON.stringify(C.state.handlerErrors)}, uses=${usedAfterC}`);
    console.log(failed.length ? "FAILED: " + failed.join("; ") : "PASSED");
    if (failed.length) process.exitCode = 1;
  } catch (error) {
    console.log("FAILED: the script itself stopped: " + String(error?.stack ?? error).slice(0, 400).replace(/\s*\n\s*/g, " | "));
    process.exitCode = 1;
  } finally {
    await client?.stop?.().catch(() => {});
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}
