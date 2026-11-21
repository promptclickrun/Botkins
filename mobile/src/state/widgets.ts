// Keeps the widgets' snapshot (src/state/widgetData.ts) up to date: while the app runs it is
// written a moment after anything a widget shows changes, and at once when the app goes to the
// background. The native side saves it in the App Group and asks iOS to draw the widgets again.
import { AppState } from "react-native";
import { Activities } from "../../modules/botkins-activity";
import { lookOf } from "@/data/botLook";
import { loadProviderUsage, providerUsageNow, watchProviderUsage } from "./providerUsage";
import { useApp } from "./store";
import { computerPart, sameSnapshot, type WidgetSnapshot, withComputer } from "./widgetData";

const QUIET_MS = 1500;
/** Plans and limits older than this are asked for again when the app comes to the front and a usage widget is on show. */
const USAGE_OLD_MS = 10 * 60_000;

let saved: WidgetSnapshot | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;

function snapshotNow(): WidgetSnapshot | undefined {
  const state = useApp.getState();
  const pairing = state.pairing;
  if (!pairing || !state.synced) return undefined;
  const part = computerPart({
    name: state.parts.meta?.name ?? pairing.name ?? "Your computer",
    bots: state.parts.bots ?? [],
    chats: state.parts.chats ?? [],
    runs: state.parts.runs ?? [],
    live: state.parts.live,
    defaultProvider: state.parts.settings?.model?.provider,
    models: state.models,
    usage: providerUsageNow(),
    look: lookOf,
    now: Date.now(),
  });
  return withComputer(saved, pairing.serverId, part, state.pairings.map((item) => item.serverId), Date.now());
}

function write() {
  if (timer) clearTimeout(timer);
  timer = null;
  const next = snapshotNow();
  if (!next || !Activities?.setWidgetData || sameSnapshot(saved, next)) return;
  saved = next;
  void Activities.setWidgetData(JSON.stringify(next)).catch(() => {});
}
const soon = () => {
  if (!timer) timer = setTimeout(write, QUIET_MS);
};

/** Asks the computer for plans and limits when a usage widget is on show and the last answer is old. */
async function freshUsage() {
  const meta = useApp.getState().parts.meta;
  if (!meta?.capabilities.includes("provider-usage-v1") || !Activities?.installedWidgets) return;
  const { fetchedAt, loading } = providerUsageNow();
  if (loading || (fetchedAt && Date.now() - fetchedAt < USAGE_OLD_MS)) return;
  try {
    if ((await Activities.installedWidgets()).includes("BotkinsUsage")) await loadProviderUsage();
  } catch {
    // The widget keeps the numbers it has, and says how old they are.
  }
}

let started = false;
/** Called once when the app starts. */
export async function startWidgets() {
  if (started || !Activities?.setWidgetData) return;
  started = true;
  try {
    const kept = await Activities.getWidgetData?.();
    if (kept) saved = JSON.parse(kept) as WidgetSnapshot;
  } catch {
    // Unreadable: the next write starts it afresh.
  }
  useApp.subscribe((state, before) => {
    if (state.parts.bots !== before.parts.bots || state.parts.chats !== before.parts.chats || state.parts.runs !== before.parts.runs || state.parts.live !== before.parts.live || state.models !== before.models || state.pairing !== before.pairing || state.synced !== before.synced) soon();
    if (state.synced && !before.synced) void freshUsage();
  });
  watchProviderUsage(soon);
  AppState.addEventListener("change", (next) => {
    if (next === "active") void freshUsage();
    else write();
  });
  soon();
}
