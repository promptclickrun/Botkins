// An app panel, opened: the same panel on a page of its own, large (or full screen), with the
// bar "Ask <bot> to change it" under it. The panel is the one on the space's page, with its saved
// state and its notes; only the room it gets changes. Over the bar are the panel's asks: what its
// bot says is worth asking next. A click puts one in the field and does not send it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Maximize2, Minimize2, X } from "lucide-react";
import { BotAvatar } from "./Avatar";
import { PANEL_FULLSCREEN_SUFFIX, openedPanelKeyAction, resolvePanelFullscreen, writePanelFullscreen } from "./panelOpen";
import { MOD } from "./places";
import { storageKey } from "./storage";
import type { Bot } from "./types";

const FULLSCREEN_HINT = MOD === "⌘" ? "⇧⌘F" : "Ctrl+Shift+F";

export default function OpenedPanel({
  title,
  bot,
  children,
  ask,
  asks = [],
  initialFullscreen,
  close,
}: {
  title: string;
  /** The panel's bot, when the person may ask it. */
  bot?: Bot;
  /** The panel itself. */
  children: ReactNode;
  /** Asks the bot about this panel and opens the chat it answers. */
  ask?: (text: string) => Promise<void>;
  /** The panel's asks, cleaned (`asksOf`). Shown only with the ask bar. */
  asks?: string[];
  /** Explicit opening mode (e.g. "Open full screen"); otherwise uses the remembered choice. */
  initialFullscreen?: boolean;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const [fullscreen, setFullscreen] = useState(() => resolvePanelFullscreen(initialFullscreen, storageKey(PANEL_FULLSCREEN_SUFFIX)));
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const closeRef = useRef(close);
  closeRef.current = close;

  const setRememberedFullscreen = (next: boolean) => {
    setFullscreen(next);
    writePanelFullscreen(storageKey(PANEL_FULLSCREEN_SUFFIX), next);
  };

  useEffect(() => {
    // Opening explicitly in full screen (e.g. from the panel menu) also remembers that choice.
    if (typeof initialFullscreen === "boolean") writePanelFullscreen(storageKey(PANEL_FULLSCREEN_SUFFIX), initialFullscreen);
  }, [initialFullscreen]);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const dialog = ref.current;
      if (!dialog?.open) return;
      const openDialogs = document.querySelectorAll("dialog[open]");
      if (openDialogs[openDialogs.length - 1] !== dialog) return;
      const action = openedPanelKeyAction(e, fullscreenRef.current);
      if (!action) return;
      e.preventDefault();
      if (action === "toggle") {
        setRememberedFullscreen(!fullscreenRef.current);
      } else if (action === "restore") {
        // Esc exits full screen first without wiping the saved full-screen preference.
        setFullscreen(false);
      } else {
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const toggleLabel = fullscreen ? "Exit full screen" : "Full screen";

  return (
    <dialog
      ref={ref}
      className={"space-opened" + (fullscreen ? " fullscreen" : "")}
      aria-label={title}
      onCancel={(e) => {
        if (fullscreenRef.current) {
          e.preventDefault();
          setFullscreen(false);
          return;
        }
        close();
      }}
      onClose={close}
    >
      <div className="space-opened-actions">
        <button
          type="button"
          className="space-opened-toggle"
          aria-label={toggleLabel}
          aria-pressed={fullscreen}
          title={toggleLabel + " (" + FULLSCREEN_HINT + ")"}
          onClick={() => setRememberedFullscreen(!fullscreen)}
        >
          {fullscreen ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
        </button>
        <button type="button" className="space-opened-close" aria-label="Close" title="Close" onClick={close}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="space-opened-panel">{children}</div>
      {bot && ask && asks.length > 0 && (
        <div className="space-asks" role="group" aria-label={"Ideas to ask " + bot.name}>
          {asks.map((one) => (
            <button
              type="button"
              key={one}
              onClick={() => {
                // The words go in the field for the person to read, change and send.
                setText(one);
                field.current?.focus();
              }}
            >
              {one}
            </button>
          ))}
        </div>
      )}
      {bot && ask && (
        <form
          className="space-ask space-opened-ask"
          onSubmit={(e) => {
            e.preventDefault();
            const said = text.trim();
            if (!said || asking) return;
            setAsking(true);
            void ask(said).finally(() => setAsking(false));
          }}
        >
          <BotAvatar bot={bot} size={26} />
          <input
            ref={field}
            aria-label={"Ask " + bot.name + " to change it"}
            placeholder={"Ask " + bot.name + " to change it"}
            value={text}
            maxLength={8000}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="space-send" aria-label="Send" disabled={!text.trim() || asking}>
            <ArrowUp size={16} />
          </button>
        </form>
      )}
    </dialog>
  );
}
