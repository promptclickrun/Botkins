import { useEffect, useRef, useState } from "react";
import type { LinkPreview } from "./types";
import { liveOn, readAloud, stopReading } from "./voice";
import "./extras.css";

// Only a link the reader can see gets a preview: Markdown link targets and code are skipped, so a
// reply can't make Botkins fetch a hidden address.
const firstLink = (text: string) =>
  /\bhttps?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/i.exec(
    text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/\]\([^)]*\)/g, "] "),
  )?.[0];

/** A card for the first web link in a reply (Bighelp's link previews). Shows nothing when the page has no preview. */
export function LinkPreviewCard({ text, enabled }: { text: string; enabled: boolean }) {
  const url = enabled ? firstLink(text) : undefined;
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  useEffect(() => {
    setPreview(null);
    if (!url) return;
    let live = true;
    window.botkins
      .linkPreview(url)
      .then((p) => live && setPreview(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [url]);
  if (!preview) return null;
  return (
    <button
      className="link-preview"
      title={preview.url}
      onClick={() => void window.botkins.openLink(preview.url)}
      aria-label={"Open " + preview.title}
    >
      {preview.image && <img src={preview.image} alt="" />}
      <span>
        <small>{preview.site}</small>
        <strong>{preview.title}</strong>
        {preview.description && <span className="link-preview-text">{preview.description}</span>}
      </span>
    </button>
  );
}

/** Plain text for speech: Markdown marks, code and links removed. */
export function speakable(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>|#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Speaks text aloud with the voice chosen in Settings › Voice (src/voice.ts), or stops it when it is already being read. */
export function toggleSpeech(text: string) {
  void readAloud("text:" + text.length + ":" + text.slice(0, 80), text);
}

/** Reads each new reply aloud, once it is finished, while the setting is on and this chat is open. */
export function useReadAloud(enabled: boolean, chatId: string, latest?: { key: string; text: string; index?: number }, finished = true) {
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    last.current = latest?.key;
    return () => stopReading();
  }, [chatId]);
  useEffect(() => {
    if (!latest || latest.key === last.current || !finished) return;
    last.current = latest.key;
    if (enabled && latest.text && !liveOn()) void readAloud(latest.index != null ? chatId + ":" + latest.index : latest.key, latest.text);
  }, [latest?.key, enabled, finished]);
}
