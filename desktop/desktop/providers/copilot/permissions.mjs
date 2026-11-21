// Copilot permission requests, described in Botkins' neutral terms (desktop/providers/provider.mjs).
import { approveAll } from "@microsoft/copilot-sdk";
import { displayValue } from "../../display.mjs";

const escapesSandbox = (req) => !!(req.requestSandboxBypass || req.requestSandboxPermissive || req.sandboxPathGrant);

/** What "Always allow" would cover: [text for the person, ...values that identify the scope]. */
function reusable(req) {
  if (escapesSandbox(req) || req.managedApprovalRequired) return;
  switch (req.kind) {
    case "mcp":
      return ["MCP tool " + req.serverName + "/" + req.toolName, req.serverName, req.toolName];
    case "custom-tool":
      return ["tool " + req.toolName, req.toolName];
    case "read":
      return ["reads of this path", req.resolvedPath || req.path];
    case "write":
      return [
        "writes to this path",
        req.resolvedPath || req.fileName,
        ...new Set((req.fileEdits ?? []).flatMap((e) => [e.before?.path, e.after?.path]).filter(Boolean)),
      ];
    case "shell":
      return ["this exact command", req.fullCommandText];
    case "url":
      return ["this URL", req.url];
  }
}
function describe(req) {
  switch (req.kind) {
    case "shell":
      return { label: "Shell command", preview: req.fullCommandText };
    case "write":
      return { label: req.resolvedPath || req.fileName || "File change", preview: req.diff || req.newFileContents };
    case "read":
      return { label: "Read file", preview: req.resolvedPath || req.path };
    case "mcp":
      return {
        label: [req.serverDisplayName || req.serverName, req.toolName].filter(Boolean).join(" / "),
        preview: displayValue(req.args, Infinity),
      };
    case "custom-tool":
      return { label: req.toolName, preview: displayValue(req.args, Infinity) };
    case "url":
      return { label: "Open URL", preview: req.url };
    case "hook": {
      // A plugin's hook answered "ask" for a tool call. The person agrees to the tool call itself, so the first line is
      // the command (or, for a tool with no command, its arguments, as for other tools), and the hook's own words are the
      // label. Without this the card had an empty first line, and the command was only inside the detail.
      const args = req.toolArgs;
      const command = args && typeof args === "object" && typeof args.command === "string" ? args.command : null;
      return {
        label: typeof req.hookMessage === "string" && req.hookMessage.trim() ? req.hookMessage.trim().slice(0, 300) : "A plugin's hook asks you first",
        preview: command ?? (args === undefined ? "" : displayValue(args, Infinity)),
      };
    }
    default:
      return { label: req.kind, preview: "" };
  }
}

/** The neutral request Botkins' approval rules and prompt work from. */
export function describeRequest(req, invocation = {}) {
  const managed = !!(req.managedApprovalRequired || invocation.managedSettingsEnabled);
  const scope = !managed && reusable(req);
  const remember =
    scope && scope.length > 1 && scope.slice(1).every((v) => typeof v === "string" && v.length > 0) ? scope : null;
  return {
    kind: req.kind,
    toolName: req.toolName,
    // (For a hook's question the title says who asks: a plugin, not the bot.)
    title: req.kind === "hook" ? "A plugin asks before " + (req.toolName || "a tool") + " runs" : req.intention || req.toolTitle || "Approve " + (req.toolName || req.kind) + "?",
    ...describe(req),
    detail: displayValue(req, Infinity),
    remember,
    readOnly: req.kind === "read" || (req.kind === "mcp" && req.readOnly === true),
    sandboxEscape: escapesSandbox(req),
    managed,
  };
}

/** Botkins' answer as the SDK's permission result. */
export function toResult(answer, req, invocation = {}) {
  if (!answer?.allow) return { kind: "reject" };
  return answer.interactive ? { kind: "approve-once", approvedInteractively: true } : approveAll(req, invocation);
}

/** Runs one SDK permission request through a neutral handler. */
export async function decide(handler, req, invocation = {}) {
  return toResult(await handler(describeRequest(req, invocation)), req, invocation);
}
