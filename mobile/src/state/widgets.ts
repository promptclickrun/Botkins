// Keeps the widgets' snapshot (src/state/widgetData.ts) up to date: while the app runs it is
// written a moment after anything a widget shows changes, and at once when the app goes to the
// background. The native side saves it in the App Group and asks iOS to draw the widgets again.
import { AppState } from "react-native";
import { Activities } from "../../modules/botkins-activity";
import { lookOf } from "@/data/botLook";
import { readPanels, readSpaceOnce, watchSpaceContents } from "@/features/spaces/data";
import { spaceTitle } from "@/features/spaces/logic";
import { loadProviderUsage, providerUsageNow, watchProviderUsage } from "./providerUsage";
import { useApp } from "./store";
import { computerPart, panelParts, sameSnapshot, type WidgetSnapshot, withComputer } from "./widgetData";

const QUIET_MS = 1500;
/** Plans and limits older than this are asked for again when the app comes to the front and a usage widget is on show. */
const USAGE_OLD_MS = 10 * 60_000;

let saved: WidgetSnapshot | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;

function snapshotNow(): WidgetSnapshot | undefined {
  const state = useApp.getState();
  const pairing = state.pairing;
  if (!pairing || !state.synced) return undefined;
  const bots = state.parts.bots ?? [];
  // A panel's widget ("spaces-v1"): the panels of the person's spaces, as the phone last read them.
  const spaces = state.parts.meta?.capabilities.includes("spaces-v1") ? (state.parts.spaces ?? []) : [];
  const part = computerPart({
    name: state.parts.meta?.name ?? pairing.name ?? "Your computer",
    panels: panelParts(spaces, readPanels(), bots, lookOf, spaceTitle, saved?.computers[pairing.serverId]?.panels),
    bots,
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
// With no Botkins widget on the Home Screen, Lock Screen or StandBy, the snapshot is written only
// when the app leaves the front (where adding a widget or a control reads its bots): it used to be
// worked out every 1.5 s while a bot worked whether or not anything showed it. Installed widgets are
// asked for again each time the app comes to the front, which is when a person who just added one returns.
let anyWidget: boolean | undefined;
async function checkWidgets() {
  try {
    anyWidget = Activities?.installedWidgets ? (await Activities.installedWidgets()).length > 0 : undefined;
  } catch {
    anyWidget = undefined;
  }
}
const soon = () => {
  if (anyWidget === false) return;
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

/** Reads the pinned spaces the phone has not read yet, when a panel's widget is on show: its panels are then up to date without the person opening each space. */
async function freshPanels() {
  const state = useApp.getState();
  if (!state.parts.meta?.capabilities.includes("spaces-v1") || !Activities?.installedWidgets) return;
  try {
    if (!(await Activities.installedWidgets()).includes("BotkinsPanel")) return;
    for (const space of (useApp.getState().parts.spaces ?? []).filter((one) => one.pinned).slice(0, 8)) readSpaceOnce(space.id);
  } catch {
    // The widget keeps the panels it has.
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
    if (state.parts.spaces !== before.parts.spaces) soon();
    if (state.synced && !before.synced) {
      void freshUsage();
      void freshPanels();
    }
  });
  watchProviderUsage(soon);
  watchSpaceContents(soon);
  AppState.addEventListener("change", (next) => {
    if (next === "active") {
      void checkWidgets().then(soon);
      void freshUsage();
      void freshPanels();
    // Always written on the way out: adding a widget or a control reads its list of bots from it.
    } else write();
  });
  await checkWidgets();
  soon();
}
