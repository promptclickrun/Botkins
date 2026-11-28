import { useCallback, useEffect, useState } from "react";
import { Input } from "glisse";
import { GlassSegmented } from "./GlisseUI";
import { Group, Row, Sheet, SwitchRow, ValueRow, errorText } from "./SettingsRows";
import type { Preferences, WorkspacePruneMode, WorkspacePruneResult, WorkspaceStats } from "./types";

const api = window.botkins;

const DAY_PRESETS = [
  { id: "7", label: "7 days", days: 7 },
  { id: "14", label: "14 days", days: 14 },
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "custom", label: "Custom", days: null },
] as const;

const MODE_OPTIONS: { id: WorkspacePruneMode; label: string }[] = [
  { id: "trim", label: "Trim tool output" },
  { id: "delete", label: "Delete old runs" },
];

export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return Math.max(0, Math.round(bytes || 0)) + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function presetForDays(days: number): (typeof DAY_PRESETS)[number]["id"] {
  if (days === 7) return "7";
  if (days === 14) return "14";
  if (days === 30) return "30";
  if (days === 90) return "90";
  return "custom";
}

type Props = {
  settings: Preferences;
  cache: { bytes: number; catalogs: number } | null | undefined;
  busy: boolean;
  onClearCache: () => void;
  onChangePreferences: (patch: Parameters<typeof window.botkins.setPreferences>[0]) => Promise<void>;
  onStatus: (message: string) => void;
  onError: (err: unknown) => void;
};

/**
 * Settings › Storage: workspace.json size, run pruning with preview & archive confirmation,
 * automatic daily/startup pruning preference, and browser cache controls.
 */
export default function StorageSettings({
  settings,
  cache,
  busy,
  onClearCache,
  onChangePreferences,
  onStatus,
  onError,
}: Props) {
  const pref = settings.workspacePrune ?? { auto: false, keepDays: 30, mode: "trim" as WorkspacePruneMode };
  const [stats, setStats] = useState<WorkspaceStats | null>(null);
  const [preset, setPreset] = useState<(typeof DAY_PRESETS)[number]["id"]>(() => presetForDays(pref.keepDays));
  const [customDays, setCustomDays] = useState<string>(() => String(pref.keepDays));
  const [mode, setMode] = useState<WorkspacePruneMode>(pref.mode);
  const [preview, setPreview] = useState<WorkspacePruneResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pruning, setPruning] = useState(false);

  // Sync local controls if preferences arrive later from the host.
  useEffect(() => {
    setPreset(presetForDays(pref.keepDays));
    setCustomDays(String(pref.keepDays));
    setMode(pref.mode);
  }, [pref.keepDays, pref.mode]);

  const effectiveDays = (() => {
    if (preset !== "custom") return Number(preset);
    const parsed = Number(customDays.trim());
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3650 ? parsed : null;
  })();

  const loadStats = useCallback(async () => {
    if (typeof api.workspaceStats !== "function") return;
    try {
      setStats(await api.workspaceStats());
    } catch (err) {
      onError(err);
    }
  }, [onError]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const runPreview = useCallback(
    async (keepDays: number, nextMode: WorkspacePruneMode) => {
      if (typeof api.workspacePrune !== "function") return;
      setPreviewing(true);
      try {
        const res = await api.workspacePrune({ keepDays, mode: nextMode, dryRun: true });
        setPreview(res);
      } catch (err) {
        setPreview(null);
        onError(err);
      } finally {
        setPreviewing(false);
      }
    },
    [onError],
  );

  // Automatically refresh the dry-run preview whenever keepDays or mode changes.
  useEffect(() => {
    if (effectiveDays === null) {
      setPreview(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void runPreview(effectiveDays, mode);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [effectiveDays, mode, runPreview]);

  const savePreference = async (patch: Partial<typeof pref>) => {
    try {
      await onChangePreferences({ workspacePrune: { ...pref, ...patch } });
    } catch (err) {
      onError(err);
    }
  };

  const selectPreset = (id: string) => {
    const next = id as (typeof DAY_PRESETS)[number]["id"];
    setPreset(next);
    if (next !== "custom") {
      const days = Number(next);
      setCustomDays(String(days));
      if (days !== pref.keepDays) void savePreference({ keepDays: days });
    }
  };

  const commitCustomDays = () => {
    if (effectiveDays !== null && effectiveDays !== pref.keepDays) {
      void savePreference({ keepDays: effectiveDays });
    }
  };

  const selectMode = (nextMode: WorkspacePruneMode) => {
    setMode(nextMode);
    if (nextMode !== pref.mode) void savePreference({ mode: nextMode });
  };

  const openConfirm = async () => {
    if (effectiveDays === null) return;
    setPreviewing(true);
    try {
      const fresh = await api.workspacePrune({ keepDays: effectiveDays, mode, dryRun: true });
      setPreview(fresh);
      if (fresh.affectedCount === 0) {
        onStatus("Nothing to prune for this window.");
        return;
      }
      setConfirmOpen(true);
    } catch (err) {
      onError(err);
    } finally {
      setPreviewing(false);
    }
  };

  const executePrune = async () => {
    if (effectiveDays === null) return;
    setPruning(true);
    try {
      const result = await api.workspacePrune({ keepDays: effectiveDays, mode, dryRun: false });
      setConfirmOpen(false);
      await loadStats();
      await runPreview(effectiveDays, mode);
      const verb = result.mode === "delete" ? "Deleted" : "Trimmed";
      onStatus(
        `${verb} ${result.affectedCount.toLocaleString()} run${result.affectedCount === 1 ? "" : "s"}, saved ${formatStorageBytes(result.savedBytes)}.` +
          (result.archivePath ? ` Archive: ${result.archivePath}` : ""),
      );
    } catch (err) {
      setConfirmOpen(false);
      onError(errorText(err));
    } finally {
      setPruning(false);
    }
  };

  const canPrune = effectiveDays !== null && !pruning && !previewing && !busy && (preview?.affectedCount ?? 0) > 0;

  return (
    <>
      <Group
        title="Workspace history"
        footer="Active turns, the newest run of each chat, and runs linked to open approvals, tasks or workflows are never touched. A gzip archive is written before anything changes."
        actions={
          <>
            <button
              type="button"
              className="set-button"
              disabled={effectiveDays === null || previewing || pruning}
              onClick={() => effectiveDays !== null && void runPreview(effectiveDays, mode)}
            >
              {previewing ? "Checking…" : "Preview"}
            </button>
            <button
              type="button"
              className={"set-button " + (mode === "delete" ? "danger" : "primary")}
              disabled={!canPrune}
              onClick={() => void openConfirm()}
            >
              {pruning ? "Pruning…" : "Prune now"}
            </button>
          </>
        }
      >
        <ValueRow
          label="Workspace size"
          value={stats ? formatStorageBytes(stats.bytes) : "Measuring…"}
          help={stats ? `${formatStorageBytes(stats.runsBytes)} in run history` : undefined}
        />
        <ValueRow
          label="Saved runs"
          value={stats ? stats.runCount.toLocaleString() : "…"}
          help={
            stats
              ? `${stats.chatCount.toLocaleString()} chat${stats.chatCount === 1 ? "" : "s"}` +
                (stats.trimmedRuns > 0 ? ` · ${stats.trimmedRuns.toLocaleString()} already trimmed` : "")
              : undefined
          }
        />
        <Row
          label="Keep the last"
          help="Older runs outside the newest 200 are eligible."
          stacked
        >
          {() => (
            <div className="storage-days-row">
              <GlassSegmented
                aria-label="Keep the last"
                minTabWidth={68}
                items={DAY_PRESETS.map((item) => ({ value: item.id, label: item.label }))}
                value={preset}
                onValueChange={selectPreset}
              />
              {preset === "custom" && (
                <div className="storage-custom-days">
                  <Input
                    type="number"
                    min={1}
                    max={3650}
                    step={1}
                    aria-label="Custom days to keep"
                    value={customDays}
                    onValueChange={setCustomDays}
                    onBlur={commitCustomDays}
                  />
                  <span className="muted">days (1–3650)</span>
                </div>
              )}
            </div>
          )}
        </Row>
        <Row
          label="Prune mode"
          help={
            mode === "trim"
              ? "Keeps run summaries, usage, todos and step names; drops large tool inputs and outputs."
              : "Removes old run records completely after archiving them."
          }
          stacked
        >
          {() => (
            <GlassSegmented
              aria-label="Prune mode"
              minTabWidth={136}
              items={MODE_OPTIONS.map((opt) => ({ value: opt.id, label: opt.label }))}
              value={mode}
              onValueChange={(value) => selectMode(value as WorkspacePruneMode)}
            />
          )}
        </Row>
        <ValueRow
          label="Preview"
          value={
            previewing
              ? "Calculating…"
              : effectiveDays === null
                ? "Enter 1–3650 days"
                : !preview
                  ? "—"
                  : preview.affectedCount === 0
                    ? "Nothing to prune"
                    : `${preview.affectedCount.toLocaleString()} run${preview.affectedCount === 1 ? "" : "s"} · saves ${formatStorageBytes(preview.savedBytes)}`
          }
          help={
            preview && preview.affectedCount > 0
              ? `${formatStorageBytes(preview.beforeBytes)} → ${formatStorageBytes(preview.afterBytes)}`
              : undefined
          }
        />
        <SwitchRow
          label="Auto-prune workspace"
          help="Runs at startup and once a day using the window and mode above. Off by default."
          checked={pref.auto}
          disabled={busy || pruning}
          onChange={(auto) => void savePreference({ auto })}
        />
      </Group>

      <Group
        title="Workspace cache"
        footer="Clearing keeps your chats, bots, panels and routines."
        actions={
          <button
            type="button"
            className="set-button"
            disabled={busy}
            onClick={onClearCache}
          >
            Clear cache
          </button>
        }
      >
        <ValueRow label="Browser cache" value={cache ? (cache.bytes / 1024 / 1024).toFixed(1) + " MB" : "Measuring…"} />
        <ValueRow
          label="Saved capability menus"
          value={cache ? String(cache.catalogs) : "…"}
          help="So “/” opens fast."
        />
      </Group>

      {confirmOpen && preview && (
        <Sheet
          title={preview.mode === "delete" ? "Delete old runs?" : "Trim old tool output?"}
          close={() => !pruning && setConfirmOpen(false)}
          submit={() => void executePrune()}
          footer={
            <>
              <button type="button" className="set-button" disabled={pruning} onClick={() => setConfirmOpen(false)}>
                Cancel
              </button>
              <button
                type="submit"
                className={"set-button " + (preview.mode === "delete" ? "danger" : "primary")}
                disabled={pruning}
              >
                {pruning ? "Pruning…" : preview.mode === "delete" ? "Delete runs" : "Trim now"}
              </button>
            </>
          }
        >
          <p className="storage-confirm-copy">
            {preview.mode === "delete"
              ? `This will delete ${preview.affectedCount.toLocaleString()} run${preview.affectedCount === 1 ? "" : "s"} older than ${preview.keepDays} day${preview.keepDays === 1 ? "" : "s"} (keeping the newest ${preview.keepRuns} runs and all active or referenced runs).`
              : `This will trim tool inputs and outputs from ${preview.affectedCount.toLocaleString()} run${preview.affectedCount === 1 ? "" : "s"} older than ${preview.keepDays} day${preview.keepDays === 1 ? "" : "s"} (keeping step names, summaries, usage and todos).`}
          </p>
          <div className="set-card">
            <ValueRow
              label="Estimated space saved"
              value={formatStorageBytes(preview.savedBytes)}
              help={`${formatStorageBytes(preview.beforeBytes)} → ${formatStorageBytes(preview.afterBytes)}`}
            />
            <div className="set-row stacked">
              <div className="set-label">
                <span className="set-name">Archive location</span>
                <small>Written as a compressed .json.gz backup before workspace.json is updated.</small>
              </div>
              <div className="set-control">
                <code className="storage-archive-path">{preview.archivePath ?? stats?.archiveDir ?? "data/archive/"}</code>
              </div>
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
