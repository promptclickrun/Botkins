// Arranging in Spaces, with no edit mode: dragging pinned spaces in the side menu, dragging a panel
// to another slot on a space's page, and pulling a panel's corner to Small, Wide or Tall. The order
// and the sizes are kept on the computer. The pure parts (where things land, what a pull snaps to)
// are in spaces.ts. Dragging follows useBotDrag.tsx and SidebarSettings.tsx: the browser's own drag
// and drop, with a line or a slot where it lands.
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { arrangeMove, panelDrop, PANEL_SIZES, snapSize, stepSize, type PanelSize, type SpaceSummary } from "./spaces";

const api = window.botkins;
const spaceType = "application/x-botkins-space";
const panelType = "application/x-botkins-panel";

/**
 * Dragging pinned spaces up or down the side menu. A line shows where one lands; dropping sends the
 * person's new order. Until the computer answers, the menu shows the new order.
 */
export function useSpaceDrag(spaces: SpaceSummary[], fail: (e: unknown) => void) {
  const [dragging, setDragging] = useState("");
  const [over, setOver] = useState<{ id: string; after: boolean }>();
  const [moved, setMoved] = useState<string[]>();
  // The computer's answer replaces the order shown.
  useEffect(() => setMoved(undefined), [spaces]);
  const pinned = spaces.filter((s) => s.pinned);
  const shown = moved ? (moved.map((id) => pinned.find((s) => s.id === id)).filter(Boolean) as SpaceSummary[]) : pinned;
  function end() {
    setDragging("");
    setOver(undefined);
  }
  /** Sends an order, and shows it until the computer's answer comes. */
  function send(next: { order: string[]; pinned: string[] } | null) {
    if (!next) return;
    setMoved(next.pinned);
    api["link.spaces.arrange"](next).catch((e) => {
      setMoved(undefined);
      fail(e);
    });
  }
  return {
    shown,
    send,
    row(id: string) {
      return {
        draggable: true,
        "data-drop": over?.id === id && dragging !== id ? (over.after ? "after" : "before") : undefined,
        "data-dragging": dragging === id || undefined,
        onDragStart(e: DragEvent<HTMLElement>) {
          e.dataTransfer.setData(spaceType, id);
          e.dataTransfer.effectAllowed = "move";
          setDragging(id);
        },
        onDragEnd: end,
        onDragOver(e: DragEvent<HTMLElement>) {
          if (!dragging || !e.dataTransfer.types.includes(spaceType)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const box = e.currentTarget.getBoundingClientRect();
          const after = e.clientY > box.top + box.height / 2;
          if (over?.id !== id || over.after !== after) setOver({ id, after });
        },
        onDrop(e: DragEvent<HTMLElement>) {
          if (!dragging || !e.dataTransfer.types.includes(spaceType)) return;
          e.preventDefault();
          const from = dragging;
          const to = over;
          end();
          if (to) send(arrangeMove(spaces, from, to.id, to.after));
        },
      };
    },
  };
}

/**
 * Dragging a panel by its header to another slot. While it is dragged, the panel itself is the
 * dashed slot where it will land (the grid shows it there with CSS `order`, so nothing moves in the
 * page's markup during the drag). Dropping sends `spaces.movePanel` with the panel it lands in front of.
 */
export function usePanelDrag(ids: string[], spaceId: string, grid: RefObject<HTMLElement | null>, fail: (e: unknown) => void) {
  const dragged = useRef("");
  const [dragging, setDragging] = useState("");
  const [drop, setDrop] = useState<{ order: string[]; before: string | null } | null>(null);
  function end() {
    dragged.current = "";
    setDragging("");
    setDrop(null);
  }
  function commit(e: DragEvent<HTMLElement>) {
    if (!dragged.current || !e.dataTransfer.types.includes(panelType)) return;
    e.preventDefault();
    e.stopPropagation();
    const id = dragged.current;
    const to = drop;
    end();
    if (to) api["spaces.movePanel"](id, { spaceId, before: to.before }).catch(fail);
  }
  return {
    dragging,
    /** The grid: the gaps between panels take a drop too. */
    grid: {
      onDragOver(e: DragEvent<HTMLElement>) {
        if (!dragged.current || !e.dataTransfer.types.includes(panelType)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      },
      onDrop: commit,
    },
    /** A panel: where a drop over it lands, and its place while one is dragged. */
    panel(id: string) {
      const at = drop?.order.indexOf(id) ?? -1;
      return {
        className: dragging === id ? "panel-slot" : undefined,
        style: at >= 0 ? { order: at } : undefined,
        onDragOver(e: DragEvent<HTMLElement>) {
          const from = dragged.current;
          if (!from || !e.dataTransfer.types.includes(panelType)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          if (from === id) return;
          // A panel across both columns takes a drop above or below it; a small one, beside it.
          const box = e.currentTarget.getBoundingClientRect();
          const across = box.width > (grid.current?.clientWidth ?? 0) * 0.75;
          const after = across ? e.clientY > box.top + box.height / 2 : e.clientX > box.left + box.width / 2;
          const next = panelDrop(ids, from, id, after);
          if (next?.before !== drop?.before || !next !== !drop) setDrop(next);
        },
        onDrop: commit,
      };
    },
    /** A panel's header: the only place a drag starts, so the buttons and views inside still work. */
    handle(id: string) {
      return {
        draggable: true,
        className: "panel-handle",
        onDragStart(e: DragEvent<HTMLDivElement>) {
          // A drag that starts on one of the header's buttons is not a move.
          if ((e.target as HTMLElement).closest("button")) return e.preventDefault();
          const panel = e.currentTarget.closest("section");
          e.dataTransfer.setData(panelType, id);
          e.dataTransfer.effectAllowed = "move";
          if (panel) {
            const box = panel.getBoundingClientRect();
            e.dataTransfer.setDragImage(panel, e.clientX - box.left, e.clientY - box.top);
          }
          dragged.current = id;
          // After the browser has its picture of the panel; then the panel turns into the slot.
          setTimeout(() => dragged.current === id && setDragging(id), 0);
        },
        onDragEnd: end,
      };
    },
  };
}

/**
 * Pulling a panel's corner. While pulling, the panel shows the size it snaps to, with the choice
 * Small / Wide / Tall; letting go sets it. Focused with the keyboard, arrow keys change the size.
 */
export function usePanelResize(grid: RefObject<HTMLElement | null>, fail: (e: unknown) => void) {
  const [pull, setPull] = useState<{ id: string; size: PanelSize }>();
  const start = useRef<{ id: string; left: number; top: number; tallAt: number }>(undefined);
  const latest = useRef<PanelSize>(undefined);
  const set = (id: string, size: PanelSize, was: PanelSize) => {
    if (size !== was) api.changePanel(id, size).catch(fail);
  };
  return {
    /** The size to draw a panel at: the one it snaps to while pulled. */
    sizeOf: (id: string, size: PanelSize) => (pull?.id === id ? pull.size : size),
    pulling: pull?.id,
    corner(panel: { id: string; title: string; size: PanelSize }) {
      const at = PANEL_SIZES.findIndex((s) => s.id === panel.size);
      const shown = pull?.id === panel.id ? pull.size : undefined;
      return (
        <>
          <span
            className="panel-corner"
            role="slider"
            tabIndex={0}
            aria-label={"Size of " + panel.title}
            aria-valuemin={0}
            aria-valuemax={PANEL_SIZES.length - 1}
            aria-valuenow={at}
            aria-valuetext={PANEL_SIZES[at]?.label}
            onPointerDown={(e: PointerEvent<HTMLSpanElement>) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              const box = e.currentTarget.closest("section")!.getBoundingClientRect();
              // About 80 px past the bottom edge makes it Tall; a Tall panel pulled up as far is Wide again.
              const tallAt = panel.size === "tall" ? box.height - 80 : box.height + 80;
              start.current = { id: panel.id, left: box.left, top: box.top, tallAt };
              latest.current = panel.size;
              setPull({ id: panel.id, size: panel.size });
            }}
            onPointerMove={(e) => {
              const from = start.current;
              if (!from || from.id !== panel.id) return;
              const g = grid.current;
              const width = g?.clientWidth ?? 0;
              const gap = g ? parseFloat(getComputedStyle(g).columnGap) || 0 : 0;
              const size = snapSize(e.clientX - from.left, e.clientY - from.top, { width, gap, tallAt: from.tallAt });
              if (size !== latest.current) {
                latest.current = size;
                setPull({ id: panel.id, size });
              }
            }}
            onPointerUp={() => {
              const size = latest.current;
              start.current = undefined;
              latest.current = undefined;
              setPull(undefined);
              if (size) set(panel.id, size, panel.size);
            }}
            onPointerCancel={() => {
              start.current = undefined;
              latest.current = undefined;
              setPull(undefined);
            }}
            onKeyDown={(e: KeyboardEvent<HTMLSpanElement>) => {
              if (!e.key.startsWith("Arrow")) return;
              e.preventDefault();
              set(panel.id, stepSize(panel.size, e.key), panel.size);
            }}
          />
          {shown && (
            <span className="panel-sizes" aria-hidden="true">
              {PANEL_SIZES.map((s) => (
                <span key={s.id} className={s.id === shown ? "on" : undefined}>
                  {s.label}
                </span>
              ))}
            </span>
          )}
        </>
      );
    },
  };
}
