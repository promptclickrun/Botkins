// Which backend conversation belongs to which Botkins session.
//
// Botkins names a session itself (a chat's id, or one derived from it for a group member or a
// teammate). Codex and OpenCode make up their own ids, so each adapter keeps this small file
// in its own folder: { [sessionId]: { ref, ...whatever the adapter needs to resume or fork } }.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { earlierConversation, forkTranscript } from "../canvas.mjs";

export class SessionStore {
  /** @param file  Where the records are kept. Omit to keep them in memory only (tests, no data folder). */
  constructor(file) {
    this.file = file;
    this.records = {};
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8"));
        if (data && typeof data === "object" && !Array.isArray(data)) this.records = data;
      } catch {
        // A damaged file only costs the link to older conversations; they start afresh.
      }
    }
  }
  get(sessionId) {
    return this.records[sessionId];
  }
  set(sessionId, record) {
    this.records[sessionId] = record;
    this.save();
  }
  /** Changes one record in place and saves. */
  update(sessionId, change) {
    const record = this.records[sessionId];
    if (!record) return;
    change(record);
    this.save();
  }
  delete(sessionId) {
    if (!(sessionId in this.records)) return;
    delete this.records[sessionId];
    this.save();
  }
  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(this.records), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
}

/** A UUID made from any text, the same every time, for a backend that only takes UUIDs as session ids. */
export function uuidFor(text) {
  const hex = createHash("sha256").update(String(text)).digest("hex");
  // Version 4 and variant bits in their places, so it reads as an ordinary UUID.
  return [hex.slice(0, 8), hex.slice(8, 12), "4" + hex.slice(13, 16), "89ab"[parseInt(hex[16], 16) % 4] + hex.slice(17, 20), hex.slice(20, 32)].join("-");
}

/** The text of an MCP tool result's content, for a step's output. */
export function mcpText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : part?.type ? "[" + part.type + "]" : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * The MCP servers of a session spec, with the sign-in token of a remote server that uses OAuth
 * added as its Authorization header. Botkins keeps those tokens in its vault; a backend that
 * can't ask for one mid-session gets the current one when the session opens.
 */
export async function serversWithTokens(spec) {
  const out = {};
  for (const [name, server] of Object.entries(spec.mcpServers ?? {})) {
    if (server.type === "stdio" || !spec.mcpAuth || Object.keys(server.headers ?? {}).some((h) => h.toLowerCase() === "authorization")) {
      out[name] = server;
      continue;
    }
    const token = await spec.mcpAuth({ server: name, url: server.url, reason: "initial" }).catch(() => null);
    out[name] = token?.accessToken
      ? { ...server, headers: { ...server.headers, Authorization: (token.tokenType || "Bearer") + " " + token.accessToken } }
      : server;
  }
  return out;
}

/**
 * The conversation so far, for a backend that has lost its own copy of a conversation (or never
 * had it), to go before the first message it is sent (canvas.mjs earlierConversation). The
 * message being answered now is left out.
 */
export function transcriptContext(spec, botName = "Assistant") {
  const messages = [...(spec.history?.() ?? [])];
  if (messages.at(-1)?.role === "user") messages.pop();
  return earlierConversation(forkTranscript(messages, botName));
}

/**
 * Shared stale-reference recovery for every provider.
 *
 * When `resume` throws an error indicating the provider no longer has the conversation
 * (`missingConversation`, or a custom `isMissing` predicate), clears any stale record, calls
 * `create` to start a fresh native session, and returns `{ value, recovered: true, lost }` where
 * `lost` carries the Botkins transcript to hand off on the first prompt (when `spec.hasReplies`
 * is true and `spec` does not already carry its own forkContext).
 *
 * Non-missing errors (network errors, auth failures, model errors, timeouts) are rethrown so real
 * sessions are never silently orphaned.
 */
export async function resumeOrRecover({ spec, hasRef, resume, create, onMissing, isMissing = missingConversation, botName }) {
  if (hasRef) {
    try {
      const value = await resume();
      if (value != null) return { value, recovered: false, lost: "" };
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await onMissing?.();
  }
  const value = await create();
  const lost = spec?.hasReplies ? transcriptContext(spec, botName) : "";
  return { value, recovered: true, lost };
}

/**
 * True when a backend's error says the conversation it was asked to resume doesn't exist. The
 * words have to be about a conversation: "model not found" or "server not found" is another
 * failure, and starting a new conversation over it would orphan the real one.
 */
export const missingConversation = (error) =>
  /no rollout found|no conversation found|no such (thread|session|conversation)|unknown (thread|session|conversation)|(thread|session|conversation|rollout)\b[^.\n]{0,80}?(not found|does(n't| not) exist|is missing|no longer exists)|(not found|does(n't| not) exist)[^.\n]{0,40}?\b(thread|session|conversation|rollout)/i.test(
    String(error?.message ?? error),
  );

// ── Per-harness session records on chats, group members, and teammates ───────────────────────────
//
// Each chat (or group member, or teammate helper record) tracks native session state per provider
// id in `holder.sessions[providerId] = { ref?, folder?, through }`:
//   ref      Optional provider-scoped session id (e.g. from a native fork). Distinct from `chat.id`.
//   folder   Working folder this harness's native session was created in (or undefined for default).
//   through  Number of messages in `holder.messages` (or helper exchanges) that this harness has
//            already seen in its native session. Used on switch-back to hand off only the missed turns.

/** Migrates legacy single-provider fields (`established`, `sessionProvider`, `sessionFolder`) into
 * `holder.sessions[providerId]` without losing existing history. Safe to call repeatedly. */
export function migrateSessionHolder(holder, defaultProviderId = "copilot") {
  if (!holder || typeof holder !== "object") return false;
  let changed = false;
  if (holder.sessions !== undefined && (typeof holder.sessions !== "object" || holder.sessions === null || Array.isArray(holder.sessions))) {
    delete holder.sessions;
    changed = true;
  }
  if (holder.established) {
    const providerId = typeof holder.sessionProvider === "string" && holder.sessionProvider ? holder.sessionProvider : defaultProviderId;
    holder.sessions ??= {};
    if (!holder.sessions[providerId]) {
      const through = Array.isArray(holder.messages) ? holder.messages.length : 0;
      holder.sessions[providerId] = {
        ...(holder.sessionId && { ref: holder.sessionId }),
        ...(holder.sessionFolder !== undefined && { folder: holder.sessionFolder }),
        through,
      };
      changed = true;
    }
  }
  return changed;
}

/** Migrates every chat (including Main chat savedForks, group members, and teammate helpers). */
export function migrateChatSessions(chats, defaultProviderId = "copilot") {
  let changed = false;
  const visit = (holder) => {
    if (!holder || typeof holder !== "object") return;
    if (migrateSessionHolder(holder, defaultProviderId)) changed = true;
    for (const member of Object.values(holder.members ?? {})) {
      if (migrateSessionHolder(member, defaultProviderId)) changed = true;
    }
    for (const helper of Object.values(holder.helpers ?? {})) {
      if (migrateSessionHolder(helper, defaultProviderId)) changed = true;
    }
    for (const fork of Object.values(holder.savedForks ?? {})) visit(fork);
  };
  for (const chat of chats ?? []) visit(chat);
  return changed;
}

/** Lists every `[sessionId, providerId]` tracked on a holder across all harnesses. */
export function holderSessions(holder, defaultSessionId, defaultProviderId = "copilot") {
  const out = [];
  const seen = new Set();
  for (const [providerId, entry] of Object.entries(holder?.sessions ?? {})) {
    const id = entry?.ref || defaultSessionId;
    const key = providerId + "\0" + id;
    if (!seen.has(key)) {
      seen.add(key);
      out.push([id, providerId]);
    }
  }
  if (holder?.established) {
    const providerId = holder.sessionProvider ?? defaultProviderId;
    const id = holder.sessionId ?? defaultSessionId;
    const key = providerId + "\0" + id;
    if (!seen.has(key)) {
      seen.add(key);
      out.push([id, providerId]);
    }
  }
  return out;
}
