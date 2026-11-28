// What the GitHub page says when the computer answers that it can't do GitHub's calls: which
// computer answered, the version it runs, and what to do there. Plain logic, so tests run it.

/** The first release whose computer app takes GitHub's calls from a phone. */
export const GITHUB_FROM = "0.17.25";

const UNKNOWN_CALL = /unknown method|not supported|unsupported|not a function|can't be done from a phone/i;
/** The computer answered that it doesn't know the call (an app from before it could connect GitHub). */
export const computerLacksGithub = (error: unknown) => error instanceof Error && UNKNOWN_CALL.test(error.message);

/** Whether version `a` is `b` or later, by its numbers ("0.17.25", "v0.18.0-beta.1"). Unknown when `a` has none. */
export function versionAtLeast(a: string | undefined, b: string): boolean | undefined {
  const parts = (text: string) => (/\d+(\.\d+)*/.exec(text)?.[0] ?? "").split(".").filter(Boolean).map(Number);
  const mine = parts(a ?? "");
  if (mine.length === 0) return undefined;
  const wanted = parts(b);
  for (let i = 0; i < Math.max(mine.length, wanted.length); i++) {
    const diff = (mine[i] ?? 0) - (wanted[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

/** The notice: it names the computer that answered and its version, so "which computer, on what" is never a guess. */
export function githubNotice(computer: { name?: string; version?: string } | undefined): { title: string; text: string } {
  const name = computer?.name?.trim() || "Your computer";
  const version = computer?.version?.trim();
  const recent = versionAtLeast(version, GITHUB_FROM);
  if (recent === undefined)
    return { title: "Update Botkins on " + name, text: name + " answered that it can't connect GitHub yet. That needs Botkins " + GITHUB_FROM + " or later there. Update it, then check again." };
  if (!recent)
    return { title: "Update Botkins on " + name, text: name + " is running Botkins " + version + ". Connecting GitHub needs " + GITHUB_FROM + " or later. Update it there, then check again." };
  // New enough by its own account, and the answer was still no. With several computers joined the page's calls
  // can reach another computer than the one whose version the phone holds, so the notice says so and guesses no further.
  return {
    title: "Check which computer answered",
    text: name + " is running Botkins " + version + ", which can connect GitHub, but the answer was that it can't. With several computers joined, the answer may have come from another one: pick the computer under Settings for computer. Otherwise quit Botkins on " + name + ", open it again, then check again.",
  };
}
