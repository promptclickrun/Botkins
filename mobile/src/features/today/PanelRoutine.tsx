// A Today panel's own routine: when it refreshes itself, in which time zone, and with what
// instructions (the computer's Today › Manage › "Set a routine", its RoutineForm in src/Today.tsx).
import { router, useLocalSearchParams } from "expo-router";
import { Pause, Play, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import type { Panel } from "@/link/types";
import { useCan, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { EmptyState, Field, Group, IconTile, Loading, Row, Sheet, space, T, useTheme } from "@/ui";
import { type CadenceDraft, CadenceFields, cadenceOf, draftOfCadence, phoneZone, scheduleOk, usePreview } from "@/features/work/Cadence";
import { cadenceFromCron, cronFromCadence } from "@/features/work/cron";

const DEFAULT_CRON = "0 9 * * 1-5";
const DEFAULT_PROMPT = "Refresh this panel from its original sources.";

/** Whether a name is a time zone this phone knows. An unknown one is left to the computer to judge. */
function knownZone(zone: string) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export default function PanelRoutine() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const panel = usePart("panels")?.find((item) => item.id === id);
  const synced = useApp((state) => state.synced);
  const canManage = useCan("today", "manage");
  if (!canManage) return <Sheet title="Panel routine"><EmptyState title="Your team role can't manage panel routines" /></Sheet>;
  if (!panel) return <Sheet title="Panel routine">{synced ? <EmptyState title="This panel is gone" action="Close" onAction={() => router.back()} /> : <Loading />}</Sheet>;
  return <Form key={panel.id} panel={panel} />;
}

function Form({ panel }: { panel: Panel }) {
  const { colors } = useTheme();
  const routine = panel.routine;
  const [draft, setDraft] = useState<CadenceDraft>(() => {
    const cadence = cadenceFromCron(routine?.cron || DEFAULT_CRON);
    return draftOfCadence(cadence);
  });
  const [zone, setZone] = useState(routine?.timezone || phoneZone());
  const [prompt, setPrompt] = useState(routine?.prompt || DEFAULT_PROMPT);
  const [saving, setSaving] = useState(false);
  const canDelete = useCan("today", "delete");
  const set = (patch: Partial<CadenceDraft>) => setDraft((last) => ({ ...last, ...patch }));

  const cadence = cadenceOf(draft);
  const cleanZone = zone.trim();
  const zoneOk = !!cleanZone && knownZone(cleanZone);
  const preview = usePreview(cadence, zoneOk ? cleanZone : phoneZone());
  const ready = zoneOk && !!prompt.trim() && scheduleOk(preview, draft.kind);

  const save = async () => {
    if (!ready) return;
    setSaving(true);
    const ok = await attempt(api.routine(panel.id, { action: "set", cron: cronFromCadence(cadence), timezone: cleanZone, prompt: prompt.trim() }).then(() => true), "Routine saved");
    setSaving(false);
    if (ok) router.back();
  };
  const act = (action: "pause" | "resume" | "remove", done: string) => {
    if (action === "remove") router.back();
    void attempt(api.routine(panel.id, { action }), done);
  };

  return (
    <Sheet title="Panel routine" action="Save" onAction={() => void save()} actionDisabled={!ready} actionLoading={saving}>
      <T variant="subhead" color="muted" numberOfLines={2} style={{ marginTop: -space.sm }}>
        {panel.title}
      </T>
      <CadenceFields draft={draft} onChange={set} preview={preview} allowOnce={false} label="Repeats" />
      <View style={{ gap: space.lg }}>
        <Field
          label="Time zone"
          value={zone}
          onChangeText={setZone}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          error={cleanZone && !zoneOk ? "Not a time zone this phone knows" : undefined}
          hint={cleanZone !== phoneZone() ? "This phone: " + phoneZone() : undefined}
        />
        <Field label="Refresh instructions" value={prompt} onChangeText={setPrompt} area maxLength={4000} hint="Each refresh uses one model turn." />
      </View>
      {routine && (
        <Group>
          {routine.enabled ? (
            <Row leading={<IconTile icon={Pause} color={colors.ink2} />} title="Pause routine" onPress={() => act("pause", "Routine paused")} />
          ) : (
            <Row leading={<IconTile icon={Play} />} title="Resume routine" onPress={() => act("resume", "Routine resumed")} />
          )}
          {canDelete && <Row leading={<IconTile icon={Trash2} color={colors.danger} />} title="Remove routine" tone="danger" onPress={() => act("remove", "Routine removed")} />}
        </Group>
      )}
    </Sheet>
  );
}
