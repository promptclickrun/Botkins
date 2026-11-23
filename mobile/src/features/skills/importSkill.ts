import type { SkillImportResult } from "@/link/types";

/** A replacement approves only the names in the host's first answer, on that same host. */
export async function finishSkillImport(
  send: (replace?: string[]) => Promise<SkillImportResult>,
  ask: (names: string[]) => Promise<boolean>,
  connected: () => boolean,
) {
  if (!connected()) throw new Error("Reconnect to the computer and try again.");
  let result = await send();
  if (result.conflicts.length) {
    if (!(await ask(result.conflicts))) return;
    if (!connected()) throw new Error("Reconnect to the computer and try again.");
    result = await send(result.conflicts);
    if (result.conflicts.length) throw new Error("The skills changed. Review the names again.");
  }
  return result.added;
}
