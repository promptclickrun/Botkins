// Asking the person at the terminal: a line, a hidden line (a token), a yes or no, and a file in
// their editor.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CliError, usage } from "../output.mjs";

/** Everything on standard input, for a value piped in. */
export async function readAll(stream) {
  let text = "";
  stream.setEncoding?.("utf8");
  for await (const chunk of stream) text += chunk;
  return text;
}

/**
 * One line typed at the terminal. `hidden` shows nothing of it (a token, a key). `signal` closes
 * the question from outside (the thing it was asked for is over): it resolves with null, and what
 * was typed so far is dropped, never used.
 */
export function ask(context, question, { hidden = false, signal } = {}) {
  const { stdin, stderr } = context;
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: stdin, output: stderr, terminal: !!stdin.isTTY });
    // (True once the question has its end: an answer, or a close from outside. The end of input after that is not a cancel.)
    let answered = false;
    const close = () => {
      answered = true;
      rl.close();
      if (hidden && stdin.isTTY) stderr.write("\n");
      resolve(null);
    };
    if (signal?.aborted) return close();
    signal?.addEventListener("abort", close, { once: true });
    if (hidden && stdin.isTTY) {
      // Whatever is typed is not drawn: only the question stays on the line.
      rl._writeToOutput = (text) => {
        if (text.includes(question)) stderr.write(question);
      };
    }
    const cancel = () => reject(new CliError("Cancelled.", 130, "CANCELLED"));
    rl.on("SIGINT", () => {
      signal?.removeEventListener("abort", close);
      rl.close();
      cancel();
    });
    // The end of input (Ctrl-D, or a pipe that closes) before an answer is the same as Ctrl-C.
    rl.on("close", () => {
      if (!answered) cancel();
    });
    rl.question(question, (answer) => {
      answered = true;
      signal?.removeEventListener("abort", close);
      rl.close();
      if (hidden && stdin.isTTY) stderr.write("\n");
      resolve(answer);
    });
  });
}

/** A secret: typed without showing at a terminal, or read from a pipe. Never taken from the command line, where a process list shows it. */
export async function secret(context, question) {
  const value = context.stdin.isTTY ? await ask(context, question, { hidden: true }) : await readAll(context.stdin);
  const trimmed = value.trim();
  if (!trimmed) throw usage("Nothing was entered.");
  return trimmed;
}

/** True for yes. Without a terminal to ask at, `--yes` has to say it. */
export async function confirm(context, question) {
  if (context.options.yes) return true;
  if (!context.stdin.isTTY || context.json) throw usage("This needs a yes. Run it again with --yes.");
  return /^y(es)?$/i.test((await ask(context, question + " [y/N] ")).trim());
}

/**
 * Opens text in the person's editor ($VISUAL, $EDITOR, else vi) and returns what they saved.
 * The file is in a folder only they can read and is removed afterwards.
 */
export function edit(context, text, name = "botkins.json") {
  const command = context.env.VISUAL || context.env.EDITOR || "vi";
  const dir = mkdtempSync(join(tmpdir(), "botkins-edit-"));
  const file = join(dir, name);
  try {
    writeFileSync(file, text, { mode: 0o600 });
    // The editor's own words may hold arguments ("code --wait").
    const [program, ...args] = command.split(/\s+/).filter(Boolean);
    const result = spawnSync(program, [...args, file], { stdio: "inherit" });
    if (result.error) throw new CliError("The editor `" + command + "` couldn't be started: " + result.error.message + ". Set EDITOR to the one you use.");
    if (result.status !== 0) throw new CliError("The editor ended with an error, so nothing was changed.");
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Makes a call that the service may refuse with NEEDS_SCRIPT_YES: the routine or task it saves, moves or starts is a script command
 * (desktop/terminal/script-yes.mjs). The text that came with the refusal (the command, its words, its whole script) is shown on
 * standard error, and the person is asked (--yes agrees, when there is no terminal); then the call is made again with the mark.
 * `send(marks)` makes the call with `marks` after its arguments. Returns what the call returned, or `undefined` when the person said no.
 */
export async function withScriptYes(context, send) {
  try {
    return await send([]);
  } catch (error) {
    if (error?.code !== "NEEDS_SCRIPT_YES") throw error;
    // (The last two lines are for a program that makes the call itself.)
    context.stderr.write(String(error.message).split("\n").slice(0, -2).join("\n") + "\n");
    if (!(await confirm(context, "Go on?"))) {
      context.note("Nothing was changed.");
      return undefined;
    }
    return send([{ agreed: true }]);
  }
}
