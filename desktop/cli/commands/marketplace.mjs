// `botkins marketplace`: the skills, packs and format version 3 templates a marketplace lists in
// format version 2 (desktop/catalog-v2.mjs). Install shows the same review as the window and asks at a
// terminal. With no terminal it is refused unless given `--yes --revision <commit>`, the catalog
// commit that was looked at, as `botkins plugins install` takes a plugin's revision.
import { CliError, EXIT, table, usage } from "../output.mjs";
import { confirm } from "./input.mjs";
import { safe, shellWord } from "./tools.mjs";

const call = (context, method, ...args) => context.client.call(method, ...args);
const show = (context, text) => void context.stderr.write(text + "\n");
const one = (context, what) => {
  if (context.args.length !== 1) throw usage(what);
  return context.args[0];
};
const indent = (text, pad = "    ") => String(text).split("\n").map((line) => pad + safe(line)).join("\n");
const CADENCE_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const cadence = (c) => (c.kind === "weekly" ? "weekly on " + c.days.map((d) => CADENCE_DAYS[d]).join(", ") : c.kind) + " at " + c.time;

/** Which kind a listing id is, read from the catalog: skill, pack or template. */
async function kindOf(context, id) {
  const all = await call(context, "market.catalog");
  for (const kind of ["skills", "packs", "templates"]) if (all[kind].some((item) => item.id === id)) return kind.slice(0, -1);
  throw new CliError("No skill, pack or template has the id " + safe(id) + ". See `botkins marketplace list`.", EXIT.failed, "NOT_FOUND");
}

const skillLines = (review) => [
  "  " + safe(review.name) + " " + safe(review.source.version) + "   license " + safe(review.source.license) + "   " + review.files.length + " files, " + review.size + " bytes",
  ...(review.executable.length ? ["      executable files: " + review.executable.map(safe).join(", ")] : []),
  ...(review.listing.requires.tools.length ? ["      needs: " + review.listing.requires.tools.join(", ")] : []),
  ...(review.listing.requires.optional.length ? ["      uses when it can: " + review.listing.requires.optional.join(", ")] : []),
  ...review.listing.warnings.map((w) => "      warning: " + safe(w)),
  ...(review.update ? ["      update from " + safe(review.update.from) + ": " + ["added", "changed", "removed"].map((k) => review.update[k].length + " " + k).join(", ")] : []),
];
const pluginLines = (plugin) => [
  "  " + safe(plugin.name) + (plugin.version ? " " + safe(plugin.version) : "") + (plugin.installed ? (plugin.installed.matchesRevision === false ? "   (installed, different revision)" : "   (installed)") : ""),
  ...((plugin.contents?.mcpServers ?? []).map((s) => "      tool " + safe(s.name) + ": " + safe(s.kind === "remote" ? s.url : [s.command, ...(s.args ?? [])].join(" ")))),
  ...((plugin.contents?.hooks ?? []).map((h) => "      hook at " + safe(h.event ?? h.when) + ": " + safe(h.command))),
  ...(plugin.installed?.matchesRevision === false ? ["      warning: installed at a different revision; update it with `botkins plugins update` first."] : []),
];

function reviewText(kind, review) {
  if (kind === "skill") return ["Skill from " + safe(review.listing.marketplaceName) + " at " + review.listing.commit, ...skillLines(review), "", indent(review.text)].join("\n");
  if (kind === "pack") return ["Pack " + safe(review.name) + " " + safe(review.version) + " from " + safe(review.marketplaceName) + " at " + review.commit, safe(review.summary), "Skills:", ...review.skills.flatMap(skillLines), ...(review.plugins.length ? ["Plugins:", ...review.plugins.flatMap(pluginLines)] : [])].join("\n");
  return [
    "Template " + safe(review.name) + " " + safe(review.version) + " from " + safe(review.marketplaceName) + " at " + review.commit,
    "Role: " + safe(review.role),
    ...(review.summary ? ["About: " + safe(review.summary)] : []),
    "Instructions:", indent(review.instructions),
    ...(review.skills.length ? ["Catalog skills:", ...review.skills.flatMap(skillLines)] : []),
    ...(review.privateSkills.length ? ["Private skills:", ...review.privateSkills.flatMap((s) => ["  " + safe(s.name) + ": " + safe(s.description), indent(s.instructions, "      ")])] : []),
    ...(review.plugins.length ? ["Plugins:", ...review.plugins.flatMap(pluginLines)] : []),
    ...(review.routines.length ? ["Routines:", ...review.routines.flatMap((r) => ["  " + safe(r.name) + ": " + cadence(r.cadence) + (r.active ? ", starts on" : ", starts paused"), indent(r.instructions, "      ")])] : []),
  ].join("\n");
}

const preview = (kind) => ({ skill: "market.skillPreview", pack: "market.packPreview", template: "market.templatePreview" })[kind];

export const marketplaceCommands = {
  marketplace: {
    summary: "Skills, packs and bot templates from the marketplaces (format version 2)",
    details: "Lists what each marketplace lists under skills, packs and templates, and installs one after showing all of it. Plugins stay under `botkins plugins`, and version 1 and 2 templates under `botkins templates`.",
    commands: {
      list: {
        summary: "List the skills, packs and templates",
        usage: "botkins marketplace list",
        async run(context) {
          context.print(await call(context, "market.catalog"), (all) => {
            const rows = [
              ...all.skills.map((s) => ["skill", s.id, s.version, s.installed ? (s.update ? "update" : "installed") : "", safe(s.summary).slice(0, 80)]),
              ...all.packs.map((p) => ["pack", p.id, p.version, "", safe(p.summary).slice(0, 80)]),
              ...all.templates.map((t) => ["template", t.id, t.version ?? "", "", safe(t.summary || t.role).slice(0, 80)]),
            ];
            return rows.length ? table(["KIND", "ID", "VERSION", "STATE", "SUMMARY"], rows) : "No marketplace lists skills, packs or templates.";
          });
        },
      },
      show: {
        summary: "Show everything a skill, pack or template installs",
        usage: "botkins marketplace show <id>",
        async run(context) {
          const id = one(context, "Name a listing by its id from `botkins marketplace list`.");
          const kind = await kindOf(context, id);
          context.print(await call(context, preview(kind), id), (review) => reviewText(kind, review) + "\nCatalog commit: " + (review.commit ?? review.listing?.commit));
        },
      },
      install: {
        summary: "Install a skill or pack, or make a bot from a template",
        usage: "botkins marketplace install <id> [--bot <bot>]… [--routine <name>]… [--no-routines] [--revision <commit>] [--yes]",
        options: {
          bot: { type: "string", multiple: true, value: "bot", about: "A bot that gets the skill or pack, by id. Give it again for each one (every bot without it)" },
          routine: { type: "string", multiple: true, value: "name", about: "For a template: a routine to keep (all of them without it)" },
          "no-routines": { type: "boolean", about: "For a template: keep none of its routines" },
          revision: { type: "string", value: "commit", about: "The catalog commit that you looked at (`botkins marketplace show` prints it)" },
          yes: { type: "boolean", about: "Don't ask first. Needs --revision" },
        },
        asks: "--yes --revision",
        details: "Shows the whole review first and asks. With no terminal, or with --json, it needs --yes with --revision, the catalog commit that `botkins marketplace show` prints; it is refused when the catalog has moved on since.",
        async run(context) {
          const id = one(context, "Name a listing by its id from `botkins marketplace list`.");
          const o = context.options;
          const kind = await kindOf(context, id);
          const review = await call(context, preview(kind), id);
          const commit = review.commit ?? review.listing.commit;
          show(context, reviewText(kind, review));
          if (o.yes) {
            if (o.revision === undefined) throw usage("--yes needs --revision: the catalog commit that you looked at. `botkins marketplace show -- " + shellWord(id, "<its id>") + "` prints it.");
          } else if (!context.stdin.isTTY || context.json) {
            throw usage("Installing from a marketplace needs a person's yes. Look at it with `botkins marketplace show -- " + shellWord(id, "<its id>") + "`, then give `--yes --revision=<its catalog commit>`.");
          } else if (!(await confirm(context, kind === "template" ? "Make this bot?" : "Install it?"))) return EXIT.failed;
          if (o.revision !== undefined && o.revision !== commit) throw new CliError("The catalog changed after you looked at it. Look at it again.");
          const bots = o.bot?.length ? o.bot : undefined;
          if (kind === "skill") return void context.print(await call(context, "market.skillInstall", review.token, { ...(bots && { bots }) }), (r) => (r.conflicts?.length ? "A skill with this name is installed already: " + r.conflicts.map(safe).join(", ") : "Installed " + r.added.map(safe).join(", ") + "."));
          if (kind === "pack") return void context.print(await call(context, "market.packInstall", review.token, { commit, ...(bots && { bots }) }), (r) => (r.conflicts?.length ? "A skill with this name is installed already: " + r.conflicts.map(safe).join(", ") : "Installed " + [...r.added, ...r.plugins].map(safe).join(", ") + "."));
          const routines = o["no-routines"] ? [] : o.routine?.length ? o.routine : undefined;
          context.print(await call(context, "market.templateInstall", review.token, { commit, ...(routines && { routines }) }), (r) => "Made the bot " + safe(review.name) + " (" + r.botId + ").");
        },
      },
    },
  },
};
