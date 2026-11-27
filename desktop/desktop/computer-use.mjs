// Native desktop computer-use layer powered by bundled MIT cua-driver over stdio MCP.
//
// Design:
// - Off by default (`settings.computerUse === false`). Owner chats only (never member chats).
// - Lazy stdio MCP child process (`cua-driver mcp`): never spawned at app startup, closed on exit.
// - Curated 4-tool surface: computer_apps, computer_observe (uses get_window_state, never
//   get_accessibility_tree), computer_act (background delivery default, secure-field refusal,
//   effect/escalation verbatim passthrough, Botkins approval gating), computer_desktop.
// - Vault-backed native fill (`secureSetValue`) for SecureInputs `native_fill` so secrets never
//   enter prompts, tool arguments, or logs.
// - Emits frames and action markers into the Screen stream (`onActivity`) so paired phones see
//   live activity and whether background delivery left the person's pointer untouched.
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { defineTool } from "./providers/provider.mjs";
import { CUA_DRIVER_LICENSE, CUA_DRIVER_VERSION, resolveBundledCuaDriver } from "./cua-driver-bundle.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const CALL_TIMEOUT_MS = 30_000;
const MAX_TRACKED_TOKENS = 1000;
const ACTIONS = ["click", "double_click", "right_click", "type_text", "press_key", "hotkey", "scroll", "drag", "set_value"];
const DELIVERY_MODES = ["background", "foreground"];
const NON_REMEMBERED_ACTIONS = new Set(["type_text", "set_value", "hotkey"]);
const SECURE_ROLE_RE = /secure|password|secret/i;
const FOCUSED_SECURE_TTL_MS = 5 * 60_000;
const TURN_WATCH_MS = 200;

export function formatVisibleText(text, max = 200) {
  if (typeof text !== "string") return "";
  let escaped = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === "\n") escaped += "\\n";
    else if (ch === "\r") escaped += "\\r";
    else if (ch === "\t") escaped += "\\t";
    else if (ch === "\0") escaped += "\\0";
    else if (code < 0x20 || code === 0x7f) {
      escaped += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      escaped += ch;
    }
  }
  if (escaped.length <= max) return escaped;
  return `${escaped.slice(0, max)}… (${text.length} chars)`;
}

function execProgram(file, args, { timeout = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        missing: error?.code === "ENOENT",
      });
    });
    child.stdin?.end();
  });
}

function isSecureNode(node) {
  if (!node || typeof node !== "object") return false;
  if (
    node.secure === true ||
    node.is_secure === true ||
    node.isSecure === true ||
    node.password === true ||
    node.is_password === true ||
    node.isPassword === true
  ) {
    return true;
  }
  for (const field of [node.role, node.subrole, node.control_type, node.type, node.ax_role, node.ax_subrole]) {
    if (typeof field === "string" && SECURE_ROLE_RE.test(field)) return true;
  }
  return false;
}

function collectNodes(value, out = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 24) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, out, depth + 1);
    return out;
  }
  const token = value.element_token ?? value.token;
  if (typeof token === "string" && token) {
    out.push({
      token,
      secure: isSecureNode(value),
      focused:
        value.focused === true ||
        value.is_focused === true ||
        value.isFocused === true ||
        value.has_keyboard_focus === true ||
        value.hasKeyboardFocus === true,
      role: typeof value.role === "string" ? value.role : typeof value.subrole === "string" ? value.subrole : undefined,
      title: typeof value.title === "string" ? value.title : typeof value.label === "string" ? value.label : undefined,
    });
  }
  for (const key of ["children", "elements", "nodes", "tree", "root", "window", "windows"]) {
    if (value[key] !== undefined) collectNodes(value[key], out, depth + 1);
  }
  return out;
}

function parseMcpResult(result) {
  if (!result || typeof result !== "object") return { data: result ?? null, image: null };
  let data = null;
  let image = null;
  if (result.structuredContent && typeof result.structuredContent === "object") {
    data = structuredClone(result.structuredContent);
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (block.type === "image" && typeof block.data === "string" && block.data.length > 0) {
      image = {
        data: block.data,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/jpeg",
      };
    }
  }
  if (data === null && texts.length) {
    const joined = texts.join("\n").trim();
    try {
      data = JSON.parse(joined);
    } catch {
      data = { text: joined };
    }
  }
  if (!image && data && typeof data === "object") {
    const raw = data.screenshot_base64 ?? data.screenshot?.data ?? (typeof data.screenshot === "string" ? data.screenshot : null);
    if (typeof raw === "string" && raw.length > 0) {
      image = {
        data: raw,
        mimeType: data.screenshot?.mimeType ?? data.screenshot_mime_type ?? "image/jpeg",
        width: data.screenshot?.width ?? data.width,
        height: data.screenshot?.height ?? data.height,
      };
    }
  }
  if (result.isError) {
    const message =
      (data && typeof data === "object" && (data.error || data.message || data.text)) ||
      texts[0] ||
      "cua-driver tool call failed.";
    const err = new Error(String(message));
    err.driverResult = data;
    throw err;
  }
  return { data: data ?? {}, image };
}

function stripImageFields(data) {
  if (!data || typeof data !== "object") return data;
  const copy = Array.isArray(data) ? [...data] : { ...data };
  if (!Array.isArray(copy)) {
    delete copy.screenshot_base64;
    if (typeof copy.screenshot === "string") delete copy.screenshot;
    else if (copy.screenshot && typeof copy.screenshot === "object") {
      const { data: _ignored, base64: _b64, ...rest } = copy.screenshot;
      copy.screenshot = Object.keys(rest).length ? rest : undefined;
      if (!copy.screenshot) delete copy.screenshot;
    }
  }
  return copy;
}

function imageToJpegFrame(image) {
  if (!image?.data) return null;
  try {
    const buf = Buffer.from(image.data, "base64");
    if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) {
      return { jpeg: buf, width: image.width, height: image.height };
    }
  } catch {
    // Non-JPEG or invalid base64: ignore frame attachment, still emit marker.
  }
  return null;
}

/**
 * Persistent stdio JSON-RPC 2.0 MCP client for a single cua-driver process.
 * Spawns lazily on first tool call and tears down cleanly on close().
 */
export class CuaDriverClient {
  #child = null;
  #rl = null;
  #ready = null;
  #nextId = 1;
  #pending = new Map();
  #closed = false;

  constructor({ resolveBinary = () => resolveBundledCuaDriver(), command, args, env, timeoutMs = CALL_TIMEOUT_MS } = {}) {
    this.resolveBinary = resolveBinary;
    this.command = command;
    this.args = args;
    this.env = env;
    this.timeoutMs = timeoutMs;
  }

  isRunning() {
    return Boolean(this.#child && !this.#child.killed && this.#child.exitCode === null);
  }

  #resolveLaunch() {
    if (this.command) {
      return { command: this.command, args: this.args ?? ["mcp"] };
    }
    const found = this.resolveBinary();
    if (!found?.path) {
      throw new Error(
        `Bundled cua-driver (${CUA_DRIVER_VERSION}) was not found on this computer. Reinstall Botkins or set BOTKINS_CUA_DRIVER_BIN.`,
      );
    }
    return { command: found.path, args: this.args ?? ["mcp"] };
  }

  async #ensureStarted() {
    if (this.#closed) throw new Error("Computer use client is closed.");
    if (this.#ready && this.isRunning()) return this.#ready;
    const { command, args } = this.#resolveLaunch();
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...(this.env ?? {}) },
    });
    this.#child = child;
    let stderrBuf = "";
    child.stderr?.on("data", (chunk) => {
      stderrBuf = (stderrBuf + String(chunk)).slice(-2000);
    });
    const failAll = (reason) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#rl?.close();
      this.#rl = null;
      this.#ready = null;
      for (const entry of this.#pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
      }
      this.#pending.clear();
    };
    child.on("error", (err) => failAll(`Failed to start cua-driver: ${err.message}`));
    child.on("exit", (code, signal) => {
      const detail = stderrBuf.trim() ? ` (${stderrBuf.trim().slice(0, 200)})` : "";
      failAll(`cua-driver exited (${signal ?? code ?? "unknown"})${detail}`);
    });
    this.#rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#rl.on("line", (line) => {
      if (this.#child !== child) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      // Ignore server notifications; reject server-initiated requests with -32601 so they never collide with pending client calls.
      if (typeof msg.method === "string") {
        if (msg.id !== undefined && msg.id !== null && child.stdin?.writable) {
          try {
            child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32601, message: `Method not found: ${msg.method}` },
              }) + "\n",
            );
          } catch {
            // ignore write error on closing stdin
          }
        }
        return;
      }
      if (msg.id == null) return;
      if (!Object.hasOwn(msg, "result") && !Object.hasOwn(msg, "error")) return;
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (Object.hasOwn(msg, "error") && msg.error != null) {
        const err = new Error(msg.error.message || "cua-driver RPC error");
        err.code = msg.error.code;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
    });

    this.#ready = (async () => {
      await this.#request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "botkins", version: CUA_DRIVER_VERSION },
      });
      this.#notify("notifications/initialized", {});
    })();

    try {
      await this.#ready;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  #notify(method, params) {
    if (!this.#child?.stdin?.writable) return;
    this.#child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  #request(method, params, { signal, timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.#child?.stdin?.writable) {
        reject(new Error("cua-driver process is not running."));
        return;
      }
      if (signal?.aborted) {
        reject(new Error("Computer use request was aborted."));
        return;
      }
      const id = this.#nextId++;
      const onAbort = () => {
        const entry = this.#pending.get(id);
        if (!entry) return;
        this.#pending.delete(id);
        clearTimeout(entry.timer);
        reject(new Error("Computer use request was aborted."));
      };
      const timer = setTimeout(() => {
        const entry = this.#pending.get(id);
        if (!entry) return;
        this.#pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`cua-driver timed out waiting for ${method}.`));
        this.stop();
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        timer,
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      });
      try {
        this.#child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      }
    });
  }

  async callTool(name, args = {}, { signal } = {}) {
    await this.#ensureStarted();
    const raw = await this.#request("tools/call", { name, arguments: args }, { signal });
    return parseMcpResult(raw);
  }

  stop() {
    const child = this.#child;
    this.#child = null;
    this.#ready = null;
    this.#rl?.close();
    this.#rl = null;
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("cua-driver stopped."));
    }
    this.#pending.clear();
    if (child && child.exitCode === null) {
      try {
        child.stdin?.end();
      } catch {}
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  }

  close() {
    this.#closed = true;
    this.stop();
  }
}

function summarizeAction(args) {
  const target = args.element_token
    ? `element ${args.element_token}`
    : args.x != null && args.y != null
      ? `(${Math.round(args.x)}, ${Math.round(args.y)})`
      : `PID ${args.pid}`;
  switch (args.action) {
    case "click":
      return `Click ${target}`;
    case "double_click":
      return `Double-click ${target}`;
    case "right_click":
      return `Right-click ${target}`;
    case "type_text":
      return `Type into ${target}`;
    case "set_value":
      return `Set value on ${target}`;
    case "press_key":
      return `Press ${args.key ?? "key"} in PID ${args.pid}`;
    case "hotkey":
      return `Press ${(args.keys ?? []).join("+")} in PID ${args.pid}`;
    case "scroll":
      return `Scroll ${target}`;
    case "drag":
      return `Drag in PID ${args.pid}`;
    default:
      return `${args.action} on ${target}`;
  }
}

function validateActArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Provide an action object.");
  if (!ACTIONS.includes(args.action)) throw new Error(`Unsupported action "${args.action}". Use one of: ${ACTIONS.join(", ")}.`);
  if (!Number.isInteger(args.pid) || args.pid < 1) throw new Error("pid must be a positive integer.");
  const deliveryMode = args.delivery_mode ?? "background";
  if (!DELIVERY_MODES.includes(deliveryMode)) throw new Error('delivery_mode must be "background" or "foreground".');
  if (args.element_token !== undefined && (typeof args.element_token !== "string" || !args.element_token.trim())) {
    throw new Error("element_token must be a non-empty string.");
  }
  if ((args.action === "type_text" || args.action === "set_value") && typeof args.text !== "string") {
    throw new Error(`${args.action} requires text.`);
  }
  if (args.action === "press_key" && (typeof args.key !== "string" || !args.key.trim())) {
    throw new Error("press_key requires key.");
  }
  if (args.action === "hotkey" && (!Array.isArray(args.keys) || !args.keys.length || args.keys.some((k) => typeof k !== "string" || !k.trim()))) {
    throw new Error("hotkey requires a non-empty keys array.");
  }
  return { ...args, delivery_mode: deliveryMode };
}

export class ComputerUse {
  #tokens = new Map(); // `${pid}:${token}` -> { secure, role, title, app, windowTitle, windowId, at }
  #focusedSecure = new Map(); // `${pid}:${windowId ?? ""}` -> { pid, windowId, token, app, windowTitle, at }

  constructor(
    ws,
    {
      client,
      command,
      args,
      resolveBinary,
      onActivity = () => {},
      screenAdapter = () => null,
      platform = process.platform,
      arch = process.arch,
      env = process.env,
      exec = execProgram,
    } = {},
  ) {
    this.ws = ws;
    this.resolveBinary = resolveBinary ?? (() => resolveBundledCuaDriver({ platform, arch, env }));
    this.client = client ?? new CuaDriverClient({ resolveBinary: this.resolveBinary, command, args, env });
    this.onActivity = onActivity;
    this.screenAdapter = typeof screenAdapter === "function" ? screenAdapter : () => screenAdapter;
    this.platform = platform;
    this.arch = arch;
    this.env = env;
    this.exec = exec;
  }

  enabled() {
    return this.ws?.state?.settings?.computerUse === true;
  }

  #normalizeWindowId(windowId, data) {
    if (windowId !== undefined && windowId !== null && String(windowId).trim() !== "") return String(windowId);
    const fromData = data?.window_id ?? data?.windowId;
    if (fromData !== undefined && fromData !== null && String(fromData).trim() !== "") return String(fromData);
    return undefined;
  }

  #setFocusedSecure(pid, windowId, { token, app, windowTitle }) {
    const wid = windowId !== undefined && windowId !== null && String(windowId).trim() !== "" ? String(windowId) : "";
    const focusKey = `${pid}:${wid}`;
    this.#focusedSecure.set(focusKey, { pid, windowId: wid || undefined, token, app, windowTitle, at: Date.now() });
  }

  #clearFocusedSecure(pid, windowId) {
    const wid = windowId !== undefined && windowId !== null && String(windowId).trim() !== "" ? String(windowId) : "";
    this.#focusedSecure.delete(`${pid}:${wid}`);
    this.#focusedSecure.delete(`${pid}:`);
    if (!wid) {
      for (const key of [...this.#focusedSecure.keys()]) {
        if (key.startsWith(`${pid}:`)) this.#focusedSecure.delete(key);
      }
    }
  }

  #findFocusedSecure(pid, windowId) {
    const now = Date.now();
    const fresh = (entry) => entry && now - entry.at < FOCUSED_SECURE_TTL_MS;
    const wid = windowId !== undefined && windowId !== null && String(windowId).trim() !== "" ? String(windowId) : undefined;
    if (wid !== undefined) {
      const exact = this.#focusedSecure.get(`${pid}:${wid}`);
      if (fresh(exact)) return exact;
      const wildcard = this.#focusedSecure.get(`${pid}:`);
      if (fresh(wildcard)) return wildcard;
      return null;
    }
    const wildcard = this.#focusedSecure.get(`${pid}:`);
    if (fresh(wildcard)) return wildcard;
    for (const [key, entry] of this.#focusedSecure.entries()) {
      if (key.startsWith(`${pid}:`) && fresh(entry)) return entry;
    }
    return null;
  }

  #rememberObserved(pid, windowId, data, { filtered = false } = {}) {
    const app = typeof data?.app === "string" ? data.app : typeof data?.app_name === "string" ? data.app_name : undefined;
    const windowTitle = typeof data?.window_title === "string" ? data.window_title : typeof data?.title === "string" ? data.title : undefined;
    const resolvedWindowId = this.#normalizeWindowId(windowId, data);
    const nodes = collectNodes(data);
    const now = Date.now();
    let sawSecureFocus = false;
    let sawNonSecureFocus = false;
    for (const node of nodes) {
      const key = `${pid}:${node.token}`;
      this.#tokens.delete(key);
      this.#tokens.set(key, {
        secure: node.secure,
        role: node.role,
        title: node.title,
        app,
        windowTitle,
        windowId: resolvedWindowId,
        at: now,
      });
      if (node.focused) {
        if (node.secure) {
          sawSecureFocus = true;
          this.#setFocusedSecure(pid, resolvedWindowId, { token: node.token, app, windowTitle });
        } else {
          sawNonSecureFocus = true;
        }
      }
      if (this.#tokens.size > MAX_TRACKED_TOKENS) {
        this.#tokens.delete(this.#tokens.keys().next().value);
      }
    }
    // Never clear focused-secure on a filtered observe, nor when no non-secure node is positively focused.
    if (!filtered && !sawSecureFocus && sawNonSecureFocus) {
      this.#clearFocusedSecure(pid, resolvedWindowId);
    }
    return { app, windowTitle, windowId: resolvedWindowId, nodes };
  }

  async #inspectWindowNoScreenshot(pid, windowId, { signal } = {}) {
    const callArgs = {
      pid,
      ...(windowId !== undefined && { window_id: String(windowId) }),
      include_screenshot: false,
    };
    const { data } = await this.client.callTool("get_window_state", callArgs, { signal });
    const observed = this.#rememberObserved(pid, windowId, data, { filtered: false });
    const dataPid = data?.pid !== undefined && data?.pid !== null ? Number(data.pid) : pid;
    const dataWindowId =
      data?.window_id !== undefined && data?.window_id !== null
        ? String(data.window_id)
        : data?.windowId !== undefined && data?.windowId !== null
          ? String(data.windowId)
          : undefined;
    return { ...observed, data, dataPid, dataWindowId };
  }

  /**
   * Verifies a `native_fill` target against the observed token cache before creating
   * a vault approval card. Never trusts model-supplied app/window titles.
   */
  resolveCachedSecureTarget(target) {
    if (!this.enabled()) throw new Error("Computer use is off on this computer. Turn it on in Settings › Access.");
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error("Invalid native secure field target.");
    }
    const { pid, element_token, window_id } = target;
    if (!Number.isInteger(pid) || pid < 1 || typeof element_token !== "string" || !element_token.trim()) {
      throw new Error("Invalid native secure field target.");
    }
    const meta = this.#tokens.get(`${pid}:${element_token}`);
    if (!meta || meta.secure !== true) {
      throw new Error(
        `Refused native_fill: element "${element_token}" on PID ${pid} is not a verified secure/password field in the observed window state. Call computer_observe first.`,
      );
    }
    if (window_id !== undefined && meta.windowId !== undefined && String(window_id) !== String(meta.windowId)) {
      throw new Error(
        `Refused native_fill: element "${element_token}" does not belong to window "${window_id}".`,
      );
    }
    const effectiveWindowId = window_id !== undefined ? String(window_id) : meta.windowId;
    return {
      pid,
      element_token,
      ...(effectiveWindowId !== undefined && { window_id: effectiveWindowId }),
      ...(meta.app && { app: meta.app }),
      ...(meta.windowTitle && { window_title: meta.windowTitle }),
    };
  }

  /**
   * Re-reads live window state (without screenshot) before every `type_text`/`set_value`
   * and fails closed if the target or focused element is secure or cannot be resolved.
   */
  async verifyWritableTarget(args, { signal } = {}) {
    if (args.action !== "type_text" && args.action !== "set_value") return null;
    let fresh;
    try {
      fresh = await this.#inspectWindowNoScreenshot(args.pid, args.window_id, { signal });
    } catch (err) {
      throw new Error(
        `Refused ${args.action}: could not verify the target window state (${err?.message || "window check failed"}).`,
      );
    }
    if (fresh.dataPid !== args.pid) {
      throw new Error(`Refused ${args.action}: window state PID (${fresh.dataPid}) did not match requested PID (${args.pid}).`);
    }
    if (args.window_id !== undefined && fresh.dataWindowId !== undefined && String(args.window_id) !== fresh.dataWindowId) {
      throw new Error(`Refused ${args.action}: window "${args.window_id}" no longer matches active window "${fresh.dataWindowId}".`);
    }
    const effectiveWindowId = args.window_id !== undefined ? String(args.window_id) : fresh.windowId;

    if (args.element_token) {
      const node = fresh.nodes.find((n) => n.token === args.element_token);
      if (!node) {
        throw new Error(
          `Refused ${args.action}: element_token "${args.element_token}" could not be resolved in the current window state (unknown or stale token). Call computer_observe first.`,
        );
      }
      if (node.secure) {
        throw new Error(
          `Refused ${args.action} on secure/password field "${args.element_token}" (${node.role ?? "AXSecureTextField"}). ` +
            `Never type secrets directly; call request_secure_input with operation: "native_fill" and target: { pid: ${args.pid}, element_token: "${args.element_token}"${effectiveWindowId ? `, window_id: "${effectiveWindowId}"` : ""} } so the person fills it through the Botkins vault.`,
        );
      }
      return fresh;
    }

    // No element_token: fail closed if the focused element is secure, previously clicked secure, or unresolvable.
    const focusedNodes = fresh.nodes.filter((n) => n.focused);
    const focusedSecureNode = focusedNodes.find((n) => n.secure);
    if (focusedSecureNode) {
      throw new Error(
        `Refused ${args.action} because the focused field (${focusedSecureNode.token}) is a secure/password field. ` +
          `Call request_secure_input with operation: "native_fill" and target: { pid: ${args.pid}, element_token: "${focusedSecureNode.token}"${effectiveWindowId ? `, window_id: "${effectiveWindowId}"` : ""} }.`,
      );
    }
    const cachedFocusedSecure = this.#findFocusedSecure(args.pid, effectiveWindowId);
    if (cachedFocusedSecure) {
      throw new Error(
        `Refused ${args.action} because the focused field (${cachedFocusedSecure.token}) is a secure/password field. ` +
          `Call request_secure_input with operation: "native_fill" and target: { pid: ${args.pid}, element_token: "${cachedFocusedSecure.token}"${effectiveWindowId ? `, window_id: "${effectiveWindowId}"` : ""} }.`,
      );
    }
    if (!focusedNodes.length) {
      throw new Error(
        `Refused ${args.action}: the focused element could not be resolved in the current window state. Pass a non-secure element_token from computer_observe, or use request_secure_input with operation: "native_fill" for password fields.`,
      );
    }
    return fresh;
  }

  /**
   * Validates arguments and runs fail-closed secure-field checks before approval (used by node-host).
   */
  async preflightAct(rawArgs, { signal } = {}) {
    const validated = validateActArgs(rawArgs);
    await this.verifyWritableTarget(validated, { signal });
    return validated;
  }

  #emitActivity(marker, image) {
    try {
      const frame = imageToJpegFrame(image);
      this.onActivity(marker, frame);
    } catch {
      // Never let telemetry/stream emission break a tool call.
    }
  }

  async apps({ include_background = false } = {}, { signal } = {}) {
    const { data } = await this.client.callTool(
      "list_apps",
      include_background ? { include_background: true } : {},
      { signal },
    );
    return data;
  }

  async observe(args = {}, { botId, botName, signal } = {}) {
    if (!Number.isInteger(args.pid) || args.pid < 1) throw new Error("pid must be a positive integer.");
    const includeScreenshot = args.include_screenshot === true;
    const filtered = typeof args.query === "string" && args.query.trim().length > 0;
    const callArgs = {
      pid: args.pid,
      ...(args.window_id !== undefined && { window_id: String(args.window_id) }),
      ...(args.max_depth !== undefined && { max_depth: args.max_depth }),
      ...(args.query !== undefined && { query: String(args.query) }),
      // Always capture a screenshot for the live Screen stream; strip from model response unless requested.
      include_screenshot: true,
    };
    const { data, image } = await this.client.callTool("get_window_state", callArgs, { signal });
    const meta = this.#rememberObserved(args.pid, args.window_id, data, { filtered });
    this.#emitActivity(
      {
        botId,
        botName,
        action: "observe",
        summary: `Observed ${meta.app ?? `PID ${args.pid}`}${meta.windowTitle ? ` — ${meta.windowTitle}` : ""}`,
        app: meta.app,
        windowTitle: meta.windowTitle,
        deliveryMode: "background",
        pointerUntouched: true,
      },
      image,
    );
    if (includeScreenshot) {
      return {
        ...data,
        ...(image && !data.screenshot_base64 && { screenshot: { mimeType: image.mimeType, data: image.data } }),
      };
    }
    return stripImageFields(data);
  }

  async desktop(args = {}, { botId, botName, signal } = {}) {
    const includeScreenshot = args?.include_screenshot === true;
    const { data, image } = await this.client.callTool(
      "get_desktop_state",
      { include_screenshot: true },
      { signal },
    );
    this.#emitActivity(
      {
        botId,
        botName,
        action: "desktop",
        summary: "Inspected desktop state",
        deliveryMode: "background",
        pointerUntouched: true,
      },
      image,
    );
    if (includeScreenshot) {
      return {
        ...data,
        ...(image && !data.screenshot_base64 && { screenshot: { mimeType: image.mimeType, data: image.data } }),
      };
    }
    return stripImageFields(data);
  }

  async act(rawArgs, { botId, botName, signal } = {}) {
    const args = validateActArgs(rawArgs);
    await this.verifyWritableTarget(args, { signal });
    const meta = args.element_token ? this.#tokens.get(`${args.pid}:${args.element_token}`) : null;
    const toolArgs = {
      pid: args.pid,
      delivery_mode: args.delivery_mode,
      ...(args.window_id !== undefined && { window_id: String(args.window_id) }),
      ...(args.element_token !== undefined && { element_token: args.element_token }),
      ...(args.x !== undefined && { x: args.x }),
      ...(args.y !== undefined && { y: args.y }),
      ...(args.to_x !== undefined && { to_x: args.to_x }),
      ...(args.to_y !== undefined && { to_y: args.to_y }),
      ...(args.text !== undefined && { text: args.text }),
      ...(args.key !== undefined && { key: args.key }),
      ...(args.keys !== undefined && { keys: args.keys }),
      ...(args.delta_x !== undefined && { delta_x: args.delta_x }),
      ...(args.delta_y !== undefined && { delta_y: args.delta_y }),
      ...(args.allow_fallback !== undefined && { allow_fallback: Boolean(args.allow_fallback) }),
    };
    const driverTool = args.action;
    const { data, image } = await this.client.callTool(driverTool, toolArgs, { signal });
    // Clicking a secure field marks it focused-secure immediately so a subsequent token-less type_text is refused.
    if ((args.action === "click" || args.action === "double_click" || args.action === "right_click") && args.element_token && meta?.secure) {
      const effectiveWindowId = this.#normalizeWindowId(args.window_id ?? meta.windowId, data);
      this.#setFocusedSecure(args.pid, effectiveWindowId, {
        token: args.element_token,
        app: meta.app ?? data?.app,
        windowTitle: meta.windowTitle ?? data?.window_title,
      });
    }
    const actualDelivery =
      data?.delivery_mode === "foreground" || data?.used_foreground === true || args.delivery_mode === "foreground"
        ? "foreground"
        : "background";
    this.#emitActivity(
      {
        botId,
        botName,
        action: args.action,
        summary: summarizeAction(args),
        app: meta?.app ?? data?.app,
        windowTitle: meta?.windowTitle ?? data?.window_title,
        deliveryMode: actualDelivery,
        pointerUntouched: actualDelivery === "background",
        ...(args.x != null && args.y != null && { point: { x: args.x, y: args.y } }),
      },
      image,
    );
    // Pass through effect and escalation verbatim from cua-driver.
    return stripImageFields(data);
  }

  /**
   * Vault-backed fill for SecureInputs (`operation: "native_fill"`).
   * Re-verifies the target via get_window_state (no screenshot) immediately before set_value,
   * fails closed unless the token still resolves to a secure node in the same pid/window,
   * and never emits the value or a screenshot frame to the Screen stream.
   */
  async secureSetValue({ pid, window_id, element_token, value }, { botId, botName, signal } = {}) {
    if (!this.enabled()) throw new Error("Computer use is off on this computer. Turn it on in Settings › Access.");
    if (!Number.isInteger(pid) || pid < 1 || typeof element_token !== "string" || !element_token.trim()) {
      throw new Error("Invalid native secure field target.");
    }
    if (typeof value !== "string" || !value.length) throw new Error("Missing secure value.");

    const failNativeTarget = (message) => {
      const err = new Error(message);
      err.secureCode = "native_target_mismatch";
      throw err;
    };
    let fresh;
    try {
      fresh = await this.#inspectWindowNoScreenshot(pid, window_id, { signal });
    } catch (err) {
      failNativeTarget(
        `Refused native_fill: could not verify target window state (${err?.message || "window check failed"}). Nothing was filled.`,
      );
    }
    if (fresh.dataPid !== pid) {
      failNativeTarget(`Refused native_fill: window PID (${fresh.dataPid}) did not match approved PID (${pid}). Nothing was filled.`);
    }
    if (window_id !== undefined && fresh.dataWindowId !== undefined && String(window_id) !== fresh.dataWindowId) {
      failNativeTarget(`Refused native_fill: window changed after approval. Nothing was filled.`);
    }
    const node = fresh.nodes.find((n) => n.token === element_token);
    if (!node || node.secure !== true) {
      failNativeTarget(
        `Refused native_fill: element "${element_token}" no longer resolves to a secure/password field in the approved window. Nothing was filled.`,
      );
    }

    const effectiveWindowId = window_id !== undefined ? String(window_id) : fresh.windowId;
    const { data } = await this.client.callTool(
      "set_value",
      {
        pid,
        ...(effectiveWindowId !== undefined && { window_id: effectiveWindowId }),
        element_token,
        text: value,
        value,
        delivery_mode: "background",
      },
      { signal },
    );
    // Never emit a screenshot frame or the filled value in the Screen stream for secure_fill.
    this.#emitActivity(
      {
        botId,
        botName,
        action: "secure_fill",
        summary: `Filled a secure field in ${fresh.app ?? `PID ${pid}`} from the vault`,
        app: fresh.app,
        windowTitle: fresh.windowTitle,
        deliveryMode: "background",
        pointerUntouched: true,
      },
      null,
    );
    return {
      applied: true,
      ...(data?.effect !== undefined && { effect: data.effect }),
      ...(data?.escalation !== undefined && { escalation: data.escalation }),
    };
  }

  /**
   * Curated local computer-use tools. Only exposed when `settings.computerUse === true`
   * and the turn belongs to an owner chat (never member/shared chats or helper chats).
   */
  tools(bot, chat, run, task) {
    if (!this.enabled()) return [];
    if (!chat || chat.helper) return [];
    if (this.ws.accessForTurn(chat, task).member) return [];
    const isActive = () =>
      !(task?.stopped || task?.ended || this.ws.closing || (run && this.ws.active?.get(chat.id) !== task));
    const checkActive = () => {
      if (!isActive()) throw new Error("This turn is no longer active.");
      if (!this.enabled()) throw new Error("Computer use was turned off in Settings.");
    };
    const withTurnSignal = async (fn) => {
      checkActive();
      const gone = new AbortController();
      const onTaskAbort = () => gone.abort();
      if (task?.signal?.aborted) gone.abort();
      else task?.signal?.addEventListener?.("abort", onTaskAbort, { once: true });
      const watch = setInterval(() => {
        if (!isActive() || !this.enabled()) gone.abort();
      }, TURN_WATCH_MS);
      watch.unref?.();
      try {
        return await fn(gone.signal);
      } finally {
        clearInterval(watch);
        task?.signal?.removeEventListener?.("abort", onTaskAbort);
      }
    };

    return [
      defineTool("computer_apps", {
        description:
          "List running desktop applications and their PIDs/windows on this computer. Read-only. Call this first to find an app's pid before computer_observe.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            include_background: { type: "boolean", description: "Include background/agent processes (default false)." },
          },
        },
        skipPermission: true,
        handler: async (args) =>
          withTurnSignal(async (signal) => {
            const result = await this.apps(args ?? {}, { signal });
            return JSON.stringify(result);
          }),
      }),
      defineTool("computer_observe", {
        description:
          "Inspect one native desktop app window via accessibility tree (get_window_state) and return element_token handles for computer_act. Omits screenshot pixels by default to save context; pass include_screenshot: true only when you need to visually verify layout.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["pid"],
          properties: {
            pid: { type: "integer", minimum: 1, description: "Process ID from computer_apps." },
            window_id: { type: "string", description: "Optional window identifier when an app has multiple windows." },
            include_screenshot: { type: "boolean", description: "Include base64 screenshot image in the tool result (default false)." },
            max_depth: { type: "integer", minimum: 1, maximum: 20 },
            query: { type: "string", description: "Optional filter for matching elements." },
          },
        },
        skipPermission: true,
        handler: async (args) =>
          withTurnSignal(async (signal) => {
            const result = await this.observe(args, { botId: bot?.id, botName: bot?.name, signal });
            return JSON.stringify(result);
          }),
      }),
      defineTool("computer_act", {
        description:
          "Perform one native desktop UI action on an app window (click, double_click, right_click, type_text, press_key, hotkey, scroll, drag, set_value). Prefer element_token from computer_observe over raw x/y pixels. Defaults to delivery_mode: \"background\" so the person's mouse and focus stay untouched. Never use type_text on password/secure fields — use request_secure_input with operation: \"native_fill\" instead. Returns cua-driver effect and escalation fields verbatim.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["action", "pid"],
          properties: {
            action: { type: "string", enum: ACTIONS },
            pid: { type: "integer", minimum: 1 },
            window_id: { type: "string" },
            element_token: { type: "string" },
            x: { type: "number" },
            y: { type: "number" },
            to_x: { type: "number" },
            to_y: { type: "number" },
            text: { type: "string" },
            key: { type: "string" },
            keys: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
            delta_x: { type: "number" },
            delta_y: { type: "number" },
            delivery_mode: { type: "string", enum: DELIVERY_MODES },
            allow_fallback: { type: "boolean" },
          },
        },
        skipPermission: true,
        handler: async (args) =>
          withTurnSignal(async (signal) => {
            const validated = validateActArgs(args);
            // Re-read live window state and refuse secure/unresolvable fields before even asking approval.
            await this.verifyWritableTarget(validated, { signal });
            const meta = validated.element_token ? this.#tokens.get(`${validated.pid}:${validated.element_token}`) : null;
            const summary = summarizeAction(validated);
            const hasTypedText = validated.action === "type_text" || validated.action === "set_value";
            const visibleText = hasTypedText ? formatVisibleText(validated.text, 200) : "";
            const preview = hasTypedText ? `${validated.action}: "${visibleText}"` : summary;
            const decision = await this.ws.interactions.permission(chat, task, {
              kind: "custom-tool",
              label: "Computer action",
              title: summary,
              detail: [
                meta?.app ? `App: ${meta.app} (PID ${validated.pid})` : `PID: ${validated.pid}`,
                ...(meta?.windowTitle ? [`Window: ${meta.windowTitle}`] : []),
                ...(hasTypedText ? [`Text: ${visibleText}`] : []),
                `Delivery: ${validated.delivery_mode}${validated.delivery_mode === "background" ? " (leaves your pointer untouched)" : ""}`,
              ].join("\n"),
              preview,
              readOnly: false,
              ...(!NON_REMEMBERED_ACTIONS.has(validated.action) && {
                remember: ["Allow computer actions in this chat", "computer_act"],
              }),
            });
            if (!decision?.allow) throw new Error("The person declined this computer action.");
            checkActive();
            const result = await this.act(validated, { botId: bot?.id, botName: bot?.name, signal });
            return JSON.stringify(result);
          }),
      }),
      defineTool("computer_desktop", {
        description:
          "Read the current desktop overview (visible windows, active app, displays) via get_desktop_state. Read-only. Omits screenshot pixels by default unless include_screenshot: true.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            include_screenshot: { type: "boolean", description: "Include base64 screenshot image in the tool result (default false)." },
          },
        },
        skipPermission: true,
        handler: async (args) =>
          withTurnSignal(async (signal) => {
            const result = await this.desktop(args ?? {}, { botId: bot?.id, botName: bot?.name, signal });
            return JSON.stringify(result);
          }),
      }),
    ];
  }

  /**
   * Platform-aware status & permissions check for Settings onboarding.
   */
  async status() {
    const found = this.resolveBinary();
    const bundled = Boolean(found?.path);
    const enabled = this.enabled();
    const base = {
      enabled,
      bundled,
      binarySource: found?.source ?? null,
      version: CUA_DRIVER_VERSION,
      license: CUA_DRIVER_LICENSE,
      platform: this.platform,
    };

    if (this.platform === "darwin") {
      let accessibility = false;
      let screenRecording = false;
      let checkedWith = "electron";
      const screen = this.screenAdapter();
      if (typeof screen?.granted === "function") {
        const g = screen.granted();
        accessibility = Boolean(g?.accessibility);
        screenRecording = Boolean(g?.screenRecording);
      }
      if (bundled) {
        const probe = await this.exec(found.path, ["permissions", "status", "--json"]);
        if (probe.code === 0 && probe.stdout.trim()) {
          try {
            const parsed = JSON.parse(probe.stdout);
            const a = parsed.accessibility ?? parsed.permissions?.accessibility;
            const s = parsed.screen_recording ?? parsed.screenRecording ?? parsed.permissions?.screen_recording ?? parsed.permissions?.screenRecording;
            if (typeof a === "boolean") accessibility = a;
            else if (typeof a?.granted === "boolean") accessibility = a.granted;
            if (typeof s === "boolean") screenRecording = s;
            else if (typeof s?.granted === "boolean") screenRecording = s.granted;
            checkedWith = "cua-driver";
          } catch {
            // Fall back to Electron permission state.
          }
        }
      }
      return {
        ...base,
        supported: true,
        session: "macos",
        ready: bundled && accessibility && screenRecording,
        checkedWith,
        permissions: { accessibility, screenRecording },
        notes: [
          "Botkins uses Accessibility to read app UI elements and send background clicks/keys, and Screen Recording to observe windows and stream live views to your phone.",
        ],
      };
    }

    if (this.platform === "linux") {
      const sessionType = (this.env.XDG_SESSION_TYPE || (this.env.WAYLAND_DISPLAY ? "wayland" : this.env.DISPLAY ? "x11" : "headless")).toLowerCase();
      const wayland = sessionType === "wayland";
      const headless = sessionType === "headless";
      return {
        ...base,
        supported: !headless,
        session: sessionType,
        limited: wayland || headless,
        ready: bundled && !headless,
        permissions: { accessibility: !headless, screenRecording: !headless },
        notes: wayland
          ? [
              "Wayland session detected: compositor isolation limits background input and window inspection for native Wayland apps. XWayland apps work best; use browser tools or node commands when available.",
            ]
          : headless
            ? ["No graphical display (DISPLAY / WAYLAND_DISPLAY) was detected in this session."]
            : ["X11 session detected: native desktop observation and input run directly inside your active display."],
      };
    }

    if (this.platform === "win32") {
      return {
        ...base,
        supported: true,
        session: "windows",
        ready: bundled,
        permissions: { accessibility: true, screenRecording: true },
        notes: [
          "Windows UI Automation works inside your signed-in desktop session. Administrator (UAC-elevated) windows cannot be controlled from a standard-privilege session.",
        ],
      };
    }

    return {
      ...base,
      supported: false,
      session: this.platform,
      ready: false,
      permissions: { accessibility: false, screenRecording: false },
      notes: ["Native computer use is not supported on this operating system."],
    };
  }

  async requestPermission(kind) {
    if (kind !== "accessibility" && kind !== "screenRecording") {
      throw new Error('Permission kind must be "accessibility" or "screenRecording".');
    }
    if (this.platform !== "darwin") return this.status();
    const screen = this.screenAdapter();
    if (typeof screen?.request === "function") {
      await screen.request(kind).catch(() => {});
    }
    const found = this.resolveBinary();
    if (found?.path) {
      const flag = kind === "accessibility" ? "accessibility" : "screen-recording";
      await this.exec(found.path, ["permissions", "grant", flag, "--json"]).catch(() => {});
    }
    return this.status();
  }

  close() {
    this.client.close();
    this.#tokens.clear();
    this.#focusedSecure.clear();
  }
}
