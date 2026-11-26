// Pure presentation model for mobile chat & activity displays (Open-mode T3 Code grouping,
// Fold-mode OpenBot partitioning, command/diff parsing, and Activity feed summaries).
import type { Run, RunSummary, Step } from "@/link/types";

export type StepKind =
  | "command"
  | "read"
  | "write"
  | "edit"
  | "search-files"
  | "web"
  | "web-page"
  | "ask"
  | "helper"
  | "plan"
  | "skill"
  | "card"
  | "panel"
  | "tool";

export type DiffLine = {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
};

export type ParsedDiff = {
  lines: DiffLine[];
  added: number;
  removed: number;
  truncated?: boolean;
};

export type ParsedStepInput = {
  kind: StepKind;
  command?: string;
  description?: string;
  filePath?: string;
  fileName?: string;
  query?: string;
  url?: string;
  diff?: ParsedDiff;
};

export type OpenWorkGroup = {
  id: string;
  primaryKind: StepKind;
  steps: Step[];
  running: boolean;
  failedCount: number;
  label: string;
};

export type FoldBlock =
  | { kind: "command"; id: string; step: Step; parsed: ParsedStepInput }
  | { kind: "diff"; id: string; step: Step; parsed: ParsedStepInput }
  | { kind: "group"; id: string; steps: Step[]; kinds: StepKind[]; label: string; running: boolean; failedCount: number };

const KIND_PATTERNS: [RegExp, StepKind][] = [
  [/^(bash|powershell|shell|terminal|run_command|exec|write_bash|write_powershell|read_bash|read_powershell)$/, "command"],
  [/^(view|read|read_file|cat|open_file)$/, "read"],
  [/^(create|write|write_file|create_file)$/, "write"],
  [/^(edit|str_replace|str_replace_editor|apply_patch|patch|multi_edit|insert)$/, "edit"],
  [/^(grep|glob|search|search_files|find|rg|ls|list_dir|list_directory)$/, "search-files"],
  [/^(web_search|search_web|bing_search|google_search)$/, "web"],
  [/^(web_fetch|fetch|fetch_url|browse|browser_navigate)$/, "web-page"],
  [/^(ask_user|ask)$/, "ask"],
  [/^(task|subagent|run_subagent|delegate)$/, "helper"],
  [/^(sql|update_todo|todo|todo_write|todowrite|manage_todo_list)$/, "plan"],
  [/^(skill|read_skill|use_skill)$/, "skill"],
  [/^render_card$/, "card"],
  [/^today_/, "panel"],
];

const QUIET_TOOL = /^(report_intent|think|thinking|task_complete|read_agent|list_agents)$/;
/** Tools whose bot-to-bot interaction renders as a dedicated agent-message rail card when backed by run.teamwork or run.taskHandoffs. */
export const RAIL_COVERED_TEAMWORK_TOOL = /^(ask_teammate|list_node_files|node_read_file|node_write_file|node_mkdir|node_move_file|node_delete_file|node_stat_file|node_search_files|node_exec|node_which|node_screen_info|node_screen_capture|node_screen_input|node_notify)$/i;
export const RAIL_COVERED_TASK_TOOL = /^task_create$/i;

type RailTeamworkRef = { id?: string; toolCallId?: string; message?: string };
type RailTaskHandoffRef = { id?: string; taskId?: string; toolCallId?: string };

function parseJsonObject(text?: string): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function matchesTeamworkCard(
  step: Pick<Step, "id" | "name" | "input">,
  entry: RailTeamworkRef | null | undefined,
): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (entry.toolCallId) return step.id === entry.toolCallId;
  if (String(step.name || "").trim().toLowerCase() === "ask_teammate" && typeof entry.message === "string" && entry.message) {
    const input = parseJsonObject(step.input);
    if (typeof input?.message === "string" && input.message.trim() === entry.message.trim()) return true;
  }
  return false;
}

function matchesTaskHandoffCard(
  step: Pick<Step, "id" | "output">,
  entry: RailTaskHandoffRef | null | undefined,
): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (entry.toolCallId) return step.id === entry.toolCallId;
  const taskId = entry.taskId || entry.id;
  if (taskId) {
    const output = parseJsonObject(step.output);
    if (output?.id === taskId) return true;
  }
  return false;
}

/** True when a tool step is already represented by a sender-side agent-message rail card on this run, so it should not also appear as a tool row. */
export function isStepCoveredByRail(
  step: Pick<Step, "id" | "name" | "status" | "source" | "input" | "output"> | null | undefined,
  run?: { teamwork?: readonly RailTeamworkRef[]; taskHandoffs?: readonly RailTaskHandoffRef[] } | null,
): boolean {
  if (!step || !run || step.source || step.status === "Failed") return false;
  const name = String(step.name || "").trim();
  if (!name) return false;
  if (run.teamwork?.length && RAIL_COVERED_TEAMWORK_TOOL.test(name)) {
    return run.teamwork.some((entry) => matchesTeamworkCard(step, entry));
  }
  if (run.taskHandoffs?.length && RAIL_COVERED_TASK_TOOL.test(name)) {
    return run.taskHandoffs.some((entry) => matchesTaskHandoffCard(step, entry));
  }
  return false;
}

const SUMMARY_WORDS: Record<StepKind, [string, string]> = {
  command: ["Ran a command", "Ran %d commands"],
  read: ["Read a file", "Read %d files"],
  write: ["Created a file", "Created %d files"],
  edit: ["Edited a file", "Edited %d files"],
  "search-files": ["Searched files", "Searched files %d times"],
  web: ["Searched the web", "Searched the web %d times"],
  "web-page": ["Read a web page", "Read %d web pages"],
  ask: ["Asked a question", "Asked %d questions"],
  helper: ["Ran a helper", "Ran %d helpers"],
  plan: ["Updated the plan", "Updated the plan"],
  skill: ["Used a skill", "Used %d skills"],
  card: ["Made a card", "Made %d cards"],
  panel: ["Updated a panel", "Updated panels %d times"],
  tool: ["Used a tool", "Used %d tools"],
};

const RUNNING_WORDS: Record<StepKind, [string, string]> = {
  command: ["Running a command", "Running %d commands"],
  read: ["Reading a file", "Reading %d files"],
  write: ["Creating a file", "Creating %d files"],
  edit: ["Editing a file", "Editing %d files"],
  "search-files": ["Searching files", "Searching files (%d)"],
  web: ["Searching the web", "Searching the web (%d)"],
  "web-page": ["Reading a web page", "Reading %d web pages"],
  ask: ["Asking a question", "Asking %d questions"],
  helper: ["Running a helper", "Running %d helpers"],
  plan: ["Updating the plan", "Updating the plan"],
  skill: ["Using a skill", "Using %d skills"],
  card: ["Making a card", "Making %d cards"],
  panel: ["Updating a panel", "Updating panels (%d)"],
  tool: ["Running a tool", "Running %d tools"],
};

export function toolKind(name?: string | null): StepKind | null {
  const n = String(name || "").toLowerCase().trim();
  if (!n || QUIET_TOOL.test(n)) return null;
  for (const [re, kind] of KIND_PATTERNS) {
    if (re.test(n)) return kind;
  }
  return "tool";
}

export function classifyStep(step?: Step | null): StepKind | null {
  if (!step) return null;
  if (step.source) return "tool";
  const kind = toolKind(step.name);
  if (!kind && step.status === "Failed") return "tool";
  return kind;
}

export function isCodingKind(kind: StepKind | null): boolean {
  return kind === "command" || kind === "edit" || kind === "write";
}

function baseName(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function shortHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function buildOldNewDiff(oldStr: string, newStr: string, maxLines = 80): ParsedDiff {
  const oldLines = oldStr.split(/\r?\n/);
  const newLines = newStr.split(/\r?\n/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const delLines = oldLines.slice(prefix, oldLines.length - suffix);
  const addLines = newLines.slice(prefix, newLines.length - suffix);
  const lines: DiffLine[] = [];
  if (prefix > 0) lines.push({ kind: "ctx", text: oldLines[prefix - 1] });
  for (const text of delLines) lines.push({ kind: "del", text });
  for (const text of addLines) lines.push({ kind: "add", text });
  if (suffix > 0) lines.push({ kind: "ctx", text: oldLines[oldLines.length - suffix] });
  const truncated = lines.length > maxLines;
  return {
    lines: truncated ? lines.slice(0, maxLines) : lines,
    added: addLines.length,
    removed: delLines.length,
    truncated,
  };
}

function parseUnifiedDiff(raw: string, maxLines = 80): { filePath?: string; diff: ParsedDiff } | null {
  const rawLines = raw.split(/\r?\n/);
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let filePath: string | undefined;
  for (const line of rawLines) {
    const patchFile = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/);
    if (patchFile) {
      if (!filePath) filePath = patchFile[1].trim();
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim().replace(/^b\//, "");
      if (target && target !== "/dev/null" && !filePath) filePath = target;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch") || line.startsWith("diff --git ")) {
      continue;
    }
    if (line.startsWith("@@")) {
      lines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      added++;
      lines.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      removed++;
      lines.push({ kind: "del", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      lines.push({ kind: "ctx", text: line.slice(1) });
    }
  }
  if (!lines.length && added === 0 && removed === 0) return null;
  const truncated = lines.length > maxLines;
  return {
    filePath,
    diff: {
      lines: truncated ? lines.slice(0, maxLines) : lines,
      added,
      removed,
      truncated,
    },
  };
}

function buildWriteDiff(text: string, maxLines = 80): ParsedDiff {
  const rawLines = text.split(/\r?\n/);
  const truncated = rawLines.length > maxLines;
  return {
    lines: (truncated ? rawLines.slice(0, maxLines) : rawLines).map((line) => ({ kind: "add", text: line })),
    added: rawLines.length,
    removed: 0,
    truncated,
  };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export function parseStepInput(step: Step): ParsedStepInput {
  const kind = classifyStep(step) ?? "tool";
  const raw = typeof step.input === "string" ? step.input.trim() : "";
  const result: ParsedStepInput = { kind };

  if (raw) {
    let parsedObj: Record<string, unknown> | null = null;
    if (raw.startsWith("{")) {
      try {
        const value: unknown = JSON.parse(raw);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          parsedObj = value as Record<string, unknown>;
        }
      } catch {
        parsedObj = null;
      }
    }

    if (parsedObj) {
      result.command = pickString(parsedObj, ["command", "cmd", "script"]);
      result.description = pickString(parsedObj, ["description", "intent"]);
      result.filePath = pickString(parsedObj, ["path", "file_path", "filePath", "file", "target_file"]);
      result.query = pickString(parsedObj, ["pattern", "query", "q"]);
      result.url = pickString(parsedObj, ["url", "uri"]);

      const oldText =
        typeof parsedObj.old_str === "string"
          ? parsedObj.old_str
          : typeof parsedObj.old_string === "string"
            ? parsedObj.old_string
            : undefined;
      const newText =
        typeof parsedObj.new_str === "string"
          ? parsedObj.new_str
          : typeof parsedObj.new_string === "string"
            ? parsedObj.new_string
            : undefined;
      const patchText =
        typeof parsedObj.patch === "string"
          ? parsedObj.patch
          : typeof parsedObj.diff === "string"
            ? parsedObj.diff
            : undefined;
      const writeText =
        typeof parsedObj.file_text === "string"
          ? parsedObj.file_text
          : typeof parsedObj.content === "string"
            ? parsedObj.content
            : undefined;

      if (oldText !== undefined && newText !== undefined) {
        result.diff = buildOldNewDiff(oldText, newText);
      } else if (patchText) {
        const parsedDiff = parseUnifiedDiff(patchText);
        if (parsedDiff) {
          result.diff = parsedDiff.diff;
          if (!result.filePath && parsedDiff.filePath) result.filePath = parsedDiff.filePath;
        }
      } else if (writeText !== undefined && (kind === "write" || kind === "edit")) {
        result.diff = buildWriteDiff(writeText);
      }
    } else {
      const looksUnified =
        raw.includes("*** Update File:") ||
        raw.includes("*** Add File:") ||
        raw.includes("\n@@ ") ||
        raw.startsWith("@@ ") ||
        raw.includes("\n+++ ");
      if (looksUnified) {
        const parsedDiff = parseUnifiedDiff(raw);
        if (parsedDiff) {
          result.diff = parsedDiff.diff;
          if (parsedDiff.filePath) result.filePath = parsedDiff.filePath;
        }
      } else if (kind === "command") {
        result.command = raw;
      } else if (
        (kind === "read" || kind === "edit" || kind === "write") &&
        !raw.includes("\n") &&
        (raw.includes("/") || raw.includes("\\") || /\.[a-z0-9]+$/i.test(raw))
      ) {
        result.filePath = raw;
      }
    }
  }

  if (result.filePath) {
    result.fileName = baseName(result.filePath);
  }
  if (kind === "command" && !result.command && step.label && step.label !== step.name) {
    result.command = step.label;
  }
  return result;
}

function clipChars(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars - 1).trimEnd() + "…" : text;
}

function firstLine(text: string, maxChars = 100): string {
  const line = text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  return clipChars(line, maxChars);
}

export function stepHeadline(step: Step, parsed: ParsedStepInput = parseStepInput(step)): string {
  const kind = parsed.kind;
  const running = step.status === "Running";
  if (kind === "command") {
    return parsed.description || (parsed.command ? firstLine(parsed.command, 88) : null) || step.label || (running ? "Running command" : "Ran a command");
  }
  if (kind === "edit") {
    if (parsed.fileName) return (running ? "Editing " : "Edited ") + parsed.fileName;
    return step.label && step.label !== step.name ? step.label : running ? "Editing a file" : "Edited a file";
  }
  if (kind === "write") {
    if (parsed.fileName) return (running ? "Creating " : "Created ") + parsed.fileName;
    return step.label && step.label !== step.name ? step.label : running ? "Creating a file" : "Created a file";
  }
  if (kind === "read") {
    if (parsed.fileName) return (running ? "Reading " : "Read ") + parsed.fileName;
    return step.label && step.label !== step.name ? step.label : running ? "Reading a file" : "Read a file";
  }
  if (kind === "search-files") {
    if (parsed.query) return (running ? "Searching for " : "Searched for ") + clipChars(parsed.query, 60);
    return step.label && step.label !== step.name ? step.label : running ? "Searching files" : "Searched files";
  }
  if (kind === "web") {
    if (parsed.query) return (running ? "Searching web: " : "Searched web: ") + clipChars(parsed.query, 60);
    return step.label && step.label !== step.name ? step.label : running ? "Searching the web" : "Searched the web";
  }
  if (kind === "web-page") {
    const host = parsed.url ? shortHost(parsed.url) : undefined;
    if (host) return (running ? "Reading " : "Read ") + host;
    return step.label && step.label !== step.name ? step.label : running ? "Reading a web page" : "Read a web page";
  }
  if (step.label && step.label !== step.name) return step.label;
  return step.source ? step.source + " / " + step.name : step.name || "Used a tool";
}

export function clipLines(text: string | undefined, maxLines = 4, fromEnd = false): { text: string; totalLines: number; clipped: boolean } {
  const cleaned = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!cleaned) return { text: "", totalLines: 0, clipped: false };
  const all = cleaned.split("\n");
  if (all.length <= maxLines) return { text: cleaned, totalLines: all.length, clipped: false };
  const slice = fromEnd ? all.slice(-maxLines) : all.slice(0, maxLines);
  return { text: slice.join("\n"), totalLines: all.length, clipped: true };
}

export function visibleSteps(steps?: Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps ?? []) {
    if (classifyStep(s)) out.push(s);
  }
  return out;
}

export function summarizeSteps(steps?: Step[], opts?: { running?: boolean }): string {
  const counts = new Map<StepKind, number>();
  for (const s of steps ?? []) {
    const kind = classifyStep(s);
    if (!kind) continue;
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  if (!counts.size) return "";
  const table = opts?.running ? RUNNING_WORDS : SUMMARY_WORDS;
  const parts = [...counts].map(([kind, n]) => {
    const [one, many] = table[kind] || table.tool;
    return n === 1 ? one : many.replace("%d", String(n));
  });
  const text = parts.slice(0, 4).join(", ").toLowerCase();
  return text[0].toUpperCase() + text.slice(1);
}

export function summarizeToolNames(usedTools?: string[]): string {
  const counts = new Map<StepKind, number>();
  for (const name of usedTools ?? []) {
    const kind = toolKind(name);
    if (!kind) continue;
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  if (!counts.size) return "";
  const parts = [...counts].map(([kind, n]) => {
    const [one, many] = SUMMARY_WORDS[kind] || SUMMARY_WORDS.tool;
    return n === 1 ? one : many.replace("%d", String(n));
  });
  const text = parts.slice(0, 4).join(", ").toLowerCase();
  return text[0].toUpperCase() + text.slice(1);
}

export function uniqueKinds(steps?: Step[], usedTools?: string[], max = 4): StepKind[] {
  const seen: StepKind[] = [];
  for (const s of steps ?? []) {
    const kind = classifyStep(s);
    if (kind && !seen.includes(kind)) {
      seen.push(kind);
      if (seen.length >= max) return seen;
    }
  }
  if (!seen.length) {
    for (const name of usedTools ?? []) {
      const kind = toolKind(name);
      if (kind && !seen.includes(kind)) {
        seen.push(kind);
        if (seen.length >= max) return seen;
      }
    }
  }
  return seen;
}

/** Group consecutive steps of the same kind for T3 Code Open-mode inline rows. */
export function groupForOpenMode(steps?: Step[]): OpenWorkGroup[] {
  const filtered = visibleSteps(steps);
  const groups: OpenWorkGroup[] = [];
  for (const step of filtered) {
    const kind = classifyStep(step) ?? "tool";
    const prev = groups[groups.length - 1];
    if (prev && prev.primaryKind === kind) {
      prev.steps.push(step);
    } else {
      groups.push({ id: step.id, primaryKind: kind, steps: [step], running: false, failedCount: 0, label: "" });
    }
  }
  for (const g of groups) {
    g.running = g.steps.some((s) => s.status === "Running");
    g.failedCount = g.steps.filter((s) => s.status === "Failed").length;
    g.label = g.steps.length === 1 ? stepHeadline(g.steps[0]) : summarizeSteps(g.steps, { running: g.running });
  }
  return groups;
}

/** Partition steps chronologically into OpenBot Fold-mode coding frames and grouped tool lines. */
export function partitionForFoldMode(steps?: Step[]): FoldBlock[] {
  const filtered = visibleSteps(steps);
  const blocks: FoldBlock[] = [];
  for (const step of filtered) {
    const kind = classifyStep(step) ?? "tool";
    if (kind === "command") {
      blocks.push({ kind: "command", id: step.id, step, parsed: parseStepInput(step) });
    } else if (kind === "edit" || kind === "write") {
      blocks.push({ kind: "diff", id: step.id, step, parsed: parseStepInput(step) });
    } else {
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === "group") {
        prev.steps.push(step);
      } else {
        blocks.push({ kind: "group", id: step.id, steps: [step], kinds: [], label: "", running: false, failedCount: 0 });
      }
    }
  }
  for (const b of blocks) {
    if (b.kind === "group") {
      b.running = b.steps.some((s) => s.status === "Running");
      b.failedCount = b.steps.filter((s) => s.status === "Failed").length;
      b.kinds = uniqueKinds(b.steps, undefined, 4);
      b.label = b.steps.length === 1 ? stepHeadline(b.steps[0]) : summarizeSteps(b.steps, { running: b.running });
    }
  }
  return blocks;
}

export function formatWorkingDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

function asStepKind(value: string): StepKind {
  return value in SUMMARY_WORDS ? (value as StepKind) : "tool";
}

export function formatFeedWork(
  run: Pick<RunSummary, "status" | "summary" | "stepKinds" | "stepCount" | "failedCount"> &
    Partial<Pick<Run, "steps" | "usedTools" | "teamwork" | "taskHandoffs">>,
): { kinds: StepKind[]; summary: string; stepCount: number; failedCount: number } {
  const hasSteps = Array.isArray(run.steps) && run.steps.length > 0;
  const steps = hasSteps ? run.steps!.filter((s) => !isStepCoveredByRail(s, run)) : [];
  const legacyTools = hasSteps ? undefined : run.usedTools;
  const kinds = run.stepKinds?.length ? run.stepKinds.slice(0, 4).map(asStepKind) : uniqueKinds(steps, legacyTools, 4);
  const failedCount = typeof run.failedCount === "number" ? run.failedCount : steps.filter((s) => s.status === "Failed").length;
  const visibleToolCount = (legacyTools ?? []).filter((n) => toolKind(n) != null).length;
  const stepCount = typeof run.stepCount === "number" ? run.stepCount : visibleSteps(steps).length || visibleToolCount;
  let summary = run.summary || "";
  if (!summary && steps.length) {
    summary = summarizeSteps(steps, { running: run.status === "Working" });
  }
  if (!summary && legacyTools?.length) {
    summary = summarizeToolNames(legacyTools);
  }
  return { kinds, summary, stepCount, failedCount };
}
