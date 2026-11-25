// A custom view (an html block): one page a bot wrote, drawn on the phone in a web view. This file
// builds the document the web view loads and reads what the page says back. No React Native
// imports, so tests/frames.test.ts runs it.
//
// The page is not trusted. It gets no network (the policy below, and the web view refuses every
// navigation), no way to reach the app except the few messages read here, and only the data its
// own bot gave it. The bridge is the same `window.botkins` the desktop app gives a page
// (desktop/desktop/frames.mjs), so a page written for the computer runs here unchanged.

/** What a view's page may do: run its own inline code and styles and show inline pictures. Nothing loads from anywhere. */
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
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
].join("; ");

/**
 * Runs at the start of every frame of a view, before any of the page's code: the policy above has no
 * word for peer-to-peer connections (WebRTC), so the ways to open one are removed, here and in any
 * frame the page makes (a blank frame would otherwise have its own).
 */
export const FRAME_GUARD = String.raw`(() => {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate", "WebSocket", "EventSource", "WebTransport", "Worker", "SharedWorker"]) {
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  }
})();true;`;

/**
 * Runs first in a view's page: no frame is ever left inside it. FRAME_GUARD runs in every frame the
 * web view makes, but not in a frame whose address is code (`javascript:`): that one ran with WebRTC
 * still in it, and packets left (seen on a simulator, 2026-11-20). So each `iframe`, `frame`,
 * `object` and `embed` is taken out the moment it is put in, before anything in it can run, also
 * inside a shadow root; and the ways to make a shadow root from markup are removed. The functions
 * it uses are kept apart, so a page cannot swap them. The relay's frame for a shared space's panel
 * (relay/src/space-frame.js.txt) holds this block word for word; tests/space-page.test.ts fails
 * when the two differ.
 */
export const NESTED_FRAME_GUARD = String.raw`  (() => {
    const un = (fn) => Function.prototype.call.bind(fn);
    const getter = (proto, name) => un(Object.getOwnPropertyDescriptor(proto, name).get);
    const matches = un(Element.prototype.matches);
    const queryAll = un(Element.prototype.querySelectorAll);
    const removeNode = un(Element.prototype.remove);
    const addedOf = getter(MutationRecord.prototype, "addedNodes");
    const countOf = getter(NodeList.prototype, "length");
    const itemOf = un(NodeList.prototype.item);
    const observe = un(MutationObserver.prototype.observe);
    const Observer = MutationObserver;
    const NESTED = "iframe,frame,object,embed,portal,fencedframe";
    const drop = (node) => {
      try {
        if (matches(node, NESTED)) return removeNode(node);
        const inside = queryAll(node, NESTED);
        for (let i = countOf(inside) - 1; i >= 0; i--) removeNode(itemOf(inside, i));
      } catch (e) {
        // Not an element (text, a comment): nothing to take out.
      }
    };
    const watch = (root) =>
      observe(
        new Observer((records) => {
          for (let r = 0; r < records.length; r++) {
            const added = addedOf(records[r]);
            for (let i = countOf(added) - 1; i >= 0; i--) drop(itemOf(added, i));
          }
        }),
        root,
        { childList: true, subtree: true },
      );
    watch(document);
    // What is inside a shadow root is not seen from the document, so each one made is watched too, and
    // the ways to make one from markup are removed.
    const attach = Element.prototype.attachShadow;
    if (attach) {
      const attachTo = un(attach);
      Object.defineProperty(Element.prototype, "attachShadow", {
        value: function attachShadow(init) {
          const root = attachTo(this, init);
          watch(root);
          return root;
        },
        writable: false,
        configurable: false,
      });
    }
    for (const [owner, name] of [[Element.prototype, "setHTMLUnsafe"], [typeof ShadowRoot === "function" ? ShadowRoot.prototype : null, "setHTMLUnsafe"], [Document, "parseHTMLUnsafe"]]) {
      try { if (owner && name in owner) Object.defineProperty(owner, name, { value: undefined, configurable: false, writable: false }); } catch (e) {}
    }
    // Markup that makes a shadow root would hide what is inside it from the watch above, so that
    // attribute is unnamed in everything written here. (It is done by hand: the usual ways to search a
    // string can be swapped by a page.)
    const codeAt = un(String.prototype.charCodeAt);
    const sliceOf = un(String.prototype.slice);
    const WORD = "shadowroot";
    const plain = (value) => {
      const html = "" + value;
      let out = "";
      let from = 0;
      for (let i = 0; i + WORD.length <= html.length; i++) {
        let hit = true;
        for (let j = 0; j < WORD.length && hit; j++) hit = (codeAt(html, i + j) | 32) === codeAt(WORD, j);
        if (!hit) continue;
        out += sliceOf(html, from, i) + "data-no-";
        from = i;
      }
      return out + sliceOf(html, from);
    };
    const writeTo = un(Document.prototype.write);
    for (const name of ["write", "writeln"]) {
      Object.defineProperty(Document.prototype, name, {
        value: function (...parts) {
          let text = "";
          for (let i = 0; i < parts.length; i++) text += parts[i];
          return writeTo(this, plain(text) + (name === "writeln" ? "\n" : ""));
        },
        writable: false,
        configurable: false,
      });
    }
  })();`;

export const MIN_HEIGHT = 48;
export const MAX_HEIGHT = 4000;
/** The longest message a page may send (an answer's text is cut well below this). */
export const MAX_MESSAGE = 20_000;
export const MAX_ANSWER = 4000;

/** A height the page or the block asked for, kept within what a card can be. */
export function clampHeight(value: unknown, fallback: number): number {
  const height = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)));
}

export type FrameTheme = { mode: "light" | "dark"; colors: Record<string, string> };

/** The app's colors by the names a page uses (the desktop app's own names). */
export function frameColors(colors: Record<string, string>): Record<string, string> {
  const pick = (name: string) => colors[name] ?? "";
  return {
    "--ink": pick("ink"),
    "--muted": pick("muted"),
    "--faint": pick("faint"),
    "--line": pick("line"),
    "--line-strong": pick("lineStrong"),
    "--paper": pick("surface"),
    "--surface": pick("surface"),
    "--sunken": pick("sunken"),
    "--raised": pick("raised"),
    "--canvas": pick("canvas"),
    "--rail": pick("sunken"),
    "--accent": pick("accent"),
    "--on-accent": pick("onAccent"),
    "--accent-soft": pick("accentSoft"),
    "--active": pick("sunken"),
    "--success": pick("success"),
    "--warning": pick("warning"),
    "--danger": pick("danger"),
    "--info": pick("info"),
    "--bubble": pick("bubble"),
  };
}

/** JSON that is safe inside a <script>: no way to end the script or start a comment. */
const LINE_SEPARATORS = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
export function inlineJson(value: unknown): string {
  return (JSON.stringify(value ?? null) ?? "null")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(LINE_SEPARATORS[0])
    .join("\\u2028")
    .split(LINE_SEPARATORS[1])
    .join("\\u2029");
}

// Runs inside the page, before the bot's own code. It gives the page its data and the app's colors,
// and three things it may ask for: its height, text for the person's message box, and a web page
// opened in the browser (the app asks the person first). The app talks back through __botkinsIn.
const BRIDGE = String.raw`(() => {
  const root = document.documentElement;
  const data = __DATA__;
  const pending = new Map();
  const themed = new Set();
  const stated = new Set();
  let seq = 0;
  let mode = __MODE__;
  // Nothing here talks peer to peer either: the policy can't say so, so the ways in are removed.
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebSocket", "EventSource", "WebTransport", "Worker", "SharedWorker"]) {
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  }
  const post = (type, more) => {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ botkins: 1, type }, more))); } catch (e) {}
  };
  const ask = (type, more) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      post(type, Object.assign({ id }, more));
    });
  const receive = (m) => {
    if (!m || typeof m !== "object") return;
    if (m.type === "theme") {
      mode = m.mode === "dark" ? "dark" : "light";
      root.dataset.theme = mode;
      root.style.colorScheme = mode;
      for (const [name, value] of Object.entries(m.colors || {})) if (/^--[a-z-]+$/.test(name)) root.style.setProperty(name, String(value));
      for (const fn of themed) { try { fn(mode); } catch (e) {} }
    } else if (m.type === "state") {
      // Someone else changed the panel's state.
      for (const fn of stated) { try { fn(m.state && typeof m.state === "object" ? m.state : {}); } catch (e) {} }
    } else if (m.type === "result") {
      const waiting = pending.get(m.id);
      pending.delete(m.id);
      if (waiting) m.error ? waiting.reject(new Error(String(m.error))) : waiting.resolve(m.value);
    }
  };
  Object.defineProperty(window, "__botkinsIn", { value: receive });
  const api = {
    getData: () => Promise.resolve(data),
    onData: (fn) => (fn(data), () => {}),
    sendAnswer: (text) => ask("answer", { text: String(text) }),
    openLink: (url) => ask("open", { url: String(url) }),
    theme: () => mode,
    onTheme: (fn) => (themed.add(fn), () => themed.delete(fn)),
    close: () => {},
    // A panel's saved state ("spaces-v1"): what people did in an app, kept on the computer. The app
    // answers; outside a panel get() is {} and set() is false.
    state: Object.freeze({
      get: () => ask("state").then((value) => (value && typeof value === "object" ? value : {}), () => ({})),
      set: (patch, label) => ask("setState", { patch, label: label === undefined ? undefined : String(label) }).then((saved) => saved === true, () => false),
      onChange: (fn) => (stated.add(fn), () => stated.delete(fn)),
    }),
  };
  api.sendMessage = api.sendAnswer;
  // Saved pages can also use either earlier spelling of the bridge.
  Object.defineProperty(window, "botkins", { value: Object.freeze(api) });
  Object.defineProperty(window, "commander", { value: window.botkins });
  Object.defineProperty(window, "bighelp", { value: window.botkins });
  root.dataset.theme = mode;
  // The page's own height, so the card is as tall as the page and the chat scrolls, not the view.
  let last = 0;
  const size = () => {
    const body = document.body;
    const height = Math.ceil(Math.max(body ? body.scrollHeight : 0, body ? body.offsetHeight : 0, root.offsetHeight, 1));
    if (height !== last) post("size", { height: (last = height) });
  };
  addEventListener("DOMContentLoaded", () => {
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(size).observe(root);
      if (document.body) new ResizeObserver(size).observe(document.body);
    }
    size();
  });
  addEventListener("load", size);
  // A link to a web page asks the app instead of leaving the view.
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
  // A page written on the computer can fail in a phone's browser engine. The first error is told to
  // the app, so a view that drew nothing says why it is empty.
  let told = false;
  addEventListener("error", (event) => {
    if (told || event.target !== window) return;
    told = true;
    post("error", { message: String((event && event.message) || "").slice(0, 200) });
  });
  post("ready");
})();`;

const BASE_STYLE =
  'font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--ink);-webkit-text-size-adjust:100%}' +
  "html,body{margin:0;background:transparent;overflow-wrap:break-word}" +
  "img,svg,canvas,video{max-width:100%}";

// Padding on the root element: a page rarely styles it, so the room stays when the bot's own body has padding of its own.
const bottomRoom = (bottom?: number) => {
  const room = typeof bottom === "number" && Number.isFinite(bottom) ? Math.max(0, Math.min(400, Math.round(bottom))) : 0;
  return room ? ":root{--inset-bottom:" + room + "px}html{padding-bottom:" + room + "px}" : "";
};

/**
 * The document the web view loads: the policy, the app's colors and the bridge first, then what
 * the bot wrote. `fill` is the full-screen view, where the page scrolls by itself. `bottom` is room
 * left under the page's end in that view, so its last line can scroll above what floats over the
 * frame (a panel's ask bar); the page can read it as `--inset-bottom`.
 */
export function framePage(html: string, data: unknown, theme: FrameTheme, options: { fill?: boolean; bottom?: number } = {}): string {
  const vars = Object.entries(theme.colors)
    .filter(([name, value]) => /^--[a-z-]+$/.test(name) && /^[#(),.%\sa-zA-Z0-9-]*$/.test(value))
    .map(([name, value]) => name + ":" + value)
    .join(";");
  const head =
    '<meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + FRAME_CSP + '">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1' + (options.fill ? "" : ", maximum-scale=1, user-scalable=no") + '">' +
    "<style>:root{color-scheme:" + theme.mode + ";" + vars + ";" + BASE_STYLE + (options.fill ? bottomRoom(options.bottom) : "html{overflow:hidden}") + "</style>" +
    "<script>" + NESTED_FRAME_GUARD + "\n" + BRIDGE.replace("__DATA__", () => inlineJson(data)).replace("__MODE__", () => JSON.stringify(theme.mode)) + "</script>";
  // The policy has to come before anything of the bot's, so the head is always the app's own.
  return "<!doctype html><html><head>" + head + "</head><body>" + html + "</body></html>";
}

export type FrameMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  /** A request the page may make, but not like this: it is told no. */
  | { type: "refused"; id: number }
  | { type: "size"; height: number }
  | { type: "answer"; id: number; text: string }
  | { type: "open"; id: number; url: string }
  /** A panel's page asks for its saved state, or to change it ("spaces-v1"). */
  | { type: "state"; id: number }
  | { type: "setState"; id: number; patch: Record<string, unknown>; label?: string };

/** A panel's state as the computer takes it: 64 KiB of JSON and 200 top-level keys at most. */
export const STATE_LIMITS = { bytes: 64 * 1024, keys: 200, label: 80 };
/** A view may save only within this long after a touch in it, and this often at most. */
export const STATE_TOUCH_MS = 3000;
export const STATE_PACE_MS = 1000;

/** A patch a page may send for its panel's state: a plain object within the limits. Anything else is refused. */
export function statePatch(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (!keys.length || keys.length > STATE_LIMITS.keys) return null;
  try {
    return JSON.stringify(value).length <= STATE_LIMITS.bytes ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One change a second from a view, however fast its page asks. */
export class StatePace {
  private last = new Map<string, number>();
  allow(frame: string, now = Date.now()): boolean {
    const before = this.last.get(frame);
    if (before !== undefined && now - before < STATE_PACE_MS) return false;
    this.last.set(frame, now);
    return true;
  }
}

/** What a page said, when it is one of the few things a page may say. Anything else is null. */
export function readFrameMessage(raw: unknown): FrameMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return null;
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.botkins !== 1) return null;
  if (m.type === "ready") return { type: "ready" };
  if (m.type === "error") return { type: "error", message: typeof m.message === "string" ? m.message.slice(0, 200) : "" };
  if (m.type === "size") return typeof m.height === "number" && Number.isFinite(m.height) ? { type: "size", height: m.height } : null;
  const id = typeof m.id === "number" && Number.isFinite(m.id) ? m.id : null;
  if (id === null) return null;
  if (m.type === "state") return { type: "state", id };
  if (m.type === "setState") {
    const patch = statePatch(m.patch);
    const label = typeof m.label === "string" && m.label.trim() ? m.label.trim().slice(0, STATE_LIMITS.label) : undefined;
    return patch ? { type: "setState", id, patch, ...(label && { label }) } : { type: "refused", id };
  }
  if (m.type === "answer") return typeof m.text === "string" && m.text.trim() ? { type: "answer", id, text: m.text.slice(0, MAX_ANSWER) } : { type: "refused", id };
  if (m.type === "open") return typeof m.url === "string" && m.url.length <= 2000 && /^https?:\/\/[^\s/?#]+/i.test(m.url) ? { type: "open", id, url: m.url } : { type: "refused", id };
  return null;
}

/** The script that hands the page a message from the app. */
export function frameScript(message: { type: "theme"; mode: "light" | "dark"; colors: Record<string, string> } | { type: "result"; id: number; value?: unknown; error?: string } | { type: "state"; state: Record<string, unknown> }): string {
  return "try{window.__botkinsIn(" + inlineJson(message) + ")}catch(e){};true;";
}

/** The only place a view's web view may go: the blank page its own document is loaded on. */
export const allowsLoad = (url: string, topFrame: boolean) => topFrame && url === "about:blank";

/** One answer every five seconds from a view, and six a minute from all of them, as on the computer. */
export class AnswerPace {
  private last = new Map<string, number>();
  private recent: number[] = [];
  allow(frame: string, now = Date.now()): boolean {
    this.recent = this.recent.filter((time) => now - time < 60_000);
    const before = this.last.get(frame);
    if ((before !== undefined && now - before < 5000) || this.recent.length >= 6) return false;
    this.last.set(frame, now);
    this.recent.push(now);
    return true;
  }
}
