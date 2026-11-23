// Switching between the computers this phone is paired with: from the menu that opens on a hold of
// the computer's name on Home, and from the list on the computer's page.
import { router } from "expo-router";
import { computerChoice } from "@/state/computers";
import { switchComputer } from "@/state/link";
import { showToast, useApp } from "@/state/store";

/** Starts using another paired computer and says so. */
export function switchTo(serverId: string) {
  const state = useApp.getState();
  const next = state.pairings.find((pairing) => pairing.serverId === serverId);
  if (!next || state.pairing?.serverId === serverId) return;
  void switchComputer(serverId);
  showToast("Now using " + (next.name || "that computer"), "success");
}

/** Connecting one more computer ("Connect a computer"). The ones the phone has stay paired. */
export const addComputer = () => router.push("/pair/scan");

// About how long the phone's menu takes to close. A switch redraws all of Home, so it waits for the
// menu to be gone first and is not drawn under it.
const MENU_CLOSES_MS = 450;

/** Acts on a choice in the switcher's menu, once the menu has closed. */
export function runComputerChoice(event: string) {
  const choice = computerChoice(event);
  if (!choice) return;
  setTimeout(() => (choice === "add" ? addComputer() : switchTo(choice.use)), MENU_CLOSES_MS);
}
