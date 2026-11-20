// Phones and other devices: pairing, the paired devices, and the relay for away from home.
import { ago, CliError, EXIT, table, usage } from "../output.mjs";
import { confirm } from "./input.mjs";

// The longest a pairing code may stay open: a day (desktop/terminal/control.mjs checks the same).
const MAX_PAIR_MINUTES = 24 * 60;
const deviceRows = (devices) => devices.map((device) => [device.name, device.person ?? "", device.kind, device.platform, device.connected ? "connected" : "last seen " + ago(device.lastSeenAt), device.id]);

export const link = {
  pair: {
    summary: "Show a pairing code (QR code, code and link) for a phone",
    usage: "botkins pair [--ttl <minutes>] [--no-wait] [--no-qr]",
    options: {
      ttl: { type: "string", value: "minutes", about: "How long the code stays open, from 1 to 1440 minutes (5)" },
      "no-wait": { type: "boolean", about: "Print the code and return, without waiting for the phone" },
      wait: { type: "boolean", about: "With --json: wait for the phone and print the device too" },
      "no-qr": { type: "boolean", about: "Leave the QR code out (for a terminal that can't draw it)" },
    },
    details: "Open Botkins on the phone, choose to add a computer and scan the code, or type the address and the code. The code works once and for five minutes, or for as long as --ttl says when the phone's owner gets it later. It lets a phone in: show it only to the person whose phone it is.",
    async run(context) {
      const minutes = context.options.ttl === undefined ? undefined : Number(context.options.ttl);
      if (minutes !== undefined && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_PAIR_MINUTES)) throw usage("--ttl takes a whole number of minutes from 1 to " + MAX_PAIR_MINUTES + ".");
      const before = new Set((await context.client.call("devices.list")).map((device) => device.id));
      const pairing = await context.client.call("pair.start", ...(minutes === undefined ? [] : [{ minutes }]));
      const status = await context.client.call("status");
      const waits = context.json ? context.options.wait === true : context.options["no-wait"] !== true;
      if (!context.json) {
        const lines = [];
        if (!context.options["no-qr"]) lines.push(pairing.qr, "");
        lines.push("Pair a phone with “" + status.link.name + "”", "", "  Code      " + context.color.bold(pairing.code), "  Address   " + (status.link.addresses.length ? status.link.addresses.join("  or  ") : "(no network address found)") + (status.relay.enabled ? "  (or from anywhere, through the relay)" : ""), "  Link      " + pairing.url, "", "The code works once, until " + new Date(pairing.expiresAt).toLocaleTimeString() + ". Keep it private: it lets a phone in.");
        context.stdout.write(lines.join("\n") + "\n");
      }
      if (!waits) {
        if (context.json) context.print(pairing);
        return;
      }
      context.note("\nWaiting for the phone… (Ctrl-C to stop waiting; the code stays open)");
      for (let revision = 0; ; ) {
        const now = await context.client.call("pair.status");
        const device = now.devices.find((entry) => !before.has(entry.id));
        if (device) {
          context.print({ ...pairing, device }, context.color.green("Paired: ") + device.name + " (" + device.platform + ")");
          return;
        }
        if (!now.pairing || now.pairing.code !== pairing.code) throw new CliError("The pairing code ran out before a phone used it. Run `botkins pair` again.", EXIT.failed, "EXPIRED");
        ({ revision } = await context.client.call("events.wait", revision));
      }
    },
  },
  devices: {
    summary: "List, rename and remove paired devices",
    commands: {
      list: {
        summary: "List the paired devices",
        usage: "botkins devices list",
        async run(context) {
          context.print(await context.client.call("devices.list"), (devices) => (devices.length ? table(["NAME", "PERSON", "KIND", "PLATFORM", "STATE", "ID"], deviceRows(devices)) : "No device is paired. Run `botkins pair`."));
        },
      },
      rename: {
        summary: "Give a paired device another name",
        usage: "botkins devices rename <device> <name>",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the device (its name or id) and its new name.");
          context.print(await context.client.call("devices.rename", context.args[0], context.args[1]), (device) => "Renamed to " + device.name + ".");
        },
      },
      "set-person": {
        summary: "Say whose device it is",
        usage: "botkins devices set-person <device> <person>",
        details: "The person's name is shown with the device, on this host and on the phones. An empty name (\"\") clears it.",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the device (its name or id) and the person who uses it.");
          context.print(await context.client.call("devices.setPerson", context.args[0], context.args[1]), (device) => (device.person ? device.name + " is " + device.person + "'s." : device.name + " has no person's name."));
        },
      },
      remove: {
        summary: "Unpair a device",
        usage: "botkins devices remove <device> [--yes]",
        options: { yes: { type: "boolean", short: "y", about: "Don't ask first" } },
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the device (its name or id).");
          if (!(await confirm(context, "Unpair " + context.args[0] + "? It will have to pair again to use this host."))) return EXIT.failed;
          context.print(await context.client.call("devices.remove", context.args[0]), (gone) => "Unpaired " + gone.name + ".");
        },
      },
    },
  },
  relay: {
    summary: "Away from home: reach this host from another network, through the Botkins relay",
    details: "With the relay on, the host keeps one outgoing connection to the relay, and a phone that isn't on this network goes through it. Messages are sealed between the phone and the host, so the relay can't read them.",
    commands: {
      status: {
        summary: "Show whether the relay is on and connected",
        usage: "botkins relay status",
        async run(context) {
          context.print(await context.client.call("relay.status"), (relay) => "The relay is " + (!relay.enabled ? "off." : relay.connected ? "on and connected (" + relay.url + ")." : "on, and not connected" + (relay.problem === "taken" ? ": another computer holds this host's place. Run `botkins relay reset`." : " yet (" + relay.url + ").")));
        },
      },
      on: {
        summary: "Turn the relay on",
        usage: "botkins relay on",
        async run(context) {
          context.print(await context.client.call("relay.set", true), "The relay is on. Phones learn of it the next time they connect on this network.");
        },
      },
      off: {
        summary: "Turn the relay off",
        usage: "botkins relay off",
        async run(context) {
          context.print(await context.client.call("relay.set", false), "The relay is off. Phones reach this host on its own network only.");
        },
      },
      reset: {
        summary: "Take a new place on the relay (a new key)",
        usage: "botkins relay reset [--yes]",
        options: { yes: { type: "boolean", short: "y", about: "Don't ask first" } },
        async run(context) {
          if (!(await confirm(context, "Take a new place on the relay? Phones that are away find this host again once they have been on its network."))) return EXIT.failed;
          context.print(await context.client.call("relay.reset"), "This host has a new place on the relay.");
        },
      },
    },
  },
};
