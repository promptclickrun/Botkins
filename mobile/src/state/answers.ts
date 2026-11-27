// Answers given outside the app: a Live Activity's buttons, the Dynamic Island's, and a
// notification's actions (docs/live-cards.md, section 7).
//
// Each lands in a queue the native side keeps (modules/botkins-activity: the App Intents in
// targets/widgets/_shared and the notification actions put it there), so an answer given while the app
// was closed is not lost. This file sends each one the way the request panel does, then tells the
// native side how it went: the card shows "Sent", or gets its buttons back.
import { Activities, type QueuedAnswer } from "../../modules/botkins-activity";
import { answerCall } from "./answerCall";
import { api, freshSync, restIfAway, switchComputer } from "./link";
import { useApp } from "./store";
import { idForHost } from "./unified";

const latestRun = (chatId: string) =>
  (useApp.getState().parts.runs ?? []).filter((run) => run.chatId === chatId).reduce<{ id: string; time: number } | undefined>((latest, run) => (!latest || run.time > latest.time ? run : latest), undefined)?.id;

const sending = new Set<string>();

/** Sends one answer. It stays queued when the computer can't be reached, and is dropped when the computer refuses it. */
async function send(answer: QueuedAnswer) {
  if (sending.has(answer.id) || !Activities?.answered) return;
  sending.add(answer.id);
  try {
    // An answer to another paired computer's request uses that computer, unless it is already live in unified mode.
    const { pairing, pairings, unified, unifiedHosts } = useApp.getState();
    const inUnifiedPool = !!unified && !!answer.host && unifiedHosts.some((h) => h.id === answer.host && h.included);
    if (!inUnifiedPool && answer.host && answer.host !== pairing?.serverId && pairings.some((item) => item.serverId === answer.host)) {
      await switchComputer(answer.host);
    }
    // Woken in the background, the link may be at rest: follow until the computer has answered once.
    if (!(await freshSync(15_000))) return; // Not reached: kept for the next time.
    const primaryId = useApp.getState().pairing?.serverId ?? null;
    const scope = (id: string) => (inUnifiedPool && answer.host ? idForHost(answer.host, id, primaryId) : id);
    const call = answerCall(answer, (cid) => latestRun(scope(cid)));
    if (!call) {
      await Activities.answered(answer.id, false);
      return;
    }
    try {
      if (call.method === "respond") await api.respond(scope(call.requestId), call.answer);
      else if (call.method === "stop") await api.stop(scope(call.chatId));
      else await api.retry(scope(call.runId));
      await Activities.answered(answer.id, true);
    } catch {
      // Refused (the request was answered elsewhere, or is gone): the card gets its buttons back,
      // and the computer's next update shows where things stand.
      await Activities.answered(answer.id, false);
    }
  } finally {
    sending.delete(answer.id);
    restIfAway();
  }
}

/** Sends every answer waiting in the queue. Called when the app starts, comes to the front, or the computer is reached. */
export async function sendAnswers() {
  if (!Activities?.takeAnswers) return;
  try {
    for (const answer of await Activities.takeAnswers()) void send(answer);
  } catch {
    // An older build of the native part has no queue.
  }
}

let started = false;
/** Listens for answers given while the app runs. */
export function startAnswers() {
  if (started || !Activities?.takeAnswers) return;
  started = true;
  Activities.addListener("answer", (answer) => void send(answer));
  void sendAnswers();
}
