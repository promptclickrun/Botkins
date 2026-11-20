import { MenuView } from "@react-native-menu/menu";
import { router, useLocalSearchParams } from "expo-router";
import { Bell, MessageCircle, Play, Send, Trash2 } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { type RoutineEntry, useBots, usePart, useRoutines } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { EmptyState, Field, Group, IconTile, Label, Loading, Row, Sheet, space, T, useTheme } from "@/ui";
import { BotChips, routineName } from "./bits";
import { type CadenceDraft, CadenceFields, cadenceOf, draftOfCadence, phoneZone, scheduleOk, usePreview } from "./Cadence";
import { canNotify, DELIVERY, deliveryToSave, firstPlace, notifyLine, type Place, placeOf, placesFor } from "./delivery";

const zone = phoneZone;

type Draft = CadenceDraft & { botId: string | null; name: string; prompt: string; place: Place; notify: boolean };

function draftOf(routine: RoutineEntry | undefined, botId: string | null, capabilities: string[] | undefined): Draft {
  const base: Draft = { ...draftOfCadence(undefined), botId, name: "", prompt: "", place: firstPlace(undefined, true, capabilities), notify: true };
  if (!routine) return base;
  const { entry } = routine;
  const place = firstPlace(entry.deliver, false, capabilities);
  return { ...base, ...draftOfCadence(entry.cadence ?? { kind: "custom", cron: entry.cron ?? "" }), botId: routine.chat.botId, name: routineName(routine), prompt: entry.prompt, place, notify: entry.notify !== false };
}

export default function RoutineEditor() {
  const { id, botId } = useLocalSearchParams<{ id: string; botId?: string }>();
  const routines = useRoutines();
  const synced = useApp((state) => state.synced);
  const isNew = id === "new";
  const routine = routines.find((item) => item.id === id);
  if (!isNew && !routine)
    return <Sheet title="Routine">{synced ? <EmptyState title="This routine is gone" action="Close" onAction={() => router.back()} /> : <Loading />}</Sheet>;
  return <Editor key={routine?.id ?? "new"} routine={routine} botId={botId ?? null} />;
}

function Editor({ routine, botId }: { routine?: RoutineEntry; botId: string | null }) {
  const { colors } = useTheme();
  const bots = useBots();
  const shownBots = useMemo(() => bots.filter((bot) => !bot.hidden), [bots]);
  const capabilities = usePart("meta")?.capabilities;
  const [draft, setDraft] = useState<Draft>(() => draftOf(routine, botId ?? (shownBots.length === 1 ? shownBots[0].id : null), capabilities));
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft((last) => ({ ...last, ...patch }));
  // An older computer keeps every result in the routine's own chat.
  const canDeliver = !!capabilities?.includes(DELIVERY);
  // "No output" is offered only where the computer takes it; a routine that has it keeps it.
  const places = placesFor(capabilities, routine?.entry.deliver?.to);
  const botName = bots.find((bot) => bot.id === draft.botId)?.name;
  const placeLabel = (place: Place) => (place === "chat" && botName ? "Chat with " + botName : placeOf(place).label);

  const cadence = cadenceOf(draft);
  const preview = usePreview(cadence, zone());
  const ready = !!draft.botId && !!draft.name.trim() && !!draft.prompt.trim() && scheduleOk(preview, draft.kind);

  const save = async () => {
    if (!ready || !draft.botId) return;
    setSaving(true);
    const fields = { name: draft.name.trim(), prompt: draft.prompt.trim(), cadence, timezone: zone(), ...(canDeliver && { deliver: deliveryToSave(draft.place, routine?.entry.deliver), notify: canNotify(draft.place) && draft.notify }) };
    const ok = routine ? await attempt(api.updateRoutine(routine.id, fields).then(() => true), "Saved") : await attempt(api.createRoutine({ botId: draft.botId, ...fields }), "Routine created");
    setSaving(false);
    if (ok) router.back();
  };

  const remove = () => {
    if (!routine) return;
    Alert.alert("Delete " + routineName(routine) + "?", "Its chat and past runs are deleted too.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          router.back();
          void attempt(api.deleteRoutine(routine.id), "Routine deleted");
        },
      },
    ]);
  };
  const openChat = () => {
    if (!routine) return;
    router.back();
    router.push({ pathname: "/chat/[id]", params: { id: routine.id } });
  };

  return (
    <Sheet title={routine ? "Routine" : "New routine"} action={routine ? "Save" : "Create"} onAction={() => void save()} actionDisabled={!ready} actionLoading={saving}>
      {!routine && (
        <View>
          <Label>Bot</Label>
          {shownBots.length ? (
            <BotChips bots={shownBots} value={draft.botId} onChange={(next) => set({ botId: next })} />
          ) : (
            <T variant="subhead" color="muted">
              Make a bot first.
            </T>
          )}
        </View>
      )}

      <View style={{ gap: space.lg }}>
        <Field label="Name" placeholder="Morning brief" value={draft.name} onChangeText={(name) => set({ name })} returnKeyType="next" maxLength={80} autoFocus={!routine} />
        <Field label="Instructions" placeholder="What to do each time it runs" value={draft.prompt} onChangeText={(prompt) => set({ prompt })} area />
      </View>

      <CadenceFields draft={draft} onChange={set} preview={preview} />

      {canDeliver && (
        <View>
          <Label>Send result to</Label>
          <Group>
            <MenuView
              actions={places.map((place) => ({ id: place.value, title: placeLabel(place.value), subtitle: place.hint, image: place.image, state: draft.place === place.value ? ("on" as const) : ("off" as const) }))}
              onPressAction={({ nativeEvent }) => set({ place: nativeEvent.event as Place })}
            >
              <Row leading={<IconTile icon={Send} color={colors.ink2} />} title={placeLabel(draft.place)} subtitle={placeOf(draft.place).hint} chevron />
            </MenuView>
            <Row key="notify" leading={<IconTile icon={Bell} color={colors.ink2} />} title="Notify me" subtitle={notifyLine(draft.place, draft.notify)} subtitleLines={2} toggled={canNotify(draft.place) && draft.notify} disabled={!canNotify(draft.place)} onToggle={(notify) => set({ notify })} />
          </Group>
        </View>
      )}

      {routine && (
        <Group>
          <Row leading={<IconTile icon={Play} />} title="Run now" onPress={() => void attempt(api.runRoutine(routine.id), "Running now")} />
          <Row leading={<IconTile icon={MessageCircle} color={colors.info} />} title="Open chat" chevron onPress={openChat} />
          <Row leading={<IconTile icon={Trash2} color={colors.danger} />} title="Delete routine" tone="danger" onPress={remove} />
        </Group>
      )}
    </Sheet>
  );
}
