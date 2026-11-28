// The side menu's places: the ones the person keeps on it, in their order, then All. A row is
// dragged to another position; a tile dragged from the All page lands where the line shows; a
// right-click has the same moves as a menu (Move up, Move down, Take off menu). Collapsed, each is
// its icon, with its name beside it on hover and on keyboard focus.
import { useState, type DragEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, PinOff } from "lucide-react";
import { useMenu } from "./Pages";
import { PlaceIcon } from "./PlaceIcon";
import { placeDrag, usePlaceDrag } from "./placeDrag";
import { pinned, stepped, unpinned, type Arranged, type Place } from "./places";
import type { Preferences } from "./types";

export function MenuPlaces({
  rows,
  sidebar,
  collapsed,
  selected,
  go,
  arrange,
  notes,
}: {
  /** The places on the menu that this person may open, in order. */
  rows: Place[];
  sidebar: Preferences["sidebar"];
  collapsed: boolean;
  selected: Place | "All" | "";
  go: (place: Place | "All") => void;
  /** Saves a new arrangement, and says what happened for a screen reader. */
  arrange: (next: Arranged, said: string) => void;
  /** What a row adds after its name: a count, a dot, words for a screen reader. */
  notes: (place: Place) => { after?: ReactNode; label?: ReactNode; described?: string };
}) {
  const menu = useMenu();
  const dragged = usePlaceDrag();
  // Where a dragged place would land: before this row, or at the end (before All).
  const [over, setOver] = useState<Place | "All">();
  const size = collapsed ? 24 : 18;

  function land(e: DragEvent, before: Place | "All") {
    const held = placeDrag.get();
    if (!held || !placeDrag.carries(e)) return;
    e.preventDefault();
    setOver(undefined);
    placeDrag.end();
    if (held.place === before) return;
    arrange(pinned(sidebar, held.place, before === "All" ? undefined : before), held.place + (held.from === "all" ? " pinned to the side menu." : " moved."));
  }
  const target = (before: Place | "All") => ({
    onDragOver: (e: DragEvent) => {
      if (!placeDrag.carries(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // The lower half of a row is the position after it.
      const box = e.currentTarget.getBoundingClientRect();
      const next = before === "All" || e.clientY <= box.top + box.height / 2 ? before : (rows[rows.indexOf(before) + 1] ?? "All");
      if (over !== next) setOver(next);
    },
    onDrop: (e: DragEvent) => land(e, over ?? before),
  });
  const marks = (place: Place | "All") => (dragged && over === place && dragged.place !== place ? " drop-before" : "");

  return (
    <nav aria-label="Workspace" className={dragged ? "taking-place" : undefined} onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(undefined)}>
      {rows.map((place) => {
        const note = notes(place);
        const up = stepped(sidebar, place, -1, rows);
        const down = stepped(sidebar, place, 1, rows);
        return (
          <button
            key={place}
            data-place={place}
            className={(selected === place ? "selected" : "") + marks(place) + (dragged?.place === place ? " dragging" : "")}
            aria-current={selected === place ? "page" : undefined}
            aria-description={note.described}
            draggable
            onDragStart={(e) => placeDrag.start(e, place, "menu")}
            onDragEnd={() => {
              placeDrag.end();
              setOver(undefined);
            }}
            {...target(place)}
            onClick={() => go(place)}
            onContextMenu={(e) =>
              menu.show(e, place, [
                { label: "Move up", icon: ArrowUp, disabled: !up, run: () => up && arrange(up, place + " moved up.") },
                { label: "Move down", icon: ArrowDown, disabled: !down, run: () => down && arrange(down, place + " moved down.") },
                "separator",
                { label: "Take off menu", icon: PinOff, run: () => arrange(unpinned(sidebar, place), place + " taken off the side menu. It is on the All page.") },
              ])
            }
          >
            <PlaceIcon place={place} size={size} />
            {/* With icons only, the name shows beside the icon on hover and on keyboard focus. */}
            <span className="nav-label">
              {place}
              {note.label}
            </span>
            {note.after}
          </button>
        );
      })}
      {/* All is always the menu's last place: every place is a tile there. */}
      <button data-place="All" className={(selected === "All" ? "selected" : "") + marks("All")} aria-current={selected === "All" ? "page" : undefined} {...target("All")} onClick={() => go("All")}>
        <PlaceIcon place="All" size={size} />
        <span className="nav-label">All</span>
      </button>
      {menu.node}
    </nav>
  );
}
