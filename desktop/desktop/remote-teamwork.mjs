// The source turn waits for Host B's decision and reply. A lost response repeats the same
// request ID. The only context sent to the other computer is the message shown in its card.
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { globalAccess } from "./access.mjs";
import { isGroup } from "./groups.mjs";

export function remoteTeamworkAllowed(ws, bot, chat, run, task) {
  if (!ws.teamworkPeers?.available()) return false;
  const source = ws.state.bots.find(item => item.id === bot.id);
  if (!source || chat.botId !== source.id || ws.state.settings.teamwork === false || source.teamwork === false ||
      source.hidden || (source.createdBy && source.createdBy !== "owner") ||
      isGroup(chat) || chat.group || chat.helper || chat.hostDispatch || run?.panelId) return false;
  // A restricted project's grants name local bots. An identically named bot elsewhere
  // has no project grant. Remote teammates never receive a project folder or transcript.
  if (ws.projects.projectOf(chat) && !globalAccess(ws.state)) return false;
  return ws.turnPeople(chat, task).people.every((person) => person === "owner") && !ws.chatPeople(chat.id).invited.length;
}

export function requireRemoteTurn(ws, bot, chat, run, task) {
  if (!run || task.stopped || task.ended || ws.closing || ws.active.get(chat.id) !== task)
    throw new Error("This turn is no longer active.");
  if (!remoteTeamworkAllowed(ws, bot, chat, run, task))
    throw new Error("Cross-host Teamwork is available in a private owner chat with Teamwork and access enabled.");
}

export async function peerRoster(peers, hostId) {
  const hosts = await peers.hosts(hostId !== undefined);
  if (hostId === undefined) return { hosts };
  const host = hosts.find((item) => item.serverId === hostId);
  if (!host) throw new Error("Choose a computer from list_host_teammates.");
  const bots = await peers.call(host.serverId, "list", {}, host.pin);
  if (!Array.isArray(bots)) throw new Error("That computer could not list its teammates.");
  return { host: { serverId: host.serverId, name: host.name }, bots, pin: host.pin };
}

/**
 * Discovers versioned capabilities on one or all same-owner hosts.
 * A sleeping or unreachable host is reported as unavailable rather than failing discovery.
 */
export async function peerCapabilities(peers, hostId) {
  const hosts = await peers.hosts(true);
  if (hostId !== undefined) {
    const host = hosts.find((item) => item.serverId === hostId);
    if (!host) throw new Error("Choose a computer from list_node_hosts.");
    try {
      const capabilities = await peers.call(host.serverId, "capabilities", {}, host.pin);
      return {
        host: { serverId: host.serverId, name: capabilities?.name || host.name },
        online: capabilities?.online !== false,
        unavailable: false,
        capabilities,
        pin: host.pin,
      };
    } catch (error) {
      if (error?.code === "TEAMWORK_OFFLINE") {
        return {
          host: { serverId: host.serverId, name: host.name },
          online: false,
          unavailable: true,
          capabilities: null,
          pin: host.pin,
        };
      }
      throw error;
    }
  }
  const nodes = await Promise.all(
    hosts.map(async (host) => {
      try {
        const capabilities = await peers.call(host.serverId, "capabilities", {}, host.pin);
        return {
          serverId: host.serverId,
          name: capabilities?.name || host.name,
          role: capabilities?.role || "standard",
          online: capabilities?.online !== false,
          paused: !!capabilities?.paused,
          wholeComputer: !!capabilities?.wholeComputer,
          ...(capabilities?.execPolicy && { execPolicy: capabilities.execPolicy }),
          unavailable: false,
          version: capabilities?.version ?? 1,
          bots: Array.isArray(capabilities?.bots) ? capabilities.bots : [],
          operations: Array.isArray(capabilities?.operations) ? capabilities.operations : [],
          projects: Array.isArray(capabilities?.projects) ? capabilities.projects : [],
        };
      } catch (error) {
        if (error?.code === "TEAMWORK_OFFLINE") {
          return {
            serverId: host.serverId,
            name: host.name,
            role: "unknown",
            online: false,
            paused: false,
            unavailable: true,
            bots: [],
            operations: [],
            projects: [],
          };
        }
        return {
          serverId: host.serverId,
          name: host.name,
          role: "standard",
          online: false,
          paused: false,
          unavailable: true,
          error: String(error?.message || "Unavailable"),
          bots: [],
          operations: [],
          projects: [],
        };
      }
    }),
  );
  return { hosts: nodes };
}

// Journal the destination identity and request ID before submitting. If a recovered source
// turn no longer owns its wait, cancel on the next connection, even if the chat was deleted.
export class OutgoingDispatches {
  live = new Set();
  cancelling = new Map();
  constructor(ws, saved) {
    this.ws = ws;
    this.pending = new Map();
    for (const record of Array.isArray(saved) ? saved : []) {
      if (typeof record?.id === "string" && typeof record.hostId === "string" && typeof record.pin === "string")
        this.pending.set(record.id, record);
    }
  }

  start(entry, pin, { cancelOp = "cancel" } = {}) {
    const { id, remote: { hostId } } = entry;
    this.live.add(id);
    this.pending.set(id, { id, hostId, pin, ...(cancelOp !== "cancel" && { cancelOp }) });
    this.ws.save();
  }

  finish(id) {
    this.live.delete(id);
    if (this.pending.delete(id)) this.ws.save();
  }

  cancel(id) {
    this.live.delete(id);
    if (this.cancelling.has(id)) return this.cancelling.get(id);
    const record = this.pending.get(id);
    if (!record || !this.ws.teamworkPeers?.available()) return;
    const cancelOp = record.cancelOp === "job.cancel" ? "job.cancel" : "cancel";
    const attempt = (async () => {
      try {
        const { status } = await this.ws.teamworkPeers.call(record.hostId, cancelOp, { id }, record.pin);
        if (["cancelled", "answered", "completed", "failed", "denied"].includes(status)) this.finish(id);
      } catch {
        // Retain the durable ID. An offline, signed-out or re-paired machine may come back.
      }
    })().finally(() => this.cancelling.delete(id));
    this.cancelling.set(id, attempt);
    return attempt;
  }

  async reconcile() {
    if (!this.pending.size || !this.ws.teamworkPeers?.available() || this.cancelling.size) return;
    // Move each attempted ID to the back so an offline computer cannot starve other hosts.
    const retry = [...this.pending.values()].filter(record => !this.live.has(record.id)).slice(0, 4);
    for (const record of retry) {
      this.pending.delete(record.id);
      this.pending.set(record.id, record);
    }
    await Promise.all(retry.map(record => this.cancel(record.id)));
  }
}

export async function remoteReply(ws, bot, chat, run, task, entry, message, pin) {
  const { hostId } = entry.remote;
  const peers = ws.teamworkPeers;
  const submit = { id: entry.id, sourceBotId: bot.id, sourceBotName: bot.name, targetBotId: entry.botId, message, createdAt: entry.started };
  const receipt = { id: entry.id };
  const controller = new AbortController();
  const outgoing = ws.teamwork.outgoing;
  outgoing.start(entry, pin);
  const helper = { abort: async () => { controller.abort(); await outgoing.cancel(entry.id); } };
  (task.helpers ??= new Set()).add(helper);
  let operation = "submit";
  let finished = false;
  let delay = 0;
  try {
    while (true) {
      requireRemoteTurn(ws, bot, chat, run, task);
      if (delay) await wait(delay, undefined, { signal: controller.signal });
      requireRemoteTurn(ws, bot, chat, run, task);
      let result;
      try {
        result = await peers.call(hostId, operation, operation === "submit" ? submit : receipt, pin);
      } catch (error) {
        if (error.code !== "TEAMWORK_OFFLINE") throw error;
        // The remote may already have accepted a submit whose reply was lost.
        delay = Math.min(15000, Math.max(1500, delay * 2));
        continue;
      }
      requireRemoteTurn(ws, bot, chat, run, task);
      if (result?.status === "pending" || result?.status === "working") {
        const status = result.status === "pending" ? "waiting" : "working";
        if (entry.status !== status) {
          entry.status = status;
          ws.notify();
        }
        operation = "status";
        delay = 3000;
        continue;
      }
      if (result?.status === "answered" && typeof result.reply === "string" && result.reply.trim()) {
        finished = true;
        return result.reply.slice(0, 32000);
      }
      if (["denied", "cancelled", "failed"].includes(result?.status)) {
        finished = true;
        if (result.status === "denied") throw new Error("The owner declined this request.");
        if (result.status === "cancelled") throw new Error("The request was cancelled on the other computer.");
        throw new Error(result.error || "The remote teammate could not finish.");
      }
      throw new Error("The other computer returned an invalid Teamwork response.");
    }
  } finally {
    task.helpers.delete(helper);
    if (finished) outgoing.finish(entry.id);
    else await outgoing.cancel(entry.id);
  }
}

/**
 * Runs a bounded operation on another same-owner node host.
 * Retries reuse the same request ID so a reconnect never executes the job twice.
 */
export async function remoteJob(ws, bot, chat, run, task, entry, payload, pin, { pollMs = 1000 } = {}) {
  const { hostId } = entry.remote;
  const peers = ws.teamworkPeers;
  const submit = {
    id: entry.id,
    sourceBotId: bot.id,
    sourceBotName: bot.name,
    operation: payload.operation,
    resourceId: payload.resourceId ?? "",
    path: payload.path ?? "",
    ...(payload.params !== undefined && { params: payload.params }),
    createdAt: entry.started,
  };
  const receipt = { id: entry.id };
  const controller = new AbortController();
  const outgoing = ws.teamwork.outgoing;
  outgoing.start(entry, pin, { cancelOp: "job.cancel" });
  const helper = { abort: async () => { controller.abort(); await outgoing.cancel(entry.id); } };
  (task.helpers ??= new Set()).add(helper);
  let operation = "job.submit";
  let finished = false;
  let delay = 0;
  try {
    while (true) {
      requireRemoteTurn(ws, bot, chat, run, task);
      if (delay) await wait(delay, undefined, { signal: controller.signal });
      requireRemoteTurn(ws, bot, chat, run, task);
      let result;
      try {
        result = await peers.call(hostId, operation, operation === "job.submit" ? submit : receipt, pin);
      } catch (error) {
        if (error.code !== "TEAMWORK_OFFLINE") throw error;
        delay = Math.min(15000, Math.max(1500, delay * 2));
        continue;
      }
      requireRemoteTurn(ws, bot, chat, run, task);
      if (result?.status === "pending" || result?.status === "working") {
        const status = result.status === "pending" ? "waiting" : "working";
        const outputChanged =
          result.output &&
          (entry.output?.stdout !== result.output.stdout || entry.output?.stderr !== result.output.stderr);
        if (result.output) entry.output = result.output;
        if (entry.status !== status || outputChanged) {
          entry.status = status;
          ws.notify();
        }
        operation = "job.status";
        delay = result.status === "working" ? Math.min(pollMs, 500) : pollMs;
        continue;
      }
      if (result?.status === "completed" && result.result && typeof result.result === "object") {
        finished = true;
        return result.result;
      }
      if (["denied", "cancelled", "failed"].includes(result?.status)) {
        finished = true;
        if (result.status === "denied") throw new Error("The owner declined this request.");
        if (result.status === "cancelled") throw new Error("The request was cancelled on the node host.");
        throw new Error(result.error || "The node host could not finish this request.");
      }
      throw new Error("The node host returned an invalid response.");
    }
  } finally {
    task.helpers.delete(helper);
    if (finished) outgoing.finish(entry.id);
    else await outgoing.cancel(entry.id);
  }
}

/**
 * Fetches live status from another same-owner node host (read-only).
 * Same-owner authorization is enforced by teamwork-peers (never phones or team members).
 */
export async function remoteNodeStatus(peers, hostId) {
  if (!peers?.available()) throw new Error("Cross-host controls require sign-in and host linking.");
  const hosts = await peers.hosts(true);
  const host = hosts.find((item) => item.serverId === hostId);
  if (!host) throw new Error("Unknown or unreachable same-owner host.");
  const status = await peers.call(host.serverId, "control.status", {}, host.pin);
  return { hostId: host.serverId, hostName: host.name, nodeHost: status };
}

/**
 * Runs an owner-only remote node management control on another same-owner host
 * (pause, resume, share, unshare, revoke, rename, disconnect) using the node's
 * trusted-device approval and grant model. Retries reuse the same request ID.
 */
export async function remoteNodeControl(
  peers,
  hostId,
  action,
  params = {},
  { pollMs = 1500, timeoutMs = 5 * 60_000, signal } = {},
) {
  if (!peers?.available()) throw new Error("Cross-host controls require sign-in and host linking.");
  const hosts = await peers.hosts(true);
  const host = hosts.find((item) => item.serverId === hostId);
  if (!host) throw new Error("Unknown or unreachable same-owner host.");

  const requestId = params.requestId || randomUUID();
  const submit = {
    id: requestId,
    action,
    ...(params.projectId && { projectId: params.projectId }),
    ...(params.grantId && { grantId: params.grantId }),
    ...(params.name && { name: params.name }),
    createdAt: Date.now(),
  };
  const receipt = { id: requestId };
  let operation = "control.submit";
  let delay = 0;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (signal?.aborted) {
      await peers.call(host.serverId, "control.cancel", receipt, host.pin).catch(() => {});
      throw new Error("Remote node control was cancelled.");
    }
    if (Date.now() > deadline) {
      await peers.call(host.serverId, "control.cancel", receipt, host.pin).catch(() => {});
      throw new Error("Timed out waiting for approval on the node host.");
    }
    if (delay) await wait(delay, undefined, { signal });
    let result;
    try {
      result = await peers.call(
        host.serverId,
        operation,
        operation === "control.submit" ? submit : receipt,
        host.pin,
      );
    } catch (error) {
      if (error.code !== "TEAMWORK_OFFLINE") throw error;
      delay = Math.min(10_000, Math.max(pollMs, delay * 2));
      continue;
    }
    if (result?.status === "pending" || result?.status === "working") {
      operation = "control.poll";
      delay = pollMs;
      continue;
    }
    if (result?.status === "completed" && result.result && typeof result.result === "object") {
      return { hostId: host.serverId, hostName: host.name, ...result.result };
    }
    if (result?.status === "denied") throw new Error("The owner declined this remote node control request.");
    if (result?.status === "cancelled") throw new Error("The remote node control request was cancelled.");
    if (result?.status === "failed") throw new Error(result.error || "The node host could not complete this control request.");
    throw new Error("The node host returned an invalid remote control response.");
  }
}
