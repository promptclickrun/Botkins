// CLI commands for Botkins Agent on GitHub (`botkins github ...`).
// Strictly owner-only via the local control socket.

import { table, usage } from "../output.mjs";

export const githubCommands = {
  github: {
    summary: "Connect the Botkins Agent GitHub App and manage @botkins-agent mentions",
    commands: {
      status: {
        summary: "Show GitHub App connection status, bound installations, and repo mention settings",
        usage: "botkins github status",
        async run(context) {
          const info = await context.client.call("github.status");
          context.print(info, (s) => {
            const lines = [
              `App: @${s.appSlug} (${s.manageAppUrl})`,
              `Relay: ${s.relayConnected ? "connected" : "disconnected"}`,
              `Events: ${s.eventsOn ? "on" : "off"}`,
              `Last delivery: ${s.lastDelivery ? `${s.lastDelivery.event} on ${s.lastDelivery.repository} (${s.lastDelivery.receivedAt})` : "none"}`,
              "",
            ];
            if (!s.installations?.length) {
              lines.push("Installations: none (run `botkins github install` to connect Botkins Agent)");
            } else {
              lines.push(
                "Installations:",
                table(
                  ["ID", "ACCOUNT", "TYPE", "REPOS", "INSTALLER"],
                  s.installations.map((i) => [
                    String(i.installationId),
                    i.accountLogin || "-",
                    i.accountType || "-",
                    i.repositorySelection === "all" ? `all (${i.repos?.length ?? 0})` : String(i.repos?.length ?? 0),
                    i.installerLogin || "-",
                  ]),
                ),
              );
            }
            if (s.repos?.length) {
              lines.push(
                "",
                "Repositories:",
                table(
                  ["REPO", "MENTIONS", "DEFAULT BOT", "ALLOWLIST"],
                  s.repos.map((r) => [
                    r.fullName,
                    r.answerMentions ? "on" : "off",
                    r.defaultBotId || "(primary)",
                    r.allowlist?.length ? r.allowlist.join(", ") : "(installer + write collaborators)",
                  ]),
                ),
              );
            }
            return lines.join("\n");
          });
        },
      },
      install: {
        summary: "Generate a signed 10-minute GitHub App install link for this host",
        usage: "botkins github install",
        async run(context) {
          const result = await context.client.call("github.installUrl");
          context.print(result, (r) =>
            [
              `Open this link in your browser to install @${r.appSlug} and bind it to this host (expires in 10 minutes):`,
              r.url,
            ].join("\n"),
          );
        },
      },
      refresh: {
        summary: "Sync bound GitHub App installations from the relay",
        usage: "botkins github refresh",
        async run(context) {
          const info = await context.client.call("github.refresh");
          context.print(info, (s) =>
            `Synced ${s.installations?.length ?? 0} installation(s) and ${s.repos?.length ?? 0} repository(ies).`,
          );
        },
      },
      repo: {
        summary: "Configure @botkins-agent mention answering, default bot, and allowlist for a repository",
        usage: "botkins github repo <owner/repo> [--mentions <on|off>] [--bot <bot>] [--allowlist <users>]",
        options: {
          mentions: { type: "string", value: "on|off", about: "Turn built-in @botkins-agent mention answering on or off" },
          bot: { type: "string", value: "bot", about: "Default bot name or ID when no bot name follows @botkins-agent (use 'none' to clear)" },
          allowlist: { type: "string", value: "users", about: "Comma-separated extra GitHub logins allowed to summon (use 'clear' to empty)" },
        },
        async run(context) {
          const repo = context.positionals[0];
          if (!repo) throw usage("Provide a repository as owner/repo.");
          const patch = {};
          if (context.options.mentions !== undefined) {
            const v = String(context.options.mentions).trim().toLowerCase();
            if (v === "on" || v === "true" || v === "1") patch.answerMentions = true;
            else if (v === "off" || v === "false" || v === "0") patch.answerMentions = false;
            else throw usage("--mentions must be on or off.");
          }
          if (context.options.bot !== undefined) {
            const v = String(context.options.bot).trim();
            patch.defaultBotId = v.toLowerCase() === "none" || v === "" ? null : v;
          }
          if (context.options.allowlist !== undefined) {
            const v = String(context.options.allowlist).trim();
            patch.allowlist = v.toLowerCase() === "clear" || v === "" ? [] : v.split(",").map((s) => s.trim()).filter(Boolean);
          }
          if (!Object.keys(patch).length) {
            throw usage("Pass at least one of --mentions, --bot, or --allowlist.");
          }
          const updated = await context.client.call("github.setRepo", [repo, patch]);
          context.print(updated, () => `Updated GitHub settings for ${repo.toLowerCase()}.`);
        },
      },
      unbind: {
        summary: "Disconnect a GitHub App installation from this host",
        usage: "botkins github unbind <installation-id>",
        async run(context) {
          const raw = context.positionals[0];
          const id = Number(raw);
          if (!raw || !Number.isSafeInteger(id) || id <= 0) throw usage("Provide a numeric GitHub installation ID.");
          const updated = await context.client.call("github.unbind", [id]);
          context.print(updated, () => `Disconnected GitHub installation ${id} from this host.`);
        },
      },
    },
  },
};
