// Talking with a bot by turns, on the one voice button: the phone listens, what was said is sent to
// the chat as a normal message, the bot's reply is read aloud, and the phone listens again. It uses
// the dictation and the reading aloud chosen in Settings › Voice. Live voice, when it is on, takes
// the button instead (full duplex; see Live.tsx).
//
// One talk at a time, app-wide. It ends when the person ends it, when nothing is said twice in a
// row, when the bot needs an answer on the screen, or when the chat's screen closes.
import { create } from "zustand";
import { showToast } from "@/state/store";
import { chatAccess } from "./chatAccess";
import { canListen, type Handlers, listen, type Session } from "./dictation";
import { askBot } from "./live/askBot";
import { LOOK_AT_PHONE, NO_REPLY, STILL_WORKING } from "./live/askBot";
import { sttProvider } from "./state";
import { speakText, stopSpeech, useSpeakingNow } from "./tts";

export type TalkPhase = "off" | "listening" | "sending" | "waiting" | "speaking";
export const useTalk = create<{ chatId: string | null; phase: TalkPhase; heard: string; level: number }>(() => ({ chatId: null, phase: "off", heard: "", level: 0 }));

/** How long a pause ends what the person is saying. */
const PAUSE_MS = 1700;
/** How long the phone listens for a first word before it gives the turn up. */
const NOTHING_MS = 12_000;
/** The longest one turn of speech is listened to. */
const LONGEST_MS = 90_000;
/** A recording's level (0 to 1) that counts as speech; a quiet room sits well under it. */
const LOUD = 0.5;

let generation = 0;
let session: Session | null = null;

export const canTalk = canListen;

/** Starts talking in a chat (ending a talk somewhere else). */
export function startTalk(chatId: string) {
  endTalk();
  if (!canListen()) {
    showToast("This needs the newest Botkins app.", "error");
    return;
  }
  const mine = ++generation;
  useTalk.setState({ chatId, phase: "listening", heard: "", level: 0 });
  void loop(chatId, () => generation === mine);
}

/** Ends the talk: stops listening and stops what is being read. */
export function endTalk() {
  generation++;
  session?.cancel();
  session = null;
  if (useTalk.getState().phase !== "off") stopSpeech();
  useTalk.setState({ chatId: null, phase: "off", heard: "", level: 0 });
}

/** While the reply is read: stop reading and listen again. */
export function skipToListening() {
  if (useTalk.getState().phase === "speaking") stopSpeech();
}

async function loop(chatId: string, alive: () => boolean) {
  let silent = 0;
  while (alive()) {
    useTalk.setState({ phase: "listening", heard: "", level: 0 });
    const said = await hearOnce(alive);
    if (!alive()) return;
    if (!said) {
      // Nothing was said: once more, then the talk ends by itself.
      if (++silent >= 2) break;
      continue;
    }
    silent = 0;
    useTalk.setState({ phase: "waiting", heard: said, level: 0 });
    const reply = await askBot(said, chatAccess(chatId));
    if (!alive()) return;
    if (reply.startsWith("The message didn't reach the bot")) {
      showToast("That didn't reach your computer.", "error");
      break;
    }
    useTalk.setState({ phase: "speaking" });
    if (reply === LOOK_AT_PHONE) {
      // The bot asked for an approval or an answer: it is on the screen, and the talk stops for it.
      await say("I need your answer on the screen.", alive);
      break;
    }
    await say(reply === NO_REPLY ? "Done." : reply === STILL_WORKING ? "I'm still working on it. The answer will be in the chat." : reply, alive);
  }
  if (alive()) endTalk();
}

/** Listens for one turn of speech. Resolves with what was said, or "" when nothing was. */
function hearOnce(alive: () => boolean): Promise<string> {
  return new Promise((resolve) => {
    const onPhone = sttProvider() === "device";
    const finals: string[] = [];
    let partial = "";
    let spoke = false;
    let lastLoud = 0;
    let done = false;
    let pause: ReturnType<typeof setTimeout> | null = null;
    const text = () => [...finals, partial].join(" ").replace(/\s+/g, " ").trim();
    const finish = () => {
      if (done) return;
      done = true;
      if (pause) clearTimeout(pause);
      clearTimeout(nothing);
      clearTimeout(longest);
      session = null;
      resolve(text());
    };
    const handlers: Handlers = {
      onText: (heard, final) => {
        if (final) {
          if (heard.trim()) finals.push(heard.trim());
          partial = "";
        } else partial = heard;
        if (done) return;
        spoke = true;
        useTalk.setState({ heard: text() });
        // The phone's recognizer keeps listening; a pause in the words ends the turn.
        if (onPhone) {
          if (pause) clearTimeout(pause);
          pause = setTimeout(() => session?.stop(), PAUSE_MS);
        }
      },
      setLevel: (level) => {
        if (done) return;
        useTalk.setState({ level });
        // A recording has no words yet: its loudness says when the person spoke and when they stopped.
        if (onPhone) return;
        const now = Date.now();
        if (level >= LOUD) {
          spoke = true;
          lastLoud = now;
        } else if (spoke && now - lastLoud > PAUSE_MS) session?.stop();
      },
      quiet: () => {
        if (!done) useTalk.setState({ phase: "sending", level: 0 });
      },
      ended: finish,
    };
    const nothing = setTimeout(() => {
      if (!spoke) session?.cancel();
    }, NOTHING_MS);
    const longest = setTimeout(() => session?.stop(), LONGEST_MS);
    void listen(handlers).then(
      (started) => {
        if (!started) return finish();
        if (done || !alive()) return started.cancel();
        session = started;
      },
      () => finish(),
    );
  });
}

/** Reads `text` aloud and resolves when it is over (or was stopped). */
function say(text: string, alive: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const id = "talk:" + Date.now();
    let started = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      off();
      clearTimeout(never);
      clearTimeout(limit);
      resolve();
    };
    const check = () => {
      const now = useSpeakingNow.getState().id;
      if (now === id) started = true;
      else if (started || !alive()) finish();
    };
    const off = useSpeakingNow.subscribe(check);
    // A voice that never starts (no sound on this build) must not hold the talk.
    const never = setTimeout(() => {
      if (!started) finish();
    }, 6000);
    const limit = setTimeout(finish, 10 * 60_000);
    speakText(id, text, { quiet: true });
    check();
  });
}
