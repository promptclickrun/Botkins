// Sharing a space: the commands (cli/commands/index.mjs adds them).
// `sharingCommands` maps a top-level word to a group `{ summary, commands }`: `botkins sharing`.
//
// What these hold to (desktop/AGENTS.md):
//  - A link that opens a space for anyone is a secret that is made to be handed on. `sharing link` prints it, once, on
//    standard output, and is the only command that does. `sharing list` and `sharing show` say that a space has a link
//    and never print it. No line of the log has it.
//  - Three changes make a space visible to more people: a link, a space shared with all members, and the team's switch that
//    lets members make links. Each shows first what it opens, and to whom (on standard error, with --yes and with --json too),
//    and asks; with no terminal it needs --yes. The service's own call refuses these unless the caller says that it agreed.
//  - A name that somebody else wrote (a space, a person) is made safe before it is printed to a person. `--json` has it as it is.
//  - `seen` and `here` of the app are not here: they say that a person opened a space on a device, or looks at it now. A
//    terminal is no device. Pins and the order are here (`order`, `pin`, `unpin`).
import { CliError, EXIT, table, usage } from "../output.mjs";
import { shownText } from "../../desktop/shown-text.mjs";
import { confirm } from "./input.mjs";

const safe = shownText;
// No short form: the same as in the commands of tools.
const YES = { yes: { type: "boolean", about: "Do not ask first" } };
/** What must be seen is written to standard error whatever --json is: a caller that reads JSON still shows its person. */
const show = (context, text) => void context.stderr.write(text + "\n");

const one = (context, what) => {
  if (context.args.length !== 1) throw usage(what);
  return context.args[0];
};
const NAME_THE_SPACE = "Name the space (its name or id; see `botkins sharing list`).";

// ── How a space is shown ──
const NOTIFY = { off: "Off", daily: "Once a day", all: "Every change" };
/** The people picked for a space, as the apps write them: "Maya", "Maya and Dev", "Maya, Dev and 2 more". */
const peopleNames = (people) => {
  const names = people.map((one) => safe(one.name));
  if (!names.length) return "nobody yet";
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + " and " + names[1];
  return names[0] + ", " + names[1] + " and " + (names.length - 2) + " more";
};
const who = (s) =>
  s.access === "members" ? "Members picked: " + peopleNames(s.people ?? []) : s.access === "team" ? "All members" : s.access === "link" ? "Anyone with the link" : s.mine ? "Only you" : "Only " + (s.by?.name ? safe(s.by.name) : "its maker");
const spaceText = (s) =>
  [
    safe(s.name) + "   " + s.id,
    "Made by: " + (s.mine ? "you" : s.by?.name ? safe(s.by.name) : "the owner") + ".",
    "Who can open it: " + who(s) + ".",
    ...(s.access === "members" ? (s.people ?? []).map((one) => "  " + safe(one.name) + ": can " + (one.can === "edit" ? "change it" : "only look at it")) : []),
    ...(s.access === "team" ? ["Members can " + (s.teamCan === "edit" ? "look at it and change it." : "only look at it.")] : []),
    ...(s.access === "link"
      ? [
          "They can see everything on it. They can't change it. Members who open the space itself can " + (s.teamCan === "edit" ? "change it." : "only look at it."),
          s.linkState === "off" ? "Links are off while the relay is off." : s.linkState === "leaving" ? "An earlier link is being taken back." : "The link is not shown here. `botkins sharing link " + s.id + "` prints it.",
        ]
      : []),
    "Notify me: " + (NOTIFY[s.notify] ?? s.notify) + ". Pinned: " + (s.pinned ? "yes" : "no") + ". Panels: " + s.panels + (s.changed ? ", " + s.changed + " changed since you opened it" : "") + ".",
    ...(s.here?.length ? ["Looking at it now: " + s.here.map((one) => safe(one.name)).join(", ") + "."] : []),
  ].join("\n");

export const sharingCommands = {
  sharing: {
    summary: "Who can open a space: people, all members, or anyone with a link. Your order of spaces, and Notify me",
    details: "A space is private until its maker shares it. It is shared with people that the maker picks, with all members, or with anyone who has a link. A space is its name or its id (`botkins sharing list`). This is the owner's own view: it lists every space of this computer, the spaces of members too.\nA link opens a copy of the space for anyone, with no sign-in. It is a secret that is made to be handed on. `botkins sharing link` prints it, and no other command does. A link, a space shared with all members, and the team's switch for links each make a space visible to more people: each shows what it opens, and to whom, and asks first; with no terminal it needs --yes.",
    commands: {
      list: {
        summary: "List the spaces, in your order, with who can open each",
        usage: "botkins sharing list",
        async run(context) {
          context.print(await context.client.call("sharing.list"), (list) => (list.length ? table(["NAME", "WHO CAN OPEN", "NOTIFY", "PINNED", "ID"], list.map((s) => [safe(s.name), who(s), NOTIFY[s.notify] ?? s.notify, s.pinned ? "yes" : "", s.id])) : "No spaces yet."));
        },
      },
      show: {
        summary: "Show one space: who can open it, whether it has a link, and your Notify me",
        usage: "botkins sharing show <space>",
        details: "It says whether the space has a link, and does not print the link. `botkins sharing link <space>` prints it.",
        async run(context) {
          context.print(await context.client.call("sharing.get", one(context, NAME_THE_SPACE)), spaceText);
        },
      },
      set: {
        summary: "Share a space with people you pick or with all members, or make it private",
        usage: "botkins sharing set <space> (--private | --view <person>… [--edit <person>…] | --all-members [--can <view|edit>]) [--yes]",
        options: {
          private: { type: "boolean", about: "Only its maker can open it" },
          view: { type: "string", multiple: true, value: "person", about: "A member who can look at it (name or id). Give it for each person" },
          edit: { type: "string", multiple: true, value: "person", about: "A member who can look at it and change it (name or id). Give it for each person" },
          "all-members": { type: "boolean", about: "Every member can open it. This needs a yes" },
          can: { type: "string", value: "view|edit", about: "With --all-members: what members can do (view, or edit). Without it a space keeps what it had, and a new one is view" },
          ...YES,
        },
        arguments: [{ name: "space", required: true }],
        details: "Give one of --private, --view and --edit, or --all-members. With --view and --edit you name every person who can open the space: the list replaces the one it had. A person is a member's name or id, and the owner can be named too. The maker needs no mention. A member whose role cannot open spaces is refused by the app. A space that was shared by link and gets one of these levels loses its link: the link stops working.\n--all-members shows the space and who it opens to first, and asks; with no terminal it needs --yes. The block is printed on standard error with --yes and with --json too. The other levels ask nothing. To make a link, use `botkins sharing link`.",
        async run(context) {
          const ref = one(context, NAME_THE_SPACE);
          const o = context.options;
          const picked = [o.private, o["all-members"], o.view?.length || o.edit?.length].filter(Boolean).length;
          if (picked !== 1) throw usage("Give one of --private, --view or --edit, or --all-members.");
          if (o.can !== undefined && !o["all-members"]) throw usage("--can goes with --all-members. For people, use --view and --edit.");
          const found = await context.client.call("sharing.get", ref);
          const options = {};
          if (o.private) options.access = "private";
          else if (o["all-members"]) {
            options.access = "team";
            if (o.can !== undefined) options.can = o.can;
            const can = o.can ?? found.teamCan ?? "view";
            show(context, ["This shares the space " + safe(found.name) + " with all members.", "Now: " + who(found) + ".", "Every member whose role can open spaces will be able to open it, and " + (can === "edit" ? "look at it and change it." : "look at it. They will not be able to change it.")].join("\n"));
            if (!(await confirm(context, "Share the space with all members?"))) return EXIT.failed;
            options.agreed = true;
          } else {
            options.access = "members";
            const people = [...(o.view ?? []).map((person) => ({ person, can: "view" })), ...(o.edit ?? []).map((person) => ({ person, can: "edit" }))];
            options.people = people;
          }
          const done = await context.client.call("sharing.set", found.id, options);
          context.print(done, (s) => "The space " + safe(s.name) + " is shared like this now. Who can open it: " + who(s) + "." + (found.access === "link" ? " Its link is taken back: it stops working." : ""));
        },
      },
      link: {
        summary: "Make a link that opens a copy of a space for anyone, and print it",
        usage: "botkins sharing link <space> [--new | --off] [--yes]",
        options: {
          new: { type: "boolean", about: "Make another link: the old one stops working" },
          off: { type: "boolean", about: "Take the link away: the space becomes private" },
          ...YES,
        },
        arguments: [{ name: "space", required: true }],
        details: "Anyone with the link can see everything on the space, with no sign-in. They can't change it. The link is a secret that is made to be handed on: it is printed on standard output, and nothing else is, so `botkins sharing link <space> | pbcopy` keeps it out of the screen. A copy of the space is put on the relay and kept up to date. It needs the relay to be on (`botkins relay on`).\nMaking a link, and --new, show what they open first and ask; with no terminal they need --yes. The block is printed on standard error with --yes and with --json too. A space that has a link already prints the one it has and changes nothing. --off makes the space private and the link stops working; it asks nothing. The log names the space, never the link. Run it with --json to get { id, name, link, made, new }.",
        async run(context) {
          const ref = one(context, NAME_THE_SPACE);
          const o = context.options;
          if (o.new && o.off) throw usage("Give --new or --off, not both.");
          const found = await context.client.call("sharing.get", ref);
          if (o.off) {
            if (found.access !== "link") throw new CliError("The space " + safe(found.name) + " is not shared by link. Who can open it: " + who(found) + ".");
            const done = await context.client.call("sharing.set", found.id, { access: "private" });
            context.print(done, (s) => "The space " + safe(s.name) + " is private now. Its link is taken back: it stops working.");
            return;
          }
          const making = found.access !== "link";
          const another = !making && o.new === true;
          const options = {};
          if (making || another) {
            show(
              context,
              [
                (making ? "This makes a link for the space " : "This makes a new link for the space ") + safe(found.name) + "." + (making ? "" : " The old link stops working."),
                "Anyone with the link can see everything on this space. They can't change it.",
                "They need no sign-in, and they do not need to be on your team. Everything a panel says is public: its text, its page and its data. Notes and chats are not. A copy of the space is put on the relay and kept up to date.",
                "The link is a secret that is made to be handed on. Give it only to people who may see this space. To take it back: `botkins sharing link " + found.id + " --off`.",
              ].join("\n"),
            );
            if (!(await confirm(context, making ? "Make the link?" : "Make a new link?"))) return EXIT.failed;
            options.agreed = true;
          }
          if (another) options.new = true;
          const done = await context.client.call("sharing.link", found.id, options);
          context.print(done, (answer) => answer.link);
        },
      },
      links: {
        summary: "Turn the team's switch \"Members may share by link\" on or off",
        usage: "botkins sharing links <on|off> [--yes]",
        options: YES,
        arguments: [{ name: "state", required: true }],
        details: "On: a member whose role can change spaces can make a link for a space that the member made. Anyone with such a link can see everything on that space, with no sign-in. On shows this first and asks; with no terminal it needs --yes. The block is printed on standard error with --yes and with --json too. Off asks nothing: members cannot make new links, and the links that exist stay as they are. Take one away with `botkins sharing link <space> --off`. The owner can make links with the switch off. This copy of Botkins cannot say what the switch is now: it only sets it.",
        async run(context) {
          // (The link's answer for the team has no field for this switch, so the command cannot read it.)
          const only = "This command can only set the switch, with `on` or `off`. It cannot say what the switch is now.";
          const state = one(context, only);
          if (state !== "on" && state !== "off") throw usage(only);
          const options = {};
          if (state === "on") {
            show(context, ["This lets members share by link.", "A member whose role can change spaces will be able to make a link for a space that the member made, with no question to you. Anyone with such a link can see everything on that space. They can't change it."].join("\n"));
            if (!(await confirm(context, "Let members share by link?"))) return EXIT.failed;
            options.agreed = true;
          }
          const done = await context.client.call("sharing.setLinks", state === "on", options);
          context.print(done, (answer) => (answer.on ? "Members may share by link now." : "Members may not make new links now. The links that exist stay as they are."));
        },
      },
      order: {
        summary: "Put spaces first, in the order you give. The rest follow",
        usage: "botkins sharing order <space>…",
        arguments: [{ name: "space", required: true, many: true }],
        details: "This is your own order, as the Share list of the window and the phone shows it: pinned spaces first, then the others. The spaces you name come first, in your order; the spaces you leave out follow in the order they had. Pins stay as they are and follow the new order.",
        async run(context) {
          if (!context.args.length) throw usage(NAME_THE_SPACE);
          context.print(await context.client.call("sharing.order", context.args), (list) => table(["NAME", "PINNED", "ID"], list.map((s) => [safe(s.name), s.pinned ? "yes" : "", s.id])));
        },
      },
      pin: {
        summary: "Pin a space, after the ones that are pinned",
        usage: "botkins sharing pin <space>",
        async run(context) {
          context.print(await context.client.call("sharing.pin", one(context, NAME_THE_SPACE), true), (s) => "Pinned the space " + safe(s.name) + ".");
        },
      },
      unpin: {
        summary: "Take a space's pin away",
        usage: "botkins sharing unpin <space>",
        async run(context) {
          context.print(await context.client.call("sharing.pin", one(context, NAME_THE_SPACE), false), (s) => "The space " + safe(s.name) + " is not pinned now.");
        },
      },
      notify: {
        summary: "Say when you are told of a change in a space, or show it",
        usage: "botkins sharing notify <space> [<off|daily|all>]",
        arguments: [{ name: "space", required: true }, { name: "when", required: false }],
        details: "off: never. daily: once a day, in the morning. all: at every change (at most once in 10 minutes for each space). Without a choice it shows the one the space has. It is your own choice, as the owner. Nothing is sent about your own change, or while you look at the space in the window.",
        async run(context) {
          if (context.args.length < 1 || context.args.length > 2) throw usage(NAME_THE_SPACE);
          const [ref, when] = context.args;
          if (when === undefined) {
            context.print(await context.client.call("sharing.get", ref), (s) => "Notify me for " + safe(s.name) + ": " + (NOTIFY[s.notify] ?? s.notify) + ".");
            return;
          }
          if (!["off", "daily", "all"].includes(when)) throw usage("Say off, daily or all.");
          context.print(await context.client.call("sharing.notify", ref, when), (s) => "Notify me for " + safe(s.name) + " is now: " + (NOTIFY[s.notify] ?? s.notify) + ".");
        },
      },
    },
  },
};
