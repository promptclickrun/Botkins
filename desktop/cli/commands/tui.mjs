// `botkins tui`: the dashboard.
import { usage } from "../output.mjs";

export const tui = {
  tui: {
    summary: "Open the dashboard: the service, devices, bots, chats, routines and the log, and a way in to every command",
    usage: "botkins tui",
    details: "Keys: the arrows or 1 to 6 change the tab, up and down move the selection, : opens the commands screen (every area of the command line, its state, and a line to run one of its commands), ? shows every key, q quits. It needs a terminal; for a script, use the other commands with --json.",
    async run(context) {
      if (!context.stdin.isTTY || !context.stdout.isTTY || context.json) throw usage("The dashboard needs a terminal. In a script, use `botkins status --json` and the other commands.");
      const { runDashboard } = await import("../tui/app.mjs");
      const { main } = await import("../main.mjs");
      // A command that the dashboard runs is the real one, with the same service and data folder as this one.
      const flags = [...(context.options["data-dir"] ? ["--data-dir", context.options["data-dir"]] : []), ...(context.options.socket ? ["--socket", context.options.socket] : [])];
      const run = (words, io) => main([...flags, ...words], { env: context.env, client: context.client, stdin: context.stdin, stdout: context.stdout, stderr: context.stderr, ...io });
      return runDashboard({ client: context.client, stdin: context.stdin, stdout: context.stdout, stderr: context.stderr, env: context.env, run });
    },
  },
};
