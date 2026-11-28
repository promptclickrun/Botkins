// All: every place in the app as a tile, with one line of what is going on there. It is the side
// menu's last place. A tile that is on the menu says so; its pin puts it on the menu or takes it
// off, and so does dragging: a tile dragged onto the side menu is pinned where the line shows, and
// a row of the menu dropped here comes off it. The plain logic is places.ts.
import { Pin, PinOff } from "lucide-react";
import { useState, type DragEvent } from "react";
import { chatsPageUnreadChats } from "./chatSections";
import { PlaceIcon } from "./PlaceIcon";
import { placeDrag, usePlaceDrag } from "./placeDrag";
import { hiddenPlaces, pinned, unpinned, type Arranged, type Place } from "./places";
import { isRoutineChat } from "../desktop/link/routine-chat.mjs";
import type { State } from "./types";
import "./all.css";

const count = (n: number, one: string, many: string, none: string) => (n === 0 ? none : n === 1 ? "1 " + one : n + " " + many);

/** What each tile says now: a count the app has, or a few plain words. What waits for the person comes first. */
export function placeLines(state: State): Record<Place, { text: string; waiting?: boolean }> {
  const tasks = (state.tasks ?? []).filter((task) => task.status !== "archived");
  const waiting = state.requests.length + tasks.filter((task) => task.status === "blocked" || (task.status === "review" && !task.reviewerBotId)).length;
  const active = tasks.filter((task) => !["done", "later", "backlog"].includes(task.status)).length;
  const unread = chatsPageUnreadChats(state.chats).length;
  const changed = (state.spaces ?? []).filter((space) => space.changed > 0).length;
  const working = Object.keys(state.streams).length;
  return {
    Home: { text: count(state.bots.filter((bot) => !bot.hidden).length, "bot", "bots", "No bots yet") },
    Today: { text: "Cards and panels from your bots" },
    Chats: { text: unread > 0 ? unread + " unread" : "All read" },
    Work: waiting > 0 ? { text: waiting === 1 ? "1 needs you" : waiting + " need you", waiting: true } : { text: working > 0 ? "Bots are working" : "Nothing waiting" },
    Projects: { text: count(state.projects?.length ?? 0, "project", "projects", "No projects yet") },
    Tasks: { text: count(active, "active", "active", "None active") },
    Routines: { text: count(state.chats.filter((chat) => !chat.archived && isRoutineChat(chat)).length, "routine", "routines", "No routines yet") },
    Spaces: { text: changed > 0 ? changed + " changed" : count(state.spaces?.length ?? 0, "space", "spaces", "No spaces yet") },
    Wiki: { text: "Pages your bots keep" },
    Market: { text: "Bots, apps and skills" },
    Activity: { text: "What your bots did" },
    Usage: { text: "Tokens, plans and limits" },
  };
}

export default function AllPage({
  state,
  places,
  go,
  arrange,
  said,
}: {
  state: State;
  /** The places this person may open. */
  places: Place[];
  go: (place: Place) => void;
  arrange: (next: Arranged, said: string) => void;
  /** What the last change to the side menu did, wherever it was made. */
  said: string;
}) {
  const sidebar = state.settings.sidebar;
  const hidden = hiddenPlaces(sidebar);
  const lines = placeLines(state);
  const dragged = usePlaceDrag();
  // A row of the side menu held over this page: dropped here, it comes off the menu.
  const taking = dragged?.from === "menu";
  const [over, setOver] = useState(false);
  const say = arrange;
  const toggle = (place: Place) =>
    hidden.includes(place) ? say(pinned(sidebar, place), place + " pinned to the side menu.") : say(unpinned(sidebar, place), place + " taken off the side menu.");
  function drop(e: DragEvent) {
    const held = placeDrag.get();
    setOver(false);
    if (!held || held.from !== "menu" || !placeDrag.carries(e)) return;
    e.preventDefault();
    placeDrag.end();
    say(unpinned(sidebar, held.place), held.place + " taken off the side menu.");
  }
  return (
    <div
      className={"page wide all-page" + (taking ? " taking" : "") + (taking && over ? " over" : "")}
      onDragOver={(e) => {
        if (!taking || !placeDrag.carries(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
      onDrop={drop}
    >
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">All</h1>
        </div>
        <span className="set-wait all-status" role="status">
          {said}
        </span>
      </header>
      <ul className="all-grid" aria-label="Every place">
        {places.map((place) => {
          const on = !hidden.includes(place);
          const line = lines[place];
          return (
            <li key={place} className={"all-tile" + (dragged?.place === place ? " dragging" : "")} data-place={place} draggable onDragStart={(e) => placeDrag.start(e, place, "all")} onDragEnd={() => placeDrag.end()}>
              <button type="button" className="all-open" onClick={() => go(place)}>
                <span className="all-icon">
                  <PlaceIcon place={place} size={20} />
                </span>
                <span className="all-name">{place}</span>
                <span className={"all-line" + (line.waiting ? " waiting" : "")}>{line.text}</span>
              </button>
              <button
                type="button"
                className={"all-pin" + (on ? " on" : "")}
                aria-pressed={on}
                aria-label={on ? "Take " + place + " off the side menu" : "Pin " + place + " to the side menu"}
                title={on ? "Take off menu" : "Pin to menu"}
                onClick={() => toggle(place)}
              >
                {on ? <Pin size={14} /> : <PinOff size={14} />}
                {on && <span>On menu</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="group-foot all-foot">{taking ? "Drop it here to take it off your side menu." : "Drag a tile onto your side menu to pin it, or use its pin."}</p>
    </div>
  );
}
