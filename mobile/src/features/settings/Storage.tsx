// Settings › Storage (owner-only): workspace.json size, run history pruning with preview,
// gzip archive confirmation, automatic daily/startup pruning toggle, and browser cache.
import { Archive, CalendarClock, Eraser, HardDrive, Layers, Sparkles, SquareSlash, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Alert, View } from "react-native";
import type { WorkspacePruneMode, WorkspacePruneResult, WorkspaceStats } from "@/link/types";
import { useCapability, useOnline, usePart, useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Button, Field, Group, IconTile, Label, Page, Row, Segmented, space, T, useTheme } from "@/ui";
import { formatStorageBytes, megabytes, parseCustomDays, presetForDays, type DayPreset } from "./storageLogic";

const DAY_OPTIONS: { value: DayPreset; label: string }[] = [
  { value: "7", label: "7d" },
  { value: "14", label: "14d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
  { value: "custom", label: "Custom" },
];

const MODE_OPTIONS: { value: WorkspacePruneMode; label: string }[] = [
  { value: "trim", label: "Trim tool output" },
  { value: "delete", label: "Delete old runs" },
];

export default function Storage() {
  const { colors } = useTheme();
  const online = useOnline();
  const meta = usePart("meta");
  const settings = useSettings();
  const owner = meta?.you?.kind !== "member";
  const canPruneCap = useCapability("workspace-prune-v1");
  const canClear = useCapability("maintenance-v1");

  const pref = settings?.workspacePrune ?? { auto: false, keepDays: 30, mode: "trim" as WorkspacePruneMode };
  const [stats, setStats] = useState<WorkspaceStats>();
  const [cache, setCache] = useState<{ bytes: number; catalogs: number }>();
  const [preset, setPreset] = useState<DayPreset>(() => presetForDays(pref.keepDays));
  const [customDays, setCustomDays] = useState<string>(() => String(pref.keepDays));
  const [mode, setMode] = useState<WorkspacePruneMode>(pref.mode);
  const [preview, setPreview] = useState<WorkspacePruneResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    setPreset(presetForDays(pref.keepDays));
    setCustomDays(String(pref.keepDays));
    setMode(pref.mode);
  }, [pref.keepDays, pref.mode]);

  const effectiveDays = preset === "custom" ? parseCustomDays(customDays) : Number(preset);

  const loadStats = useCallback(async () => {
    if (!online || !owner) return;
    if (canPruneCap) {
      await api.workspaceStats().then(setStats, () => {});
    }
    await api.cacheInfo().then(setCache, () => {});
  }, [online, owner, canPruneCap]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const runPreview = useCallback(
    async (keepDays: number, nextMode: WorkspacePruneMode) => {
      if (!online || !owner || !canPruneCap) return;
      setPreviewing(true);
      try {
        const res = await api.workspacePrune({ keepDays, mode: nextMode, dryRun: true });
        setPreview(res);
      } catch {
        setPreview(null);
      } finally {
        setPreviewing(false);
      }
    },
    [online, owner, canPruneCap],
  );

  useEffect(() => {
    if (!online || !owner || !canPruneCap || effectiveDays === null) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => void runPreview(effectiveDays, mode), 150);
    return () => clearTimeout(timer);
  }, [online, owner, canPruneCap, effectiveDays, mode, runPreview]);

  if (!owner) {
    return (
      <Page title="Storage">
        <Group>
          <Row
            leading={<IconTile icon={HardDrive} color={colors.ink2} />}
            title="Owner only"
            subtitle="Workspace storage and pruning can only be managed by the computer's owner."
            subtitleLines={3}
          />
        </Group>
      </Page>
    );
  }

  const savePref = (patch: Partial<typeof pref>) => {
    void attempt(api.setPreferences({ workspacePrune: { ...pref, ...patch } }));
  };

  const onSelectPreset = (next: DayPreset) => {
    setPreset(next);
    if (next !== "custom") {
      const days = Number(next);
      setCustomDays(String(days));
      if (days !== pref.keepDays) savePref({ keepDays: days });
    }
  };

  const onSelectMode = (next: WorkspacePruneMode) => {
    setMode(next);
    if (next !== pref.mode) savePref({ mode: next });
  };

  const confirmAndPrune = async () => {
    if (effectiveDays === null || !online || !canPruneCap) return;
    setPreviewing(true);
    let fresh: WorkspacePruneResult | undefined;
    try {
      fresh = await attempt(api.workspacePrune({ keepDays: effectiveDays, mode, dryRun: true }));
    } finally {
      setPreviewing(false);
    }
    if (!fresh) return;
    setPreview(fresh);
    if (fresh.affectedCount === 0) {
      Alert.alert("Nothing to prune", "No eligible runs are older than the selected window.");
      return;
    }
    const verb = fresh.mode === "delete" ? "Delete" : "Trim";
    const archive = fresh.archivePath ?? stats?.archiveDir ?? "data/archive/";
    const details =
      `${verb} ${fresh.affectedCount.toLocaleString()} run${fresh.affectedCount === 1 ? "" : "s"} to save ${formatStorageBytes(fresh.savedBytes)} (${formatStorageBytes(fresh.beforeBytes)} → ${formatStorageBytes(fresh.afterBytes)}).\n\n` +
      `A gzip archive will be saved first to:\n${archive}`;
    Alert.alert(fresh.mode === "delete" ? "Delete old runs?" : "Trim old tool output?", details, [
      { text: "Cancel", style: "cancel" },
      {
        text: verb + " now",
        style: fresh.mode === "delete" ? "destructive" : "default",
        onPress: () => {
          void (async () => {
            setPruning(true);
            const result = await attempt(
              api.workspacePrune({ keepDays: effectiveDays, mode, dryRun: false }),
              `Saved ${formatStorageBytes(fresh.savedBytes)}.`,
            );
            setPruning(false);
            if (result) {
              await loadStats();
              await runPreview(effectiveDays, mode);
            }
          })();
        },
      },
    ]);
  };

  const clearCache = async () => {
    setClearing(true);
    await attempt(api.clearCache(), "Cache cleared.");
    await api.cacheInfo().then(setCache, () => {});
    setClearing(false);
  };

  const previewValue = !canPruneCap
    ? "Update required"
    : previewing
      ? "Checking…"
      : effectiveDays === null
        ? "Enter 1–3650"
        : !preview
          ? "—"
          : preview.affectedCount === 0
            ? "Nothing to prune"
            : `${preview.affectedCount.toLocaleString()} run${preview.affectedCount === 1 ? "" : "s"} · −${formatStorageBytes(preview.savedBytes)}`;

  const previewSub =
    preview && preview.affectedCount > 0
      ? `${formatStorageBytes(preview.beforeBytes)} → ${formatStorageBytes(preview.afterBytes)}`
      : "Active turns, newest run per chat, and open approvals, tasks or workflows are protected.";

  return (
    <Page title="Storage" keyboard>
      <View>
        <Label>Workspace history</Label>
        <Group>
          <Row
            leading={<IconTile icon={HardDrive} color={colors.ink2} />}
            title="Workspace size"
            subtitle={stats ? `${formatStorageBytes(stats.runsBytes)} in run history` : canPruneCap ? undefined : "Update the app on your computer"}
            value={stats ? formatStorageBytes(stats.bytes) : "—"}
          />
          <Row
            leading={<IconTile icon={Layers} color={colors.ink2} />}
            title="Saved runs"
            subtitle={
              stats
                ? `${stats.chatCount.toLocaleString()} chat${stats.chatCount === 1 ? "" : "s"}` +
                  (stats.trimmedRuns > 0 ? ` · ${stats.trimmedRuns.toLocaleString()} trimmed` : "")
                : undefined
            }
            value={stats ? stats.runCount.toLocaleString() : "—"}
          />
        </Group>
      </View>

      {canPruneCap && (
        <View style={{ gap: space.md }}>
          <View style={{ gap: space.sm }}>
            <Label>Keep the last</Label>
            <Segmented options={DAY_OPTIONS} value={preset} onChange={onSelectPreset} />
            {preset === "custom" && (
              <Field
                label="Custom days (1–3650)"
                value={customDays}
                onChangeText={setCustomDays}
                onBlur={() => {
                  if (effectiveDays !== null && effectiveDays !== pref.keepDays) savePref({ keepDays: effectiveDays });
                }}
                keyboardType="number-pad"
                placeholder="30"
              />
            )}
          </View>

          <View style={{ gap: space.sm }}>
            <Label>Prune mode</Label>
            <Segmented options={MODE_OPTIONS} value={mode} onChange={onSelectMode} />
            <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
              {mode === "trim"
                ? "Keeps run summaries, usage, todos and step names; drops large tool inputs and outputs."
                : "Removes old run records completely after saving a gzip archive."}
            </T>
          </View>

          <View>
            <Label>Preview & automatic pruning</Label>
            <Group>
              <Row
                leading={<IconTile icon={Archive} color={colors.ink2} />}
                title="Preview"
                subtitle={previewSub}
                subtitleLines={3}
                value={previewValue}
                onPress={effectiveDays !== null ? () => void runPreview(effectiveDays, mode) : undefined}
              />
              <Row
                leading={<IconTile icon={CalendarClock} color={colors.ink2} />}
                title="Auto-prune workspace"
                subtitle="Runs at startup and once a day using the window and mode above"
                subtitleLines={2}
                toggled={pref.auto}
                disabled={!online || pruning}
                onToggle={(auto) => savePref({ auto })}
              />
            </Group>
          </View>

          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button
              title={previewing ? "Checking…" : "Preview"}
              variant="secondary"
              icon={Sparkles}
              disabled={!online || effectiveDays === null || previewing || pruning}
              onPress={() => effectiveDays !== null && void runPreview(effectiveDays, mode)}
              style={{ flex: 1 }}
            />
            <Button
              title={pruning ? "Pruning…" : "Prune now"}
              variant={mode === "delete" ? "danger" : "primary"}
              icon={mode === "delete" ? Trash2 : Eraser}
              disabled={!online || effectiveDays === null || previewing || pruning || (preview?.affectedCount ?? 0) === 0}
              onPress={() => void confirmAndPrune()}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      )}

      {cache && (
        <View>
          <Label>Cache</Label>
          <Group>
            <Row leading={<IconTile icon={HardDrive} color={colors.ink2} />} title="Browser cache" value={megabytes(cache.bytes)} />
            <Row leading={<IconTile icon={SquareSlash} color={colors.ink2} />} title="Saved capability menus" subtitle="So “/” opens fast" value={String(cache.catalogs)} />
            <Row
              leading={<IconTile icon={Eraser} color={colors.ink2} />}
              title="Clear cache"
              subtitle={canClear ? "Keeps your chats, bots, panels and routines" : "Update the app on your computer"}
              subtitleLines={2}
              disabled={!canClear || !online || clearing}
              onPress={() => void clearCache()}
            />
          </Group>
        </View>
      )}
    </Page>
  );
}
