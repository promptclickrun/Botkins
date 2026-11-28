// Multi-host pooling and unified state composition for the mobile app.
//
// Pure TypeScript with no React Native imports so unit tests run it directly.
// When "Operate all bots in one view" is enabled with more than one included paired computer,
// the primary computer's IDs stay raw while every other included computer's IDs are reversibly
// scoped with `rh~<encodeURIComponent(serverId)>~<rawId>`. Every merged bot, chat, request,
// task, run, project, panel, and space carries `hostId` and `hostName` metadata so the UI can
// badge them cleanly and `api` calls route directly to the right computer without switching hosts.
import type { LinkState, Pairing } from "@/link/client";
import type {
  AgentRequest,
  BoardItem,
  Bot,
  BotTask,
  ChannelAuditEntry,
  ChannelConnection,
  ChatDetail,
  ChatSummary,
  DeviceAsk,
  Live,
  MergedSpaceSource,
  Panel,
  PanelView,
  Parts,
  ProactivePart,
  Project,
  ReasoningView,
  Run,
  RunSummary,
  Section,
  SpaceContent,
  SpaceSummary,
  Workflow,
  WorkflowActionCard,
  WorkflowRun,
} from "@/link/types";

export const SCOPED_PREFIX = "rh~";
export const MERGED_BUILTIN_PREFIX = "unified~builtin~";
export type MergeableBuiltin = "today" | "feed" | "ideas" | "goals";
const MERGEABLE_BUILTINS = new Set<string>(["today", "feed", "ideas", "goals"]);

export function mergedBuiltinSpaceId(builtin: MergeableBuiltin): string {
  return `${MERGED_BUILTIN_PREFIX}${builtin}`;
}

export function parseMergedBuiltinSpaceId(value: unknown): MergeableBuiltin | null {
  if (typeof value !== "string" || !value.startsWith(MERGED_BUILTIN_PREFIX)) return null;
  const kind = value.slice(MERGED_BUILTIN_PREFIX.length);
  return MERGEABLE_BUILTINS.has(kind) ? (kind as MergeableBuiltin) : null;
}

export const isMergedBuiltinSpaceId = (value: unknown): boolean => parseMergedBuiltinSpaceId(value) !== null;

export function isMergeableBuiltinSpace(space: Pick<SpaceSummary, "builtin" | "mine"> | undefined | null): space is Pick<SpaceSummary, "builtin" | "mine"> & { builtin: MergeableBuiltin; mine: true } {
  return !!space && space.mine === true && typeof space.builtin === "string" && MERGEABLE_BUILTINS.has(space.builtin);
}

/** Quiet note shown in a merged built-in space when one or more included computers are offline. */
export function offlineComputersNote(count: number): string | undefined {
  if (!(count > 0)) return undefined;
  return count === 1 ? "1 computer offline" : `${count} computers offline`;
}

export type UnifiedHostStatus = {
  id: string;
  name: string;
  state: LinkState;
  primary: boolean;
  included: boolean;
  member?: boolean;
  team?: string;
  bots: number;
};

export type PooledHostSnapshot = {
  pairing: Pairing;
  link: LinkState;
  synced: boolean;
  parts: Partial<Parts>;
  chats: Record<string, ChatDetail | undefined>;
  running: Record<string, Run | null | undefined>;
  texts: Record<string, { stream: string; thinking: string } | undefined>;
};

export function scopeId(hostId: string, rawId: string): string {
  if (!rawId || !hostId) return rawId;
  if (rawId.startsWith(SCOPED_PREFIX)) return rawId;
  return `${SCOPED_PREFIX}${encodeURIComponent(hostId).replace(/~/g, "%7E")}~${rawId}`;
}

export function parseScopedId(value: unknown): { hostId: string; rawId: string } | null {
  if (typeof value !== "string" || !value.startsWith(SCOPED_PREFIX)) return null;
  const rest = value.slice(SCOPED_PREFIX.length);
  const sep = rest.indexOf("~");
  if (sep <= 0) return null;
  try {
    const hostId = decodeURIComponent(rest.slice(0, sep));
    const rawId = rest.slice(sep + 1);
    if (!hostId || !rawId) return null;
    return { hostId, rawId };
  } catch {
    return null;
  }
}

export const isScopedId = (value: unknown): boolean => parseScopedId(value) !== null;
export const unscopeId = (value: string): string => parseScopedId(value)?.rawId ?? value;
export const hostOfId = (value: unknown, primaryId: string | null): string | null =>
  parseScopedId(value)?.hostId ?? primaryId;

export function idForHost(hostId: string, rawId: string, primaryId: string | null): string {
  return hostId === primaryId ? rawId : scopeId(hostId, rawId);
}

const optScope = (hostId: string, primaryId: string | null, id: string | null | undefined): string | undefined =>
  typeof id === "string" && id ? idForHost(hostId, id, primaryId) : undefined;

function hostNameOf(pairing: Pairing, parts: Partial<Parts>): string {
  return parts.meta?.name || pairing.name || "Computer";
}

function scopeRun<T extends RunSummary | Run>(run: T, hostId: string, primaryId: string | null): T {
  const s = (id: string) => idForHost(hostId, id, primaryId);
  const next: Record<string, unknown> = {
    ...run,
    id: s(run.id),
    chatId: s(run.chatId),
    ...(run.panelId && { panelId: s(run.panelId) }),
  };
  const full = run as Run;
  if (Array.isArray(full.steps)) {
    next.steps = full.steps.map((step) => (step.botId ? { ...step, botId: s(step.botId) } : step));
  }
  if (Array.isArray(full.reasoning)) {
    next.reasoning = full.reasoning.map((item) => (item.botId ? { ...item, botId: s(item.botId) } : item));
  }
  if (Array.isArray(full.speakers)) {
    next.speakers = full.speakers.map((id) => s(id));
  }
  if (Array.isArray(full.failures)) {
    next.failures = full.failures.map((f) => ({ ...f, botId: s(f.botId) }));
  }
  if (Array.isArray(full.teamwork)) {
    next.teamwork = full.teamwork.map((ask) => ({
      ...ask,
      botId: s(ask.botId),
      fromBotId: s(ask.fromBotId),
    }));
  }
  return next as T;
}

function scopeActionCard(card: WorkflowActionCard, s: (id: string) => string): WorkflowActionCard {
  return {
    ...card,
    ...(card.dispatchedChatId ? { dispatchedChatId: s(card.dispatchedChatId) } : {}),
    ...(card.dispatchedBotId ? { dispatchedBotId: s(card.dispatchedBotId) } : {}),
    ...(card.dispatch
      ? {
          dispatch: {
            ...card.dispatch,
            ...(card.dispatch.botId ? { botId: s(card.dispatch.botId) } : {}),
          },
        }
      : {}),
  };
}

function scopeChannel(conn: ChannelConnection, s: (id: string) => string, tag?: { hostId: string; hostName: string }): ChannelConnection {
  return {
    ...conn,
    id: s(conn.id),
    ...(conn.botId ? { botId: s(conn.botId) } : {}),
    ...(tag ?? {}),
  };
}

function scopeWorkflow(wf: Workflow, s: (id: string) => string, tag?: { hostId: string; hostName: string }): Workflow {
  return {
    ...wf,
    id: s(wf.id),
    nodes: wf.nodes.map((node) => {
      if (!node.config) return node;
      const cfg = { ...node.config };
      if (typeof cfg.botId === "string" && cfg.botId) cfg.botId = s(cfg.botId);
      if (typeof cfg.chatId === "string" && cfg.chatId) cfg.chatId = s(cfg.chatId);
      if (typeof cfg.routineChatId === "string" && cfg.routineChatId) cfg.routineChatId = s(cfg.routineChatId);
      if (typeof cfg.taskId === "string" && cfg.taskId) cfg.taskId = s(cfg.taskId);
      return { ...node, config: cfg };
    }),
    ...(tag ?? {}),
  };
}

function scopeWorkflowRun(run: WorkflowRun, s: (id: string) => string, tag?: { hostId: string; hostName: string }): WorkflowRun {
  return {
    ...run,
    id: s(run.id),
    workflowId: s(run.workflowId),
    ...(tag ?? {}),
  };
}

export function scopeChatDetail(detail: ChatDetail, hostId: string, primaryId: string | null): ChatDetail {
  if (hostId === primaryId) return detail;
  const s = (id: string) => idForHost(hostId, id, primaryId);
  return {
    ...detail,
    id: s(detail.id),
    messages: detail.messages.map((m) => ({
      ...m,
      ...(m.runId && { runId: s(m.runId) }),
      ...(m.botId && { botId: s(m.botId) }),
      ...(m.steeredRunId && { steeredRunId: s(m.steeredRunId) }),
      ...(m.proactiveRunId && { proactiveRunId: s(m.proactiveRunId) }),
      ...(m.answer && { answer: { ...m.answer, runId: s(m.answer.runId), requestId: s(m.answer.requestId) } }),
      ...(m.actionCard && { actionCard: scopeActionCard(m.actionCard, s) }),
    })),
    runs: detail.runs.map((r) => scopeRun(r, hostId, primaryId)),
    ...(detail.pane && {
      pane: {
        ...detail.pane,
        active: detail.pane.active ? s(detail.pane.active) : detail.pane.active,
        panels: detail.pane.panels.map((p) => ({
          ...p,
          id: s(p.id),
          botId: s(p.botId),
          ...(p.frame && { frame: s(p.frame) }),
        })),
        ...(detail.pane.ask && {
          ask: {
            ...detail.pane.ask,
            botId: s(detail.pane.ask.botId),
            runId: s(detail.pane.ask.runId),
            ...(detail.pane.ask.panelId && { panelId: s(detail.pane.ask.panelId) }),
          },
        }),
      },
    }),
  };
}

export function scopeReasoningView(view: ReasoningView, hostId: string, primaryId: string | null): ReasoningView {
  if (hostId === primaryId) return view;
  const s = (id: string) => idForHost(hostId, id, primaryId);
  return {
    run: s(view.run),
    items: view.items.map((item) => (item.botId ? { ...item, botId: s(item.botId) } : item)),
  };
}

export function scopePartsForHost(
  incoming: Record<string, unknown>,
  hostId: string,
  hostName: string,
  primaryId: string | null,
): Record<string, unknown> {
  const s = (id: string) => idForHost(hostId, id, primaryId);
  const tag = { hostId, hostName };
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (name === "bots" && Array.isArray(value)) {
      out.bots = (value as Bot[]).map((b) => ({
        ...b,
        id: s(b.id),
        ...(b.sectionId ? { sectionId: s(b.sectionId) } : {}),
        ...(b.access?.projects?.length
          ? { access: { ...b.access, projects: b.access.projects.map((p) => s(p)) } }
          : {}),
        ...tag,
      }));
    } else if (name === "sections" && Array.isArray(value)) {
      out.sections = (value as Section[]).map((sec) => ({ ...sec, id: s(sec.id) }));
    } else if (name === "chatSections" && Array.isArray(value)) {
      out.chatSections = (value as Section[]).map((sec) => ({ ...sec, id: s(sec.id) }));
    } else if (name === "chats" && Array.isArray(value)) {
      out.chats = (value as ChatSummary[]).map((c) => ({
        ...c,
        id: s(c.id),
        botId: s(c.botId),
        ...(c.botIds ? { botIds: c.botIds.map((id) => s(id)) } : {}),
        ...(c.sectionId ? { sectionId: s(c.sectionId) } : {}),
        ...(c.projectId ? { projectId: s(c.projectId) } : {}),
        ...(c.panelId ? { panelId: s(c.panelId) } : {}),
        ...(c.forkedFrom ? { forkedFrom: { ...c.forkedFrom, chatId: s(c.forkedFrom.chatId) } } : {}),
        ...(c.last?.botId ? { last: { ...c.last, botId: s(c.last.botId) } } : {}),
        ...(c.schedules
          ? {
              schedules: c.schedules.map((sch) =>
                sch.deliver?.chatId
                  ? { ...sch, deliver: { ...sch.deliver, chatId: s(sch.deliver.chatId) } }
                  : sch,
              ),
            }
          : {}),
        ...tag,
      }));
    } else if (name === "runs" && Array.isArray(value)) {
      out.runs = (value as RunSummary[]).map((r) => ({ ...scopeRun(r, hostId, primaryId), ...tag }));
    } else if (name === "live" && value && typeof value === "object") {
      const live = value as Live;
      const scopeMap = <V>(rec: Record<string, V> | undefined): Record<string, V> => {
        if (!rec) return {};
        const res: Record<string, V> = {};
        for (const [k, v] of Object.entries(rec)) res[s(k)] = v;
        return res;
      };
      const nextLive: Live = {
        streams: scopeMap(live.streams),
        intents: scopeMap(live.intents),
        thinking: scopeMap(live.thinking),
        speakers: Object.fromEntries(
          Object.entries(live.speakers ?? {}).map(([cid, bid]) => [s(cid), s(bid)]),
        ),
        ...(live.typing ? { typing: scopeMap(live.typing) } : {}),
        queued: scopeMap(live.queued),
        requests: (live.requests ?? []).map((r: AgentRequest) => ({
          ...r,
          id: s(r.id),
          chatId: s(r.chatId),
          botId: s(r.botId),
          ...tag,
        })),
        active: (live.active ?? []).map((cid) => s(cid)),
        ...(live.steerable ? { steerable: scopeMap(live.steerable) } : {}),
      };
      out.live = nextLive;
    } else if (name === "tasks" && Array.isArray(value)) {
      out.tasks = (value as BotTask[]).map((t) => ({
        ...t,
        id: s(t.id),
        botId: t.botId ? s(t.botId) : null,
        ...(t.chatId ? { chatId: s(t.chatId) } : {}),
        ...(t.runId ? { runId: s(t.runId) } : {}),
        ...tag,
      }));
    } else if (name === "workflows" && Array.isArray(value)) {
      out.workflows = (value as Workflow[]).map((wf) => scopeWorkflow(wf, s, tag));
    } else if (name === "workflowRuns" && Array.isArray(value)) {
      out.workflowRuns = (value as WorkflowRun[]).map((r) => scopeWorkflowRun(r, s, tag));
    } else if (name === "channels" && Array.isArray(value)) {
      out.channels = (value as ChannelConnection[]).map((conn) => scopeChannel(conn, s, tag));
    } else if (name === "projects" && Array.isArray(value)) {
      out.projects = (value as Project[]).map((p) => ({
        ...p,
        id: s(p.id),
        ...(p.artifacts ? { artifacts: p.artifacts.map((a) => s(a)) } : {}),
        ...tag,
      }));
    } else if (name === "panels" && Array.isArray(value)) {
      out.panels = (value as Panel[]).map((p) => ({
        ...p,
        id: s(p.id),
        botId: s(p.botId),
        chatId: s(p.chatId),
        ...(p.projectId ? { projectId: s(p.projectId) } : {}),
        ...(p.refreshChatId ? { refreshChatId: s(p.refreshChatId) } : {}),
        ...(p.spaceId ? { spaceId: s(p.spaceId) } : {}),
        blocks: p.blocks.map((b) => (b.type === "html" && b.frame ? { ...b, frame: s(b.frame) } : b)),
        ...tag,
      }));
    } else if (name === "projectPanels" && Array.isArray(value)) {
      out.projectPanels = (value as PanelView[]).map((p) => ({
        ...p,
        id: s(p.id),
        botId: s(p.botId),
        ...(p.chatId ? { chatId: s(p.chatId) } : {}),
        ...(p.projectId ? { projectId: s(p.projectId) } : {}),
        ...(p.refreshChatId ? { refreshChatId: s(p.refreshChatId) } : {}),
        ...(p.spaceId ? { spaceId: s(p.spaceId) } : {}),
        blocks: p.blocks.map((b) => (b.type === "html" && b.frame ? { ...b, frame: s(b.frame) } : b)),
        ...tag,
      }));
    } else if (name === "board" && Array.isArray(value)) {
      out.board = (value as BoardItem[]).map((item) => ({
        ...item,
        id: s(item.id),
        botId: s(item.botId),
        ...(item.proactiveRunId ? { proactiveRunId: s(item.proactiveRunId) } : {}),
        ...tag,
      }));
    } else if (name === "spaces" && Array.isArray(value)) {
      out.spaces = (value as SpaceSummary[]).map((sp) => ({
        ...sp,
        id: s(sp.id),
        ...(sp.projectId ? { projectId: s(sp.projectId) } : {}),
        ...tag,
      }));
    } else if (name === "proactive" && value && typeof value === "object") {
      const p = value as ProactivePart;
      const bots: ProactivePart["bots"] = {};
      for (const [bid, cfg] of Object.entries(p.bots ?? {})) {
        if (!cfg) continue;
        bots[s(bid)] = {
          ...cfg,
          ...(cfg.chatId ? { chatId: s(cfg.chatId) } : {}),
          ...(cfg.log ? { log: cfg.log.map((l) => ({ ...l, runId: s(l.runId) })) } : {}),
        };
      }
      out.proactive = { ...p, bots };
    } else if (name === "phones" && value && typeof value === "object") {
      const phones = value as NonNullable<Parts["phones"]>;
      const next: NonNullable<Parts["phones"]> = {};
      for (const [did, info] of Object.entries(phones)) {
        if (!info) continue;
        const push = info.push
          ? {
              ...info.push,
              ...(info.push.bots
                ? { bots: { mode: info.push.bots.mode, ids: (info.push.bots.ids ?? []).map((id) => s(id)) } }
                : {}),
              ...(info.push.mutedBots
                ? { mutedBots: info.push.mutedBots.map((id) => s(id)) }
                : {}),
            }
          : undefined;
        next[did] = push ? { ...info, push } : info;
      }
      out.phones = next;
    } else if (name === "asks" && Array.isArray(value)) {
      out.asks = (value as DeviceAsk[]).map((ask) => ({
        ...ask,
        id: s(ask.id),
        ...(ask.botId ? { botId: s(ask.botId) } : {}),
      }));
    } else if (name.startsWith("chat:")) {
      const cid = s(name.slice(5));
      out["chat:" + cid] = value ? scopeChatDetail(value as ChatDetail, hostId, primaryId) : value;
    } else if (name.startsWith("run:")) {
      const cid = s(name.slice(4));
      out["run:" + cid] = value ? scopeRun(value as Run, hostId, primaryId) : value;
    } else if (name.startsWith("reasoning:")) {
      const cid = s(name.slice(10));
      out["reasoning:" + cid] = value ? scopeReasoningView(value as ReasoningView, hostId, primaryId) : value;
    } else if (name.startsWith("text:")) {
      const cid = s(name.slice(5));
      out["text:" + cid] = value;
    } else {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Merges scoped `Parts` from every included pooled host into one unified `Partial<Parts>`.
 * Host-specific settings/meta/mcp/skills/credentials/team come from `settingsHostId` (falling back to primary).
 */
export function mergeUnifiedParts(
  hosts: PooledHostSnapshot[],
  primaryId: string | null,
  settingsHostId: string | null,
): Partial<Parts> {
  if (!hosts.length) return {};
  const target =
    hosts.find((h) => h.pairing.serverId === settingsHostId && h.synced) ??
    hosts.find((h) => h.pairing.serverId === primaryId && h.synced) ??
    hosts.find((h) => h.synced) ??
    hosts[0]!;

  const merged: Partial<Parts> = { ...target.parts };
  const bots: Bot[] = [];
  const sections: Section[] = [];
  const chatSections: Section[] = [];
  const chats: ChatSummary[] = [];
  const runs: RunSummary[] = [];
  const tasks: BotTask[] = [];
  const workflows: Workflow[] = [];
  const workflowRuns: WorkflowRun[] = [];
  const channels: ChannelConnection[] = [];
  const projects: Project[] = [];
  const panels: Panel[] = [];
  const projectPanels: PanelView[] = [];
  const board: BoardItem[] = [];
  const spaces: SpaceSummary[] = [];
  const asks: DeviceAsk[] = [];
  const live: Live = {
    streams: {},
    intents: {},
    thinking: {},
    speakers: {},
    typing: {},
    queued: {},
    requests: [],
    active: [],
    steerable: {},
  };
  let anyProactiveEnabled = false;
  const proactiveBots: ProactivePart["bots"] = {};
  let proactiveChatMode: ProactivePart["chatMode"];
  const phones: NonNullable<Parts["phones"]> = {};

  for (const h of hosts) {
    if (!h.synced) continue;
    const p = h.parts;
    if (p.phones) Object.assign(phones, p.phones);
    if (p.bots) bots.push(...p.bots);
    if (p.sections) sections.push(...p.sections);
    if (p.chatSections) chatSections.push(...p.chatSections);
    if (p.chats) chats.push(...p.chats);
    if (p.runs) runs.push(...p.runs);
    if (p.tasks) tasks.push(...p.tasks);
    if (p.workflows) workflows.push(...p.workflows);
    if (p.workflowRuns) workflowRuns.push(...p.workflowRuns);
    if (p.channels) channels.push(...p.channels);
    if (p.projects) projects.push(...p.projects);
    if (p.panels) panels.push(...p.panels);
    if (p.projectPanels) projectPanels.push(...p.projectPanels);
    if (p.board) board.push(...p.board);
    if (p.spaces) spaces.push(...p.spaces);
    if (p.asks) asks.push(...p.asks);
    if (p.proactive) {
      if (p.proactive.enabled) anyProactiveEnabled = true;
      if (!proactiveChatMode && p.proactive.chatMode) proactiveChatMode = p.proactive.chatMode;
      Object.assign(proactiveBots, p.proactive.bots);
    }
    if (p.live) {
      Object.assign(live.streams, p.live.streams);
      Object.assign(live.intents, p.live.intents);
      Object.assign(live.thinking, p.live.thinking);
      Object.assign(live.speakers, p.live.speakers);
      if (p.live.typing) Object.assign(live.typing!, p.live.typing);
      Object.assign(live.queued, p.live.queued);
      if (p.live.steerable) Object.assign(live.steerable!, p.live.steerable);
      live.requests.push(...(p.live.requests ?? []));
      live.active.push(...(p.live.active ?? []));
    }
  }

  chats.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  runs.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  workflowRuns.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  live.requests.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  board.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  // Merge built-in spaces (today/feed/ideas/goals with mine: true) across online hosts into
  // one virtual space per builtin. Never merge by name; custom spaces and other people's built-ins
  // stay separate per host. Offline hosts drop out of the merge and are reflected via offlineCount.
  const offlineHostCount = hosts.filter((h) => h.link !== "online").length;
  const mergedSpaces = mergeUnifiedSpaces(hosts, primaryId, offlineHostCount);

  merged.bots = bots;
  merged.sections = sections;
  merged.chatSections = chatSections;
  merged.chats = chats;
  merged.runs = runs;
  merged.tasks = tasks;
  merged.workflows = workflows;
  merged.workflowRuns = workflowRuns;
  merged.channels = channels;
  merged.projects = projects;
  merged.panels = panels;
  merged.projectPanels = projectPanels;
  merged.board = board;
  merged.spaces = mergedSpaces;
  merged.asks = asks;
  merged.live = live;
  if (Object.keys(phones).length) {
    merged.phones = phones;
  }
  if (Object.keys(proactiveBots).length || anyProactiveEnabled) {
    merged.proactive = { enabled: anyProactiveEnabled, ...(proactiveChatMode && { chatMode: proactiveChatMode }), bots: proactiveBots };
  }
  return merged;
}

/**
 * Deduplicates `builtin` (today/feed/ideas/goals) + `mine: true` spaces across hosts into one
 * virtual space per builtin (`unified~builtin~<kind>`). Custom spaces and other people's built-ins
 * stay per host. Offline hosts drop out of the merge; their count is tracked on `merged.offlineCount`.
 */
export function mergeUnifiedSpaces(
  hosts: PooledHostSnapshot[],
  primaryId: string | null,
  offlineHostCount?: number,
): SpaceSummary[] {
  const offlineCount = offlineHostCount ?? hosts.filter((h) => h.link !== "online").length;
  const builtinGroups = new Map<MergeableBuiltin, { entry: SpaceSummary; source: MergedSpaceSource }[]>();
  const firstSlot = new Map<MergeableBuiltin, number>();
  const out: Array<SpaceSummary | { kind: "slot"; builtin: MergeableBuiltin }> = [];

  for (const h of hosts) {
    if (!h.synced) continue;
    const hostId = h.pairing.serverId;
    const hostName = hostNameOf(h.pairing, h.parts);
    const online = h.link === "online";
    const list = h.parts.spaces ?? [];
    for (const sp of list) {
      if (isMergeableBuiltinSpace(sp)) {
        // Offline host drops out of the merge (never blanks the space).
        if (!online) continue;
        const builtin = sp.builtin;
        if (!firstSlot.has(builtin)) {
          firstSlot.set(builtin, out.length);
          out.push({ kind: "slot", builtin });
        }
        const rawSpaceId = unscopeId(sp.id);
        const source: MergedSpaceSource = {
          hostId,
          hostName,
          spaceId: sp.id,
          rawSpaceId,
          rev: sp.rev ?? 0,
          online,
        };
        const listForKind = builtinGroups.get(builtin) ?? [];
        listForKind.push({ entry: sp, source });
        builtinGroups.set(builtin, listForKind);
      } else {
        out.push(sp);
      }
    }
  }

  const result: SpaceSummary[] = [];
  for (const item of out) {
    if ("kind" in item) {
      const group = builtinGroups.get(item.builtin);
      if (!group?.length) continue;
      // Prefer primary host's entry as the base metadata, otherwise first online contributor.
      const base = group.find((g) => g.source.hostId === primaryId)?.entry ?? group[0]!.entry;
      const seenHere = new Set<string>();
      const here: SpaceSummary["here"] = [];
      for (const g of group) {
        for (const p of g.entry.here ?? []) {
          const key = `${p.id}:${p.panelId ?? ""}`;
          if (!seenHere.has(key)) {
            seenHere.add(key);
            here.push(p);
          }
        }
      }
      const totalCount = group.reduce((sum, g) => sum + (g.entry.count ?? 0), 0);
      const totalChanged = Math.min(99, group.reduce((sum, g) => sum + (g.entry.changed ?? 0), 0));
      const totalRev = group.reduce((sum, g) => sum + (g.entry.rev ?? 0), 0);
      const updatedAt = Math.max(0, ...group.map((g) => g.entry.updatedAt ?? 0));
      const pinned = group.some((g) => g.entry.pinned);
      const mergedSummary: SpaceSummary = {
        ...base,
        id: mergedBuiltinSpaceId(item.builtin),
        builtin: item.builtin,
        mine: true,
        count: totalCount,
        changed: totalChanged,
        pinned,
        here,
        rev: totalRev,
        updatedAt,
        hostId: undefined,
        hostName: undefined,
        merged: {
          sources: group.map((g) => g.source),
          offlineCount,
        },
      };
      result.push(mergedSummary);
    } else {
      result.push(item);
    }
  }
  return result;
}

/**
 * Combines `spaces.read` responses from multiple hosts for a merged built-in space.
 * - Panels from all contributing hosts are kept in order and tagged with `hostId`/`hostName`.
 * - Cards (Feed/Ideas/Goals) are interleaved newest first (`createdAt` desc, tie-break `updatedAt` desc),
 *   each tagged with `hostId`/`hostName`.
 * - Failed/offline hosts are dropped quietly and counted in `offlineCount` so the space never blanks.
 */
export function combineMergedSpaceContent(
  mergedId: string,
  rev: number,
  responses: Array<{
    hostId: string;
    hostName: string;
    content?: SpaceContent;
    failed?: boolean;
  }>,
  baseOfflineCount = 0,
): SpaceContent {
  const panels: PanelView[] = [];
  const cards: BoardItem[] = [];
  const seenItems: Record<string, number> = {};
  let hasSeenItems = false;
  let seenAt = 0;
  let failedReads = 0;
  const contributing = new Set<string>();

  for (const res of responses) {
    if (res.failed || !res.content) {
      failedReads += 1;
      continue;
    }
    const c = res.content;
    if (c.seenAt > seenAt) seenAt = c.seenAt;
    if (c.seenItems) {
      hasSeenItems = true;
      for (const [itemId, at] of Object.entries(c.seenItems)) {
        seenItems[itemId] = Math.max(seenItems[itemId] ?? 0, at);
      }
    }
    const hostPanels = (c.panels ?? []).map((p) => ({
      ...p,
      hostId: p.hostId ?? res.hostId,
      hostName: p.hostName ?? res.hostName,
    }));
    const hostCards = (c.cards ?? []).map((card) => ({
      ...card,
      hostId: card.hostId ?? res.hostId,
      hostName: card.hostName ?? res.hostName,
    }));
    if (hostPanels.length > 0 || hostCards.length > 0) contributing.add(res.hostId);
    panels.push(...hostPanels);
    cards.push(...hostCards);
  }

  cards.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  return {
    id: mergedId,
    rev,
    seenAt,
    ...(hasSeenItems && { seenItems }),
    panels,
    cards,
    offlineCount: baseOfflineCount + failedReads,
    contributingHosts: contributing.size,
  };
}

/**
 * Resolves the concrete scoped spaceId on a target host for a merged built-in space (for panel
 * creation, asking, or moving). Falls back to the host's own source spaceId if present, else
 * the first online source.
 */
export function resolveMergedSpaceTarget(
  space: SpaceSummary,
  targetHostId: string | null | undefined,
): { hostId: string; spaceId: string; rawSpaceId: string } | null {
  const sources = space.merged?.sources ?? [];
  if (!sources.length) return null;
  const picked = (targetHostId ? sources.find((s) => s.hostId === targetHostId) : undefined) ?? sources[0]!;
  return { hostId: picked.hostId, spaceId: picked.spaceId, rawSpaceId: picked.rawSpaceId };
}

/** Recursively locates the first scoped ID's hostId inside call arguments. */
export function findHostInValue(value: unknown, depth = 0): string | null {
  if (depth > 8 || value == null) return null;
  if (typeof value === "string") return parseScopedId(value)?.hostId ?? null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHostInValue(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const found = findHostInValue(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Recursively strips the scoped prefix for a specific target host before sending over Link. */
export function unscopeValueForHost<T>(value: T, targetHostId: string, depth = 0): T {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") {
    const parsed = parseScopedId(value);
    return (parsed && parsed.hostId === targetHostId ? parsed.rawId : value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => unscopeValueForHost(item, targetHostId, depth + 1)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const parsedKey = parseScopedId(k);
      const nextKey = parsedKey && parsedKey.hostId === targetHostId ? parsedKey.rawId : k;
      out[nextKey] = unscopeValueForHost(v, targetHostId, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Methods that belong to the selected settings computer when no scoped ID is present. */
const SETTINGS_HOST_METHODS = new Set([
  "setPreferences",
  "setAppearance",
  "setApproval",
  "addBot",
  "importAgent",
  "importAgents",
  "importableAgents",
  "addSection",
  "saveSection",
  "deleteSection",
  "link.chats.addSection",
  "saveChatSection",
  "deleteChatSection",
  "addProject",
  "addProjectFolder",
  "saveMcpServer",
  "deleteMcpServer",
  "toggleMcpServer",
  "saveSkill",
  "deleteSkill",
  "toggleSkill",
  "saveCredential",
  "deleteCredential",
  "models",
  "providers",
  "skills",
  "harnesses",
  "providerUsage",
  "usageReport",
  "link.push.setPrefs",
  "link.devices.list",
  "link.devices.rename",
  "link.devices.remove",
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
  "githubAgentSetSettings",
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
  "link.credentials.grants",
  "link.credentials.setGrant",
  "link.credentials.revokeGrant",
  "link.credentials.audit",
  "link.credentials.copy",
]);

const STRING_ID_METHODS = new Set([
  "addBot",
  "duplicateBot",
  "mainChat",
  "changeMainFork",
  "createChat",
  "createGroupChat",
  "forkChat",
  "startProjectChat",
  "createRoutine",
  "duplicateRoutine",
  "saveTask",
  "addSection",
  "link.chats.addSection",
  "addProjectFolder",
  "spaces.create",
]);

const STRING_ARRAY_ID_METHODS = new Set([
  "importAgents",
  "addProjectArtifact",
  "startProjectJob",
]);

/** Methods that should fan out across hosts when passed mixed IDs (e.g. markChatsRead, reorderBots). */
export type MobileRouteResult =
  | { kind: "single"; hostId: string; args: unknown[] }
  | { kind: "fanout"; calls: { hostId: string; args: unknown[] }[] };

export function routeMobileCall(
  method: string,
  args: unknown[],
  ctx: { primaryId: string; settingsHostId: string | null; poolIds: string[] },
): MobileRouteResult {
  // Channel security & host-affinity checks: secrets and bindings never cross hosts.
  if (method === "channelBind" && args.length >= 2 && typeof args[0] === "string" && typeof args[1] === "string" && args[1]) {
    const connHost = hostOfId(args[0], ctx.primaryId);
    const botHost = hostOfId(args[1], ctx.primaryId);
    if (connHost && botHost && connHost !== botHost) {
      throw new Error("A channel can only be bound to a bot on the same computer.");
    }
  }
  if (method === "channelUpdate" && typeof args[0] === "string" && args[1] && typeof args[1] === "object" && !Array.isArray(args[1])) {
    const patch = args[1] as { botId?: unknown };
    if (typeof patch.botId === "string" && patch.botId) {
      const connHost = hostOfId(args[0], ctx.primaryId);
      const botHost = hostOfId(patch.botId, ctx.primaryId);
      if (connHost && botHost && connHost !== botHost) {
        throw new Error("A channel can only be bound to a bot on the same computer.");
      }
    }
  }
  if (method === "channelAdd" && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
    const input = args[0] as Record<string, unknown>;
    const explicitHost = typeof input.hostId === "string" && input.hostId ? input.hostId : null;
    const botHost = typeof input.botId === "string" && input.botId ? hostOfId(input.botId, ctx.primaryId) : null;
    if (explicitHost && botHost && explicitHost !== botHost) {
      throw new Error("A channel can only be bound to a bot on the same computer.");
    }
    const candidate = explicitHost ?? botHost ?? ctx.settingsHostId ?? ctx.primaryId;
    const target = ctx.poolIds.includes(candidate) ? candidate : ctx.primaryId;
    const { hostId: _strip, ...restObj } = input;
    const cleaned = [restObj, ...args.slice(1)];
    return {
      kind: "single",
      hostId: target,
      args: target === ctx.primaryId ? cleaned : unscopeValueForHost(cleaned, target),
    };
  }

  // Explicit hostId on first object argument (e.g. addBot({ ..., hostId }))
  if (args[0] && typeof args[0] === "object" && !Array.isArray(args[0]) && typeof (args[0] as { hostId?: unknown }).hostId === "string") {
    const explicit = (args[0] as { hostId: string }).hostId;
    const { hostId: _strip, ...restObj } = args[0] as Record<string, unknown>;
    const target = ctx.poolIds.includes(explicit) ? explicit : ctx.primaryId;
    const cleaned = [restObj, ...args.slice(1)];
    return { kind: "single", hostId: target, args: target === ctx.primaryId ? cleaned : unscopeValueForHost(cleaned, target) };
  }

  // Fan-out methods with arrays of scoped/unscoped IDs
  if ((method === "markChatsRead" || method === "reorderBots" || method === "link.chats.orderSections") && Array.isArray(args[0])) {
    const groups = new Map<string, string[]>();
    for (const id of args[0] as unknown[]) {
      if (typeof id !== "string") continue;
      const parsed = parseScopedId(id);
      const hid = parsed ? parsed.hostId : ctx.primaryId;
      const raw = parsed ? parsed.rawId : id;
      const list = groups.get(hid) ?? [];
      list.push(raw);
      groups.set(hid, list);
    }
    const calls = [...groups.entries()]
      .filter(([hid]) => ctx.poolIds.includes(hid))
      .map(([hostId, list]) => ({ hostId, args: [list, ...args.slice(1)] }));
    if (calls.length > 1) return { kind: "fanout", calls };
    if (calls.length === 1) return { kind: "single", hostId: calls[0]!.hostId, args: calls[0]!.args };
  }

  const scopedHost = findHostInValue(args);
  if (scopedHost && ctx.poolIds.includes(scopedHost)) {
    return {
      kind: "single",
      hostId: scopedHost,
      args: scopedHost === ctx.primaryId ? args : unscopeValueForHost(args, scopedHost),
    };
  }

  const fallback =
    SETTINGS_HOST_METHODS.has(method) && ctx.settingsHostId && ctx.poolIds.includes(ctx.settingsHostId)
      ? ctx.settingsHostId
      : ctx.primaryId;
  return { kind: "single", hostId: fallback, args };
}

/** Re-scopes IDs returned from a remote (non-primary) host call so mobile navigation & state match. */
export function rescopeMobileResult<T>(method: string, result: T, hostId: string, primaryId: string | null): T {
  if (!result || hostId === primaryId) return result;
  const s = (id: string) => idForHost(hostId, id, primaryId);
  if (typeof result === "string") {
    return (STRING_ID_METHODS.has(method) ? s(result) : result) as unknown as T;
  }
  if (Array.isArray(result)) {
    if (STRING_ARRAY_ID_METHODS.has(method)) {
      return result.map((item) => (typeof item === "string" ? s(item) : item)) as unknown as T;
    }
    if (method === "channelsList") {
      return (result as unknown as ChannelConnection[]).map((conn) => scopeChannel(conn, s)) as unknown as T;
    }
    if (method === "channelPairList") {
      return (result as unknown as Array<Record<string, unknown>>).map((p) =>
        p && typeof p === "object"
          ? { ...p, ...(typeof p.connectionId === "string" && p.connectionId ? { connectionId: s(p.connectionId) } : {}) }
          : p,
      ) as unknown as T;
    }
    if (method === "channelLogs") {
      return (result as unknown as ChannelAuditEntry[]).map((entry) => ({
        ...entry,
        ...(entry.connectionId ? { connectionId: s(entry.connectionId) } : {}),
        ...(entry.turnId ? { turnId: s(entry.turnId) } : {}),
      })) as unknown as T;
    }
    return result;
  }
  if (typeof result !== "object") return result;
  if (method === "link.messages") {
    return scopeChatDetail(result as unknown as ChatDetail, hostId, primaryId) as unknown as T;
  }
  if (method === "chat.cardAction") {
    const res = result as unknown as {
      state: "dispatched" | "dismissed";
      chatId?: string;
      botId?: string;
      botName?: string;
      card: WorkflowActionCard;
    };
    return {
      ...res,
      ...(res.chatId ? { chatId: s(res.chatId) } : {}),
      ...(res.botId ? { botId: s(res.botId) } : {}),
      ...(res.card ? { card: scopeActionCard(res.card, s) } : {}),
    } as unknown as T;
  }
  if (method === "channelAdd" || method === "channelUpdate" || method === "channelBind" || method === "channelSetPolicy" || method === "channelPause" || method === "channelResume") {
    return scopeChannel(result as unknown as ChannelConnection, s) as unknown as T;
  }
  if (method === "channelRemove") {
    const res = result as unknown as { removed: boolean; id: string };
    return { ...res, ...(res.id ? { id: s(res.id) } : {}) } as unknown as T;
  }
  if (method === "channelPairApprove" || method === "channelPairDeny") {
    const res = result as unknown as Record<string, unknown>;
    return {
      ...res,
      ...(typeof res.connectionId === "string" && res.connectionId ? { connectionId: s(res.connectionId) } : {}),
    } as unknown as T;
  }
  if (method === "workflowsList") {
    const res = result as unknown as { workflows: Workflow[]; runs: WorkflowRun[] };
    return {
      ...res,
      workflows: (res.workflows ?? []).map((wf) => scopeWorkflow(wf, s)),
      runs: (res.runs ?? []).map((r) => scopeWorkflowRun(r, s)),
    } as unknown as T;
  }
  if (method === "workflowCreate" || method === "workflowUpdate" || method === "workflowPause" || method === "workflowResume") {
    return scopeWorkflow(result as unknown as Workflow, s) as unknown as T;
  }
  if (method === "workflowRun" || method === "workflowRetryRun" || method === "workflowRespondApproval" || method === "workflowCancelRun") {
    return scopeWorkflowRun(result as unknown as WorkflowRun, s) as unknown as T;
  }
  if (method === "workflowImportText") {
    const res = result as unknown as { workflow?: Workflow } & Record<string, unknown>;
    return { ...res, ...(res.workflow ? { workflow: scopeWorkflow(res.workflow, s) } : {}) } as unknown as T;
  }
  if (method === "claudeArtifacts.status" || method === "claudeArtifacts.setModel" || method === "claudeArtifacts.setBotApproval" || method === "claudeArtifacts.revokeBotApproval") {
    const res = result as unknown as { grants?: Array<{ botId: string; botName: string; grantedAt: number }> } & Record<string, unknown>;
    return {
      ...res,
      ...(Array.isArray(res.grants) ? { grants: res.grants.map((g) => ({ ...g, botId: s(g.botId) })) } : {}),
    } as unknown as T;
  }
  if (method === "spaces.read") {
    const content = result as unknown as { id: string; seenItems?: Record<string, number>; panels?: PanelView[]; cards?: BoardItem[] };
    const seenItems = content.seenItems
      ? Object.fromEntries(Object.entries(content.seenItems).map(([k, v]) => [s(k), v]))
      : undefined;
    return {
      ...content,
      id: s(content.id),
      ...(seenItems && { seenItems }),
      ...(content.panels && {
        panels: content.panels.map((p) => ({
          ...p,
          id: s(p.id),
          botId: s(p.botId),
          ...(p.chatId && { chatId: s(p.chatId) }),
          ...(p.spaceId && { spaceId: s(p.spaceId) }),
          ...(p.refreshChatId && { refreshChatId: s(p.refreshChatId) }),
          blocks: p.blocks.map((b) => (b.type === "html" && b.frame ? { ...b, frame: s(b.frame) } : b)),
          hostId,
        })),
      }),
      ...(content.cards && {
        cards: content.cards.map((c) => ({ ...c, id: s(c.id), botId: s(c.botId), hostId })),
      }),
    } as unknown as T;
  }
  const obj = result as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  if (typeof obj.id === "string" && (method === "addBot" || method === "newChat" || method === "forkChat" || method === "addProject" || method === "saveTask" || method === "spaces.create" || method === "saveSection" || method === "saveChatSection")) {
    out.id = s(obj.id);
  }
  if (typeof obj.chatId === "string") out.chatId = s(obj.chatId);
  if (typeof obj.botId === "string") out.botId = s(obj.botId);
  if (typeof obj.runId === "string") out.runId = s(obj.runId);
  if (typeof obj.spaceId === "string") out.spaceId = s(obj.spaceId);
  if (typeof obj.panelId === "string") out.panelId = s(obj.panelId);
  return out as T;
}

export function buildUnifiedHostsStatus(
  pairings: Pairing[],
  primaryId: string | null,
  excluded: ReadonlyArray<string>,
  pool: ReadonlyMap<string, { link: LinkState; parts: Partial<Parts> }>,
): UnifiedHostStatus[] {
  const excludedSet = new Set(excluded);
  return pairings.map((pairing) => {
    const entry = pool.get(pairing.serverId);
    const primary = pairing.serverId === primaryId;
    const included = primary || !excludedSet.has(pairing.serverId);
    const team = entry?.parts.team && "team" in entry.parts.team ? entry.parts.team.team.name : undefined;
    return {
      id: pairing.serverId,
      name: entry ? hostNameOf(pairing, entry.parts) : pairing.name || "Computer",
      state: entry?.link ?? "offline",
      primary,
      included,
      ...(team && { member: true, team }),
      bots: entry?.parts.bots?.length ?? 0,
    };
  });
}

export function optScopedId(hostId: string, rawId: string | undefined, primaryId: string | null): string | undefined {
  return optScope(hostId, primaryId, rawId);
}
