// Where a routine's result goes: the choices, in the words of the app on the computer, and what the
// editor shows and saves. Plain logic with no React Native imports, so the tests run it.
import type { RoutineDelivery } from "@/link/types";

export type Place = RoutineDelivery["to"];
/** The computer can keep where a result lands and whether it notifies. */
export const DELIVERY = "routine-delivery-v1";
/** The computer also takes "No output": the routine runs, keeps its history, and publishes nothing. */
export const NO_OUTPUT = "routine-no-output-v1";
/** The computer takes per-person and per-device routine notification targets (`notifyTargets`). */
export const NOTIFY_TARGETS = "routine-notify-targets-v1";

/** Where a result can land, in the computer's order. The chat's label names the bot when one is chosen. */
export const PLACES: { value: Place; label: string; hint: string; image: string }[] = [
  { value: "none", label: "No output", hint: "Works quietly, with no reply or notification", image: "moon.zzz" },
  { value: "routine", label: "Routine chat", hint: "Kept with its past runs", image: "clock.arrow.circlepath" },
  { value: "chat", label: "Chat", hint: "A message from the bot", image: "bubble.left" },
  { value: "feed", label: "Feed", hint: "On Today", image: "newspaper" },
  { value: "idea", label: "Ideas", hint: "On Today", image: "lightbulb" },
  { value: "goal", label: "Goals", hint: "On Today", image: "target" },
];
export const placeOf = (value: Place) => PLACES.find((item) => item.value === value) ?? PLACES[1]!;

/**
 * The choices a person is offered. "No output" is there only on a computer that takes it, or when
 * the routine already has it, so that opening and saving a routine never changes where it goes.
 */
export function placesFor(capabilities: string[] | undefined, current?: Place) {
  const allowed = !!capabilities?.includes(NO_OUTPUT);
  return PLACES.filter((item) => item.value !== "none" || allowed || current === "none");
}

/**
 * Where the editor starts. A routine keeps what it has (a routine with nothing said goes to its
 * own chat). A new one starts on "No output" where the computer takes it, as on the computer.
 */
export function firstPlace(deliver: RoutineDelivery | undefined, isNew: boolean, capabilities: string[] | undefined): Place {
  if (isNew) return capabilities?.includes(NO_OUTPUT) ? "none" : "routine";
  return PLACES.some((item) => item.value === deliver?.to) ? deliver!.to : "routine";
}

/** What is saved. A chat picked on the computer stays picked while the result still goes to a chat. */
export function deliveryToSave(place: Place, before?: RoutineDelivery): RoutineDelivery {
  const kept = before?.to === "chat" && place === "chat" ? before.chatId : undefined;
  return { to: place, ...(kept && { chatId: kept }) };
}

/** A routine with no output never notifies, so its switch is off and can't be turned. */
export const canNotify = (place: Place) => place !== "none";
/** The line under "Notify me". */
export const notifyLine = (place: Place, notify: boolean) => (place === "none" ? "No-output routines never publish or notify" : notify ? "When a run finishes" : "This routine is quiet");
