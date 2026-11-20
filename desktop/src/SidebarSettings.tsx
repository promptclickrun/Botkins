import { useEffect, useRef, useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import type { Preferences } from "./types";
import { Group, SwitchRow } from "./SettingsRows";
import { MOD, PLACES, placeOrder, type Place } from "./places";
import { PlaceIcon } from "./PlaceIcon";
import "./integrations.css";

const api = window.botkins;
type Sidebar = { order: string[]; collapsed: boolean };
const save = (sidebar: Partial<Sidebar>) => api.setPreferences({ sidebar } as Parameters<typeof api.setPreferences>[0]);

/** Settings › Side menu: the order of the places (drag, or Move up and Move down) and collapsing the menu to icons. */
export default function SidebarSettings({ settings, fail }: { settings: Preferences; fail: (e: unknown) => void }) {
  const saved = placeOrder(settings.sidebar?.order);
  const [order, setOrder] = useState<Place[]>(saved);
  const [collapsed, setCollapsed] = useState(!!settings.sidebar?.collapsed);
  const [dragging, setDragging] = useState<Place>();
  const [over, setOver] = useState<{ place: Place; after: boolean }>();
  const [status, setStatus] = useState("");
  const list = useRef<HTMLOListElement>(null);
  // Follows changes made elsewhere, such as ⌘B or another window.
  const key = saved.join();
  useEffect(() => setOrder(saved), [key]);
  useEffect(() => setCollapsed(!!settings.sidebar?.collapsed), [settings.sidebar?.collapsed]);

  function apply(next: Place[], said?: string) {
    setOrder(next);
    if (said) setStatus(said);
    save({ order: next }).catch((e) => {
      setOrder(saved);
      fail(e);
    });
  }
  function move(place: Place, by: number) {
    const from = order.indexOf(place);
    const to = from + by;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, place);
    apply(next, place + " moved to position " + (to + 1) + " of " + next.length + ".");
    // Focus stays with the place that moved; at the top or bottom it moves to the button that still works.
    requestAnimationFrame(() => {
      const row = list.current?.querySelector<HTMLElement>('[data-place="' + place + '"]');
      const wanted = row?.querySelector<HTMLButtonElement>(by < 0 ? "[data-move=up]" : "[data-move=down]");
      (wanted && !wanted.disabled ? wanted : row?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    });
  }
  function drop(e: DragEvent) {
    e.preventDefault();
    const place = dragging;
    setDragging(undefined);
    setOver(undefined);
    if (!place || !over || over.place === place) return;
    const next = order.filter((p) => p !== place);
    const at = next.indexOf(over.place) + (over.after ? 1 : 0);
    next.splice(at, 0, place);
    if (next.join() !== order.join()) apply(next, place + " moved to position " + (at + 1) + " of " + next.length + ".");
  }
  const usual = order.join() === PLACES.join();
  return (
    <>
      <Group
        title="Places"
        footer="Drag a place, or use its arrows."
        actions={
          <>
            <span className="set-wait sidebar-status" role="status">
              {status}
            </span>
            <button type="button" className="set-button" disabled={usual} onClick={() => apply([...PLACES], "The usual order is back.")}>
              Reset to the usual order
            </button>
          </>
        }
      >
        <ol className="place-list" aria-label="Places in the side menu" ref={list} onDragOver={(e) => dragging && e.preventDefault()} onDrop={drop}>
          {order.map((place, i) => {
            return (
              <li
                key={place}
                data-place={place}
                className={
                  "set-row place-row" +
                  (dragging === place ? " dragging" : "") +
                  (over?.place === place && dragging !== place ? (over.after ? " drop-after" : " drop-before") : "")
                }
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", place);
                  setDragging(place);
                }}
                onDragEnd={() => {
                  setDragging(undefined);
                  setOver(undefined);
                }}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const box = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY > box.top + box.height / 2;
                  if (over?.place !== place || over.after !== after) setOver({ place, after });
                }}
              >
                <span className="place-grip" aria-hidden="true">
                  <GripVertical size={14} />
                </span>
                <span className="place-icon" aria-hidden="true">
                  <PlaceIcon place={place} size={18} />
                </span>
                <span className="set-name place-name">{place}</span>
                <span className="place-moves">
                  <button
                    type="button"
                    className="int-icon"
                    data-move="up"
                    aria-label={"Move " + place + " up"}
                    title="Move up"
                    disabled={i === 0}
                    onClick={() => move(place, -1)}
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    className="int-icon"
                    data-move="down"
                    aria-label={"Move " + place + " down"}
                    title="Move down"
                    disabled={i === order.length - 1}
                    onClick={() => move(place, 1)}
                  >
                    <ArrowDown size={14} />
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      </Group>
      <Group>
        <SwitchRow
          label="Show icons only"
          help={"Press " + MOD + "B to switch from anywhere."}
          checked={collapsed}
          onChange={(on) => {
            setCollapsed(on);
            save({ collapsed: on }).catch((e) => {
              setCollapsed(!on);
              fail(e);
            });
          }}
        />
      </Group>
    </>
  );
}
