// The phone's host for an MCP App's view in a chat (the computer's desktop/mcp-apps.mjs keeps the
// view, the tool's input and its result). Plain logic, no React Native: tests/mcp-app.test.ts runs it.
//
// The view is one page in a web view, built by `mcpAppPage`: the app's own head comes first (the
// policy made from the origins the view's server declared, and a guard), then the view's markup. An
// MCP App talks to `window.parent` by postMessage; in a web view the page is its own parent, so
// `MCP_APP_BRIDGE` (injected before the page's code runs) sends what the page posts to the app
// instead, and the app answers with message events from that same parent. `createMcpHost` speaks the
// host's side of MCP Apps ("ui/initialize", then the tool's input and result, the view's tool calls
// and resource reads, links, size and theme), with the calls themselves given by the screen.
import type { McpAppView, McpToolResult } from "@/link/types";

/** The MCP Apps protocol version this host speaks, as the official AppBridge does. */
export const MCP_APPS_PROTOCOL = "2026-01-26";
/** How tall a view may be, in points. */
export const VIEW_MIN = 80;
export const VIEW_MAX = 2000;

export type HostContext = { theme: "light" | "dark"; platform: "mobile"; displayMode: "inline"; availableDisplayModes: ["inline"]; deviceCapabilities: { touch: true; hover: false } };

/** What the screen does for the view: its server's calls (through the computer), links, size, and "ready". */
export type HostCalls = {
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  readResource: (uri: string) => Promise<unknown>;
  /** Asks the person, then opens it. Resolves whether it was opened. */
  openLink: (url: string) => Promise<boolean>;
  size: (height: number) => void;
  ready: () => void;
};

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const MAX_MESSAGE = 2_000_000;

/**
 * The host's side of one view. `post` sends a JSON-RPC message to the page. `receive` takes what the
 * page sent (a string from the web view) and answers it. The tool's input and its result go once,
 * after the view said it is initialized.
 */
export function createMcpHost(view: McpAppView, context: HostContext, calls: HostCalls, post: (message: object) => void) {
  let initialized = false;
  let nextId = 1;
  let current = context;
  const reply = (id: unknown, result: unknown) => post({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, code: number, message: string) => post({ jsonrpc: "2.0", id, error: { code, message } });
  const notify = (method: string, params: object) => post({ jsonrpc: "2.0", method, params });

  async function request(id: unknown, method: string, params: Record<string, unknown>) {
    switch (method) {
      case "ui/initialize":
        return reply(id, {
          protocolVersion: params.protocolVersion === MCP_APPS_PROTOCOL ? params.protocolVersion : MCP_APPS_PROTOCOL,
          hostInfo: { name: "Botkins", version: "1" },
          hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {} },
          hostContext: { ...current, toolInfo: { tool: { ...view.tool, inputSchema: { type: "object", ...view.tool.inputSchema } } } },
        });
      case "ping":
        return reply(id, {});
      case "tools/call": {
        if (typeof params.name !== "string" || !params.name) return fail(id, -32602, "Name the tool.");
        return reply(id, await calls.callTool(params.name, record(params.arguments)));
      }
      case "resources/read":
        if (typeof params.uri !== "string" || !params.uri) return fail(id, -32602, "Name the resource.");
        return reply(id, await calls.readResource(params.uri));
      case "ui/open-link":
        if (typeof params.url !== "string") return fail(id, -32602, "Give the address.");
        return reply(id, (await calls.openLink(params.url)) ? {} : { isError: true });
      case "ui/request-display-mode":
        return reply(id, { mode: "inline" });
      default:
        return fail(id, -32601, "Method not found: " + method);
    }
  }

  return {
    /** A message the page posted. Anything that isn't JSON-RPC 2.0 is ignored. */
    async receive(raw: string) {
      if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return;
      let message: Message;
      try {
        message = JSON.parse(raw) as Message;
      } catch {
        return;
      }
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
      const params = record(message.params);
      if (message.id === undefined || message.id === null) {
        if (message.method === "ui/notifications/initialized" && !initialized) {
          initialized = true;
          notify("ui/notifications/tool-input", { arguments: view.input });
          notify("ui/notifications/tool-result", view.result);
          calls.ready();
        } else if (message.method === "ui/notifications/size-changed" && typeof params.height === "number" && Number.isFinite(params.height)) calls.size(Math.round(Math.min(VIEW_MAX, Math.max(VIEW_MIN, params.height))));
        return;
      }
      try {
        await request(message.id, message.method, params);
      } catch (error) {
        fail(message.id, -32603, error instanceof Error ? error.message : "That didn't work.");
      }
    },
    /** The app's look, before the view starts or as it changes. */
    theme(theme: "light" | "dark") {
      if (theme === current.theme) return;
      current = { ...current, theme };
      if (initialized) notify("ui/notifications/host-context-changed", { theme });
    },
    /** The card is going away: the view may save what it holds. */
    teardown() {
      if (initialized) post({ jsonrpc: "2.0", id: "teardown-" + nextId++, method: "ui/resource-teardown", params: {} });
    },
  };
}

/** The view's policy, from the origins its server declared (the computer kept only https and wss ones). */
export function mcpAppCsp(csp: McpAppView["csp"]): string {
  const clean = (list: string[], scheme: RegExp) => list.filter((origin) => scheme.test(origin) && /^[a-z]+:\/\/[a-zA-Z0-9.*:-]+$/.test(origin));
  const resources = clean(csp.resourceDomains, /^https:\/\//);
  const connect = clean(csp.connectDomains, /^(https|wss):\/\//);
  const from = (base: string) => [base, ...resources].join(" ");
  return [
    "default-src 'none'",
    "script-src " + from("'unsafe-inline'"),
    "style-src " + from("'unsafe-inline'"),
    "img-src " + from("data: blob:"),
    "font-src " + from("data:"),
    "media-src " + from("data: blob:"),
    "connect-src " + (connect.length ? connect.join(" ") : "'none'"),
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * The page the web view loads: the app's head first, so the policy holds before anything of the view's,
 * then the view's markup in the body (its own head and body tags are read there as their contents).
 */
export function mcpAppPage(view: McpAppView, nestedGuard: string): string {
  const head =
    '<meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + mcpAppCsp(view.csp) + '">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">' +
    // The app's theme reaches the view through MCP Apps' host context; the page's defaults follow the phone.
    "<style>:root{color-scheme:light dark}html,body{margin:0;background:transparent}</style>" +
    "<script>" + nestedGuard + "</script>";
  return "<!doctype html><html><head>" + head + "</head><body>" + (view.html ?? "") + "</body></html>";
}

/**
 * Runs in the page before its own code: what the page posts to its parent goes to the app, and the
 * app's messages arrive as message events from that parent. The ways to talk peer to peer are taken away.
 */
export const MCP_APP_BRIDGE = String.raw`(() => {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate", "WebTransport"]) {
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  }
  const relay = window.ReactNativeWebView;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const Event = MessageEvent;
  const fire = EventTarget.prototype.dispatchEvent.bind(window);
  Object.defineProperty(window, "postMessage", { value: (message) => { try { relay.postMessage(stringify(message)); } catch (e) {} }, configurable: false, writable: false });
  Object.defineProperty(window, "__botkinsMcp", { value: (text) => { try { fire(new Event("message", { data: parse(text), source: window, origin: "null" })); } catch (e) {} }, configurable: false, writable: false });
})();true;`;

/** The script the app runs in the page to hand it one message. */
export const deliver = (message: object) => "window.__botkinsMcp(" + JSON.stringify(JSON.stringify(message)) + ");true;";
