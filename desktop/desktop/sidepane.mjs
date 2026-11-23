// The chat's side pane, as a bot can use it (docs/SIDE_PANE.md).
//
// A bot shows something beside the conversation instead of inside it: a page it wrote (a rich UI),
// a table, a website, or the Screen panel. Each thing is a panel. A chat keeps its panels as tabs,
// so what was shown earlier is still there, and the app opens the pane on the chat the person is in.
//
//   chat.pane = {
//     panels: [{ id, kind, title, botId, createdAt, updatedAt, pinned?, unseen?,
//                frame?,            rich_ui: the id of the stored page (desktop/frames.mjs)
//                columns?, rows?,   table
//                url? }],           web
//     active,   the id of the tab in front, or null for the chat's own Details
//     ask?,     { seq, panelId, runId, botId, at } the latest time a bot asked for the pane to open.
//               A client that has this chat on screen opens the pane when `seq` goes up.
//     closed?,  { runId, at } the person closed the pane. For the rest of that turn no bot opens it again.
//   }
//
// What a bot can and can't do here:
//   - A rich UI is an html block: it runs in the same sandbox, with no network (FRAME_CSP).
//   - A website is loaded by the app's own viewer, which keeps nothing and can reach nothing of the
//     app. Showing one is a request to the network at an address the bot chose, so that tool goes
//     through the chat's approval like any tool that reaches out; the others never ask.
//   - The Screen panel is only shown. Whether a phone may see or use this computer's screen stays
//     the person's switch in that panel, with the system's own permission questions.
//   - The person closes a panel, pins one, or closes the pane. A pane the person closed stays closed
//     for the rest of that turn: a new panel waits as a tab.
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { defineTool } from "./providers/index.mjs";
import { frameFields } from "./frames.mjs";
import { isPrivateAddress } from "./linkpreview.mjs";

/** What a phone or another computer asks about before it shows a bot's panels. */
export const SIDE_PANE = "side-pane-v1";
export const ARTIFACTS = "artifacts-v1";
export const PANEL_KINDS = ["rich_ui", "table", "web", "screen"];
export const MAX_PANELS = 8;
const MAX_TITLE = 80;
const MAX_COLUMNS = 12;
const MAX_ROWS = 200;
const MAX_CELL = 500;
const MAX_URL = 2000;
const ACTIONS = ["select", "remove", "pin", "unpin", "closed", "opened"];

const title = (value, fallback) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE) : fallback);

/** A table as a bot sent it, checked: text cells only, every row as wide as the header. */
export function tableFields({ columns, rows }) {
  if (!Array.isArray(columns) || !columns.length || columns.length > MAX_COLUMNS) throw new Error("A table needs 1 to " + MAX_COLUMNS + " columns.");
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error("A table holds at most " + MAX_ROWS + " rows.");
  const cell = (value) => {
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value !== "string") throw new Error("Every cell of a table is text.");
    return value.slice(0, MAX_CELL);
  };
  const head = columns.map(cell);
  const body = rows.map((row) => {
    if (!Array.isArray(row) || row.length !== head.length) throw new Error("Every row needs " + head.length + " cells, one for each column.");
    return row.map(cell);
  });
  return { columns: head, rows: body };
}

/** This computer's own addresses. A bot may show a site that runs here, such as one it is building. */
const loopback = (address) => address === "::1" || /^127\./.test(address) || /^::ffff:127\./i.test(address);
/** True for an address literal on the local network (not this computer's own): never shown. */
export const localNetworkLiteral = (host) => {
  const address = String(host ?? "").replace(/^\[|\]$/g, "");
  return isIP(address) !== 0 && isPrivateAddress(address) && !loopback(address);
};
/**
 * A web address a bot wants shown, checked: http or https, no sign-in inside it, and not a place
 * on the local network (a router, a printer, another computer). Returns the address as kept.
 * `resolve` looks a name up; tests pass a stand-in, so nothing here reaches a network in a test.
 */
export async function webAddress(value, resolve = (host) => lookup(host, { all: true })) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new Error("Give a full web address, such as https://example.com.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https addresses can be shown.");
  if (url.username || url.password) throw new Error("An address with a user name or a password in it can't be shown.");
  if (url.href.length > MAX_URL) throw new Error("That address is too long.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return url.href;
  let addresses = [host];
  if (!isIP(host)) {
    try {
      addresses = (await resolve(host)).map((found) => found.address);
    } catch {
      throw new Error("That address couldn't be found.");
    }
  }
  if (!addresses.length) throw new Error("That address couldn't be found.");
  if (addresses.some((address) => isPrivateAddress(address) && !loopback(address)))
    throw new Error("An address on the local network can't be shown in the side pane. A public site can, and so can one that runs on this computer (localhost).");
  return url.href;
}

export class SidePane {
  /**
   * @param ws               The workspace.
   * @param options.resolve  For tests: async (host) => [{ address }] instead of a real lookup.
   */
  constructor(ws, { resolve } = {}) {
    this.ws = ws;
    this.resolve = resolve;
  }
  pane(chat) {
    const pane = chat.pane && typeof chat.pane === "object" ? chat.pane : (chat.pane = { panels: [], active: null });
    if (!Array.isArray(pane.panels)) pane.panels = [];
    return pane;
  }
  find(chat, id) {
    const panel = this.pane(chat).panels.find((p) => p.id === id);
    if (!panel) throw new Error("This panel no longer exists.");
    return panel;
  }
  /** A panel as a bot is told of it. */
  brief(panel, pane) {
    return { id: panel.id, kind: panel.kind, title: panel.title, ...(panel.url && { url: panel.url }), ...(panel.pinned && { pinned: true }), ...(pane.active === panel.id && { in_front: true }) };
  }
  drop(chat, panel) {
    const pane = this.pane(chat);
    if (panel.frame) this.ws.frames.remove([panel.frame]);
    pane.panels = pane.panels.filter((p) => p !== panel);
    if (pane.active === panel.id) pane.active = pane.panels.at(-1)?.id ?? null;
  }
  /** Adds a panel, making room first: the oldest one the person didn't pin goes. */
  add(chat, bot, run, fields) {
    const pane = this.pane(chat);
    if ((run.panes ?? 0) >= MAX_PANELS) throw new Error("Show at most " + MAX_PANELS + " panels in one reply. Update one you already showed instead.");
    while (pane.panels.length >= MAX_PANELS) {
      const oldest = pane.panels.find((p) => !p.pinned);
      if (!oldest) throw new Error("The person pinned every panel of this chat. Update one of them, or ask the person to close one.");
      this.drop(chat, oldest);
    }
    const now = Date.now();
    const panel = { id: randomUUID(), botId: bot.id, createdAt: now, updatedAt: now, ...fields };
    pane.panels.push(panel);
    run.panes = (run.panes ?? 0) + 1;
    return panel;
  }
  /**
   * Puts a panel in front and asks for the pane to open, unless the person said otherwise: a tab
   * they pinned stays in front, and a pane they closed during this turn stays closed.
   */
  front(chat, bot, run, panel) {
    const pane = this.pane(chat);
    const current = pane.panels.find((p) => p.id === pane.active);
    const held = !!current?.pinned && current !== panel;
    if (!held) pane.active = panel?.id ?? null;
    if (pane.closed && pane.closed.runId === run.id) {
      if (panel) panel.unseen = true;
      return { opened: false, note: "The person closed the side pane during this turn, so it stays closed. The panel is there as a tab when they open it. Don't open it again; say in your reply that it is ready." };
    }
    if (panel) held ? (panel.unseen = true) : delete panel.unseen;
    delete pane.closed;
    pane.ask = { seq: (pane.ask?.seq ?? 0) + 1, panelId: held ? current.id : (panel?.id ?? null), runId: run.id, botId: bot.id, at: Date.now() };
    return { opened: true, ...(held && { note: "The person pinned another panel, so this one was added as a tab behind it." }) };
  }

  /**
   * What the person did with the pane of a chat (the window and a paired phone both call this):
   * "select" a tab (null for Details), "remove" a panel, "pin" or "unpin" one, and "closed" or
   * "opened" for the pane itself.
   */
  act(chatId, action, panelId) {
    const chat = this.ws.chat(chatId);
    if (!ACTIONS.includes(action)) throw new Error("Unknown side pane action");
    // Opening or closing the pane of a chat no bot has shown anything in is nothing to remember.
    if ((action === "closed" || action === "opened") && !chat.pane?.panels?.length && !chat.pane?.ask) return;
    const pane = this.pane(chat);
    if (action === "closed") {
      // The turn in progress, if there is one: its bot doesn't open the pane again.
      const run = this.ws.state.runs.findLast((r) => r.chatId === chat.id && r.status === "Working");
      pane.closed = { runId: run?.id ?? null, at: Date.now() };
    } else if (action === "opened") {
      delete pane.closed;
      const active = pane.panels.find((p) => p.id === pane.active);
      if (active) delete active.unseen;
    } else if (action === "select") {
      if (panelId === null || panelId === undefined) pane.active = null;
      else {
        const panel = this.find(chat, panelId);
        pane.active = panel.id;
        delete panel.unseen;
      }
    } else if (action === "remove") this.drop(chat, this.find(chat, panelId));
    else {
      const panel = this.find(chat, panelId);
      action === "pin" ? (panel.pinned = true) : delete panel.pinned;
    }
    this.ws.save();
  }

  /** The session tools of one turn. A turn nobody is watching (a routine, a task, a panel refresh) gets none. */
  tools(bot, chat, run, task) {
    if (chat.helper || run?.panelId || run?.scheduleId || run?.taskId) return [];
    const string = { type: "string" };
    const tool = (name, description, properties, required, handler, skipPermission = true) =>
      defineTool(name, {
        description,
        parameters: { type: "object", properties, required, additionalProperties: false },
        skipPermission,
        defer: "never",
        handler: async (args) => {
          if (task.stopped || this.ws.closing || !run || this.ws.active.get(chat.id) !== task) throw new Error("This turn is no longer active");
          return JSON.stringify(await handler(args ?? {}));
        },
      });
    const mine = (id) => {
      const panel = this.find(chat, id);
      if (panel.botId !== bot.id) throw new Error("Another bot opened this panel. Only that bot or the person changes it.");
      return panel;
    };
    const shown = (panel, result) => {
      this.ws.save();
      return { id: panel.id, kind: panel.kind, title: panel.title, ...result };
    };
    return [
      tool(
        "side_pane_show",
        "Open the side pane beside this chat and show a panel in it. Use it only when keeping something in view beside the conversation is more useful than showing it in chat. `kind` is \"rich_ui\" (send one self-contained HTML document in `html`, with inline CSS and JavaScript, and optional JSON in `data`; it runs in a sandbox with no network, and reads its data with window.botkins.getData() and onData), \"table\" (send `columns` and `rows` of text), \"screen\" (offers a clickable chat card for visible browser automation or interactive desktop actions worth watching; skip code, scripts, terminal work and background checks; only the person can change screen access) or \"details\" (the chat's own details). Each panel becomes a tab, so earlier ones stay. The person can close the pane; if they did during this turn it stays closed and your panel waits as a tab. Keep your reply short and point to the panel. Use side_pane_web for a website.",
        {
          kind: { type: "string", enum: ["rich_ui", "table", "screen", "details"] },
          title: { type: "string", description: "A few words for the tab." },
          html: string,
          data: {},
          columns: { type: "array", items: string },
          rows: { type: "array", items: { type: "array", items: string } },
        },
        ["kind"],
        (args) => {
          if (args.kind === "details") {
            const result = this.front(chat, bot, run, null);
            this.ws.save();
            return { kind: "details", ...result };
          }
          if (args.kind === "screen") {
            // The chat card opens this tab only when the person chooses it.
            const panel = this.pane(chat).panels.find((p) => p.kind === "screen") ?? this.add(chat, bot, run, { kind: "screen", title: "Screen" });
            return shown(panel, { opened: false, note: "Screen is available in chat. The person can open it." });
          }
          if (args.kind === "rich_ui") {
            const fields = frameFields({ html: args.html, data: args.data });
            const panel = this.add(chat, bot, run, { kind: "rich_ui", title: title(args.title, "View") });
            panel.frame = this.ws.frames.create("chat:" + chat.id, bot.id, fields);
            return shown(panel, this.front(chat, bot, run, panel));
          }
          if (args.kind === "table") {
            const table = tableFields(args);
            const panel = this.add(chat, bot, run, { kind: "table", title: title(args.title, "Table"), ...table });
            return shown(panel, this.front(chat, bot, run, panel));
          }
          throw new Error("`kind` is rich_ui, table, screen or details.");
        },
      ),
      tool(
        "side_pane_web",
        "Show a website in the side pane beside this chat, in the app's own viewer (it stores nothing on this computer, and the person can open the page in their browser from there). Give a full http or https address. A public site can be shown, and so can one that runs on this computer (localhost); other addresses on the local network can't. Depending on the chat's approval setting the person is asked first. Never put anything of the person's in the address. Pass `id` to send a web panel you opened to another address.",
        { url: string, title: { type: "string", description: "A few words for the tab. Left out, the site's name is used." }, id: string },
        ["url"],
        async (args) => {
          const url = await webAddress(args.url, this.resolve);
          const host = new URL(url).hostname.replace(/^www\./, "");
          let panel;
          if (args.id) {
            panel = mine(args.id);
            if (panel.kind !== "web") throw new Error("That panel isn't a website.");
            Object.assign(panel, { url, title: title(args.title, host), updatedAt: Date.now() });
          } else panel = this.add(chat, bot, run, { kind: "web", title: title(args.title, host), url });
          return shown(panel, { url, ...this.front(chat, bot, run, panel) });
        },
        false,
      ),
      tool(
        "side_pane_update",
        "Change a panel you opened in the side pane: new `data` for a rich UI (it reaches the open page at once through onData), a new page in `html`, new `columns` and `rows` for a table, or a new `title`. It doesn't open the pane or bring the panel to the front. Use side_pane_web to change a website's address.",
        { id: string, title: string, html: string, data: {}, columns: { type: "array", items: string }, rows: { type: "array", items: { type: "array", items: string } } },
        ["id"],
        (args) => {
          const panel = mine(args.id);
          if (panel.kind === "rich_ui" && (args.html !== undefined || args.data !== undefined)) {
            const fields = frameFields({ html: args.html ?? this.ws.frames.html(panel.frame), data: args.data !== undefined ? args.data : this.ws.frames.data(panel.frame) });
            const old = panel.frame;
            panel.frame = this.ws.frames.create("chat:" + chat.id, bot.id, fields);
            this.ws.frames.remove([old]);
          } else if (panel.kind === "table" && (args.columns !== undefined || args.rows !== undefined))
            Object.assign(panel, tableFields({ columns: args.columns ?? panel.columns, rows: args.rows ?? panel.rows }));
          else if (args.title === undefined) throw new Error(panel.kind === "rich_ui" ? "Send `html`, `data` or `title`." : panel.kind === "table" ? "Send `columns`, `rows` or `title`." : "Only this panel's `title` can change here.");
          if (args.title !== undefined) panel.title = title(args.title, panel.title);
          panel.updatedAt = Date.now();
          return shown(panel, { updated: true });
        },
      ),
      tool(
        "side_pane_close",
        "Close a panel you opened in the side pane (pass its `id`), or with no id ask for the pane itself to close, leaving its tabs. Close what is no longer useful; the person can also close anything themselves.",
        { id: string },
        [],
        (args) => {
          const pane = this.pane(chat);
          if (args.id) {
            const panel = mine(args.id);
            this.drop(chat, panel);
            this.ws.save();
            return { closed: panel.id, left: pane.panels.length };
          }
          pane.ask = { seq: (pane.ask?.seq ?? 0) + 1, close: true, runId: run.id, botId: bot.id, at: Date.now() };
          this.ws.save();
          return { closed: "pane", left: pane.panels.length };
        },
      ),
      tool(
        "side_pane_list",
        "The panels in this chat's side pane (yours and other bots'), which one is in front, and whether the person closed the pane during this turn.",
        {},
        [],
        () => {
          const pane = this.pane(chat);
          return { panels: pane.panels.map((panel) => ({ ...this.brief(panel, pane), yours: panel.botId === bot.id })), closed_by_person: !!pane.closed && pane.closed.runId === run.id };
        },
      ),
    ];
  }
}
