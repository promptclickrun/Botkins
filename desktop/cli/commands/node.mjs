// Node host commands: configure this computer as a remote Botkins node host, manage shared
// project folders, exec policy, allowlist, whole-computer scope, pending approvals, audit log,
// and per-operation grants.
import { ago, EXIT, table, usage } from "../output.mjs";
import { confirm } from "./input.mjs";
import { approvalAction } from "./workspace.mjs";

const safe = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240);
const show = (context, line) => {
  if (!context.json) context.stderr.write(line + "\n");
};

function formatApprovals(list) {
  if (!Array.isArray(list) || !list.length) return "No pending node host approvals.";
  return table(
    ["REQUEST", "FROM", "OPERATION", "TITLE"],
    list.map((item) => [
      safe(item.id),
      safe(item.sourceBotName && item.sourceHostName ? `${item.sourceBotName} on ${item.sourceHostName}` : item.sourceBotName || item.sourceHostName || "Remote"),
      safe(item.operation || "node"),
      safe(item.title),
    ]),
  );
}

function formatAudit(entries) {
  if (!Array.isArray(entries) || !entries.length) return "No node audit log entries yet.";
  return table(
    ["TIME", "STATUS", "FROM", "OPERATION", "ARGS", "EXIT"],
    entries.map((entry) => [
      ago(entry.time),
      safe(entry.status),
      safe(entry.sourceBotName && entry.sourceHostName ? `${entry.sourceBotName}@${entry.sourceHostName}` : entry.sourceBotName || "Bot"),
      safe(entry.operation),
      safe(entry.argsSummary || entry.resourceName || "").slice(0, 60),
      entry.exitCode !== undefined && entry.exitCode !== null ? String(entry.exitCode) : entry.error ? safe(entry.error).slice(0, 40) : "",
    ]),
  );
}

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
      ago(status.lastCompleted.finishedAt || status.lastCompleted.at)
    : "none yet";
  const policyMode = safe(status.execPolicy?.mode || "ask");
  const allowCount = status.execPolicy?.allowlist?.length ?? 0;
  const lines = [
    table(["", ""], [
      ["Node host", safe(status.name) + " · " + stateWord],
      ["Exec policy", policyMode + (allowCount ? ` (${allowCount} allowlist ${allowCount === 1 ? "rule" : "rules"})` : "")],
      ["Whole computer", status.wholeComputer ? "enabled" : "off (shared folders only)"],
      ["Shared folders", shared],
      ["Pending approvals", String(status.pendingApprovals?.length ?? 0)],
      ["Grants", String(status.grants?.length ?? 0)],
      ["Last completed", last],
    ])
      .split("\n")
      .slice(1)
      .join("\n"),
  ];
  if (status.pendingApprovals?.length) {
    lines.push("", "Pending approvals:", formatApprovals(status.pendingApprovals));
  }
  if (status.grants?.length) {
    lines.push(
      "",
      "Grants:",
      table(
        ["GRANT", "BOT", "HOST", "OPERATION", "RESOURCE", "SCOPE"],
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
  if (status.auditLog?.length) {
    lines.push("", "Recent audit log:", formatAudit(status.auditLog.slice(0, 10)));
  }
  return lines.join("\n");
}

const node = {
  summary: "Run this computer as a Botkins node host and control its policy, approvals, folders and grants",
  details: "A node host runs Botkins on a remote or second computer and offers scoped file, shell, computer-control and notification operations to your other Botkins hosts. Policy and grants are enforced on this node.",
  commands: {
    status: {
      summary: "Show node host status, policy, pending approvals, shared folders, grants and recent audit log",
      usage: "botkins node status",
      async run(context) {
        context.print(await context.client.call("node.status"), formatStatus);
      },
    },
    approvals: {
      summary: "List pending node host approval requests",
      usage: "botkins node approvals",
      async run(context) {
        context.print(await context.client.call("node.approvals"), formatApprovals);
      },
    },
    approve: {
      summary: "Approve or deny a pending node host request at an interactive terminal",
      usage: "botkins node approve <request-id>",
      async run(context) {
        if (context.args.length !== 1) throw usage("botkins node approve <request-id>");
        const target = context.args[0].trim();
        const pending = await context.client.call("node.approvals");
        const request = Array.isArray(pending)
          ? pending.find((entry) => entry.id === target || entry.chatId === target || entry.chatId === "node-job-" + target)
          : undefined;
        if (!request) throw usage("No pending node host approval matches " + safe(target) + ". Run `botkins node approvals` to list them.");
        if (!context.stdin.isTTY || context.json) {
          throw usage("Approving a node host request requires an interactive terminal (TTY). Approve at a terminal, in the app window, or on a paired phone.");
        }
        const action = await approvalAction(context, request);
        const result = await context.client.call(
          "chat.respond",
          request.id,
          { action },
          ...(action === "deny" ? [] : [{ agreed: true, ...(request.review && { reviewed: true }) }]),
        );
        context.print(result, "Decision recorded.");
      },
    },
    audit: {
      summary: "Show the node host audit log",
      usage: "botkins node audit [--limit <count>]",
      options: {
        limit: { type: "string", value: "count", about: "Maximum number of entries to show (default 50)" },
      },
      async run(context) {
        const raw = context.options.limit;
        const limit = raw !== undefined ? Number(raw) : 50;
        if (!Number.isFinite(limit) || limit <= 0) throw usage("botkins node audit [--limit <count>]");
        context.print(await context.client.call("node.audit", Math.floor(limit)), formatAudit);
      },
    },
    policy: {
      summary: "Set the node host shell execution policy mode (deny, allowlist, ask, full)",
      usage: "botkins node policy <mode>",
      async run(context) {
        if (context.args.length !== 1) throw usage("botkins node policy <deny|allowlist|ask|full>");
        const mode = context.args[0].trim().toLowerCase();
        context.print(
          await context.client.call("node.execMode", mode),
          (status) => "Exec policy set to " + safe(status?.execPolicy?.mode || mode) + ".",
        );
      },
    },
    allowlist: {
      summary: "Inspect or change this node's shell allowlist rules",
      usage: "botkins node allowlist [--add <pattern>] [--bot <bot-id>] [--remove <rule-id>]",
      options: {
        add: { type: "string", value: "pattern", about: "Add an executable name or path glob pattern" },
        bot: { type: "string", value: "bot-id", about: "Optional source bot ID to scope an added rule (default *)" },
        remove: { type: "string", value: "rule-id", about: "Remove an allowlist rule by id" },
      },
      async run(context) {
        if (context.options.add && context.options.remove) {
          throw usage("Use either --add or --remove, not both.");
        }
        if (context.options.add) {
          const status = await context.client.call("node.allowlist.add", context.options.add, context.options.bot || "*");
          context.print(status, () => `Added allowlist rule "${safe(context.options.add)}" for ${safe(context.options.bot || "*")}.`);
          return;
        }
        if (context.options.remove) {
          const status = await context.client.call("node.allowlist.remove", context.options.remove);
          context.print(status, () => `Removed allowlist rule ${safe(context.options.remove)}.`);
          return;
        }
        const status = await context.client.call("node.status");
        const rules = status?.execPolicy?.allowlist ?? [];
        context.print(rules, () =>
          rules.length
            ? table(
                ["ID", "BOT", "PATTERN"],
                rules.map((r) => [safe(r.id), safe(r.botId || "*"), safe(r.pattern)]),
              )
            : "No shell allowlist rules configured.",
        );
      },
    },
    "whole-computer": {
      summary: "Turn whole-computer file access on or off for this node",
      usage: "botkins node whole-computer <on|off>",
      async run(context) {
        if (context.args.length !== 1) throw usage("botkins node whole-computer <on|off>");
        const arg = context.args[0].trim().toLowerCase();
        if (arg !== "on" && arg !== "off") throw usage("botkins node whole-computer <on|off>");
        const enabled = arg === "on";
        context.print(
          await context.client.call("node.wholeComputer", enabled),
          () => (enabled ? "Whole-computer file access enabled on this node." : "Whole-computer file access turned off."),
        );
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
      summary: "Pause incoming node host requests and kill running operations immediately",
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
