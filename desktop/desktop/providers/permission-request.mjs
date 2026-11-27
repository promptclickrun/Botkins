import { isAbsolute, parse } from "node:path";

/** A permission card and its policy flags, shared by the harness adapters. */
export function permissionRequest({ kind, toolName, title, label, preview, detail, remember = null, readOnly = false, managed = false, sandboxEscape = false }) {
  return {
    kind, toolName,
    title: title || `Approve ${toolName || kind}?`,
    label,
    preview,
    detail,
    remember: managed || sandboxEscape ? null : remember,
    readOnly,
    managed,
    sandboxEscape,
  };
}

/** No directory-relative grant can follow a chat to another project. */
export function absolutePermissionPath(path) {
  return typeof path === "string" && !path.includes("\0") && isAbsolute(path) &&
    (process.platform !== "win32" || parse(path).root.length > 1);
}

export function fileReadPermission(path, { exact = true } = {}) {
  return {
    label: "Read file",
    preview: typeof path === "string" ? path : "",
    remember: exact && absolutePermissionPath(path) ? ["reads of this path", path] : null,
    readOnly: typeof path === "string" && !!path && !path.includes("\0"),
  };
}

export function fileWritePermission(path, preview, otherPaths = []) {
  return {
    label: path || "File change",
    preview,
    remember: [path, ...otherPaths].every(absolutePermissionPath)
      ? ["writes to this path", path, ...otherPaths] : null,
  };
}

export const permissionName = (value) => typeof value === "string" && !!value.trim() && !value.includes("\0");

export function mcpPermission({ server, tool, serverLabel, preview, exact = true, readOnly }) {
  const named = permissionName(server) && permissionName(tool);
  return {
    label: [serverLabel || server, tool].filter(permissionName).join(" / ") || "MCP tool",
    preview,
    remember: named && exact ? [`MCP tool ${server}/${tool}`, server, tool] : null,
    readOnly: named && readOnly === true,
  };
}
