import { useEffect, useRef, useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import type { Preferences } from "./types";
import { Switch } from "glisse";
import { Group, SwitchRow } from "./SettingsRows";
import { hiddenPlaces, MOD, PLACES, placeOrder, usualArrangement, type Place } from "./places";
import { PlaceIcon } from "./PlaceIcon";
import "./integrations.css";

const api = window.botkins;
type Sidebar = { order: string[]; hidden: string[]; collapsed: boolean };
const save = (sidebar: Partial<Sidebar>) => api.setPreferences({ sidebar } as Parameters<typeof api.setPreferences>[0]);

/**
 * Settings › Side menu: which places are on the menu (a switch each; one that is off is a tile on
 * the All page), their order (drag, or Move up and Move down) and collapsing the menu to icons.
 * The places on the menu come first, in the menu's order; the ones off it follow, and have no
 * order to change. The All page arranges the same menu by dragging a tile onto it.
 */
export default function SidebarSettings({ settings, spaces = false, fail }: { settings: Preferences; /** The computer has Spaces: Today is a space there, not a place to put in order here. */ spaces?: boolean; fail: (e: unknown) => void }) {
  // With Spaces, Today is a space. The menu's section of spaces has no position to change (it is
  // under the places), so it is a switch of its own below.
  const places = PLACES.filter((place) => place !== "Spaces" && !(spaces && place === "Today"));
  // A place left out here keeps its position in what is saved: the computer puts back any place an order doesn't name.
  const saved = placeOrder(settings.sidebar?.order).filter((place) => places.includes(place));
  const [order, setOrder] = useState<Place[]>(saved);
  const savedHidden = hiddenPlaces(settings.sidebar);
  const [hidden, setHidden] = useState<Place[]>(savedHidden);
  const [collapsed, setCollapsed] = useState(!!settings.sidebar?.collapsed);
  const [dragging, setDragging] = useState<Place>();
  const [over, setOver] = useState<{ place: Place; after: boolean }>();
  const [status, setStatus] = useState("");
  const list = useRef<HTMLOListElement>(null);
  // Follows changes made elsewhere, such as ⌘B or another window.
  const key = saved.join();
  useEffect(() => setOrder(saved), [key]);
  const hiddenKey = savedHidden.join();
  useEffect(() => setHidden(savedHidden), [hiddenKey]);
  // The menu's own places, in its order, then the ones kept off it.
  const menu = order.filter((place) => !hidden.includes(place));
  const off = order.filter((place) => hidden.includes(place));
  const rows = [...menu, ...off];
  function show(place: Place, on: boolean) {
    const next = PLACES.filter((p) => (p === place ? !on : hidden.includes(p)));
    // A place switched on joins the end of the menu, as a tile pinned on the All page does.
    const ordered = on ? [...menu, place, ...off.filter((p) => p !== place)] : order;
    setHidden(next);
    setOrder(ordered);
    setStatus(place + (on ? " is on the side menu." : " is off the side menu, on the All page."));
    save(on ? { order: ordered, hidden: next } : { hidden: next }).catch((e) => {
      setHidden(savedHidden);
      setOrder(saved);
      fail(e);
    });
  }
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
    const from = menu.indexOf(place);
    const to = from + by;
    if (from < 0 || to < 0 || to >= menu.length) return;
    const next = [...menu];
    next.splice(from, 1);
    next.splice(to, 0, place);
    apply([...next, ...off], place + " moved to position " + (to + 1) + " of " + next.length + ".");
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
    if (!place || !over || over.place === place || !menu.includes(place) || !menu.includes(over.place)) return;
    const next = menu.filter((p) => p !== place);
    const at = next.indexOf(over.place) + (over.after ? 1 : 0);
    next.splice(at, 0, place);
    if (next.join() !== menu.join()) apply([...next, ...off], place + " moved to position " + (at + 1) + " of " + next.length + ".");
  }
  function showSpaces(on: boolean) {
    const next = PLACES.filter((p) => (p === "Spaces" ? !on : hidden.includes(p)));
    setHidden(next);
    setStatus(on ? "Your spaces are on the side menu." : "Your spaces are off the side menu, on the All page.");
    save({ hidden: next }).catch((e) => {
      setHidden(savedHidden);
      fail(e);
    });
  }
  const usualOff = usualArrangement().hidden;
  const usual = !hidden.includes("Spaces") && menu.join() === places.filter((place) => !usualOff.includes(place)).join() && off.length === places.filter((place) => usualOff.includes(place)).length;
  function reset() {
    const next = usualArrangement();
    setOrder(next.order.filter((place) => places.includes(place)));
    setHidden(next.hidden);
    setStatus("The usual menu is back.");
    save(next).catch((e) => {
      setOrder(saved);
      setHidden(savedHidden);
      fail(e);
    });
  }
  return (
    <>
      <Group
        title="Places"
        footer="Switch a place off to keep it on the All page only. Drag a place on the menu, or use its arrows, to put the menu in order."
        actions={
          <>
            <span className="set-wait sidebar-status" role="status">
              {status}
            </span>
            <button type="button" className="set-button" disabled={usual} onClick={reset}>
              Reset to the usual menu
            </button>
          </>
        }
      >
        <ol className="place-list" aria-label="Places" ref={list} onDragOver={(e) => dragging && e.preventDefault()} onDrop={drop}>
          {rows.map((place, i) => {
            const on = i < menu.length;
            return (
              <li
                key={place}
                data-place={place}
                className={
                  "set-row place-row" +
                  (on ? "" : " off") +
                  (dragging === place ? " dragging" : "") +
                  (over?.place === place && dragging !== place ? (over.after ? " drop-after" : " drop-before") : "")
                }
                draggable={on}
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
                  if (!dragging || !on) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const box = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY > box.top + box.height / 2;
                  if (over?.place !== place || over.after !== after) setOver({ place, after });
                }}
              >
                <span className="place-grip" aria-hidden="true">
                  {on && <GripVertical size={14} />}
                </span>
                <span className="place-icon" aria-hidden="true">
                  <PlaceIcon place={place} size={18} />
                </span>
                <span className="set-name place-name">{place}</span>
                <span className="place-moves">
                  <Switch checked={!hidden.includes(place)} aria-label={"Show " + place + " on the side menu"} onCheckedChange={(on) => show(place, on)} />
                  <button
                    type="button"
                    className="int-icon"
                    data-move="up"
                    aria-label={"Move " + place + " up"}
                    title="Move up"
                    disabled={!on || i === 0}
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
                    disabled={!on || i === menu.length - 1}
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
        {spaces && <SwitchRow label="Show your spaces" help="Under the places. Off, they are a tile on the All page." checked={!hidden.includes("Spaces")} onChange={showSpaces} />}
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
