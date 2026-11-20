// The schedule picker a routine and a Today panel's routine share: Once (routines only), Daily,
// Weekdays, Weekly or Custom, the days, the time or date, and the computer's reading of it.
import { CalendarClock, CalendarDays, Clock } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import type { Cadence } from "@/link/types";
import { api } from "@/state/link";
import { clockLabel, upcoming } from "@/state/time";
import { Chip, Field, Group, IconTile, Label, Row, space, T, Tap, useTheme } from "@/ui";
import { dateToDay, dateToTime, dayLabel, dayToDate, InlinePicker, openAndroidPicker, timeToDate } from "./bits";

export type Kind = Cadence["kind"];
const KINDS: { value: Kind; label: string }[] = [
  { value: "once", label: "Once" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom" },
];
const DAYS = [
  { letter: "S", name: "Sunday" },
  { letter: "M", name: "Monday" },
  { letter: "T", name: "Tuesday" },
  { letter: "W", name: "Wednesday" },
  { letter: "T", name: "Thursday" },
  { letter: "F", name: "Friday" },
  { letter: "S", name: "Saturday" },
];
/** The phone's own time zone. */
export const phoneZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export type CadenceDraft = { kind: Kind; time: string; days: number[]; date: string; cron: string };

/** A draft for a cadence, or the default one: weekdays at 9. */
export function draftOfCadence(cadence: Cadence | undefined): CadenceDraft {
  const tomorrow = dateToDay(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const base: CadenceDraft = { kind: "weekdays", time: "09:00", days: [1], date: tomorrow, cron: "" };
  if (!cadence) return base;
  if (cadence.kind === "custom") return { ...base, kind: "custom", cron: cadence.cron };
  if (cadence.kind === "once") return { ...base, kind: "once", time: cadence.time, date: cadence.date };
  if (cadence.kind === "weekly") return { ...base, kind: "weekly", time: cadence.time, days: cadence.days };
  return { ...base, kind: cadence.kind, time: cadence.time };
}

export function cadenceOf(draft: CadenceDraft): Cadence {
  switch (draft.kind) {
    case "once":
      return { kind: "once", date: draft.date, time: draft.time };
    case "weekly":
      return { kind: "weekly", time: draft.time, days: [...draft.days].sort((a, b) => a - b) };
    case "custom":
      return { kind: "custom", cron: draft.cron.trim().replace(/\s+/g, " ") };
    default:
      return { kind: draft.kind, time: draft.time };
  }
}

export type Preview = { state: "idle" } | { state: "loading" } | { state: "ok"; nextAt: number | null; summary: string } | { state: "error"; message: string };

/** The computer's reading of a schedule in a time zone, asked again 300 ms after the last change. */
export function usePreview(cadence: Cadence, timezone: string): Preview {
  const key = JSON.stringify([cadence, timezone]);
  const local: Preview | null = cadence.kind === "custom" && !cadence.cron ? { state: "idle" } : cadence.kind === "weekly" && cadence.days.length === 0 ? { state: "error", message: "Pick at least one day." } : null;
  const [answer, setAnswer] = useState<{ key: string; preview: Preview } | null>(null);
  const ask = !local;
  useEffect(() => {
    if (!ask) return;
    let live = true;
    const timer = setTimeout(() => {
      const [asked, zone] = JSON.parse(key) as [Cadence, string];
      api.previewCadence(asked, zone || undefined).then(
        (result) => live && setAnswer({ key, preview: { state: "ok", nextAt: result.nextAt, summary: result.summary } }),
        (error: unknown) => live && setAnswer({ key, preview: { state: "error", message: error instanceof Error ? error.message : "That schedule doesn't work." } }),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, ask]);
  if (local) return local;
  if (!answer) return { state: "loading" };
  // While the next answer is on its way, a good last answer stays on screen.
  if (answer.key !== key) return answer.preview.state === "ok" ? answer.preview : { state: "loading" };
  return answer.preview;
}

/** Whether a schedule may be saved while its preview is what it is. */
export const scheduleOk = (preview: Preview, kind: Kind) => preview.state === "ok" || (preview.state === "loading" && kind !== "custom");

/** The kinds, the days, the time or date or cron, and the next run. `label` names the group ("Schedule", "Repeats"). */
export function CadenceFields({ draft, onChange, preview, allowOnce = true, label = "Schedule" }: { draft: CadenceDraft; onChange: (patch: Partial<CadenceDraft>) => void; preview: Preview; allowOnce?: boolean; label?: string }) {
  const { colors } = useTheme();
  const [picker, setPicker] = useState<"time" | "date" | null>(null);
  const pick = (mode: "time" | "date") => {
    const value = mode === "time" ? timeToDate(draft.time) : dayToDate(draft.date);
    const apply = (date: Date) => onChange(mode === "time" ? { time: dateToTime(date) } : { date: dateToDay(date) });
    if (!openAndroidPicker(mode, value, apply)) setPicker(picker === mode ? null : mode);
  };
  const hasTime = draft.kind !== "custom";
  return (
    <View style={{ gap: space.md }}>
      <Label style={{ marginBottom: 0 }}>{label}</Label>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ marginHorizontal: -space.xl }} contentContainerStyle={{ paddingHorizontal: space.xl, gap: space.sm }}>
        {KINDS.filter((kind) => allowOnce || kind.value !== "once").map((kind) => (
          <Chip
            key={kind.value}
            label={kind.label}
            selected={draft.kind === kind.value}
            onPress={() => {
              onChange({ kind: kind.value });
              setPicker(null);
            }}
          />
        ))}
      </ScrollView>

      {draft.kind === "weekly" && (
        <View style={{ flexDirection: "row", justifyContent: "space-between" }} accessibilityRole="radiogroup" accessibilityLabel="Days">
          {DAYS.map((day, index) => {
            const on = draft.days.includes(index);
            return (
              <Tap
                key={day.name}
                feel="select"
                sink={0.92}
                onPress={() => onChange({ days: on ? draft.days.filter((d) => d !== index) : [...draft.days, index] })}
                accessibilityRole="checkbox"
                accessibilityLabel={day.name}
                accessibilityState={{ checked: on }}
                style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: on ? colors.primary : colors.surface, borderWidth: 1, borderColor: on ? colors.primary : colors.line }}
              >
                <T variant="subhead" weight="700" color={on ? "onPrimary" : "ink2"}>
                  {day.letter}
                </T>
              </Tap>
            );
          })}
        </View>
      )}

      {draft.kind === "custom" ? (
        <Field
          mono
          placeholder="0 9 * * 1-5"
          value={draft.cron}
          onChangeText={(cron) => onChange({ cron })}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          keyboardType="numbers-and-punctuation"
          accessibilityLabel="Cron schedule"
          hint="Minute, hour, day, month, weekday"
        />
      ) : (
        <Group>
          {draft.kind === "once" && <Row key="date" leading={<IconTile icon={CalendarDays} color={colors.ink2} />} title="Date" value={dayLabel(draft.date)} onPress={() => pick("date")} />}
          {draft.kind === "once" && picker === "date" && <InlinePicker key="date-picker" mode="date" value={dayToDate(draft.date)} onChange={(date) => onChange({ date: dateToDay(date) })} />}
          {hasTime && <Row key="time" leading={<IconTile icon={Clock} color={colors.ink2} />} title="Time" value={clockLabel(draft.time)} onPress={() => pick("time")} />}
          {hasTime && picker === "time" && <InlinePicker key="time-picker" mode="time" value={timeToDate(draft.time)} onChange={(date) => onChange({ time: dateToTime(date) })} />}
        </Group>
      )}

      <NextRun preview={preview} />
    </View>
  );
}

function NextRun({ preview }: { preview: Preview }) {
  const { colors } = useTheme();
  if (preview.state === "idle") return null;
  const error = preview.state === "error";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs, minHeight: 24 }} accessibilityLiveRegion="polite">
      {preview.state === "loading" ? <ActivityIndicator size="small" color={colors.muted} /> : <CalendarClock size={16} color={error ? colors.danger : colors.muted} strokeWidth={2.2} />}
      {preview.state === "error" ? (
        <T variant="footnote" weight="600" color="danger" style={{ flex: 1 }}>
          {preview.message}
        </T>
      ) : preview.state === "ok" ? (
        <T variant="footnote" color="muted" style={{ flex: 1 }} numberOfLines={2}>
          <T variant="footnote" weight="700" color="ink2">
            {preview.nextAt ? "Next run " + upcoming(preview.nextAt) : "No upcoming run"}
          </T>
          {preview.summary ? "  ·  " + preview.summary : ""}
        </T>
      ) : (
        <T variant="footnote" color="muted">
          Checking…
        </T>
      )}
    </View>
  );
}
