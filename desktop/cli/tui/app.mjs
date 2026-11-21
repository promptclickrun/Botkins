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
//
// The six tabs and their one-key edits are what the dashboard had first. The commands screen (the
// `:` key) is the way in to everything else: it lists the areas of the command line from the command
// tree, shows an area's state by running its list command with --json, and runs a command that the
// person writes as a line of text. The command is the real one, run as it would be from the shell:
// the dashboard never adds a flag to it and never answers a question of it.
import { emitKeypressEvents } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { plainText } from "../../desktop/shown-text.mjs";
import { COMMANDS } from "../commands/index.mjs";
import { areasOf, editLine, leavesOf, listOf, rowsOf, splitLine, startLine } from "./menu.mjs";
import { KEYS, render, TABS } from "./view.mjs";

const MAX_LOGS = 2000;
const CSI = "\u001b[";

/**
 * @param options.client  The service (desktop/terminal/socket.mjs controlClient).
 * @param options.write   (text) → the terminal.
 * @param options.size    () → { width, height }.
 * @param options.colors  False for a terminal without them.
 * @param options.commands The command tree (cli/commands/index.mjs COMMANDS).
 * @param options.read    (words) → { exit, out, err }: runs a command with no terminal and keeps what it prints (for a list).
 * @param options.exec    (words) → exit code: runs a command in the person's terminal, which the dashboard has left until it ends.
 * @returns { state, start(), stop(), key(input), refresh(), frame(), idle() }
 */
export function createApp({ client, write, size, colors = true, now = () => Date.now(), commands = COMMANDS, read: readCommand, exec }) {
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
    if (!running || state.away) return;
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
  // ---- The commands screen.
  const openMenu = () => {
    state.menu = { level: "areas", areas: areasOf(commands), selected: 0, view: "state", row: 0, picked: 0 };
    draw();
  };
  /** The state of the open area: what its list command says, read by running that command with --json. */
  async function loadArea() {
    const menu = state.menu;
    if (menu?.level !== "area" && menu?.level !== "command") return;
    if (!menu.list || !readCommand) return;
    const word = menu.word;
    if (!menu.data) menu.data = { loading: true };
    draw();
    let data;
    try {
      const result = await readCommand([...menu.list.path, "--json"]);
      let value;
      try {
        value = JSON.parse(result.out);
      } catch {
        value = undefined;
      }
      if (result.exit !== 0) data = { error: value?.error?.message ?? (result.err.trim() || "The command ended with exit code " + result.exit + ".") };
      else if (value === undefined) data = { error: "The command printed nothing that can be shown here. Run it with its own line." };
      else data = rowsOf(value, now());
    } catch (error) {
      data = { error: String(error?.message ?? error) };
    }
    if (state.menu !== menu || menu.word !== word) return;
    menu.data = data;
    menu.row = Math.max(0, Math.min(menu.row, (data.rows?.length ?? 1) - 1));
    draw();
  }
  function openArea(area) {
    const leaves = leavesOf(area);
    Object.assign(state.menu, { level: "area", word: area.word, leaves, list: listOf(leaves), data: null, view: "state", row: 0, picked: 0, chosen: null, last: null });
    // An area that is one command (`status`) goes straight to its line.
    if (area.command.run) return openCommand(leaves[0]);
    if (!state.menu.list) state.menu.view = "commands";
    track(loadArea());
  }
  function openCommand(leaf) {
    const { menu } = state;
    // The row that the person picked in the state list gives its name to the line.
    const text = startLine(leaf, menu.chosen);
    Object.assign(menu, { level: "command", leaf, line: { text, cursor: text.length }, last: null });
  }
  /** Runs the line. The dashboard leaves its screen; the command has the terminal until it ends. */
  async function runLine() {
    const { menu } = state;
    const parsed = splitLine(menu.line.text);
    if (parsed.error) return fail(parsed.error);
    if (parsed.words[0] === "tui") return fail("The dashboard is open already.");
    if (!exec) return fail("This dashboard cannot run a command.");
    state.away = true;
    let code;
    try {
      code = await exec(parsed.words);
    } catch (error) {
      code = 1;
    }
    state.away = false;
    last = "";
    menu.last = { words: parsed.words.map((word) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word))).join(" "), exit: code };
    draw();
    // What the command changed shows in the state again.
    await Promise.all([refresh(), loadArea()]);
  }
  /** One key on the commands screen. */
  function menuKey({ name, ch, ctrl }) {
    const menu = state.menu;
    const up = name === "up" ? -1 : name === "down" ? 1 : 0;
    const enter = name === "return" || name === "enter";
    if (menu.level === "command") {
      if (enter) track(runLine().catch(fail));
      else editLine(menu.line, { name, ch, ctrl });
    } else if (menu.level === "areas") {
      menu.selected = Math.max(0, Math.min(menu.areas.length - 1, menu.selected + up));
      if (enter) openArea(menu.areas[menu.selected]);
    } else if (name === "tab" || name === "left" || name === "right") {
      if (menu.list) Object.assign(menu, { view: menu.view === "state" ? "commands" : "state", chosen: null });
    } else if (menu.view === "state") {
      const count = menu.data?.rows?.length ?? 0;
      menu.row = Math.max(0, Math.min(count - 1, menu.row + up));
      if (enter && count) Object.assign(menu, { view: "commands", chosen: menu.data.rows[menu.row] });
      else if (ch === "r") track(loadArea());
    } else {
      menu.picked = Math.max(0, Math.min(menu.leaves.length - 1, menu.picked + up));
      if (enter && menu.leaves[menu.picked]) openCommand(menu.leaves[menu.picked]);
    }
    draw();
  }
  /** Esc: one step back. */
  function menuBack() {
    const menu = state.menu;
    if (menu.level === "command") {
      // An area that is one command has no screen of its own to go back to.
      menu.level = menu.leaves.length === 1 && menu.leaves[0].path.length === 1 ? "areas" : "area";
    } else if (menu.level === "area") menu.level = "areas";
    else state.menu = null;
  }

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
      else if (state.menu) menuBack();
      else if (state.reading) state.reading = null;
      return void draw();
    }
    if (state.help || state.overlay) {
      // Any other key closes what is on top.
      Object.assign(state, { help: false, overlay: null });
      return void draw();
    }
    if (state.menu) {
      // In a line being written, `q` and `?` are letters.
      if (state.menu.level !== "command") {
        if (ch === "q") return "quit";
        if (ch === "?") {
          state.help = true;
          return void draw();
        }
      }
      return void menuKey({ name, ch, ctrl });
    }
    if (ch === "q") return "quit";
    if (ch === ":") return void openMenu();
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
        // A change from anywhere (a phone, a bot, a command) shows in the open area too.
        if (running && !state.away && state.menu?.level === "area") await loadArea();
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

/**
 * Runs the dashboard on a real terminal until the person quits.
 * @param options.run  (words, io) → exit code: runs one command as `botkins <words>` would, on the streams in `io`.
 */
export function runDashboard({ client, stdin, stdout, stderr = process.stderr, env = process.env, run }) {
  return new Promise((resolve) => {
    const colors = !env.NO_COLOR && env.TERM !== "dumb";
    // A list: the command runs with no terminal, and what it prints is kept.
    const read = async (words) => {
      let out = "";
      let err = "";
      const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
      const input = new PassThrough();
      input.end();
      const exit = await run(words, { stdin: input, stdout: sink((text) => void (out += text)), stderr: sink((text) => void (err += text)) });
      return { exit, out, err };
    };
    const app = createApp({ client, write: (text) => stdout.write(text), size: () => ({ width: stdout.columns || 80, height: stdout.rows || 24 }), colors, read, exec });
    let away = false;
    const enter = () => {
      // Its own screen, with no cursor; the one before comes back on the way out.
      stdout.write(CSI + "?1049h" + CSI + "?25l" + CSI + "2J");
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on("keypress", onKey);
    };
    const step = () => {
      stdin.off("keypress", onKey);
      stdin.setRawMode?.(false);
      stdin.pause();
      stdout.write(CSI + "?25h" + CSI + "?1049l");
    };
    const leave = () => {
      app.stop();
      stdout.off("resize", onResize);
      step();
      resolve(0);
    };
    /**
     * A command of the commands screen. The dashboard steps aside: the command has the terminal, as if it
     * were typed in the shell, so a question is asked and a hidden answer stays hidden. The dashboard
     * answers nothing and adds no flag. When the command ends, a key brings the dashboard back.
     */
    async function exec(words) {
      away = true;
      step();
      stdout.write("$ botkins " + words.map((word) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : JSON.stringify(plainText(word)))).join(" ") + "\n");
      let code;
      try {
        code = await run(words, { stdin, stdout, stderr });
      } catch (error) {
        stderr.write("botkins: " + plainText(String(error?.message ?? error)) + "\n");
        code = 1;
      }
      stdout.write("\nThe command ended with exit code " + code + ". Press a key to go back to the dashboard.\n");
      stdin.setRawMode?.(true);
      stdin.resume();
      await new Promise((done) => stdin.once("keypress", done));
      stdin.pause();
      away = false;
      enter();
      return code;
    }
    const onKey = (ch, info = {}) => {
      if (app.key({ name: info.name, ch, ctrl: info.ctrl }) === "quit") leave();
    };
    const onResize = () => {
      if (away) return;
      stdout.write(CSI + "2J");
      app.draw();
    };
    emitKeypressEvents(stdin);
    enter();
    stdout.on("resize", onResize);
    process.once("SIGTERM", leave);
    void app.start();
  });
}

export { KEYS };
