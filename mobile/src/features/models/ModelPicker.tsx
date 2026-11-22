import { router, useLocalSearchParams } from "expo-router";
import { Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Info, Search } from "lucide-react-native";
import { type ReactNode, useMemo, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ModelChoice, ModelInfo } from "@/link/types";
import { useBot, useCan, useChat, useModels, useProviders, useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { setPrefs, usePrefs } from "@/state/prefs";
import { chooseModel, effectiveModel, effortLabel, findModel, groupModels, modelKey, routineDefault } from "@/state/models";
import { heldRoutineModel } from "@/features/work/routineModel";
import { useProviderUsage } from "@/state/providerUsage";
import { Badge, Chip, EmptyState, Group, haptic, IconButton, Label, Loading, ProviderIcon, radius, Row, Sheet, space, T, Tap, useTheme } from "@/ui";
import { contextFact } from "./facts";
import { limitLine, limitTone, primaryLimit } from "./limits";
import { defaultProviderOf, describeChoice } from "./shared";

type Scope = "global" | "routines" | "bot" | "chat" | "routine";
const SCOPES = ["routines", "bot", "chat", "routine"] as const;
const same = (a: ModelChoice | null | undefined, b: ModelChoice | null | undefined) =>
  (a ?? null) === (b ?? null) || (!!a && !!b && a.model === b.model && (a.provider ?? "") === (b.provider ?? "") && (a.reasoningEffort ?? "") === (b.reasoningEffort ?? ""));

/** A row in the list: a model, or "Use default". Checked when chosen. A model's row also has an info button. */
function Choice({
  title,
  subtitle,
  leading,
  selected,
  disabled,
  badge,
  onPress,
  onInfo,
}: {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  selected: boolean;
  disabled?: boolean;
  badge?: string;
  onPress: () => void;
  onInfo?: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <Tap
        onPress={onPress}
        disabled={disabled}
        feel="select"
        sink={1}
        hitSlop={0}
        accessibilityRole="radio"
        accessibilityLabel={title + (subtitle ? ", " + subtitle : "") + (badge ? ", " + badge : "")}
        accessibilityState={{ checked: selected, disabled: !!disabled }}
        style={{ flex: 1, minWidth: 0 }}
      >
        <View style={{ minHeight: 56, paddingLeft: space.lg, paddingRight: onInfo ? space.xs : space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }}>
          {leading}
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
              <T variant="callout" weight={selected ? "600" : "500"} numberOfLines={1} style={{ flexShrink: 1 }}>
                {title}
              </T>
              {!!badge && <Badge label={badge} tone="accent" />}
            </View>
            {!!subtitle && (
              <T variant="footnote" color="muted" numberOfLines={1}>
                {subtitle}
              </T>
            )}
          </View>
          <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: selected ? colors.accent : "transparent", borderWidth: selected ? 0 : 1.5, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" }}>
            {selected && <Check size={14} color={colors.onAccent} strokeWidth={3} />}
          </View>
        </View>
      </Tap>
      {onInfo && (
        <Tap onPress={onInfo} feel="select" sink={0.9} hitSlop={0} accessibilityRole="button" accessibilityLabel={"About " + title} style={{ width: 48, minHeight: 56, alignItems: "center", justifyContent: "center", paddingRight: space.xs }}>
          <Info size={19} color={colors.faint} strokeWidth={2.2} />
        </Tap>
      )}
    </View>
  );
}

/** What a model's row says under its name: its window when known, then its description. */
const modelSubtitle = (model: ModelInfo) => (model.available ? [contextFact(model), model.description].filter(Boolean).join(" · ") || undefined : "Not on this account");

/**
 * Picks the model and thinking level for the computer, its routines ("routines": the Default
 * routines model), a bot, a chat, or a routine being edited ("routine": the choice goes back to the
 * editor, which saves it with the routine; `id` is the routine's bot).
 */
export default function ModelPicker() {
  const params = useLocalSearchParams<{ scope?: string }>();
  const canManage = useCan("agents", "manage");
  // A routine's model is part of the routine: whoever may make or change routines picks it.
  const canCreateRoutine = useCan("today", "create");
  const canChangeRoutine = useCan("today", "manage");
  const canRoutine = canCreateRoutine || canChangeRoutine;
  if (!(params.scope === "routine" ? canRoutine : canManage)) return <Sheet title="Model"><EmptyState title="Your team role can't change models" /></Sheet>;
  return <Picker />;
}

function Picker() {
  const params = useLocalSearchParams<{ scope?: string; id?: string }>();
  const scope: Scope = SCOPES.find((name) => name === params.scope) ?? "global";
  const chat = useChat(scope === "chat" ? params.id : undefined);
  const bot = useBot(scope === "bot" || scope === "routine" ? params.id : chat?.botId);
  const held = scope === "routine" ? heldRoutineModel() : null;
  const { colors } = useTheme();
  const settings = useSettings();
  const models = useModels();
  const providers = useProviders();
  const defaultProvider = defaultProviderOf(providers);

  const saved =
    (scope === "global" ? settings?.model : scope === "routines" ? settings?.routineModel : scope === "bot" ? bot?.model : scope === "routine" ? held?.value : chat?.model) ?? null;
  const routineChat = !!chat?.schedules?.some((entry) => entry.routine);
  const inherited =
    scope === "chat"
      ? effectiveModel(settings, bot, chat ? { ...chat, model: undefined } : undefined)
      : scope === "routine"
        ? routineDefault(settings, bot)
        : scope === "bot" || scope === "routines"
          ? settings?.model
          : undefined;
  // What "no model of its own" is called here.
  const inheritTitle = scope === "routines" ? "Use the global default" : scope === "routine" || routineChat ? "Use the routines default" : "Use default";
  const [choice, setChoice] = useState<ModelChoice | null>(saved);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const chosen = findModel(models ?? [], choice ?? undefined, defaultProvider);
  const savedMissing = !!saved && !!models && !findModel(models, saved, defaultProvider);
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const shown = needle ? (models ?? []).filter((m) => [m.name, m.id, m.providerName, m.group, m.description].some((text) => text?.toLowerCase().includes(needle))) : (models ?? []);
    return groupModels(shown);
  }, [models, query]);

  // A provider folds shut to get its models out of the way. A search opens them all while it lasts.
  const folded = usePrefs((prefs) => prefs.foldedProviders);
  // What is left of each provider's plan, shown under its name while a model is chosen.
  const limits = useProviderUsage();
  const searching = !!query.trim();
  const isFolded = (provider: string) => !searching && folded.includes(provider);
  const fold = (provider: string) => {
    haptic.select();
    setPrefs({ foldedProviders: folded.includes(provider) ? folded.filter((id) => id !== provider) : [...folded, provider] });
  };
  const allFolded = groups.length > 0 && groups.every((group) => folded.includes(group.provider));
  const foldAll = () => {
    haptic.select();
    setPrefs({ foldedProviders: allFolded ? [] : groups.map((group) => group.provider) });
  };

  const pick = (model: ModelInfo) => setChoice(chooseModel(model, choice?.reasoningEffort));
  const save = async () => {
    if (scope === "routine") {
      held?.set(choice);
      router.back();
      return;
    }
    setBusy(true);
    const done = await attempt(api.setModel(scope, scope === "global" || scope === "routines" ? null : (params.id ?? null), choice).then(() => true));
    setBusy(false);
    if (done) router.back();
  };

  const fallback = scope !== "global" ? describeChoice(inherited, models, defaultProvider) : undefined;
  const thinking = chosen && choice ? <Thinking model={chosen} effort={choice.reasoningEffort} onChange={(effort) => setChoice(chooseModel(chosen, effort))} /> : null;

  return (
    <Sheet title="Model" action={scope === "routine" ? "Done" : "Save"} onAction={() => void save()} actionDisabled={same(choice, saved) || (scope === "global" && !choice)} actionLoading={busy} footer={thinking}>
      {!models ? (
        <Loading />
      ) : models.length === 0 ? (
        <EmptyState title="No models yet" action="Model providers" onAction={() => router.dismissTo("/models")} />
      ) : (
        <>
          {models.length > 8 && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <SearchField value={query} onChange={setQuery} />
              </View>
              {groups.length > 1 && !searching && <IconButton icon={allFolded ? ChevronsUpDown : ChevronsDownUp} label={allFolded ? "Open every provider" : "Fold every provider"} variant="soft" size={44} onPress={foldAll} />}
            </View>
          )}

          {(fallback || savedMissing) && !query && (
            <Group>
              {fallback && (
                <Choice
                  leading={<ProviderIcon provider={fallback.provider} name={fallback.providerLabel} size={32} tile />}
                  title={inheritTitle}
                  subtitle={fallback.label}
                  selected={choice === null}
                  onPress={() => setChoice(null)}
                />
              )}
              {savedMissing && saved && (
                <Choice leading={<ProviderIcon provider={saved.provider ?? defaultProvider} size={32} tile />} title={saved.model} subtitle="Unavailable" selected={same(choice, saved)} onPress={() => setChoice(saved)} />
              )}
            </Group>
          )}

          {groups.map((group) => {
            const shut = isFolded(group.provider);
            const count = group.sections.reduce((sum, section) => sum + section.models.length, 0);
            // A folded provider still says which of its models is chosen.
            const holds = !!choice && !!chosen && group.sections.some((section) => section.models.includes(chosen));
            const Fold = shut ? ChevronRight : ChevronDown;
            const usage = limits.of(group.provider);
            const left = limitLine(usage);
            const leftPercent = primaryLimit(usage)?.percentRemaining;
            const leftTone = leftPercent === undefined ? "ok" : limitTone(leftPercent);
            return (
              <View key={group.provider} style={{ gap: space.sm }}>
                <Tap
                  onPress={() => !searching && fold(group.provider)}
                  sink={1}
                  hitSlop={0}
                  accessibilityRole="button"
                  accessibilityLabel={group.name + ", " + count + (count === 1 ? " model" : " models") + (holds ? ", holds the chosen model" : "") + (left ? ", " + left : "")}
                  accessibilityState={{ expanded: !shut }}
                  style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs }}
                >
                  <ProviderIcon provider={group.provider} name={group.name} size={26} tile />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                      <T variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
                        {group.name}
                      </T>
                      <T variant="subhead" color={shut && holds ? "accentText" : "faint"} weight={shut && holds ? "600" : "400"} numberOfLines={1} style={{ flex: 1 }}>
                        {shut && holds && chosen ? chosen.name : String(count)}
                      </T>
                    </View>
                    {/* What is left of the provider's plan, when it says: "62% of weekly left · resets Mon". */}
                    {!!left && (
                      <T variant="footnote" color={leftTone === "out" ? "danger" : leftTone === "low" ? "warning" : "muted"} numberOfLines={1}>
                        {left}
                      </T>
                    )}
                  </View>
                  {!searching && <Fold size={18} color={colors.faint} strokeWidth={2.2} />}
                </Tap>
                {!shut && group.sections.map((section) => (
                  <View key={section.title ?? ""}>
                    {!!section.title && group.sections.length > 1 && <Label style={{ marginTop: space.xs }}>{section.title}</Label>}
                    <Group>
                      {section.models.map((model) => (
                        <Choice
                          key={modelKey(model)}
                          title={model.name}
                          subtitle={modelSubtitle(model)}
                          badge={model.recommended && model.available ? "Recommended" : undefined}
                          selected={!!choice && chosen === model}
                          disabled={!model.available}
                          onPress={() => pick(model)}
                          onInfo={() => router.push({ pathname: "/chat/model-info", params: { model: model.id, provider: model.provider ?? "" } })}
                        />
                      ))}
                    </Group>
                  </View>
                ))}
              </View>
            );
          })}
          {groups.length === 0 && (
            <T variant="subhead" color="muted" center style={{ paddingVertical: space.xl }}>
              No models match
            </T>
          )}

          <Group>
            <Row title="Model providers" chevron onPress={() => router.dismissTo("/models")} />
          </Group>
        </>
      )}
    </Sheet>
  );
}

function SearchField({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const { colors, dark, type } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, height: 44, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: colors.sunken }}>
      <Search size={17} color={colors.muted} strokeWidth={2.2} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Search models"
        placeholderTextColor={colors.faint}
        keyboardAppearance={dark ? "dark" : "light"}
        selectionColor={colors.accent}
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="while-editing"
        returnKeyType="search"
        maxFontSizeMultiplier={1.3}
        accessibilityLabel="Search models"
        style={[type.callout, { flex: 1, color: colors.ink, paddingVertical: 0 }]}
      />
    </View>
  );
}

/** The thinking levels the chosen model takes, pinned under the list so it is always in reach. */
function Thinking({ model, effort, onChange }: { model: ModelInfo; effort?: string; onChange: (effort: string | undefined) => void }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const current = effort ?? model.defaultEffort;
  return (
    <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.canvas, paddingTop: space.md, paddingBottom: insets.bottom + space.sm, gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xl }}>
        <ProviderIcon provider={model.provider} name={model.providerName} size={14} />
        <T variant="label" color="muted" style={{ textTransform: "uppercase" }} accessibilityRole="header">
          {"Thinking · " + model.name}
        </T>
      </View>
      {model.efforts.length === 0 ? (
        <T variant="subhead" color="muted" style={{ paddingHorizontal: space.xl, paddingBottom: space.xs }}>
          This model manages its own thinking.
        </T>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: space.xl, gap: space.sm }}>
          {model.efforts.map((level) => (
            <Chip
              key={level}
              label={effortLabel(level) + (level === model.defaultEffort ? " · Default" : "")}
              selected={level === current}
              // The model's own default is saved as no choice, so it follows the model.
              onPress={() => onChange(level === model.defaultEffort ? undefined : level)}
            />
          ))}
        </View>
      )}
    </View>
  );
}
