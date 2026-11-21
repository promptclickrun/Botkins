// The wiki: the commands (cli/commands/index.mjs adds them).
// `wikiCommands` maps a top-level word to a group `{ summary, commands }`. A group whose word is there
// already (`bots`, `routines`, `providers`, …) gets these commands added to its own.
//
// The wiki is a set of Markdown pages in sections (folders). A page is named by its path, as
// `botkins wiki tree` prints it (`projects/website.md`, and `projects/website` works too), or by
// its title when only one page has it.
//
// A page's text is a person's or a bot's text. `show` and `version` print it as it is, so that a
// pipe gets the page and nothing else. Every other command makes a title safe to show.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CliError, EXIT, ago, table, usage } from "../output.mjs";
import { confirm, edit, readAll } from "./input.mjs";
import { safe, shellWord } from "./tools.mjs";

const YES = { yes: { type: "boolean", about: "Don't ask first" } };
const FILE = { file: { type: "string", value: "path", about: "Read the text from this file. \"-\" reads standard input" } };
const words = (context, what) => {
  if (!context.args.length) throw usage(what);
  return context.args.join(" ");
};
/** A file's text, or standard input for "-". */
async function textFrom(context, path) {
  if (path === "-") return readAll(context.stdin);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError("The file " + path + " can't be read: " + error.message);
  }
}
/** The page as a word of a command that Botkins prints for someone to run. */
const page = (path) => shellWord(path, "<the page>");
/** One line that says a page: its path and its title. */
const named = (item) => safe(item.path) + (item.title && item.title !== item.path ? " (" + safe(item.title) + ")" : "");

/** A yes for a change that is hard to undo. With no terminal the sentence says on standard error what the yes is for, and --yes has to give it. */
async function mayDo(context, statement, question) {
  if (!context.options.yes && (!context.stdin.isTTY || context.json)) context.stderr.write(statement + "\n");
  return confirm(context, question);
}
/** The plain tree: one row for each section and page, with its whole path, which is the name that every command takes. */
function treeText(tree) {
  const pagesIn = (path) => tree.pages.filter((item) => !item.template && item.path.startsWith(path + "/")).length;
  const rows = [
    ...tree.folders.map((path) => ({ path: path + "/", title: "(section, " + pagesIn(path) + (pagesIn(path) === 1 ? " page)" : " pages)"), key: path })),
    ...tree.pages.map((item) => ({ path: item.path, title: item.title + (item.template ? " (template)" : ""), key: item.path })),
  // A section comes before its pages: "\0" sorts before every other character of a name.
  ].sort((a, b) => { const [x, y] = [a, b].map((row) => row.key.split("/").join("\0")); return x < y ? -1 : x > y ? 1 : 0; });
  const lines = [rows.length ? table(["PATH", "TITLE"], rows.map((row) => [safe(row.path), safe(row.title)])) : "The wiki has no pages yet. Add one with `botkins wiki add`."];
  const missing = tree.suggested?.projects ?? [];
  if (missing.length) lines.push("", "Projects with no page yet: " + missing.map((project) => safe(project.name)).join(", ") + ". Make one with `botkins wiki add --for <project>`.");
  return lines.join("\n");
}

export const wikiCommands = {
  wiki: {
    summary: "Read and write the wiki: the pages that you and your bots keep",
    details: "The wiki is a set of Markdown pages in sections. A page is named by its path as `botkins wiki tree` prints it, such as projects/website.md (the .md may be left off), or by its title when only one page has it. The app keeps earlier versions of a page (`botkins wiki history`).\n\nA page's text is a person's or a bot's text. `wiki show` and `wiki version` print it as it is, so that a pipe gets the page and nothing else: a terminal that shows it can be moved or changed by what it holds. The titles that the other commands print are made safe. `--json` has every value as it is.",
    commands: {
      tree: {
        summary: "List the sections and pages",
        usage: "botkins wiki tree",
        async run(context) {
          context.print(await context.client.call("wiki.tree"), treeText);
        },
      },
      show: {
        summary: "Print one page's text, as it is",
        usage: "botkins wiki show <page>",
        details: "The text goes to standard output and nothing else does, so `botkins wiki show notes > notes.md` gets the page. A note about the page, with its revision, goes to standard error. With --json the answer is the page: its text (`content`), its revision (`base`), its links and its backlinks.",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the page (its path or title).");
          const found = await context.client.call("wiki.page", context.args[0]);
          if (context.json) return void context.print(found);
          context.stdout.write(found.content);
          context.note(named(found) + ", revision " + found.base + (found.versions ? ", " + found.versions + (found.versions === 1 ? " earlier version" : " earlier versions") : "") + ".");
        },
      },
      search: {
        summary: "Find the pages that hold all of some words",
        usage: "botkins wiki search <word>…",
        arguments: [{ name: "word", required: true, many: true }],
        details: "A page matches when every word is in its title, its path or its text. The best 30 come first.",
        async run(context) {
          const query = words(context, "Give some words to search for.");
          context.print(await context.client.call("wiki.search", query), (hits) => (hits.length ? hits.map((hit) => safe(hit.path) + "   " + safe(hit.title) + (hit.snippet ? "\n    " + safe(hit.snippet) : "")).join("\n") : "No page has all of those words."));
        },
      },
      add: {
        summary: "Add a page: from a text, from the section's template, or for a project",
        usage: "botkins wiki add [<title>…] [--folder <section>] [--file <path>] [--for <project>]",
        arguments: [{ name: "title", required: false, many: true }],
        options: {
          folder: { type: "string", value: "section", about: "The section to add the page to (its path). Left out, the page is at the top" },
          ...FILE,
          for: { type: "string", value: "project", about: "Add the page for a project (its name or id). It starts from the project's record and takes its title from the project" },
        },
        details: "The page's file name comes from its title. Without --file the page starts from the section's template. With --file <path> (or --file - for standard input) the text of the file is the page. Make the section first with `botkins wiki add-folder`.",
        async run(context) {
          const { folder, file } = context.options;
          const project = context.options.for;
          const data = {};
          if (project !== undefined) {
            if (context.args.length || folder !== undefined || file !== undefined) throw usage("A page for a project takes its title and its place from the project. Give only --for <project>.");
            data.for = project;
          } else {
            data.title = words(context, "Give the page a title, or --for <project>.");
            if (folder !== undefined) data.folder = folder;
            if (file !== undefined) data.text = await textFrom(context, file);
          }
          context.print(await context.client.call("wiki.add", data), (added) => "Added " + named(added) + ". Read it with `botkins wiki show " + page(added.path) + "`, and change it with `botkins wiki save " + page(added.path) + " --file <path>`.");
        },
      },
      "add-folder": {
        summary: "Add a section",
        usage: "botkins wiki add-folder <name>… [--in <section>]",
        arguments: [{ name: "name", required: true, many: true }],
        options: { in: { type: "string", value: "section", about: "The section to add it to (its path). Left out, it is at the top" } },
        details: "The folder's name comes from the name: lower case, with dashes.",
        async run(context) {
          const data = { name: words(context, "Give the section a name.") };
          if (context.options.in !== undefined) data.parent = context.options.in;
          context.print(await context.client.call("wiki.addFolder", data), (added) => "Added the section " + safe(added.path) + "/.");
        },
      },
      save: {
        summary: "Replace a page's text",
        usage: "botkins wiki save <page> [--file <path>] [--base <revision>]",
        options: {
          ...FILE,
          base: { type: "string", value: "revision", about: "The revision of the text that you started from (`base` in `wiki show --json`). A page that changed since is not overwritten" },
        },
        details: "The new text comes from --file <path>, or from standard input with --file -. At a terminal with no --file, your editor opens with the page. The app keeps the text that the page had as an earlier version (`botkins wiki history`), so a save can be undone with `botkins wiki restore`.\n\nWith --base <revision> the save fails when someone changed the page after you read it. The refusal says to read the page again: `botkins wiki show <page> --json` has the current revision as `base`, and `botkins wiki show <page>` prints it on standard error. The editor form always checks.",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the page (its path or title).");
          const [ref] = context.args;
          const { file } = context.options;
          let { base } = context.options;
          let content;
          if (file !== undefined) content = await textFrom(context, file);
          else {
            if (!context.stdin.isTTY || context.json) throw usage("With no terminal the new text comes from a file. Give --file <path>, or --file - to read standard input.");
            const current = await context.client.call("wiki.page", ref);
            content = edit(context, current.content, basename(current.path));
            base ??= current.base;
            if (content === current.content) return void context.print({ path: current.path, title: current.title, base: current.base, changed: false }, "Nothing changed.");
          }
          let saved;
          try {
            saved = await context.client.call("wiki.save", ref, content, ...(base !== undefined ? [base] : []));
          } catch (error) {
            if (error.code === "CHANGED") throw new CliError(error.message + " Nothing was saved. Read the page again, which gives its current revision (`botkins wiki show " + shellWord(ref, "<the page>") + " --json` has it as `base`, and the plain form prints it on standard error), put your change into the new text, and save again with that revision.", EXIT.failed, "CHANGED");
            throw error;
          }
          context.print(saved, (done) => (done.changed ? "Saved " + named(done) + ". The earlier text is kept: `botkins wiki history " + page(done.path) + "`." : named(done) + " already has that text."));
        },
      },
      move: {
        summary: "Move or rename a page or a section",
        usage: "botkins wiki move <page or section> <new path>",
        arguments: [{ name: "from", required: true }, { name: "to", required: true }],
        details: "Give the whole new path, such as projects/new-name.md for a page, or archive/old for a section. The links to the page in other pages follow it.",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the page or section, and its new path.");
          context.print(await context.client.call("wiki.move", context.args[0], context.args[1]), (moved) => (moved.from === moved.to ? safe(moved.to) + " is there already." : "Moved " + safe(moved.from) + " to " + safe(moved.to) + ". The links to it follow."));
        },
      },
      remove: {
        summary: "Remove a page, or a section with its pages",
        usage: "botkins wiki remove <page or section> [--yes]",
        arguments: [{ name: "item", required: true }],
        options: YES,
        details: "The app keeps what it removes in the `.trash` folder inside the wiki's folder, with the page's earlier versions. No command brings it back: copy it out of that folder. A page that Botkins keeps itself (the index and the log) is not removed.",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the page or section (its path or title).");
          const item = await context.client.call("wiki.find", context.args[0]);
          const what = item.kind === "section" ? "the section " + safe(item.path) + "/ and its " + item.pages + (item.pages === 1 ? " page" : " pages") : "the page " + named(item);
          if (!(await mayDo(context, "This removes " + what + ".", "Remove " + what + "?"))) return EXIT.failed;
          context.print(await context.client.call("wiki.remove", item.path), (done) => "Removed " + safe(done.removed) + ". It is kept in the wiki's `.trash` folder.");
        },
      },
      history: {
        summary: "List a page's earlier versions",
        usage: "botkins wiki history <page>",
        async run(context) {
          if (context.args.length !== 1) throw usage("Name the page (its path or title).");
          context.print(await context.client.call("wiki.history", context.args[0]), (history) =>
            history.versions.length
              ? table(["VERSION", "WHEN", "BY"], history.versions.map((entry) => [entry.id, ago(entry.time), safe(entry.by)])) + "\nRead one with `botkins wiki version " + page(history.path) + " <version>`. A version can be given by the start of its id."
              : named(history) + " has no earlier versions.",
          );
        },
      },
      version: {
        summary: "Print the text of an earlier version, as it is",
        usage: "botkins wiki version <page> <version>",
        arguments: [{ name: "page", required: true }, { name: "version", required: true }],
        details: "The version is its id from `botkins wiki history`, or the start of the id. The text goes to standard output as it is. With --json the answer has the text, the time and who changed the page.",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the page and the version.");
          const found = await context.client.call("wiki.version", context.args[0], context.args[1]);
          if (context.json) return void context.print(found);
          context.stdout.write(found.text);
          context.note(safe(found.path) + ", the version " + found.id + " (" + ago(found.time) + ").");
        },
      },
      restore: {
        summary: "Put an earlier version of a page back",
        usage: "botkins wiki restore <page> <version> [--yes]",
        arguments: [{ name: "page", required: true }, { name: "version", required: true }],
        options: YES,
        details: "The text that the page has now is kept as an earlier version, so a restore can be undone.",
        async run(context) {
          if (context.args.length !== 2) throw usage("Name the page and the version.");
          const found = await context.client.call("wiki.version", context.args[0], context.args[1]);
          const replace = "the text of " + safe(found.path) + " with the version from " + ago(found.time);
          if (!(await mayDo(context, "This replaces " + replace + ".", "Replace " + replace + "?"))) return EXIT.failed;
          context.print(await context.client.call("wiki.restore", context.args[0], found.id), (done) => "Restored " + named(done) + " to the version from " + ago(found.time) + ". The text it had before is kept too.");
        },
      },
      export: {
        summary: "Write pages to a file: a zip of Markdown files, or one web page",
        usage: "botkins wiki export [<page>] [--scope all|page|project] [--format zip|html] [--output <path>] [--list] [--yes]",
        arguments: [{ name: "page", required: false }],
        options: {
          scope: { type: "string", value: "scope", about: "all (the whole wiki, the default with no page), page (the page and the pages that link with it, the default with a page), or project (two steps of links out)" },
          format: { type: "string", value: "format", about: "zip (Markdown files, the default) or html (one web page)" },
          output: { type: "string", value: "path", about: "The file to write, or a folder to write it in. It is written on this computer" },
          list: { type: "boolean", about: "Only list the pages that the export would hold. Write nothing" },
          ...YES,
        },
        details: "The window's save dialog is not used: the command writes the file where --output says. A PDF is laid out by the app's window, so it is not offered here: export html, and print that to PDF in a browser. A file that is there already is replaced only with --yes (or when you say yes at a terminal). The export is also kept among the artifacts of the first bot, as it is for a phone.",
        async run(context) {
          const [ref, ...more] = context.args;
          if (more.length) throw usage("Name one page, or none for the whole wiki.");
          const { output, list } = context.options;
          const format = context.options.format ?? "zip";
          const scope = context.options.scope ?? (ref === undefined ? "all" : "page");
          if (!["zip", "html"].includes(format)) throw usage(format === "pdf" ? "A PDF is laid out by the app's window. Export html (--format html) and print it to PDF in a browser." : "The format is zip or html.");
          if (!["all", "page", "project"].includes(scope)) throw usage("The scope is all, page or project.");
          if ((scope === "all") !== (ref === undefined)) throw usage(scope === "all" ? "A whole-wiki export has no page. Leave the page out, or give --scope page or project." : "A " + scope + " export starts from a page. Name it, or give --scope all.");
          const options = { scope, ...(ref !== undefined && { page: ref }) };
          if (list) {
            const plan = await context.client.call("wiki.exportPlan", options);
            return void context.print(plan, (shown) => (shown.pages.length ? table(["PATH", "TITLE", "WHY"], shown.pages.map((item) => [safe(item.path), safe(item.title), item.why])) : "The wiki has no pages to export."));
          }
          if (output === undefined) throw usage("Say where to write the file with --output <path>, or list the pages with --list.");
          const file = await context.client.call("wiki.export", { ...options, format });
          // A folder that exists gets the file under the name that the app made; anything else is the file.
          let target = resolve(output);
          let existing = null;
          try {
            existing = statSync(target);
            if (existing.isDirectory()) {
              target = join(target, basename(file.name));
              existing = statSync(target, { throwIfNoEntry: false }) ?? null;
            }
          } catch {}
          if (existing && !(await mayDo(context, safe(target) + " is there already. This replaces it.", safe(target) + " is there already. Replace it?"))) return EXIT.failed;
          const bytes = file.base64 !== undefined ? Buffer.from(file.base64, "base64") : Buffer.from(file.text, "utf8");
          try {
            writeFileSync(target, bytes, { mode: 0o600, flag: existing ? "w" : "wx" });
          } catch (error) {
            throw new CliError("The file " + target + " can't be written: " + error.message);
          }
          context.print({ path: target, name: file.name, pages: file.pages, bytes: bytes.length }, (done) => "Wrote " + done.pages + (done.pages === 1 ? " page" : " pages") + " to " + safe(done.path) + " (" + done.bytes.toLocaleString("en-US") + " bytes).");
        },
      },
    },
  },
};
