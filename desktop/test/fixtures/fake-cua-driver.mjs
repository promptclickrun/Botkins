#!/usr/bin/env node
// Fake stdio MCP server mimicking cua-driver for unit and integration tests.
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Tiny valid 1x1 JPEG (base64).
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

const logFile = process.env.FAKE_CUA_LOG || "";
const focusedByPid = new Map();

function logCall(entry) {
  if (!logFile) return;
  try {
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
  } catch {
    // ignore
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handleToolCall(name, args = {}) {
  logCall({ name, args, driver_pid: process.pid });

  if (name === "list_apps") {
    const apps = [
      { pid: 4242, name: "Safari", bundle_id: "com.apple.Safari", active: true, background: false },
      { pid: 5151, name: "Notes", bundle_id: "com.apple.Notes", active: false, background: false },
    ];
    if (args.include_background) {
      apps.push({ pid: 9999, name: "HelperDaemon", bundle_id: "com.example.Helper", active: false, background: true });
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ apps, driver_pid: process.pid }) }],
      structuredContent: { apps, driver_pid: process.pid },
    };
  }

  if (name === "get_window_state") {
    const pid = Number(args.pid || 4242);
    const app = pid === 5151 ? "Notes" : "Safari";
    const mutated = Boolean(process.env.FAKE_CUA_MUTATE_SECURE_FILE && existsSync(process.env.FAKE_CUA_MUTATE_SECURE_FILE));
    const focusedToken = process.env.FAKE_CUA_NO_FOCUS_REPORT === "1" ? null : (focusedByPid.get(pid) ?? null);
    let elements = [
      { element_token: "tok-search", role: "AXTextField", label: "Search", value: "", secure: false, focused: focusedToken === "tok-search" },
      mutated
        ? { element_token: "tok-password", role: "AXTextField", label: "Username", value: "", secure: false, focused: focusedToken === "tok-password" }
        : { element_token: "tok-password", role: "AXSecureTextField", label: "Password", value: "", secure: true, focused: focusedToken === "tok-password" },
      { element_token: "tok-uia-pass", role: "Edit", label: "PIN", value: "", is_password: true, focused: focusedToken === "tok-uia-pass" },
      { element_token: "tok-uia-pass2", role: "Edit", label: "Passcode", value: "", isPassword: true, focused: focusedToken === "tok-uia-pass2" },
      { element_token: "tok-submit", role: "AXButton", label: "Sign In", secure: false, focused: focusedToken === "tok-submit" },
    ];
    if (typeof args.query === "string" && args.query.trim()) {
      const q = args.query.trim().toLowerCase();
      elements = elements.filter(
        (el) =>
          el.label.toLowerCase().includes(q) ||
          el.element_token.toLowerCase().includes(q) ||
          el.role.toLowerCase().includes(q),
      );
    }
    const payload = {
      pid,
      app,
      window_id: args.window_id || "win-1",
      window_title: `${app} — Sign In`,
      elements,
    };
    const content = [{ type: "text", text: JSON.stringify(payload) }];
    if (args.include_screenshot) {
      content.push({ type: "image", mimeType: "image/jpeg", data: TINY_JPEG_B64 });
    }
    return { content, structuredContent: payload };
  }

  if (name === "get_desktop_state") {
    const payload = {
      displays: [{ id: "main", width: 1440, height: 900, primary: true }],
      windows: [{ pid: 4242, app: "Safari", window_id: "win-1", title: "Safari — Sign In" }],
    };
    const content = [{ type: "text", text: JSON.stringify(payload) }];
    if (args.include_screenshot) {
      content.push({ type: "image", mimeType: "image/jpeg", data: TINY_JPEG_B64 });
    }
    return { content, structuredContent: payload };
  }

  if ((name === "click" || name === "double_click" || name === "right_click") && args.element_token) {
    focusedByPid.set(Number(args.pid || 4242), args.element_token);
  }

  const deliveryMode = args.delivery_mode || "background";
  const payload = {
    ok: true,
    action: name,
    pid: args.pid,
    window_id: args.window_id || "win-1",
    app: Number(args.pid) === 5151 ? "Notes" : "Safari",
    window_title: Number(args.pid) === 5151 ? "Notes — Main" : "Safari — Sign In",
    element_token: args.element_token || null,
    delivery_mode: deliveryMode,
    effect: {
      delivered: true,
      method: deliveryMode === "background" ? "ax_action" : "cgevent",
      pointer_moved: deliveryMode === "foreground",
      focus_changed: deliveryMode === "foreground",
    },
    escalation:
      args.element_token === "tok-needs-escalation"
        ? { suggested: true, reason: "Control ignored background AXPress; retry with delivery_mode: foreground." }
        : { suggested: false },
  };
  const content = [
    { type: "text", text: JSON.stringify(payload) },
    { type: "image", mimeType: "image/jpeg", data: TINY_JPEG_B64 },
  ];
  return { content, structuredContent: payload };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  // Record client replies to server-initiated requests (no method field).
  if (typeof req.method !== "string") {
    logCall({ client_reply: req });
    return;
  }
  if (req.id === undefined || req.id === null) return; // notification

  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "fake-cua-driver", version: "0.63.2-test" },
        capabilities: { tools: {} },
      },
    });
    return;
  }

  if (req.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: [
          { name: "list_apps" },
          { name: "get_window_state" },
          { name: "get_desktop_state" },
          { name: "click" },
          { name: "type_text" },
          { name: "set_value" },
        ],
      },
    });
    return;
  }

  if (req.method === "tools/call") {
    const toolName = req.params?.name;
    if (toolName === "list_apps" && process.env.FAKE_CUA_HANG_ALWAYS === "1") {
      logCall({ name: toolName, hung: true, driver_pid: process.pid });
      return;
    }
    if (toolName === "list_apps" && process.env.FAKE_CUA_HANG_ONCE_FILE && !existsSync(process.env.FAKE_CUA_HANG_ONCE_FILE)) {
      writeFileSync(process.env.FAKE_CUA_HANG_ONCE_FILE, String(process.pid));
      logCall({ name: toolName, hung: true, driver_pid: process.pid });
      return;
    }
    const result = handleToolCall(toolName, req.params?.arguments || {});
    if (process.env.FAKE_CUA_COLLIDING_SERVER_REQ === "1") {
      // Emit a server-initiated request with the exact same id before the real reply.
      send({ jsonrpc: "2.0", id: req.id, method: "sampling/createMessage", params: { colliding: true } });
      setTimeout(() => send({ jsonrpc: "2.0", id: req.id, result }), 20);
      return;
    }
    send({ jsonrpc: "2.0", id: req.id, result });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32601, message: `Unknown method: ${req.method}` },
  });
});
