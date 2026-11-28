// Unified multi-host view: scoped IDs, state composition across local + remote hosts,
// transparent IPC/Link call routing, and remote event diffing for notifications.
//
// Local entities keep their raw IDs (so local drafts, history, and existing single-host state stay
// unchanged). Remote entities are given reversible, URL-safe scoped IDs of the form:
//   rh~<encodedHostId>~<rawId>
// Every entity in a unified snapshot also carries `hostId` and `hostName` so every surface
// (bots, chats, approvals, notifications, tasks, routines, spaces) can show which computer owns it
// and route actions directly to that host without switching computers.

export const LOCAL_HOST_ID = "local";
export const SCOPED_PREFIX = "rh~";

/** Whether `value` is a non-empty string. */
const hasText = (value) => typeof value === "string" && value.length > 0;

/**
 * Prefixes `rawId` with `hostId` when `hostId` is a remote host.
 * Idempotent: an already-scoped ID or a local ID is returned unchanged.
 */
export function scopeId(hostId, rawId) {
  if (!hasText(rawId)) return rawId;
  if (!hasText(hostId) || hostId === LOCAL_HOST_ID) return rawId;
  if (rawId.startsWith(SCOPED_PREFIX)) return rawId;
  return SCOPED_PREFIX + encodeURIComponent(hostId).replace(/~/g, "%7E") + "~" + rawId;
}

/** Parses a scoped ID back into `{ hostId, rawId }`, or returns null for a local/unscoped ID. */
export function parseScopedId(id) {
  if (typeof id !== "string" || !id.startsWith(SCOPED_PREFIX)) return null;
  const sep = id.indexOf("~", SCOPED_PREFIX.length);
  if (sep <= SCOPED_PREFIX.length || sep >= id.length - 1) return null;
  try {
    const hostId = decodeURIComponent(id.slice(SCOPED_PREFIX.length, sep));
    const rawId = id.slice(sep + 1);
    if (!hostId || !rawId) return null;
    return { hostId, rawId };
  } catch {
    return null;
  }
}

/** Strips the host prefix if present, returning the raw entity ID on its owning host. */
export function unscopeId(id) {
  const parsed = parseScopedId(id);
  return parsed ? parsed.rawId : id;
}

/** Returns the owning host ID of an entity ID (`"local"` when unscoped). */
export function hostOfId(id) {
  return parseScopedId(id)?.hostId ?? LOCAL_HOST_ID;
}

/** Returns true when `id` belongs to a remote host in unified mode. */
export function isScopedId(id) {
  return parseScopedId(id) !== null;
}

function mapKeys(record, mapKey, mapValue) {
  if (!record || typeof record !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    out[mapKey(key)] = mapValue ? mapValue(value, key) : value;
  }
  return out;
}

function scopeActionCard(card, s) {
  if (!card || typeof card !== "object") return card;
  return {
    ...card,
    ...(hasText(card.dispatchedChatId) && { dispatchedChatId: s(card.dispatchedChatId) }),
    ...(hasText(card.dispatchedBotId) && { dispatchedBotId: s(card.dispatchedBotId) }),
    ...(card.dispatch && typeof card.dispatch === "object" && {
      dispatch: {
        ...card.dispatch,
        ...(hasText(card.dispatch.botId) && { botId: s(card.dispatch.botId) }),
      },
    }),
  };
}

function scopeChannel(conn, s, meta) {
  if (!conn || typeof conn !== "object") return conn;
  return {
    ...conn,
    id: s(conn.id),
    ...(hasText(conn.botId) && { botId: s(conn.botId) }),
    ...(Array.isArray(conn.pendingPairings) && {
      pendingPairings: conn.pendingPairings.map((p) =>
        p && typeof p === "object"
          ? { ...p, ...(hasText(p.connectionId) && { connectionId: s(p.connectionId) }) }
          : p,
      ),
    }),
    ...(meta ?? {}),
  };
}

function scopeWorkflow(wf, s, meta) {
  if (!wf || typeof wf !== "object") return wf;
  return {
    ...wf,
    id: s(wf.id),
    ...(Array.isArray(wf.nodes) && {
      nodes: wf.nodes.map((node) => {
        if (!node || typeof node !== "object" || !node.config || typeof node.config !== "object") return node;
        const cfg = { ...node.config };
        if (hasText(cfg.botId)) cfg.botId = s(cfg.botId);
        if (hasText(cfg.chatId)) cfg.chatId = s(cfg.chatId);
        if (hasText(cfg.routineChatId)) cfg.routineChatId = s(cfg.routineChatId);
        if (hasText(cfg.taskId)) cfg.taskId = s(cfg.taskId);
        return { ...node, config: cfg };
      }),
    }),
    ...(meta ?? {}),
  };
}

function scopeWorkflowRun(run, s, meta) {
  if (!run || typeof run !== "object") return run;
  return {
    ...run,
    id: s(run.id),
    ...(hasText(run.workflowId) && { workflowId: s(run.workflowId) }),
    ...(meta ?? {}),
  };
}

/** Tags local entities with `hostId: "local"` and `hostName` without altering any IDs. */
export function tagLocalSnapshot(snap, { hostName = "This computer", hostId = LOCAL_HOST_ID } = {}) {
  if (!snap || typeof snap !== "object") return snap;
  const tag = { hostId, hostName };
  const addTag = (list) => (Array.isArray(list) ? list.map((item) => (item && typeof item === "object" ? { ...item, ...tag } : item)) : list);
  return {
    ...snap,
    bots: addTag(snap.bots ?? []),
    sections: addTag(snap.sections ?? []),
    ...(Array.isArray(snap.chatSections) && { chatSections: addTag(snap.chatSections) }),
    chats: addTag(snap.chats ?? []),
    runs: addTag(snap.runs ?? []),
    requests: addTag(snap.requests ?? []),
    tasks: addTag(snap.tasks ?? []),
    ...(Array.isArray(snap.workflows) && { workflows: addTag(snap.workflows) }),
    ...(Array.isArray(snap.workflowRuns) && { workflowRuns: addTag(snap.workflowRuns) }),
    ...(Array.isArray(snap.channels) && { channels: addTag(snap.channels) }),
    projects: addTag(snap.projects ?? []),
    panels: addTag(snap.panels ?? []),
    board: addTag(snap.board ?? []),
    ...(Array.isArray(snap.spaces) && { spaces: addTag(snap.spaces) }),
    ...(Array.isArray(snap.templates) && { templates: addTag(snap.templates) }),
  };
}

/**
 * Rewrites all entity IDs and cross-references in a remote host's snapshot so they can be merged
 * into a unified multi-host state without colliding with local or other remote hosts.
 */
export function scopeRemoteSnapshot(snap, { hostId, hostName, member = false, team = "" } = {}) {
  if (!snap || typeof snap !== "object" || !hasText(hostId) || hostId === LOCAL_HOST_ID) return snap;
  const s = (id) => (hasText(id) ? scopeId(hostId, id) : id);
  const meta = {
    hostId,
    hostName: hostName || "Computer",
    ...(member && { hostMember: true }),
    ...(team && { hostTeam: team }),
  };

  const bots = (Array.isArray(snap.bots) ? snap.bots : []).map((bot) => ({
    ...bot,
    id: s(bot.id),
    ...(hasText(bot.sectionId) && { sectionId: s(bot.sectionId) }),
    primary: false,
    ...meta,
  }));

  const sections = (Array.isArray(snap.sections) ? snap.sections : []).map((section) => ({
    ...section,
    id: s(section.id),
    ...meta,
  }));

  const chatSections = Array.isArray(snap.chatSections)
    ? snap.chatSections.map((section) => ({ ...section, id: s(section.id), ...meta }))
    : undefined;

  const chats = (Array.isArray(snap.chats) ? snap.chats : []).map((chat) => ({
    ...chat,
    id: s(chat.id),
    botId: s(chat.botId),
    ...(Array.isArray(chat.botIds) && { botIds: chat.botIds.map(s) }),
    ...(hasText(chat.projectId) && { projectId: s(chat.projectId) }),
    ...(hasText(chat.sectionId) && { sectionId: s(chat.sectionId) }),
    ...(hasText(chat.forkedFrom) && { forkedFrom: s(chat.forkedFrom) }),
    ...(Array.isArray(chat.schedules) && {
      schedules: chat.schedules.map((sched) => ({
        ...sched,
        ...(sched?.deliver?.chatId && { deliver: { ...sched.deliver, chatId: s(sched.deliver.chatId) } }),
      })),
    }),
    ...(Array.isArray(chat.messages) && {
      messages: chat.messages.map((msg) => ({
        ...msg,
        ...(hasText(msg?.botId) && { botId: s(msg.botId) }),
        ...(hasText(msg?.runId) && { runId: s(msg.runId) }),
        ...(msg?.actionCard && { actionCard: scopeActionCard(msg.actionCard, s) }),
      })),
    }),
    ...meta,
  }));

  const runs = (Array.isArray(snap.runs) ? snap.runs : []).map((run) => ({
    ...run,
    id: s(run.id),
    ...(hasText(run.chatId) && { chatId: s(run.chatId) }),
    ...(hasText(run.botId) && { botId: s(run.botId) }),
    ...(run.delivery?.chatId && { delivery: { ...run.delivery, chatId: s(run.delivery.chatId) } }),
    ...meta,
  }));

  const requests = (Array.isArray(snap.requests) ? snap.requests : []).map((req) => ({
    ...req,
    id: s(req.id),
    ...(hasText(req.chatId) && { chatId: s(req.chatId) }),
    ...(hasText(req.botId) && { botId: s(req.botId) }),
    ...meta,
  }));

  const tasks = (Array.isArray(snap.tasks) ? snap.tasks : []).map((task) => ({
    ...task,
    id: s(task.id),
    ...(hasText(task.botId) && { botId: s(task.botId) }),
    ...(hasText(task.chatId) && { chatId: s(task.chatId) }),
    ...(hasText(task.projectId) && { projectId: s(task.projectId) }),
    ...meta,
  }));

  const workflows = Array.isArray(snap.workflows)
    ? snap.workflows.map((wf) => scopeWorkflow(wf, s, meta))
    : undefined;

  const workflowRuns = Array.isArray(snap.workflowRuns)
    ? snap.workflowRuns.map((run) => scopeWorkflowRun(run, s, meta))
    : undefined;

  const channels = Array.isArray(snap.channels)
    ? snap.channels.map((conn) => scopeChannel(conn, s, meta))
    : undefined;

  const projects = (Array.isArray(snap.projects) ? snap.projects : []).map((project) => ({
    ...project,
    id: s(project.id),
    ...(Array.isArray(project.todos) && {
      todos: project.todos.map((todo) => ({ ...todo, ...(hasText(todo?.id) && { id: s(todo.id) }) })),
    }),
    ...meta,
  }));

  const panels = (Array.isArray(snap.panels) ? snap.panels : []).map((panel) => ({
    ...panel,
    ...(hasText(panel.id) && { id: s(panel.id) }),
    ...(hasText(panel.botId) && { botId: s(panel.botId) }),
    ...(hasText(panel.chatId) && { chatId: s(panel.chatId) }),
    ...(hasText(panel.projectId) && { projectId: s(panel.projectId) }),
    ...meta,
  }));

  const board = (Array.isArray(snap.board) ? snap.board : []).map((item) => ({
    ...item,
    id: s(item.id),
    ...(hasText(item.botId) && { botId: s(item.botId) }),
    ...(hasText(item.chatId) && { chatId: s(item.chatId) }),
    ...meta,
  }));

  const spaces = Array.isArray(snap.spaces)
    ? snap.spaces.map((space) => ({
        ...space,
        id: s(space.id),
        ...(hasText(space.projectId) && { projectId: s(space.projectId) }),
        ...meta,
      }))
    : undefined;

  const templates = Array.isArray(snap.templates)
    ? snap.templates.map((tpl) => ({ ...tpl, id: s(tpl.id), ...meta }))
    : undefined;

  let proactive;
  if (snap.proactive && typeof snap.proactive === "object") {
    const mappedBots = {};
    for (const [botId, entry] of Object.entries(snap.proactive.bots ?? {})) {
      mappedBots[s(botId)] = entry && typeof entry === "object" && hasText(entry.chatId)
        ? { ...entry, chatId: s(entry.chatId) }
        : entry;
    }
    proactive = { ...snap.proactive, bots: mappedBots };
  }

  return {
    ...snap,
    bots,
    sections,
    ...(chatSections && { chatSections }),
    chats,
    runs,
    requests,
    streams: mapKeys(snap.streams, s),
    thinking: mapKeys(snap.thinking, s),
    intents: mapKeys(snap.intents, s),
    speakers: mapKeys(snap.speakers, s, (botId) => (hasText(botId) ? s(botId) : botId)),
    typing: mapKeys(snap.typing, s),
    queued: mapKeys(snap.queued, s),
    ...(snap.steerable && { steerable: mapKeys(snap.steerable, s) }),
    tasks,
    ...(workflows && { workflows }),
    ...(workflowRuns && { workflowRuns }),
    ...(channels && { channels }),
    projects,
    panels,
    board,
    ...(spaces && { spaces }),
    ...(templates && { templates }),
    ...(proactive && { proactive }),
  };
}

/**
 * Composes the local host snapshot and all included remote host snapshots into one unified State.
 * Local entities stay first for primary-bot semantics; chats and runs are merged chronologically.
 */
export function composeUnifiedDesktopState(localSnap, { localName = "This computer", remotes = [] } = {}) {
  const local = tagLocalSnapshot(localSnap, { hostId: LOCAL_HOST_ID, hostName: localName });
  const scopedRemotes = remotes.map((entry) =>
    scopeRemoteSnapshot(entry.snapshot, {
      hostId: entry.host.id,
      hostName: entry.host.name,
      member: entry.host.member === true,
      team: entry.host.team ?? "",
    }),
  );

  const bots = [...(local.bots ?? [])];
  const sections = [...(local.sections ?? [])];
  let chatSections = Array.isArray(local.chatSections) ? [...local.chatSections] : undefined;
  const chats = [...(local.chats ?? [])];
  const runs = [...(local.runs ?? [])];
  const requests = [...(local.requests ?? [])];
  const streams = { ...(local.streams ?? {}) };
  const thinking = { ...(local.thinking ?? {}) };
  const intents = { ...(local.intents ?? {}) };
  const speakers = { ...(local.speakers ?? {}) };
  const typing = { ...(local.typing ?? {}) };
  const queued = { ...(local.queued ?? {}) };
  const steerable = local.steerable ? { ...local.steerable } : {};
  const tasks = [...(local.tasks ?? [])];
  let workflows = Array.isArray(local.workflows) ? [...local.workflows] : undefined;
  let workflowRuns = Array.isArray(local.workflowRuns) ? [...local.workflowRuns] : undefined;
  let channels = Array.isArray(local.channels) ? [...local.channels] : undefined;
  const projects = [...(local.projects ?? [])];
  const panels = [...(local.panels ?? [])];
  const board = [...(local.board ?? [])];
  let spaces = Array.isArray(local.spaces) ? [...local.spaces] : undefined;
  const templates = [...(local.templates ?? [])];
  const proactiveBots = { ...(local.proactive?.bots ?? {}) };
  let hasProactive = !!local.proactive;

  for (const remote of scopedRemotes) {
    if (!remote) continue;
    bots.push(...(remote.bots ?? []));
    sections.push(...(remote.sections ?? []));
    if (Array.isArray(remote.chatSections)) {
      chatSections = [...(chatSections ?? []), ...remote.chatSections];
    }
    chats.push(...(remote.chats ?? []));
    runs.push(...(remote.runs ?? []));
    requests.push(...(remote.requests ?? []));
    Object.assign(streams, remote.streams ?? {});
    Object.assign(thinking, remote.thinking ?? {});
    Object.assign(intents, remote.intents ?? {});
    Object.assign(speakers, remote.speakers ?? {});
    Object.assign(typing, remote.typing ?? {});
    Object.assign(queued, remote.queued ?? {});
    if (remote.steerable) Object.assign(steerable, remote.steerable);
    tasks.push(...(remote.tasks ?? []));
    if (Array.isArray(remote.workflows)) {
      workflows = [...(workflows ?? []), ...remote.workflows];
    }
    if (Array.isArray(remote.workflowRuns)) {
      workflowRuns = [...(workflowRuns ?? []), ...remote.workflowRuns];
    }
    if (Array.isArray(remote.channels)) {
      channels = [...(channels ?? []), ...remote.channels];
    }
    projects.push(...(remote.projects ?? []));
    panels.push(...(remote.panels ?? []));
    board.push(...(remote.board ?? []));
    if (Array.isArray(remote.spaces)) {
      spaces = [...(spaces ?? []), ...remote.spaces];
    }
    templates.push(...(remote.templates ?? []));
    if (remote.proactive) {
      hasProactive = true;
      Object.assign(proactiveBots, remote.proactive.bots ?? {});
    }
  }

  // Keep newest chats & runs at the top across all hosts.
  chats.sort((a, b) => (Number(b?.updated ?? b?.created ?? 0) - Number(a?.updated ?? a?.created ?? 0)));
  runs.sort((a, b) => (Number(b?.time ?? 0) - Number(a?.time ?? 0)));
  requests.sort((a, b) => (Number(a?.time ?? 0) - Number(b?.time ?? 0)));
  if (workflowRuns) {
    workflowRuns.sort((a, b) => Number(b?.startedAt ?? b?.createdAt ?? 0) - Number(a?.startedAt ?? a?.createdAt ?? 0));
  }

  return {
    ...local,
    bots,
    sections,
    ...(chatSections && { chatSections }),
    chats,
    runs,
    requests,
    streams,
    thinking,
    intents,
    speakers,
    typing,
    queued,
    ...(Object.keys(steerable).length > 0 && { steerable }),
    tasks,
    ...(workflows && { workflows }),
    ...(workflowRuns && { workflowRuns }),
    ...(channels && { channels }),
    projects,
    panels,
    board,
    ...(spaces && { spaces }),
    templates,
    ...(hasProactive && { proactive: { ...(local.proactive ?? { enabled: false, chatMode: "main" }), bots: proactiveBots } }),
  };
}

/** Recursively replaces any scoped ID belonging to `hostId` with its raw ID (leaving unrelated strings intact). */
export function unscopeValueForHost(value, hostId) {
  if (typeof value === "string") {
    const parsed = parseScopedId(value);
    return parsed && parsed.hostId === hostId ? parsed.rawId : value;
  }
  if (Array.isArray(value)) return value.map((item) => unscopeValueForHost(item, hostId));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = unscopeValueForHost(v, hostId);
    return out;
  }
  return value;
}

/** Finds the first remote hostId referenced in `value` (shallow or nested plain objects/arrays). */
export function findHostInValue(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return null;
  if (typeof value === "string") return parseScopedId(value)?.hostId ?? null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHostInValue(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    if (hasText(value.hostId) && value.hostId !== LOCAL_HOST_ID) return value.hostId;
    for (const key of ["chatId", "botId", "id", "requestId", "spaceId", "projectId", "sectionId", "taskId", "routineId", "botIds", "workflowId", "runId", "connectionId", "routineChatId", "nodes"]) {
      if (key in value) {
        const found = findHostInValue(value[key], depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

// Calls whose return value is a single entity ID string that must be re-scoped for the owning host.
const RETURNS_SCOPED_ID = new Set([
  "createChat",
  "mainChat",
  "createGroupChat",
  "addBot",
  "duplicateBot",
  "addSection",
  "link.chats.addSection",
  "createRoutine",
  "duplicateRoutine",
  "createProject",
  "addProject",
  "startProjectChat",
  "spaces.create",
  "spaces.ask",
  "addTodo",
]);

/** Re-scopes return values from remote calls so the renderer keeps working with unified scoped IDs. */
export function rescopeResult(name, hostId, result) {
  if (!hasText(hostId) || hostId === LOCAL_HOST_ID || result === null || result === undefined) return result;
  const s = (id) => (hasText(id) ? scopeId(hostId, id) : id);
  if (RETURNS_SCOPED_ID.has(name)) {
    if (typeof result === "string") return s(result);
    if (result && typeof result === "object") {
      return {
        ...result,
        ...(hasText(result.id) && { id: s(result.id) }),
        ...(hasText(result.chatId) && { chatId: s(result.chatId) }),
        ...(hasText(result.botId) && { botId: s(result.botId) }),
        ...(hasText(result.spaceId) && { spaceId: s(result.spaceId) }),
        ...(hasText(result.projectId) && { projectId: s(result.projectId) }),
      };
    }
  }
  if (name === "saveTask" && result && typeof result === "object") {
    return {
      ...result,
      ...(hasText(result.id) && { id: s(result.id) }),
      ...(hasText(result.botId) && { botId: s(result.botId) }),
      ...(hasText(result.chatId) && { chatId: s(result.chatId) }),
      ...(hasText(result.projectId) && { projectId: s(result.projectId) }),
    };
  }
  if (name === "forkChat" && typeof result === "string") return s(result);
  if (name === "chat.cardAction" && result && typeof result === "object") {
    return {
      ...result,
      ...(hasText(result.chatId) && { chatId: s(result.chatId) }),
      ...(hasText(result.botId) && { botId: s(result.botId) }),
      ...(result.card && { card: scopeActionCard(result.card, s) }),
    };
  }
  if (name === "channelsList" && Array.isArray(result)) {
    return result.map((conn) => scopeChannel(conn, s, { hostId }));
  }
  if ((name === "channelAdd" || name === "channelUpdate" || name === "channelBind" || name === "channelSetPolicy" || name === "channelPause" || name === "channelResume") && result && typeof result === "object") {
    return scopeChannel(result, s, { hostId });
  }
  if (name === "channelRemove" && result && typeof result === "object") {
    return { ...result, ...(hasText(result.id) && { id: s(result.id) }) };
  }
  if (name === "channelPairList" && Array.isArray(result)) {
    return result.map((p) => (p && typeof p === "object" ? { ...p, ...(hasText(p.connectionId) && { connectionId: s(p.connectionId) }), hostId } : p));
  }
  if ((name === "channelPairApprove" || name === "channelPairDeny") && result && typeof result === "object") {
    return { ...result, ...(hasText(result.connectionId) && { connectionId: s(result.connectionId) }) };
  }
  if (name === "channelLogs" && Array.isArray(result)) {
    return result.map((entry) =>
      entry && typeof entry === "object"
        ? {
            ...entry,
            ...(hasText(entry.connectionId) && { connectionId: s(entry.connectionId) }),
            ...(hasText(entry.turnId) && { turnId: s(entry.turnId) }),
            hostId,
          }
        : entry,
    );
  }
  if (name === "workflowsList" && result && typeof result === "object") {
    return {
      ...result,
      ...(Array.isArray(result.workflows) && { workflows: result.workflows.map((wf) => scopeWorkflow(wf, s, { hostId })) }),
      ...(Array.isArray(result.runs) && { runs: result.runs.map((r) => scopeWorkflowRun(r, s, { hostId })) }),
    };
  }
  if ((name === "workflowCreate" || name === "workflowUpdate" || name === "workflowPause" || name === "workflowResume") && result && typeof result === "object") {
    return scopeWorkflow(result, s, { hostId });
  }
  if ((name === "workflowRun" || name === "workflowRetryRun" || name === "workflowRespondApproval" || name === "workflowCancelRun") && result && typeof result === "object") {
    return scopeWorkflowRun(result, s, { hostId });
  }
  if (name === "workflowImportText" && result && typeof result === "object" && result.workflow) {
    return { ...result, workflow: scopeWorkflow(result.workflow, s, { hostId }) };
  }
  if (name === "startProjectJob" && Array.isArray(result)) {
    return result.map((id) => (typeof id === "string" ? s(id) : id));
  }
  if ((name === "claudeArtifacts.status" || name === "claudeArtifacts.setModel" || name === "claudeArtifacts.setBotApproval" || name === "claudeArtifacts.revokeBotApproval") && result && typeof result === "object") {
    return {
      ...result,
      ...(Array.isArray(result.grants) && {
        grants: result.grants.map((g) => (g && typeof g === "object" && hasText(g.botId) ? { ...g, botId: s(g.botId) } : g)),
      }),
    };
  }
  if (name === "proactiveAct" && result && typeof result === "object" && hasText(result.chatId)) {
    return { ...result, chatId: s(result.chatId) };
  }
  if ((name === "link.messages" || name === "artifactMessagePage") && result && typeof result === "object") {
    return {
      ...result,
      ...(hasText(result.chatId) && { chatId: s(result.chatId) }),
      ...(Array.isArray(result.messages) && {
        messages: result.messages.map((m) => ({
          ...m,
          ...(hasText(m?.botId) && { botId: s(m.botId) }),
          ...(hasText(m?.runId) && { runId: s(m.runId) }),
          ...(m?.actionCard && { actionCard: scopeActionCard(m.actionCard, s) }),
        })),
      }),
      ...(Array.isArray(result.runs) && {
        runs: result.runs.map((r) => ({
          ...r,
          ...(hasText(r?.id) && { id: s(r.id) }),
          ...(hasText(r?.chatId) && { chatId: s(r.chatId) }),
          ...(hasText(r?.botId) && { botId: s(r.botId) }),
        })),
      }),
    };
  }
  if (name === "spaces.read" && result && typeof result === "object") {
    return {
      ...result,
      ...(hasText(result.id) && { id: s(result.id) }),
      ...(hasText(result.projectId) && { projectId: s(result.projectId) }),
      ...(Array.isArray(result.panels) && {
        panels: result.panels.map((p) => ({
          ...p,
          ...(hasText(p?.botId) && { botId: s(p.botId) }),
          ...(hasText(p?.chatId) && { chatId: s(p.chatId) }),
          ...(hasText(p?.projectId) && { projectId: s(p.projectId) }),
          hostId,
        })),
      }),
    };
  }
  if (name === "routine" && result && typeof result === "object") {
    return {
      ...result,
      ...(hasText(result.id) && { id: s(result.id) }),
      ...(hasText(result.botId) && { botId: s(result.botId) }),
      ...(hasText(result.chatId) && { chatId: s(result.chatId) }),
    };
  }
  if (name === "mentionables" && Array.isArray(result)) {
    return result.map((item) => (item && typeof item === "object" && hasText(item.id) && item.kind === "bot" ? { ...item, id: s(item.id) } : item));
  }
  return result;
}

// Host-level calls that don't carry an entity ID and therefore target `settingsHost` when in unified mode.
const HOST_SCOPED_CALLS = new Set([
  "providers",
  "setProviderEnabled",
  "providerConfigure",
  "providerServices",
  "providerSignInStart",
  "providerSignInRead",
  "providerSignInInput",
  "providerSignInCancel",
  "signIn",
  "cancelSignIn",
  "signOut",
  "installProvider",
  "providerUseToken",
  "connectProviderService",
  "finishProviderService",
  "cancelProviderService",
  "disconnectProviderService",
  "auth",
  "models",
  "providerUsage",
  "usage",
  "harnesses",
  "phoneLink",
  "setPhoneLink",
  "setRelay",
  "setRelayUrl",
  "setRelayKey",
  "setHostName",
  "startPairing",
  "stopPairing",
  "removeDevice",
  "renameDevice",
  "setDeviceScreen",
  "setScreenControl",
  "setPreferences",
  "setProactiveChatMode",
  "skills",
  "readSkill",
  "saveSkill",
  "removeSkill",
  "setSkillEnabled",
  "addSkillFolder",
  "addSkillFolderAt",
  "removeSkillFolder",
  "skills.upload",
  "skills.saveScript",
  "skills.readScript",
  "skillsCatalog.search",
  "skillsCatalog.preview",
  "skillsCatalog.install",
  "skillsCatalog.featured",
  "mcpCatalog.list",
  "mcpCatalog.add",
  "saveMcpServer",
  "setMcpServerEnabled",
  "removeMcpServer",
  "testMcpServer",
  "signInMcpServer",
  "cancelMcpSignIn",
  "signOutMcpServer",
  "importMcpServers",
  "importMcpServerFile",
  "plugins.marketplaces",
  "plugins.addMarketplace",
  "plugins.removeMarketplace",
  "plugins.browse",
  "plugins.preview",
  "plugins.install",
  "plugins.addFolder",
  "plugins.configure",
  "plugins.setBots",
  "plugins.setEnabled",
  "plugins.update",
  "plugins.uninstall",
  "plugins.refresh",
  "piPackages.browse",
  "piPackages.preview",
  "piPackages.list",
  "piPackages.install",
  "piPackages.setEnabled",
  "piPackages.remove",
  "agents.browse",
  "agents.template",
  "composio.catalog",
  "composio.connected",
  "composio.accounts",
  "composio.connect",
  "composio.removeAccount",
  "wikiTree",
  "wikiPage",
  "saveWikiPage",
  "createWikiPage",
  "createWikiPageFor",
  "createWikiFolder",
  "moveWiki",
  "deleteWiki",
  "searchWiki",
  "wikiHistory",
  "wikiVersion",
  "restoreWikiVersion",
  "wikiExportPlan",
  "wikiExportPages",
  "exportWiki",
  "exportWikiFile",
  "team",
  "saveTeamRole",
  "deleteTeamRole",
  "saveTeamGroup",
  "deleteTeamGroup",
  "createTeamInvite",
  "revokeTeamInvite",
  "approveTeamRequest",
  "denyTeamRequest",
  "moveTeamMember",
  "removeTeamMember",
  "renameTeam",
  "renameTeamMember",
  "setMyAvatar",
  "link.team.setLinkSharing",
  "credentials",
  "removeCredential",
  "savedCredentials",
  "saveSavedCredential",
  "removeSavedCredential",
  "checkSavedCredential",
  "voiceSettings",
  "voiceOptions",
  "saveVoiceSettings",
  "listFolders",
  "addProjectFolder",
  "importableAgents",
  "importAgents",
  "nodeStatus",
  "nodeSetup",
  "nodeSetPaused",
  "nodeSetName",
  "nodeSetProjects",
  "nodeDisconnect",
  "addBot",
  "addSection",
  "link.chats.addSection",
  "createProject",
  "addProject",
  "spaces.create",
  "saveTask",
  "channelsList",
  "channelAdd",
  "channelPairList",
  "channelPairApprove",
  "channelPairDeny",
  "channelLogs",
  "workflowsList",
  "workflowCreate",
  "workflowImportText",
  "workflowGithubStatus",
  "workflowGithubSignInStart",
  "workflowGithubSignInCancel",
  "workflowGithubCatalog",
  "githubAgentStatus",
  "githubAgentInstallUrl",
  "githubAgentRefresh",
  "githubAgentSetRepo",
  "githubAgentUnbind",
  "claudeArtifacts.status",
  "claudeArtifacts.setModel",
  "market.catalog",
  "market.skillImage",
  "market.skillPreview",
  "market.skillInstall",
  "market.packPreview",
  "market.packInstall",
  "market.templatePreview",
  "market.templateInstall",
  "credentialGrants",
  "revokeCredentialGrant",
  "credentialAudit",
  "setCredentialGrant",
]);

/**
 * Resolves how an IPC call should be routed when unified multi-host mode is active.
 * Returns one of:
 *   - `{ kind: "local", args }`
 *   - `{ kind: "remote", hostId, name, args }`
 *   - `{ kind: "fanout", calls: [{ hostId, name, args }] }` (for multi-host batches like `markChatsRead` / `reorderBots`)
 */
export function routeUnifiedCall(name, args = [], { settingsHost = LOCAL_HOST_ID } = {}) {
  // Multi-host batch calls: partition IDs by owning host.
  if (name === "markChatsRead" && Array.isArray(args[0])) {
    const groups = new Map();
    for (const id of args[0]) {
      if (!hasText(id)) continue;
      const hostId = hostOfId(id);
      const list = groups.get(hostId) ?? [];
      list.push(unscopeId(id));
      groups.set(hostId, list);
    }
    return {
      kind: "fanout",
      calls: [...groups.entries()].map(([hostId, ids]) => ({ hostId, name, args: [ids] })),
    };
  }
  if (name === "reorderBots" && Array.isArray(args[0])) {
    const groups = new Map();
    for (const id of args[0]) {
      if (!hasText(id)) continue;
      const hostId = hostOfId(id);
      const list = groups.get(hostId) ?? [];
      list.push(unscopeId(id));
      groups.set(hostId, list);
    }
    return {
      kind: "fanout",
      calls: [...groups.entries()].map(([hostId, ids]) => ({ hostId, name, args: [ids] })),
    };
  }
  if (name === "link.chats.orderSections" && Array.isArray(args[0])) {
    const groups = new Map();
    for (const id of args[0]) {
      if (!hasText(id)) continue;
      const hostId = hostOfId(id);
      const list = groups.get(hostId) ?? [];
      list.push(unscopeId(id));
      groups.set(hostId, list);
    }
    return {
      kind: "fanout",
      calls: [...groups.entries()].map(([hostId, ids]) => ({ hostId, name, args: [ids] })),
    };
  }

  if (name === "channelBind" && args.length >= 2) {
    const connHost = hostOfId(args[0]);
    if (hasText(args[1]) && hostOfId(args[1]) !== connHost) {
      throw new Error("A channel can only be bound to a bot on the same computer.");
    }
  }
  if (name === "channelUpdate" && args[1] && typeof args[1] === "object" && hasText(args[1].botId)) {
    const connHost = hostOfId(args[0]);
    if (hostOfId(args[1].botId) !== connHost) {
      throw new Error("A channel can only be bound to a bot on the same computer.");
    }
  }
  if (name === "channelAdd" && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
    const input = args[0];
    const targetHost = hasText(input.hostId)
      ? input.hostId
      : hasText(input.botId)
        ? hostOfId(input.botId)
        : settingsHost || LOCAL_HOST_ID;
    if (hasText(input.hostId) && hasText(input.botId) && hostOfId(input.botId) !== targetHost) {
      throw new Error("A channel can only be bound to a bot on the same computer.");
    }
    const { hostId: _strip, ...rest } = input;
    const nextArgs = [rest, ...args.slice(1)];
    if (targetHost === LOCAL_HOST_ID) return { kind: "local", args: nextArgs };
    return { kind: "remote", hostId: targetHost, name, args: unscopeValueForHost(nextArgs, targetHost) };
  }
  if (name === "channelsList" || (name === "channelPairList" && !hasText(args[0])) || (name === "channelLogs" && !hasText(args[0]))) {
    // Host-scoped reads without a connection id go to settingsHost (never broadcast secrets).
    if (hasText(settingsHost) && settingsHost !== LOCAL_HOST_ID) {
      return { kind: "remote", hostId: settingsHost, name, args };
    }
    return { kind: "local", args };
  }

  // Explicit `hostId` on creation payloads (`addBot({ ..., hostId })`, `createProject({ ..., hostId })`, etc.).
  const first = args[0];
  if (first && typeof first === "object" && !Array.isArray(first) && hasText(first.hostId)) {
    const targetHost = first.hostId;
    const { hostId: _strip, ...rest } = first;
    const nextArgs = [rest, ...args.slice(1)];
    if (targetHost === LOCAL_HOST_ID) return { kind: "local", args: nextArgs };
    return { kind: "remote", hostId: targetHost, name, args: unscopeValueForHost(nextArgs, targetHost) };
  }

  // `setModel(scope, id, ...)` -> when scope is "bot" or "chat", route by `id`; when "default", route to settingsHost.
  if (name === "setModel") {
    const [scope, id] = args;
    if ((scope === "bot" || scope === "chat") && hasText(id)) {
      const targetHost = hostOfId(id);
      if (targetHost === LOCAL_HOST_ID) return { kind: "local", args };
      return { kind: "remote", hostId: targetHost, name, args: unscopeValueForHost(args, targetHost) };
    }
    if (settingsHost && settingsHost !== LOCAL_HOST_ID) {
      return { kind: "remote", hostId: settingsHost, name, args };
    }
    return { kind: "local", args };
  }

  // Inspect arguments for any scoped entity ID.
  for (const arg of args) {
    const found = findHostInValue(arg);
    if (found) {
      return { kind: "remote", hostId: found, name, args: unscopeValueForHost(args, found) };
    }
  }

  // Host-scoped calls without an entity ID follow the selected settings host (default: local).
  if (HOST_SCOPED_CALLS.has(name) && hasText(settingsHost) && settingsHost !== LOCAL_HOST_ID) {
    return { kind: "remote", hostId: settingsHost, name, args };
  }

  return { kind: "local", args };
}

/**
 * Diffs a remote host's previous and next parts to extract newly arrived requests (approvals,
 * questions, secure inputs) and newly completed/failed runs so desktop notifications can alert
 * the user across all connected hosts without switching hosts.
 */
export function diffRemoteNotifications(prev, next, { hostId, hostName }) {
  const events = [];
  if (!next || typeof next !== "object") return events;
  const s = (id) => (hasText(id) ? scopeId(hostId, id) : id);
  const bots = Array.isArray(next.bots) ? next.bots : [];
  const chats = Array.isArray(next.chats) ? next.chats : [];
  const botById = new Map(bots.map((b) => [b.id, b]));
  const chatById = new Map(chats.map((c) => [c.id, c]));

  // Only emit deltas after we have received an initial snapshot from this host,
  // so connecting to a host doesn't flood desktop notifications with old history.
  if (!prev) return events;

  const prevReqIds = new Set((prev.live?.requests ?? []).map((r) => r.id));
  for (const req of next.live?.requests ?? []) {
    if (!req?.id || prevReqIds.has(req.id)) continue;
    const bot = botById.get(req.botId);
    const chat = chatById.get(req.chatId);
    events.push({
      type: "request",
      hostId,
      hostName,
      bot: bot ? { ...bot, id: s(bot.id) } : { id: s(req.botId), name: hostName || "Botkins" },
      chat: chat ? { ...chat, id: s(chat.id), botId: s(chat.botId) } : undefined,
      request: {
        ...req,
        id: s(req.id),
        chatId: s(req.chatId),
        botId: s(req.botId),
      },
    });
  }

  const prevRuns = new Map((prev.runs ?? []).map((r) => [r.id, r]));
  for (const run of next.runs ?? []) {
    if (!run?.id || run.status === "Working" || run.status === "Stopped") continue;
    const before = prevRuns.get(run.id);
    // Emit when a previously Working run finishes, or a brand-new finished run arrives.
    if (before && before.status !== "Working") continue;
    const chat = chatById.get(run.chatId);
    const bot = botById.get(run.botId ?? chat?.botId);
    const syntheticChat = chat
      ? {
          ...chat,
          id: s(chat.id),
          botId: s(chat.botId),
          messages: chat.last
            ? [{ role: chat.last.role, text: chat.last.text, runId: run.id }]
            : [],
        }
      : { id: s(run.chatId), botId: s(run.botId), title: run.title, messages: [] };
    events.push({
      type: "turn",
      hostId,
      hostName,
      bot: bot ? { ...bot, id: s(bot.id) } : { id: s(run.botId), name: hostName || "Botkins" },
      chat: syntheticChat,
      run: {
        ...run,
        id: s(run.id),
        chatId: s(run.chatId),
        botId: s(run.botId),
        ...(run.delivery?.chatId && { delivery: { ...run.delivery, chatId: s(run.delivery.chatId) } }),
      },
    });
  }

  return events;
}
