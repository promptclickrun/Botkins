// Node host commands: configure this computer as a remote Botkins node host, manage shared
// project folders and per-operation grants, pause/resume, or disconnect.
import { ago, EXIT, table, usage } from "../output.mjs";
import { confirm } from "./input.mjs";

const safe = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240);
const show = (context, line) => {
  if (!context.json) context.stderr.write(line + "\n");
};

function formatStatus(status) {
  if (!status?.enabled) return "Node host is off. Run `botkins node setup --name <name>` to set this computer up as a node host.";
  const stateWord = status.paused ? "Paused" : "Online";
  const shared = status.sharedProjects?.length
    ? status.sharedProjects.map((project) => safe(project.name) + " (" + safe(project.folder) + ")").join(", ")
    : "none";
  const last = status.lastCompleted
    ? safe(status.lastCompleted.sourceBotName) +
      " on " +
      safe(status.lastCompleted.sourceHostName) +
      " · " +
      safe(status.lastCompleted.operation) +
      " (" +
      safe(status.lastCompleted.resourceName) +
      ") · " +
      ago(status.lastCompleted.at)
    : "none yet";
  const lines = [
    table(["", ""], [
      ["Node host", safe(status.name) + " · " + stateWord],
      ["Shared folders", shared],
      ["Last completed", last],
      ["Grants", String(status.grants?.length ?? 0)],
    ])
      .split("\n")
      .slice(1)
      .join("\n"),
  ];
  if (status.grants?.length) {
    lines.push(
      "",
      table(
        ["GRANT", "BOT", "HOST", "OPERATION", "FOLDER", "SCOPE"],
        status.grants.map((grant) => [
          safe(grant.id),
          safe(grant.sourceBotName),
          safe(grant.sourceHostName),
          safe(grant.operation),
          safe(grant.resourceName),
          grant.scope === "always" ? "always" : "today",
        ]),
      ),
    );
  }
  return lines.join("\n");
}

const node = {
  summary: "Run this computer as a Botkins node host and control its shared folders and grants",
  details: "A node host runs Botkins on a remote or second computer and offers shared bots and read-only project folder listings to your other Botkins hosts. Grants are stored on this node per requesting host, bot, operation and folder.",
  commands: {
    status: {
      summary: "Show node host status, shared folders, last completed request and grants",
      usage: "botkins node status",
      async run(context) {
        context.print(await context.client.call("node.status"), formatStatus);
      },
    },
    setup: {
      summary: "Set this computer up as a node host with a name",
      usage: "botkins node setup --name <name>",
      options: {
        name: { type: "string", value: "name", about: "The name shown for this node host on your other computers" },
      },
      async run(context) {
        const name = safe(context.options.name).trim();
        if (!name) throw usage("botkins node setup --name <name>");
        context.print(await context.client.call("node.setup", name), (status) => "Node host set up as " + safe(status?.name || name) + " (Online).");
      },
    },
    rename: {
      summary: "Rename this node host",
      usage: "botkins node rename <name>",
      async run(context) {
        if (context.args.length !== 1) throw usage("botkins node rename <name>");
        const name = safe(context.args[0]).trim();
        if (!name) throw usage("botkins node rename <name>");
        context.print(await context.client.call("node.rename", name), (status) => "Renamed node host to " + safe(status?.name || name) + ".");
      },
    },
    pause: {
      summary: "Pause incoming node host requests",
      usage: "botkins node pause",
      async run(context) {
        context.print(await context.client.call("node.pause", true), (status) => "Node host " + safe(status?.name || "") + " is paused.");
      },
    },
    resume: {
      summary: "Resume incoming node host requests",
      usage: "botkins node resume",
      async run(context) {
        context.print(await context.client.call("node.pause", false), (status) => "Node host " + safe(status?.name || "") + " is online.");
      },
    },
    share: {
      summary: "Share a project folder from this node host",
      usage: "botkins node share <project>",
      async run(context) {
        if (context.args.length !== 1) throw usage("botkins node share <project>");
        context.print(await context.client.call("node.share", context.args[0], true), (result) => "Sharing folder for project " + safe(result?.project?.name || context.args[0]) + ".");
      },
    },
    unshare: {
      summary: "Stop sharing a project folder from this node host",
      usage: "botkins node unshare <project>",
      async run(context) {
        if (context.args.length !== 1) throw usage("botkins node unshare <project>");
        context.print(await context.client.call("node.share", context.args[0], false), (result) => "Stopped sharing folder for project " + safe(result?.project?.name || context.args[0]) + ".");
      },
    },
    revoke: {
      summary: "Revoke one node host grant by id, or all grants with --all",
      usage: "botkins node revoke [<grant-id>] [--all] [--yes]",
      options: {
        all: { type: "boolean", about: "Revoke every saved node host grant" },
        yes: { type: "boolean", about: "Do not ask first" },
      },
      async run(context) {
        const all = context.options.all === true;
        if (all && context.args.length) throw usage("botkins node revoke [<grant-id>] [--all] [--yes]");
        if (!all && context.args.length !== 1) throw usage("botkins node revoke [<grant-id>] [--all] [--yes]");
        const id = all ? undefined : context.args[0];
        show(context, id ? "This revokes node host grant " + safe(id) + ". Future requests for that operation will ask again." : "This revokes all saved node host grants. Future requests will ask again.");
        if (!(await confirm(context, id ? "Revoke node host grant " + safe(id) + "?" : "Revoke all node host grants?"))) {
          context.note("Grants kept.");
          return EXIT.failed;
        }
        context.print(await context.client.call("node.revoke", id), id ? "Revoked grant " + safe(id) + "." : "Revoked all node host grants.");
      },
    },
    disconnect: {
      summary: "Disconnect this computer from acting as a node host",
      usage: "botkins node disconnect [--yes]",
      options: {
        yes: { type: "boolean", about: "Do not ask first" },
      },
      details: "Cancels in-flight node jobs, turns off node hosting, and disconnects this host from the profile directory. Local bots, chats and project files stay on this computer.",
      async run(context) {
        show(context, "This disconnects this computer as a node host and stops serving remote node requests.");
        if (!(await confirm(context, "Disconnect this node host?"))) {
          context.note("Still connected.");
          return EXIT.failed;
        }
        context.print(await context.client.call("node.disconnect"), "Disconnected node host.");
      },
    },
  },
};

export const nodeCommands = { node };
