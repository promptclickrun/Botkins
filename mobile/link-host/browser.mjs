// Browser extension tools ("browser-v1").
//
// Lets a paired Chromium (Chrome or Edge) extension expose the signed-in browser profile to bots
// on this host over the existing sealed Botkins Link (LAN or relay).
//
// Unlike phone tools (device.mjs), browser tools follow the OpenClaw / Claude extension model:
// - The extension registers as a paired device of kind `"browser"` (owner-only).
// - When the extension enables browser control (and optionally switches between `all` tabs and
//   `group` tabs in its popup), it reports `link.browser.state`.
// - Bots see the `browser_*` tools only while at least one connected/enabled browser extension
//   is available. When multiple browser extensions are paired (e.g., laptop + Mac Studio), bots
//   can list them with `browser_list` or target one with `browser` (device id or name).
// - Every tool call waits in a lean per-browser ask stream (`meta` + `asks` only: the extension
//   never receives chats, runs, spaces, or text streams, keeping relay traffic minimal).
import { randomBytes } from "node:crypto";
import { Failure } from "./tools.mjs";

export const BROWSER_CAPABILITY = "browser-v1";
const CALL_MS = 60_000;
const MAX_ASKS = 24;
const MAX_RESULT = 2 * 1024 * 1024; // 2 MiB (covers snapshots + base64 screenshots)
export const BROWSER_MODES = ["all", "group"];

const string = { type: "string" };
const number = { type: "number" };
const boolean = { type: "boolean" };
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const targetBrowser = {
  ...string,
  description: "Optional browser extension name or device id when more than one browser profile is connected. Defaults to the most recently active browser.",
};
const targetTab = {
  ...number,
  description: "Optional Chromium tab id. Defaults to the active eligible tab.",
};

/**
 * Browser tools offered to bots while a Botkins Chromium extension is connected and enabled.
 * Read-only tools only inspect browser/page state; write tools interact with tabs/pages.
 */
export const BROWSER_TOOLS = [
  {
    name: "browser_list",
    readOnly: true,
    hostOnly: true,
    description: "Lists the connected Botkins Chromium browser extensions paired with this host (device id, name, browser, access mode, active status). Use this to pick a `browser` when multiple browser profiles are connected.",
    parameters: object({}),
  },
  {
    name: "browser_tabs",
    readOnly: true,
    description: "Lists eligible open tabs in the person's Chromium browser profile (id, windowId, title, url, active, pinned, inGroup).",
    parameters: object({ browser: targetBrowser }),
  },
  {
    name: "browser_open",
    readOnly: false,
    description: "Opens a new tab in the person's Chromium browser at `url` (and adds it to the Botkins tab group when in Selected tabs mode). Returns the tab id, title, and url.",
    parameters: object({ url: string, active: { ...boolean, description: "Focus the new tab (default true)." }, browser: targetBrowser }, ["url"]),
  },
  {
    name: "browser_navigate",
    readOnly: false,
    description: "Navigates a tab to `url`, or goes `back`, `forward`, or `reload`. Waits briefly for the page load to settle.",
    parameters: object({
      tabId: targetTab,
      url: { ...string, description: "Full http(s) URL to navigate to." },
      action: { type: "string", enum: ["goto", "back", "forward", "reload"], description: "Navigation action (default goto when url is given)." },
      browser: targetBrowser,
    }),
  },
  {
    name: "browser_close_tab",
    readOnly: false,
    description: "Closes a tab by `tabId` in the person's Chromium browser.",
    parameters: object({ tabId: number, browser: targetBrowser }, ["tabId"]),
  },
  {
    name: "browser_snapshot",
    readOnly: true,
    description: "Reads the current page's title, URL, visible text, and interactive elements (buttons, links, inputs, selects) with stable CSS selectors and ref ids for clicking or typing.",
    parameters: object({
      tabId: targetTab,
      maxChars: { ...number, description: "Maximum visible text characters to return (default 12000, max 50000)." },
      browser: targetBrowser,
    }),
  },
  {
    name: "browser_screenshot",
    readOnly: true,
    description: "Captures a JPEG screenshot of the tab via chrome.debugger. Saved to an upload file on this host so you can inspect it with the read tool or share it; returns its local path, url, title, and dimensions.",
    parameters: object({
      tabId: targetTab,
      fullPage: { ...boolean, description: "Capture the full scrollable page instead of the viewport (default false)." },
      quality: { ...number, description: "JPEG quality 20-90 (default 70)." },
      browser: targetBrowser,
    }),
    file: true,
  },
  {
    name: "browser_click",
    readOnly: false,
    description: "Clicks an element by `selector`, `ref` (from browser_snapshot), `text` match, or viewport coordinates (`x`, `y`).",
    parameters: object({
      tabId: targetTab,
      selector: { ...string, description: "CSS selector of the element to click." },
      ref: { ...string, description: "Element ref from browser_snapshot (e.g. e12)." },
      text: { ...string, description: "Visible text of a button or link to click." },
      x: number,
      y: number,
      doubleClick: boolean,
      browser: targetBrowser,
    }),
  },
  {
    name: "browser_type",
    readOnly: false,
    description: "Types text into an input, textarea, or contenteditable element identified by `selector` or `ref` (or the currently focused element). Optionally clears first or presses Enter.",
    parameters: object({
      tabId: targetTab,
      selector: string,
      ref: string,
      text: string,
      clear: { ...boolean, description: "Clear existing field value before typing (default false)." },
      submit: { ...boolean, description: "Press Enter after typing (default false)." },
      browser: targetBrowser,
    }, ["text"]),
  },
  {
    name: "browser_press",
    readOnly: false,
    description: "Dispatches a keyboard key press (e.g. Enter, Escape, Tab, ArrowDown, Backspace, or shortcut like Control+a / Meta+a) to the page.",
    parameters: object({
      tabId: targetTab,
      key: string,
      browser: targetBrowser,
    }, ["key"]),
  },
  {
    name: "browser_scroll",
    readOnly: false,
    description: "Scrolls the page or a matching element by pixels or direction (`up`, `down`, `top`, `bottom`).",
    parameters: object({
      tabId: targetTab,
      direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
      amount: { ...number, description: "Pixels to scroll for up/down (default 600)." },
      selector: string,
      browser: targetBrowser,
    }),
  },
  {
    name: "browser_wait",
    readOnly: true,
    description: "Waits for a CSS `selector`, visible `text`, URL substring, or fixed milliseconds (`ms`, max 15000) in a tab.",
    parameters: object({
      tabId: targetTab,
      selector: string,
      text: string,
      urlContains: string,
      ms: { ...number, description: "Fixed wait in ms (default 1000 when no condition given; max 15000)." },
      timeoutMs: { ...number, description: "Maximum time to wait for a condition (default 10000, max 25000)." },
      browser: targetBrowser,
    }),
  },
  {
    name: "browser_eval",
    readOnly: false,
    description: "Evaluates a JavaScript expression in the tab via chrome.debugger and returns the JSON-serializable result. Use when structured click/type/snapshot actions are not enough.",
    parameters: object({
      tabId: targetTab,
      expression: string,
      awaitPromise: { ...boolean, description: "Await returned Promise (default true)." },
      browser: targetBrowser,
    }, ["expression"]),
  },
  {
    name: "browser_cdp",
    readOnly: false,
    description: "Sends a raw Chrome DevTools Protocol command (e.g. `Page.navigate`, `DOM.getDocument`, `Input.dispatchMouseEvent`, `Emulation.setDeviceMetricsOverride`) to a tab via chrome.debugger.",
    parameters: object({
      tabId: targetTab,
      method: string,
      params: { type: "object", additionalProperties: true },
      browser: targetBrowser,
    }, ["method"]),
  },
];

const BY_NAME = new Map(BROWSER_TOOLS.map((tool) => [tool.name, tool]));
const SAFE_SECURE_CODES = new Set(["origin_mismatch", "password_type_mismatch", "type_mismatch"]);

function zeroSecureFields(fields) {
  if (!Array.isArray(fields)) return;
  for (const field of fields) {
    if (field && typeof field === "object") field.value = "";
  }
  fields.length = 0;
}

const cleanLine = (value, max = 80) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");

export function cleanBrowserState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { enabled: false, mode: "all" };
  const mode = BROWSER_MODES.includes(input.mode) ? input.mode : "all";
  const browser = cleanLine(input.browser, 40);
  const profile = cleanLine(input.profile, 60);
  const version = cleanLine(input.version, 32);
  return {
    enabled: input.enabled !== false,
    mode,
    ...(browser && { browser }),
    ...(profile && { profile }),
    ...(version && { version }),
  };
}

export class BrowserTools {
  /**
   * @param store     LinkStore
   * @param uploads   Uploads (screenshots arrive via link.upload and resolve to real local paths)
   * @param isLive    (deviceId) => boolean (whether this browser currently has an active session/socket)
   * @param changed   () => void (marks asks changed so waiting browser follow/sync wakes immediately)
   * @param onTools   () => void (notifies Workspace that the browser tool list changed)
   * @param now       () => number
   */
  constructor({ store, uploads, isLive = () => false, changed = () => {}, onTools = () => {}, now = Date.now }) {
    Object.assign(this, { store, uploads, isLive, changed, onTools, now });
    this.pending = new Map(); // askId -> { ask, tool, resolve, reject, timers }
    this.views = new Map(); // deviceId -> Map(partName -> { json, v })
  }

  /** Paired owner devices of kind "browser". */
  devices() {
    return this.store.data.devices
      .filter((device) => device.kind === "browser" && !device.memberId)
      .sort((a, b) => Number(this.isLive(b.id)) - Number(this.isLive(a.id)) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  }

  /** Paired browser extensions that are enabled (control on). */
  enabledDevices() {
    return this.devices().filter((device) => {
      const state = device.browser;
      return state ? state.enabled !== false : true;
    });
  }

  /** Tools currently available to bots on this host. */
  tools() {
    if (!this.enabledDevices().length) return [];
    return BROWSER_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      readOnly: tool.readOnly === true,
      source: "browser",
    }));
  }

  /** Updates what a paired browser extension reports about itself. */
  setState(deviceId, input) {
    const device = this.store.device(deviceId);
    if (device?.kind !== "browser") throw new Failure("Only a browser extension can update browser state.");
    const next = cleanBrowserState(input);
    this.store.setBrowser(deviceId, next);
    this.changed();
    this.onTools();
    return next;
  }

  /** Asks currently waiting for a specific browser device. */
  asksFor(deviceId) {
    return [...this.pending.values()].filter((entry) => entry.ask.deviceId === deviceId).map((entry) => entry.ask);
  }

  /**
   * Lean sync view for a browser extension device: only `meta` and its own `asks`.
   * This prevents chat/run/space streaming from ever crossing the relay to an idle browser extension.
   */
  view(device, parts, nextVersion) {
    const view = this.views.get(device.id) ?? new Map();
    const rawMeta = parts.get("meta")?.json;
    const meta = rawMeta ? JSON.parse(rawMeta) : {};
    const put = (name, value) => {
      const json = JSON.stringify(value);
      if (view.get(name)?.json !== json) view.set(name, { json, v: nextVersion() });
    };
    put("meta", {
      app: meta.app,
      version: meta.version,
      name: meta.name,
      serverId: meta.serverId,
      protocol: meta.protocol,
      capabilities: meta.capabilities ?? [],
      you: { kind: "browser", deviceId: device.id },
    });
    put("asks", this.asksFor(device.id));
    view.names = ["meta", "asks"];
    view.texts = new Set();
    this.views.set(device.id, view);
    return view;
  }

  /** Lists paired browser extensions with live connection and control state. */
  listDevices() {
    return this.devices().map((device) => ({
      id: device.id,
      name: device.name,
      platform: device.platform,
      connected: this.isLive(device.id),
      enabled: device.browser ? device.browser.enabled !== false : true,
      mode: device.browser?.mode ?? "all",
      ...(device.browser?.browser && { browser: device.browser.browser }),
      ...(device.browser?.profile && { profile: device.browser.profile }),
      lastSeenAt: device.lastSeenAt,
    }));
  }

  /** Resolves a target browser by id or name (or picks the most recently active enabled browser). */
  pickDevice(selector) {
    const enabled = this.enabledDevices();
    if (!enabled.length) {
      throw new Error("No Botkins Chromium extension is enabled on this host. Open the Botkins extension in Chrome or Edge and connect it to this host.");
    }
    if (!selector) return enabled[0];
    const query = String(selector).trim();
    const byId = enabled.find((d) => d.id === query);
    if (byId) return byId;
    const lower = query.toLowerCase();
    const exact = enabled.filter((d) => d.name.toLowerCase() === lower || d.browser?.profile?.toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    const partial = enabled.filter((d) => d.name.toLowerCase().includes(lower) || d.browser?.profile?.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    const available = enabled.map((d) => `${d.name} (${d.id})`).join(", ");
    throw new Error(`Could not match browser "${query}". Connected browsers: ${available}.`);
  }

  /**
   * Sends a dedicated internal `secure.fill` ask to a connected enabled browser extension.
   * Never exposed as a bot-callable browser tool; zeroes field values and clears cached asks on completion.
   */
  secureFill(deviceId, payload = {}, { signal } = {}) {
    const device = this.enabledDevices().find((d) => d.id === String(deviceId || ""));
    if (!device || !this.isLive(device.id)) {
      return Promise.reject(new Error("The approved browser extension is no longer connected or enabled."));
    }
    if (this.pending.size >= MAX_ASKS) {
      return Promise.reject(new Error("Too many browser tool calls are waiting. Try again in a moment."));
    }
    if (signal?.aborted) return Promise.reject(new Error("Stopped."));

    const tabId = Number(payload?.tabId);
    const origin = String(payload?.origin || "").trim();
    const rawFields = Array.isArray(payload?.fields) ? payload.fields : [];
    if (!Number.isInteger(tabId) || tabId < 0 || !origin || rawFields.length === 0) {
      return Promise.reject(new Error("Invalid secure fill payload."));
    }
    const allowedKeys = new Set();
    const fields = [];
    for (const item of rawFields) {
      const key = String(item?.key || "").trim();
      const kind = ["text", "password", "code", "secret"].includes(item?.kind) ? item.kind : "text";
      const value = typeof item?.value === "string" ? item.value : "";
      if (!key || !value) {
        zeroSecureFields(fields);
        return Promise.reject(new Error("Invalid secure fill field."));
      }
      allowedKeys.add(key);
      fields.push({ key, kind, value });
    }

    const id = randomBytes(9).toString("base64url");
    const ask = {
      id,
      deviceId: device.id,
      tool: "secure.fill",
      args: {
        tabId,
        origin,
        fields,
        submit: Boolean(payload?.submit),
      },
      at: this.now(),
    };

    return new Promise((resolve, reject) => {
      const done = (settle, value) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        for (const timer of entry.timers) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        zeroSecureFields(ask.args.fields);
        // Drop cached asks JSON immediately so sealed secret payloads are never retained in memory.
        this.views.get(device.id)?.delete("asks");
        this.changed();
        settle(value);
      };
      const onAbort = () => done(reject, new Error("Stopped."));
      const timers = [
        setTimeout(
          () => done(reject, new Error(`Browser "${device.name}" didn't answer in time.`)),
          CALL_MS,
        ),
      ];
      for (const timer of timers) timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        ask,
        tool: { name: "secure.fill", secure: true, allowedKeys },
        timers,
        resolve: (value) => done(resolve, value),
        reject: (error) => done(reject, error),
      });
      this.changed();
    });
  }

  /** Runs a browser tool call and waits for the extension to answer via `link.browser.answer`. */
  call(name, args = {}, { botId, chatId, signal } = {}) {
    const tool = BY_NAME.get(String(name));
    if (!tool) return Promise.reject(new Error("There is no browser tool named " + String(name).slice(0, 60) + "."));
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      return Promise.reject(new Error("The arguments must be an object."));
    }
    if (tool.hostOnly) {
      return Promise.resolve({ browsers: this.listDevices() });
    }
    let device;
    try {
      device = this.pickDevice(args.browser);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.pending.size >= MAX_ASKS) return Promise.reject(new Error("Too many browser tool calls are waiting. Try again in a moment."));
    if (signal?.aborted) return Promise.reject(new Error("Stopped."));

    const { browser: _browser, ...toolArgs } = args;
    const id = randomBytes(9).toString("base64url");
    const ask = {
      id,
      deviceId: device.id,
      tool: tool.name,
      args: toolArgs,
      at: this.now(),
      ...(botId && { botId }),
      ...(chatId && { chatId }),
    };

    return new Promise((resolve, reject) => {
      const done = (settle, value) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        for (const timer of entry.timers) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.changed();
        settle(value);
      };
      const onAbort = () => done(reject, new Error("Stopped."));
      const timers = [
        setTimeout(
          () => done(reject, new Error(`Browser "${device.name}" didn't answer in time. Check that Chrome/Edge is open and the Botkins extension is connected.`)),
          CALL_MS,
        ),
      ];
      for (const timer of timers) timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { ask, tool, timers, resolve: (value) => done(resolve, value), reject: (error) => done(reject, error) });
      this.changed();
    });
  }

  /** Extension answer to one of its asks. */
  answer(deviceId, id, answer) {
    const entry = this.pending.get(String(id));
    if (!entry || entry.ask.deviceId !== deviceId) throw new Failure("That browser request is no longer open.");
    if (answer?.ok !== true) {
      const error = new Error(typeof answer?.error === "string" && answer.error ? answer.error.slice(0, 600) : "The browser extension couldn't complete that action.");
      if (entry.tool.secure && typeof answer?.code === "string" && SAFE_SECURE_CODES.has(answer.code)) {
        error.secureCode = answer.code;
      }
      return entry.reject(error);
    }
    let result = answer.result ?? null;
    if (entry.tool.secure) {
      const allowed = entry.tool.allowedKeys;
      const filled = Array.isArray(result?.filled) ? result.filled.filter((k) => typeof k === "string" && allowed.has(k)) : [];
      const missing = Array.isArray(result?.missing) ? result.missing.filter((k) => typeof k === "string" && allowed.has(k)) : [];
      return entry.resolve({ filled, missing });
    }
    if (entry.tool.file && (result?.path || result?.uploadId)) {
      const path = this.uploads?.ownFile(deviceId, result.path ?? result.uploadId);
      if (!path) return entry.reject(new Error("The browser screenshot didn't arrive."));
      const { uploadId: _uploadId, ...rest } = result;
      result = { ...rest, path };
    }
    let text;
    try {
      text = JSON.stringify(result);
    } catch {
      return entry.reject(new Error("The browser extension's answer couldn't be read."));
    }
    if (text.length > MAX_RESULT) return entry.reject(new Error("The browser extension's answer was too large."));
    entry.resolve(result);
  }

  forget(deviceId) {
    this.views.delete(deviceId);
    for (const entry of [...this.pending.values()]) {
      if (entry.ask.deviceId === deviceId) entry.reject(new Error("That browser extension was removed."));
    }
    this.onTools();
  }

  dispose() {
    for (const entry of [...this.pending.values()]) entry.reject(new Error("Botkins is closing."));
  }
}
