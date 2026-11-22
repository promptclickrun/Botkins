// The desktop's own voice (Settings › Voice, the composer's microphone and Live Voice button, and
// reading replies aloud). Everything that reaches a speech provider goes through the link's Voice
// (desktop/link/voice.mjs, see VOICE.md), so this computer and its paired phones share one set of
// choices and keys. This file only shapes what the page needs: plain data, never a key.
import { VoiceTurns } from "./link/voice-history.mjs";
import { Failure } from "./link/tools.mjs";
import { cleanBotVoice, effectiveTts, liveInstructions as sharedLiveInstructions, MAX_AUDIO, MAX_SPEAK } from "./link/voice.mjs";

/** The one tool a live voice has. The voice only talks; the bot does the work, as a normal turn in the chat. */
export const ASK_BOT = {
  name: "ask_bot",
  description:
    "Hands the person's request to the bot, which can use its tools, files and memory, and returns the bot's answer. Use it for new work: fresh or current information, anything to look up, do, change or remember. Not for what the conversation or your notes already answer.",
  parameters: {
    type: "object",
    properties: { request: { type: "string", description: "The request, in the person's own words." } },
    required: ["request"],
    additionalProperties: false,
  },
};
/** How much of a bot's reply a live voice gets back: about a minute or two of speech. */
export const SPOKEN_REPLY = 2000;
const FORMATS = ["wav", "m4a", "mp3", "webm"];
const NOT_READY = "Voice isn't ready yet. Try again in a moment.";
// A request waits behind at most this many turns that were already running in the chat.
const MAX_WAITS = 5;
const LIVE_CONTEXT_WAIT = 2000;

/** Plain text for speaking: Markdown marks, code blocks and link addresses left out. */
export function speakable(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " (The code is in the chat.) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<?https?:\/\/[^\s>]+>?/g, "a link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~>|#]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Where a sentence ends inside `text`, at or before `max`, else -1. */
function sentenceEnd(text, max) {
  let best = -1;
  const re = /[.!?…。！？](?:["'”’)\]]*)(?=\s|$)|\n/g;
  for (let m; (m = re.exec(text)) && m.index < max; ) best = m.index + m[0].length;
  return best;
}

/** `text` in parts of at most `max` characters, each ending at a sentence end where one is near. */
export function splitSentences(text, max = MAX_SPEAK) {
  const parts = [];
  let rest = String(text ?? "").trim();
  while (rest.length > max) {
    let cut = sentenceEnd(rest, max);
    if (cut < max / 3) {
      const space = rest.lastIndexOf(" ", max);
      cut = space > max / 3 ? space : max;
    }
    const part = rest.slice(0, cut).trim();
    if (part) parts.push(part);
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** The start of `text` up to `max` characters, cut at a sentence end, and said to be cut short. */
export function cutForSpeech(text, max = SPOKEN_REPLY) {
  const all = String(text ?? "").trim();
  if (all.length <= max) return all;
  const note = " The rest is in the chat.";
  const room = max - note.length;
  let cut = sentenceEnd(all, room);
  if (cut < room / 3) {
    const space = all.lastIndexOf(" ", room);
    cut = space > room / 3 ? space : room;
  }
  return all.slice(0, cut).trim() + note;
}

/** What a voice is told about the bot it speaks for. */
export function liveInstructions(bot, profile = "") {
  const name = String(bot?.name ?? "the bot").slice(0, 80);
  const about = [bot?.role, bot?.instructions].filter(Boolean).join("\n\n");
  const defaults = [
    "You are the voice of " + name + ", a bot the person works with. Speak as " + name + ", in the first person, warmly and briefly: this is a spoken conversation, so no lists, no Markdown, and one or two sentences unless asked for more. Never say that you are ChatGPT, Gemini or another assistant.",
    "You only do the talking. For anything beyond small talk (a question about their work, anything to look up, do, remember or change, or anything that needs " +
      name +
      "'s memory, tools or files), call the ask_bot tool once with the request in the person's own words, wait for the result, and then tell them what it answered in your own words. Never make up what the bot would say.",
    "Sometimes the tool answers that " +
      name +
      " needs the person's approval, has a question for them, or is still working. Say exactly that, and that the request is on their screen: you can't approve or answer for them, and you don't call the tool again for the same request. When you are then told that " +
      name +
      " has answered, tell the person what it said.",
    "Speak the language the person speaks.",
  ].join("\n\n");
  const prompt = [defaults, profile, about && "The person's instructions for this bot take precedence over Botkins conversational defaults and profile notes.\n" + about].filter(Boolean).join("\n\n");
  if (prompt.length <= 20_000) return prompt;
  // The realtime provider has a smaller instruction budget than a chat. The bot can apply
  // its full instructions when it answers through ask_bot.
  return defaults + "\nFor every spoken request, including small talk, call ask_bot and speak its reply in its own words so the person's full custom instructions are followed.";
}

export class VoiceDesk {
  /**
   * @param options.voice      () => the link's Voice (link.voice), or null before the link is made.
   * @param options.workspace  () => the Workspace: chat(id), bot(id), active, send(chatId, text).
   * @param options.dictate    () => void: starts the system's own dictation (macOS only), or undefined.
   * @param options.platform   process.platform, for what this computer can do by itself.
   * @param options.refresh    async () => void, run before the settings are read (the Codex sign-in check).
   * @param options.say        async (sessionId, text) => boolean: puts words into a live session outside a
   *                           tool call, for the voice to say (the answer to a request that outlasted its
   *                           tool call). False when that session can't be told.
   * @param options.handoffMs  How long a tool call waits on the bot before the voice is told the bot is
   *                           still at work, and the answer follows by `say`.
   */
  constructor({ voice, workspace, liveContext, dictate, platform = process.platform, refresh, say, handoffMs = 45_000, log = () => {} } = {}) {
    Object.assign(this, { voiceOf: voice, workspaceOf: workspace, liveContextOf: liveContext, dictate, platform, refresh, say, handoffMs, log });
    // Live sessions: id → { chatId, own?, turn? }. `turn` is a request to the bot that outlasted its
    // tool call: { done, reply?, following }.
    this.sessions = new Map();
    this.waiters = new Map();
  }
  get voice() {
    const voice = this.voiceOf?.() ?? null;
    if (!voice) throw new Failure(NOT_READY);
    return voice;
  }
  /** Whether this computer has dictation of its own that Botkins can start. */
  get deviceStt() {
    return this.platform === "darwin" && typeof this.dictate === "function";
  }

  /** The choices (never a key), whether voice can be changed here, and what this computer does itself. */
  async settings() {
    await Promise.resolve(this.refresh?.()).catch(() => {});
    const voice = this.voiceOf?.() ?? null;
    const device = { stt: this.deviceStt, tts: true };
    if (!voice) return { ...emptySettings(), ready: false, problem: NOT_READY, device };
    const problem = typeof voice.locked === "string" ? voice.locked : "";
    return { ...voice.settings(), ready: !problem, ...(problem && { problem }), device };
  }
  async set(patch) {
    this.voice.set(patch ?? {});
    return this.settings();
  }
  /** Saves (a string) or removes (null) a provider's key. The answer says only whether one is saved. */
  async setKey(provider, key) {
    if (key != null && (typeof key !== "string" || !key.trim() || key.length > 4000)) throw new Failure("Paste the key to save it.");
    this.voice.setKey(provider, key == null ? null : key.trim());
    return this.settings();
  }
  options(kind, provider) {
    return this.voice.options(kind, provider);
  }

  /** A recording made in the page, as text. */
  async transcribe(bytes, format, language) {
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Failure("There was nothing to hear. Try again.");
    if (bytes.byteLength > MAX_AUDIO) throw new Failure("That recording is over 25 MB.");
    if (!FORMATS.includes(format)) throw new Failure("That recording's format isn't supported.");
    const audio = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const { text } = await this.voice.transcribe({ audio, format, ...(typeof language === "string" && language && { language }) });
    return { text: String(text ?? "").trim() };
  }

  /**
   * Text as speech. With "This computer" chosen the page speaks it with the system's voices
   * ({ device: true }); otherwise the audio, in parts of up to 4,000 characters.
   */
  async speak(text, { voice, speed, botId } = {}) {
    const words = speakable(text);
    if (!words) throw new Failure("There is nothing to read aloud.");
    const settings = this.voice.settings();
    // A bot's own voice ("bot-voice-v1") over the shared one: it may name another provider, or "This computer".
    const override = this.botVoice(botId)?.tts;
    if (effectiveTts(settings.tts, override).provider === "device") return { device: true };
    if (words.length > MAX_SPEAK * 10) throw new Failure("That is too long to read aloud.");
    const parts = [];
    for (const part of splitSentences(words, MAX_SPEAK)) {
      const spoken = await this.voice.speak({ text: part, ...(voice && { voice }), ...(speed != null && { speed }), ...(override && { override }) });
      parts.push({ audio: new Uint8Array(spoken.audio), format: spoken.format });
    }
    return { parts };
  }

  /** A bot's own voice as saved on the bot (checked again here), or null. An unknown bot has none. */
  botVoice(botId) {
    if (typeof botId !== "string" || !botId) return null;
    try {
      return cleanBotVoice(this.workspaceOf?.()?.state.bots.find((bot) => bot.id === botId)?.voice);
    } catch {
      return null;
    }
  }

  /** Starts the system's dictation into the focused text field. { started: false } where there is none. */
  startDictation() {
    if (!this.deviceStt) return { started: false, platform: this.platform };
    this.dictate();
    return { started: true, platform: this.platform };
  }

  // ── Live voice ──────────────────────────────────────────────────────────────────────────────

  /**
   * The app's bounded identity/user notes for this chat. A missing hook, a throw or a slow read
   * leaves the voice with the chat and bot alone; this mirrors the link host's optional hook.
   */
  async liveNotes(chatId, botId) {
    const workspace = this.workspaceOf();
    const read = this.liveContextOf ?? workspace?.liveContext;
    if (typeof read !== "function") return {};
    let timer;
    try {
      const notes = await Promise.race([
        Promise.resolve(read({ chatId, botId })),
        new Promise((resolve) => (timer = setTimeout(() => resolve(null), LIVE_CONTEXT_WAIT))),
      ]);
      if (!notes || typeof notes !== "object" || Array.isArray(notes)) return {};
      return Object.fromEntries(["userName", "identity", "user"].filter((key) => typeof notes[key] === "string").map((key) => [key, notes[key]]));
    } catch {
      this.log("voice: the app's notes for a live call could not be read");
      return {};
    } finally {
      clearTimeout(timer);
    }
  }

  /** Opens a live session for a chat with its bot. `sdp` is the page's WebRTC offer (OpenAI and Codex). */
  async startLive(chatId, { sdp } = {}) {
    const workspace = this.workspaceOf();
    const chat = workspace.chat(String(chatId));
    const botId = chat.botId ?? chat.botIds?.[0];
    const bot = workspace.state.bots.find((b) => b.id === botId);
    if (!bot) throw new Failure("That chat's bot is gone.");
    // The Codex helper names the bot to its voice (desktop/codexvoice.mjs).
    this.startingBot = bot.name;
    this.startingChat = chat.id;
    this.starting = (this.starting ?? 0) + 1;
    let session;
    try {
      const contextReader = this.liveContextOf ?? workspace.liveContext;
      // Keep the old no-hook path synchronous: callers can receive the live session immediately,
      // while the optional app context is the only thing that may add the bounded wait.
      const notes = typeof contextReader === "function" ? await this.liveNotes(chat.id, bot.id) : {};
      // Only actual conversation messages are carried into voice. Interim updates, secure-input
      // receipts and command/step records stay in the desktop chat, never in provider context.
      const messages = (chat.messages ?? []).filter((message) => message?.answer?.kind !== "secure");
      const instructions = sharedLiveInstructions({ bot, messages, bots: workspace.state.bots ?? [], notes });
      // `about` reaches the Codex helper, which names the bot to its voice and says whose chat the session is for (noteSession).
      session = await this.voice.live({ ...(typeof sdp === "string" && sdp && { sdp }), instructions, tools: [ASK_BOT], about: { chatId: chat.id, botId: bot.id, botName: bot.name }, override: cleanBotVoice(bot.voice)?.live });
      const entry = this.sessions.get(session.id) ?? {};
      this.sessions.set(session.id, Object.assign(entry, { chatId: chat.id, own: true }));
    } finally {
      this.starting--;
      // Tool calls that came in while it started: their session is known now, or never will be.
      for (const list of this.waiters.values()) for (const resolve of list) resolve();
      this.waiters.clear();
    }
    return { ...session, tools: [ASK_BOT] };
  }

  /**
   * Told by the Codex helper which chat a session it started is for. A phone's session starts in
   * the link, not here, and its tool calls still arrive on this computer: this is how they find
   * their chat. A chat that isn't one of this workspace's is not taken.
   */
  noteSession(sessionId, { chatId, author } = {}) {
    const id = String(sessionId ?? "");
    if (!id || typeof chatId !== "string" || !this.workspaceOf().state.chats.some((chat) => chat.id === chatId)) return false;
    // The window's own session is one that is being started here, for this chat, right now.
    this.sessions.set(id, { chatId, author, own: !author && (this.starting ?? 0) > 0 && chatId === this.startingChat });
    // A session that ended without saying so is not kept for ever.
    for (const old of [...this.sessions.keys()].slice(0, Math.max(0, this.sessions.size - 64))) this.sessions.delete(old);
    for (const resolve of this.waiters.get(id) ?? []) resolve();
    this.waiters.delete(id);
    return true;
  }
  /** True for a session this window started (not one the link started for a phone). */
  isOwn(sessionId) {
    return this.sessions.get(String(sessionId ?? ""))?.own === true;
  }
  /** Codex and the window send deltas or whole revisions, sometimes interleaved across speakers. */
  heard(id, text, final, { role = "user", item, replace, started } = {}) {
    const session = this.sessions.get(id);
    if (!session || typeof text !== "string" || typeof final !== "boolean" || !["assistant", "user"].includes(role)) return;
    const ws = this.workspaceOf();
    if (!ws.state.chats.some(chat => chat.id === session.chatId) || (session.author && !ws.inChat(session.chatId, session.author.memberId))) return;
    const turns = session.speech ??= new VoiceTurns(id);
    const lane = (session[role] ??= { number: 1, partial: new Map(), finished: new Set() });
    const named = typeof item === "string" && item.length > 0 && item.length <= 128;
    const key = named ? "item-" + item : String(lane.number);
    if (lane.finished.has(key) && !(role === "assistant" && final && replace)) return;
    if (started) {
      if (role === "user") turns.start(key);
      else turns.output(key);
      if (!text) return;
    }
    const previous = lane.partial.get(key)?.text ?? "";
    const words = (final ? text || previous : replace ? text : previous + text).slice(0, 32000);
    if (!words.trim()) return;
    const voiceId = role === "user" ? turns.input(key) : id + ":assistant-" + key;
    const options = role === "assistant" ? turns.output(key) : undefined;
    ws.recordVoiceLine(session.chatId, voiceId, words, final, session.author, options);
    if (final) {
      lane.partial.delete(key);
      if (named) lane.finished.add(key);
      else lane.number++;
      if (role === "assistant") turns.finishOutput(key);
    } else {
      lane.partial.set(key, { text: words, item });
    }
  }
  /** A session is over. Keep the last words even if the provider has not sent a final. */
  forget(sessionId) {
    const id = String(sessionId ?? "");
    const session = this.sessions.get(id);
    for (const role of ["user", "assistant"]) {
      for (const { text, item } of session?.[role]?.partial.values() ?? []) this.heard(id, text, true, { role, item });
    }
    this.sessions.delete(id);
  }
  /** The session's chat. A tool call can come in (from Codex) just before startLive has returned. */
  async sessionOf(sessionId) {
    if (!this.sessions.has(sessionId) && this.starting > 0) {
      await new Promise((resolve) => {
        const list = this.waiters.get(sessionId) ?? [];
        list.push(resolve);
        this.waiters.set(sessionId, list);
        setTimeout(resolve, 10_000).unref?.();
      });
    }
    const known = this.sessions.get(sessionId);
    if (!known) throw new Failure("That live voice session has ended.");
    return known;
  }

  /**
   * Runs a tool the live voice called. `ask_bot` sends the request to the chat as the person's
   * message, a normal turn with the chat's own history, tools and approvals, and resolves with
   * the bot's reply, cut to a length that suits speech.
   *
   * A turn can outlast the tool call: the bot stops to ask the person something (an approval, a
   * question), or simply works for a long time. The voice is not left silent. The tool call then
   * answers at once with what is going on ("Pip needs your approval before it can go on: …"),
   * the request is on screen where the person answers it, and when the turn ends the voice is
   * told the bot's reply (`say`). A voice that can't be told keeps the reply for its next call.
   */
  async liveTool(sessionId, name, args) {
    const id = String(sessionId);
    const entry = await this.sessionOf(id);
    if (name !== ASK_BOT.name) throw new Failure("The voice asked for a tool it doesn't have.");
    const { chatId } = entry;
    const workspace = this.workspaceOf();
    if (entry.author && !workspace.inChat(chatId, entry.author.memberId)) throw new Failure("This chat is no longer shared with you.");
    const chat = workspace.chat(chatId);
    const botName = workspace.state.bots.find((bot) => bot.id === (chat.botId ?? chat.botIds?.[0]))?.name ?? "The bot";
    // A request from earlier in this session: its reply is waiting to be said, or it is still under way.
    if (entry.turn) {
      if (entry.turn.reply !== undefined) {
        const text = entry.turn.reply;
        entry.turn = null;
        return text;
      }
      return this.follow(id, entry, botName);
    }
    const request = String(args?.request ?? args?.message ?? "").trim().slice(0, 32000);
    if (!request) return "The request was empty.";
    const voiceId = (entry.speech ??= new VoiceTurns(id)).claim();
    let before = 0;
    let requestRunId;
    let done;
    for (let waits = 0; ; waits++) {
      const running = workspace.active.get(chatId);
      if (running) {
        if (waits >= MAX_WAITS) throw new Failure("The bot is still busy. Try again in a moment.");
        await Promise.resolve(running.done).catch(() => {});
        continue;
      }
      before = chat.messages.length;
      try {
        done = Promise.resolve(workspace.send(chatId, request, { voiceId, ...(entry.author && { author: entry.author }) }));
        const sent = chat.messages.findLast(message => message.voiceId === voiceId);
        requestRunId = (sent || chat.messages[before])?.runId;
        break;
      } catch (error) {
        // Another message started the chat in between: wait for it, then send.
        if (workspace.active.has(chatId) && waits < MAX_WAITS) continue;
        throw error;
      }
    }
    const reply = () => {
      const said = chat.messages.slice(before).findLast((m) => m.role === "assistant" && !m.interim && m.text && (!requestRunId || m.runId === requestRunId));
      if (said) return cutForSpeech(speakable(said.text), SPOKEN_REPLY);
      // No reply: the run says why, when it knows.
      const run = (workspace.state.runs ?? []).find((r) => r.chatId === chatId && r.id === requestRunId);
      const why = run && run.status !== "Completed" && run.detail ? cutForSpeech(speakable(run.detail), 300) : "";
      return why ? botName + " couldn't finish that: " + why : "The bot didn't answer that. Its reply, if any, is in the chat.";
    };
    entry.turn = { done: done.then(reply, (error) => botName + " couldn't do that: " + cutForSpeech(speakable(error?.message ?? "something went wrong"), 300)), reply: undefined, following: false };
    return this.follow(id, entry, botName);
  }
  /** A request for the person that is waiting in a chat right now, or null. */
  waitingOn(chatId) {
    try {
      return (this.workspaceOf().interactions?.snapshot?.() ?? []).find((request) => request.chatId === chatId) ?? null;
    } catch {
      return null;
    }
  }
  /** Waits on a request to the bot with the voice: for its reply, or for the moment the voice should say something else. */
  async follow(id, entry, botName) {
    const turn = entry.turn;
    const workspace = this.workspaceOf();
    let stop = () => {};
    let timer;
    // The bot stops for the person: a request that is there already, or the next one in this chat.
    const asked = new Promise((resolve) => {
      const there = this.waitingOn(entry.chatId);
      if (there) return resolve({ request: there });
      const heard = (request) => request?.chatId === entry.chatId && resolve({ request });
      workspace.events?.on?.("request", heard);
      stop = () => workspace.events?.off?.("request", heard);
    });
    const long = new Promise((resolve) => (timer = setTimeout(() => resolve({ long: true }), this.handoffMs)));
    const first = await Promise.race([turn.done.then((text) => ({ text })), asked, long]);
    stop();
    clearTimeout(timer);
    if (first.text !== undefined) {
      if (entry.turn === turn) entry.turn = null;
      return first.text;
    }
    // The turn goes on without this tool call. When it ends, the voice is told what the bot said.
    if (!turn.following) {
      turn.following = true;
      void turn.done.then(async (text) => {
        if (entry.turn !== turn || this.sessions.get(id) !== entry) return;
        const told = await Promise.resolve(this.say?.(id, botName + " has now answered the request from a moment ago. Tell the person this, as " + botName + ": " + text)).catch(() => false);
        if (entry.turn !== turn) return;
        // A voice that couldn't be told gets the reply with its next call.
        if (told) entry.turn = null;
        else turn.reply = text;
      });
    }
    if (first.request) {
      const what = cutForSpeech(speakable(first.request.title ?? ""), 200);
      const lead = first.request.kind === "permission" ? botName + " needs your approval before it can go on" : botName + " has a question for you";
      return lead + (what ? ": " + what : ".") + " It is on screen in the chat, where you can answer it. I can't answer it for you. I will tell you what " + botName + " says once you have.";
    }
    return botName + " is still working on it. I will tell you when it is done.";
  }

  endLive(sessionId) {
    const id = String(sessionId ?? "");
    this.forget(id);
    this.voiceOf?.()?.endLive(id);
  }
  /** Ends every live session (when the app quits). */
  close() {
    for (const id of [...this.sessions.keys()]) this.endLive(id);
  }
}

/** The settings' shape before the link is made, so the page always has something to draw. */
function emptySettings() {
  return {
    stt: { provider: "device" },
    tts: { provider: "device", speed: 1, auto: false },
    live: { provider: null },
    providers: {
      openai: { baseUrl: "https://api.openai.com/v1", hasKey: false },
      azure: { kind: "openai", hasKey: false },
      elevenlabs: { hasKey: false },
      gemini: { hasKey: false },
      custom: { hasKey: false },
      local: { available: false, models: [] },
      codex: { available: false, signedIn: false },
    },
  };
}
