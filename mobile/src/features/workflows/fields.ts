// Client-side mirror of workflow field availability & token parsing for instant chip validation and autocomplete.
// The same file as desktop/src/workflowAnalysis.ts apart from this import; tests/workflow-designer.test.ts checks it.
import type { Workflow, WorkflowNode, WorkflowTriggerKind } from "@/link/types";

export interface AvailableField {
  name: string;
  type: string;
  choices?: string[];
  description?: string;
  sourceNodeId: string;
  sourceLabel: string;
  sourceKind: WorkflowNode["kind"];
  triggerKind?: WorkflowTriggerKind;
  guaranteed: boolean;
  ambiguous: boolean;
  sources: string[];
}

export interface FieldProblem {
  field: string;
  prop: string;
  kind: "missing" | "partial" | "ambiguous";
  message: string;
}

export interface NodeFieldAnalysis {
  available: AvailableField[];
  guaranteed: Set<string>;
  partial: Set<string>;
  ambiguous: Record<string, string[]>;
  problems: FieldProblem[];
  reachable: boolean;
}

export const TRIGGER_FIELDS: Record<WorkflowTriggerKind, Array<{ name: string; type: string; description: string; choices?: string[] }>> = {
  task: [
    { name: "id", type: "string", description: "Task ID" },
    { name: "title", type: "string", description: "Task title" },
    { name: "bot", type: "string", description: "Assigned bot name" },
    { name: "from", type: "string", description: "Previous status" },
    { name: "to", type: "string", description: "New status" },
    { name: "result", type: "string", description: "Task result text" },
    { name: "problem", type: "string", description: "Task error or blocker" },
    { name: "priority", type: "string", description: "Task priority", choices: ["low", "normal", "high", "urgent"] },
  ],
  schedule: [
    { name: "local_date", type: "string", description: "Local date (YYYY-MM-DD)" },
    { name: "local_time", type: "string", description: "Local time (HH:MM)" },
    { name: "weekday", type: "string", description: "Day of week", choices: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] },
    { name: "run_time", type: "string", description: "ISO timestamp of run" },
    { name: "timezone", type: "string", description: "IANA time zone" },
  ],
  manual: [
    { name: "run_time", type: "string", description: "ISO timestamp of run" },
    { name: "triggered_by", type: "string", description: "Who started the run" },
  ],
  routine: [
    { name: "routine_id", type: "string", description: "Routine chat ID" },
    { name: "routine_name", type: "string", description: "Routine name" },
    { name: "bot", type: "string", description: "Bot name" },
    { name: "status", type: "string", description: "Run status" },
    { name: "result", type: "string", description: "Routine reply text" },
    { name: "run_id", type: "string", description: "Run ID" },
    { name: "finished_at", type: "string", description: "ISO timestamp when finished" },
  ],
  chat: [
    { name: "chat_id", type: "string", description: "Chat ID" },
    { name: "chat_title", type: "string", description: "Chat title" },
    { name: "bot", type: "string", description: "Bot name" },
    { name: "sender", type: "string", description: "Message author" },
    { name: "text", type: "string", description: "Message text" },
    { name: "time", type: "string", description: "ISO timestamp of message" },
  ],
  webhook: [
    { name: "body", type: "string", description: "Raw request body" },
    { name: "payload", type: "string", description: "Formatted JSON payload" },
    { name: "method", type: "string", description: "HTTP method" },
    { name: "received_at", type: "string", description: "ISO timestamp received" },
  ],
  github: [
    { name: "repo", type: "string", description: "Repository (owner/repo)" },
    { name: "event", type: "string", description: "Event type", choices: ["pr_opened", "pr_review", "ci_status"] },
    { name: "number", type: "number", description: "Pull request number" },
    { name: "title", type: "string", description: "Pull request title" },
    { name: "author", type: "string", description: "Pull request author" },
    { name: "url", type: "string", description: "Pull request URL" },
    { name: "branch", type: "string", description: "Head branch name" },
    { name: "state", type: "string", description: "Pull request state" },
    { name: "review_state", type: "string", description: "Review decision" },
    { name: "ci_status", type: "string", description: "CI rollup status" },
  ],
};

const FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/;
const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]{0,63})(\?)?\s*\}\}/g;

export interface ParsedToken {
  raw: string;
  name: string;
  optional: boolean;
  start: number;
  end: number;
}

export function parseTemplateTokens(text: string): ParsedToken[] {
  if (!text || !text.includes("{{")) return [];
  const out: ParsedToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    out.push({ raw: m[0], name: m[1], optional: m[2] === "?", start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function nodeOutputFields(node: WorkflowNode) {
  const attach = (list: Array<{ name: string; type?: string; choices?: string[]; description?: string }>) =>
    list.map((f) => ({
      name: f.name,
      type: f.type || "string",
      choices: f.choices,
      description: f.description,
      sourceNodeId: node.id,
      sourceLabel: node.label || node.id,
      sourceKind: node.kind,
      triggerKind: node.triggerKind,
    }));

  if (node.kind === "trigger") {
    const base = node.triggerKind ? TRIGGER_FIELDS[node.triggerKind] ?? [] : [];
    const extra: Array<{ name: string; type?: string; choices?: string[]; description?: string }> = [
      ...(Array.isArray(node.config?.fields) ? node.config.fields : []),
      ...(Array.isArray(node.config?.inputs) ? node.config.inputs : []),
    ].filter((f) => f && FIELD_NAME_RE.test(String(f.name || "")));
    const seen = new Set<string>();
    const merged: typeof extra = [];
    for (const f of [...base, ...extra]) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      merged.push(f);
    }
    return attach(merged);
  }
  if (node.kind === "agent" || node.kind === "model") {
    const out: Array<{ name: string; type?: string; choices?: string[]; description?: string }> = [];
    const seen = new Set<string>();
    for (const f of Array.isArray(node.config?.outputFields) ? node.config.outputFields : []) {
      if (!f || !FIELD_NAME_RE.test(String(f.name || "")) || seen.has(f.name)) continue;
      seen.add(f.name);
      out.push({ name: f.name, type: f.type || "string", choices: f.choices, description: f.description });
    }
    const key = typeof node.config?.outputKey === "string" && FIELD_NAME_RE.test(node.config.outputKey) ? node.config.outputKey : null;
    if (key && !seen.has(key)) {
      out.push({ name: key, type: "string", description: "Step reply text" });
    } else if (!out.length) {
      out.push({ name: node.kind === "agent" ? "agent_reply" : "model_reply", type: "string", description: "Step reply text" });
    }
    return attach(out);
  }
  if (node.kind === "approval") {
    const fields: Array<{ name: string; type?: string; choices?: string[]; description?: string }> = [
      { name: "approval_decision", type: "string", choices: ["approved", "rejected"], description: "Approval outcome" },
    ];
    if (typeof node.config?.noteField === "string" && FIELD_NAME_RE.test(node.config.noteField)) {
      fields.push({ name: node.config.noteField, type: "string", description: "Reviewer note" });
    }
    return attach(fields);
  }
  return [];
}

function nodeTemplates(node: WorkflowNode): Array<{ prop: string; value: string }> {
  const cfg = node.config ?? {};
  const list: Array<{ prop: string; value: string }> = [];
  const push = (prop: string, v: unknown) => {
    if (typeof v === "string" && v.includes("{{")) list.push({ prop, value: v });
  };
  if (node.kind === "agent" || node.kind === "model") push("prompt", cfg.prompt);
  else if (node.kind === "approval") push("message", cfg.message);
  else if (node.kind === "output") {
    push("template", cfg.template);
    push("title", cfg.title);
  } else if (node.kind === "condition") {
    push("expression", cfg.expression);
    if (Array.isArray(cfg.rules)) {
      for (const r of cfg.rules) push("rule.value", r?.value);
    }
  }
  return list;
}

export function analyzeWorkflowFields(workflow: Pick<Workflow, "nodes" | "edges">): Record<string, NodeFieldAnalysis> {
  const nodes = workflow.nodes ?? [];
  const edges = workflow.edges ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (byId.has(e.from) && byId.has(e.to)) outgoing.get(e.from)!.push(e.to);
  }

  const fieldsByNode = new Map(nodes.map((n) => [n.id, nodeOutputFields(n)]));
  const pathsTo = new Map<string, string[][]>(nodes.map((n) => [n.id, []]));

  function dfs(id: string, visited: Set<string>, path: string[]) {
    const list = pathsTo.get(id)!;
    if (list.length >= 64) return;
    list.push([...path]);
    for (const next of outgoing.get(id) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      path.push(next);
      dfs(next, visited, path);
      path.pop();
      visited.delete(next);
    }
  }

  for (const n of nodes) {
    if (n.kind === "trigger") dfs(n.id, new Set([n.id]), [n.id]);
  }

  const out: Record<string, NodeFieldAnalysis> = {};
  for (const node of nodes) {
    const paths = pathsTo.get(node.id) ?? [];
    const upstream = paths.map((p) => p.slice(0, -1));
    const fieldSources = new Map<string, ReturnType<typeof nodeOutputFields>>();
    const pathSets: Set<string>[] = [];
    const ambiguous = new Map<string, Set<string>>();

    for (const up of upstream) {
      const seenInPath = new Map<string, string[]>();
      for (const id of up) {
        for (const f of fieldsByNode.get(id) ?? []) {
          if (!fieldSources.has(f.name)) fieldSources.set(f.name, []);
          const arr = fieldSources.get(f.name)!;
          if (!arr.some((x) => x.sourceNodeId === f.sourceNodeId)) arr.push(f);
          if (!seenInPath.has(f.name)) seenInPath.set(f.name, []);
          seenInPath.get(f.name)!.push(f.sourceLabel);
        }
      }
      pathSets.push(new Set(seenInPath.keys()));
      for (const [name, labels] of seenInPath.entries()) {
        if (labels.length > 1) {
          if (!ambiguous.has(name)) ambiguous.set(name, new Set());
          for (const l of labels) ambiguous.get(name)!.add(l);
        }
      }
    }

    const guaranteed = new Set<string>();
    const partial = new Set<string>();
    const available: AvailableField[] = [];
    for (const [name, metas] of fieldSources.entries()) {
      const onAll = pathSets.length > 0 && pathSets.every((s) => s.has(name));
      if (onAll) guaranteed.add(name);
      else partial.add(name);
      available.push({
        ...metas[0],
        guaranteed: onAll,
        ambiguous: ambiguous.has(name),
        sources: metas.map((m) => m.sourceLabel),
      });
    }
    available.sort((a, b) => a.name.localeCompare(b.name));

    const problems: FieldProblem[] = [];
    const check = (name: string, optional: boolean, prop: string) => {
      if (ambiguous.has(name)) {
        problems.push({
          field: name,
          prop,
          kind: "ambiguous",
          message: `Multiple upstream steps provide "${name}" (${[...ambiguous.get(name)!].join(", ")}).`,
        });
      } else if (!fieldSources.has(name)) {
        problems.push({ field: name, prop, kind: "missing", message: `No upstream step provides "${name}".` });
      } else if (!guaranteed.has(name) && !optional) {
        problems.push({
          field: name,
          prop,
          kind: "partial",
          message: `Not every path provides "${name}". Use {{${name}?}} to allow empty values.`,
        });
      }
    };

    for (const { prop, value } of nodeTemplates(node)) {
      for (const tok of parseTemplateTokens(value)) check(tok.name, tok.optional, prop);
    }
    if (node.kind === "condition") {
      if (Array.isArray(node.config?.rules)) {
        for (const r of node.config.rules) {
          if (r?.field) check(String(r.field), false, "condition.field");
        }
      } else if (typeof node.config?.expression === "string" && node.config.expression.trim()) {
        const m = /^([a-zA-Z_][a-zA-Z0-9_.-]*)/.exec(node.config.expression.trim());
        if (m) check(m[1], false, "condition.field");
      }
    }

    out[node.id] = {
      available,
      guaranteed,
      partial,
      ambiguous: Object.fromEntries([...ambiguous.entries()].map(([k, v]) => [k, [...v]])),
      problems,
      reachable: paths.length > 0 || node.kind === "trigger",
    };
  }
  return out;
}
