// A space's icon: one for each of the four every person has, and one for a space a person made.
import { LayoutGrid, Lightbulb, type LucideIcon, Rss, Sun, Target } from "lucide-react-native";
import type { SpaceSummary } from "@/link/types";

const BUILTIN: Record<NonNullable<SpaceSummary["builtin"]>, LucideIcon> = { today: Sun, feed: Rss, ideas: Lightbulb, goals: Target };

export const spaceIcon = (space: Pick<SpaceSummary, "builtin">): LucideIcon => (space.builtin ? BUILTIN[space.builtin] : LayoutGrid);
