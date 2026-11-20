// The icons of the six places, drawn from the Botkins navigation pack (assets/brand/nav-icons),
// file for file: 24 × 24, rounded 1.75 strokes in the current text color. An icon is decoration;
// the place's name is the button's label.
import chats from "../assets/brand/nav-icons/chats.svg?raw";
import home from "../assets/brand/nav-icons/home.svg?raw";
import projects from "../assets/brand/nav-icons/projects.svg?raw";
import today from "../assets/brand/nav-icons/today.svg?raw";
import wiki from "../assets/brand/nav-icons/wiki.svg?raw";
import work from "../assets/brand/nav-icons/work.svg?raw";
import type { Place } from "./places";

/** What a file draws: the inside of its <svg>, without the <title> (which would add a second label on hover). */
const shapes = (file: string) => file.replace(/^[\s\S]*?<svg[^>]*>|<\/svg>\s*$/g, "").replace(/<title>[\s\S]*?<\/title>/, "");
const ART: Record<Place, string> = {
  Home: shapes(home),
  Today: shapes(today),
  Chats: shapes(chats),
  Work: shapes(work),
  Projects: shapes(projects),
  Wiki: shapes(wiki),
};

export function PlaceIcon({ place, size = 24 }: { place: Place; size?: number }) {
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
      dangerouslySetInnerHTML={{ __html: ART[place] }}
    />
  );
}
