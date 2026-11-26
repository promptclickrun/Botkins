#!/usr/bin/env node
// Fake stdio MCP server mimicking cua-driver for unit and integration tests.
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Tiny valid 1x1 JPEG (base64).
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

const logFile = process.env.FAKE_CUA_LOG || "";
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
  logCall({ name, args });

  if (name === "list_apps") {
    const apps = [
      { pid: 4242, name: "Safari", bundle_id: "com.apple.Safari", active: true, background: false },
      { pid: 5151, name: "Notes", bundle_id: "com.apple.Notes", active: false, background: false },
    ];
    if (args.include_background) {
      apps.push({ pid: 9999, name: "HelperDaemon", bundle_id: "com.example.Helper", active: false, background: true });
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ apps }) }],
      structuredContent: { apps },
    };
  }

  if (name === "get_window_state") {
    const pid = Number(args.pid || 4242);
    const app = pid === 5151 ? "Notes" : "Safari";
    const payload = {
      pid,
      app,
      window_id: args.window_id || "win-1",
      window_title: `${app} — Sign In`,
      elements: [
        { element_token: "tok-search", role: "AXTextField", label: "Search", value: "", secure: false },
        { element_token: "tok-password", role: "AXSecureTextField", label: "Password", value: "", secure: true },
        { element_token: "tok-submit", role: "AXButton", label: "Sign In", secure: false },
      ],
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
    const result = handleToolCall(req.params?.name, req.params?.arguments || {});
    send({ jsonrpc: "2.0", id: req.id, result });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32601, message: `Unknown method: ${req.method}` },
  });
});
