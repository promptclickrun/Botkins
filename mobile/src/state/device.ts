// Answering what bots ask of this phone (the "asks" part), and telling the computer this phone's
// device access switches. What a tool reads goes only into its answer: never into a log, a toast,
// the store or the activity list.
import { AppState } from "react-native";
import { runDeviceTool } from "@/device/run";
import { cleanSources, sameSources, toolOf } from "@/device/tools";
import type { DeviceAnswer, DeviceAsk } from "@/link/types";
import { loadDevicePrefs, recordActivity, useDevicePrefs } from "./devicePrefs";
import { api, wake } from "./link";
import { useApp } from "./store";

/** An ask older than this is left alone: the bot has given up on it, or is about to. */
// As long as the computer waits for a tool the person finishes by hand (HANDS_MS in link-host/device.mjs).
const MAX_AGE = 150_000;

const started = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

const deviceId = () => useApp.getState().pairing?.deviceId;
const supported = () => !!useApp.getState().parts.meta?.capabilities?.includes("device-v1");

/** The asks addressed to this phone that no one has started, oldest first. */
function waiting(now = Date.now()): DeviceAsk[] {
  const me = deviceId();
  if (!me) return [];
  const asks = useApp.getState().parts.asks ?? [];
  return asks
    .filter((ask) => ask && ask.deviceId === me && typeof ask.id === "string" && !started.has(ask.id) && now - ask.at < MAX_AGE)
    // A tool the person finishes on the phone waits for the app to be in front.
    .filter((ask) => !toolOf(ask.tool)?.hands || AppState.currentState === "active")
    .sort((a, b) => a.at - b.at);
}

const stillOpen = (id: string) => (useApp.getState().parts.asks ?? []).some((ask) => ask.id === id);

/** Sends an answer, trying again for a short while when the link is down. */
async function send(id: string, answer: DeviceAnswer): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await api["link.device.answer"](id, answer);
      return true;
    } catch {
      // Answered elsewhere, timed out on the computer, or the link is down.
      if (!stillOpen(id)) return false;
      if (useApp.getState().link !== "online") wake();
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  return false;
}

/** Runs one ask and answers it. Resolves true when the computer took the answer. */
async function handle(ask: DeviceAsk): Promise<boolean> {
  const answer = await runDeviceTool(ask.tool, ask.args, { askId: ask.id });
  // The computer may have given up while the tool ran (the app went behind, a slow fix).
  const sent = stillOpen(ask.id) ? await send(ask.id, answer) : false;
  const bot = ask.botId ? useApp.getState().parts.bots?.find((candidate) => candidate.id === ask.botId)?.name : undefined;
  recordActivity({
    id: ask.id,
    tool: ask.tool,
    botId: ask.botId,
    bot,
    at: Date.now(),
    ok: answer.ok && sent,
    error: !answer.ok ? answer.error : sent ? undefined : "The answer didn't reach your computer in time.",
  });
  return sent;
}

/** Starts every waiting ask, one at a time. Resolves with how many were answered. */
function pump(): Promise<number> {
  const asks = waiting();
  if (!asks.length) return queue.then(() => 0);
  for (const ask of asks) started.add(ask.id);
  // Keep the set of handled ids small: anything past two minutes is ignored anyway.
  if (started.size > 500) for (const id of [...started].slice(0, started.size - 300)) started.delete(id);
  const run = queue.then(async () => {
    let answered = 0;
    for (const ask of asks) if (await handle(ask).catch(() => false)) answered++;
    return answered;
  });
  queue = run.catch(() => 0);
  return run;
}

// ---- Telling the computer the switches

let lastSent: { serverId: string; json: string; at: number } | null = null;
let sending = false;

/** Sends this phone's switches when the computer's copy differs, or when told to. */
async function syncSources(force = false) {
  const state = useApp.getState();
  if (sending || state.link !== "online" || !state.pairing || !supported()) return;
  await loadDevicePrefs();
  const sources = cleanSources(useDevicePrefs.getState().sources);
  const json = JSON.stringify(sources);
  const theirs = state.parts.phones?.[state.pairing.deviceId]?.sources;
  const sameAsSent = lastSent?.serverId === state.pairing.serverId && lastSent.json === json;
  // The computer reports what it keeps; once it matches there is nothing to do. A copy that still
  // differs right after sending is the computer catching up, so it is given a few seconds.
  if (!force && state.parts.phones && sameSources(theirs, sources)) return;
  if (!force && sameAsSent && Date.now() - lastSent!.at < 8_000) return;
  if (!force && !state.parts.phones && sameAsSent) return;
  sending = true;
  try {
    await api["link.device.sources"](sources);
    lastSent = { serverId: state.pairing.serverId, json, at: Date.now() };
  } catch {
    // Sent again at the next change or connection.
  } finally {
    sending = false;
  }
  // A switch changed while this was on its way.
  if (JSON.stringify(cleanSources(useDevicePrefs.getState().sources)) !== json) void syncSources(true);
}

let begun = false;

/**
 * Starts answering asks addressed to this phone and keeping the computer's copy of its switches
 * current. Call once at app start; later calls do nothing.
 */
export function startDeviceAnswers() {
  if (begun) return;
  begun = true;
  void loadDevicePrefs().then(() => {
    void syncSources(true);
    void pump();
  });
  useApp.subscribe((state, before) => {
    if (state.parts.asks !== before.parts.asks || state.pairing !== before.pairing) void pump();
    // A new connection, a new computer, or the computer's copy changed.
    const connected = state.link === "online" && before.link !== "online";
    if (connected || state.pairing?.serverId !== before.pairing?.serverId || state.parts.meta !== before.parts.meta) void syncSources(connected);
    else if (state.parts.phones !== before.parts.phones) void syncSources();
  });
  useDevicePrefs.subscribe((state, before) => {
    if (state.sources !== before.sources) void syncSources(true);
  });
  // A mail waits for the app to come to the front.
  AppState.addEventListener("change", (next) => next === "active" && void pump());
}

/**
 * One pass over the asks waiting for this phone, for a background task woken by a push. Waits a
 * few seconds for the link when it is down. Resolves with how many it answered.
 */
export async function answerPendingAsks(): Promise<number> {
  await loadDevicePrefs();
  if (useApp.getState().link !== "online") {
    wake();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 10_000);
      const stop = useApp.subscribe((state) => state.link === "online" && done());
      function done() {
        clearTimeout(timer);
        stop();
        resolve();
      }
    });
  }
  // What is already running finishes first, then this pass.
  await queue;
  return pump();
}
