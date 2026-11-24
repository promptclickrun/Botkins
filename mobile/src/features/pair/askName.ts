// Use the signed-in person's profile for a new pairing or team request.
// A local-only installation asks for a name in the existing sheet.
import { router } from "expo-router";
import { useProfile } from "@/state/profile";

let waiting: ((name: string | null) => void) | undefined;

export function askPersonName(): Promise<string | null> {
  answerPersonName(null);
  const { home, session } = useProfile.getState();
  const name = session && (home?.profile.name || session.name).trim();
  if (name) return Promise.resolve(name);
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
