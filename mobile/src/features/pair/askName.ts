// "Your name" is one sheet (/pair/name) that every way of pairing or joining opens before it sends
// anything: a scanned code, a typed one, a pairing link and a team invite. It answers once.
import { router } from "expo-router";

let waiting: ((name: string | null) => void) | undefined;

/** Opens "Your name" and resolves to the name given, or null when the person closed the sheet. */
export function askPersonName(): Promise<string | null> {
  waiting?.(null);
  return new Promise((resolve) => {
    waiting = resolve;
    router.push("/pair/name");
  });
}

/** What the sheet answers: the cleaned name, or null when it was closed. Only the first answer counts. */
export function answerPersonName(name: string | null) {
  const done = waiting;
  waiting = undefined;
  done?.(name);
}
