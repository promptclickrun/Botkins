// HTML frames: rich pages a bot puts inside a Today panel or a chat card (an "html" block).
// A frame is one self-contained HTML page plus optional data. The app draws it in a sandboxed
// frame that cannot reach the network, the app or the computer; it talks to the app through a
// small bridge (window.botkins), in the spirit of MCP Apps.
//
//   <data>/frames/<id>.html, <id>.json     the page as the bot wrote it, and its data
//   state.frames: [{ id, owner, botId }]   owner is "panel:<panel id>" or "chat:<chat id>"
//
// The page is kept out of the workspace file and out of what the app's own page receives: only
// the frame's id travels, and the frame loads from botkins-app://frame-<id>/ (desktop/main.mjs).
import { LEGACY_NAME } from "./home.mjs";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guardedPage, unshadow } from "./view-guard.mjs";

export const MAX_FRAME_HTML = 300_000;
export const MAX_FRAME_DATA = 200_000;
/** What a frame's page may do: run its own inline code and styles, show inline images. Nothing loads from anywhere. */
export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  // Sandboxed even when opened outside the app's frame: scripts only, with an origin of its own.
  "sandbox allow-scripts",
].join("; ");

// The bridge runs inside the frame, before the bot's page. It gives the page its data, the app's
// colors, and three things it may ask for: its height, text for the person's message box, and a
// web page opened in the browser (the app asks the person first).
const BRIDGE = String.raw`(() => {
  const root = document.documentElement;
  const data = __DATA__;
  const pending = new Map();
  const themed = new Set();
  const changed = new Set();
  let seq = 0;
  let mode = "light";
  const post = (type, more) => parent.postMessage({ botkins: 1, type, ...more }, "*");
  const ask = (type, more) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      post(type, { id, ...more });
    });
  addEventListener("message", (event) => {
    const m = event.data;
    if (event.source !== parent || !m || m.botkins !== 1) return;
    if (m.type === "theme") {
      mode = m.mode === "dark" ? "dark" : "light";
      root.dataset.theme = mode;
      root.style.colorScheme = mode;
      for (const [name, value] of Object.entries(m.colors || {})) if (/^--[a-z-]+$/.test(name)) root.style.setProperty(name, String(value));
      for (const fn of themed) fn(mode);
    } else if (m.type === "state") {
      // Someone else changed this panel's saved state.
      const state = m.state && typeof m.state === "object" ? m.state : {};
      for (const fn of changed) fn(state);
    } else if (m.type === "result") {
      const waiting = pending.get(m.id);
      pending.delete(m.id);
      if (waiting) m.error ? waiting.reject(new Error(String(m.error))) : waiting.resolve(m.value);
    }
  });
  const api = {
    getData: () => Promise.resolve(data),
    onData: (fn) => (fn(data), () => {}),
    sendAnswer: (text) => ask("answer", { text: String(text) }),
    openLink: (url) => ask("open", { url: String(url) }),
    theme: () => mode,
    onTheme: (fn) => (themed.add(fn), () => themed.delete(fn)),
    close: () => {},
  };
  api.sendMessage = api.sendAnswer;
  // What people change in a panel's page is kept with the panel, for everyone who can open its
  // space (desktop/spaces.mjs). The app that shows the page answers "state" with the saved
  // object and "setState" with whether the change was saved; it passes a change on only soon
  // after the person touched the page, so a page can't write in a person's name by itself. An
  // app from before this never answers: after a few seconds there is no state, and nothing was saved.
  const within = (promise, otherwise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(otherwise), 5000))]).catch(() => otherwise);
  api.state = Object.freeze({
    get: () => within(ask("state", {}), {}).then((state) => (state && typeof state === "object" ? state : {})),
    set: (patch, label) => within(ask("setState", { patch, ...(label != null && { label: String(label) }) }), false).then((saved) => saved === true),
    onChange: (fn) => (changed.add(fn), () => changed.delete(fn)),
  });
  // Saved pages can also use either earlier spelling of the bridge.
  Object.defineProperty(window, "botkins", { value: Object.freeze(api) });
  Object.defineProperty(window, ${JSON.stringify(LEGACY_NAME.toLowerCase())}, { value: window.botkins });
  Object.defineProperty(window, "bighelp", { value: window.botkins });
  // The page's own height: what it needs when it is taller than the frame, and what it has when it
  // is shorter, so the frame shrinks as well as grows.
  const size = () => post("size", { height: Math.ceil(root.scrollHeight > root.clientHeight + 1 ? root.scrollHeight : Math.max(root.offsetHeight, 1)) });
  addEventListener("DOMContentLoaded", () => {
    new ResizeObserver(size).observe(root);
    if (document.body) new ResizeObserver(size).observe(document.body);
    size();
  });
  addEventListener("load", size);
  // A link to a web page asks the app instead of leaving the frame.
  addEventListener(
    "click",
    (event) => {
      const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (!link) return;
      event.preventDefault();
      if (/^https?:/i.test(link.href)) api.openLink(link.href).catch(() => {});
    },
    true,
  );
  post("ready");
})();`;

const BASE_STYLE =
  // The Ink theme in light, until the app sends the colors in use (src/HtmlFrame.tsx).
  ":root{color-scheme:light dark;--ink:#000000;--muted:#595959;--line:#e7e7e4;--paper:#f5f5f3;--surface:#f5f5f3;--canvas:#ffffff;--rail:#f7f7f5;--sunken:#ededea;--accent:#000000;--active:#ededea;" +
  'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--ink)}' +
  "html,body{margin:0;background:transparent}";

/** JSON that is safe inside a <script>: no way to end the script or start a comment. */
const LINE_SEPARATORS = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
const inline = (value) =>
  JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(LINE_SEPARATORS[0])
    .join("\\u2028")
    .split(LINE_SEPARATORS[1])
    .join("\\u2029");

/** The page as the frame loads it: the bridge and base styles first, then what the bot wrote. */
export function framePage(html, data) {
  const head = "<meta charset=\"utf-8\"><style>" + BASE_STYLE + "</style><script>" + BRIDGE.replace("__DATA__", () => inline(data)) + "</script>";
  const at = /<head[^>]*>/i.exec(html) ?? /<html[^>]*>/i.exec(html);
  if (at) return html.slice(0, at.index + at[0].length) + head + html.slice(at.index + at[0].length);
  return "<!doctype html><html><head>" + head + "</head><body>" + html + "</body></html>";
}

/** Checks an html block's page and data as a bot sent them. */
export function frameFields({ html, data }) {
  if (typeof html !== "string" || !html.trim()) throw new Error("An html block needs its page in `html`.");
  if (html.length > MAX_FRAME_HTML) throw new Error("Keep an html block under " + MAX_FRAME_HTML.toLocaleString("en-US") + " characters.");
  let json = "null";
  if (data !== undefined) {
    json = JSON.stringify(data);
    if (json === undefined || json.length > MAX_FRAME_DATA) throw new Error("Keep an html block's data under " + MAX_FRAME_DATA.toLocaleString("en-US") + " characters of JSON.");
  }
  return { html, json };
}

export class Frames {
  constructor(ws) {
    this.ws = ws;
    this.dir = join(ws.dir, "frames");
    ws.state.frames = Array.isArray(ws.state.frames) ? ws.state.frames : [];
  }
  get all() {
    return this.ws.state.frames;
  }
  get(id) {
    const frame = typeof id === "string" && /^[0-9a-f-]{36}$/.test(id) ? this.all.find((f) => f.id === id) : null;
    if (!frame) throw new Error("This view no longer exists.");
    return frame;
  }
  file(id, ext) {
    return join(this.dir, id + ext);
  }
  /** Stores a checked page (see frameFields) for an owner and returns the frame's id. */
  create(owner, botId, { html, json }) {
    const frame = { id: randomUUID(), owner, botId, createdAt: Date.now() };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(frame.id, ".html"), html, { mode: 0o600 });
    writeFileSync(this.file(frame.id, ".json"), json, { mode: 0o600 });
    this.all.push(frame);
    return frame.id;
  }
  html(id) {
    this.get(id);
    return readFileSync(this.file(id, ".html"), "utf8");
  }
  data(id) {
    this.get(id);
    try {
      return JSON.parse(readFileSync(this.file(id, ".json"), "utf8"));
    } catch {
      return null;
    }
  }
  /** The page the frame loads, bridge included. */
  /** The page as the window's frame loads it: the guard first, then the bridge, then what the bot wrote. */
  page(id) {
    return guardedPage(framePage(unshadow(this.html(id)), this.data(id)));
  }
  remove(ids) {
    const gone = new Set(ids);
    if (!gone.size) return;
    for (const id of gone) {
      rmSync(this.file(id, ".html"), { force: true });
      rmSync(this.file(id, ".json"), { force: true });
    }
    this.ws.state.frames = this.all.filter((f) => !gone.has(f.id));
  }
  /** Removes an owner's frames, except the ones in `keep`. */
  removeOwner(owner, keep = []) {
    this.remove(this.all.filter((f) => f.owner === owner && !keep.includes(f.id)).map((f) => f.id));
  }
  /**
   * The chat a frame's answer goes to: its card's chat, or the chat its panel was made in. null
   * when that chat is gone. This only looks: it makes no chat. A panel is in a space that several
   * people may open, and a chat made here would be made for whoever happened to look. An answer
   * from a panel whose chat is gone starts an ask about that panel instead (`spaces.ask`), which
   * is the asker's own chat.
   */
  chatFor(id) {
    const frame = this.get(id);
    const [kind, owner] = frame.owner.split(":");
    const exists = (chatId) => chatId && this.ws.state.chats.some((c) => c.id === chatId && !c.panelId);
    if (kind === "chat") return exists(owner) ? owner : null;
    const panel = this.ws.state.panels.find((p) => p.id === owner);
    return panel && exists(panel.chatId) ? panel.chatId : null;
  }
  /** The panel a frame is a view of, or null for a card's view in a chat. */
  panelOf(id) {
    const [kind, owner] = this.get(id).owner.split(":");
    return kind === "panel" ? (this.ws.state.panels.find((p) => p.id === owner) ?? null) : null;
  }
}
