// Plain logic for a chat's extras: a side question (/btw, /ask), a quoted reply, and the lines of a
// file's changes. No React Native imports, so tests/bots-chats.test.ts runs it.
import type { ChangedFile } from "@/link/types";

/** "/btw <question>" or "/ask <question>": a question answered beside the chat, not in it. `question` is "" when none was written. */
export function sideQuestionOf(text: string): { command: "btw" | "ask"; question: string } | null {
  const match = /^\/(btw|ask)(?=\s|$)\s*([\s\S]*)$/i.exec(text.trim());
  if (!match) return null;
  return { command: match[1].toLowerCase() as "btw" | "ask", question: match[2].trim() };
}

/** What a Reply quotes: the message's text, trimmed, at most 1,200 characters (the computer's limit). */
export const quoteOf = (text: string) => text.trim().slice(0, 1200);

export type DiffLine = "file" | "add" | "del" | "hunk" | "plain";
/** How one line of a diff is drawn. */
export function diffLineKind(line: string): DiffLine {
  if (line.startsWith("+++") || line.startsWith("---")) return "file";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("@@")) return "hunk";
  return "plain";
}

/** A changed file's one letter: M, A, D, R or U. */
export const kindLetter = (kind: ChangedFile["kind"]) => kind[0].toUpperCase();
/** "old → new" for a renamed file, else its path. */
export const changedPath = (file: Pick<ChangedFile, "path" | "from">) => (file.from ? file.from + " → " + file.path : file.path);
/** "3 files". */
export const fileCount = (count: number) => count + (count === 1 ? " file" : " files");
