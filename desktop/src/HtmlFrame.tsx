// An html block: a page a bot wrote, drawn in a sandboxed frame inside a Today panel or a chat card,
// in the spirit of MCP Apps. The frame loads from botkins-app://frame-<id>/ (desktop/frames.mjs) with
// scripts only: no same origin, no network, no way to reach this page. It talks by postMessage, and
// every message is { botkins: 1, type, … }; only messages from this frame's own window count.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { APPEARANCE_EVENT } from "./appearance";
import { cleanLabel, cleanPatch, saveGate, type FrameStore } from "./frameState";

const api = window.botkins;
// The theme's colors a page may use, by the names the app's own styles use (src/tokens.css).
const COLORS = ["--ink", "--muted", "--faint", "--line", "--line-strong", "--paper", "--surface", "--sunken", "--raised", "--canvas", "--rail", "--accent", "--on-accent", "--accent-soft", "--active", "--success", "--warning", "--danger", "--info", "--bubble"] as const;
const MIN = 48;
const MAX = 4000;
/** How long a page may take to say it is ready before the frame shows that it didn't load. */
const PATIENCE = 10000;
// A real click or key press inside a view, by the view's id. The main process tells of it from a
// script of its own inside the frame, which the page cannot reach or imitate (desktop/preload.cjs).
// An older main process says nothing, and then no view may save.
const gates = new Map<string, ReturnType<typeof saveGate>>();
const gateOf = (frame: string) => gates.get(frame) ?? gates.set(frame, saveGate()).get(frame)!;
api.onFrameGesture?.(({ frame }) => gateOf(frame).gesture());

const clamp = (n: unknown, fallback: number) => {
  const value = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.round(Math.min(MAX, Math.max(MIN, value)));
};

/** The app's look as a frame receives it: light or dark, and its colors from the page's CSS variables. */
function theme() {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const colors: Record<string, string> = {};
  for (const name of COLORS) colors[name] = css.getPropertyValue(name).trim();
  return { botkins: 1, type: "theme", mode: root.dataset.mode === "dark" ? "dark" : "light", colors };
}

export default function HtmlFrame({ frame, height, title, store }: { frame: string; height: number; title?: string; /** The panel's saved state, for a view in a panel of a space. */ store?: FrameStore }) {
  const ref = useRef<HTMLIFrameElement>(null);
  // The state as it is now, for the listener below, and the revisions this view's own saves made.
  const held = useRef(store);
  held.current = store;
  const ownRevs = useRef(new Set<number>());
  const toldRev = useRef(store?.rev);
  const [size, setSize] = useState(() => clamp(height, 160));
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  // Reload makes a new frame.
  const [attempt, setAttempt] = useState(0);
  const name = title || "View from a bot";
  // The bridge says "ready" each time the page loads. A load without it is something else: an error page.
  const heard = useRef(false);
  const shown = useRef(false);
  const restores = useRef<number[]>([]);

  // A layout effect, so the listener is there before the frame can say it is ready.
  useLayoutEffect(() => {
    setPhase("loading");
    const frameWindow = () => ref.current?.contentWindow ?? null;
    const post = (message: object) => frameWindow()?.postMessage(message, "*");
    const reply = (id: unknown, work: Promise<unknown>) =>
      work.then(
        (value) => post({ botkins: 1, type: "result", id, value: value ?? null }),
        (e) => post({ botkins: 1, type: "result", id, error: String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }),
      );
    const onMessage = (event: MessageEvent) => {
      if (!ref.current || event.source !== ref.current.contentWindow) return;
      const m = event.data;
      if (!m || typeof m !== "object" || m.botkins !== 1 || typeof m.type !== "string") return;
      if (m.type === "ready") {
        // The bridge says this before any of the page's own code runs: a new page starts with no click to its name.
        gateOf(frame).reset();
        heard.current = true;
        shown.current = true;
        setPhase("ready");
        post(theme());
      } else if (m.type === "size") setSize((s) => clamp(m.height, s));
      // botkins.state.get(): a view in a chat has no state.
      else if (m.type === "state") post({ botkins: 1, type: "result", id: m.id, value: held.current?.state ?? {} });
      // botkins.state.set(): passed on only soon after the person clicked or typed in this view, and
      // not too often. Anything else answers false and saves nothing.
      else if (m.type === "setState") {
        const patch = cleanPatch(m.patch);
        const save = held.current?.set;
        const refuse = () => post({ botkins: 1, type: "result", id: m.id, value: false });
        if (!patch || !save || !gateOf(frame).allow()) refuse();
        else
          save(patch, cleanLabel(m.label)).then((rev) => {
            ownRevs.current.add(rev);
            post({ botkins: 1, type: "result", id: m.id, value: true });
          }, refuse);
      }
      else if (m.type === "answer" || m.type === "open") {
        // Only a view the person is working in may hand over text or ask to open a page: the frame has
        // the focus once they click or tab into it. A view that is merely on screen can't act by itself.
        if (document.activeElement !== ref.current) reply(m.id, Promise.reject(new Error("Click inside this view first.")));
        else if (m.type === "answer") reply(m.id, api.frameAnswer(frame, String(m.text ?? "")));
        else reply(m.id, api.frameOpenLink(frame, String(m.url ?? "")));
      }
    };
    const onTheme = () => post(theme());
    window.addEventListener("message", onMessage);
    window.addEventListener(APPEARANCE_EVENT, onTheme);
    // The app's colors also change with the theme, which sets them on the root element.
    const watch = new MutationObserver(onTheme);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-theme", "style"] });
    const timer = window.setTimeout(() => setPhase((p) => (p === "loading" ? "failed" : p)), PATIENCE);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener(APPEARANCE_EVENT, onTheme);
      watch.disconnect();
      window.clearTimeout(timer);
    };
  }, [frame, attempt]);

  // botkins.state.onChange(): the page hears of a change someone else made, not of its own save.
  const rev = store?.rev;
  useEffect(() => {
    if (rev === undefined || rev === toldRev.current) return;
    toldRev.current = rev;
    if (ownRevs.current.delete(rev)) return;
    ref.current?.contentWindow?.postMessage({ botkins: 1, type: "state", state: held.current?.state ?? {} }, "*");
  }, [rev]);

  if (phase === "failed")
    return (
      <div className="html-frame failed" role="status">
        <TriangleAlert size={16} aria-hidden="true" />
        <span>This view didn't load.</span>
        <button type="button" className="secondary" onClick={() => setAttempt((n) => n + 1)}>
          <RefreshCw size={13} aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  return (
    <div className={"html-frame" + (phase === "loading" ? " loading" : "")} style={{ ["--frame-start" as string]: clamp(height, 160) + "px" }}>
      <iframe
        key={attempt}
        ref={ref}
        sandbox="allow-scripts"
        src={"botkins-app://frame-" + frame + "/"}
        referrerPolicy="no-referrer"
        title={name}
        height={size}
        style={{ height: size }}
        onError={() => setPhase("failed")}
        onLoad={() =>
          window.setTimeout(() => {
            if (heard.current) return void (heard.current = false);
            // The page tried to leave its frame: the app blocks that, so put the page back where it was
            // (a few times at most, so a page that keeps trying ends as "didn't load").
            const now = Date.now();
            restores.current = restores.current.filter((t) => now - t < 30000);
            if (shown.current && restores.current.length < 3) {
              restores.current.push(now);
              setAttempt((n) => n + 1);
            } else setPhase("failed");
          }, 400)
        }
      />
      {phase === "loading" && <span className="html-frame-wait" aria-label={"Loading " + name} role="status" />}
    </div>
  );
}
