import type { Capability } from "./types";

/** A slash command, skill, or tool attached to the composer rail instead of inserted as plain text. */
export type DraftCommand = {
  name: string;
  command: string;
  kind: Capability["kind"];
  source: string;
  description: string;
  hint?: string;
  options?: { name: string; description: string }[];
};

export function toDraftCommand(item: Capability): DraftCommand {
  const name = item.name.replace(/^\//, "");
  const command = item.command.replace(/^\//, "");
  return {
    name,
    command,
    kind: item.kind,
    source: item.source,
    description: item.description,
    ...(item.hint ? { hint: item.hint } : {}),
    ...(item.options?.length ? { options: item.options } : {}),
  };
}

/** Combine an attached rail command with the drafted text into the outgoing slash prompt. */
export function composeSlashPrompt(draft: string, command?: DraftCommand | null): string {
  const body = draft.trim();
  if (!command) return body;
  const slash = "/" + command.command.replace(/^\//, "");
  return body ? slash + " " + body : slash;
}

/** Whether the current draft + attached command is a /btw or /ask side question ready to send. */
export function isSideCommand(draft: string, command?: DraftCommand | null): boolean {
  if (/^\/(?:btw|ask)\s+\S/i.test(draft)) return true;
  if (!command) return false;
  return /^(?:btw|ask)$/i.test(command.command.replace(/^\//, "")) && !!draft.trim();
}

export type SlashInput =
  | { mode: "command"; query: string; end: number }
  | { mode: "subcommand"; parent: string; query: string; end: number };

/**
 * Parse a leading "/" trigger at the caret:
 * - "/query" at the start (with optional trailing text after whitespace)
 * - "/parent sub" when typing a subcommand directly
 */
export function parseSlashInput(draft: string, caret = draft.length): SlashInput | null {
  const at = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  if (after && !/^\s/.test(after)) return null;
  const sub = /^\/([^\s/]+) ([^\s]*)$/.exec(before);
  if (sub) return { mode: "subcommand", parent: sub[1], query: sub[2], end: at };
  const cmd = /^\/([^\s/]*)$/.exec(before);
  if (cmd) return { mode: "command", query: cmd[1], end: at };
  return null;
}

/** Remove the leading slash trigger [0, end] (plus one following space) while keeping any drafted body. */
export function stripLeadingTrigger(draft: string, end: number): string {
  return draft.slice(end).replace(/^ /, "");
}

/** Apply a chosen subcommand option to an attached parent command. */
export function applyCommandOption(
  parent: DraftCommand,
  option: { name: string; description: string },
): DraftCommand {
  return {
    name: parent.name + " " + option.name,
    command: parent.command + " " + option.name,
    kind: parent.kind,
    source: parent.source,
    description: option.description || parent.description,
  };
}
