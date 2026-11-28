// Connected computers and unified multi-host view (`botkins hosts`).
import { table, usage } from "../output.mjs";

const safe = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240);

const onOff = (word, flagName) => {
  const value = String(word ?? "").trim().toLowerCase();
  if (value === "on" || value === "true" || value === "yes") return true;
  if (value === "off" || value === "false" || value === "no") return false;
  throw usage("Give on or off for " + flagName + ".");
};

function formatHosts(status) {
  const mode = status.unified
    ? "Unified view (all included computers together)"
    : status.unifiedEnabled
      ? "Unified view enabled (no paired computers included)"
      : status.using
        ? "Focused on " + safe(status.using.name)
        : "Focused on " + safe(status.localName) + " (local)";
  const lines = ["View: " + mode];
  if (!status.hosts?.length) {
    lines.push("No paired computers yet. Pair another host in the app or via `botkins profile`.");
    return lines.join("\n");
  }
  lines.push(
    "",
    table(
      ["NAME", "STATE", "IN UNIFIED", "BOTS", "WAITING", "ID"],
      status.hosts.map((host) => [
        safe(host.name) + (host.current ? " (focused)" : ""),
        host.state ? safe(host.state) : "idle",
        host.included !== false ? "yes" : "no",
        host.bots !== undefined ? String(host.bots) : "",
        host.requests ? String(host.requests) : "",
        safe(host.id),
      ]),
    ),
  );
  return lines.join("\n");
}

export const hostsCommands = {
  hosts: {
    summary: "Operate bots across multiple connected computers in one unified view",
    details: "When unified view is on (`botkins hosts unified on`), bots, chats, pending approvals and runs from this computer and every included paired computer appear together without switching hosts.",
    commands: {
      list: {
        summary: "Show connected computers and whether unified view is on",
        usage: "botkins hosts list",
        async run(context) {
          context.print(await context.client.call("hosts.status"), formatHosts);
        },
      },
      unified: {
        summary: "Turn unified multi-host view on or off",
        usage: "botkins hosts unified <state>",
        details: "Give `on` to bring bots, chats and approvals from all included computers into one view, or `off` to return to a single computer.",
        async run(context) {
          if (context.args.length !== 1) throw usage("Give on or off: `botkins hosts unified on` or `botkins hosts unified off`.");
          const enabled = onOff(context.args[0], "unified view");
          context.print(await context.client.call("hosts.unified", enabled), formatHosts);
        },
      },
      include: {
        summary: "Include or exclude a paired computer from unified view",
        usage: "botkins hosts include <host> <state>",
        details: "Give the computer's name or id from `botkins hosts list`, followed by `on` or `off`.",
        async run(context) {
          if (context.args.length !== 2) throw usage("Give the computer name or id and on/off: `botkins hosts include <host> on|off`.");
          const [ref, state] = context.args;
          const included = onOff(state, "include");
          context.print(await context.client.call("hosts.include", ref, included), formatHosts);
        },
      },
      focus: {
        summary: "Focus on a single computer (or local) and leave unified view",
        usage: "botkins hosts focus <host>",
        details: "Give `local` to focus on this computer, or a paired computer's name or id from `botkins hosts list`.",
        async run(context) {
          if (context.args.length !== 1) throw usage("Give `local` or a paired computer's name or id.");
          context.print(await context.client.call("hosts.focus", context.args[0]), formatHosts);
        },
      },
    },
  },
};
