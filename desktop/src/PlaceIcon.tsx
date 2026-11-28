// The icons of the places. Seven are drawn from the Botkins navigation pack (assets/brand/nav-icons),
// file for file: 24 × 24, rounded 1.75 strokes in the current text color. The places the pack has no
// file for (Tasks, Routines, Spaces, Activity, Usage) and All are Lucide's, drawn with the same
// stroke. An icon is decoration; the place's name is the button's label.
import { Activity, ChartColumn, Clock, LayoutGrid, Layers, ListChecks, type LucideIcon } from "lucide-react";
import chats from "../assets/brand/nav-icons/chats.svg?raw";
import home from "../assets/brand/nav-icons/home.svg?raw";
import market from "../assets/brand/nav-icons/market.svg?raw";
import projects from "../assets/brand/nav-icons/projects.svg?raw";
import today from "../assets/brand/nav-icons/today.svg?raw";
import wiki from "../assets/brand/nav-icons/wiki.svg?raw";
import work from "../assets/brand/nav-icons/work.svg?raw";
import type { Place } from "./places";

/** What a file draws: the inside of its <svg>, without the <title> (which would add a second label on hover). */
const shapes = (file: string) => file.replace(/^[\s\S]*?<svg[^>]*>|<\/svg>\s*$/g, "").replace(/<title>[\s\S]*?<\/title>/, "");
const ART: Partial<Record<Place, string>> = {
  Home: shapes(home),
  Today: shapes(today),
  Chats: shapes(chats),
  Work: shapes(work),
  Projects: shapes(projects),
  Wiki: shapes(wiki),
  Market: shapes(market),
};
const DRAWN: Partial<Record<Place | "All", LucideIcon>> = { Tasks: ListChecks, Routines: Clock, Spaces: Layers, Activity, Usage: ChartColumn, All: LayoutGrid };

export function PlaceIcon({ place, size = 24 }: { place: Place | "All"; size?: number }) {
  const Drawn = DRAWN[place];
  if (Drawn) return <Drawn size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" />;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: ART[place as Place] ?? "" }}
    />
  );
}
