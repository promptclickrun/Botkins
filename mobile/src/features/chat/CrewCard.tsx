// The crew card in the chat: the helpers and background commands a turn started (activityStory.ts
// `crewOf`). While the turn runs it sits where the first of them started; once it ended, under the
// turn's fold or receipt (turn.ts places it).
//
// Battery: it starts folded, one still row ("2 helpers · 1 command · 2 working" and each one's
// mark). The chat's item holds only that line and those marks, so the row is drawn again only when
// one of them changes, not on each step a helper takes. A tap opens it, per chat and turn: then it
// reads the run, and only then may a clock tick (the shared one, for a running member's time, while
// the chat is on show) and a running member's line shimmer.
import { router } from "expo-router";
import { ChevronDown, ChevronRight, Users } from "lucide-react-native";
import { memo, useMemo } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { create, createStore, type StoreApi, useStore } from "zustand";
import type { Run } from "@/link/types";
import { useCapability } from "@/state/hooks";
import { api } from "@/state/link";
import { showToast, useApp } from "@/state/store";
import { Button, T, Tap, useOnShow, useTheme } from "@/ui";
import { Shimmer } from "@/ui/Shimmer";
import { type CrewMember, crewOf, isLive } from "./activityStory";
import { StepMark, workWidth } from "./bits";
import { clockOffset } from "./crew";
import { commandSheet, helperSheet } from "./HelperRail";
import type { Item } from "./turn";
import { useElapsedClock } from "./useElapsedClock";

export const STOP_HELPER = "stop-helper-v1";
const RADIUS = 20;
const PAD = 12;
/** The marks a folded card shows at most; the rest are a count. */
const MARKS = 5;

const NO_ROWS = createStore<ReadonlySet<string>>(() => new Set());

/** The crew cards a person opened, by chat and turn. */
const useOpenCrews = create<Record<string, true>>(() => ({}));
function flip(key: string) {
  const open = useOpenCrews.getState();
  if (!open[key]) return useOpenCrews.setState({ [key]: true });
  const rest = { ...open };
  delete rest[key];
  useOpenCrews.setState(rest, true);
}

/** Asks first, then stops one helper or background command on the computer. */
export function confirmStop(chatId: string, id: string, name: string, kind: "helper" | "command", done?: () => void) {
  Alert.alert("Stop " + name + "?", kind === "helper" ? "It stops where it is. The bot keeps going." : "The process on your computer ends.", [
    { text: "Cancel", style: "cancel" },
    {
      text: kind === "helper" ? "Stop helper" : "Stop process",
      style: "destructive",
      onPress: () =>
        void api.stopHelper(chatId, id).then(
          () => done?.(),
          () => showToast("Couldn't stop it.", "error"),
        ),
    },
  ]);
}

/** The run a card or sheet is about: the turn under way, or a saved one. */
export const useRun = (chatId: string, runId: string): Run | undefined =>
  useApp((state) => (state.running[chatId]?.id === runId ? (state.running[chatId] ?? undefined) : state.chats[chatId]?.runs[runId]));

/** How long one has run: a running one's time ticks on the shared clock while `on`. */
export function Elapsed({ started, finished, on }: { started: number; finished?: number; on: boolean }) {
  const now = useElapsedClock(on && finished === undefined);
  return (
    <T variant="footnote" color="faint" numberOfLines={1} style={{ fontVariant: ["tabular-nums"] }}>
      {clockOffset((finished ?? now) - started)}
    </T>
  );
}

/** Which of the chat's rows are on screen (scroll.ts `createChatViewport().rows`). */
type Rows = StoreApi<ReadonlySet<string>>;

export const CrewCard = memo(function CrewCard({ chatId, item, rows }: { chatId: string; item: Extract<Item, { kind: "crew" }>; rows?: Rows }) {
  const { colors, dark } = useTheme();
  const key = chatId + ":" + item.runId;
  const open = useOpenCrews((state) => !!state[key]);
  const shown = item.marks.slice(0, MARKS);
  const more = item.marks.length - shown.length;
  return (
    <View style={workWidth}>
      <View
        style={{
          backgroundColor: colors.surface,
          borderRadius: RADIUS,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: colors.line,
          paddingHorizontal: PAD,
          ...(!dark && { shadowColor: colors.shadow, shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } }),
        }}
      >
        <Tap onPress={() => flip(key)} feel="select" hitSlop={0} accessibilityLabel={"Crew, " + item.line} accessibilityHint={open ? "Hides the helpers" : "Shows the helpers"} accessibilityState={{ expanded: open }}>
          <View style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Users size={16} color={colors.muted} strokeWidth={2.2} />
            <T variant="subhead" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
              {item.line}
            </T>
            <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ marginLeft: "auto", flexDirection: "row", alignItems: "center" }}>
              {shown.map((status, i) => (
                <StepMark key={i} status={status} size={13} />
              ))}
              {more > 0 && (
                <T variant="caption" color="faint">
                  {"+" + more}
                </T>
              )}
            </View>
            {open ? <ChevronDown size={16} color={colors.faint} strokeWidth={2.4} /> : <ChevronRight size={16} color={colors.faint} strokeWidth={2.4} />}
          </View>
        </Tap>
        {open && <CrewList chatId={chatId} runId={item.runId} turnLive={item.live} rowKey={item.key} rows={rows} />}
      </View>
    </View>
  );
});

/**
 * The open card: one row per helper and command. It reads the run, so it is drawn only while open.
 * A background command still running after the turn ended keeps Stop on its row; helpers are
 * stopped from their own sheet.
 */
function CrewList({ chatId, runId, turnLive, rowKey, rows }: { chatId: string; runId: string; turnLive: boolean; rowKey: string; rows?: Rows }) {
  const { colors } = useTheme();
  const run = useRun(chatId, runId);
  const crew = useMemo(() => (run ? crewOf(run) : null), [run]);
  // Its clocks and shimmer run only while the chat is on show and the card is on screen.
  const inView = useStore(rows ?? NO_ROWS, (seen) => !rows || seen.has(rowKey));
  const onShow = useOnShow() && inView;
  const canStop = useCapability(STOP_HELPER);
  if (!crew) return null;
  return (
    <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingBottom: 4 }}>
      {crew.members.map((member) => (
        <MemberRow key={member.id} chatId={chatId} runId={runId} member={member} onShow={onShow} stop={canStop && member.stoppable && member.kind === "command" && !turnLive} />
      ))}
    </View>
  );
}

/** What a member's row says under its name: what it is doing, or what it came back with. */
const lineOf = (member: CrewMember) => (isLive(member.status) ? member.doing : member.kind === "helper" ? member.done : member.doing);

const MemberRow = memo(function MemberRow({ chatId, runId, member, onShow, stop }: { chatId: string; runId: string; member: CrewMember; onShow: boolean; stop: boolean }) {
  const { colors } = useTheme();
  const live = isLive(member.status);
  const line = lineOf(member);
  const failed = member.status === "Failed";
  const open = () => router.push(member.kind === "helper" ? helperSheet(chatId, runId, member.id) : commandSheet(chatId, runId, member.id));
  const steps = member.kind === "helper" && member.steps ? (member.steps === 1 ? "1 step" : member.steps + " steps") : "";
  const words = (text: string, color: "muted" | "ink" | "danger") => (
    <T variant="footnote" color={color} numberOfLines={1}>
      {text}
    </T>
  );
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Tap onPress={open} feel="select" hitSlop={0} style={{ flex: 1 }} accessibilityLabel={member.name + ", " + member.status + (line ? ", " + line : "") + ", show " + (member.kind === "helper" ? "helper" : "output")}>
        <View style={{ minHeight: 52, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <StepMark status={member.status} size={14} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant={member.kind === "command" ? "mono" : "callout"} weight={member.kind === "command" ? undefined : "500"} numberOfLines={1}>
              {member.name}
            </T>
            {!!line &&
              (live ? (
                <Shimmer on={onShow} lit={words(line, "ink")}>
                  {words(line, "muted")}
                </Shimmer>
              ) : (
                words(line, failed ? "danger" : "muted")
              ))}
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Elapsed started={member.started} finished={member.finished} on={onShow && live} />
            {!!steps && (
              <T variant="caption" color="faint" numberOfLines={1}>
                {steps}
              </T>
            )}
          </View>
          <ChevronRight size={14} color={colors.faint} strokeWidth={2.4} />
        </View>
      </Tap>
      {stop && <Button title="Stop" variant="secondary" size="sm" onPress={() => confirmStop(chatId, member.id, member.name, member.kind)} accessibilityLabel={"Stop " + member.name} />}
    </View>
  );
});
