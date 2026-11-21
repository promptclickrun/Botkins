// An app panel, opened: the same panel on a page of its own, large, with the bar
// "Ask <bot> to change it" under it. The panel is the one on the space's page, with its saved
// state and its notes; only the room it gets changes.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, X } from "lucide-react";
import { BotAvatar } from "./Avatar";
import type { Bot } from "./types";

export default function OpenedPanel({
  title,
  bot,
  children,
  ask,
  close,
}: {
  title: string;
  /** The panel's bot, when the person may ask it. */
  bot?: Bot;
  /** The panel itself. */
  children: ReactNode;
  /** Asks the bot about this panel and opens the chat it answers. */
  ask?: (text: string) => Promise<void>;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="space-opened" aria-label={title} onCancel={close} onClose={close}>
      <button type="button" className="space-opened-close" aria-label="Close" onClick={close}>
        <X size={18} />
      </button>
      <div className="space-opened-panel">{children}</div>
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
