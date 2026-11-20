import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import type { Bot } from "./types";
import { useAsk } from "./Pages";
import { errorText } from "./SettingsRows";
import { stopCancel } from "./SkillsSettings";
import "./integrations.css";

const api = window.botkins;
/** Characters a bot's memory may hold (desktop/memory.mjs MEMORY_MAX). */
export const MEMORY_LIMIT = 24000;

/** Bots & capabilities › Memory: the bot's MEMORY.md, editable, with Save, Revert, Refresh and Clear. */
export default function BotMemory({ bot }: { bot: Bot }) {
  const [saved, setSaved] = useState<string>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const dialogs = useAsk();
  async function load() {
    setError("");
    try {
      const value = await api.botMemory(bot.id);
      setSaved(value);
      setText(value);
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    setSaved(undefined);
    setNote("");
    void load();
  }, [bot.id]);
  async function write(value: string, done: string) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api.setBotMemory(bot.id, value);
      await load();
      setNote(done);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    const ok = await dialogs.ask({
      title: "Clear " + bot.name + "'s memory?",
      body: bot.name + " forgets everything saved here. Chats are kept.",
      confirm: "Clear memory",
      danger: true,
    });
    if (ok) await write("", "Memory cleared.");
  }
  const dirty = saved !== undefined && text !== saved;
  const over = text.length > MEMORY_LIMIT;
  return (
    <section className="set-group int-memory" {...stopCancel}>
      <div className="int-grouphead">
        <h3>Memory</h3>
        {!dirty && (
          <button type="button" className="set-link int-refresh" disabled={busy || saved === undefined} onClick={() => void load().then(() => setNote(""))}>
            <RotateCw size={12} aria-hidden="true" />
            Refresh
          </button>
        )}
      </div>
      <div className="set-card">
        <div className="set-row stacked">
          <label className="visually-hidden" htmlFor="bot-memory">
            {bot.name}'s memory
          </label>
          <textarea
            id="bot-memory"
            className="int-mono-area"
            rows={13}
            spellCheck={false}
            disabled={saved === undefined}
            aria-describedby="bot-memory-help bot-memory-count"
            placeholder={saved === undefined ? "Loading…" : "Nothing saved yet. Add facts " + bot.name + " should always know, one per line."}
            value={text}
            onChange={(e) => {
              setNote("");
              setText(e.target.value);
            }}
          />
        </div>
        <div className="set-actions">
          <span className={"set-wait int-count-note" + (over ? " over" : "")} id="bot-memory-count" role={note ? "status" : undefined}>
            {note || text.length.toLocaleString() + " of " + MEMORY_LIMIT.toLocaleString() + " characters" + (dirty ? " · Not saved" : "")}
          </span>
          <button type="button" className="set-button danger" disabled={busy || !saved} onClick={() => void clear()}>
            Clear memory…
          </button>
          {dirty && (
            <button type="button" className="set-button" disabled={busy} onClick={() => setText(saved ?? "")}>
              Revert
            </button>
          )}
          <button type="button" className="set-button primary" disabled={busy || !dirty || over} onClick={() => void write(text, "Memory saved.")}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <p className="set-foot" id="bot-memory-help">
        {bot.name} saves facts here to remember them in every chat. You can edit or remove them.
      </p>
      {error && (
        <p className="set-status error-text" role="alert">
          {error}
        </p>
      )}
      {dialogs.node}
    </section>
  );
}
