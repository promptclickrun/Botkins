// An html block: a page a bot wrote, drawn in a sandboxed frame inside a Today panel or a chat card,
// in the spirit of MCP Apps. The frame loads from commander-app://frame-<id>/ (desktop/frames.mjs) with
// scripts only: no same origin, no network, no way to reach this page. It talks by postMessage, and
// every message is { commander: 1, type, … }; only messages from this frame's own window count.
import { useLayoutEffect, useRef, useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { APPEARANCE_EVENT } from "./appearance";

const api = window.botkins;
// The theme's colors a page may use, by the names the app's own styles use (src/tokens.css).
const COLORS = ["--ink", "--muted", "--faint", "--line", "--line-strong", "--paper", "--surface", "--sunken", "--raised", "--canvas", "--rail", "--accent", "--on-accent", "--accent-soft", "--active", "--success", "--warning", "--danger", "--info", "--bubble"] as const;
const MIN = 48;
const MAX = 4000;
/** How long a page may take to say it is ready before the frame shows that it didn't load. */
const PATIENCE = 10000;
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
  return { commander: 1, type: "theme", mode: root.dataset.mode === "dark" ? "dark" : "light", colors };
}

export default function HtmlFrame({ frame, height, title }: { frame: string; height: number; title?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
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
        (value) => post({ commander: 1, type: "result", id, value: value ?? null }),
        (e) => post({ commander: 1, type: "result", id, error: String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }),
      );
    const onMessage = (event: MessageEvent) => {
      if (!ref.current || event.source !== ref.current.contentWindow) return;
      const m = event.data;
      if (!m || typeof m !== "object" || m.commander !== 1 || typeof m.type !== "string") return;
      if (m.type === "ready") {
        heard.current = true;
        shown.current = true;
        setPhase("ready");
        post(theme());
      } else if (m.type === "size") setSize((s) => clamp(m.height, s));
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
        src={"commander-app://frame-" + frame + "/"}
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
