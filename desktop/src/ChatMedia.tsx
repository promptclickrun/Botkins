// A MEDIA: attachment drawn in a reply, where its line was (rules: src/mediaParts.ts).
import { useContext, useEffect, useState } from "react";
import { File as FileIcon, FileAudio, FileImage, FileVideo } from "lucide-react";
import { ChatFileContext } from "./ChatFileLink";
import { isPicture, readsWhole } from "./mediaParts";
import type { Artifact } from "./types";

const sizeText = (size: number | null) => size == null ? "" : size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 102.4) / 10} KB` : `${Math.round(size / 104857.6) / 10} MB`;

/** The picture's own file, read in parts, as an address the window can draw. */
async function wholePicture(item: Artifact) {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let total = 0;
  const limit = item.size ?? 0;
  while (total < limit) {
    const reply = await window.botkins["artifacts.read"](item.id, { offset, length: Math.min(512 * 1024, limit - total) });
    const bytes = Uint8Array.from(atob(reply.data), (character) => character.charCodeAt(0));
    chunks.push(bytes);
    total += bytes.byteLength;
    if (!bytes.byteLength || reply.nextOffset == null || reply.nextOffset <= offset) break;
    offset = reply.nextOffset;
  }
  if (!total) throw new Error("Empty picture.");
  return URL.createObjectURL(new Blob(chunks as BlobPart[], { type: item.mime }));
}

/** The small picture the computer makes. A computer with no display makes none. */
async function smallPicture(item: Artifact) {
  const image = await window.botkins["artifacts.thumbnail"](item.id, { size: 512 });
  return image ? `data:${image.mime};base64,${image.data}` : null;
}

// What was read stays for the pictures on screen and a few more, so a reply drawn again does not read its files again.
const KEPT = 40;
const held = new Map<string, Promise<string | null>>();
function picture(key: string, read: () => Promise<string | null>) {
  let wait = held.get(key);
  if (wait) held.delete(key);
  else {
    wait = read().catch(() => null);
    void wait.then((url) => { if (!url && held.get(key) === wait) held.delete(key); });
  }
  held.set(key, wait);
  for (const [old, gone] of held) {
    if (held.size <= KEPT) break;
    held.delete(old);
    void gone.then((url) => { if (url?.startsWith("blob:")) URL.revokeObjectURL(url); });
  }
  return wait;
}

function Chip({ item, open }: { item: Artifact; open: () => void }) {
  const Icon = item.kind === "image" ? FileImage : item.kind === "video" ? FileVideo : item.kind === "audio" ? FileAudio : FileIcon;
  const size = sizeText(item.size);
  return (
    <span className="chat-media">
      <button type="button" className="chat-media-chip" title={item.path} onClick={open}>
        <Icon size={15} aria-hidden="true" />
        <span className="chat-media-name">{item.name}</span>
        {size && <small>{size}</small>}
      </button>
    </span>
  );
}

function PictureIn({ item, host, open }: { item: Artifact; host: string; open: () => void }) {
  const key = [host, item.id, item.size, item.time].join("\u0000");
  // The file itself first, sharp; where it is too large, or the window cannot draw its kind, the small picture.
  const [step, setStep] = useState<"whole" | "small">(readsWhole(item) ? "whole" : "small");
  const [shown, setShown] = useState<{ key: string; url: string | null }>();
  useEffect(() => {
    let current = true;
    void picture(key + "\u0000" + step, () => step === "whole" ? wholePicture(item) : smallPicture(item)).then((url) => {
      if (!current) return;
      if (!url && step === "whole") setStep("small");
      else setShown({ key: key + step, url });
    });
    return () => { current = false; };
  }, [key, step]);
  const mine = shown?.key === key + step ? shown : undefined;
  if (mine && !mine.url) return <Chip item={item} open={open} />;
  return (
    <span className="chat-media">
      <button type="button" className="chat-media-picture" title={item.name} aria-label={"Open " + item.name} aria-busy={!mine} onClick={open}>
        {mine?.url && <img src={mine.url} alt={item.name} draggable={false} onError={() => step === "whole" ? setStep("small") : setShown({ key: key + step, url: null })} />}
      </button>
    </span>
  );
}

/** The attachment at place `index` of the reply's found paths. A click opens it in Artifacts. */
export function ChatMedia({ index }: { index: number }) {
  const { files, found } = useContext(ChatFileContext);
  const item = found[index]?.media;
  if (!files || !item) return null;
  const open = () => files.preview({ item, local: false });
  return isPicture(item) ? <PictureIn item={item} host={files.hostId ?? ""} open={open} /> : <Chip item={item} open={open} />;
}
