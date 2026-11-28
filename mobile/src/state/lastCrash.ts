// The last error that closed the app, kept on the phone so the next launch can say what it was.
// A fatal JavaScript error ends a release build at once, and the phone's own crash log has no room
// for its message; this writes the message first (a synchronous write: nothing after it is sure to
// run), then lets the app end as before. Settings › About shows the note. crashNote.ts is the logic.
import * as Application from "expo-application";
import { File, Paths } from "expo-file-system";
import { type CrashNote, crashNote, parseCrashNote } from "./crashNote";

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

let watching = false;
/** From now on, an error that would close the app is written down first. Called once, as the app starts. */
export function watchForCrashes(): void {
  if (watching) return;
  watching = true;
  const before = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, fatal) => {
    if (fatal) keepCrash(error, "fatal");
    before?.(error, fatal);
  });
}
