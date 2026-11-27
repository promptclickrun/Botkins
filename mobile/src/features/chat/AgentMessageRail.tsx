// Quiet hairline cards for bot-to-bot messages on phone (incoming, grouped outgoing asks,
// grouped task handoffs, and folded node calls).
import { ArrowUpRight, Bot as BotIcon, Check, ChevronDown, ChevronRight, CircleAlert, Globe, X as XIcon } from "lucide-react-native";
import { memo, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import type { Bot, Message, Run, TeamAsk } from "@/link/types";
import { useChats, usePart } from "@/state/hooks";
import { BotAvatar, Markdown, space, T, Tap, useOnShow, useTheme } from "@/ui";
import {
  askRowSummary,
  buildIncomingRail,
  buildOutgoingRail,
  buildTaskHandoffGroup,
  formatCompactElapsed,
  groupAsks,
  type AskGroupModel,
  type NodeCallGroupModel,
  type TaskHandoffGroupModel,
  type TaskHandoffRailModel,
} from "./agentRailModel";
import { openChat as openChatRoute } from "./navigate";
import { useElapsedClock } from "./useElapsedClock";

function clock(time?: number): string {
  if (!time) return "";
  try {
    return new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function PulseDot({ color, size = 6 }: { color: string; size?: number }) {
  const reduced = useReducedMotion();
  const visible = useOnShow();
  const opacity = useSharedValue(reduced ? 0.85 : 0.4);
  useEffect(() => {
    if (reduced || !visible) {
      opacity.value = 0.85;
      return;
    }
    opacity.value = withRepeat(
      withSequence(withTiming(1, { duration: 700 }), withTiming(0.35, { duration: 700 })),
      -1,
      false,
    );
  }, [reduced, visible, opacity]);
  const anim = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, anim]} />;
}

function RailFace({ bot, remote, size = 18 }: { bot?: Bot; remote?: boolean; size?: number }) {
  const { colors } = useTheme();
  if (bot) return <BotAvatar bot={bot} size={size} />;
  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.sunken,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {remote ? (
        <Globe size={Math.round(size * 0.65)} color={colors.muted} strokeWidth={2.2} />
      ) : (
        <BotIcon size={Math.round(size * 0.65)} color={colors.muted} strokeWidth={2.2} />
      )}
    </View>
  );
}

/**
 * Recipient-side card on phone: renders an incoming bot-to-bot message (task handoff, remote dispatch,
 * or teamwork) with a quiet hairline border, muted "from X" header, collapsible body, and source chat link.
 */
export const IncomingAgentRail = memo(function IncomingAgentRail({
  message,
  bots,
  onOpenChat = openChatRoute,
}: {
  message: Message;
  bots: Map<string, Bot>;
  onOpenChat?: (chatId: string) => void;
}) {
  const { colors } = useTheme();
  const chats = useChats();
  const [expanded, setExpanded] = useState(false);

  const botList = useMemo(() => [...bots.values()], [bots]);
  const accessibleChatIds = useMemo(() => new Set(chats.map((c) => c.id)), [chats]);
  const model = useMemo(
    () => buildIncomingRail(message, { bots: botList, accessibleChatIds }),
    [message, botList, accessibleChatIds],
  );
  if (!model) return null;

  const senderBot = bots.get(model.senderBotId);
  const stamp = clock(model.time);
  const meta = [model.viaLabel, stamp].filter(Boolean).join(" · ");

  return (
    <View
      accessible={false}
      accessibilityLabel={model.ariaLabel}
      style={[
        styles.incomingCard,
        {
          backgroundColor: colors.surface,
          borderColor: colors.line,
        },
      ]}
    >
      <View style={styles.head} accessible accessibilityLabel={model.ariaLabel}>
        <RailFace bot={senderBot} remote={model.via === "remote"} />
        <View style={styles.identity}>
          <T variant="footnote" color="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
            from{" "}
            <T variant="footnote" weight="600" color="ink">
              {model.senderName}
            </T>
            {meta ? " · " + meta : ""}
          </T>
        </View>
        {!!model.sourceChatId && (
          <Tap
            onPress={() => onOpenChat(model.sourceChatId!)}
            feel="select"
            accessibilityLabel={"Open chat with " + model.senderName}
            style={styles.linkButton}
          >
            <T variant="caption" color="muted">
              Source chat
            </T>
            <ArrowUpRight size={12} color={colors.muted} strokeWidth={2.2} />
          </Tap>
        )}
      </View>

      {!!model.taskTitle && (
        <T variant="footnote" weight="600" color="ink">
          {model.taskTitle}
        </T>
      )}

      {model.collapsible && !expanded ? (
        <T variant="footnote" color="ink2" numberOfLines={2}>
          {model.preview}
        </T>
      ) : (
        <Markdown text={model.body} />
      )}

      {model.collapsible && (
        <Tap
          onPress={() => setExpanded((v) => !v)}
          feel="select"
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={expanded ? "Show less" : "Show full message"}
          style={styles.toggle}
        >
          {expanded ? (
            <ChevronDown size={13} color={colors.muted} strokeWidth={2.2} />
          ) : (
            <ChevronRight size={13} color={colors.muted} strokeWidth={2.2} />
          )}
          <T variant="caption" color="muted">
            {expanded ? "Show less" : "Show full message"}
          </T>
        </Tap>
      )}
    </View>
  );
});

const AskRow = memo(function AskRow({ ask, bots }: { ask: TeamAsk; bots: Map<string, Bot> }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);

  const botList = useMemo(() => [...bots.values()], [bots]);
  const model = useMemo(() => buildOutgoingRail(ask, botList), [ask, botList]);
  const now = useElapsedClock(model.live);
  const targetBot = ask.remote ? undefined : bots.get(ask.botId);
  const summary = useMemo(() => askRowSummary(model), [model]);
  const liveElapsed = model.live ? formatCompactElapsed(Math.max(0, now - ask.started)) : "";

  return (
    <View style={[styles.rowWrap, { borderTopColor: colors.line }]}>
      <Tap
        onPress={() => setExpanded((v) => !v)}
        feel="select"
        sink={0.99}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={model.ariaLabel}
        style={styles.rowButton}
      >
        <RailFace bot={targetBot} remote={model.via === "remote"} size={18} />
        <T variant="footnote" weight="600" color="ink" numberOfLines={1} style={styles.rowName}>
          {model.targetName}
        </T>
        <T variant="footnote" color="muted" numberOfLines={1} style={styles.rowSummary}>
          {summary}
        </T>
        <View style={styles.rowTrail}>
          {model.status === "answered" ? (
            <Check size={14} color={colors.success} strokeWidth={2.4} />
          ) : model.live ? (
            <T variant="caption" color="accentText" style={styles.tabular}>
              {liveElapsed}
            </T>
          ) : model.status === "failed" ? (
            <XIcon size={14} color={colors.danger} strokeWidth={2.4} />
          ) : (
            <T variant="caption" color="muted">
              stopped
            </T>
          )}
        </View>
      </Tap>

      {expanded && (
        <View style={[styles.rowBody, { borderTopColor: colors.line }]}>
          <T variant="footnote" color="ink2">
            {model.message}
          </T>
          {!!model.expecting && (
            <T variant="caption" color="muted">
              Needs: {model.expecting}
            </T>
          )}
          {!!model.reply && (
            <View style={[styles.replyBox, { backgroundColor: colors.canvas, borderColor: colors.line }]}>
              <Markdown text={model.reply} />
            </View>
          )}
          {!model.reply && !!model.error && (
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
              <CircleAlert size={14} color={colors.danger} strokeWidth={2.2} />
              <T variant="footnote" color="danger" style={{ flex: 1 }}>
                {model.error}
              </T>
            </View>
          )}
          {model.stepCount > 0 && (
            <T variant="caption" color="muted">
              {model.stepCount === 1 ? "1 tool step" : model.stepCount + " tool steps"}
            </T>
          )}
        </View>
      )}
    </View>
  );
});

const AskGroupCard = memo(function AskGroupCard({ group, bots }: { group: AskGroupModel; bots: Map<string, Bot> }) {
  const { colors } = useTheme();
  return (
    <View
      accessible={false}
      style={[
        styles.groupCard,
        {
          backgroundColor: colors.surface,
          borderColor: colors.line,
        },
      ]}
    >
      <View style={styles.groupHead}>
        {group.live && <PulseDot color={colors.accent} size={6} />}
        <T variant="footnote" color="muted" numberOfLines={1} style={{ flex: 1 }}>
          {group.header}
        </T>
      </View>
      {group.asks.map((ask) => (
        <AskRow key={ask.id} ask={ask} bots={bots} />
      ))}
    </View>
  );
});

/** Back-to-back node calls folded into one quiet card; tap to see each call row. */
const NodeCallGroupCard = memo(function NodeCallGroupCard({ group, bots }: { group: NodeCallGroupModel; bots: Map<string, Bot> }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View
      accessible={false}
      style={[styles.groupCard, { backgroundColor: colors.surface, borderColor: colors.line }]}
    >
      <Tap
        onPress={() => setOpen((v) => !v)}
        feel="select"
        sink={0.99}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={group.ariaLabel + (open ? ", collapse" : ", expand")}
        style={styles.groupHead}
      >
        {open ? (
          <ChevronDown size={13} color={colors.muted} strokeWidth={2.2} />
        ) : (
          <ChevronRight size={13} color={colors.muted} strokeWidth={2.2} />
        )}
        <RailFace remote size={18} />
        <T variant="footnote" weight="600" color="ink" numberOfLines={1}>
          {group.title}
        </T>
        {!open && (
          <T variant="footnote" color="muted" numberOfLines={1} style={styles.rowSummary}>
            {group.summary.replace(/\s+/g, " ").trim()}
          </T>
        )}
        <View style={styles.rowTrail}>
          {group.live ? (
            <T variant="caption" color="accentText" style={styles.tabular}>
              {group.running + " running"}
            </T>
          ) : group.failed ? (
            <XIcon size={14} color={colors.danger} strokeWidth={2.4} />
          ) : (
            <Check size={14} color={colors.success} strokeWidth={2.4} />
          )}
        </View>
      </Tap>
      {open && group.asks.map((ask) => <AskRow key={ask.id} ask={ask} bots={bots} />)}
    </View>
  );
});

const TaskHandoffRow = memo(function TaskHandoffRow({
  model,
  bots,
  onOpenChat = openChatRoute,
}: {
  model: TaskHandoffRailModel;
  bots: Map<string, Bot>;
  onOpenChat?: (chatId: string) => void;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);

  const targetBot = bots.get(model.targetBotId);
  const done = model.status === "done" || model.status === "review";

  return (
    <View style={[styles.rowWrap, { borderTopColor: colors.line }]}>
      <Tap
        onPress={() => setExpanded((v) => !v)}
        feel="select"
        sink={0.99}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={model.ariaLabel}
        style={styles.rowButton}
      >
        <RailFace bot={targetBot} size={18} />
        <T variant="footnote" weight="600" color="ink" numberOfLines={1} style={styles.rowName}>
          {model.targetName}
        </T>
        <T variant="footnote" color="muted" numberOfLines={1} style={styles.rowSummary}>
          {model.title}
        </T>
        <View style={styles.rowTrail}>
          {done ? (
            <Check size={14} color={colors.success} strokeWidth={2.4} />
          ) : model.status === "blocked" ? (
            <XIcon size={14} color={colors.danger} strokeWidth={2.4} />
          ) : (
            <T variant="caption" color={model.live ? "accentText" : "muted"}>
              {model.statusLabel.toLowerCase()}
            </T>
          )}
        </View>
      </Tap>

      {expanded && (
        <View style={[styles.rowBody, { borderTopColor: colors.line }]}>
          <View style={styles.head}>
            <T variant="footnote" weight="600" color="ink" style={{ flex: 1 }}>
              {model.title}
            </T>
            {!!model.taskChatId && (
              <Tap
                onPress={() => onOpenChat(model.taskChatId!)}
                feel="select"
                accessibilityLabel={"Open task chat: " + model.title}
                style={styles.linkButton}
              >
                <T variant="caption" color="muted">
                  Open task
                </T>
                <ArrowUpRight size={12} color={colors.muted} strokeWidth={2.2} />
              </Tap>
            )}
          </View>
          {!!model.details && (
            <View style={{ gap: 2 }}>
              <T variant="caption" color="muted">
                Task brief
              </T>
              <Markdown text={model.details} />
            </View>
          )}
          {!!model.result && (
            <View style={[styles.replyBox, { backgroundColor: colors.canvas, borderColor: colors.line }]}>
              <Markdown text={model.result} />
            </View>
          )}
          {!!model.problem && (
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
              <CircleAlert size={14} color={colors.danger} strokeWidth={2.2} />
              <T variant="footnote" color="danger" style={{ flex: 1 }}>
                {model.problem}
              </T>
            </View>
          )}
        </View>
      )}
    </View>
  );
});

const TaskHandoffGroupCard = memo(function TaskHandoffGroupCard({
  group,
  bots,
  onOpenChat,
}: {
  group: TaskHandoffGroupModel;
  bots: Map<string, Bot>;
  onOpenChat?: (chatId: string) => void;
}) {
  const { colors } = useTheme();
  return (
    <View
      accessible={false}
      style={[
        styles.groupCard,
        {
          backgroundColor: colors.surface,
          borderColor: colors.line,
        },
      ]}
    >
      <View style={styles.groupHead}>
        {group.live && <PulseDot color={colors.accent} size={6} />}
        <T variant="footnote" color="muted" numberOfLines={1} style={{ flex: 1 }}>
          {group.header}
        </T>
      </View>
      {group.items.map((model) => (
        <TaskHandoffRow key={model.id} model={model} bots={bots} onOpenChat={onOpenChat} />
      ))}
    </View>
  );
});

/** Sender-side stack of quiet grouped agent cards for one turn on phone. */
export const AgentMessageRail = memo(function AgentMessageRail({
  run,
  bots,
  onOpenChat = openChatRoute,
}: {
  run: Pick<Run, "id" | "teamwork" | "taskHandoffs">;
  bots: Map<string, Bot>;
  onOpenChat?: (chatId: string) => void;
}) {
  const tasks = usePart("tasks");
  const asks = run.teamwork ?? [];
  const handoffs = run.taskHandoffs ?? [];
  const botList = useMemo(() => [...bots.values()], [bots]);
  const groupedAsks = useMemo(() => groupAsks(asks, botList), [asks, botList]);
  const handoffGroup = useMemo(() => buildTaskHandoffGroup(handoffs, { bots: botList, tasks }), [handoffs, botList, tasks]);
  if (!groupedAsks.length && !handoffGroup) return null;

  return (
    <View style={{ gap: space.sm }} accessibilityLabel="Agent messages">
      {groupedAsks.map((item) =>
        item.kind === "ask-group" ? (
          <AskGroupCard key={item.id} group={item} bots={bots} />
        ) : (
          <NodeCallGroupCard key={item.id} group={item} bots={bots} />
        ),
      )}
      {handoffGroup && <TaskHandoffGroupCard group={handoffGroup} bots={bots} onOpenChat={onOpenChat} />}
    </View>
  );
});

const styles = StyleSheet.create({
  groupCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    overflow: "hidden",
  },
  groupHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowName: {
    flexShrink: 0,
  },
  rowSummary: {
    flex: 1,
    minWidth: 0,
  },
  rowTrail: {
    marginLeft: 4,
    flexShrink: 0,
    alignItems: "flex-end",
    justifyContent: "center",
  },
  tabular: {
    fontVariant: ["tabular-nums"],
  },
  rowBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  replyBox: {
    padding: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  incomingCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 12,
    gap: 6,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  identity: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  linkButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingVertical: 2,
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingVertical: 2,
  },
});
