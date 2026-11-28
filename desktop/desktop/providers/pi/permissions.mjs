import { displayValue } from "../../display.mjs";
import { fileReadPermission, fileWritePermission, mcpPermission, permissionRequest } from "../permission-request.mjs";

const READS = new Set(["read", "grep", "find", "ls"]);
const WRITES = new Set(["write", "edit"]);

function writePreview(name, input) {
  if (name === "write" && typeof input.content === "string") return input.content;
  if (name === "edit") {
    // Pi batches replacements; older Pi-compatible tools pass one replacement at the top level.
    const edits = input.edits ?? [input];
    if (Array.isArray(edits) && edits.length && edits.every((e) => typeof e?.oldText === "string" && typeof e.newText === "string"))
      return edits.flatMap(({ oldText, newText }) => [
        ...oldText.split("\n").map((line) => "-" + line),
        ...newText.split("\n").map((line) => "+" + line),
      ]).join("\n");
  }
  return displayValue(input, Infinity);
}

export function describeToolCall(call, { name, server, configured }) {
  const input = call.input && typeof call.input === "object" ? call.input : {};
  const target = input.path ?? input.file_path;
  const path = typeof target === "string" && (input.path == null || input.file_path == null || input.path === input.file_path) ? target : "";
  const detail = displayValue(call, Infinity);
  const common = { toolName: name, detail, managed: !!call.managed, sandboxEscape: !!call.sandboxEscape };
  if (server)
    return permissionRequest({
      ...common, kind: "mcp",
      ...mcpPermission({
        server, tool: name, preview: displayValue(input, Infinity),
        exact: configured && call.registryServer === server && call.registryTool === name,
        readOnly: configured && call.registryServer === server && call.readOnly === true,
      }),
    });
  if (name === "bash") {
    const command = String(input.command ?? "");
    return permissionRequest({ ...common, kind: "shell", label: "Shell command", title: "Run this command?", preview: command, remember: call.native === true && command ? ["this exact command", command] : null });
  }
  // OMP's hashline patch may change, delete or move multiple files. Show exactly what OMP
  // received; neither an apparent path nor the first file header defines a reusable scope.
  if (call.native === true && name === "edit" && typeof input.input === "string")
    return permissionRequest({ ...common, kind: "write", label: "File change", preview: input.input });
  if (call.native === true && WRITES.has(name))
    return permissionRequest({ ...common, kind: "write", ...fileWritePermission(path, writePreview(name, input)) });
  if (call.native === true && READS.has(name))
    return permissionRequest({ ...common, kind: "read", ...fileReadPermission(path, { exact: name === "read" }) });
  return permissionRequest({ ...common, kind: "custom-tool", label: name, title: "Use " + name + "?", preview: displayValue(input, Infinity) });
}
