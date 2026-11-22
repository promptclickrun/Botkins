// A chat's Connect card: a bot asked the person to connect a Composio app (desktop/connects.mjs).
// Connect asks the computer to start or join the app's sign-in and opens the page it answers in
// the browser. Coming back to the window looks again; the computer goes on with the chat once.
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { AppLogo } from "./MarketApps";
import { errorText } from "./SettingsRows";
import type { ConnectCard as Card, ConnectStatus } from "./types";

const api = window.botkins;

/** What the card says under the app's name, and its button, for each state. */
const WORDS: Record<ConnectStatus, { line: (name: string) => string; button?: string }> = {
  needed: { line: (name) => "Connect your " + name + " account so the bot can go on.", button: "Connect" },
  waiting: { line: (name) => "Finish signing in to " + name + " in your browser.", button: "Open page again" },
  connected: { line: () => "Connected" },
  failed: { line: (name) => "Connecting " + name + " didn't finish.", button: "Try again" },
  expired: { line: () => "The sign-in page expired.", button: "Try again" },
  sign_in: { line: () => "Sign in with Composio in Marketplace › Apps first.", button: "Check again" },
  unavailable: { line: () => "This bot can't use Composio in this chat any more." },
};

export function ConnectCard({ chatId, card }: { chatId: string; card: Card }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const words = WORDS[card.status] ?? WORDS.needed;

  // Back from the browser: the computer looks at Composio again at once.
  useEffect(() => {
    if (card.status !== "waiting") return;
    const look = () => void api["composio.cardCheck"](chatId, card.id).catch(() => {});
    window.addEventListener("focus", look);
    return () => window.removeEventListener("focus", look);
  }, [chatId, card.id, card.status]);

  const press = async () => {
    setBusy(true);
    setError("");
    try {
      if (card.status === "sign_in") await api["composio.cardCheck"](chatId, card.id);
      else {
        const state = await api["composio.cardOpen"](chatId, card.id);
        if (state.url) await api.openLink(state.url);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="chat-card app-card connect-card" aria-label={"Connect " + card.name}>
      <AppLogo app={{ name: card.name, logo: card.logo ?? null }} size={38} />
      <span className="app-card-text">
        <strong>{card.status === "connected" ? card.name : "Connect " + card.name}</strong>
        <small className={card.status === "connected" ? "connect-done" : undefined} role="status">
          {card.status === "connected" && <Check size={13} strokeWidth={3} aria-hidden="true" />}
          {card.note || words.line(card.name)}
        </small>
        {error && <small className="connect-error">{error}</small>}
      </span>
      {words.button && (
        <button className={card.status === "needed" ? "primary" : "secondary"} disabled={busy} onClick={() => void press()}>
          {words.button}
        </button>
      )}
    </section>
  );
}
