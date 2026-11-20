import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { findPathSpans } from "../desktop/path-detector.mjs";
import type { Artifact } from "./types";

export type FilePreview = { item: Artifact; local: boolean };
export type ChatFiles = { chatId: string; botId: string; hostId?: string; remote: boolean; preview: (file: FilePreview) => void };
type Found = { path: string; start: number; end: number; item: Artifact };
export const ChatFileContext = createContext<{ files?: ChatFiles; found: Found[] }>({ found: [] });

export function useChatFiles(text: string, files?: ChatFiles) {
  const candidates = useMemo(() => files ? findPathSpans(text) : [], [text, !!files]);
  const [checked, setChecked] = useState<{ key: string; found: Found[] }>();
  const key = JSON.stringify([text, files?.chatId, files?.botId, files?.hostId, files?.remote]);
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
      if (current) setChecked({ key, found: candidates.flatMap((span) => {
        const item = valid.get(span.path);
        return item ? [{ ...span, item }] : [];
      }) });
    }
    const handle = window.setTimeout(() => {
      void check(files).catch(() => { if (current) setChecked({ key, found: [] }); });
    }, 75);
    return () => { current = false; window.clearTimeout(handle); };
  }, [key, candidates]);
  return useMemo(() => checked?.key === key ? checked.found : [], [checked, key]);
}

type MdNode = { type: string; value?: string; children?: MdNode[]; position?: { start: { offset?: number }; end: { offset?: number } }; data?: unknown };

// Link only the exact text nodes established by the detector and the host.
// Existing Markdown links retain their own destinations and labels.
export function pathMarkup(text: string, found: Found[]) {
  return () => (tree: MdNode) => {
    function replace(node: MdNode): MdNode[] {
      if (["link", "image", "linkReference", "imageReference", "definition", "code"].includes(node.type)) return [node];
      if (node.type !== "text" && node.type !== "inlineCode") {
        if (node.children) node.children = node.children.flatMap(replace);
        return [node];
      }
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start == null || end == null || !node.value) return [node];
      const out: MdNode[] = [];
      let consumed = 0;
      found.forEach((span, index) => {
        if (span.start < start || span.end > end) return;
        const label = text.slice(span.start, span.end);
        const begin = node.value!.indexOf(label, consumed);
        if (begin < 0) return;
        if (begin > consumed) out.push({ type: "text", value: node.value!.slice(consumed, begin) });
        out.push({ type: "chatFile", data: { hName: "span", hProperties: { "data-chat-file": index } }, children: [{ type: "text", value: label }] });
        consumed = begin + label.length;
      });
      if (!out.length) return [node];
      if (consumed < node.value.length) out.push({ type: "text", value: node.value.slice(consumed) });
      return out;
    }
    replace(tree);
  };
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
