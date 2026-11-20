// The dashboard (`botkins tui`): what the service is doing, on one screen, driven by the keyboard.
//
// It is a client of the control socket like every other command: it asks the service for what it
// shows and for what a key does, and never opens the data folder itself. The screen is drawn by
// cli/tui/view.mjs from one `state`; this file keeps that state up to date and turns keys into calls.
//
// Why no library. A terminal interface library such as Ink brings React and a layout engine:
// several megabytes more in every install, and tens of megabytes of memory in a process that
// only draws a few lists. The host this runs on may have 1 GB in all. The screen here is a
// header, six lists and a line of keys, so it is drawn with plain escape sequences and Node's own
// key events, with no dependency.
import { emitKeypressEvents } from "node:readline";
import { KEYS, render, TABS } from "./view.mjs";

const MAX_LOGS = 2000;
const CSI = "\u001b[";

/**
 * @param options.client  The service (desktop/terminal/socket.mjs controlClient).
 * @param options.write   (text) → the terminal.
 * @param options.size    () → { width, height }.
 * @param options.colors  False for a terminal without them.
 * @returns { state, start(), stop(), key(input), refresh(), frame(), idle() }
 */
export function createApp({ client, write, size, colors = true, now = () => Date.now() }) {
  const state = { tab: "Overview", selected: 0, logs: [], follow: true, scroll: 0, now: now() };
  let running = false;
  let revision = 0;
  let logCursor = 0;
  const busy = new Set();
  const track = (promise) => {
    busy.add(promise);
    promise.finally(() => busy.delete(promise));
    return promise;
  };

  const frame = () => render({ ...state, now: now() }, size(), { colors });
  let last = "";
  const draw = () => {
    if (!running) return;
    const text = frame().join("\r\n");
    if (text === last) return;
    last = text;
    // Home, then the whole screen: no flicker, because every line is as wide as the terminal.
    write(CSI + "H" + text);
  };
  const say = (message) => {
    Object.assign(state, { message, error: "" });
    draw();
  };
  const fail = (error) => {
    Object.assign(state, { error: String(error?.message ?? error), message: "" });
    draw();
  };
  /** The list the selection moves in, on this tab. */
  const list = () => ({ Devices: state.devices, Bots: state.bots, Chats: state.chats, Routines: state.routines })[state.tab] ?? [];
  const chosen = () => list()[state.selected];

  /** Everything the screen shows, asked for at once. */
  async function refresh() {
    try {
      const [status, providers, devices, bots, chats, routines, runs] = await Promise.all([client.call("status"), client.call("providers.list"), client.call("devices.list"), client.call("bots.list"), client.call("chat.list"), client.call("routines.list"), client.call("runs.list", 10)]);
      // A phone that appeared while a pairing code is on screen: the code did its work.
      if (state.overlay?.kind === "pair" && state.devices && devices.length > state.devices.length) {
        const added = devices.find((device) => !state.devices.some((known) => known.id === device.id));
        state.overlay = null;
        state.message = "Paired: " + (added?.name ?? "a device");
      }
      Object.assign(state, { status, providers, devices, bots, chats: [...chats].reverse(), routines, runs, offline: false });
      state.selected = Math.max(0, Math.min(state.selected, list().length - 1));
    } catch (error) {
      if (error.code === "NOT_RUNNING") Object.assign(state, { offline: true, status: null });
      else state.error = error.message;
    }
    draw();
  }
  /** The chat being read, kept up to date while its bot is writing. */
  async function follow(chatId) {
    let seen;
    while (running && state.reading?.chatId === chatId) {
      try {
        const view = await client.call("chat.read", chatId, { after: Math.max(0, (state.reading.count ?? 0) - 30), wait: seen !== undefined, seen });
        if (state.reading?.chatId !== chatId) return;
        seen = view.seen;
        Object.assign(state.reading, { messages: view.messages.slice(-30), working: view.working, stream: view.stream, count: view.count });
        draw();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }
  function read(chat) {
    state.reading = { chatId: chat.id, title: chat.title, bot: chat.bot, messages: [], count: chat.messages };
    draw();
    // Not one of the things a key waits for: it goes on for as long as the chat is on screen.
    void follow(chat.id);
  }
  /** A question at the bottom of the screen. Resolves with what was typed, or null for esc. */
  const ask = (question, value = "") =>
    new Promise((resolve) => {
      state.prompt = { question, value, resolve };
      draw();
    });
  const confirm = async (question) => /^y(es)?$/i.test(((await ask(question + " (y/n)")) ?? "").trim());

  // What each key does. Each is one call to the service, then a look at what changed.
  const actions = {
    async pair() {
      const pairing = await client.call("pair.start");
      state.overlay = { kind: "pair", lines: [...pairing.qr.split("\n"), "", "Code   " + pairing.code, "Link   " + pairing.url, "", "Scan the code with Botkins on the phone, or type the address and the code. It works once, until " + new Date(pairing.expiresAt).toLocaleTimeString() + ".", "Waiting for the phone… (esc closes this; the code stays open)"] };
    },
    async relay() {
      const relay = await client.call("relay.set", !state.status.relay.enabled);
      say("The relay is " + (relay.enabled ? "on." : "off."));
    },
    async rename() {
      const device = chosen();
      const name = device && (await ask("New name for " + device.name + ":", device.name));
      if (name?.trim()) say("Renamed to " + (await client.call("devices.rename", device.id, name.trim())).name + ".");
    },
    async person() {
      const device = chosen();
      const person = device && (await ask("Who uses " + device.name + "?", device.person ?? ""));
      if (person !== null && device) say((await client.call("devices.setPerson", device.id, person.trim())).person ? device.name + " is " + person.trim() + "'s." : device.name + " has no person's name.");
    },
    async unpair() {
      const device = chosen();
      if (device && (await confirm("Unpair " + device.name + "?"))) say("Unpaired " + (await client.call("devices.remove", device.id)).name + ".");
    },
    async addBot() {
      const name = await ask("Name of the new bot:");
      if (!name?.trim()) return;
      const role = await ask("Its role, in a few words:", "Assistant");
      if (role === null) return;
      say("Added " + (await client.call("bots.add", { name: name.trim(), role: role.trim() || "Assistant" })).name + ".");
    },
    async editBot() {
      const bot = chosen();
      if (!bot) return;
      const name = await ask("Name:", bot.name);
      if (name === null) return;
      const role = await ask("Role:", bot.role);
      if (role === null) return;
      const instructions = await ask("Instructions:", bot.instructions);
      if (instructions === null) return;
      say("Saved " + (await client.call("bots.edit", bot.id, { name, role, instructions })).name + ".");
    },
    async model() {
      const bot = chosen();
      if (!bot) return;
      const models = await client.call("models");
      const ref = await ask("Model for " + bot.name + " (" + (models.map((model) => model.ref).slice(0, 6).join(", ") || "no provider is signed in") + (models.length > 6 ? ", …" : "") + "; empty for the default):", bot.model ? (bot.model.provider ? bot.model.provider + "/" : "") + bot.model.model : "");
      if (ref !== null) say("Saved " + (await client.call("bots.edit", bot.id, { model: ref.trim() })).name + ".");
    },
    async removeBot() {
      const bot = chosen();
      if (bot && (await confirm("Remove " + bot.name + " with its chats, routines and memory?"))) say("Removed " + (await client.call("bots.remove", bot.id)).name + ".");
    },
    async chatWith() {
      const bot = chosen();
      const message = bot && (await ask("Message for " + bot.name + ":"));
      if (!message?.trim()) return;
      const { chatId } = await client.call("chat.open", bot.id);
      await client.call("chat.send", chatId, message.trim());
      Object.assign(state, { tab: "Chats", selected: 0 });
      read({ id: chatId, title: message.trim().slice(0, 60), bot: bot.name, messages: 0 });
    },
    async reply() {
      const chat = state.reading ? { id: state.reading.chatId, bot: state.reading.bot } : chosen();
      const message = chat && (await ask("Message" + (chat.bot ? " for " + chat.bot : "") + ":"));
      if (!message?.trim()) return;
      await client.call("chat.send", chat.id, message.trim());
      if (!state.reading) read(chosen());
    },
    async stopChat() {
      const id = state.reading?.chatId ?? chosen()?.id;
      if (id) await client.call("chat.stop", id);
    },
    async runRoutine() {
      const routine = chosen();
      if (routine) say((await client.call("routines.run", routine.id)).name + " is running.");
    },
    async toggleRoutine() {
      const routine = chosen();
      if (routine) say((await client.call(routine.enabled ? "routines.pause" : "routines.resume", routine.id)).name + (routine.enabled ? " is paused." : " is on."));
    },
  };
  const BINDINGS = {
    Overview: { R: "relay", p: "pair" },
    Devices: { p: "pair", r: "rename", s: "person", x: "unpair" },
    Bots: { a: "addBot", e: "editBot", m: "model", c: "chatWith", x: "removeBot" },
    Chats: { c: "reply", S: "stopChat" },
    Routines: { r: "runRoutine", space: "toggleRoutine" },
    Logs: {},
  };
  const run = (name) =>
    track(
      Promise.resolve()
        .then(() => actions[name]())
        .then(refresh, (error) => (fail(error), refresh())),
    );

  /**
   * One key. `input` is { name?, ch?, ctrl? } as Node's key events give it.
   * @returns "quit" when the dashboard should close.
   */
  function key({ name, ch, ctrl } = {}) {
    if (ctrl && name === "c") return "quit";
    // A question being answered takes every key.
    if (state.prompt) {
      const { prompt } = state;
      if (name === "return" || name === "enter") {
        state.prompt = null;
        prompt.resolve(prompt.value);
      } else if (name === "escape") {
        state.prompt = null;
        prompt.resolve(null);
      } else if (name === "backspace") prompt.value = prompt.value.slice(0, -1);
      else if (ctrl && name === "u") prompt.value = "";
      else if (ch && ch >= " " && !ctrl) prompt.value += ch;
      draw();
      return;
    }
    Object.assign(state, { message: "", error: "" });
    if (name === "escape") {
      if (state.help) state.help = false;
      else if (state.overlay) state.overlay = null;
      else if (state.reading) state.reading = null;
      return void draw();
    }
    if (state.help || state.overlay) {
      // Any other key closes what is on top.
      Object.assign(state, { help: false, overlay: null });
      return void draw();
    }
    if (ch === "q") return "quit";
    if (ch === "?") state.help = true;
    else if (ch >= "1" && ch <= String(TABS.length)) Object.assign(state, { tab: TABS[Number(ch) - 1], selected: 0, reading: null });
    else if (name === "right" || name === "tab") Object.assign(state, { tab: TABS[(TABS.indexOf(state.tab) + 1) % TABS.length], selected: 0, reading: null });
    else if (name === "left") Object.assign(state, { tab: TABS[(TABS.indexOf(state.tab) + TABS.length - 1) % TABS.length], selected: 0, reading: null });
    else if (state.tab === "Logs") {
      const page = Math.max(1, size().height - 8);
      const step = { up: 1, down: -1, pageup: page, pagedown: -page }[name];
      if (ch === "f") Object.assign(state, { follow: !state.follow, scroll: 0 });
      else if (step) Object.assign(state, { follow: false, scroll: Math.max(0, Math.min(Math.max(0, state.logs.length - page), state.scroll + step)) });
    } else if (name === "up") state.selected = Math.max(0, state.selected - 1);
    else if (name === "down") state.selected = Math.min(Math.max(0, list().length - 1), state.selected + 1);
    else if ((name === "return" || name === "enter") && state.tab === "Chats" && !state.reading && chosen()) read(chosen());
    else {
      const action = BINDINGS[state.tab]?.[name === "space" ? "space" : ch];
      if (action) return void run(action);
    }
    draw();
  }

  async function watch() {
    while (running) {
      try {
        ({ revision } = await client.call("events.wait", revision));
        if (running) await refresh();
      } catch {
        if (running) await Promise.all([refresh(), new Promise((resolve) => setTimeout(resolve, 2000))]);
      }
    }
  }
  async function tail() {
    while (running) {
      try {
        const read = await client.call("logs.read", logCursor ? { after: logCursor, wait: true } : { tail: 200 });
        logCursor = read.next || logCursor;
        if (read.entries.length) {
          state.logs.push(...read.entries);
          if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
          draw();
        }
      } catch {
        logCursor = 0;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
  let clock;
  return {
    state,
    key,
    refresh,
    frame,
    draw,
    /** Resolves when nothing a key started is still on its way (for tests). */
    idle: async () => {
      while (busy.size) await Promise.allSettled([...busy]);
    },
    async start() {
      running = true;
      await refresh();
      void watch();
      void tail();
      // The clock moves the "running for" and "ago" texts.
      clock = setInterval(() => void refresh(), 5000);
      clock.unref?.();
    },
    stop() {
      running = false;
      clearInterval(clock);
      state.reading = null;
      if (state.prompt) state.prompt.resolve(null);
    },
  };
}

/** Runs the dashboard on a real terminal until the person quits. */
export function runDashboard({ client, stdin, stdout, env = process.env }) {
  return new Promise((resolve) => {
    const colors = !env.NO_COLOR && env.TERM !== "dumb";
    const app = createApp({ client, write: (text) => stdout.write(text), size: () => ({ width: stdout.columns || 80, height: stdout.rows || 24 }), colors });
    const leave = () => {
      app.stop();
      stdin.off("keypress", onKey);
      stdout.off("resize", onResize);
      stdin.setRawMode?.(false);
      stdin.pause();
      // Back to the terminal as it was: the cursor, and the screen that was there before.
      stdout.write(CSI + "?25h" + CSI + "?1049l");
      resolve(0);
    };
    const onKey = (ch, info = {}) => {
      if (app.key({ name: info.name, ch, ctrl: info.ctrl }) === "quit") leave();
    };
    const onResize = () => {
      stdout.write(CSI + "2J");
      app.draw();
    };
    // Its own screen, with no cursor; the one before comes back on the way out.
    stdout.write(CSI + "?1049h" + CSI + "?25l" + CSI + "2J");
    emitKeypressEvents(stdin);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("keypress", onKey);
    stdout.on("resize", onResize);
    process.once("SIGTERM", leave);
    void app.start();
  });
}

export { KEYS };
