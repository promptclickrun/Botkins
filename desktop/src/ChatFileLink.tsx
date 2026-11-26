import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { findPathSpans } from "../desktop/path-detector.mjs";
import type { Artifact } from "./types";
import { mediaPlaces } from "./mediaParts";

export { pathMarkup } from "./mediaParts";

export type FilePreview = { item: Artifact; local: boolean };
/** `revision`: the computer's artifact index revision; a change asks about the paths again (a reply's attachments are recorded just after it is written). */
export type ChatFiles = { chatId: string; botId: string; hostId?: string; remote: boolean; revision?: number; preview: (file: FilePreview) => void };
/** A path in a reply that the computer answered for. `media`: a `MEDIA:` attachment the computer knows, drawn in place of its text (`again`: an earlier place draws it). */
export type Found = { path: string; start: number; end: number; item: Artifact; media?: Artifact; again?: boolean };
export const ChatFileContext = createContext<{ files?: ChatFiles; found: Found[] }>({ found: [] });

export function useChatFiles(text: string, files?: ChatFiles) {
  const candidates = useMemo(() => files ? findPathSpans(text) : [], [text, !!files]);
  const [checked, setChecked] = useState<{ key: string; found: Found[] }>();
  // Only a reply that writes MEDIA: waits on the index: other paths are links that don't depend on it.
  const media = candidates.some((span) => span.media);
  const key = JSON.stringify([text, files?.chatId, files?.botId, files?.hostId, files?.remote, media ? files?.revision : 0]);
  useEffect(() => {
    if (!files || !candidates.length) return;
    let current = true;
    async function check(scope: ChatFiles) {
      const paths = [...new Set(candidates.map((span) => span.path))];
      const valid = new Map<string, Artifact>();
      for (let i = 0; i < paths.length && current; i += 20) {
        const batch = paths.slice(i, i + 20);
        const results = scope.remote
          ? (await window.botkins["artifacts.resolve"]({ chatId: scope.chatId, paths: batch })).items
          : (await window.botkins.inspectChatPaths(batch)).map((info) => info && ({
              ...info, id: info.path, botId: scope.botId, time: 0, source: "tool" as const,
            }));
        results.forEach((item, index) => { if (item) valid.set(batch[index], item); });
      }
      // A MEDIA: attachment is drawn only when the computer knows the file as the chat's own.
      // On this computer a path's link asks only whether the file is there, so that is asked apart.
      const known = new Map<string, Artifact>();
      const sent = [...new Set(candidates.filter((span) => span.media).map((span) => span.path))];
      if (scope.remote) for (const path of sent) { const item = valid.get(path); if (item) known.set(path, item); }
      else for (let i = 0; i < sent.length && current; i += 20) {
        const batch = sent.slice(i, i + 20);
        const items = await window.botkins["artifacts.resolve"]({ chatId: scope.chatId, paths: batch }).then((reply) => reply.items, () => []);
        items.forEach((item, index) => { if (item) known.set(batch[index], item); });
      }
      const places = mediaPlaces(candidates, known);
      if (current) setChecked({ key, found: candidates.flatMap((span, index) => {
        const { media: _sent, ...place } = span;
        const item = valid.get(span.path) ?? places[index]?.media;
        return item ? [{ ...place, item, ...places[index] }] : [];
      }) });
    }
    const handle = window.setTimeout(() => {
      void check(files).catch(() => { if (current) setChecked({ key, found: [] }); });
    }, 75);
    return () => { current = false; window.clearTimeout(handle); };
  }, [key, candidates]);
  return useMemo(() => checked?.key === key ? checked.found : [], [checked, key]);
}

export function FileLink({ index, children }: { index: number; children: ReactNode }) {
  const { files, found } = useContext(ChatFileContext);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [error, setError] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(undefined); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); };
  }, [menu]);
  const target = found[index];
  if (!files || !target) return <>{children}</>;
  const scope = files;
  async function act(action: "open" | "reveal" | "preview" | "copy") {
    setMenu(undefined);
    setError("");
    try {
      if (action === "copy") await window.botkins.copyText(target.item.path);
      else if (action === "preview" || (scope.remote && action === "open")) {
        const item = scope.remote ? target.item : (await window.botkins["artifacts.resolve"]({ chatId: scope.chatId, paths: [target.path] })).items[0];
        scope.preview({ item: item ?? target.item, local: !item });
      } else await window.botkins.openChatPath(target.item.path, action);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  function showMenu(x: number, y: number) {
    setMenu({ x: Math.max(4, Math.min(x, innerWidth - 190)), y: Math.max(4, Math.min(y, innerHeight - 126)) });
  }
  return <>
    <a href="#" title={target.item.path} onClick={(e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.ctrlKey || e.metaKey) showMenu(e.clientX, e.clientY);
      else void act("open");
    }} onContextMenu={(e) => {
      e.preventDefault(); e.stopPropagation(); showMenu(e.clientX, e.clientY);
    }}>{children}</a>
    {error && <small role="alert">{error}</small>}
    {menu && createPortal(<div className="chat-file-menu" ref={menuRef} role="menu" style={{ left: menu.x, top: menu.y }}>
      {!scope.remote && <button type="button" role="menuitem" onClick={() => void act("reveal")}>Show in folder</button>}
      <button type="button" role="menuitem" onClick={() => void act("preview")}>Preview in Artifacts</button>
      <button type="button" role="menuitem" onClick={() => void act("copy")}>Copy path</button>
    </div>, document.body)}
  </>;
}
