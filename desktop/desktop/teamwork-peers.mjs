// Host-to-host teamwork has its own keys and a four-operation interface. A peer never becomes
// a paired device. The profile service supplies the owner directory, never the Link private key.
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { agree, b64u, box, hkdf, random, unb64u, unbox } from "./link/crypto.mjs";
import { findHost, normalizeHost } from "./remote/link-client.mjs";

const operations = new Set([
  "list",
  "submit",
  "status",
  "cancel",
  "capabilities",
  "job.submit",
  "job.status",
  "job.cancel",
  "job.answer",
  "control.status",
  "control.submit",
  "control.poll",
  "control.cancel",
  "migrate.begin",
  "migrate.chunk",
  "migrate.commit",
  "migrate.verify",
  "migrate.activate",
  "migrate.rollback",
]);
const nodeOperations = new Set([
  "capabilities",
  "job.submit",
  "job.status",
  "job.cancel",
  "job.answer",
  "control.status",
  "control.submit",
  "control.poll",
  "control.cancel",
  "migrate.begin",
  "migrate.chunk",
  "migrate.commit",
  "migrate.verify",
  "migrate.activate",
  "migrate.rollback",
]);
const trackedOperations = new Set(["submit", "status", "job.submit", "job.status", "job.answer", "control.submit", "control.poll"]);
const cancelOperations = new Set(["cancel", "job.cancel", "control.cancel"]);
const windowMs = 60_000;
const statusCacheMs = 10_000;
const maxReplyBytes = 1024 * 1024;
const pending = (value) => value?.status === "pending" || value?.status === "working";
const validKey = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) && b64u(unb64u(value)) === value;
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 160;
const nonce = () => b64u(random(16));
const validNonce = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value);
function routeAddress(route) {
  if (typeof route !== "string" || route.length > 320) return null;
  const ipv6 = /^\[([^\]]+)\]:(\d{1,5})$/.exec(route);
  if (ipv6 && isIP(ipv6[1]) === 6 && Number(ipv6[2]) > 0 && Number(ipv6[2]) <= 65535) return route;
  if (!route.startsWith("relay!") && !/^[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(route)) return null;
  return normalizeHost(route);
}
const denied = () => new Error("These computers must both belong to the same Botkins profile.");
const offline = () => Object.assign(new Error("The computer or profile service is temporarily unreachable."), { code: "TEAMWORK_OFFLINE" });

function pinFor(profileId, source, target) {
  return createHash("sha256").update(JSON.stringify([profileId, source.serverId, source.serverKey, target.serverId, target.serverKey])).digest("hex");
}

function keyFor(keys, otherKey, profileId, sourceId, targetId) {
  return hkdf(agree(keys, unb64u(otherKey)), Buffer.from(JSON.stringify([profileId, sourceId, targetId])), "botkins/teamwork-host/v1");
}

// A stale LAN address can answer hello before its identity is known. Bound direct response
// bodies while reading them. Relay responses are already bounded by the relay frame limit.
async function boundedResponse(response) {
  if (!response.body?.getReader) return response;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxReplyBytes) {
        await reader.cancel();
        throw new Error("Teamwork response is too large.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return { ok: response.ok, status: response.status, json: () => JSON.parse(Buffer.concat(chunks, length).toString("utf8")) };
}

export function installTeamworkPeers({ workspace, link }, profile, transport = globalThis.fetch) {
  const fetchPeer = (url, init) => transport(url, { ...init, redirect: "error" }).then(boundedResponse);
  const boot = nonce();
  const used = new Map();
  let active = 0;
  let lookup;
  let cached;
  function owner() {
    const binding = link.store.data.profiles?.owner;
    const id = binding?.profileId;
    if (!link.enabled || !link.server || profile.localDisconnected || binding?.revoked || !validId(id) || profile.session?.profileId !== id || !profile.token()) throw denied();
    return id;
  }
  // A pending status carries only its state. All other operations need a live lookup.
  // Approval and terminal replies also bypass reads started before the decision or result.
  function readHome(token, mode) {
    const now = Date.now();
    if ((mode === "status" || mode === "job.status") && cached?.token === token && now < cached.until) return cached.home;
    if (mode !== "fresh" && lookup?.token === token) return lookup.promise;
    cached = null;
    const entry = { token };
    lookup = entry;
    entry.promise = profile.profileApi().home(token).then(({ profile, hosts }) => {
      const home = { profile, hosts };
      if (lookup === entry) cached = { token, home, until: now + statusCacheMs };
      return home;
    }).finally(() => { if (lookup === entry) lookup = null; });
    return entry.promise;
  }
  async function directory(mode = "live") {
    const profileId = owner();
    const token = profile.token();
    let home;
    try { home = await readHome(token, mode); } catch (error) {
      if (error?.status === 401 || error?.status === 403) throw denied();
      throw offline();
    }
    if (owner() !== profileId || profile.token() !== token || home?.profile?.id !== profileId || !Array.isArray(home.hosts)) throw denied();
    const rows = home.hosts;
    const uniqueOwner = (id) => {
      const found = rows.filter((row) => row?.serverId === id);
      const row = found[0];
      if (found.length !== 1 || (row.member !== undefined && row.member !== false) || !validId(row.serverId) || !validKey(row.serverKey)) throw denied();
      return row;
    };
    const local = uniqueOwner(link.store.data.serverId);
    if (local.serverKey !== b64u(link.store.data.keys.publicKey)) throw denied();
    function other(id) {
      const remote = uniqueOwner(id);
      if (remote.serverId === local.serverId || remote.serverKey === local.serverKey) throw denied();
      return remote;
    }
    return { profileId, local, rows, other };
  }
  async function verify(peer) {
    const { profileId, local, other } = await directory("fresh");
    if (profileId !== peer.profileId || local.serverId !== peer.targetId || local.serverKey !== peer.targetKey || other(peer.serverId).serverKey !== peer.serverKey) throw denied();
  }
  async function receive(message) {
    const profileId = owner();
    if (active >= 24) throw offline();
    if (!validKey(message.publicKey) || !validId(message.from) || typeof message.box !== "string") throw denied();
    const { serverId: targetId, keys } = link.store.data;
    const key = keyFor(keys, message.publicKey, profileId, message.from, targetId);
    const request = unbox(key, message.box, "teamwork/request");
    const { id, at, operation } = request;
    if (request.boot !== boot || !validNonce(id) || used.has(id) || !Number.isSafeInteger(at) || Math.abs(Date.now() - at) > windowMs || !operations.has(operation)) throw denied();
    active++;
    try {
      const { local, other, profileId: current } = await directory(operation);
      const source = other(message.from);
      if (local.serverId !== targetId || local.serverKey !== b64u(keys.publicKey) || source.serverKey !== message.publicKey || profileId !== current) throw denied();
      const now = Date.now();
      for (const [token, expiry] of used) if (expiry < now) used.delete(token);
      if (at + windowMs < now || used.has(id)) throw denied();
      if (used.size >= 4096) throw offline();
      used.set(id, at + windowMs);
      const peer = { profileId, serverId: source.serverId, serverKey: source.serverKey, name: source.name, targetId, targetKey: local.serverKey, targetName: local.name };
      peer.verify = () => verify(peer);
      let reply;
      try {
        reply = {
          value: await (nodeOperations.has(operation)
            ? workspace.nodeHost.receive(peer, operation, request.payload)
            : workspace.hostDispatch.receive(peer, operation, request.payload)),
        };
      } catch (error) {
        reply = { error: String(error?.message || "The teamwork request failed.").slice(0, 360) };
      }
      if (trackedOperations.has(operation)) {
        // A pending job's approval (ask) is shown to the owner on the asking computer, so it is sent only after the peer checks out, as output is.
        if (pending(reply.value) && !reply.value?.output && !reply.value?.ask) reply.value = { status: reply.value.status };
        else await peer.verify();
      }
      if (cancelOperations.has(operation) && reply.value) reply.value = { status: reply.value.status };
      const sealed = box(key, reply, "teamwork/reply/" + id);
      if (sealed.length + 10 > maxReplyBytes) return { box: box(key, { error: "Teamwork response is too large." }, "teamwork/reply/" + id) };
      return { box: sealed };
    } finally { active--; }
  }
  link.teamworkPeer = { boot, receive };
  workspace.teamworkPeers = {
    available() { try { return !!owner(); } catch { return false; } },
    verify,
    async hosts(withPin = false) {
      const { rows, other, profileId, local } = await directory();
      return rows.flatMap((row) => {
        try {
          const remote = other(row?.serverId);
          return [{ serverId: remote.serverId, name: remote.name, ...(withPin && { pin: pinFor(profileId, local, remote) }) }];
        } catch { return []; }
      });
    },
    async call(serverId, operation, payload, pin) {
      if (!operations.has(operation)) throw new Error("Unknown teamwork operation.");
      const { profileId, local, other } = await directory(operation);
      const remote = other(serverId);
      if (pin !== undefined && pin !== pinFor(profileId, local, remote)) throw denied();
      const routes = (Array.isArray(remote.hosts) ? remote.hosts : []).slice(0, 16).map(routeAddress).filter(Boolean);
      let found;
      try { found = await findHost(fetchPeer, routes, remote); } catch { throw offline(); }
      if (!validNonce(found.hello.teamworkBoot)) throw new Error("Update Botkins on the other computer to use host teamwork.");
      if (owner() !== profileId) throw denied();
      const key = keyFor(link.store.data.keys, remote.serverKey, profileId, local.serverId, serverId);
      const id = nonce();
      const request = { id, boot: found.hello.teamworkBoot, at: Date.now(), operation, payload };
      const body = JSON.stringify({ teamwork: 1, from: local.serverId, publicKey: local.serverKey, box: box(key, request, "teamwork/request") });
      if (Buffer.byteLength(body) > 512 * 1024) throw new Error("That teamwork request is too large.");
      let response;
      try {
        response = await fetchPeer("http://" + found.host + "/botkins/v1/profile", { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(12_000) });
      } catch { throw offline(); }
      if (response.status === 429 || response.status >= 500) throw offline();
      if (!response.ok) throw denied();
      const sealed = await response.json();
      const reply = unbox(key, sealed.box, "teamwork/reply/" + id);
      if (trackedOperations.has(operation)) {
        if (pending(reply.value) && !reply.value?.output && !reply.value?.ask) return { status: reply.value.status };
        await verify({ profileId, targetId: local.serverId, targetKey: local.serverKey, serverId, serverKey: remote.serverKey });
      }
      if (reply.error) throw new Error(reply.error);
      return reply.value;
    },
  };
  return workspace.teamworkPeers;
}
