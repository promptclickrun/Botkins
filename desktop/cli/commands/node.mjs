// Node host commands: configure this computer as a remote Botkins node host, manage shared
// project folders and per-operation grants, pause/resume, or disconnect.
import { ago, EXIT, table, usage } from "../output.mjs";
import { ask, confirm } from "./input.mjs";

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
  if (status.conversion?.snapshot) {
    lines.push("", "Backup snapshot available for undo: " + safe(status.conversion.snapshot.path));
  }
  return lines.join("\n");
}

function parseBotSpecs(rawSpecs, bots, targets) {
  const specs = Array.isArray(rawSpecs) ? rawSpecs : rawSpecs ? [rawSpecs] : [];
  const actions = [];
  for (const spec of specs) {
    const eq = String(spec).indexOf("=");
    if (eq <= 0) throw usage("Use --bot <bot>=<move:host|keep|delete>.");
    const ref = spec.slice(0, eq).trim();
    const rhs = spec.slice(eq + 1).trim();
    const bot =
      bots.find((b) => b.id === ref) ??
      bots.find((b) => String(b.name || "").toLowerCase() === ref.toLowerCase());
    if (!bot) throw usage("Unknown bot: " + safe(ref));
    const [rawAction, rawTarget] = rhs.split(":");
    const action = (rawAction || "").trim().toLowerCase();
    if (!["move", "keep", "delete"].includes(action)) {
      throw usage("Bot action must be move, keep, or delete (got " + safe(rawAction) + ").");
    }
    let targetHostId;
    if (action === "move" && rawTarget) {
      const target =
        targets.find((h) => h.serverId === rawTarget.trim()) ??
        targets.find((h) => String(h.name || "").toLowerCase() === rawTarget.trim().toLowerCase());
      targetHostId = target ? target.serverId : rawTarget.trim();
    }
    actions.push({ botId: bot.id, action, ...(targetHostId && { targetHostId }) });
  }
  return actions;
}

function resolveTargetHost(ref, targets) {
  if (!ref) return "";
  const trimmed = String(ref).trim();
  const match =
    targets.find((h) => h.serverId === trimmed) ??
    targets.find((h) => String(h.name || "").toLowerCase() === trimmed.toLowerCase());
  return match ? match.serverId : trimmed;
}

function formatPlan(plan) {
  const lines = [
    "Node host name: " + safe(plan.nodeName),
    "Backup snapshot folder: " + safe(plan.snapshotDir),
    "",
    table(
      ["BOT", "ACTION", "DESTINATION", "CHATS", "ROUTINES", "PANELS"],
      (plan.botPlans ?? []).map((item) => [
        safe(item.botName),
        safe(item.action),
        item.action === "move"
          ? safe(item.targetHostName || item.targetHostId || "")
          : item.action === "keep"
            ? "this node (shared)"
            : "removed after snapshot",
        String(item.chatCount ?? 0),
        String(item.routineCount ?? 0),
        String(item.panelCount ?? 0),
      ]),
    ),
    "",
    `Summary: ${plan.counts.moveBots} moving, ${plan.counts.keepBots} kept locally, ${plan.counts.deleteBots} deleting · ` +
      `${plan.counts.chatsMoving} chats & ${plan.counts.routinesMoving} routines moving · ` +
      `${plan.counts.vaultEntriesLeftBehind} vault secrets left encrypted locally.`,
  ];
  if (plan.warnings?.length) {
    lines.push("", ...plan.warnings.map((w) => "Note: " + safe(w)));
  }
  if (plan.errors?.length) {
    lines.push("", ...plan.errors.map((e) => "Error: " + safe(e)));
  }
  return lines.join("\n");
}

function formatConversionResult(result) {
  const job = result?.job;
  if (!job) return "Conversion finished.";
  const lines = [
    `Conversion ${safe(job.status)}: ${safe(job.nodeName)} (${result?.nodeHost?.online ? "Online" : result?.nodeHost?.paused ? "Paused" : "Not active"})`,
  ];
  if (job.snapshotPath) lines.push("Local backup snapshot: " + safe(job.snapshotPath));
  if (job.error) lines.push("Stopped: " + safe(job.error));
  if (job.items?.length) {
    lines.push(
      "",
      table(
        ["BOT", "ACTION", "STAGE", "LOCATION"],
        job.items.map((item) => [
          safe(item.botName),
          safe(item.action),
          safe(item.stage),
          item.action === "move"
            ? safe(item.targetHostName || item.targetHostId || "")
            : item.action === "keep"
              ? "this node (shared)"
              : "deleted",
        ]),
      ),
    );
  }
  if (job.status === "completed" && job.snapshotPath) {
    lines.push("", "To undo while the snapshot exists: botkins node convert --undo --yes");
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
    convert: {
      summary: "Convert this full Botkins host into a Node host (move, keep, or delete local bots safely)",
      usage: "botkins node convert [--name <name>] [--all <move|keep|delete>] [--target <host>] [--bot <spec>] [--share <project>] [--confirm-delete <phrase>] [--dry-run] [--resume] [--undo] [--yes]",
      details:
        "Takes a local backup snapshot first, moves chosen bots with verify-before-delete and routine de-duplication, keeps chosen bots as shared bots, and enables Node host mode. Vault secrets stay encrypted on this computer. Phone pairing survives.",
      options: {
        name: { type: "string", value: "name", about: "Node host name shown on your other computers" },
        all: { type: "string", value: "move|keep|delete", about: "Apply the same action to every local bot" },
        target: { type: "string", value: "host", about: "Destination same-owner host name or id for --all move or --bot <bot>=move" },
        bot: { type: "string", multiple: true, value: "spec", about: "Per-bot action: <bot>=move[:<host>]|keep|delete (repeat per bot)" },
        share: { type: "string", multiple: true, value: "project", about: "Project name or id whose folder to share from this node" },
        "confirm-delete": { type: "string", value: "phrase", about: "Type DELETE to confirm deleting bots in non-interactive mode" },
        "dry-run": { type: "boolean", about: "Inspect and print the conversion plan without making any changes" },
        resume: { type: "boolean", about: "Resume an interrupted conversion without duplicating already-moved bots" },
        undo: { type: "boolean", about: "Restore this computer from the latest local conversion backup snapshot" },
        yes: { type: "boolean", about: "Run non-interactively without prompting" },
      },
      async run(context) {
        if (context.options.undo) {
          show(context, "This restores this computer from its local conversion backup snapshot (phone pairing and vault stay intact).");
          if (!(await confirm(context, "Undo the node host conversion?"))) {
            context.note("Conversion kept.");
            return EXIT.failed;
          }
          const undone = await context.client.call("node.convert.undo");
          context.print(
            undone,
            (res) =>
              `Restored ${res.restoredBots} bot(s) and ${res.restoredChats} chat(s) from snapshot ${safe(res.snapshotId)}.` +
              (res.pausedToPreventDupes?.length
                ? `\nPaused ${res.pausedToPreventDupes.length} routine(s) because their target host was unreachable during rollback.`
                : ""),
          );
          return;
        }

        if (context.options.resume) {
          const result = await context.client.call("node.convert.run", { resume: true });
          context.print(result, formatConversionResult);
          return result?.job?.status === "completed" ? EXIT.ok : EXIT.failed;
        }

        const inspected = await context.client.call("node.convert.inspect");
        const bots = inspected?.bots ?? [];
        const targets = (inspected?.targets ?? []).filter((h) => h.online && !h.unavailable);
        const nodeName = safe(context.options.name || inspected?.suggestedName || "Node Host").trim();

        const sharedProjects = [];
        const shareSpecs = Array.isArray(context.options.share)
          ? context.options.share
          : context.options.share
            ? [context.options.share]
            : [];
        for (const ref of shareSpecs) {
          const project = (inspected?.shared?.projects?.items ?? []).find(
            (p) => p.id === ref || String(p.name || "").toLowerCase() === String(ref).toLowerCase(),
          );
          if (!project) throw usage("Unknown project to share: " + safe(ref));
          sharedProjects.push(project.id);
        }

        const defaultTarget = resolveTargetHost(context.options.target, targets);
        let sameForAll;
        if (context.options.all) {
          const action = String(context.options.all).trim().toLowerCase();
          if (!["move", "keep", "delete"].includes(action)) throw usage("--all must be move, keep, or delete.");
          sameForAll = { action, ...(action === "move" && defaultTarget ? { targetHostId: defaultTarget } : {}) };
        }

        let botActions = parseBotSpecs(context.options.bot, bots, targets).map((item) =>
          item.action === "move" && !item.targetHostId && defaultTarget
            ? { ...item, targetHostId: defaultTarget }
            : item,
        );

        const nonInteractive =
          Boolean(context.options.yes || context.options.all || botActions.length || context.options["dry-run"] || context.json || !context.stdin.isTTY);

        if (!nonInteractive && bots.length > 0) {
          show(context, `Found ${bots.length} local bot(s), ${inspected?.shared?.wiki?.pageCount ?? 0} wiki page(s), and ${inspected?.shared?.vault?.count ?? 0} vault entry(ies).`);
          if (targets.length) {
            show(context, "Online same-owner hosts: " + targets.map((h) => `${safe(h.name)} (${safe(h.serverId)})`).join(", "));
          } else {
            show(context, "No other same-owner hosts are currently online (you can still Keep locally or Delete).");
          }
          botActions = [];
          for (const bot of bots) {
            const answer = (
              await ask(
                context,
                `Bot "${safe(bot.name)}" (${bot.chatCount} chats, ${bot.routineCount} routines) — [m]ove, [k]eep locally, or [d]elete? [k] `,
              )
            )
              .trim()
              .toLowerCase();
            const action = answer.startsWith("m") ? "move" : answer.startsWith("d") ? "delete" : "keep";
            let targetHostId;
            if (action === "move") {
              if (!targets.length) throw usage("No online destination host is available to move " + safe(bot.name) + ".");
              if (targets.length === 1) {
                targetHostId = targets[0].serverId;
              } else {
                const chosen = (
                  await ask(context, `Destination host name or id for "${safe(bot.name)}" [${safe(targets[0].name)}]: `)
                ).trim();
                targetHostId = resolveTargetHost(chosen || targets[0].serverId, targets);
              }
            }
            botActions.push({ botId: bot.id, action, ...(targetHostId && { targetHostId }) });
          }
        }

        let confirmDelete = safe(context.options["confirm-delete"] || "").trim();
        const planInput = {
          nodeName,
          ...(sameForAll && { sameForAll }),
          ...(botActions.length && { botActions }),
          ...(sharedProjects.length && { sharedProjects }),
          ...(confirmDelete && { confirmDelete }),
        };

        const plan = await context.client.call("node.convert.plan", planInput);
        if (context.options["dry-run"]) {
          context.print(plan, formatPlan);
          return plan.valid ? EXIT.ok : EXIT.failed;
        }
        if (!plan.valid) {
          context.print(plan, formatPlan);
          return EXIT.failed;
        }

        if (plan.requiresDeleteConfirmation && !plan.deleteConfirmed) {
          if (context.json || !context.stdin.isTTY) {
            throw usage("Deleting bots requires --confirm-delete DELETE.");
          }
          show(context, formatPlan(plan));
          const typed = (await ask(context, "Type DELETE to confirm deleting the selected bot(s): ")).trim();
          if (typed !== "DELETE") {
            context.note("Conversion cancelled.");
            return EXIT.failed;
          }
          confirmDelete = typed;
        } else if (!context.options.yes) {
          show(context, formatPlan(plan));
          if (!(await confirm(context, "Take a local backup snapshot and convert this computer to a Node host?"))) {
            context.note("Conversion cancelled.");
            return EXIT.failed;
          }
        }

        const result = await context.client.call("node.convert.run", {
          ...planInput,
          ...(confirmDelete && { confirmDelete }),
        });
        context.print(result, formatConversionResult);
        return result?.job?.status === "completed" ? EXIT.ok : EXIT.failed;
      },
    },
    remote: {
      summary: "Control another same-owner node host remotely (status, pause, resume, share, unshare, revoke, rename, disconnect)",
      usage: "botkins node remote <host-id> <status|pause|resume|share|unshare|revoke|rename|disconnect> [<arg>] [--yes]",
      details:
        "Owner-only remote node management over host-to-host encryption. Never available to team members or phones. Mutating actions follow the node host's trusted-device approval model.",
      options: {
        yes: { type: "boolean", about: "Do not ask for local confirmation before sending the request" },
      },
      async run(context) {
        if (context.args.length < 2 || context.args.length > 3) {
          throw usage("botkins node remote <host-id> <status|pause|resume|share|unshare|revoke|rename|disconnect> [<arg>] [--yes]");
        }
        const [hostId, rawAction, arg] = context.args;
        const action = String(rawAction || "").trim().toLowerCase();
        if (action === "status") {
          if (arg !== undefined) throw usage("botkins node remote <host-id> status");
          const result = await context.client.call("node.remote.status", hostId);
          context.print(result, (res) => formatStatus(res?.nodeHost));
          return;
        }
        const allowed = new Set(["pause", "resume", "share", "unshare", "revoke", "rename", "disconnect"]);
        if (!allowed.has(action)) {
          throw usage("Action must be status, pause, resume, share, unshare, revoke, rename, or disconnect.");
        }
        const params = {};
        if (action === "share" || action === "unshare") {
          if (!arg) throw usage(`botkins node remote <host-id> ${action} <project-id>`);
          params.projectId = arg;
        } else if (action === "rename") {
          if (!arg) throw usage("botkins node remote <host-id> rename <name>");
          params.name = arg;
        } else if (action === "revoke" && arg) {
          params.grantId = arg;
        }
        if (action === "disconnect" && !(await confirm(context, `Disconnect remote node host ${safe(hostId)}?`))) {
          context.note("Still connected.");
          return EXIT.failed;
        }
        const result = await context.client.call("node.remote.control", hostId, action, params);
        context.print(
          result,
          (res) => `Remote node ${safe(res?.hostName || hostId)}: ${safe(action)} completed.`,
        );
      },
    },
  },
};

export const nodeCommands = { node };
