// `botkins feedback`: a bug report or feature request, opened as a public issue on the Botkins repo.
// The service signs it with this computer's relay key; the relay opens the issue (mobile/relay/src/feedback.ts).
import { CliError, usage } from "../output.mjs";
import { readAll } from "./input.mjs";
import { readFileSync } from "node:fs";

async function textFrom(context, path) {
  if (path === "-") return readAll(context.stdin);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError("The file " + path + " can't be read: " + error.message);
  }
}

export const feedbackCommands = {
  feedback: {
    summary: "Report a bug or ask for a feature: opens a public issue on GitHub",
    usage: "botkins feedback <title> (--text <details> | --file <path>) [--feature]",
    options: {
      text: { type: "string", value: "details", about: "What happened, or what you'd like" },
      file: { type: "string", value: "path", about: "Read the details from this file. \"-\" reads standard input" },
      feature: { type: "boolean", about: "A feature request (without it, a bug report)" },
    },
    details: "The issue is public. It holds the title, the details, and this app's version and platform, nothing else. Leave out names, chats and anything private.",
    async run(context) {
      if (context.args.length !== 1) throw usage("Give the title in quotes.");
      const { text, file, feature } = context.options;
      if ((text === undefined) === (file === undefined)) throw usage("Give the details with --text or --file, one of them.");
      const body = text ?? (await textFrom(context, file));
      const answer = await context.client.call("feedback.send", { kind: feature ? "feature" : "bug", title: context.args[0], body });
      context.print(answer, "Opened issue #" + answer.number + ": " + answer.url);
    },
  },
};
