import { MenuView } from "@react-native-menu/menu";
import { router, useLocalSearchParams } from "expo-router";
import { Bell, CornerDownRight, MessageCircle, Play, Send, Trash2 } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Alert, View } from "react-native";
import type { ModelChoice } from "@/link/types";
import { defaultProviderOf, describeChoice } from "@/features/models/shared";
import { type RoutineEntry, useBots, useCan, useMember, useModels, usePart, useProviders, useRoutines, useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { routineDefault } from "@/state/models";
import { useApp } from "@/state/store";
import { EmptyState, Field, Group, IconTile, Label, Loading, ProviderIcon, Row, Segmented, Sheet, space, T, useTheme } from "@/ui";
import { holdRoutineModel } from "./routineModel";
import { BotChips, routineName } from "./bits";
import { type CadenceDraft, CadenceFields, cadenceOf, draftOfCadence, phoneZone, scheduleOk, usePreview } from "./Cadence";
import { canNotify, DELIVERY, deliveryToSave, firstPlace, notifyLine, type Place, placeOf, placesFor } from "./delivery";

const zone = phoneZone;

/**
 * `runs`: the instructions as a bot's turn, or a script on the computer with no model
 * ("routine-scripts-v1"), with a follow-up action that has the instructions. `model` is the
 * routine's own ("routine-models-v1"); null uses the Default routines model.
 */
type Draft = CadenceDraft & {
  botId: string | null;
  name: string;
  prompt: string;
  place: Place;
  notify: boolean;
  runs: "instructions" | "script";
  script: string;
  followUp: boolean;
  model: ModelChoice | null;
};

function draftOf(routine: RoutineEntry | undefined, botId: string | null, capabilities: string[] | undefined): Draft {
  const base: Draft = { ...draftOfCadence(undefined), botId, name: "", prompt: "", place: firstPlace(undefined, true, capabilities), notify: true, runs: "instructions", script: "", followUp: false, model: null };
  if (!routine) return base;
  const { entry } = routine;
  const place = firstPlace(entry.deliver, false, capabilities);
  return {
    ...base,
    ...draftOfCadence(entry.cadence ?? { kind: "custom", cron: entry.cron ?? "" }),
    botId: routine.chat.botId,
    name: routineName(routine),
    prompt: entry.prompt,
    place,
    notify: entry.notify !== false,
    runs: entry.script ? "script" : "instructions",
    script: entry.script ?? "",
    followUp: entry.followUp === true,
    model: routine.chat.model ?? null,
  };
}

export default function RoutineEditor() {
  const { id, botId } = useLocalSearchParams<{ id: string; botId?: string }>();
  const routines = useRoutines();
  const synced = useApp((state) => state.synced);
  const isNew = id === "new";
  const canCreate = useCan("today", "create");
  const canManage = useCan("today", "manage");
  const routine = routines.find((item) => item.id === id);
  if (isNew ? !canCreate : !canManage) return <Sheet title="Routine"><EmptyState title="Your team role can't edit routines" /></Sheet>;
  if (!isNew && !routine)
    return <Sheet title="Routine">{synced ? <EmptyState title="This routine is gone" action="Close" onAction={() => router.back()} /> : <Loading />}</Sheet>;
  return <Editor key={routine?.id ?? "new"} routine={routine} botId={botId ?? null} />;
}

function Editor({ routine, botId }: { routine?: RoutineEntry; botId: string | null }) {
  const { colors } = useTheme();
  const bots = useBots();
  const shownBots = useMemo(() => bots.filter((bot) => !bot.hidden), [bots]);
  const capabilities = usePart("meta")?.capabilities;
  const canUse = useCan("today", "use");
  const canDelete = useCan("today", "delete");
  const [draft, setDraft] = useState<Draft>(() => draftOf(routine, botId ?? (shownBots.length === 1 ? shownBots[0].id : null), capabilities));
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft((last) => ({ ...last, ...patch }));
  // An older computer keeps every result in the routine's own chat.
  const canDeliver = !!capabilities?.includes(DELIVERY);
  // "No output" is offered only where the computer takes it; a routine that has it keeps it.
  const places = placesFor(capabilities, routine?.entry.deliver?.to);
  const botName = bots.find((bot) => bot.id === draft.botId)?.name;
  const placeLabel = (place: Place) => (place === "chat" && botName ? "Chat with " + botName : placeOf(place).label);
  // Scripts run on the computer, so only its owner writes one; an older computer has neither scripts nor routine models.
  const member = useMember();
  const scriptsAllowed = !!capabilities?.includes("routine-scripts-v1") && !member;
  const modelsAllowed = !!capabilities?.includes("routine-models-v1");
  const scripted = draft.runs === "script";
  const needsPrompt = !scripted || draft.followUp;
  const bot = bots.find((item) => item.id === draft.botId);
  const settings = useSettings();
  const models = useModels();
  const defaultProvider = defaultProviderOf(useProviders());
  const shownModel = describeChoice(draft.model ?? routineDefault(settings, bot), models, defaultProvider);
  const pickModel = () => {
    holdRoutineModel(draft.model, (model) => set({ model }));
    router.push({ pathname: "/chat/model", params: { scope: "routine", id: draft.botId ?? "" } });
  };

  const cadence = cadenceOf(draft);
  const preview = usePreview(cadence, zone());
  const ready = !!draft.botId && !!draft.name.trim() && (!needsPrompt || !!draft.prompt.trim()) && (!scripted || !!draft.script.trim()) && scheduleOk(preview, draft.kind);

  const save = async () => {
    if (!ready || !draft.botId) return;
    setSaving(true);
    // The model is sent only when it changed, so an edit never waits on the model list for nothing.
    const modelChanged = JSON.stringify(draft.model) !== JSON.stringify(routine?.chat.model ?? null);
    const fields = {
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      cadence,
      timezone: zone(),
      ...(canDeliver && { deliver: deliveryToSave(draft.place, routine?.entry.deliver), notify: canNotify(draft.place) && draft.notify }),
      ...(scripted ? { script: draft.script, followUp: draft.followUp } : routine?.entry.script ? { script: null } : {}),
      ...(modelsAllowed && modelChanged && { model: draft.model }),
    };
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
        {(scriptsAllowed || scripted) && (
          <View style={{ gap: 6 }}>
            <T variant="label" color="muted" style={{ paddingHorizontal: space.xs }}>
              What runs
            </T>
            <Segmented
              options={[
                { value: "instructions", label: "Instructions" },
                { value: "script", label: "Script" },
              ]}
              value={draft.runs}
              onChange={(runs) => set({ runs })}
            />
            <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
              {scripted ? "A script runs on your computer with no model. Turn on a follow-up action to have " + (botName ?? "the bot") + " act on its output." : (botName ?? "The bot") + " follows your instructions in a model turn."}
            </T>
          </View>
        )}
        {scripted && (
          <>
            <Field
              label="Script"
              placeholder="df -h /"
              value={draft.script}
              onChangeText={(script) => set({ script })}
              area
              mono
              maxLength={20000}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              hint={"Runs with your shell in " + (botName ? botName + "'s" : "the bot's") + " folder on your computer. Stops after 10 minutes. The output is kept with the run."}
            />
            <Group>
              <Row
                leading={<IconTile icon={CornerDownRight} color={colors.ink2} />}
                title="Follow-up action"
                subtitle={(botName ?? "The bot") + " reads the output and exit code, then follows your instructions"}
                subtitleLines={2}
                toggled={draft.followUp}
                onToggle={(followUp) => set({ followUp })}
              />
            </Group>
          </>
        )}
        {needsPrompt && <Field label="Instructions" placeholder={scripted ? "What to do with the script's output" : "What to do each time it runs"} value={draft.prompt} onChangeText={(prompt) => set({ prompt })} area />}
        {needsPrompt && modelsAllowed && (
          <View>
            <Label>Model</Label>
            <Group>
              <Row
                leading={<ProviderIcon provider={shownModel.provider} name={shownModel.providerLabel} size={32} tile />}
                title={draft.model ? shownModel.label : "Use the routines default"}
                subtitle={draft.model ? shownModel.providerLabel : models ? shownModel.label : undefined}
                chevron
                onPress={pickModel}
              />
            </Group>
          </View>
        )}
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
          {canUse && <Row leading={<IconTile icon={Play} />} title="Run now" onPress={() => void attempt(api.runRoutine(routine.id), "Running now")} />}
          <Row leading={<IconTile icon={MessageCircle} color={colors.info} />} title="Open chat" chevron onPress={openChat} />
          {canDelete && <Row leading={<IconTile icon={Trash2} color={colors.danger} />} title="Delete routine" tone="danger" onPress={remove} />}
        </Group>
      )}
    </Sheet>
  );
}
