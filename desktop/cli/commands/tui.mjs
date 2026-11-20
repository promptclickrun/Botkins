// `botkins tui`: the dashboard.
import { usage } from "../output.mjs";

export const tui = {
  tui: {
    summary: "Open the dashboard: the service, devices, bots, chats, routines and the log on one screen",
    usage: "botkins tui",
    details: "Keys: the arrows or 1 to 6 change the tab, up and down move the selection, ? shows every key, q quits. It needs a terminal; for a script, use the other commands with --json.",
    async run(context) {
      if (!context.stdin.isTTY || !context.stdout.isTTY || context.json) throw usage("The dashboard needs a terminal. In a script, use `botkins status --json` and the other commands.");
      const { runDashboard } = await import("../tui/app.mjs");
      return runDashboard({ client: context.client, stdin: context.stdin, stdout: context.stdout, env: context.env });
    },
  },
};
