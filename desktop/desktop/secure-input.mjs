// Only descriptions and random handles cross the provider boundary. Values belong to one
// live tool invocation's turn and have no representation in the workspace or its snapshots.
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { defineTool } from "./providers/provider.mjs";

const ttl = 5 * 60_000;
const operations = {
  https_form: "POST these fields as a form to",
  bearer_get: "Send this value as an Authorization bearer token in a GET request to",
  page_fill: "Fill the named inputs on the open browser page at",
  git_read: "Check read access to this Git repository using its HTTPS refs endpoint and a bearer token at",
};
const text = { type: "string" };
const fieldSchema = { type: "object", additionalProperties: false, required: ["key", "label", "kind"],
  properties: { key: text, label: text, kind: { enum: ["password", "code", "secret", "text"], type: "string" }, hint: text, optional: { type: "boolean" } } };

function label(s, limit) {
  if (typeof s !== "string" || !s.trim() || s.length > limit || /[\p{Cc}\p{Cf}]/u.test(s))
    throw new Error("Use a short, single-line label.");
  return s.trim();
}
function describe({ operation, url, title, fields }) {
  if (!Object.hasOwn(operations, operation)) throw new Error("Choose a supported secure operation.");
  let address;
  try { address = new URL(url); } catch { throw new Error("Provide the full HTTPS destination."); }
  if (address.protocol !== "https:" || address.username || address.password || address.search || address.hash || address.href.length > 2048)
    throw new Error("Use an HTTPS address without credentials, a query or a fragment.");
  if (!Array.isArray(fields) || !fields.length || fields.length > 8 || (["bearer_get", "git_read"].includes(operation) && fields.length !== 1))
    throw new Error("Request one token for this operation, or one to eight fields for a form.");
  const keys = new Set();
  const clean = fields.map(f => {
    if (!f || typeof f.key !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(f.key) || f.key in Object.prototype || keys.has(f.key) || !fieldSchema.properties.kind.enum.includes(f.kind))
      throw new Error("Use distinct field keys and supported field types.");
    keys.add(f.key);
    return { key: f.key, label: label(f.label, 100), kind: f.kind, ...(f.hint && { hint: label(f.hint, 200) }), ...(f.optional === true && { optional: true }) };
  });
  return { title: label(title, 150), operation, url: address.href, fields: clean };
}

export function secureAnswer(view, answer) {
  if (answer?.action === "cancel") return { action: "cancel" };
  const values = answer?.content;
  if (answer?.action !== "accept" || !values || typeof values !== "object" || Array.isArray(values) ||
      Object.keys(values).some(key => !view.fields.some(f => f.key === key)))
    throw new Error("Check the secure fields and try again.");
  const entries = [];
  for (const { key, optional } of view.fields) {
    const v = Object.hasOwn(values, key) ? values[key] : undefined;
    if (optional && (v === undefined || v === "")) continue;
    if (typeof v !== "string" || !v.length || v.length > 32000 || v.includes("\0"))
      throw new Error("Fill in the required secure fields.");
    entries.push([key, v]);
  }
  return { action: "accept", content: Object.fromEntries(entries) };
}

// Run a bundled command with its own private copy of process.env. The parent process and
// OS process list never acquire the token. Only a success bit comes back from the command.
async function gitRead(url, token, signal) {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./secure-git-read.mjs", import.meta.url), {
    workerData: url, env: { BOTKINS_GIT_BEARER: token }, execArgv: [], stdout: true, stderr: true,
  });
  const stop = () => { void worker.terminate(); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const ok = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", () => resolve(false));
    });
    if (ok !== true || signal.aborted) throw new Error("Repository access failed.");
  } finally {
    signal.removeEventListener("abort", stop);
    await worker.terminate();
  }
}

export async function performSecureUse(plan, values, adapters = {}) {
  const signal = adapters.signal ?? AbortSignal.timeout(30_000);
  if (plan.operation === "page_fill") {
    if (!adapters.fillPage) throw new Error("Open the target page in the desktop chat's side pane first.");
    return adapters.fillPage(plan, values);
  }
  const token = Object.values(values)[0];
  if (plan.operation !== "https_form" && !/^[\x21-\x7e]+$/.test(token)) throw new Error("Invalid bearer token.");
  if (plan.operation === "git_read") return gitRead(plan.url, token, signal);
  if (!["https_form", "bearer_get"].includes(plan.operation)) throw new Error("Unknown secure operation.");
  const options = plan.operation === "https_form" ? { method: "POST", body: new URLSearchParams(values) }
    : { method: "GET", headers: { Authorization: "Bearer " + token } };
  const response = await (adapters.fetch ?? fetch)(plan.url, { ...options, signal, redirect: "error", credentials: "omit", cache: "no-store" });
  await response.body?.cancel();
  if (!response.ok) throw new Error("The destination declined the request.");
}

export class SecureInputs {
  #grants = new Map();
  #inFlight = new Map();
  constructor(ws, use, { formBrowser, savedLogins, pageUnavailable } = {}) {
    Object.assign(this, { formBrowser, savedLogins, pageUnavailable });
    this.ws = ws;
    this.use = use ?? performSecureUse;
  }
  cancel(chatId) {
    for (const grant of this.#grants.values()) if (!chatId || grant.chatId === chatId) this.#forget(grant);
    for (const [controller, id] of this.#inFlight) if (!chatId || chatId === id) controller.abort();
  }
  #forget(grant) {
    clearTimeout(grant.timer);
    for (const handle of Object.values(grant.handles)) this.#grants.delete(handle);
  }
  tools(bot, chat, run, task) {
    if (!task || !run || chat.helper || run.panelId || run.scheduleId != null || run.taskId) return [];
    const active = () => {
      if (task.stopped || task.ended || this.ws.closing || this.ws.active.get(chat.id) !== task) throw new Error("This turn has ended.");
    };
    const privateChat = () => {
      if (this.ws.accessForTurn(chat, task).member) return false;
      if (!this.ws.peopleOf) return true;
      // The split workspace relies on the link host for invites. An expired team snapshot
      // cannot establish that an owner chat is private.
      try { return this.ws.peopleOf(chat.id)?.invited?.length === 0; } catch { return false; }
    };
    const checkPrivate = () => {
      active();
      if (!privateChat()) throw new Error("Use a private owner chat for this operation.");
    };
    const request = defineTool("request_secure_input", {
      description: "Ask the person to pick a saved credential from the Botkins vault or enter a private value for this HTTPS destination. For page_fill, use the visible HTML input names from browser_form on a screen host, or open the desktop chat’s side_pane_web viewer. https_form posts keyed fields. bearer_get and git_read take one bearer token. You receive one-time handles. Never request secrets in chat.",
      parameters: { type: "object", additionalProperties: false, required: ["title", "operation", "url", "fields"],
        properties: { title: text, operation: { type: "string", enum: Object.keys(operations) }, url: text, fields: { type: "array", minItems: 1, maxItems: 8, items: fieldSchema } } },
      handler: async args => {
        active();
        const plan = describe(args);
        if (plan.operation === "page_fill" && this.pageUnavailable) throw new Error(this.pageUnavailable);
        if (plan.operation === "page_fill" && this.formBrowser) {
          checkPrivate();
          plan.document = await this.formBrowser.bind(chat.id, plan.url);
          checkPrivate();
        }
        const answer = await this.ws.interactions.request(chat, task, { kind: "secure", title: plan.title, fields: plan.fields,
          botId: bot.id, detail: operations[plan.operation] + " " + plan.url + "\n" + plan.fields.map(f => f.label + " → " + f.key).join("\n") }, ttl);
        if (answer.action !== "accept") return JSON.stringify({ cancelled: true, message: "Request closed. Use an updated Botkins window or phone to answer a new secure request." });
        active();
        const handles = Object.fromEntries(Object.keys(answer.content).map(key => [key, randomUUID()]));
        if (!Object.keys(handles).length) {
          return JSON.stringify({ handles });
        }
        const grant = { task, botId: bot.id, chatId: chat.id, plan, handles, values: answer.content, expires: Date.now() + ttl };
        grant.timer = setTimeout(() => this.#forget(grant), ttl).unref();
        for (const handle of Object.values(handles)) this.#grants.set(handle, grant);
        return JSON.stringify({ handles });
      },
    });
    const use = defineTool("use_secure_input", {
      description: "Pass the handles object from request_secure_input unchanged to apply the operation the person approved. Returns completion only.",
      parameters: { type: "object", additionalProperties: false, required: ["handles"], properties: { handles: { anyOf: [
        { type: "object", additionalProperties: text, minProperties: 1, maxProperties: 8 },
        { type: "array", items: text, minItems: 1, maxItems: 8 },
      ] } } },
      handler: async ({ handles }) => {
        active();
        const list = Array.isArray(handles);
        const ids = handles && typeof handles === "object" ? Object.values(handles) : [];
        const grant = this.#grants.get(ids[0]);
        if (!grant || grant.task !== task || grant.botId !== bot.id || grant.expires <= Date.now() ||
            ids.length !== Object.keys(grant.handles).length ||
            !Object.entries(grant.handles).every(([key, id]) => list ? ids.includes(id) : Object.hasOwn(handles, key) && handles[key] === id))
          throw new Error("These handles are incomplete, expired or unavailable for this turn.");
        if (grant.plan.document && !privateChat()) throw new Error("Open the screen browser in a private owner chat.");
        this.#forget(grant); // Reserve before awaiting. An ambiguous network failure must never replay a submission.
        const controller = new AbortController();
        this.#inFlight.set(controller, chat.id);
        try {
          await this.use({ ...grant.plan, chatId: chat.id }, grant.values, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
          return JSON.stringify({ applied: true });
        } catch {
          throw new Error("Botkins could not apply the secure input. Check the destination and request fresh input to retry.");
        } finally {
          this.#inFlight.delete(controller);
        }
      },
    });
    const tools = [request, use];
    if ((this.formBrowser || this.savedLogins) && privateChat()) {
      if (this.formBrowser) tools.push(defineTool("browser_form", {
        description: "Open an HTTPS sign-in page in this chat’s browser on the host screen, inspect visible field names, or close it. For passwords and saved vault items use request_secure_input with page_fill, then use_secure_input. No field values are returned.",
        parameters: { type: "object", required: ["action"], additionalProperties: false, properties: { action: { type: "string", enum: ["open", "inspect", "close"] }, url: text } },
        skipPermission: false,
        handler: async ({ action, url }) => {
          checkPrivate();
          if (action === "open" || action === "inspect") {
            const page = action === "open" ? await this.formBrowser.open(chat.id, url) : await this.formBrowser.inspect(chat.id);
            checkPrivate();
            return JSON.stringify(page);
          }
          if (action !== "close") throw new Error("Choose open, inspect or close.");
          await this.formBrowser.close(chat.id);
          return JSON.stringify({ closed: true });
        },
      }));
      if (this.savedLogins) tools.push(defineTool("find_saved_credentials", {
        description: "Find Botkins vault entry names saved for an HTTPS site. Only names and kinds are returned. A person picks the credential in request_secure_input before use.",
        parameters: { type: "object", required: ["url"], additionalProperties: false, properties: { url: text } },
        handler: async ({ url }) => {
          checkPrivate();
          const origin = new URL(url);
          if (origin.protocol !== "https:" || origin.username || origin.password) throw new Error("Give the HTTPS site address.");
          const entries = await this.savedLogins(chat.id, origin.origin);
          checkPrivate();
          return JSON.stringify(entries.map(({ name, kind }) => ({ name, kind })));
        },
      }));
    }
    return tools;
  }
}
