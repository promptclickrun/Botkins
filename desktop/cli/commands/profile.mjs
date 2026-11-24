// Hosted profile setup and directory management.  The command line can start the same browser
// page as the desktop app and can finish it after the person returns; it never prints a session
// token or accepts one as an argument.
import { CliError, EXIT, table, usage } from "../output.mjs";
import { confirm, secret } from "./input.mjs";

const safe = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240);
const one = (context, what) => {
  if (context.args.length !== 1) throw usage(what);
  return context.args[0];
};
const show = (context, line) => { if (!context.json) context.stderr.write(line + "\n"); };

const profile = {
  summary: "Use a hosted Botkins profile across this computer and paired computers",
  details: "A profile keeps your identity and the computers you choose in the hosted Botkins directory. The session stays sealed on this host; it is never printed. The browser page is HTTPS and shows a short code to match here. Sign out removes this host's account-bound session and access until you sign in again.",
  commands: {
    status: {
      summary: "Show the profile identity and public computer directory",
      usage: "botkins profile status",
      async run(context) {
        context.print(await context.client.call("profile.status"), (answer) => {
          if (!answer?.signedIn) return answer?.optedOut ? "Profile is off on this host (local-only mode)." : "No profile is signed in.";
          const name = answer.profile?.name || "Profile";
          return name + (answer.profile?.email ? " <" + safe(answer.profile.email) + ">" : "") + " · " + answer.hosts.length + " computer" + (answer.hosts.length === 1 ? "" : "s") + " listed.";
        });
      },
    },
    start: {
      summary: "Open the hosted profile page and show its matching code",
      usage: "botkins profile start [--label <name>]",
      options: { label: { type: "string", value: "name", about: "The name of this device in the profile directory" } },
      async run(context) {
        const attempt = await context.client.call("profile.start", context.options.label);
        const publicAttempt = attempt && { id: safe(attempt.id), url: safe(attempt.url), code: safe(attempt.code), label: safe(attempt.label) };
        context.print(publicAttempt, (answer) => "Open " + safe(answer.url) + " in a browser.\nMatch this code: " + safe(answer.code) + "\nThen return and run `botkins profile finish`.");
      },
    },
    finish: {
      summary: "Complete the saved browser profile attempt once",
      usage: "botkins profile finish",
      async run(context) {
        const answer = await context.client.call("profile.finish");
        context.print(answer, (profile) => profile ? "Signed in as " + safe(profile.name) + (profile.email ? " <" + safe(profile.email) + ">" : ".") : "The browser sign-in is not finished yet. Return to the profile page, then run this command again.");
      },
    },
    refresh: {
      summary: "Refresh the profile directory and retry offline computer bindings",
      usage: "botkins profile refresh",
      async run(context) {
        context.print(await context.client.call("profile.refresh"), (answer) => answer?.signedIn ? "Profile refreshed: " + answer.hosts.length + " computer" + (answer.hosts.length === 1 ? "" : "s") + " listed." : "No profile is signed in.");
      },
    },
    "sign-out": {
      summary: "Sign out of the profile on this host",
      usage: "botkins profile sign-out [--yes]",
      options: { yes: { type: "boolean", about: "Do not ask first" } },
      details: "Signing out drops this host's account-bound profile session. It does not delete your local bots or chats, but this host no longer shares the profile directory until you sign in again.",
      async run(context) {
        show(context, "This signs out of the hosted profile on this host. Local bots and chats stay, but profile computers and devices are no longer available here until you sign in again.");
        if (!(await confirm(context, "Sign out of the profile?"))) { context.note("Not signed out."); return EXIT.failed; }
        context.print(await context.client.call("profile.signOut"), "Signed out of the profile on this host.");
      },
    },
    "opt-out": {
      summary: "Keep this host local-only and stop the migration prompt",
      usage: "botkins profile opt-out [--yes]",
      options: { yes: { type: "boolean", about: "Do not ask first" } },
      details: "Local-only mode keeps this host's bots and chats here. It does not carry your profile identity, computer directory or continuity to another Botkins host. You can re-enter from `botkins profile start` at any time.",
      async run(context) {
        show(context, "Local-only mode keeps this host's bots and chats here. You lose profile continuity and the shared computer directory until you sign in later.");
        if (!(await confirm(context, "Keep this host local-only?"))) { context.note("Profile setup is still available."); return EXIT.failed; }
        context.print(await context.client.call("profile.optOut"), "Profile is off on this host. You can run `botkins profile start` later.");
      },
    },
    devices: {
      summary: "Approve or revoke trusted profile devices",
      commands: {
        approve: {
          summary: "Approve a pending device with its short code",
          usage: "botkins profile devices approve <device>",
          async run(context) {
            const id = one(context, "Give the pending device id.");
            const code = await secret(context, "Short code shown on that device (not shown): ");
            context.print(await context.client.call("profile.approve", id, code), "Approved the profile device.");
          },
        },
        revoke: {
          summary: "Revoke an installed profile device",
          usage: "botkins profile devices revoke <device> [--yes]",
          options: { yes: { type: "boolean", about: "Do not ask first" } },
          async run(context) {
            const id = one(context, "Give the installed device id.");
            show(context, "This revokes that profile device. It can no longer use the profile until it is trusted again.");
            if (!(await confirm(context, "Revoke the profile device?"))) { context.note("Not revoked."); return EXIT.failed; }
            context.print(await context.client.call("profile.revoke", id), "Revoked the profile device.");
          },
        },
      },
    },
    computers: {
      summary: "List profile computers and connect one with a new Link key",
      commands: {
        list: {
          summary: "List computers in the profile directory",
          usage: "botkins profile computers list",
          async run(context) {
            context.print(await context.client.call("profile.status"), (answer) => answer?.hosts?.length ? table(["NAME", "STATE", "SERVER ID"], answer.hosts.map((host) => [safe(host.name), "listed (connect when needed)", host.serverId])) : "No profile computers are listed.");
          },
        },
        connect: {
          summary: "Connect a listed profile computer",
          usage: "botkins profile computers connect <server>",
          async run(context) {
            const id = one(context, "Give the profile computer's server id.");
            context.print(await context.client.call("profile.connect", id), (answer) => "Connected to " + safe(answer.name) + ". Use it from the desktop switcher or `botkins status`.");
          },
        },
      },
    },
  },
};

export const profileCommands = { profile };
