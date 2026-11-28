// An error nothing in the app caught used to close the app at once: React Native hands it to the
// phone as fatal, and the phone's own crash log has no room for its message. Here it is written to
// the phone first (a synchronous write: nothing after it is sure to run), and in the app people use
// it is then kept from closing the app: the person is told once, and Settings › About has the
// message. In development the red screen still shows. crashNote.ts is the logic.
import * as Application from "expo-application";
import { File, Paths } from "expo-file-system";
import { type CrashNote, crashNote, parseCrashNote } from "./crashNote";
import { showToast } from "./store";

const file = () => new File(Paths.document, "last-crash.json");

/** Keep a note of an error. Never throws: failing to keep it must not be a second error. */
export function keepCrash(thrown: unknown, kind: CrashNote["kind"]): void {
  try {
    const note = crashNote(thrown, kind, Date.now(), Application.nativeApplicationVersion ?? undefined);
    const target = file();
    if (!target.exists) target.create({ intermediates: true });
    target.writeSync(JSON.stringify(note));
  } catch {
    // Nothing to do: the phone would not take the file.
  }
}

export function readLastCrash(): CrashNote | null {
  try {
    const target = file();
    return target.exists ? parseCrashNote(target.textSync()) : null;
  } catch {
    return null;
  }
}

export function clearLastCrash(): void {
  try {
    const target = file();
    if (target.exists) target.delete();
  } catch {
    // Already gone, or not the phone's to remove.
  }
}

/** One error can come many times over (every frame, every tick): the person is told this often at most. */
const TELL_EVERY_MS = 8000;

/**
 * What to do with an error nothing caught. `fatal` errors are kept, and outside development they
 * stop here: the app stays open and the person is told, where it used to close. Anything else, and
 * everything in development, goes on to React Native's own handler.
 */
export function crashHandler(options: { dev: boolean; before?: (error: unknown, fatal?: boolean) => void; keep: (error: unknown) => void; tell: () => void; now?: () => number }) {
  let told = -Infinity;
  return (error: unknown, fatal?: boolean) => {
    if (!fatal) return options.before?.(error, fatal);
    options.keep(error);
    if (options.dev) return options.before?.(error, fatal);
    const at = (options.now ?? Date.now)();
    if (at - told < TELL_EVERY_MS) return;
    told = at;
    try {
      options.tell();
    } catch {
      // Telling must not be a second error.
    }
  };
}

let watching = false;
/** From now on, an error nothing caught is written down and does not close the app. Called once, as the app starts. */
export function watchForCrashes(): void {
  if (watching) return;
  watching = true;
  const before = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler(
    crashHandler({
      dev: __DEV__,
      before,
      keep: (error) => keepCrash(error, "error"),
      tell: () => showToast("Something went wrong. Settings › About has the details.", "error"),
    }),
  );
}
