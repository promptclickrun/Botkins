// Workflow fields, template parsing/resolution, condition evaluation, and graph validation.
// Kept pure (no I/O) so the backend runner, bot tools, tests, and UI analysis stay in lockstep.

export const NODE_KINDS = ["trigger", "agent", "model", "condition", "approval", "output"];
export const TRIGGER_KINDS = ["task", "schedule", "manual", "routine", "chat", "webhook", "github"];
export const OUTPUT_DESTINATIONS = ["chat", "feed", "idea", "goal", "notification"];
export const CONDITION_OPS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "matches",
  "in",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "empty",
];

/** Fixed fields emitted by each trigger kind. */
export const TRIGGER_FIELDS = {
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

export function isValidFieldName(name) {
  return typeof name === "string" && FIELD_NAME_RE.test(name);
}

/** Fields declared as output by a single node. */
export function nodeOutputFields(node) {
  if (!node || typeof node !== "object") return [];
  const label = node.label || defaultNodeLabel(node);
  const attach = (fields) =>
    fields.map((f) => ({
      name: f.name,
      type: f.type || "string",
      ...(Array.isArray(f.choices) && f.choices.length ? { choices: f.choices } : {}),
      ...(f.description ? { description: f.description } : {}),
      sourceNodeId: node.id,
      sourceLabel: label,
      sourceKind: node.kind,
      ...(node.triggerKind ? { triggerKind: node.triggerKind } : {}),
    }));

  if (node.kind === "trigger") {
    const base = TRIGGER_FIELDS[node.triggerKind] ?? [];
    const custom = Array.isArray(node.config?.fields)
      ? node.config.fields
          .filter((f) => f && isValidFieldName(f.name))
          .map((f) => ({ name: f.name, type: f.type || "string", choices: f.choices, description: f.description }))
      : [];
    const inputs = Array.isArray(node.config?.inputs)
      ? node.config.inputs
          .filter((f) => f && isValidFieldName(f.name))
          .map((f) => ({ name: f.name, type: f.type || "string", choices: f.choices, description: f.description }))
      : [];
    const seen = new Set();
    const merged = [];
    for (const f of [...base, ...custom, ...inputs]) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      merged.push(f);
    }
    return attach(merged);
  }
  if (node.kind === "agent" || node.kind === "model") {
    const out = [];
    const declared = Array.isArray(node.config?.outputFields) ? node.config.outputFields : [];
    const seen = new Set();
    for (const f of declared) {
      if (!f || !isValidFieldName(f.name) || seen.has(f.name)) continue;
      seen.add(f.name);
      out.push({ name: f.name, type: f.type || "string", choices: f.choices, description: f.description });
    }
    const outputKey = isValidFieldName(node.config?.outputKey) ? node.config.outputKey : null;
    if (outputKey && !seen.has(outputKey)) {
      out.push({ name: outputKey, type: "string", description: "Step reply text" });
      seen.add(outputKey);
    } else if (!out.length) {
      // Every agent/model step without explicit fields exposes its reply via a stable field name.
      const fallback = node.kind === "agent" ? "agent_reply" : "model_reply";
      out.push({ name: fallback, type: "string", description: "Step reply text" });
    }
    return attach(out);
  }
  if (node.kind === "approval") {
    const fields = [{ name: "approval_decision", type: "string", choices: ["approved", "rejected"], description: "Approval outcome" }];
    if (node.config?.noteField && isValidFieldName(node.config.noteField)) {
      fields.push({ name: node.config.noteField, type: "string", description: "Reviewer note" });
    }
    return attach(fields);
  }
  return [];
}

export function defaultNodeLabel(node) {
  switch (node?.kind) {
    case "trigger":
      return (
        {
          task: "Task Board trigger",
          schedule: "Schedule trigger",
          manual: "Manual trigger",
          routine: "Routine trigger",
          chat: "Chat trigger",
          webhook: "Webhook trigger",
          github: "GitHub trigger",
        }[node.triggerKind] ?? "Trigger"
      );
    case "agent":
      return "Agent step";
    case "model":
      return "Model step";
    case "condition":
      return "Condition";
    case "approval":
      return "Approval";
    case "output":
      return "Output";
    default:
      return "Step";
  }
}

/** Extracts `{{name}}` and `{{name?}}` references from a text string. */
export function parseTemplateTokens(text) {
  if (typeof text !== "string" || !text.includes("{{")) return [];
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    out.push({
      raw: match[0],
      name: match[1],
      optional: match[2] === "?",
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return out;
}

/** Looks up a field (plain or dotted key) inside a context object. */
export function lookupField(context, name) {
  if (!context || typeof context !== "object" || typeof name !== "string") return undefined;
  if (Object.prototype.hasOwnProperty.call(context, name)) return context[name];
  if (!name.includes(".")) return undefined;
  const parts = name.split(".");
  let cur = context;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function formatFieldValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Resolves `{{field}}` and `{{field?}}` placeholders against `context`.
 * Saved text always remains plain `{{field}}`.
 */
export function resolveTemplate(text, context, { strict = false } = {}) {
  if (typeof text !== "string") return "";
  if (!text.includes("{{")) return text;
  const missing = [];
  const resolved = text.replace(TOKEN_RE, (raw, name, opt) => {
    const val = lookupField(context, name);
    if (val === undefined || val === null) {
      if (!opt) missing.push(name);
      return "";
    }
    return formatFieldValue(val);
  });
  if (strict && missing.length) {
    throw new Error("Missing workflow field" + (missing.length > 1 ? "s" : "") + ": " + [...new Set(missing)].join(", "));
  }
  return resolved;
}

/**
 * Collects all template strings referenced on a node.
 */
export function nodeTemplateStrings(node) {
  const cfg = node?.config ?? {};
  const list = [];
  const push = (prop, value) => {
    if (typeof value === "string" && value.includes("{{")) list.push({ prop, value });
  };
  if (node?.kind === "agent" || node?.kind === "model") {
    push("prompt", cfg.prompt);
  } else if (node?.kind === "approval") {
    push("message", cfg.message);
  } else if (node?.kind === "output") {
    push("template", cfg.template);
    push("title", cfg.title);
  } else if (node?.kind === "condition") {
    if (typeof cfg.expression === "string") push("expression", cfg.expression);
    if (Array.isArray(cfg.rules)) {
      for (const r of cfg.rules) {
        if (typeof r?.value === "string") push("rule.value", r.value);
      }
    }
  }
  return list;
}

/**
 * Computes field availability for every node across all trigger-to-node paths:
 * - `available`: fields provided by at least one upstream path (for autocomplete)
 * - `guaranteed`: Set of field names provided on EVERY path from any reachable trigger into this node
 * - `partial`: Set of field names provided on SOME but not all paths into this node
 * - `ambiguous`: Map<fieldName, sourceLabels[]> where two different upstream nodes along the same path provide the same field
 * - `problems`: array of `{ field, kind: "missing" | "partial" | "ambiguous", message, prop }`
 */
export function analyzeWorkflowFields(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(nodes.map((n) => [n.id, []]));
  const outgoing = new Map(nodes.map((n) => [n.id, []]));

  for (const edge of edges) {
    if (byId.has(edge.from) && byId.has(edge.to)) {
      outgoing.get(edge.from).push(edge);
      incoming.get(edge.to).push(edge);
    }
  }

  const triggers = nodes.filter((n) => n.kind === "trigger");
  const nodeFields = new Map(nodes.map((n) => [n.id, nodeOutputFields(n)]));

  // Enumerate simple paths from triggers to each node (capped to stay fast on dense DAGs).
  const MAX_PATHS_PER_NODE = 64;
  const pathsTo = new Map(nodes.map((n) => [n.id, []]));

  function dfs(currentId, visited, path) {
    const list = pathsTo.get(currentId);
    if (list.length >= MAX_PATHS_PER_NODE) return;
    list.push([...path]);
    for (const edge of outgoing.get(currentId) ?? []) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      path.push(edge.to);
      dfs(edge.to, visited, path);
      path.pop();
      visited.delete(edge.to);
    }
  }

  for (const trigger of triggers) {
    const visited = new Set([trigger.id]);
    dfs(trigger.id, visited, [trigger.id]);
  }

  const analysis = {};
  for (const node of nodes) {
    const paths = pathsTo.get(node.id) ?? [];
    // Upstream paths exclude `node.id` itself (the fields available *before* `node` runs).
    const upstreamPaths = paths.map((p) => p.slice(0, -1));
    const fieldSources = new Map(); // name -> field meta[]
    const pathSets = [];
    const ambiguous = new Map(); // name -> Set<sourceLabel>

    for (const up of upstreamPaths) {
      const seenInPath = new Map(); // name -> sourceLabel[]
      for (const id of up) {
        for (const f of nodeFields.get(id) ?? []) {
          if (!fieldSources.has(f.name)) fieldSources.set(f.name, []);
          const existing = fieldSources.get(f.name);
          if (!existing.some((x) => x.sourceNodeId === f.sourceNodeId)) existing.push(f);
          if (!seenInPath.has(f.name)) seenInPath.set(f.name, []);
          seenInPath.get(f.name).push(f.sourceLabel);
        }
      }
      pathSets.push(new Set(seenInPath.keys()));
      for (const [fname, labels] of seenInPath.entries()) {
        if (labels.length > 1) {
          if (!ambiguous.has(fname)) ambiguous.set(fname, new Set());
          for (const lbl of labels) ambiguous.get(fname).add(lbl);
        }
      }
    }

    const guaranteed = new Set();
    const partial = new Set();
    const available = [];

    for (const [name, metas] of fieldSources.entries()) {
      const onAll = pathSets.length > 0 && pathSets.every((set) => set.has(name));
      if (onAll) guaranteed.add(name);
      else partial.add(name);
      const first = metas[0];
      available.push({
        ...first,
        guaranteed: onAll,
        ambiguous: ambiguous.has(name),
        sources: metas.map((m) => m.sourceLabel),
      });
    }

    available.sort((a, b) => a.name.localeCompare(b.name));

    const problems = [];
    const checkFieldRef = (name, optional, prop) => {
      if (ambiguous.has(name)) {
        const srcs = [...ambiguous.get(name)].join(", ");
        problems.push({
          field: name,
          prop,
          kind: "ambiguous",
          message: `Multiple upstream steps provide "${name}" (${srcs}). Rename one output field so it is unambiguous.`,
        });
        return;
      }
      if (!fieldSources.has(name)) {
        problems.push({
          field: name,
          prop,
          kind: "missing",
          message: `No upstream step provides "${name}".`,
        });
        return;
      }
      if (!guaranteed.has(name) && !optional) {
        problems.push({
          field: name,
          prop,
          kind: "partial",
          message: `Not every path into this step provides "${name}". Mark it optional as {{${name}?}} or provide it on all paths.`,
        });
      }
    };

    for (const { prop, value } of nodeTemplateStrings(node)) {
      for (const tok of parseTemplateTokens(value)) {
        checkFieldRef(tok.name, tok.optional, prop);
      }
    }

    if (node.kind === "condition") {
      const rules = normalizedConditionRules(node.config);
      for (const r of rules) {
        if (r.field) checkFieldRef(r.field, false, "condition.field");
      }
    }

    analysis[node.id] = {
      available,
      guaranteed: [...guaranteed],
      partial: [...partial],
      ambiguous: Object.fromEntries([...ambiguous.entries()].map(([k, v]) => [k, [...v]])),
      problems,
      reachable: paths.length > 0 || node.kind === "trigger",
    };
  }

  return analysis;
}

/** Parses a compact expression such as `status = review` or `to != done` into a rule object. */
export function parseConditionExpression(expr) {
  if (typeof expr !== "string") return null;
  const trimmed = expr.trim();
  if (!trimmed) return null;
  const existsMatch = /^([a-zA-Z_][a-zA-Z0-9_.-]*)\s+(exists|empty)$/i.exec(trimmed);
  if (existsMatch) {
    return { field: existsMatch[1], op: existsMatch[2].toLowerCase(), value: "" };
  }
  const m = /^([a-zA-Z_][a-zA-Z0-9_.-]*)\s*(==|=|!=|>=|<=|>|<|contains|not_contains|starts_with|ends_with|matches|in)\s*(.+)$/i.exec(trimmed);
  if (!m) return null;
  const opMap = {
    "=": "equals",
    "==": "equals",
    "!=": "not_equals",
    ">": "gt",
    ">=": "gte",
    "<": "lt",
    "<=": "lte",
    contains: "contains",
    not_contains: "not_contains",
    starts_with: "starts_with",
    ends_with: "ends_with",
    matches: "matches",
    in: "in",
  };
  const rawVal = m[3].trim().replace(/^["']|["']$/g, "");
  return { field: m[1], op: opMap[m[2].toLowerCase()] ?? "equals", value: rawVal };
}

export function normalizedConditionRules(config) {
  if (Array.isArray(config?.rules) && config.rules.length > 0) {
    return config.rules.filter((r) => r && typeof r.field === "string" && r.field.trim());
  }
  if (typeof config?.expression === "string" && config.expression.trim()) {
    const parsed = parseConditionExpression(config.expression);
    return parsed ? [parsed] : [];
  }
  return [];
}

/** Evaluates a condition node deterministically with zero model calls. */
export function evaluateCondition(config, context) {
  const rules = normalizedConditionRules(config);
  if (!rules.length) return { matched: false, detail: "No condition rules configured." };
  const matchMode = config?.match === "any" ? "any" : "all";

  const evalRule = (rule) => {
    const raw = lookupField(context, rule.field);
    const actual = raw === undefined || raw === null ? "" : formatFieldValue(raw);
    const expected = typeof rule.value === "string" ? resolveTemplate(rule.value, context) : formatFieldValue(rule.value);
    const aLow = actual.toLowerCase();
    const eLow = expected.toLowerCase();
    switch (rule.op || "equals") {
      case "equals":
        return aLow === eLow;
      case "not_equals":
        return aLow !== eLow;
      case "contains":
        return aLow.includes(eLow);
      case "not_contains":
        return !aLow.includes(eLow);
      case "starts_with":
        return aLow.startsWith(eLow);
      case "ends_with":
        return aLow.endsWith(eLow);
      case "matches": {
        try {
          return new RegExp(expected, "i").test(actual);
        } catch {
          return false;
        }
      }
      case "in": {
        const items = expected
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        return items.includes(aLow);
      }
      case "gt":
        return Number(actual) > Number(expected);
      case "gte":
        return Number(actual) >= Number(expected);
      case "lt":
        return Number(actual) < Number(expected);
      case "lte":
        return Number(actual) <= Number(expected);
      case "exists":
        return raw !== undefined && raw !== null && actual.trim() !== "";
      case "empty":
        return raw === undefined || raw === null || actual.trim() === "";
      default:
        return false;
    }
  };

  const results = rules.map((r) => ({ rule: r, ok: evalRule(r) }));
  const matched = matchMode === "any" ? results.some((r) => r.ok) : results.every((r) => r.ok);
  const summary = results.map(({ rule, ok }) => `${rule.field} ${rule.op || "equals"} ${rule.value ?? ""} (${ok ? "true" : "false"})`).join(matchMode === "any" ? " OR " : " AND ");
  return { matched, detail: summary };
}

/** Validates workflow structure, cycles, and field references. */
export function validateWorkflow(workflow, { strictFields = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!workflow || typeof workflow !== "object") return { valid: false, errors: ["Workflow is required."], warnings, fields: {} };

  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  if (!nodes.length) errors.push("A workflow needs at least one node.");

  const ids = new Set();
  let triggerCount = 0;
  for (const node of nodes) {
    if (!node || typeof node.id !== "string" || !node.id.trim()) {
      errors.push("Every node needs an id.");
      continue;
    }
    if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}.`);
    ids.add(node.id);
    if (!NODE_KINDS.includes(node.kind)) errors.push(`Unknown node kind: ${node.kind}.`);
    if (node.kind === "trigger") {
      triggerCount++;
      if (!TRIGGER_KINDS.includes(node.triggerKind)) errors.push(`Unknown trigger kind on ${node.id}: ${node.triggerKind}.`);
    }
    if (node.kind === "output" && node.config?.destination && !OUTPUT_DESTINATIONS.includes(node.config.destination)) {
      errors.push(`Unknown output destination on ${node.id}: ${node.config.destination}.`);
    }
  }
  if (nodes.length && triggerCount === 0) errors.push("A workflow needs at least one trigger node.");

  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  for (const edge of edges) {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to)) {
      errors.push(`Edge connects unknown nodes (${edge?.from} -> ${edge?.to}).`);
      continue;
    }
    if (edge.from === edge.to) errors.push(`Self-loop edge on node ${edge.from}.`);
    outgoing.get(edge.from)?.push(edge.to);
  }

  // Cycle check (Kahn's / DFS 3-color)
  const color = new Map();
  const hasCycle = (id) => {
    color.set(id, 1);
    for (const next of outgoing.get(id) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) return true;
      if (c === 0 && hasCycle(next)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const id of ids) {
    if ((color.get(id) ?? 0) === 0 && hasCycle(id)) {
      errors.push("Workflow graph contains a cycle.");
      break;
    }
  }

  const fields = analyzeWorkflowFields(workflow);
  for (const [nodeId, info] of Object.entries(fields)) {
    for (const p of info.problems) {
      const entry = { nodeId, ...p };
      if (strictFields) errors.push(`Step ${nodeId}: ${p.message}`);
      else warnings.push(entry);
    }
  }

  return { valid: errors.length === 0, errors, warnings, fields };
}
