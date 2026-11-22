// The model a routine's editor holds while the Model sheet (`/chat/model?scope=routine`) is open.
// The routine isn't saved yet, so the sheet reads the editor's choice from here and hands its pick
// back; the editor saves it with the routine ("routine-models-v1").
import type { ModelChoice } from "@/link/types";

type Held = { value: ModelChoice | null; set: (choice: ModelChoice | null) => void };
let held: Held | null = null;

/** Called by the editor before it opens the sheet. */
export function holdRoutineModel(value: ModelChoice | null, set: (choice: ModelChoice | null) => void) {
  held = { value, set };
}

/** The editor's choice and where its pick goes, or null when no editor opened the sheet. */
export const heldRoutineModel = () => held;
