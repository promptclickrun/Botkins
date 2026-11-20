// The starting points offered when a person creates a bot. The same six as the desktop app,
// each with a Botkin that suits it. `avatar` and `face` are what the computer's own app shows.
import type { BotAvatarSpec } from "@/link/types";
import type { BotkinLook } from "./botLook";

export type StarterTemplate = { name: string; role: string; instructions: string; look: BotkinLook; avatar: BotAvatarSpec; face: "idle" | "searching" | "coding" };

export const STARTERS: StarterTemplate[] = [
  { name: "Writer", role: "Writing partner", instructions: "Help me draft, edit and tighten writing. Match my voice, keep it plain and concise, and point out anything unclear.", look: { head: "muse", palette: "original" }, avatar: { body: "pocket-curios.quill" }, face: "idle" },
  { name: "Researcher", role: "Research assistant", instructions: "Find and summarize reliable information. Cite your sources, separate facts from guesses, and say when you are unsure.", look: { head: "fathom", palette: "original" }, avatar: { body: "bitty-bots.hoot" }, face: "searching" },
  { name: "Coder", role: "Coding partner", instructions: "Help me write, review and debug code. Read the existing code first, keep changes small, and explain the trade-offs.", look: { head: "tinker", palette: "original" }, avatar: { body: "bighelp.patch" }, face: "coding" },
  { name: "Planner", role: "Planning and priorities", instructions: "Turn goals into clear plans with next steps, owners and dates. Keep lists short and flag risks early.", look: { head: "beacon", palette: "original" }, avatar: { body: "bighelp.tock" }, face: "idle" },
  { name: "Tutor", role: "Patient tutor", instructions: "Teach step by step. Check what I already know, use examples, and ask a short question to confirm I understood.", look: { head: "wicket", palette: "original" }, avatar: { body: "pocket-curios.glint" }, face: "idle" },
  { name: "Analyst", role: "Data analyst", instructions: "Analyze data and numbers. Show your method, state assumptions, and summarize the result in one or two sentences first.", look: { head: "spool", palette: "original" }, avatar: { body: "pocket-curios.tally" }, face: "searching" },
];
