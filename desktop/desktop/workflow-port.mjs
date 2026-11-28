// Workflow export & import in `botkins.workflow` JSON format.
// Agents are exported by name (never raw IDs alone), secrets are stripped and refused,
// newer versions or unknown step/trigger kinds are refused with an "update required" message,
// and imported workflows always start paused.

import { NODE_KINDS, TRIGGER_KINDS, OUTPUT_DESTINATIONS } from "./workflow-fields.mjs";

export const WORKFLOW_FILE_FORMAT = "botkins.workflow";
export const WORKFLOW_SCHEMA_VERSION = 1;

const SECRET_PATTERNS = [
  { label: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { label: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { label: "API key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/ },
  { label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { label: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/ },
  { label: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i },
  { label: "Webhook secret", re: /\bwhsec_[A-Za-z0-9]{16,}\b/ },
  { label: "Embedded password/secret", re: /\b(?:api_key|apiKey|secret|password|access_token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}["']?/i },
];

function findSecretInValue(value, path = "") {
  const hits = [];
  if (typeof value === "string") {
    for (const { label, re } of SECRET_PATTERNS) {
      if (re.test(value)) {
        hits.push({ path, reason: label });
        break;
      }
    }
    return hits;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...findSecretInValue(item, `${path}[${i}]`)));
    return hits;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/secret|token|password|apikey|api_key|authorization/i.test(k) && typeof v === "string" && v.trim() && !v.startsWith("vault:")) {
        hits.push({ path: path ? `${path}.${k}` : k, reason: `Secret field "${k}"` });
        continue;
      }
      hits.push(...findSecretInValue(v, path ? `${path}.${k}` : k));
    }
  }
  return hits;
}

/** Scans a workflow definition for embedded secrets. Returns offending steps and paths. */
export function detectSecretsInWorkflow(workflow) {
  const findings = [];
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  for (const node of nodes) {
    // Strip known safe vault references or route metadata before checking.
    const cfg = node?.config && typeof node.config === "object" ? { ...node.config } : {};
    delete cfg.secretRef;
    delete cfg.hasSecret;
    const hits = findSecretInValue({ label: node?.label, config: cfg }, "");
    if (hits.length) {
      findings.push({
        nodeId: node.id,
        label: node.label || node.id,
        reasons: hits.map((h) => h.reason),
      });
    }
  }
  if (typeof workflow?.description === "string") {
    const hits = findSecretInValue(workflow.description, "description");
    if (hits.length) findings.push({ nodeId: null, label: "Workflow description", reasons: hits.map((h) => h.reason) });
  }
  return findings;
}

/**
 * Exports a workflow to a portable `botkins.workflow` JSON object.
 * - Replaces bot IDs with bot names so it imports cleanly on another computer.
 * - Leaves out webhook secrets, route IDs, and local chat IDs.
 * - Refuses export if any step contains a secret.
 */
export function exportWorkflow(workflow, bots = [], appVersion = "0.17.17") {
  if (!workflow || typeof workflow !== "object") throw new Error("Workflow not found.");
  const secrets = detectSecretsInWorkflow(workflow);
  if (secrets.length) {
    const names = secrets.map((s) => `${s.label} (${s.reasons.join(", ")})`).join("; ");
    const err = new Error("Cannot export workflow containing a secret. Remove secrets from: " + names);
    err.code = "WORKFLOW_SECRET_REFUSED";
    err.findings = secrets;
    throw err;
  }

  const botNameById = new Map(bots.map((b) => [b.id, b.name]));
  const agents = new Set();

  const cleanNodes = (workflow.nodes ?? []).map((node) => {
    const cfg = structuredClone(node.config ?? {});
    if (cfg.botId) {
      const name = botNameById.get(cfg.botId) ?? cfg.botName ?? null;
      if (name) {
        cfg.botName = name;
        agents.add(name);
      }
      delete cfg.botId;
    }
    // Strip local-only IDs and secrets
    if (node.kind === "trigger" && node.triggerKind === "webhook") {
      delete cfg.secretRef;
      delete cfg.secret;
      delete cfg.routeId;
      delete cfg.hasSecret;
    }
    if (node.kind === "trigger" && node.triggerKind === "task") {
      delete cfg.taskId;
    }
    if (node.kind === "trigger" && node.triggerKind === "routine") {
      delete cfg.routineChatId;
    }
    if (node.kind === "trigger" && node.triggerKind === "chat") {
      delete cfg.chatId;
    }
    if (node.kind === "output") {
      delete cfg.chatId;
      if (cfg.card?.dispatch?.botId) {
        const dName = botNameById.get(cfg.card.dispatch.botId) ?? cfg.card.dispatch.botName ?? null;
        if (dName) {
          cfg.card.dispatch.botName = dName;
          agents.add(dName);
        }
        delete cfg.card.dispatch.botId;
      }
      if (cfg.a2ui?.dispatch?.botId) {
        const dName = botNameById.get(cfg.a2ui.dispatch.botId) ?? cfg.a2ui.dispatch.botName ?? null;
        if (dName) {
          cfg.a2ui.dispatch.botName = dName;
          agents.add(dName);
        }
        delete cfg.a2ui.dispatch.botId;
      }
    }
    return {
      id: node.id,
      kind: node.kind,
      ...(node.triggerKind ? { triggerKind: node.triggerKind } : {}),
      label: node.label,
      position: node.position ? { x: Math.round(node.position.x), y: Math.round(node.position.y) } : undefined,
      config: cfg,
    };
  });

  return {
    format: WORKFLOW_FILE_FORMAT,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    agents: [...agents],
    workflow: {
      name: workflow.name,
      description: workflow.description ?? "",
      nodes: cleanNodes,
      edges: (workflow.edges ?? []).map((e) => ({
        id: e.id,
        from: e.from,
        to: e.to,
        ...(e.branch && e.branch !== "default" ? { branch: e.branch } : {}),
      })),
    },
  };
}

/**
 * Validates and converts an imported `botkins.workflow` JSON document into a local workflow draft.
 * - Refuses files from a newer schema version or containing unknown node/trigger/output kinds with "Update required".
 * - Refuses files containing secrets.
 * - Maps agent names to local bots (using `agentMap` overrides or case-insensitive name match).
 * - Always returns `enabled: false` (paused).
 */
export function parseImportedWorkflow(raw, bots = [], agentMap = {}) {
  let doc = raw;
  if (typeof raw === "string") {
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new Error("This file is not valid JSON.");
    }
  }
  if (!doc || typeof doc !== "object" || doc.format !== WORKFLOW_FILE_FORMAT || !doc.workflow) {
    throw new Error("This file is not a Botkins workflow file.");
  }

  const unsupported = [];
  if (typeof doc.schemaVersion === "number" && doc.schemaVersion > WORKFLOW_SCHEMA_VERSION) {
    unsupported.push(`schema v${doc.schemaVersion}`);
  }
  const nodes = Array.isArray(doc.workflow.nodes) ? doc.workflow.nodes : [];
  for (const node of nodes) {
    if (!NODE_KINDS.includes(node?.kind)) {
      unsupported.push(`step "${node?.kind ?? "unknown"}"`);
    } else if (node.kind === "trigger" && !TRIGGER_KINDS.includes(node.triggerKind)) {
      unsupported.push(`trigger "${node.triggerKind ?? "unknown"}"`);
    } else if (node.kind === "output" && node.config?.destination && !OUTPUT_DESTINATIONS.includes(node.config.destination)) {
      unsupported.push(`output "${node.config.destination}"`);
    }
  }
  if (unsupported.length) {
    const err = new Error(
      `Update required: this workflow was created in a newer version of Botkins and uses unsupported features (${[...new Set(unsupported)].join(", ")}).`,
    );
    err.code = "WORKFLOW_UPDATE_REQUIRED";
    err.unsupported = [...new Set(unsupported)];
    throw err;
  }

  const secrets = detectSecretsInWorkflow(doc.workflow);
  if (secrets.length) {
    const names = secrets.map((s) => `${s.label} (${s.reasons.join(", ")})`).join("; ");
    const err = new Error("Import refused: this workflow file contains a secret in " + names + ".");
    err.code = "WORKFLOW_SECRET_REFUSED";
    err.findings = secrets;
    throw err;
  }

  const byLowerName = new Map(bots.map((b) => [b.name.toLowerCase(), b]));
  const fallbackBot = bots[0] ?? null;
  const unresolvedAgents = [];

  const resolvedNodes = nodes.map((node) => {
    const cfg = structuredClone(node.config ?? {});
    if (cfg.botName) {
      const mapped = agentMap[cfg.botName];
      const match = mapped ? bots.find((b) => b.id === mapped) : byLowerName.get(String(cfg.botName).toLowerCase());
      if (match) {
        cfg.botId = match.id;
      } else {
        unresolvedAgents.push(cfg.botName);
        if (fallbackBot && node.kind === "agent") cfg.botId = fallbackBot.id;
      }
    }
    if (node.kind === "output" && cfg.card?.dispatch?.botName) {
      const dName = cfg.card.dispatch.botName;
      const mapped = agentMap[dName];
      const match = mapped ? bots.find((b) => b.id === mapped) : byLowerName.get(String(dName).toLowerCase());
      if (match) cfg.card.dispatch.botId = match.id;
      else if (!unresolvedAgents.includes(dName)) unresolvedAgents.push(dName);
    }
    // Never accept imported secrets or route IDs
    if (node.kind === "trigger" && node.triggerKind === "webhook") {
      delete cfg.secretRef;
      delete cfg.secret;
      delete cfg.routeId;
      delete cfg.hasSecret;
    }
    return {
      id: node.id,
      kind: node.kind,
      ...(node.triggerKind ? { triggerKind: node.triggerKind } : {}),
      label: node.label,
      ...(node.position ? { position: node.position } : {}),
      config: cfg,
    };
  });

  return {
    draft: {
      name: String(doc.workflow.name ?? "Imported workflow").slice(0, 80),
      description: String(doc.workflow.description ?? "").slice(0, 500),
      enabled: false,
      nodes: resolvedNodes,
      edges: Array.isArray(doc.workflow.edges) ? doc.workflow.edges : [],
    },
    unresolvedAgents: [...new Set(unresolvedAgents)],
  };
}
