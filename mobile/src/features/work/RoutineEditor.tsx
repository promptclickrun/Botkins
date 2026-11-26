import { MenuView } from "@react-native-menu/menu";
import { router, useLocalSearchParams } from "expo-router";
import { Bell, Check, CornerDownRight, MessageCircle, Minus, Monitor, Play, Send, Smartphone, Trash2, TriangleAlert, User } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { openChat as openChatRoute } from "@/features/chat/navigate";
import type { ModelChoice } from "@/link/types";
import { defaultProviderOf, describeChoice } from "@/features/models/shared";
import { type RoutineEntry, useBots, useCan, useMember, useModels, usePart, useProviders, useRoutines, useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { routineDefault } from "@/state/models";
import { useApp } from "@/state/store";
import { Badge, EmptyState, Field, Group, IconTile, Label, Loading, ProviderIcon, radius, Row, Segmented, Sheet, space, T, Tap, useTheme } from "@/ui";
import { holdRoutineModel } from "./routineModel";
import { BotChips, routineName } from "./bits";
import { type CadenceDraft, CadenceFields, cadenceOf, draftOfCadence, phoneZone, scheduleOk, usePreview } from "./Cadence";
import { canNotify, DELIVERY, deliveryToSave, firstPlace, NOTIFY_TARGETS, notifyLine, type Place, placeOf, placesFor } from "./delivery";
import {
  activeTargetsOnly,
  buildNotifyTargetView,
  countRemovedTargetIds,
  hasSelectedTargets,
  initialNotifyMode,
  isDeviceChecked,
  isPersonChecked,
  isPersonIndeterminate,
  normalizeTargets,
  type NotifyMode,
  toggleDeviceTarget,
  togglePersonTarget,
} from "./notifyTargets";

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
  notifyMode: NotifyMode;
  notifyTargets: { people: string[]; devices: string[] };
  runs: "instructions" | "script";
  script: string;
  followUp: boolean;
  model: ModelChoice | null;
};

function draftOf(routine: RoutineEntry | undefined, botId: string | null, capabilities: string[] | undefined): Draft {
  const initialPlace = firstPlace(undefined, true, capabilities);
  const base: Draft = {
    ...draftOfCadence(undefined),
    botId,
    name: "",
    prompt: "",
    place: initialPlace,
    notify: true,
    notifyMode: "everyone",
    notifyTargets: { people: [], devices: [] },
    runs: "instructions",
    script: "",
    followUp: false,
    model: null,
  };
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
    notifyMode: initialNotifyMode(entry, place),
    notifyTargets: normalizeTargets(entry.notifyTargets),
    runs: entry.script ? "script" : "instructions",
    script: entry.script ?? "",
    followUp: entry.followUp === true,
    model: routine.chat.model ?? null,
  };
}

function TargetCheck({ checked, indeterminate }: { checked: boolean; indeterminate?: boolean }) {
  const { colors } = useTheme();
  const active = checked || indeterminate;
  return (
    <View
      style={{
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 1.5,
        borderColor: active ? colors.accent : colors.lineStrong,
        backgroundColor: active ? colors.accent : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {checked ? <Check size={14} color={colors.onAccent} strokeWidth={3} /> : indeterminate ? <Minus size={14} color={colors.onAccent} strokeWidth={3} /> : null}
    </View>
  );
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
  const meta = usePart("meta");
  const team = usePart("team");
  const phones = usePart("phones");
  const capabilities = meta?.capabilities;
  const canUse = useCan("today", "use");
  const canDelete = useCan("today", "delete");
  const [draft, setDraft] = useState<Draft>(() => draftOf(routine, botId ?? (shownBots.length === 1 ? shownBots[0].id : null), capabilities));
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft((last) => ({ ...last, ...patch }));
  // An older computer keeps every result in the routine's own chat.
  const canDeliver = !!capabilities?.includes(DELIVERY);
  const canTargetNotify = !!capabilities?.includes(NOTIFY_TARGETS);
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

  const targetView = useMemo(
    () => buildNotifyTargetView({ meta, team, phones, settings, botId: draft.botId }),
    [meta, team, phones, settings, draft.botId],
  );
  const effectiveNotifyMode: NotifyMode = !canNotify(draft.place) ? "quiet" : draft.notifyMode;
  const removedTargetCount = useMemo(
    () => (effectiveNotifyMode === "specific" ? countRemovedTargetIds(draft.notifyTargets, targetView) : 0),
    [effectiveNotifyMode, draft.notifyTargets, targetView],
  );
  const specificInvalid = canDeliver && canTargetNotify && effectiveNotifyMode === "specific" && !hasSelectedTargets(draft.notifyTargets);

  const cadence = cadenceOf(draft);
  const preview = usePreview(cadence, zone());
  const ready =
    !!draft.botId &&
    !!draft.name.trim() &&
    (!needsPrompt || !!draft.prompt.trim()) &&
    (!scripted || !!draft.script.trim()) &&
    scheduleOk(preview, draft.kind) &&
    !specificInvalid;

  const save = async () => {
    if (!ready || !draft.botId) return;
    setSaving(true);
    // The model is sent only when it changed, so an edit never waits on the model list for nothing.
    const modelChanged = JSON.stringify(draft.model) !== JSON.stringify(routine?.chat.model ?? null);
    const notifyPayload = !canDeliver
      ? {}
      : canTargetNotify
        ? !canNotify(draft.place) || effectiveNotifyMode === "quiet"
          ? { notify: false, notifyTargets: null }
          : effectiveNotifyMode === "everyone"
            ? { notify: true, notifyTargets: null }
            : {
                notify: true,
                notifyTargets: {
                  ...(draft.notifyTargets.people.length ? { people: draft.notifyTargets.people } : {}),
                  ...(draft.notifyTargets.devices.length ? { devices: draft.notifyTargets.devices } : {}),
                },
              }
        : { notify: canNotify(draft.place) && draft.notify };
    const fields = {
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      cadence,
      timezone: zone(),
      ...(canDeliver && { deliver: deliveryToSave(draft.place, routine?.entry.deliver), ...notifyPayload }),
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
    openChatRoute(routine.id);
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
        <View style={{ gap: space.md }}>
          <View>
            <Label>Send result to</Label>
            <Group>
              <MenuView
                actions={places.map((place) => ({ id: place.value, title: placeLabel(place.value), subtitle: place.hint, image: place.image, state: draft.place === place.value ? ("on" as const) : ("off" as const) }))}
                onPressAction={({ nativeEvent }) => set({ place: nativeEvent.event as Place })}
              >
                <Row leading={<IconTile icon={Send} color={colors.ink2} />} title={placeLabel(draft.place)} subtitle={placeOf(draft.place).hint} chevron />
              </MenuView>
              {!canTargetNotify && (
                <Row key="notify" leading={<IconTile icon={Bell} color={colors.ink2} />} title="Notify me" subtitle={notifyLine(draft.place, draft.notify)} subtitleLines={2} toggled={canNotify(draft.place) && draft.notify} disabled={!canNotify(draft.place)} onToggle={(notify) => set({ notify })} />
              )}
            </Group>
          </View>

          {canTargetNotify && (
            <View style={{ gap: space.sm }}>
              <Label style={{ marginBottom: 0 }}>Alerts</Label>
              <View style={{ opacity: canNotify(draft.place) ? 1 : 0.45 }} pointerEvents={canNotify(draft.place) ? "auto" : "none"}>
                <Segmented
                  options={[
                    { value: "everyone", label: "Everyone" },
                    { value: "specific", label: "Specific" },
                    { value: "quiet", label: "Quiet" },
                  ]}
                  value={effectiveNotifyMode}
                  onChange={(notifyMode) => set({ notifyMode, notify: notifyMode !== "quiet" })}
                />
              </View>
              <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
                {!canNotify(draft.place)
                  ? "No-output routines never publish or notify."
                  : effectiveNotifyMode === "quiet"
                    ? "Runs without sending alerts. The agent can still notify on a specific run."
                    : effectiveNotifyMode === "everyone"
                      ? "Alerts everyone who can see this routine on their devices with alerts enabled."
                      : "Only the selected people and devices are alerted when a run finishes."}
              </T>

              {effectiveNotifyMode === "specific" && (
                <>
                  {removedTargetCount > 0 && (
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: space.sm,
                        paddingHorizontal: space.md,
                        paddingVertical: space.sm,
                        borderRadius: radius.md,
                        backgroundColor: colors.surface,
                        borderWidth: 1,
                        borderColor: colors.warning,
                      }}
                    >
                      <TriangleAlert size={16} color={colors.warning} />
                      <T variant="footnote" color="ink" style={{ flex: 1 }}>
                        {removedTargetCount === 1
                          ? "1 saved target is no longer on this team."
                          : `${removedTargetCount} saved targets are no longer on this team.`}
                      </T>
                      <Tap
                        onPress={() => set({ notifyTargets: activeTargetsOnly(draft.notifyTargets, targetView) })}
                        accessibilityLabel="Remove unavailable targets"
                      >
                        <T variant="footnote" weight="600" color="accentText">
                          Remove
                        </T>
                      </Tap>
                    </View>
                  )}

                  <Group inset={space.lg + 22 + space.md}>
                    {targetView.people.flatMap((person) => {
                      const personChecked = isPersonChecked(draft.notifyTargets, person);
                      const personPartial = isPersonIndeterminate(draft.notifyTargets, person);
                      const personRows = [
                        <Row
                          key={`person:${person.id}`}
                          leading={<TargetCheck checked={personChecked} indeterminate={personPartial} />}
                          title={person.isMe ? `${person.name} (You)` : person.name}
                          subtitle={
                            person.devices.length > 0
                              ? "All devices"
                              : targetView.isMember && !person.isMe
                                ? "All of their devices"
                                : "No paired devices"
                          }
                          trailing={<User size={16} color={colors.muted} />}
                          onPress={() => set({ notifyTargets: togglePersonTarget(draft.notifyTargets, person) })}
                        />,
                      ];
                      for (const device of person.devices) {
                        const deviceChecked = isDeviceChecked(draft.notifyTargets, person, device.id);
                        const DeviceIcon = device.kind === "host" || device.kind === "desktop" ? Monitor : Smartphone;
                        personRows.push(
                          <Row
                            key={`device:${device.id}`}
                            leading={
                              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.lg }}>
                                <TargetCheck checked={deviceChecked} />
                                <DeviceIcon size={16} color={colors.ink2} />
                              </View>
                            }
                            title={device.name}
                            trailing={
                              !device.canNotify ? (
                                <Badge label={device.kind === "host" ? "Alerts off" : "Push off"} tone="warning" />
                              ) : undefined
                            }
                            onPress={() => set({ notifyTargets: toggleDeviceTarget(draft.notifyTargets, person, device.id) })}
                          />,
                        );
                      }
                      return personRows;
                    })}
                  </Group>

                  {specificInvalid && (
                    <T variant="footnote" color="danger" style={{ paddingHorizontal: space.xs }}>
                      Select at least one person or device, or switch to Quiet.
                    </T>
                  )}
                </>
              )}
            </View>
          )}
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
