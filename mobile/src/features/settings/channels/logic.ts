// Pure helpers for Settings › Channels: status mapping, adapter metadata matching
// desktop/desktop/channels/types.mjs, allowlist edits, blocked-event-to-fix mapping,
// day grouping, and secret-form clearing. No React Native imports so Node tests run directly.
import type {
  ChannelAllowlistEntry,
  ChannelAuditEntry,
  ChannelConnection,
  ChannelDmPolicy,
  ChannelGroupMode,
  ChannelKind,
  ChannelLimits,
  ChannelPairing,
  ChannelPolicy,
  ChannelPolicyPatch,
  ChannelStatusState,
  ChannelToolProfile,
} from "@/link/types";

export type ChannelTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export type ChannelSecretSpec = {
  key: string;
  label: string;
  placeholder: string;
  required: boolean;
  prefixHint?: string;
};

export type ChannelKindSpec = {
  kind: ChannelKind;
  name: string;
  shortSubtitle: string;
  transport: string;
  transportLabel: string;
  connectHeading: string;
  connectCaption: string;
  brandColor: string;
  secrets: readonly ChannelSecretSpec[];
};

/**
 * Matches CHANNEL_SECRET_SPECS and DEFAULT_TRANSPORT in desktop/desktop/channels/types.mjs.
 */
export const CHANNEL_KIND_SPECS: Record<ChannelKind, ChannelKindSpec> = {
  slack: {
    kind: "slack",
    name: "Slack",
    shortSubtitle: "Socket mode",
    transport: "socket_mode",
    transportLabel: "socket mode",
    connectHeading: "Connect Slack",
    connectCaption: "Paste two tokens from your Slack app.",
    brandColor: "#4A154B",
    secrets: [
      { key: "appToken", label: "App-level token", placeholder: "xapp-1-…", required: true, prefixHint: "xapp-" },
      { key: "botToken", label: "Bot token", placeholder: "xoxb-…", required: true, prefixHint: "xoxb-" },
    ],
  },
  telegram: {
    kind: "telegram",
    name: "Telegram",
    shortSubtitle: "Bot token",
    transport: "long_polling",
    transportLabel: "long polling",
    connectHeading: "Connect Telegram",
    connectCaption: "Paste the bot token from @BotFather.",
    brandColor: "#2AABEE",
    secrets: [
      { key: "botToken", label: "Bot token", placeholder: "123456:ABC-…", required: true },
    ],
  },
  discord: {
    kind: "discord",
    name: "Discord",
    shortSubtitle: "Gateway bot",
    transport: "gateway",
    transportLabel: "gateway",
    connectHeading: "Connect Discord",
    connectCaption: "Paste your bot token from the Discord Developer Portal.",
    brandColor: "#5865F2",
    secrets: [
      { key: "botToken", label: "Bot token", placeholder: "Discord bot token", required: true },
    ],
  },
  imessage: {
    kind: "imessage",
    name: "iMessage",
    shortSubtitle: "imsg CLI",
    transport: "imsg_local",
    transportLabel: "imsg CLI",
    connectHeading: "Connect iMessage",
    connectCaption: "Runs via imsg on this Mac or a paired Mac node host.",
    brandColor: "#30D158",
    secrets: [],
  },
};

export const CHANNEL_KIND_LIST: readonly ChannelKind[] = ["slack", "telegram", "discord", "imessage"];

export const DM_POLICY_OPTIONS: { value: ChannelDmPolicy; label: string; description: string }[] = [
  { value: "pairing", label: "Pairing", description: "Strangers get a code. You approve before any bot runs." },
  { value: "allowlist", label: "Allowlist", description: "Only people on your allowlist can message this bot." },
  { value: "open", label: "Open", description: "Anyone who can reach this channel can start a turn." },
  { value: "off", label: "Off", description: "Direct messages are ignored." },
];

export const GROUP_MODE_OPTIONS: { value: ChannelGroupMode; label: string; description: string }[] = [
  { value: "mention", label: "Mention only", description: "Replies when @mentioned or replied to in listed groups." },
  { value: "all", label: "All messages", description: "Answers every message in listed group channels." },
];

export const TOOL_PROFILE_OPTIONS: { value: ChannelToolProfile; label: string; description: string }[] = [
  {
    value: "restricted",
    label: "Restricted",
    description: "Read-only knowledge tools only. Shell, files, browser, vault, and outbound actions stay off.",
  },
  {
    value: "standard",
    label: "Standard",
    description: "Widened tools for external senders. Approval-gated actions still wait for you in Botkins.",
  },
];

export const DEFAULT_CHANNEL_LIMITS: ChannelLimits = {
  senderPerMinute: 10,
  connectionPerMinute: 60,
  maxInboundLength: 4000,
  maxAttachmentBytes: 5 * 1024 * 1024,
  allowedAttachmentTypes: ["image/*", "text/plain", "application/pdf"],
  dailyTurnCap: 200,
};

export function effectivePolicy(conn: ChannelConnection | undefined): ChannelPolicy {
  const raw = conn?.policy;
  const rawLimits = raw?.limits;
  const dm: ChannelDmPolicy =
    raw?.dm === "pairing" || raw?.dm === "allowlist" || raw?.dm === "open" || raw?.dm === "off"
      ? raw.dm
      : "pairing";
  const mode: ChannelGroupMode = raw?.groups?.mode === "all" ? "all" : "mention";
  const toolProfile: ChannelToolProfile = raw?.toolProfile === "standard" ? "standard" : "restricted";
  return {
    dm,
    allowlist: Array.isArray(raw?.allowlist) ? raw.allowlist : [],
    groups: {
      enabled: Boolean(raw?.groups?.enabled),
      mode,
      channels: Array.isArray(raw?.groups?.channels) ? raw.groups.channels : [],
    },
    toolProfile,
    ignoreBots: raw?.ignoreBots !== false,
    notifyPhone: Boolean(raw?.notifyPhone),
    limits: {
      senderPerMinute: rawLimits?.senderPerMinute ?? DEFAULT_CHANNEL_LIMITS.senderPerMinute,
      connectionPerMinute: rawLimits?.connectionPerMinute ?? DEFAULT_CHANNEL_LIMITS.connectionPerMinute,
      maxInboundLength: rawLimits?.maxInboundLength ?? DEFAULT_CHANNEL_LIMITS.maxInboundLength,
      maxAttachmentBytes: rawLimits?.maxAttachmentBytes ?? DEFAULT_CHANNEL_LIMITS.maxAttachmentBytes,
      allowedAttachmentTypes: Array.isArray(rawLimits?.allowedAttachmentTypes)
        ? rawLimits.allowedAttachmentTypes
        : [...DEFAULT_CHANNEL_LIMITS.allowedAttachmentTypes],
      dailyTurnCap: rawLimits?.dailyTurnCap ?? DEFAULT_CHANNEL_LIMITS.dailyTurnCap,
    },
  };
}

export function effectiveState(conn: ChannelConnection): ChannelStatusState {
  if (conn.status?.state) return conn.status.state;
  if (!conn.enabled) return "disabled";
  if (conn.paused) return "paused";
  return "disconnected";
}

export type StatusDisplay = {
  state: ChannelStatusState;
  /** Compact pill label used on the Channels hub list (Live/Error/Paused/Reconnecting/Waiting). */
  pillLabel: string;
  /** Fuller label used on the Connection detail hero card. */
  detailLabel: string;
  tone: ChannelTone;
  dot: boolean;
  broken: boolean;
};

export function channelStatusMeta(conn: ChannelConnection): StatusDisplay {
  const state = effectiveState(conn);
  switch (state) {
    case "connected":
      return { state, pillLabel: "Live", detailLabel: "Connected", tone: "success", dot: true, broken: false };
    case "auth_error":
      return { state, pillLabel: "Error", detailLabel: "Auth error", tone: "danger", dot: false, broken: true };
    case "reconnecting":
      return { state, pillLabel: "Reconnecting", detailLabel: "Reconnecting", tone: "warning", dot: true, broken: false };
    case "waiting_permission":
      return { state, pillLabel: "Waiting", detailLabel: "Waiting for macOS permission", tone: "warning", dot: false, broken: true };
    case "paused":
      return { state, pillLabel: "Paused", detailLabel: "Paused", tone: "neutral", dot: false, broken: false };
    case "disabled":
      return { state, pillLabel: "Disabled", detailLabel: "Disabled", tone: "neutral", dot: false, broken: false };
    case "disconnected":
    default:
      return {
        state: "disconnected",
        pillLabel: "Offline",
        detailLabel: "Disconnected",
        tone: "danger",
        dot: false,
        broken: Boolean(conn.enabled && !conn.paused),
      };
  }
}

export function isBrokenConnection(conn: ChannelConnection): boolean {
  return channelStatusMeta(conn).broken;
}

export function transportDisplay(conn: ChannelConnection): string {
  switch (conn.transport) {
    case "socket_mode":
      return "socket mode";
    case "long_polling":
      return "long polling";
    case "gateway":
      return "gateway";
    case "webhook":
      return "webhook";
    case "imsg_node":
      return conn.nodeHostId ? `via ${conn.nodeHostId}` : "via Mac node";
    case "imsg_local":
      return "local Mac";
    default:
      return conn.transport || CHANNEL_KIND_SPECS[conn.kind]?.transportLabel || conn.kind;
  }
}

export function groupSummary(policy: ChannelPolicy): string {
  if (!policy.groups.enabled) return "Off";
  const mode = policy.groups.mode === "all" ? "All messages" : "Mention only";
  const count = policy.groups.channels.length;
  return count > 0 ? `${mode} · ${count}` : mode;
}

export function limitsSummary(limits: ChannelLimits): string {
  return `${limits.dailyTurnCap}/day · ${limits.senderPerMinute}/min`;
}

export function formatTimeLeft(expiresAt: number, now = Date.now()): string {
  const remaining = Math.max(0, expiresAt - now);
  if (remaining <= 0) return "Expired";
  const mins = Math.ceil(remaining / 60_000);
  if (mins < 60) return `${mins}m left`;
  const hours = Math.ceil(remaining / 3_600_000);
  return `${hours}h left`;
}

export function formatShortTime(ts: number | undefined, now = Date.now()): string {
  if (!ts) return "";
  const delta = Math.max(0, now - ts);
  if (delta < 60_000) return "just now";
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(delta / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(delta / 86_400_000);
  return `${days}d ago`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function formatMonthDay(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

export function formatDayHeading(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return formatMonthDay(ts);
}

export function allowlistOriginLine(entry: ChannelAllowlistEntry): string {
  const origin = entry.source === "pairing" ? "Paired" : "Added by you";
  const date = formatMonthDay(entry.addedAt);
  return date ? `${origin} · ${date}` : origin;
}

export function addAllowlistSender(
  allowlist: readonly ChannelAllowlistEntry[],
  senderId: string,
  display?: string,
  now = Date.now(),
): ChannelAllowlistEntry[] {
  const cleanId = senderId.trim();
  if (!cleanId) return [...allowlist];
  const cleanDisplay = (display ?? "").trim();
  const existing = allowlist.find((entry) => entry.senderId === cleanId);
  if (existing) {
    if (cleanDisplay && cleanDisplay !== existing.display) {
      return allowlist.map((entry) => (entry.senderId === cleanId ? { ...entry, display: cleanDisplay } : entry));
    }
    return [...allowlist];
  }
  return [
    ...allowlist,
    {
      senderId: cleanId,
      display: cleanDisplay || cleanId,
      addedAt: now,
      source: "manual",
    },
  ];
}

export function removeAllowlistSender(
  allowlist: readonly ChannelAllowlistEntry[],
  senderId: string,
): ChannelAllowlistEntry[] {
  return allowlist.filter((entry) => entry.senderId !== senderId);
}

export function filterAllowlist(
  allowlist: readonly ChannelAllowlistEntry[],
  query: string,
): ChannelAllowlistEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...allowlist];
  return allowlist.filter(
    (entry) =>
      entry.senderId.toLowerCase().includes(q) ||
      (entry.display ?? "").toLowerCase().includes(q),
  );
}

export function collectPendingPairings(
  channels: readonly ChannelConnection[],
  connectionId?: string,
): Array<ChannelPairing & { connectionId: string; connectionLabel: string; kind: ChannelKind }> {
  const out: Array<ChannelPairing & { connectionId: string; connectionLabel: string; kind: ChannelKind }> = [];
  for (const conn of channels) {
    if (connectionId && conn.id !== connectionId) continue;
    for (const p of conn.pendingPairings ?? []) {
      out.push({
        ...p,
        connectionId: conn.id,
        connectionLabel: conn.label,
        kind: conn.kind,
      });
    }
  }
  return out.sort((a, b) => a.expiresAt - b.expiresAt);
}

export type ActivityFilter = "all" | "blocked" | "replied" | "pairing" | "errors";

export type AuditDisplay = {
  category: Exclude<ActivityFilter, "all">;
  badgeLabel: string;
  tone: ChannelTone;
  reasonText: string;
  blocked: boolean;
};

const REASON_LABELS: Record<string, string> = {
  dm_off: "DMs are off",
  not_allowlisted: "not on allowlist",
  pairing_code_issued: "code sent",
  groups_off: "groups are off",
  channel_not_listed: "channel not listed",
  mention_required: "not mentioned",
  max_inbound_length: "message too long",
  sender_rate_limit: "sender rate limit",
  connection_rate_limit: "connection rate limit",
  daily_turn_cap: "daily turn cap",
  attachment_rejected: "attachment blocked",
  self_message: "self message",
  bot_sender: "bot sender",
  inactive: "channel paused",
  invalid_event: "invalid event",
  turn_failed: "turn failed",
  reply_send_failed: "reply failed",
};

export function auditReasonLabel(reason?: string): string {
  if (!reason) return "";
  return REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}

export function auditEntryDisplay(entry: ChannelAuditEntry): AuditDisplay {
  const reasonText = auditReasonLabel(entry.reason);
  switch (entry.decision) {
    case "reply_sent":
    case "allowed":
      return {
        category: "replied",
        badgeLabel: entry.decision === "reply_sent" ? "Replied" : "Allowed",
        tone: "success",
        reasonText: entry.replyParts && entry.replyParts > 1 ? `${entry.replyParts} parts` : reasonText,
        blocked: false,
      };
    case "paired":
    case "pairing_approved":
    case "pairing_denied":
      return {
        category: "pairing",
        badgeLabel:
          entry.decision === "pairing_approved"
            ? "Approved"
            : entry.decision === "pairing_denied"
              ? "Denied"
              : "Pairing",
        tone: entry.decision === "pairing_denied" ? "neutral" : "info",
        reasonText:
          entry.decision === "pairing_approved"
            ? "added to allowlist"
            : entry.decision === "pairing_denied"
              ? "request denied"
              : reasonText || "code sent",
        blocked: false,
      };
    case "error":
      return {
        category: "errors",
        badgeLabel: "Error",
        tone: "danger",
        reasonText: reasonText || "error",
        blocked: false,
      };
    case "denied":
    case "rate_limited":
    case "ignored_bot":
    default:
      return {
        category: "blocked",
        badgeLabel: "Blocked",
        tone: "danger",
        reasonText: reasonText || entry.decision,
        blocked: true,
      };
  }
}

export function filterAuditEntries(
  entries: readonly ChannelAuditEntry[],
  filter: ActivityFilter,
  connectionId?: string,
): ChannelAuditEntry[] {
  return entries.filter((entry) => {
    if (connectionId && entry.connectionId !== connectionId) return false;
    if (filter === "all") return true;
    return auditEntryDisplay(entry).category === filter;
  });
}

export type AuditDayGroup = {
  key: string;
  label: string;
  entries: ChannelAuditEntry[];
};

export function groupAuditByDay(entries: readonly ChannelAuditEntry[], now = Date.now()): AuditDayGroup[] {
  const groups = new Map<string, AuditDayGroup>();
  for (const entry of entries) {
    const d = new Date(entry.time);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: formatDayHeading(entry.time, now), entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

export type BlockedFixAction = {
  id: string;
  label: string;
  variant: "primary" | "secondary";
  patch: ChannelPolicyPatch;
  successToast: string;
};

export type BlockedFixPlan = {
  title: string;
  subtitle: string;
  explanation: string;
  actions: BlockedFixAction[];
};

/**
 * Maps a blocked audit event to the exact channelSetPolicy fix(es) that would have let it through.
 * Never exposes message bodies — works strictly from metadata (senderId, conversationId, reason).
 */
export function blockedEventFixPlan(
  entry: ChannelAuditEntry,
  conn: ChannelConnection | undefined,
): BlockedFixPlan {
  const policy = effectivePolicy(conn);
  const who = entry.senderId || "This sender";
  const channelLabel = conn?.label ?? CHANNEL_KIND_SPECS[entry.kind as ChannelKind]?.name ?? String(entry.kind);
  const place = entry.conversationId ? `${channelLabel} · ${entry.conversationId}` : channelLabel;
  const reason = entry.reason ?? "";

  switch (reason) {
    case "mention_required": {
      const actions: BlockedFixAction[] = [];
      if (entry.senderId) {
        actions.push({
          id: "allow_sender",
          label: "Allow this person",
          variant: "primary",
          patch: { allowlist: addAllowlistSender(policy.allowlist, entry.senderId) },
          successToast: `${entry.senderId} added to allowlist`,
        });
      }
      actions.push({
        id: "group_mode_all",
        label: entry.conversationId
          ? `Answer everyone in ${entry.conversationId}`
          : "Answer all group messages",
        variant: actions.length ? "secondary" : "primary",
        patch: {
          groups: {
            ...policy.groups,
            enabled: true,
            mode: "all",
            channels: entry.conversationId && !policy.groups.channels.includes(entry.conversationId)
              ? [...policy.groups.channels, entry.conversationId]
              : policy.groups.channels,
          },
        },
        successToast: "Group mode set to all messages",
      });
      return {
        title: `${who} was blocked`,
        subtitle: `${place} · Mention only`,
        explanation: entry.conversationId
          ? `The bot only answers in ${entry.conversationId} when it's mentioned. Let this person through, or answer every message there.`
          : "The bot only answers in groups when it's mentioned. Let this person through, or answer every message there.",
        actions,
      };
    }

    case "not_allowlisted": {
      const actions: BlockedFixAction[] = [];
      if (entry.senderId) {
        actions.push({
          id: "allow_sender",
          label: "Allow this person",
          variant: "primary",
          patch: { allowlist: addAllowlistSender(policy.allowlist, entry.senderId) },
          successToast: `${entry.senderId} added to allowlist`,
        });
      }
      actions.push({
        id: "dm_pairing",
        label: "Switch DMs to Pairing",
        variant: actions.length ? "secondary" : "primary",
        patch: { dm: "pairing" },
        successToast: "DM policy set to Pairing",
      });
      return {
        title: `${who} was blocked`,
        subtitle: `${channelLabel} · Allowlist only`,
        explanation: "Direct messages are limited to your allowlist. Add this sender so future DMs go through.",
        actions,
      };
    }

    case "dm_off": {
      const actions: BlockedFixAction[] = [];
      if (entry.senderId) {
        actions.push({
          id: "allow_sender_and_allowlist",
          label: "Allow this person (Allowlist)",
          variant: "primary",
          patch: {
            dm: "allowlist",
            allowlist: addAllowlistSender(policy.allowlist, entry.senderId),
          },
          successToast: `Enabled allowlist DMs for ${entry.senderId}`,
        });
      }
      actions.push({
        id: "dm_pairing",
        label: "Turn on DM Pairing",
        variant: actions.length ? "secondary" : "primary",
        patch: { dm: "pairing" },
        successToast: "DM policy set to Pairing",
      });
      return {
        title: `${who} was blocked`,
        subtitle: `${channelLabel} · DMs off`,
        explanation: "Direct messages are turned off on this channel. Turn on Allowlist or Pairing to accept DMs.",
        actions,
      };
    }

    case "groups_off": {
      const nextChannels = entry.conversationId && !policy.groups.channels.includes(entry.conversationId)
        ? [...policy.groups.channels, entry.conversationId]
        : policy.groups.channels;
      return {
        title: `${who} was blocked`,
        subtitle: `${place} · Groups off`,
        explanation: "Group messages are disabled on this channel. Enable groups and add this conversation to answer there.",
        actions: [
          {
            id: "enable_groups",
            label: entry.conversationId ? `Enable ${entry.conversationId} (Mention only)` : "Enable groups (Mention only)",
            variant: "primary",
            patch: {
              groups: {
                enabled: true,
                mode: "mention",
                channels: nextChannels,
              },
            },
            successToast: "Groups enabled",
          },
        ],
      };
    }

    case "channel_not_listed": {
      const nextChannels = entry.conversationId && !policy.groups.channels.includes(entry.conversationId)
        ? [...policy.groups.channels, entry.conversationId]
        : policy.groups.channels;
      return {
        title: `${who} was blocked`,
        subtitle: `${place} · Group not listed`,
        explanation: "This group isn't in the allowed group list yet. Add it so the bot can respond there.",
        actions: entry.conversationId
          ? [
              {
                id: "list_group",
                label: `Add ${entry.conversationId} to allowed groups`,
                variant: "primary",
                patch: {
                  groups: {
                    ...policy.groups,
                    enabled: true,
                    channels: nextChannels,
                  },
                },
                successToast: `Added ${entry.conversationId} to groups`,
              },
            ]
          : [],
      };
    }

    case "daily_turn_cap": {
      const nextCap = Math.min(100_000, Math.max(policy.limits.dailyTurnCap * 2, policy.limits.dailyTurnCap + 100));
      return {
        title: `${who} was blocked`,
        subtitle: `${channelLabel} · Daily cap (${policy.limits.dailyTurnCap})`,
        explanation: `This connection reached its daily limit of ${policy.limits.dailyTurnCap} turns.`,
        actions: [
          {
            id: "raise_daily_cap",
            label: `Raise daily cap to ${nextCap}`,
            variant: "primary",
            patch: { limits: { dailyTurnCap: nextCap } },
            successToast: `Daily cap raised to ${nextCap}`,
          },
        ],
      };
    }

    case "sender_rate_limit": {
      const nextRate = Math.min(1000, policy.limits.senderPerMinute * 2);
      return {
        title: `${who} was blocked`,
        subtitle: `${channelLabel} · Sender rate limit`,
        explanation: `This sender exceeded ${policy.limits.senderPerMinute} messages per minute.`,
        actions: [
          {
            id: "raise_sender_rate",
            label: `Raise limit to ${nextRate}/min`,
            variant: "primary",
            patch: { limits: { senderPerMinute: nextRate } },
            successToast: `Sender limit raised to ${nextRate}/min`,
          },
        ],
      };
    }

    case "connection_rate_limit": {
      const nextRate = Math.min(10_000, policy.limits.connectionPerMinute * 2);
      return {
        title: `${who} was blocked`,
        subtitle: `${channelLabel} · Connection rate limit`,
        explanation: `This connection exceeded ${policy.limits.connectionPerMinute} messages per minute.`,
        actions: [
          {
            id: "raise_conn_rate",
            label: `Raise limit to ${nextRate}/min`,
            variant: "primary",
            patch: { limits: { connectionPerMinute: nextRate } },
            successToast: `Connection limit raised to ${nextRate}/min`,
          },
        ],
      };
    }

    default:
      return {
        title: `${who} was blocked`,
        subtitle: `${place}${reason ? ` · ${auditReasonLabel(reason)}` : ""}`,
        explanation: "This event was blocked by the channel's policy or limits. Review the connection settings to adjust it.",
        actions: entry.senderId
          ? [
              {
                id: "allow_sender",
                label: "Allow this person",
                variant: "secondary",
                patch: { allowlist: addAllowlistSender(policy.allowlist, entry.senderId) },
                successToast: `${entry.senderId} added to allowlist`,
              },
            ]
          : [],
      };
  }
}

export type TodayChannelStats = {
  turns: number;
  blocked: number;
  newPeople: number;
};

export function computeTodayStats(
  channels: readonly ChannelConnection[],
  logs: readonly ChannelAuditEntry[],
  now = Date.now(),
): TodayChannelStats {
  const d = new Date(now);
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  let turnsFromUsage = 0;
  for (const conn of channels) {
    if (conn.dailyUsage?.date === todayKey && Number.isFinite(conn.dailyUsage.turns)) {
      turnsFromUsage += conn.dailyUsage.turns;
    }
  }

  let turnsFromLogs = 0;
  let blocked = 0;
  const newPeopleSet = new Set<string>();
  for (const entry of logs) {
    if (entry.time < startOfDay) continue;
    if (entry.decision === "allowed" || entry.decision === "reply_sent") {
      if (entry.decision === "allowed") turnsFromLogs += 1;
    } else if (entry.decision === "denied" || entry.decision === "rate_limited") {
      blocked += 1;
    } else if (entry.decision === "paired" || entry.decision === "pairing_approved") {
      if (entry.senderId) newPeopleSet.add(`${entry.connectionId}:${entry.senderId}`);
    }
  }
  return {
    turns: Math.max(turnsFromUsage, turnsFromLogs),
    blocked,
    newPeople: newPeopleSet.size,
  };
}

/**
 * Pure helper for building the trimmed `secrets` payload for channelAdd/channelUpdate
 * and always returning an empty map to overwrite component state afterward.
 */
export function buildSecretsPayload(
  kind: ChannelKind,
  drafts: Record<string, string>,
): { secrets: Record<string, string>; missing: ChannelSecretSpec[] } {
  const specs = CHANNEL_KIND_SPECS[kind]?.secrets ?? [];
  const secrets: Record<string, string> = {};
  const missing: ChannelSecretSpec[] = [];
  for (const spec of specs) {
    const val = (drafts[spec.key] ?? "").trim();
    if (val) secrets[spec.key] = val;
    else if (spec.required) missing.push(spec);
  }
  return { secrets, missing };
}

/**
 * Sends channel secrets via the supplied submit callback, then clears every secret string
 * from the payload object and invokes `clearState` in `finally` so tokens never linger in
 * component state even if submission throws or returns null.
 */
export async function submitAndClearSecrets<T>(
  secrets: Record<string, string>,
  submit: (payload: Record<string, string>) => Promise<T>,
  clearState: () => void,
): Promise<T> {
  const copy: Record<string, string> = { ...secrets };
  try {
    return await submit(copy);
  } finally {
    for (const key of Object.keys(copy)) {
      copy[key] = "";
      delete copy[key];
    }
    clearState();
  }
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
