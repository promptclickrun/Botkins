// CLI commands for Channel Hooks (`botkins channels ...`).
// Strictly owner-only via the local control socket. Secrets are read ONLY from a hidden prompt or stdin.

import { CHANNEL_KINDS, CHANNEL_SECRET_SPECS } from "../../desktop/channels/types.mjs";
import { table, usage } from "../output.mjs";
import { ask, readAll } from "./input.mjs";

/** Reads required secrets for a channel kind from hidden TTY prompts or piped stdin (never CLI flags). */
async function readChannelSecrets(context, kind) {
  const specs = CHANNEL_SECRET_SPECS[kind] ?? [];
  if (!specs.length) return {};

  if (context.stdin.isTTY) {
    const out = {};
    for (const spec of specs) {
      const value = await ask(context, `${spec.label}: `, { hidden: true });
      const trimmed = String(value ?? "").trim();
      if (!trimmed && spec.required) throw usage(`${spec.label} is required.`);
      if (trimmed) out[spec.key] = trimmed;
    }
    return out;
  }

  // Piped stdin: supports either JSON object ({ botToken: "...", appToken: "..." }) or one secret per line in spec order.
  const raw = (await readAll(context.stdin)).trim();
  if (!raw) throw usage(`Provide ${specs.map((s) => s.key).join(" and ")} on stdin (JSON object or one token per line).`);
  if (raw.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw usage("Invalid JSON on stdin for channel secrets.");
    }
    const out = {};
    for (const spec of specs) {
      const val = typeof parsed[spec.key] === "string" ? parsed[spec.key].trim() : "";
      if (!val && spec.required) throw usage(`Missing "${spec.key}" in stdin JSON.`);
      if (val) out[spec.key] = val;
    }
    return out;
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const out = {};
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const val = lines[i] ?? "";
    if (!val && spec.required) throw usage(`Missing ${spec.label} (expected line ${i + 1} on stdin).`);
    if (val) out[spec.key] = val;
  }
  return out;
}

function parseList(value) {
  if (!value) return undefined;
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePositiveInt(value, name) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) throw usage(`--${name} must be a positive number.`);
  return Math.floor(n);
}

export const channelsCommands = {
  channels: {
    summary: "Publish bots to Slack, Telegram, Discord, and iMessage",
    commands: {
      list: {
        summary: "List configured channel connections",
        usage: "botkins channels list",
        async run(context) {
          const list = await context.client.call("channels.list");
          context.print(list, (items) => {
            if (!items.length) return "No channels configured. Run `botkins channels add <kind> --bot <bot>` to add one.";
            return table(
              ["ID", "KIND", "LABEL", "BOT", "STATUS", "DM", "GROUPS", "PAIRINGS"],
              items.map((c) => [
                c.id,
                c.kind,
                c.label,
                c.botId || "-",
                c.status?.state || (c.paused ? "paused" : c.enabled ? "disconnected" : "disabled"),
                c.policy?.dm || "pairing",
                c.policy?.groups?.enabled ? c.policy.groups.mode : "off",
                String(c.pendingPairings?.length ?? 0),
              ]),
            );
          });
        },
      },

      add: {
        summary: "Add a channel connection (reads tokens from hidden prompt or stdin)",
        usage: "botkins channels add <kind> [--label <name>] [--bot <bot>] [--node <host-id>] [--dm <policy>] [--disabled]",
        options: {
          label: { type: "string", value: "name", about: "Display label for this connection" },
          bot: { type: "string", value: "bot", about: "Bot ID or name to bind" },
          node: { type: "string", value: "host-id", about: "Node host ID (for iMessage via a Mac node host)" },
          dm: { type: "string", value: "policy", about: "DM policy: pairing (default), allowlist, open, or off" },
          disabled: { type: "boolean", about: "Create disabled without connecting yet" },
        },
        details: `Supported kinds: ${CHANNEL_KINDS.join(", ")}. Secrets are never accepted as command-line arguments; they are read from a hidden prompt or piped stdin.`,
        async run(context) {
          const kind = context.args[0]?.toLowerCase();
          if (!kind || !CHANNEL_KINDS.includes(kind)) {
            throw usage(`Specify a channel kind: ${CHANNEL_KINDS.join(", ")}.`);
          }
          const secrets = await readChannelSecrets(context, kind);
          const payload = {
            kind,
            ...(context.options.label && { label: context.options.label }),
            ...(context.options.bot && { bot: context.options.bot }),
            ...(context.options.node && { nodeHostId: context.options.node }),
            enabled: !context.options.disabled,
            ...(context.options.dm && { policy: { dm: context.options.dm } }),
            secrets,
          };
          const created = await context.client.call("channels.add", [payload]);
          context.print(created, (c) => `Added ${c.kind} channel "${c.label}" (${c.id}). Status: ${c.status?.state ?? "configured"}.`);
        },
      },

      remove: {
        summary: "Remove a channel connection and delete its vault tokens",
        usage: "botkins channels remove <channel>",
        async run(context) {
          const ref = context.args[0];
          if (!ref) throw usage("Specify a channel ID or label.");
          const res = await context.client.call("channels.remove", [ref]);
          context.print(res, (r) => `Removed channel ${r.id}.`);
        },
      },

      bind: {
        summary: "Bind a channel connection to a bot",
        usage: "botkins channels bind <channel> <bot>",
        async run(context) {
          const [ref, botRef] = context.args;
          if (!ref || !botRef) throw usage("Usage: botkins channels bind <channel> <bot>");
          const updated = await context.client.call("channels.bind", [ref, botRef]);
          context.print(updated, (c) => `Bound "${c.label}" (${c.id}) to bot ${c.botId}.`);
        },
      },

      policy: {
        summary: "Update DM, group, tool profile, or rate-limit policy for a channel",
        usage: "botkins channels policy <channel> [--dm <policy>] [--groups <on|off>] [--group-mode <mention|all>] [--group-channels <ids>] [--tools <restricted|standard>] [--sender-rate <n>] [--channel-rate <n>] [--daily-cap <n>] [--max-length <n>]",
        options: {
          dm: { type: "string", value: "policy", about: "DM policy: pairing, allowlist, open, or off" },
          groups: { type: "string", value: "on|off", about: "Enable or disable group messages (off by default)" },
          "group-mode": { type: "string", value: "mention|all", about: "When groups are on: mention (default) or all" },
          "group-channels": { type: "string", value: "ids", about: "Comma-separated external channel/chat IDs allowed for group replies" },
          tools: { type: "string", value: "restricted|standard", about: "Tool profile: restricted (default, read-only) or standard (widened)" },
          "sender-rate": { type: "string", value: "n", about: "Max messages per sender per minute" },
          "channel-rate": { type: "string", value: "n", about: "Max messages per connection per minute" },
          "daily-cap": { type: "string", value: "n", about: "Daily turn cap before notifying the owner" },
          "max-length": { type: "string", value: "n", about: "Max inbound message length in characters" },
        },
        async run(context) {
          const ref = context.args[0];
          if (!ref) throw usage("Specify a channel ID or label.");
          const o = context.options;
          const patch = {};
          if (o.dm) patch.dm = o.dm;
          if (o.tools) patch.toolProfile = o.tools;
          const groups = {};
          if (o.groups !== undefined) {
            if (!["on", "off", "true", "false"].includes(o.groups.toLowerCase())) throw usage("--groups must be on or off.");
            groups.enabled = o.groups.toLowerCase() === "on" || o.groups.toLowerCase() === "true";
          }
          if (o["group-mode"]) groups.mode = o["group-mode"];
          if (o["group-channels"] !== undefined) groups.channels = parseList(o["group-channels"]) ?? [];
          if (Object.keys(groups).length) patch.groups = groups;

          const limits = {};
          const senderPerMinute = parsePositiveInt(o["sender-rate"], "sender-rate");
          const connectionPerMinute = parsePositiveInt(o["channel-rate"], "channel-rate");
          const dailyTurnCap = parsePositiveInt(o["daily-cap"], "daily-cap");
          const maxInboundLength = parsePositiveInt(o["max-length"], "max-length");
          if (senderPerMinute !== undefined) limits.senderPerMinute = senderPerMinute;
          if (connectionPerMinute !== undefined) limits.connectionPerMinute = connectionPerMinute;
          if (dailyTurnCap !== undefined) limits.dailyTurnCap = dailyTurnCap;
          if (maxInboundLength !== undefined) limits.maxInboundLength = maxInboundLength;
          if (Object.keys(limits).length) patch.limits = limits;

          if (!Object.keys(patch).length) throw usage("Provide at least one policy option to change.");
          const updated = await context.client.call("channels.policy", [ref, patch]);
          context.print(updated, (c) =>
            `Updated policy for "${c.label}": dm=${c.policy.dm}, groups=${c.policy.groups.enabled ? c.policy.groups.mode : "off"}, tools=${c.policy.toolProfile}, dailyCap=${c.policy.limits.dailyTurnCap}.`,
          );
        },
      },

      pair: {
        summary: "Inspect or approve pending DM pairing requests",
        commands: {
          list: {
            summary: "List pending pairing codes",
            usage: "botkins channels pair list [<channel>]",
            async run(context) {
              const ref = context.args[0] ?? null;
              const items = await context.client.call("channels.pair.list", [ref]);
              context.print(items, (rows) => {
                if (!rows.length) return "No pending pairing requests.";
                return table(
                  ["CODE", "CHANNEL", "SENDER", "DISPLAY", "EXPIRES"],
                  rows.map((r) => [r.code, r.label, r.senderId, r.display || "-", new Date(r.expiresAt).toISOString()]),
                );
              });
            },
          },
          approve: {
            summary: "Approve a pending pairing code and allowlist the sender",
            usage: "botkins channels pair approve <code> [<channel>]",
            async run(context) {
              const [code, ref] = context.args;
              if (!code) throw usage("Specify the pairing code to approve.");
              const res = await context.client.call("channels.pair.approve", [code, ref ?? null]);
              context.print(res, (r) => `Approved ${r.senderId} (${r.display || r.senderId}) on ${r.connectionId}.`);
            },
          },
          deny: {
            summary: "Deny and discard a pending pairing code",
            usage: "botkins channels pair deny <code> [<channel>]",
            async run(context) {
              const [code, ref] = context.args;
              if (!code) throw usage("Specify the pairing code to deny.");
              const res = await context.client.call("channels.pair.deny", [code, ref ?? null]);
              context.print(res, (r) => `Denied ${r.senderId} on ${r.connectionId}.`);
            },
          },
        },
      },

      pause: {
        summary: "Pause a channel connection",
        usage: "botkins channels pause <channel>",
        async run(context) {
          const ref = context.args[0];
          if (!ref) throw usage("Specify a channel ID or label.");
          const updated = await context.client.call("channels.pause", [ref]);
          context.print(updated, (c) => `Paused "${c.label}" (${c.id}).`);
        },
      },

      resume: {
        summary: "Resume a paused channel connection",
        usage: "botkins channels resume <channel>",
        async run(context) {
          const ref = context.args[0];
          if (!ref) throw usage("Specify a channel ID or label.");
          const updated = await context.client.call("channels.resume", [ref]);
          context.print(updated, (c) => `Resumed "${c.label}" (${c.id}). Status: ${c.status?.state ?? "active"}.`);
        },
      },

      test: {
        summary: "Verify credentials and connectivity for a channel connection",
        usage: "botkins channels test <channel>",
        async run(context) {
          const ref = context.args[0];
          if (!ref) throw usage("Specify a channel ID or label.");
          const res = await context.client.call("channels.test", [ref]);
          context.print(res, (r) => (r.ok ? `OK: ${r.detail || "Connected"}` : `FAILED: ${r.detail || "Unable to connect"}`));
        },
      },

      logs: {
        summary: "Show metadata-only audit log entries for channels",
        usage: "botkins channels logs [<channel>] [--limit <n>]",
        options: {
          limit: { type: "string", value: "n", about: "Maximum number of entries to return (default 50)" },
        },
        async run(context) {
          const ref = context.args[0] ?? null;
          const limit = parsePositiveInt(context.options.limit, "limit") ?? 50;
          const entries = await context.client.call("channels.logs", [ref, { limit }]);
          context.print(entries, (rows) => {
            if (!rows.length) return "No channel audit entries.";
            return table(
              ["TIME", "CHANNEL", "DECISION", "SENDER", "CONVERSATION", "REASON"],
              rows.map((r) => [r.time, r.kind || r.connectionId, r.decision, r.senderId || "-", r.conversationId || "-", r.reason || "-"]),
            );
          });
        },
      },
    },
  },
};
