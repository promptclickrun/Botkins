// Metadata-only audit log for Channel Hooks.
// Records connection, sender id, conversation, decision, and reply metadata.
// Message bodies and secrets are NEVER logged by default.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scrubSecrets } from "./security.mjs";

const MAX_MEMORY_ENTRIES = 500;
const MAX_DISK_LINES = 2000;

export class ChannelAudit {
  constructor(dir, { getSecrets = () => [] } = {}) {
    this.file = dir ? join(dir, "channel-audit.jsonl") : null;
    this.getSecrets = getSecrets;
    this.entries = [];
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const raw = readFileSync(this.file, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const recent = lines.slice(-MAX_MEMORY_ENTRIES);
      this.entries = [];
      for (const line of recent) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object") this.entries.push(parsed);
        } catch {
          // Ignore corrupted line.
        }
      }
    } catch {
      this.entries = [];
    }
  }

  /**
   * Appends one metadata-only audit record. Never includes message bodies or secrets.
   */
  record({
    connectionId,
    kind,
    senderId = "",
    conversationId = "",
    threadId = "",
    decision,
    reason = "",
    turnId = "",
    replyParts,
  }) {
    const secrets = this.getSecrets();
    const clean = (v, max = 160) =>
      scrubSecrets(String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max), secrets);
    const entry = {
      time: Date.now(),
      connectionId: clean(connectionId, 80),
      kind: clean(kind, 32),
      ...(senderId && { senderId: clean(senderId, 160) }),
      ...(conversationId && { conversationId: clean(conversationId, 200) }),
      ...(threadId && { threadId: clean(threadId, 200) }),
      decision: clean(decision, 48),
      ...(reason && { reason: clean(reason, 160) }),
      ...(turnId && { turnId: clean(turnId, 80) }),
      ...(Number.isFinite(replyParts) && { replyParts }),
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_MEMORY_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_MEMORY_ENTRIES);
    }
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        appendFileSync(this.file, JSON.stringify(entry) + "\n", { mode: 0o600 });
        this.trimIfNeeded();
      } catch {
        // Best effort audit persistence.
      }
    }
    return entry;
  }

  trimIfNeeded() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
      if (lines.length > MAX_DISK_LINES) {
        writeFileSync(this.file, lines.slice(-MAX_MEMORY_ENTRIES).join("\n") + "\n", { mode: 0o600 });
      }
    } catch {
      // Ignore trim errors.
    }
  }

  list({ connectionId, limit = 100 } = {}) {
    const cap = Math.max(1, Math.min(500, Number(limit) || 100));
    const filtered = connectionId
      ? this.entries.filter((e) => e.connectionId === connectionId)
      : this.entries;
    return filtered.slice(-cap).reverse();
  }
}
