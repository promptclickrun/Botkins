/**
 * iMessage Channel Adapter (local `imsg` CLI or via a Mac node host).
 *
 * Local mode:
 * - Discovers `imsg` via `findImsgProgram()` from `mactools.mjs` (never uses a shell).
 * - Watches inbound messages with `imsg watch --json` (spawned with an argument array, `shell: false`)
 *   and reconnects with exponential backoff on exits.
 * - Replies via `imsg send --chat-id <id> --text <text>` using `launchProgram` + `option` from `mactools.mjs`.
 *
 * Via-node mode (`connection.nodeHostId`):
 * - Uses the owner's encrypted `teamwork-peers` transport through `nodeBridge` to invoke
 *   `channel.imessage.watch` and `channel.imessage.send` on the bound Mac node host.
 * - Detects macOS Automation permission blocks ("Botkins wants access to control Messages" prompt /
 *   AppleEvent -1743 / timeout) and surfaces `"waiting for macOS permission on <node>"` status
 *   instead of hanging.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { findImsgProgram, IMSG_MISSING, launchProgram, NO_DISK_ACCESS, option } from "../../mactools.mjs";
import { peerCapabilities } from "../../remote-teamwork.mjs";
import { formatForChannel, splitMessage } from "../format.mjs";

export const IMESSAGE_CAPABILITIES = Object.freeze({
  maxLength: 4000,
  markdownFlavor: "plain",
  threads: false,
  files: true,
  typing: false,
});

const AUTOMATION_BLOCK_RE =
  /-1743|not authori[sz]ed to send apple events|apple events|automation|waiting for macos permission|control messages/i;
const FULL_DISK_BLOCK_RE =
  /full disk access|operation not permitted|permission denied|authorization denied|unable to open database|cannot open database|EPERM|EACCES/i;

/** Returns true when an imsg error or timeout indicates macOS Automation permission is blocking Messages control. */
export function isAutomationPermissionBlock(text = "", timedOut = false) {
  if (timedOut) return true;
  return AUTOMATION_BLOCK_RE.test(String(text || ""));
}

/** Returns true when an imsg error indicates macOS Full Disk Access is missing. */
export function isFullDiskPermissionBlock(text = "") {
  return FULL_DISK_BLOCK_RE.test(String(text || ""));
}

/** Formats the standardized permission-waiting status message. */
export function permissionWaitingDetail(nodeLabel = "") {
  return nodeLabel
    ? `waiting for macOS permission on ${nodeLabel}`
    : "waiting for macOS permission";
}

/**
 * Normalizes a JSON record emitted by `imsg watch --json` or `imsg rpc` into the Channel Hooks
 * inbound event shape. Returns null for outbound (`is_from_me`) or empty/non-message records.
 */
export function normalizeImsgEvent(raw, { botHandle = "", botAliases = [] } = {}) {
  if (!raw || typeof raw !== "object") return null;
  // Unwrap JSON-RPC / wrapper envelopes if present (e.g. `imsg rpc` notification `{ method, params }`).
  const msg = raw.params && typeof raw.params === "object"
    ? (raw.params.message && typeof raw.params.message === "object" ? raw.params.message : raw.params)
    : raw.message && typeof raw.message === "object"
      ? raw.message
      : raw;

  const fromMe = Boolean(msg.is_from_me ?? msg.isFromMe ?? msg.from_me ?? msg.fromMe ?? false);
  const chatId = msg.chat_id ?? msg.chatId ?? msg.chat?.id ?? "";
  if (chatId === "" || chatId == null) return null;

  const senderId = String(
    msg.sender ??
      msg.sender_id ??
      msg.senderId ??
      msg.handle ??
      msg.from ??
      msg.author?.id ??
      "",
  ).trim();
  const senderDisplay = String(
    msg.sender_name ??
      msg.senderName ??
      msg.display_name ??
      msg.displayName ??
      msg.author?.name ??
      senderId,
  ).trim();

  const text = typeof msg.text === "string"
    ? msg.text
    : typeof msg.body === "string"
      ? msg.body
      : "";

  const attachmentsRaw = Array.isArray(msg.attachments) ? msg.attachments : [];
  const attachments = attachmentsRaw
    .filter((a) => a && typeof a === "object")
    .map((a) => ({
      name: String(a.filename || a.name || a.transfer_name || "attachment"),
      mimeType: String(a.mime_type || a.mimeType || a.uti || "application/octet-stream"),
      size: Number.isFinite(Number(a.size || a.total_bytes)) ? Number(a.size || a.total_bytes) : 0,
      ...(a.path && { path: String(a.path) }),
    }));

  if (!text.trim() && attachments.length === 0) return null;

  const participants = Array.isArray(msg.participants)
    ? msg.participants
    : Array.isArray(msg.chat?.participants)
      ? msg.chat.participants
      : [];
  const isGroup =
    Boolean(msg.is_group ?? msg.isGroup ?? msg.chat?.is_group ?? msg.chat?.isGroup) ||
    participants.length > 2;
  const isDirect = !isGroup;

  // Mention detection for group chats: explicit mention flag, or @alias / handle in text.
  let mentionsBot = Boolean(msg.mentions_bot ?? msg.mentionsBot ?? false);
  if (!mentionsBot && isGroup && text) {
    const needles = [botHandle, ...botAliases].filter((s) => typeof s === "string" && s.trim());
    const lower = text.toLowerCase();
    for (const needle of needles) {
      const clean = needle.trim().toLowerCase();
      if (lower.includes(`@${clean}`) || lower.includes(clean)) {
        mentionsBot = true;
        break;
      }
    }
  }

  const rawDate = msg.date ?? msg.created_at ?? msg.createdAt ?? msg.timestamp;
  const parsedTime = typeof rawDate === "number"
    ? rawDate
    : typeof rawDate === "string"
      ? Date.parse(rawDate)
      : NaN;
  const receivedAt = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : new Date().toISOString();

  return {
    channel: "imessage",
    conversationId: String(chatId),
    sender: {
      id: senderId || `chat-${chatId}`,
      display: senderDisplay || senderId || `chat-${chatId}`,
    },
    isDirect,
    mentionsBot,
    isFromSelf: fromMe,
    isBot: false,
    text,
    attachments,
    receivedAt,
    ...(msg.guid || msg.id ? { messageId: String(msg.guid || msg.id) } : {}),
  };
}

/**
 * Sends a single iMessage text via `imsg send --chat-id <id> --text <text>` using argument arrays
 * (never a shell). Detects macOS Automation permission blocks and timeouts cleanly.
 */
export async function runImsgSend({
  chatId,
  text,
  findImsg = findImsgProgram,
  launch = launchProgram,
  timeout = 15000,
  nodeLabel = "",
} = {}) {
  const cleanChatId = String(chatId ?? "").trim();
  if (!cleanChatId) {
    throw new Error("iMessage send requires a chatId.");
  }
  const cleanText = String(text ?? "");
  if (!cleanText.trim()) {
    return { ok: true, skipped: true };
  }

  const program = findImsg();
  if (!program) {
    const err = new Error(IMSG_MISSING);
    err.code = "IMSG_MISSING";
    throw err;
  }

  const args = ["send", ...option("--chat-id", cleanChatId), ...option("--text", cleanText)];
  const run = await launch(program, args, { timeout });

  if (run.missing) {
    const err = new Error(IMSG_MISSING);
    err.code = "IMSG_MISSING";
    throw err;
  }

  const combined = `${run.stderr || ""}\n${run.stdout || ""}`;
  if (run.timedOut || (run.code !== 0 && isAutomationPermissionBlock(combined, run.timedOut))) {
    return {
      ok: false,
      waitingForPermission: true,
      permissionKind: "automation",
      detail: permissionWaitingDetail(nodeLabel),
    };
  }

  if (run.code !== 0 && isFullDiskPermissionBlock(combined)) {
    return {
      ok: false,
      waitingForPermission: true,
      permissionKind: "full_disk",
      detail: permissionWaitingDetail(nodeLabel),
    };
  }

  if (run.code !== 0) {
    const line = combined.split("\n").map((l) => l.trim()).find(Boolean) || `imsg send exited with code ${run.code}`;
    throw new Error(line);
  }

  return { ok: true };
}

/**
 * Starts a local `imsg watch --json` child process (argument array, `shell: false`) and streams
 * normalized inbound events via `onEvent`.
 */
export function startImsgWatcherProcess({
  findImsg = findImsgProgram,
  spawnProcess = spawn,
  watchArgs = ["watch", "--json"],
  onEvent,
  onPermissionWaiting,
  onExit,
  nodeLabel = "",
} = {}) {
  const program = findImsg();
  if (!program) {
    const err = new Error(IMSG_MISSING);
    err.code = "IMSG_MISSING";
    throw err;
  }

  const child = spawnProcess(program, watchArgs, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdoutBuf = "";
  let stderrText = "";
  let closed = false;

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      const event = normalizeImsgEvent(parsed);
      if (event) onEvent?.(event);
    } catch {
      // Ignore non-JSON status lines from imsg watch.
    }
  };

  child.stdout?.on("data", (chunk) => {
    stdoutBuf += String(chunk);
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      handleLine(line);
    }
  });

  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    stderrText += text;
    if (stderrText.length > 4096) stderrText = stderrText.slice(-4096);
    if (isFullDiskPermissionBlock(text) || isAutomationPermissionBlock(text, false)) {
      onPermissionWaiting?.(permissionWaitingDetail(nodeLabel));
    }
  });

  child.on("error", (err) => {
    if (closed) return;
    closed = true;
    onExit?.({ code: 1, error: err, stderr: stderrText });
  });

  child.on("close", (code, signal) => {
    if (stdoutBuf.trim()) handleLine(stdoutBuf);
    if (closed) return;
    closed = true;
    onExit?.({ code: code ?? 0, signal: signal ?? null, stderr: stderrText });
  });

  return {
    stop() {
      closed = true;
      try {
        child.kill?.("SIGTERM");
      } catch {
        // Already exited.
      }
    },
  };
}

/**
 * Creates an iMessage Channel Adapter supporting both local `imsg` and Mac node host execution.
 */
export function createIMessageAdapter(deps = {}) {
  const findImsg = deps.findImsg ?? findImsgProgram;
  const launch = deps.launch ?? launchProgram;
  const spawnProcess = deps.spawnProcess ?? spawn;
  const sendTimeoutMs = deps.sendTimeoutMs ?? 15000;
  const pollIntervalMs = deps.pollIntervalMs ?? 1500;
  const reconnectBaseMs = deps.reconnectBaseMs ?? 1000;
  const reconnectMaxMs = deps.reconnectMaxMs ?? 30000;

  let running = false;
  let stopped = false;
  let watcher = null;
  let timer = null;
  let ctx = null;
  let cursor = 0;
  let backoffAttempt = 0;
  let nodeLabel = "";

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const nextBackoff = () => {
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** backoffAttempt);
    backoffAttempt = Math.min(backoffAttempt + 1, 10);
    return delay;
  };

  const isNodeMode = (connection) =>
    Boolean(connection?.nodeHostId) || connection?.transport === "imsg_node";

  const startLocalWatcher = () => {
    if (stopped || !ctx) return;
    try {
      watcher = startImsgWatcherProcess({
        findImsg,
        spawnProcess,
        onEvent: (event) => {
          backoffAttempt = 0;
          ctx?.onMessage?.(event);
        },
        onPermissionWaiting: (detail) => {
          ctx?.onStatus?.({ state: "waiting_permission", detail });
        },
        onExit: ({ code, error, stderr }) => {
          watcher = null;
          if (stopped || !ctx) return;
          const combined = `${error?.message || ""}\n${stderr || ""}`;
          if (isFullDiskPermissionBlock(combined) || isAutomationPermissionBlock(combined, false)) {
            ctx.onStatus?.({ state: "waiting_permission", detail: permissionWaitingDetail() });
          } else {
            const delay = nextBackoff();
            ctx.onStatus?.({
              state: "reconnecting",
              detail: `imsg watcher exited (${code ?? "error"}); retrying in ${Math.round(delay / 1000)}s.`,
            });
            clearTimer();
            timer = setTimeout(startLocalWatcher, delay);
            return;
          }
          const delay = nextBackoff();
          clearTimer();
          timer = setTimeout(startLocalWatcher, delay);
        },
      });
      backoffAttempt = 0;
      ctx.onStatus?.({ state: "connected", detail: "Watching local iMessage via imsg." });
    } catch (error) {
      if (error?.code === "IMSG_MISSING") {
        ctx.onStatus?.({ state: "disconnected", detail: IMSG_MISSING });
        throw error;
      }
      const delay = nextBackoff();
      ctx.onStatus?.({
        state: "reconnecting",
        detail: `iMessage watcher error: ${error?.message || "unknown"}; retrying.`,
      });
      clearTimer();
      timer = setTimeout(startLocalWatcher, delay);
    }
  };

  const pollNodeOnce = async (action = "poll") => {
    if (stopped || !ctx) return;
    const bridge = deps.nodeBridge ?? ctx.nodeBridge;
    const conn = ctx.connection;
    if (!bridge || typeof bridge.watch !== "function") {
      ctx.onStatus?.({
        state: "disconnected",
        detail: "Node host transport is not configured for this workspace.",
      });
      return;
    }
    try {
      const res = await bridge.watch(conn.nodeHostId, {
        action,
        connectionId: conn.id,
        botId: conn.botId,
        cursor,
      });
      if (stopped) return;
      if (res?.nodeName) nodeLabel = res.nodeName;
      const effectiveNode = nodeLabel || conn.nodeHostId;

      if (res?.waitingForPermission) {
        ctx.onStatus?.({
          state: "waiting_permission",
          detail: res.detail || permissionWaitingDetail(effectiveNode),
        });
      } else {
        backoffAttempt = 0;
        ctx.onStatus?.({
          state: "connected",
          detail: `Watching iMessage via node ${effectiveNode}.`,
        });
      }

      if (typeof res?.cursor === "number" && res.cursor > cursor) {
        cursor = res.cursor;
      }

      const events = Array.isArray(res?.events) ? res.events : [];
      for (const raw of events) {
        if (stopped) break;
        const normalized = raw?.channel === "imessage" && raw?.conversationId
          ? raw
          : normalizeImsgEvent(raw);
        if (normalized) {
          await ctx.onMessage?.(normalized);
        }
      }

      if (!stopped) {
        clearTimer();
        timer = setTimeout(() => void pollNodeOnce("poll"), pollIntervalMs);
      }
    } catch (error) {
      if (stopped || !ctx) return;
      const msg = error?.message || "Node watch failed.";
      const effectiveNode = nodeLabel || conn.nodeHostId;
      if (/denied|not granted|revoked|exec policy|not supported/i.test(msg)) {
        ctx.onStatus?.({ state: "auth_error", detail: msg });
        return;
      }
      if (isAutomationPermissionBlock(msg, false) || isFullDiskPermissionBlock(msg)) {
        ctx.onStatus?.({ state: "waiting_permission", detail: permissionWaitingDetail(effectiveNode) });
      } else {
        const delay = nextBackoff();
        ctx.onStatus?.({
          state: "reconnecting",
          detail: `Node ${effectiveNode} unavailable (${msg}); retrying.`,
        });
        clearTimer();
        timer = setTimeout(() => void pollNodeOnce("start"), delay);
        return;
      }
      const delay = nextBackoff();
      clearTimer();
      timer = setTimeout(() => void pollNodeOnce("poll"), delay);
    }
  };

  return {
    capabilities: IMESSAGE_CAPABILITIES,

    async start(startCtx) {
      ctx = startCtx;
      stopped = false;
      running = true;
      cursor = 0;
      backoffAttempt = 0;
      nodeLabel = startCtx?.connection?.nodeHostName || startCtx?.connection?.nodeHostId || "";

      if (startCtx?.signal) {
        startCtx.signal.addEventListener("abort", () => {
          void this.stop();
        }, { once: true });
      }

      if (isNodeMode(startCtx.connection)) {
        if (!startCtx.connection.nodeHostId) {
          throw new Error("iMessage node transport requires a nodeHostId.");
        }
        await pollNodeOnce("start");
      } else {
        startLocalWatcher();
      }
    },

    async stop() {
      stopped = true;
      running = false;
      clearTimer();
      if (watcher) {
        watcher.stop();
        watcher = null;
      }
      if (ctx && isNodeMode(ctx.connection)) {
        const bridge = deps.nodeBridge ?? ctx.nodeBridge;
        if (bridge && typeof bridge.watch === "function") {
          try {
            await bridge.watch(ctx.connection.nodeHostId, {
              action: "stop",
              connectionId: ctx.connection.id,
              botId: ctx.connection.botId,
            });
          } catch {
            // Best-effort remote cleanup on stop.
          }
        }
      }
    },

    async send({ conversationId, text }) {
      if (!ctx) throw new Error("iMessage adapter is not started.");
      const formatted = formatForChannel(text, IMESSAGE_CAPABILITIES.markdownFlavor);
      const chunks = splitMessage(formatted, IMESSAGE_CAPABILITIES.maxLength);
      const conn = ctx.connection;

      for (const chunk of chunks) {
        if (isNodeMode(conn)) {
          const bridge = deps.nodeBridge ?? ctx.nodeBridge;
          if (!bridge || typeof bridge.send !== "function") {
            throw new Error("Node host transport is not configured for iMessage send.");
          }
          const res = await bridge.send(conn.nodeHostId, {
            connectionId: conn.id,
            botId: conn.botId,
            chatId: String(conversationId),
            text: chunk,
          });
          if (res?.nodeName) nodeLabel = res.nodeName;
          const effectiveNode = nodeLabel || conn.nodeHostId;
          if (res?.waitingForPermission) {
            const detail = res.detail || permissionWaitingDetail(effectiveNode);
            ctx.onStatus?.({ state: "waiting_permission", detail });
            return { ok: false, waitingForPermission: true, detail };
          }
          if (res && res.ok === false) {
            throw new Error(res.error || "Node iMessage send failed.");
          }
        } else {
          const res = await runImsgSend({
            chatId: String(conversationId),
            text: chunk,
            findImsg,
            launch,
            timeout: sendTimeoutMs,
          });
          if (res.waitingForPermission) {
            ctx.onStatus?.({ state: "waiting_permission", detail: res.detail });
            return res;
          }
        }
      }

      if (running) {
        ctx.onStatus?.({
          state: "connected",
          detail: isNodeMode(conn)
            ? `Connected via node ${nodeLabel || conn.nodeHostId}.`
            : "Watching local iMessage via imsg.",
        });
      }
      return { ok: true, chunks: chunks.length };
    },

    async test({ connection, nodeBridge }) {
      if (isNodeMode(connection)) {
        const bridge = deps.nodeBridge ?? nodeBridge;
        if (!connection.nodeHostId) {
          return { ok: false, state: "disconnected", detail: "Select a Mac node host first." };
        }
        if (!bridge || typeof bridge.checkNode !== "function") {
          return { ok: false, state: "disconnected", detail: "Node host transport is unavailable." };
        }
        return bridge.checkNode(connection.nodeHostId);
      }

      const program = findImsg();
      if (!program) {
        return { ok: false, state: "disconnected", detail: IMSG_MISSING };
      }
      const run = await launch(program, ["chats", "--limit", "1", "--json"], { timeout: 10000 });
      if (run.missing) {
        return { ok: false, state: "disconnected", detail: IMSG_MISSING };
      }
      const combined = `${run.stderr || ""}\n${run.stdout || ""}`;
      if (run.timedOut || (run.code !== 0 && isAutomationPermissionBlock(combined, run.timedOut))) {
        return { ok: false, state: "waiting_permission", detail: permissionWaitingDetail() };
      }
      if (run.code !== 0 && isFullDiskPermissionBlock(combined)) {
        return { ok: false, state: "waiting_permission", detail: NO_DISK_ACCESS };
      }
      if (run.code !== 0) {
        return { ok: false, state: "disconnected", detail: combined.trim().slice(0, 200) || "imsg check failed." };
      }
      return { ok: true, state: "connected", detail: `imsg ready at ${program}.` };
    },
  };
}

/**
 * Builds a node-host bridge over the workspace's encrypted same-owner `teamwork-peers` transport
 * so iMessage channels can run `channel.imessage.watch` and `channel.imessage.send` on a bound Mac node.
 */
export function createNodeChannelBridge(workspace, { pollMs = 150, timeoutMs = 30000 } = {}) {
  const resolvePeer = async (nodeHostId) => {
    const peers = workspace?.teamworkPeers;
    if (!peers) throw new Error("Teamwork peers transport is unavailable on this host.");
    const hosts = await peers.hosts(true);
    const host = hosts.find((item) => item.serverId === nodeHostId);
    if (!host) throw new Error(`Mac node host "${nodeHostId}" is not linked to this account.`);
    return { peers, host };
  };

  const runJob = async (nodeHostId, operation, { botId = "", params = {} } = {}) => {
    const { peers, host } = await resolvePeer(nodeHostId);
    const bot = botId ? workspace.bot?.(botId) : null;
    const jobId = randomUUID();
    const submit = {
      id: jobId,
      sourceBotId: bot?.id || botId || "channel-imessage",
      sourceBotName: bot?.name || "Channel",
      operation,
      resourceId: "@imessage",
      path: "",
      params,
      createdAt: Date.now(),
    };
    const deadline = Date.now() + timeoutMs;
    let res = await peers.call(host.serverId, "job.submit", submit, host.pin);
    while (res && (res.status === "pending" || res.status === "working")) {
      if (Date.now() > deadline) {
        await peers.call(host.serverId, "job.cancel", { id: jobId }, host.pin).catch(() => {});
        throw new Error(`Timed out waiting for ${operation} on node ${host.name || host.serverId}.`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
      res = await peers.call(host.serverId, "job.status", { id: jobId }, host.pin);
    }
    if (!res || res.status !== "completed") {
      throw new Error(res?.error || `Node ${host.name || host.serverId} did not complete ${operation}.`);
    }
    return { nodeName: host.name || host.serverId, ...(res.result ?? {}) };
  };

  return {
    async watch(nodeHostId, { action = "poll", connectionId, botId, cursor = 0 } = {}) {
      return runJob(nodeHostId, "channel.imessage.watch", {
        botId,
        params: { action, connectionId, cursor },
      });
    },

    async send(nodeHostId, { connectionId, botId, chatId, text } = {}) {
      return runJob(nodeHostId, "channel.imessage.send", {
        botId,
        params: { connectionId, chatId, text },
      });
    },

    async checkNode(nodeHostId) {
      const peers = workspace?.teamworkPeers;
      if (!peers) return { ok: false, state: "disconnected", detail: "Teamwork peers transport is unavailable." };
      const info = await peerCapabilities(peers, nodeHostId);
      if (info.unavailable || !info.online) {
        return { ok: false, state: "reconnecting", detail: `Node ${info.host.name} is offline or paused.` };
      }
      const ops = new Set((info.capabilities?.operations || []).map((o) => o.id));
      if (!ops.has("channel.imessage.watch") || !ops.has("channel.imessage.send")) {
        return {
          ok: false,
          state: "auth_error",
          detail: `Node ${info.host.name} does not advertise iMessage channel operations (check macOS & exec policy).`,
        };
      }
      return { ok: true, state: "connected", detail: `Node ${info.host.name} ready for iMessage.` };
    },
  };
}

