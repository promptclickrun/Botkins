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
const SECURE_ROLE_RE = /secure|password|secret/i;

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
  if (node.secure === true || node.is_secure === true || node.isSecure === true || node.password === true) return true;
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
      focused: value.focused === true || value.is_focused === true,
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
      for (const entry of this.#pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
      }
      this.#pending.clear();
      if (this.#child === child) {
        this.#child = null;
        this.#rl?.close();
        this.#rl = null;
        this.#ready = null;
      }
    };
    child.on("error", (err) => failAll(`Failed to start cua-driver: ${err.message}`));
    child.on("exit", (code, signal) => {
      const detail = stderrBuf.trim() ? ` (${stderrBuf.trim().slice(0, 200)})` : "";
      failAll(`cua-driver exited (${signal ?? code ?? "unknown"})${detail}`);
    });
    this.#rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg.id == null) return;
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
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
  #focusedSecure = new Map(); // `${pid}:${windowId ?? ""}` -> { token, app, windowTitle, at }

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

  #rememberObserved(pid, windowId, data) {
    const app = typeof data?.app === "string" ? data.app : typeof data?.app_name === "string" ? data.app_name : undefined;
    const windowTitle = typeof data?.window_title === "string" ? data.window_title : typeof data?.title === "string" ? data.title : undefined;
    const nodes = collectNodes(data);
    const focusKey = `${pid}:${windowId ?? ""}`;
    this.#focusedSecure.delete(focusKey);
    const now = Date.now();
    for (const node of nodes) {
      const key = `${pid}:${node.token}`;
      this.#tokens.delete(key);
      this.#tokens.set(key, {
        secure: node.secure,
        role: node.role,
        title: node.title,
        app,
        windowTitle,
        windowId,
        at: now,
      });
      if (node.secure && node.focused) {
        this.#focusedSecure.set(focusKey, { token: node.token, app, windowTitle, at: now });
      }
      if (this.#tokens.size > MAX_TRACKED_TOKENS) {
        this.#tokens.delete(this.#tokens.keys().next().value);
      }
    }
    return { app, windowTitle };
  }

  #checkSecureFieldRefusal(args) {
    if (args.action !== "type_text" && args.action !== "set_value") return;
    if (args.element_token) {
      const meta = this.#tokens.get(`${args.pid}:${args.element_token}`);
      if (meta?.secure) {
        throw new Error(
          `Refused ${args.action} on secure/password field "${args.element_token}" (${meta.role ?? "AXSecureTextField"}). ` +
            `Never type secrets directly; call request_secure_input with operation: "native_fill" and target: { pid: ${args.pid}, element_token: "${args.element_token}"${args.window_id ? `, window_id: "${args.window_id}"` : ""} } so the person fills it through the Botkins vault.`,
        );
      }
    } else if (args.action === "type_text") {
      const focused =
        this.#focusedSecure.get(`${args.pid}:${args.window_id ?? ""}`) ??
        this.#focusedSecure.get(`${args.pid}:`);
      if (focused && Date.now() - focused.at < 5 * 60_000) {
        throw new Error(
          `Refused type_text because the focused field (${focused.token}) is a secure/password field. ` +
            `Call request_secure_input with operation: "native_fill" and target: { pid: ${args.pid}, element_token: "${focused.token}"${args.window_id ? `, window_id: "${args.window_id}"` : ""} }.`,
        );
      }
    }
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
    const callArgs = {
      pid: args.pid,
      ...(args.window_id !== undefined && { window_id: String(args.window_id) }),
      ...(args.max_depth !== undefined && { max_depth: args.max_depth }),
      ...(args.query !== undefined && { query: String(args.query) }),
      // Always capture a screenshot for the live Screen stream; strip from model response unless requested.
      include_screenshot: true,
    };
    const { data, image } = await this.client.callTool("get_window_state", callArgs, { signal });
    const meta = this.#rememberObserved(args.pid, args.window_id, data);
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
    this.#checkSecureFieldRefusal(args);
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
   * Writes the approved secret directly via cua-driver `set_value` without returning or logging it.
   */
  async secureSetValue({ pid, window_id, element_token, app, window_title, value }, { botId, botName, signal } = {}) {
    if (!this.enabled()) throw new Error("Computer use is off on this computer. Turn it on in Settings › Access.");
    if (!Number.isInteger(pid) || pid < 1 || typeof element_token !== "string" || !element_token.trim()) {
      throw new Error("Invalid native secure field target.");
    }
    if (typeof value !== "string" || !value.length) throw new Error("Missing secure value.");
    const meta = this.#tokens.get(`${pid}:${element_token}`);
    const { data, image } = await this.client.callTool(
      "set_value",
      {
        pid,
        ...(window_id !== undefined && { window_id: String(window_id) }),
        element_token,
        text: value,
        value,
        delivery_mode: "background",
      },
      { signal },
    );
    this.#emitActivity(
      {
        botId,
        botName,
        action: "secure_fill",
        summary: `Filled a secure field in ${app ?? meta?.app ?? `PID ${pid}`} from the vault`,
        app: app ?? meta?.app,
        windowTitle: window_title ?? meta?.windowTitle,
        deliveryMode: "background",
        pointerUntouched: true,
      },
      image,
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
    const checkActive = () => {
      if (task?.stopped || task?.ended || this.ws.closing || (run && this.ws.active?.get(chat.id) !== task)) {
        throw new Error("This turn is no longer active.");
      }
      if (!this.enabled()) throw new Error("Computer use was turned off in Settings.");
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
        handler: async (args) => {
          checkActive();
          const result = await this.apps(args ?? {});
          return JSON.stringify(result);
        },
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
        handler: async (args) => {
          checkActive();
          const result = await this.observe(args, { botId: bot?.id, botName: bot?.name });
          return JSON.stringify(result);
        },
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
        handler: async (args) => {
          checkActive();
          const validated = validateActArgs(args);
          // Refuse secure fields before even asking approval.
          this.#checkSecureFieldRefusal(validated);
          const meta = validated.element_token ? this.#tokens.get(`${validated.pid}:${validated.element_token}`) : null;
          const summary = summarizeAction(validated);
          const decision = await this.ws.interactions.permission(chat, task, {
            kind: "custom-tool",
            label: "Computer action",
            title: summary,
            detail: [
              meta?.app ? `App: ${meta.app} (PID ${validated.pid})` : `PID: ${validated.pid}`,
              ...(meta?.windowTitle ? [`Window: ${meta.windowTitle}`] : []),
              `Delivery: ${validated.delivery_mode}${validated.delivery_mode === "background" ? " (leaves your pointer untouched)" : ""}`,
            ].join("\n"),
            preview: validated.action === "type_text" || validated.action === "set_value" ? `${validated.action} (${validated.text.length} chars)` : summary,
            readOnly: false,
            remember: ["Allow computer actions in this chat", "computer_act"],
          });
          if (!decision?.allow) throw new Error("The person declined this computer action.");
          checkActive();
          const result = await this.act(validated, { botId: bot?.id, botName: bot?.name });
          return JSON.stringify(result);
        },
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
        handler: async (args) => {
          checkActive();
          const result = await this.desktop(args ?? {}, { botId: bot?.id, botName: bot?.name });
          return JSON.stringify(result);
        },
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
