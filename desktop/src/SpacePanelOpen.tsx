// An app panel, opened: the same panel on a page of its own, large (or full screen), with the
// bar "Ask <bot> to change it" under it. The panel is the one on the space's page, with its saved
// state and its notes; only the room it gets changes. Over the bar are the panel's asks: what its
// bot says is worth asking next. A click puts one in the field and does not send it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Maximize2, Minimize2, X } from "lucide-react";
import { BotAvatar } from "./Avatar";
import {
  PANEL_FULLSCREEN_SUFFIX,
  isPanelFullscreenShortcut,
  isRepeatedPanelEscape,
  panelCancelAction,
  resolvePanelFullscreen,
  shouldPersistPanelFullscreen,
  trustedFrameKeyAction,
  writePanelFullscreen,
  type PanelFullscreenSource,
} from "./panelOpen";
import { MOD } from "./places";
import { storageKey } from "./storage";
import type { Bot } from "./types";

const FULLSCREEN_HINT = MOD === "⌘" ? "⇧⌘F" : "Ctrl+Shift+F";

function isTopOpenedPanel(dialog: HTMLDialogElement | null): dialog is HTMLDialogElement {
  if (!dialog?.open) return false;
  if (dialog.querySelector("dialog[open]")) return false;
  for (const other of document.querySelectorAll("dialog:modal")) {
    if (other !== dialog) return false;
  }
  return true;
}

function isFocusInPanelFrame(dialog: HTMLDialogElement): boolean {
  const active = document.activeElement;
  return active instanceof HTMLIFrameElement && dialog.contains(active) && active.closest("dialog[open]") === dialog;
}

export default function OpenedPanel({
  title,
  bot,
  children,
  ask,
  asks = [],
  frameIds = [],
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
  /** Active custom HTML frame ids inside this opened panel, if any. */
  frameIds?: string[];
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
  const closedRef = useRef(false);
  const frameKey = frameIds.join(",");

  const applyFullscreen = (next: boolean, source: PanelFullscreenSource) => {
    setFullscreen(next);
    if (shouldPersistPanelFullscreen(source)) writePanelFullscreen(storageKey(PANEL_FULLSCREEN_SUFFIX), next);
  };

  const finishClose = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    window.botkins.setPanelOpen?.([]);
    closeRef.current();
  };

  const requestClose = () => {
    const dialog = ref.current;
    if (dialog?.open) dialog.close();
    else finishClose();
  };

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useLayoutEffect(() => {
    if (closedRef.current) return;
    window.botkins.setPanelOpen?.(frameKey ? frameKey.split(",") : []);
    return () => {
      window.botkins.setPanelOpen?.([]);
    };
  }, [frameKey]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const dialog = ref.current;
      if (!isTopOpenedPanel(dialog)) return;
      if (isFocusInPanelFrame(dialog)) return;
      if (!isPanelFullscreenShortcut(e)) return;
      const targetDialog = e.target instanceof Element ? e.target.closest("dialog[open]") : null;
      if (targetDialog && targetDialog !== dialog) return;
      const activeDialog = document.activeElement instanceof Element ? document.activeElement.closest("dialog[open]") : null;
      if (activeDialog && activeDialog !== dialog) return;
      e.preventDefault();
      applyFullscreen(!fullscreenRef.current, "toggle");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const off = window.botkins.onPanelKey?.((data) => {
      const dialog = ref.current;
      if (!isTopOpenedPanel(dialog) || !isFocusInPanelFrame(dialog)) return;
      const action = trustedFrameKeyAction(data?.key, fullscreenRef.current);
      if (action === "toggle") applyFullscreen(!fullscreenRef.current, "toggle");
      else if (action === "restore") applyFullscreen(false, "escape");
    });
    return () => off?.();
  }, []);

  const toggleLabel = fullscreen ? "Exit full screen" : "Full screen";

  return (
    <dialog
      ref={ref}
      className={"space-opened" + (fullscreen ? " fullscreen" : "")}
      aria-label={title}
      onKeyDown={(e) => {
        const targetDialog = e.target instanceof Element ? e.target.closest("dialog[open]") : null;
        if (targetDialog && targetDialog !== e.currentTarget) return;
        if (isRepeatedPanelEscape(e)) e.preventDefault();
      }}
      onCancel={(e) => {
        const action = panelCancelAction(fullscreenRef.current, e.target === e.currentTarget);
        if (action === "restore") {
          e.preventDefault();
          applyFullscreen(false, "escape");
        }
      }}
      onClose={(e) => {
        if (e.target !== e.currentTarget) return;
        finishClose();
      }}
    >
      <div className="space-opened-actions">
        <button
          type="button"
          className="space-opened-toggle"
          aria-label={toggleLabel}
          aria-pressed={fullscreen}
          title={toggleLabel + " (" + FULLSCREEN_HINT + ")"}
          onClick={() => applyFullscreen(!fullscreen, "toggle")}
        >
          {fullscreen ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
        </button>
        <button type="button" className="space-opened-close" aria-label="Close" title="Close" onClick={requestClose}>
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
