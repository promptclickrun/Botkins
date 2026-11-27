// Copilot permission requests, described in Botkins' neutral terms (desktop/providers/provider.mjs).
import { approveAll } from "@microsoft/copilot-sdk";
import { displayValue } from "../../display.mjs";
import { shownText } from "../../shown-text.mjs";
import { fileReadPermission, fileWritePermission, mcpPermission, permissionRequest } from "../permission-request.mjs";

const escapesSandbox = (req) => !!(req.requestSandboxBypass || req.requestSandboxPermissive || req.sandboxPathGrant);

/** What "Always allow" would cover: [text for the person, ...values that identify the scope]. */
function reusable(req) {
  if (escapesSandbox(req) || req.managedApprovalRequired) return;
  switch (req.kind) {
    case "custom-tool":
      return ["tool " + req.toolName, req.toolName];
    case "shell":
      return ["this exact command", req.fullCommandText];
    case "url":
      return ["this URL", req.url];
  }
}

function editPaths(edits) {
  if (edits === undefined) return [];
  if (!Array.isArray(edits) || edits.some((e) => !e || (!e.before && !e.after))) return [null];
  // Do not discard incomplete sides: they cannot inherit a grant for the primary path alone.
  return [...new Set(edits.flatMap(({ before, after }) => [
    ...(before === undefined ? [] : [before?.path]),
    ...(after === undefined ? [] : [after?.path]),
  ]))];
}

function describe(req) {
  switch (req.kind) {
    case "shell":
      return { label: "Shell command", preview: req.fullCommandText };
    case "read":
      return fileReadPermission(req.resolvedPath || req.path);
    case "write":
      return fileWritePermission(req.resolvedPath || req.fileName, req.diff || req.newFileContents, editPaths(req.fileEdits));
    case "mcp":
      return mcpPermission({ server: req.serverName, serverLabel: req.serverDisplayName, tool: req.toolName,
        preview: displayValue(req.args, Infinity), readOnly: req.readOnly });
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
      // The hook's words are a plugin's text on a card where a person says yes or no. They are made safe to show,
      // kept on one line, and the card says whose words they are: a hook cannot write a line that reads as Botkins'
      // own or as the bot's.
      const said = typeof req.hookMessage === "string" ? shownText(req.hookMessage.trim().replace(/\s+/g, " ")).slice(0, 300) : "";
      return {
        label: said ? "The plugin's hook says: " + said : "A plugin's hook asks you first",
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
  const scope = reusable(req);
  const remember =
    scope && scope.length > 1 && scope.slice(1).every((v) => typeof v === "string" && v.length > 0) ? scope : null;
  return permissionRequest({
    kind: req.kind,
    toolName: req.toolName,
    // (For a hook's question the title says who asks: a plugin, not the bot.)
    title: req.kind === "hook" ? "A plugin asks before " + (req.toolName || "a tool") + " runs" : req.intention || req.toolTitle,
    remember,
    ...describe(req),
    detail: displayValue(req, Infinity),
    sandboxEscape: escapesSandbox(req),
    managed,
  });
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
