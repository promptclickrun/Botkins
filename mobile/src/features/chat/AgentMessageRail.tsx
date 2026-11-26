// T3 Code-style vertical accent rail cards for bot-to-bot messages on phone (incoming, outgoing, task handoff).
import { ArrowRight, ArrowUpRight, Bot as BotIcon, ChevronDown, ChevronRight, CircleAlert, ClipboardList, Globe } from "lucide-react-native";
import { memo, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { Bot, BotTask, Message, Run, TaskHandoff, TeamAsk } from "@/link/types";
import { useChats, usePart } from "@/state/hooks";
import { BotAvatar, Markdown, radius, space, T, Tap, useTheme } from "@/ui";
import {
  buildIncomingRail,
  buildOutgoingRail,
  buildTaskHandoffRail,
  foldPreview,
  type AgentRailStatus,
  type AgentRailTone,
} from "./agentRailModel";
import { openChat as openChatRoute } from "./navigate";
import { spentTime } from "./fold";
import { useElapsedClock } from "./useElapsedClock";

function clock(time?: number): string {
  if (!time) return "";
  try {
    return new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function railAccent(
  colors: ReturnType<typeof useTheme>["colors"],
  via: "teamwork" | "task" | "remote",
  status?: AgentRailStatus,
): string {
  if (status === "answered" || status === "done" || status === "review") return colors.success;
  if (status === "failed") return colors.danger;
  if (status === "blocked") return colors.warning;
  if (via === "task") return colors.warning;
  if (via === "remote") return colors.accentText;
  return colors.info;
}

function toneColors(colors: ReturnType<typeof useTheme>["colors"], tone: AgentRailTone): { bg: string; fg: string } {
  switch (tone) {
    case "accent":
      return { bg: colors.infoSoft, fg: colors.info };
    case "success":
      return { bg: colors.successSoft, fg: colors.success };
    case "warning":
      return { bg: colors.warningSoft, fg: colors.warning };
    case "danger":
      return { bg: colors.dangerSoft, fg: colors.danger };
    default:
      return { bg: colors.sunken, fg: colors.muted };
  }
}

function RailFace({ bot, remote, size = 20 }: { bot?: Bot; remote?: boolean; size?: number }) {
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

function StatusPill({ label, tone, live }: { label: string; tone: AgentRailTone; live?: boolean }) {
  const { colors } = useTheme();
  const palette = toneColors(colors, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: radius.pill,
        backgroundColor: palette.bg,
        maxWidth: "100%",
      }}
    >
      {live && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: palette.fg }} />}
      <T variant="caption" numberOfLines={1} style={{ color: palette.fg, fontSize: 11, lineHeight: 15 }}>
        {label}
      </T>
    </View>
  );
}

/**
 * Recipient-side card on phone: renders an incoming bot-to-bot message (task handoff, remote dispatch,
 * or teamwork) with a vertical left accent rail, sender identity, collapsible body, and source chat link.
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
  const accent = railAccent(colors, model.via);
  const stamp = clock(model.time);

  return (
    <View
      accessible={false}
      accessibilityLabel={model.ariaLabel}
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.line,
          borderLeftColor: accent,
        },
      ]}
    >
      <View style={styles.head} accessible accessibilityLabel={model.ariaLabel}>
        <RailFace bot={senderBot} remote={model.via === "remote"} />
        <View style={styles.identity}>
          <T variant="footnote" color="muted" numberOfLines={1}>
            from{" "}
            <T variant="footnote" weight="700" color="ink">
              {model.senderName}
            </T>
          </T>
          <View style={[styles.viaChip, { backgroundColor: colors.sunken }]}>
            {model.via === "task" && <ClipboardList size={11} color={colors.muted} strokeWidth={2.2} />}
            {model.via === "remote" && <Globe size={11} color={colors.muted} strokeWidth={2.2} />}
            <T variant="caption" color="muted" style={{ fontSize: 11, lineHeight: 15 }}>
              {model.viaLabel}
            </T>
          </View>
          {!!stamp && (
            <T variant="caption" color="faint" style={{ fontSize: 11, lineHeight: 15 }}>
              {stamp}
            </T>
          )}
        </View>
        {!!model.sourceChatId && (
          <Tap
            onPress={() => onOpenChat(model.sourceChatId!)}
            feel="select"
            accessibilityLabel={"Open chat with " + model.senderName}
            style={[styles.linkButton, { backgroundColor: colors.canvas, borderColor: colors.line }]}
          >
            <T variant="caption" color="ink2" style={{ fontSize: 11, lineHeight: 15 }}>
              Source chat
            </T>
            <ArrowUpRight size={12} color={colors.ink2} strokeWidth={2.2} />
          </Tap>
        )}
      </View>

      {!!model.taskTitle && (
        <T variant="subhead" weight="700" color="ink">
          {model.taskTitle}
        </T>
      )}

      {model.collapsible && !expanded ? (
        <T variant="subhead" color="ink2" numberOfLines={2}>
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
            <ChevronDown size={14} color={colors.muted} strokeWidth={2.2} />
          ) : (
            <ChevronRight size={14} color={colors.muted} strokeWidth={2.2} />
          )}
          <T variant="caption" color="muted">
            {expanded ? "Show less" : "Show full message"}
          </T>
        </Tap>
      )}
    </View>
  );
});

const OutgoingAskCard = memo(function OutgoingAskCard({ ask, bots }: { ask: TeamAsk; bots: Map<string, Bot> }) {
  const { colors } = useTheme();
  const [replyOpen, setReplyOpen] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);

  const botList = useMemo(() => [...bots.values()], [bots]);
  const model = useMemo(() => buildOutgoingRail(ask, botList), [ask, botList]);
  const now = useElapsedClock(model.live);
  const targetBot = ask.remote ? undefined : bots.get(ask.botId);
  const accent = railAccent(colors, model.via, model.status);
  const msgFold = useMemo(() => foldPreview(model.message), [model.message]);
  const took = model.durationMs ?? (model.live ? Math.max(0, now - ask.started) : undefined);
  const hasReplyOrError = !!(model.reply || model.error);
  const snippet = (model.error ?? model.reply ?? "").replace(/\s+/g, " ").trim();

  return (
    <View
      accessible={false}
      accessibilityLabel={model.ariaLabel}
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.line,
          borderLeftColor: accent,
        },
      ]}
    >
      <View style={styles.head} accessible accessibilityLabel={model.ariaLabel}>
        <RailFace bot={targetBot} remote={model.via === "remote"} />
        <View style={styles.identity}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}>
            <ArrowRight size={12} color={colors.muted} strokeWidth={2.2} />
            <T variant="footnote" color="muted" numberOfLines={1}>
              to{" "}
              <T variant="footnote" weight="700" color="ink">
                {model.targetName}
              </T>
              {model.hostLabel ? " on " + model.hostLabel : ""}
            </T>
          </View>
          <StatusPill label={model.statusLabel} tone={model.statusTone} live={model.live} />
          {took !== undefined && took > 0 && (
            <T variant="caption" color="faint" style={{ fontSize: 11, lineHeight: 15 }}>
              {spentTime(took)}
            </T>
          )}
        </View>
      </View>

      {msgFold.collapsible && !messageOpen ? (
        <T variant="subhead" color="ink2" numberOfLines={2}>
          {msgFold.preview}
        </T>
      ) : (
        <T variant="subhead" color="ink2">
          {model.message}
        </T>
      )}

      {!!model.expecting && (
        <T variant="caption" color="muted">
          Needs: {model.expecting}
        </T>
      )}

      {msgFold.collapsible && (
        <Tap
          onPress={() => setMessageOpen((v) => !v)}
          feel="select"
          accessibilityRole="button"
          accessibilityState={{ expanded: messageOpen }}
          accessibilityLabel={messageOpen ? "Hide full request" : "Show full request"}
          style={styles.toggle}
        >
          {messageOpen ? (
            <ChevronDown size={13} color={colors.muted} strokeWidth={2.2} />
          ) : (
            <ChevronRight size={13} color={colors.muted} strokeWidth={2.2} />
          )}
          <T variant="caption" color="muted">
            {messageOpen ? "Hide full request" : "Show full request"}
          </T>
        </Tap>
      )}

      {hasReplyOrError && (
        <View style={[styles.replyWrap, { borderTopColor: colors.line }]}>
          <Tap
            onPress={() => setReplyOpen((v) => !v)}
            feel="select"
            accessibilityRole="button"
            accessibilityState={{ expanded: replyOpen }}
            accessibilityLabel={(model.error ? "Error" : "Reply from " + model.targetName) + (replyOpen ? ", collapse" : ", expand")}
            style={styles.replyToggle}
          >
            {replyOpen ? (
              <ChevronDown size={14} color={colors.muted} strokeWidth={2.2} />
            ) : (
              <ChevronRight size={14} color={colors.muted} strokeWidth={2.2} />
            )}
            <T variant="footnote" weight="600" color="ink2">
              {model.error ? "Error" : "Reply from " + model.targetName}
            </T>
            {!replyOpen && !!snippet && (
              <T variant="caption" color="muted" numberOfLines={1} style={{ flex: 1 }}>
                {snippet}
              </T>
            )}
          </Tap>
          {replyOpen && (
            <View style={[styles.replyBody, { backgroundColor: colors.canvas, borderColor: colors.line }]}>
              {model.reply ? (
                <Markdown text={model.reply} />
              ) : (
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
                  <CircleAlert size={14} color={colors.danger} strokeWidth={2.2} />
                  <T variant="footnote" color="danger" style={{ flex: 1 }}>
                    {model.error}
                  </T>
                </View>
              )}
              {model.stepCount > 0 && (
                <T variant="caption" color="muted" style={{ marginTop: space.xs }}>
                  {model.stepCount === 1 ? "1 tool step" : model.stepCount + " tool steps"}
                </T>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
});

const TaskHandoffCard = memo(function TaskHandoffCard({
  handoff,
  bots,
  tasks,
  onOpenChat = openChatRoute,
}: {
  handoff: TaskHandoff;
  bots: Map<string, Bot>;
  tasks?: BotTask[];
  onOpenChat?: (chatId: string) => void;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);

  const botList = useMemo(() => [...bots.values()], [bots]);
  const model = useMemo(() => buildTaskHandoffRail(handoff, { bots: botList, tasks }), [handoff, botList, tasks]);
  const targetBot = bots.get(model.targetBotId);
  const accent = railAccent(colors, "task", model.status);
  const hasExpandable = !!(model.details || model.result || model.problem);
  const snippet = (model.problem ?? model.result ?? model.details ?? "").replace(/\s+/g, " ").trim();

  return (
    <View
      accessible={false}
      accessibilityLabel={model.ariaLabel}
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.line,
          borderLeftColor: accent,
        },
      ]}
    >
      <View style={styles.head} accessible accessibilityLabel={model.ariaLabel}>
        <RailFace bot={targetBot} />
        <View style={styles.identity}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}>
            <ClipboardList size={12} color={colors.muted} strokeWidth={2.2} />
            <T variant="footnote" color="muted" numberOfLines={1}>
              task for{" "}
              <T variant="footnote" weight="700" color="ink">
                {model.targetName}
              </T>
            </T>
          </View>
          <StatusPill label={model.statusLabel} tone={model.statusTone} live={model.live} />
        </View>
        {!!model.taskChatId && (
          <Tap
            onPress={() => onOpenChat(model.taskChatId!)}
            feel="select"
            accessibilityLabel={"Open task chat: " + model.title}
            style={[styles.linkButton, { backgroundColor: colors.canvas, borderColor: colors.line }]}
          >
            <T variant="caption" color="ink2" style={{ fontSize: 11, lineHeight: 15 }}>
              Open task
            </T>
            <ArrowUpRight size={12} color={colors.ink2} strokeWidth={2.2} />
          </Tap>
        )}
      </View>

      <T variant="subhead" weight="700" color="ink">
        {model.title}
      </T>

      {hasExpandable && (
        <View style={[styles.replyWrap, { borderTopColor: colors.line }]}>
          <Tap
            onPress={() => setExpanded((v) => !v)}
            feel="select"
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={(model.problem ? "Blocked reason" : model.result ? "Result" : "Details") + (expanded ? ", collapse" : ", expand")}
            style={styles.replyToggle}
          >
            {expanded ? (
              <ChevronDown size={14} color={colors.muted} strokeWidth={2.2} />
            ) : (
              <ChevronRight size={14} color={colors.muted} strokeWidth={2.2} />
            )}
            <T variant="footnote" weight="600" color="ink2">
              {model.problem ? "Blocked reason" : model.result ? "Result" : "Details"}
            </T>
            {!expanded && !!snippet && (
              <T variant="caption" color="muted" numberOfLines={1} style={{ flex: 1 }}>
                {snippet}
              </T>
            )}
          </Tap>
          {expanded && (
            <View style={[styles.replyBody, { backgroundColor: colors.canvas, borderColor: colors.line, gap: space.sm }]}>
              {!!model.details && (
                <View style={{ gap: 2 }}>
                  <T variant="label" color="muted" style={{ fontSize: 10 }}>
                    TASK BRIEF
                  </T>
                  <Markdown text={model.details} />
                </View>
              )}
              {!!model.result && (
                <View style={{ gap: 2 }}>
                  <T variant="label" color="muted" style={{ fontSize: 10 }}>
                    RESULT FROM {model.targetName.toUpperCase()}
                  </T>
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
      )}
    </View>
  );
});

/** Sender-side stack of agent-message rail cards for one turn on phone. */
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
  if (!asks.length && !handoffs.length) return null;

  return (
    <View style={{ gap: space.sm }} accessibilityLabel="Agent messages">
      {asks.map((ask) => (
        <OutgoingAskCard key={ask.id} ask={ask} bots={bots} />
      ))}
      {handoffs.map((handoff) => (
        <TaskHandoffCard key={handoff.id} handoff={handoff} bots={bots} tasks={tasks} onOpenChat={onOpenChat} />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    borderTopLeftRadius: 6,
    borderBottomLeftRadius: 6,
    borderTopRightRadius: radius.md,
    borderBottomRightRadius: radius.md,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 12,
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
    flexWrap: "wrap",
    gap: 6,
  },
  viaChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  linkButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingVertical: 2,
  },
  replyWrap: {
    marginTop: 2,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  replyToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 2,
  },
  replyBody: {
    marginTop: 6,
    padding: 10,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
