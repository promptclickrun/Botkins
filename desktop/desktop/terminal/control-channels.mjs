// Control socket handlers for Channel Hooks (`botkins channels ...`).
// Strictly owner-only: reached only by the local owner socket.

import { ControlError } from "./socket.mjs";

export function channelsApi({ workspace, handlers, bot }) {
  const resolveConnection = (ref) => {
    const conn = workspace.channels.find(ref);
    if (!conn) throw new ControlError(`No channel connection matching "${ref}".`, "NOT_FOUND");
    return conn;
  };

  return {
    "channels.list": () => handlers.channelsList(),
    async "channels.add"([input]) {
      if (!input || typeof input !== "object") throw new ControlError("Provide channel configuration.", "BAD_ARGUMENT");
      const next = { ...input };
      if (next.bot && !next.botId) {
        const found = bot(next.bot);
        next.botId = found.id;
        delete next.bot;
      }
      return await handlers.channelAdd(next);
    },
    async "channels.update"([ref, patch]) {
      const conn = resolveConnection(ref);
      const next = { ...(patch ?? {}) };
      if (next.bot && !next.botId) {
        const found = bot(next.bot);
        next.botId = found.id;
        delete next.bot;
      }
      return await handlers.channelUpdate(conn.id, next);
    },
    async "channels.remove"([ref]) {
      const conn = resolveConnection(ref);
      return await handlers.channelRemove(conn.id);
    },
    async "channels.bind"([ref, botRef]) {
      const conn = resolveConnection(ref);
      const found = bot(botRef);
      return await handlers.channelBind(conn.id, found.id);
    },
    async "channels.policy"([ref, policy]) {
      const conn = resolveConnection(ref);
      return await handlers.channelSetPolicy(conn.id, policy ?? {});
    },
    async "channels.pause"([ref]) {
      const conn = resolveConnection(ref);
      return await handlers.channelPause(conn.id);
    },
    async "channels.resume"([ref]) {
      const conn = resolveConnection(ref);
      return await handlers.channelResume(conn.id);
    },
    "channels.pair.list": ([ref]) => {
      const conn = ref ? resolveConnection(ref) : null;
      return handlers.channelPairList(conn?.id ?? null);
    },
    async "channels.pair.approve"([code, ref]) {
      const conn = ref ? resolveConnection(ref) : null;
      return await handlers.channelPairApprove(code, conn?.id ?? null);
    },
    async "channels.pair.deny"([code, ref]) {
      const conn = ref ? resolveConnection(ref) : null;
      return await handlers.channelPairDeny(code, conn?.id ?? null);
    },
    async "channels.test"([ref]) {
      const conn = resolveConnection(ref);
      return await handlers.channelTest(conn.id);
    },
    "channels.logs": ([ref, options]) => {
      const conn = ref ? resolveConnection(ref) : null;
      return handlers.channelLogs(conn?.id ?? null, options ?? {});
    },
  };
}
