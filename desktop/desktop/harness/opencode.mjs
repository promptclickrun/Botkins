// An OpenCode model as the model behind another harness (Pi, OMP, the Copilot runtime).
//
// OpenCode keeps the person's model services and their sign-ins (desktop/providers/opencode), and
// it has no endpoint that answers one model request with tools: its server runs whole agent turns.
// So, as harness/claude.mjs does with Claude Code, each request the gateway gets on /opencode
// (OpenAI's Chat Completions format) is answered by one model step of an OpenCode session that
// can do nothing else:
//
//   - The session is made for the request from the conversation so far, imported whole (OpenCode's
//     own transcript import): the person's turns with their pictures, the model's replies and its
//     tool calls with their results, under the names OpenCode gives them. The system prompt is the
//     session's instructions, on an agent of Botkins' own whose prompt is one line, so OpenCode's
//     own prompt is left out. It is kept in a folder of Botkins' own (`dir`, opencode.json).
//   - The harness's tools are listed to it through a local tool server (desktop/providers/
//     toolbridge.mjs) whose calls never finish, and the session's rules allow those tools and no
//     other: OpenCode's own tools aren't offered.
//   - The last turn is sent as the session's prompt; a conversation that goes on from tool results
//     is sent one short line asking it to go on, since OpenCode starts a step only on a prompt.
//   - What the model writes comes back from OpenCode's event stream as Chat Completions chunks:
//     text, thinking, and tool calls with their whole arguments. When the step has been written
//     and it called a tool, the session is stopped before the tool would run, and its usage is
//     read from the stopped step.
//   - The session and, after a quiet while, its tool server are removed from OpenCode.
//
// The harness then runs the tools itself, with Botkins' approvals, and sends the next request.
// No sign-in leaves OpenCode, and OpenCode's own way of running a turn (Settings › Harness ›
// Provider's own) is not changed by any of this.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PlanError } from "./claude.mjs";

/** The agent a relay session runs as: one line of its own, so OpenCode's prompt is left out. */
export const RELAY_AGENT = "botkins-model";
const RELAY_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  agent: { [RELAY_AGENT]: { mode: "primary", description: "Botkins: one model step for another harness. Not for use on its own.", prompt: "Follow the instructions below." } },
};
/** The prompt of a request that goes on from tool results: OpenCode starts a step only on a prompt. */
export const CONTINUE = "Continue from the tool results above.";
/** The longest tool name the model APIs take. */
const MAX_TOOL_NAME = 64;
/** How long a tool server stays in OpenCode with no request for it. */
const IDLE_SERVER_MS = 10 * 60 * 1000;
/** How long a stopped step is waited for to say what it used. */
const USAGE_WAIT_MS = 2000;
const ZERO = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

/**
 * The names the harness's tools go by in OpenCode, which calls a tool server's tool
 * "<server>_<tool>". A name that would be too long keeps its start and a mark of its own.
 * `native(name)` and `original(nativeName)` go each way; `listed(name)` is the name the tool
 * server lists it under.
 */
export function relayNames(server, tools = []) {
  const prefix = server + "_";
  const forward = new Map();
  const back = new Map();
  for (const name of tools) {
    if (typeof name !== "string" || !name || forward.has(name)) continue;
    const room = MAX_TOOL_NAME - prefix.length;
    const listed = name.length <= room ? name : name.slice(0, room - 9) + "_" + createHash("sha256").update(name).digest("hex").slice(0, 8);
    if (back.has(listed)) throw new PlanError(400, "invalid_request_error", "Two tools would have the same name in OpenCode: " + name + " and " + back.get(listed) + ".");
    forward.set(name, listed);
    back.set(listed, name);
  }
  return {
    prefix,
    listed: (name) => forward.get(name) ?? name,
    native: (name) => prefix + (forward.get(name) ?? name),
    // A model that calls a tool by its own name (without the server's) is taken at its word.
    original: (name) => {
      const text = String(name ?? "");
      if (text.startsWith(prefix)) return back.get(text.slice(prefix.length)) ?? text.slice(prefix.length);
      return back.get(text) ?? text;
    },
  };
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;
/** A message's content (a string or Chat Completions parts) as text and pictures. */
function contentOf(content) {
  if (typeof content === "string") return { text: content, files: [] };
  const text = [];
  const files = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "text" && typeof part.text === "string") text.push(part.text);
    else if (part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      const data = DATA_URL.exec(String(url ?? ""));
      if (data) files.push({ mime: data[1], data: data[2].replace(/\s+/g, "") });
      else if (url) text.push("[Picture: " + url + "]");
    }
  }
  return { text: text.join("\n"), files };
}

/**
 * A Chat Completions request as an OpenCode session: { system, messages, prompt }.
 *   system    every system and developer message, in order
 *   messages  the conversation up to its last turn, as OpenCode's transcript import takes it
 *   prompt    the last turn: the person's text and pictures, or CONTINUE after tool results
 * Each tool call is named as OpenCode lists it, with the result the request gives it. `natives`
 * holds what OpenCode said of a tool call it made earlier (a model's signature for its call),
 * given back with it.
 */
export function transcript(body, names, { model, now = Date.now(), natives = new Map() } = {}) {
  const system = [];
  const turns = [];
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role === "system" || message?.role === "developer") {
      const { text } = contentOf(message.content);
      if (text) system.push(text);
    } else if (message?.role === "user" || message?.role === "assistant" || message?.role === "tool") turns.push(message);
  }
  if (!turns.length) throw new PlanError(400, "invalid_request_error", "A request to an OpenCode model needs at least one turn.");
  const last = turns.at(-1);
  const head = last.role === "user" ? turns.slice(0, -1) : turns;
  const messages = [];
  const calls = new Map();
  let clock = now - (head.length + 1) * 10;
  const id = () => "msg_" + randomBytes(12).toString("hex");
  const tick = () => (clock += 10);
  for (const message of head) {
    if (message.role === "user") {
      const { text, files } = contentOf(message.content);
      messages.push({ id: id(), type: "user", time: { created: tick() }, text, ...(files.length && { files: files.map((file) => ({ ...file, source: { type: "inline" } })) }) });
    } else if (message.role === "assistant") {
      const created = tick();
      const content = [];
      const { text } = contentOf(message.content);
      if (text) content.push({ type: "text", text });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (!call?.id || !call.function?.name) continue;
        let input = {};
        try {
          const parsed = JSON.parse(call.function.arguments || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
        } catch {
          // Arguments the model wrote badly stay as they were said, for the model to read.
          input = { arguments: String(call.function.arguments) };
        }
        const native = natives.get(call.id);
        const part = { type: "tool", id: call.id, name: names.native(call.function.name), executed: false, ...(native && { native }), state: { status: "error", input, error: { type: "aborted", message: "No result was given for this call." } }, time: { created } };
        calls.set(call.id, part);
        content.push(part);
      }
      messages.push({ id: id(), type: "assistant", agent: RELAY_AGENT, ...(model && { model }), time: { created, completed: tick() }, cost: 0, tokens: ZERO, finish: content.some((part) => part.type === "tool") ? "tool-calls" : "stop", content });
    } else {
      const part = calls.get(message.tool_call_id);
      if (!part) continue;
      const { text, files } = contentOf(message.content);
      const content = [...(text ? [{ type: "text", text }] : []), ...files.map((file) => ({ type: "file", uri: "data:" + file.mime + ";base64," + file.data, mime: file.mime }))];
      part.state = { status: "completed", input: part.state.input, content: content.length ? content : [{ type: "text", text: "(no output)" }] };
      part.time = { ...part.time, ran: part.time.created, completed: tick() };
    }
  }
  const prompt = last.role === "user" ? contentOf(last.content) : { text: CONTINUE, files: [] };
  return {
    system: system.join("\n\n"),
    messages,
    prompt: { text: prompt.text, ...(prompt.files.length && { files: prompt.files.map((file, index) => ({ uri: "data:" + file.mime + ";base64," + file.data, name: "picture-" + (index + 1) })) }) },
  };
}

/** The chunks of a Chat Completions stream put together as one completion (a request with stream: false). */
export function completion() {
  let head = null;
  let content = "";
  let reasoning = "";
  const calls = [];
  let finish = null;
  let usage;
  return {
    take(chunk) {
      head ??= { id: chunk.id, created: chunk.created, model: chunk.model };
      if (chunk.usage) usage = chunk.usage;
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {};
        if (delta.content) content += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        for (const call of delta.tool_calls ?? []) {
          const entry = (calls[call.index] ??= { id: call.id, type: "function", function: { name: "", arguments: "" } });
          if (call.id) entry.id = call.id;
          if (call.function?.name) entry.function.name = call.function.name;
          if (call.function?.arguments) entry.function.arguments += call.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    },
    message() {
      return {
        id: head?.id,
        object: "chat.completion",
        created: head?.created,
        model: head?.model,
        choices: [{ index: 0, message: { role: "assistant", content: content || null, ...(reasoning && { reasoning_content: reasoning }), ...(calls.length && { tool_calls: calls.filter(Boolean) }) }, finish_reason: finish ?? "stop" }],
        ...(usage && { usage }),
      };
    },
  };
}

/** OpenCode's tokens as Chat Completions usage. */
export function usageOf(tokens) {
  if (!tokens) return undefined;
  const cached = tokens.cache?.read ?? 0;
  const prompt = (tokens.input ?? 0) + cached + (tokens.cache?.write ?? 0);
  const reply = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  return { prompt_tokens: prompt, completion_tokens: reply, total_tokens: prompt + reply, prompt_tokens_details: { cached_tokens: cached }, completion_tokens_details: { reasoning_tokens: tokens.reasoning ?? 0 } };
}

const finishOf = (raw) => {
  const value = String(raw ?? "").toLowerCase();
  if (/length|max_tokens|max-tokens/.test(value)) return "length";
  if (/content[-_]filter|safety/.test(value)) return "content_filter";
  return "stop";
};

/** An OpenCode failure as the harness should hear it. */
function failure(error, fallback = "OpenCode couldn't finish this reply.") {
  const status = Number.isInteger(error?.status) && error.status >= 400 ? error.status : 502;
  const type = status === 429 ? "rate_limit_error" : status === 401 || status === 403 ? "authentication_error" : status === 400 ? "invalid_request_error" : "api_error";
  return new PlanError(status, type, error?.message || fallback);
}

export class OpenCodeRelay {
  /**
   * @param options.provider  The OpenCode provider (desktop/providers/opencode): its server
   *                          (`server()`), its event stream (`listen`, `attach`, `detach`), and
   *                          its models (`models()`), for the thinking levels each one has.
   * @param options.bridge    The local tool server (desktop/providers/toolbridge.mjs).
   * @param options.dir       Botkins' own folder for the relay's sessions.
   */
  constructor({ provider, bridge, dir, log = () => {} }) {
    Object.assign(this, { provider, bridge, dir, log });
    // Tool servers in OpenCode, by name: { endpoint, tools (a mark of the list), api, timer }.
    this.servers = new Map();
    // Names a request is using now: two at once never share a tool server.
    this.busy = new Set();
    this.projects = new WeakMap();
    this.natives = new Map();
    this.levels = null;
  }
  location() {
    if (!this.ready) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, "opencode.json"), JSON.stringify(RELAY_CONFIG, null, 2) + "\n");
      this.ready = true;
    }
    return { directory: this.dir };
  }
  /** The project OpenCode keeps the relay's folder as, which an imported session must name. */
  async project(api, location) {
    const known = this.projects.get(api);
    if (known) return known;
    const { data } = await api.post("/api/session", { location, title: "Botkins" });
    await api.delete("/api/session/" + data.id).catch(() => {});
    this.projects.set(api, data.projectID);
    return data.projectID;
  }
  /** The thinking level OpenCode has for this model nearest the one asked for, or none. */
  async variant(model, effort) {
    if (!effort || effort === "none") return undefined;
    if (!this.levels || Date.now() - this.levels.at > 5 * 60 * 1000) {
      const list = await this.provider.models().catch(() => []);
      this.levels = { at: Date.now(), map: new Map(list.map((m) => [m.id, m.efforts ?? []])) };
    }
    const offered = this.levels.map.get(model) ?? [];
    if (offered.includes(effort)) return effort;
    const order = ["minimal", "low", "medium", "high", "xhigh", "max"];
    const wanted = order.indexOf(effort);
    if (wanted < 0) return undefined;
    // The nearest level below the one asked for, else the nearest above.
    const below = order.slice(0, wanted).reverse().find((level) => offered.includes(level));
    return below ?? order.slice(wanted + 1).find((level) => offered.includes(level));
  }
  /** A tool server name no other request is using now: two at once never share one. */
  reserve(base) {
    let name = base;
    for (let n = 2; this.busy.has(name); n++) name = base + "x" + n;
    this.busy.add(name);
    return name;
  }
  /**
   * Lists `tools` on the tool server `name` in OpenCode, registering it again only when the list
   * changed. Returns the request's release(): its calls, which wait until then, are let go, and
   * the server is removed after a quiet while.
   */
  async offer(api, location, name, tools) {
    const mark = createHash("sha256").update(JSON.stringify(tools.map((tool) => [tool.name, tool.description, tool.parameters]))).digest("hex");
    let server = this.servers.get(name);
    if (server && server.api !== api) server = null;
    if (!server) {
      server = { endpoint: await this.bridge.open([], { key: "opencode-relay:" + name }), mark: null, api };
      this.servers.set(name, server);
    }
    clearTimeout(server.timer);
    const waiting = new Set();
    server.endpoint.set(tools.map((tool) => ({ ...tool, handler: () => new Promise((resolve) => waiting.add(resolve)) })));
    if (server.mark !== mark) {
      await api.put("/api/experimental/mcp/" + name, { config: { type: "remote", url: server.endpoint.url, headers: server.endpoint.headers, oauth: false, codemode: false } }, location);
      server.mark = mark;
    }
    const refusal = "This call wasn't run here: the program that asked runs its own tools.";
    return () => {
      for (const resolve of waiting) resolve(refusal);
      waiting.clear();
      // A late call (none should come) is answered at once rather than left waiting.
      server.endpoint.set(tools.map((tool) => ({ ...tool, handler: async () => refusal })));
      clearTimeout(server.timer);
      server.timer = setTimeout(() => {
        if (this.busy.has(name) || this.servers.get(name) !== server) return;
        this.servers.delete(name);
        this.bridge.forget("opencode-relay:" + name);
        void api.delete("/api/experimental/mcp/" + name, location).catch(() => {});
      }, IDLE_SERVER_MS);
      server.timer.unref?.();
    };
  }
  /**
   * Answers one Chat Completions request with one step of an OpenCode model: `emit(chunk)` for
   * each chunk of the reply, as it comes. Resolves when the reply is whole. Throws a PlanError
   * when OpenCode can't answer; `signal` stops it.
   */
  async turn(body, { emit, signal }) {
    const [providerID, ...rest] = String(body?.model ?? "").split("/");
    const modelID = rest.join("/");
    if (!providerID || !modelID) throw new PlanError(400, "invalid_request_error", "Name an OpenCode model as <service>/<model>.");
    const tools = (Array.isArray(body.tools) ? body.tools : []).filter((tool) => tool?.type === "function" && typeof tool.function?.name === "string" && tool.function.name);
    const api = await this.provider.server();
    const location = this.location();
    const variant = await this.variant(body.model, body.reasoning_effort);
    const model = { providerID, id: modelID, ...(variant && { variant }) };
    // One tool server name per conversation (its system prompt and first turn), so the tool names
    // the model reads stay the same from request to request and the provider's cache still holds.
    const first = (body.messages ?? []).find((message) => message?.role === "user");
    const base = "b" + createHash("sha256").update(JSON.stringify([(body.messages ?? []).filter((m) => m?.role === "system").map((m) => m.content), first?.content ?? null])).digest("hex").slice(0, 6);
    const name = this.reserve(base);
    const names = relayNames(name, tools.map((tool) => tool.function.name));
    const sessionID = "ses_" + randomBytes(12).toString("hex");
    let release = () => {};
    let watcher = null;
    let settled = false;
    try {
      if (tools.length) release = await this.offer(api, location, name, tools.map((tool) => ({ name: names.listed(tool.function.name), description: tool.function.description ?? "", parameters: tool.function.parameters ?? { type: "object", properties: {} } })));
      const projectID = await this.project(api, location);
      const { system, messages, prompt } = transcript(body, names, { model, natives: this.natives });
      const now = Date.now();
      await api.post("/api/experimental/session/import", {
        info: { id: sessionID, projectID, agent: RELAY_AGENT, model, cost: 0, tokens: ZERO, time: { created: now, updated: now }, title: "Botkins model turn", location, permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: name + "_*", resource: "*", effect: "allow" }] },
        messages,
        location,
      });
      const note = tools.length ? "\n\nThe tools are offered under the names `" + names.prefix + "<tool>`: call `" + names.native(tools[0].function.name) + "` for " + tools[0].function.name + ", and so on." : "";
      if (system || note) await api.put("/api/experimental/session/" + sessionID + "/instructions/entries/botkins", { value: (system + note).trim() });
      const step = this.follow(sessionID, body, names, emit, () => this.stopSession(sessionID));
      watcher = { sessionId: sessionID, children: new Set(), received: (event) => step.take(event), resync: async () => {}, turn: { reject: (error) => step.fail(error) } };
      this.provider.attach(watcher);
      await this.provider.listen();
      const aborted = () => step.fail(new PlanError(499, "api_error", "The request was cancelled."));
      if (signal?.aborted) aborted();
      signal?.addEventListener("abort", aborted, { once: true });
      try {
        await api.post("/api/session/" + sessionID + "/prompt", prompt);
        await step.done;
        settled = true;
      } finally {
        signal?.removeEventListener("abort", aborted);
      }
    } catch (error) {
      if (error instanceof PlanError) throw error;
      throw failure(error, "OpenCode couldn't take the request.");
    } finally {
      if (watcher) this.provider.detach(watcher);
      // Nothing of the request stays in OpenCode: a step still going is stopped first (so a call let
      // go can't start another step), then the calls are let go and the session removed.
      void (async () => {
        if (!settled) await this.stopSession(sessionID);
        release();
        this.busy.delete(name);
        await api.delete("/api/session/" + sessionID).catch(() => {});
      })();
    }
  }
  async stopSession(sessionID) {
    const api = await this.provider.serverIfRunning?.();
    await api?.post("/api/session/" + sessionID + "/interrupt", undefined, undefined, 10000).catch(() => {});
  }
  /**
   * Reads one session's events into Chat Completions chunks. `done` resolves when the first step's
   * reply is whole (and, for a step that called tools, OpenCode has stopped it and said what it
   * used); it rejects when OpenCode reports a failure first.
   */
  follow(sessionID, body, names, emit, stop) {
    const id = "chatcmpl-" + randomBytes(12).toString("hex");
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta, finish = null) => emit({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
    let resolve;
    let reject;
    const done = new Promise((ok, no) => ((resolve = ok), (reject = no)));
    done.catch(() => {});
    let step = null;
    let began = false;
    let sectionDelta = false;
    const calls = new Map();
    let streamed = false;
    let over = false;
    let waitTimer;
    const say = (delta) => {
      if (!began) {
        began = true;
        delta = { role: "assistant", ...delta };
      }
      chunk(delta);
    };
    const end = (finish, tokens) => {
      if (over) return;
      over = true;
      clearTimeout(waitTimer);
      if (!began) say({ content: "" });
      chunk({}, calls.size ? "tool_calls" : finishOf(finish));
      const usage = usageOf(tokens);
      if (usage) emit({ id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage });
      resolve();
    };
    const fail = (error) => {
      if (over) return;
      over = true;
      clearTimeout(waitTimer);
      reject(error instanceof PlanError ? error : failure(error));
    };
    const remember = (callId, native) => {
      if (!native) return;
      this.natives.set(callId, native);
      if (this.natives.size > 500) this.natives.delete(this.natives.keys().next().value);
    };
    const call = (data) => {
      let entry = calls.get(data.id);
      if (!entry) {
        entry = { index: calls.size, named: false, argued: false };
        calls.set(data.id, entry);
      }
      if (!entry.named && (data.name || entry.name)) {
        entry.named = true;
        entry.name = data.name ?? entry.name;
        say({ tool_calls: [{ index: entry.index, id: data.id, type: "function", function: { name: names.original(entry.name), arguments: "" } }] });
      }
      return entry;
    };
    return {
      done,
      fail,
      take: ({ type, data }) => {
        if (over || data?.sessionID !== sessionID) return;
        // Only the first step is this request's: what OpenCode does after it is never the harness's.
        if (data.assistantMessageID) {
          step ??= data.assistantMessageID;
          if (data.assistantMessageID !== step) return;
        }
        switch (type) {
          case "session.text.started":
            sectionDelta = false;
            return;
          case "session.text.delta":
            sectionDelta = true;
            if (data.delta) say({ content: data.delta });
            return;
          case "session.text.ended":
            if (!sectionDelta && data.text) say({ content: data.text });
            sectionDelta = false;
            return;
          case "session.reasoning.delta":
            if (data.delta) say({ reasoning_content: data.delta });
            return;
          case "session.tool.input.started":
            call(data);
            return;
          case "session.tool.called": {
            const entry = call({ ...data, name: data.name ?? calls.get(data.id)?.name });
            remember(data.id, data.native);
            if (!entry.argued) {
              entry.argued = true;
              say({ tool_calls: [{ index: entry.index, function: { arguments: JSON.stringify(data.input ?? {}) } }] });
            }
            return;
          }
          case "session.step.streamed":
            streamed = true;
            if (calls.size) {
              // The step is written and asks for tools: OpenCode is stopped before it runs them.
              void stop();
              waitTimer = setTimeout(() => end(), USAGE_WAIT_MS);
            }
            return;
          case "session.step.ended":
            return end(data.finish ?? data.rawFinish, data.tokens);
          case "session.step.failed":
            if (streamed && calls.size) return end(undefined, data.tokens);
            return fail(failure(data.error));
          case "session.execution.failed":
            return fail(failure(data.error));
          case "session.execution.succeeded":
            return end();
          case "session.execution.interrupted":
            if (streamed) return end();
            return fail(new PlanError(502, "api_error", "OpenCode stopped before the reply was written."));
        }
      },
    };
  }
  async stop() {
    for (const [name, server] of this.servers) {
      clearTimeout(server.timer);
      this.bridge.forget("opencode-relay:" + name);
    }
    this.servers.clear();
  }
}
