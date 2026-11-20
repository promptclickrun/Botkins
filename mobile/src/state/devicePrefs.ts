// Device access on this phone: which sources bots may use, and the last tool calls it answered.
// Saved on the phone only. The computer is told the switches (src/state/device.ts); it is never
// told the activity, and the activity never holds what a tool read.
import { forget, keep, readKept } from "@/state/keep";
import { create } from "zustand";
import { cleanSources } from "@/device/tools";
import type { DeviceLevel, DeviceSource, DeviceSources } from "@/link/types";

const SOURCES_KEY = "botkins.deviceSources.v1";
const ACTIVITY_KEY = "botkins.deviceActivity.v1";
export const MAX_ACTIVITY = 20;

/** One tool call this phone answered: which tool, for which bot, when, and whether it worked. */
export type DeviceActivity = { id: string; tool: string; botId?: string; bot?: string; at: number; ok: boolean; error?: string };

type DevicePrefs = { loaded: boolean; sources: DeviceSources; activity: DeviceActivity[] };

export const useDevicePrefs = create<DevicePrefs>(() => ({ loaded: false, sources: {}, activity: [] }));

let loading: Promise<void> | null = null;

/** Reads what is saved once. Called by itself the first time this module is used. */
export function loadDevicePrefs(): Promise<void> {
  loading ??= (async () => {
    const [sources, activity] = await Promise.all([readKept(SOURCES_KEY).catch(() => null), readKept(ACTIVITY_KEY).catch(() => null)]);
    const next: Partial<DevicePrefs> = { loaded: true };
    try {
      if (sources) next.sources = cleanSources(JSON.parse(sources));
    } catch {
      // Unreadable switches are all off.
    }
    try {
      const list = activity ? (JSON.parse(activity) as DeviceActivity[]) : [];
      if (Array.isArray(list)) next.activity = list.filter((entry) => entry && typeof entry.id === "string" && typeof entry.tool === "string").slice(0, MAX_ACTIVITY);
    } catch {
      // An unreadable list starts again.
    }
    useDevicePrefs.setState(next);
  })();
  return loading;
}

function save(key: string, value: unknown) {
  void keep(key, JSON.stringify(value)).catch(() => {});
}

export function setSourceLevel(source: DeviceSource, level: DeviceLevel) {
  // Saved after the stored switches were read, so a change made early never writes over them.
  void loadDevicePrefs().then(() => {
    const sources = cleanSources({ ...useDevicePrefs.getState().sources, [source]: level });
    useDevicePrefs.setState({ sources });
    save(SOURCES_KEY, sources);
  });
}

export function recordActivity(entry: DeviceActivity) {
  void loadDevicePrefs().then(() => {
    const clean: DeviceActivity = { ...entry, bot: entry.bot?.slice(0, 60), error: entry.error?.slice(0, 140) };
    const activity = [clean, ...useDevicePrefs.getState().activity.filter((held) => held.id !== entry.id)].slice(0, MAX_ACTIVITY);
    useDevicePrefs.setState({ activity });
    save(ACTIVITY_KEY, activity);
  });
}

export function clearActivity() {
  useDevicePrefs.setState({ activity: [] });
  void forget(ACTIVITY_KEY).catch(() => {});
}

void loadDevicePrefs();
