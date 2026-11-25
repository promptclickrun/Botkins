// A routine or a task whose text is `/<name> words` of a script command runs that script on this computer, with no model
// (desktop/script-commands.mjs). A call that saves or starts one is the person's to agree to: the socket takes the caller's
// word, `{ agreed: true }` as the last argument, that it showed the person the command, its words and its script and got a yes.
// Without it the call is refused with the text to show, and the command line asks (`withScriptYes`, cli/commands/input.mjs).
import { invocationLines, scriptInvocation } from "../script-commands.mjs";
import { ControlError } from "./socket.mjs";

/** The code of the refusal. */
export const NEEDS_SCRIPT_YES = "NEEDS_SCRIPT_YES";
/** The last line of the refusal: for a caller that is a program. The command line leaves it out. */
export const SCRIPT_YES_HINT = "Show this to the person and ask. A call to the socket carries { \"agreed\": true } as its last argument once they agreed; on the command line, --yes agrees.";

/** The script command that `text` invokes, or null. */
export const invocationOf = (workspace, text) => scriptInvocation(workspace, typeof text === "string" ? text : "");

/**
 * Throws NEEDS_SCRIPT_YES when `text` invokes a script command and the call has no `{ agreed: true }` mark. `what` says what the call
 * does ("This routine", "This task").
 */
export function needsScriptYes(workspace, text, mark, what) {
  const invocation = invocationOf(workspace, text);
  if (!invocation || (mark !== null && typeof mark === "object" && mark.agreed === true)) return;
  throw new ControlError([what + " runs a script command.", ...invocationLines(workspace, invocation), "", SCRIPT_YES_HINT].join("\n"), NEEDS_SCRIPT_YES);
}
