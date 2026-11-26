// Pieces the Work screens share: a row with its own trailing control, task words, run icons,
// bot chips and the native time and date pickers.
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { CircleAlert, CircleCheck, CircleSlash, Square } from "lucide-react-native";
import type { ReactNode } from "react";
import { ActivityIndicator, Platform, ScrollView, View } from "react-native";
import type { Bot, BotTask, TaskPriority, TaskStatus } from "@/link/types";
import type { RoutineEntry } from "@/state/hooks";
import { cadenceLabel, upcoming } from "@/state/time";
import { BotAvatar, Chip, space, T, Tap, tint, type Tone, useTheme } from "@/ui";
import { type NotifyTargetView, routineNotifyBadge } from "./notifyTargets";

/** A list row whose trailing control (a switch, a button) stays its own tap target for VoiceOver. */
export function SplitRow({ leading, title, subtitle, onPress, accessory, label, muted, hint }: { leading?: ReactNode; title: string; subtitle?: string; onPress: () => void; accessory?: ReactNode; label?: string; muted?: boolean; hint?: string }) {
  return (
    <View style={{ minHeight: 64, flexDirection: "row", alignItems: "center", paddingRight: space.lg }}>
      <Tap onPress={onPress} sink={1} feel="select" hitSlop={0} accessibilityLabel={label ?? (subtitle ? title + ", " + subtitle : title)} accessibilityHint={hint} style={{ flex: 1, minWidth: 0 }}>
        <View style={{ minHeight: 64, paddingLeft: space.lg, paddingRight: space.md, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }}>
          {leading}
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <T variant="callout" weight="500" color={muted ? "muted" : "ink"} numberOfLines={1}>
              {title}
            </T>
            {!!subtitle && (
              <T variant="footnote" color="muted" numberOfLines={2}>
                {subtitle}
              </T>
            )}
          </View>
        </View>
      </Tap>
      {!!accessory && <View style={{ alignSelf: "stretch", justifyContent: "center" }}>{accessory}</View>}
    </View>
  );
}

// Routines

/** A one-time routine that already ran. */
export const isFinished = (routine: RoutineEntry) => !!routine.entry.finishedAt || (routine.entry.cadence?.kind === "once" && routine.entry.nextAt == null);

/** "Weekdays at 8:30 AM · Tomorrow 8:30 AM", "… · Paused", "… · Done", plus non-default alert target summary. */
export function routineSubtitle(routine: RoutineEntry, view?: NotifyTargetView | null) {
  const when = routine.entry.cadence ? cadenceLabel(routine.entry.cadence) : routine.entry.cron ? "Custom schedule" : "Scheduled";
  const state = isFinished(routine) ? "Done" : routine.entry.enabled === false ? "Paused" : upcoming(routine.entry.nextAt);
  const alerts = routineNotifyBadge(routine.entry, view);
  return [when, state, alerts].filter(Boolean).join(" · ");
}

export const routineName = (routine: RoutineEntry) => routine.entry.name || routine.chat.title.replace(/^Routine · /, "") || "Routine";

// Tasks

export const STATUS_LABEL: Record<TaskStatus | "archived", string> = { later: "Later", ready: "Ready", working: "Working", review: "Needs review", blocked: "Blocked", done: "Done", archived: "Archived" };
export const STATUS_TONE: Record<TaskStatus | "archived", Tone> = { later: "neutral", ready: "info", working: "accent", review: "warning", blocked: "danger", done: "success", archived: "neutral" };
export const PRIORITY_LABEL: Record<TaskPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

/** "Quill · High", "Quill · Reviewing: Alfie", "No bot". */
export function taskSubtitle(task: BotTask, bot: Bot | undefined, reviewer?: Bot) {
  const who = task.botId ? (bot?.name ?? "A bot") : "No bot";
  const parts = [who];
  if (task.status === "review" && task.reviewerBotId) {
    parts.push("Reviewing: " + (reviewer?.name ?? "Creator"));
  }
  if (task.priority !== "normal") parts.push(PRIORITY_LABEL[task.priority] + " priority");
  return parts.join(" · ");
}

// Runs

/** A run's status as a 32-point icon: a spinner while it works. */
export function RunIcon({ status }: { status: string }) {
  const theme = useTheme();
  const { colors } = theme;
  const look =
    status === "Working"
      ? { color: colors.accent, icon: null }
      : status === "Completed"
        ? { color: colors.success, icon: CircleCheck }
        : status === "Needs you"
          ? { color: colors.warning, icon: CircleAlert }
          : status === "Stopped"
            ? { color: colors.muted, icon: Square }
            : { color: colors.muted, icon: CircleSlash };
  const Icon = look.icon;
  return (
    <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: tint(look.color, theme.dark ? 0.24 : 0.14), alignItems: "center", justifyContent: "center" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Icon ? <Icon size={18} color={look.color} strokeWidth={2.3} /> : <ActivityIndicator size="small" color={look.color} />}
    </View>
  );
}

// Bots

/** A row of bots as chips, scrolling sideways out to the screen's edges. */
export function BotChips({ bots, value, onChange, none, disabled }: { bots: Bot[]; value: string | null; onChange: (id: string | null) => void; none?: string; disabled?: boolean }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={{ marginHorizontal: -space.xl, opacity: disabled ? 0.5 : 1 }}
      contentContainerStyle={{ paddingHorizontal: space.xl, gap: space.sm }}
      pointerEvents={disabled ? "none" : "auto"}
    >
      {!!none && <Chip label={none} selected={value === null} onPress={() => onChange(null)} />}
      {bots.map((bot) => (
        <Chip key={bot.id} label={bot.name} selected={value === bot.id} onPress={() => onChange(bot.id)} leading={<BotAvatar bot={bot} size={24} badge={false} style={{ marginLeft: -8 }} />} />
      ))}
    </ScrollView>
  );
}

// Time and date. Times are 24-hour "HH:MM", dates "YYYY-MM-DD", both in the phone's own zone.

const pad = (value: number) => String(value).padStart(2, "0");
export const timeToDate = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 1, h || 0, m || 0);
};
export const dateToTime = (date: Date) => pad(date.getHours()) + ":" + pad(date.getMinutes());
export const dayToDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12);
};
export const dateToDay = (date: Date) => date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
export const dayLabel = (ymd: string) => dayFormat.format(dayToDate(ymd));

/**
 * The native picker under a row. On iOS it opens inline under the row that toggles it; on
 * Android the row opens the system dialog instead, so this draws nothing there.
 */
export function InlinePicker({ mode, value, onChange }: { mode: "time" | "date"; value: Date; onChange: (date: Date) => void }) {
  const theme = useTheme();
  if (Platform.OS !== "ios") return null;
  return (
    <View style={{ alignItems: "center", paddingHorizontal: space.sm, paddingBottom: space.sm }}>
      <DateTimePicker
        value={value}
        mode={mode}
        display={mode === "time" ? "spinner" : "inline"}
        minimumDate={mode === "date" ? new Date(new Date().setHours(0, 0, 0, 0)) : undefined}
        themeVariant={theme.dark ? "dark" : "light"}
        textColor={theme.colors.ink}
        accentColor={theme.colors.accent}
        onValueChange={(_event, date) => onChange(date)}
      />
    </View>
  );
}

/** Opens the system picker on Android. Returns false on iOS, where the row shows an inline one. */
export function openAndroidPicker(mode: "time" | "date", value: Date, onChange: (date: Date) => void) {
  if (Platform.OS !== "android") return false;
  DateTimePickerAndroid.open({ value, mode, minimumDate: mode === "date" ? new Date() : undefined, onValueChange: (_event, date) => onChange(date) });
  return true;
}
