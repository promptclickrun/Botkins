import { table, usage } from "../output.mjs";
import { confirm } from "./input.mjs";
import { safe } from "./tools.mjs";

const reviewed = {
  revision: { type: "string", value: "version", about: "Exact package version you reviewed" },
  yes: { type: "boolean", about: "Confirm the action for --revision without prompting" },
};
function packageName(context) {
  if (context.args.length !== 1) throw usage("Give one Pi package name.");
  return context.args[0];
}
const status = (pkg) => safe(pkg.name) + "@" + safe(pkg.version) + " · " + (pkg.enabled ? "On" : "Off");

async function change(context, action) {
  const name = packageName(context);
  const pkg =
    action === "install"
      ? await context.client.call("piPackages.preview", name)
      : (await context.client.call("piPackages.list")).find((row) => row.name === name);
  if (!pkg) throw usage("That Pi package isn't installed. Use botkins pi list.");
  if (action !== "disable") {
    const { revision, yes } = context.options;
    if (revision !== undefined && revision !== pkg.version) throw usage("The version changed. Review the package again.");
    const source = safe(name) + "@" + safe(pkg.version);
    context.stderr.write(
      (action === "install" ? "Pi will run pi install npm:" + source + ". " : "") +
        source +
        " can run code on this computer in every Botkins chat using Pi or OMP.\n",
    );
    if (yes && !revision)
      throw usage("--yes needs --revision <version>. Read the version with botkins pi show or botkins pi list.");
    if (!(await confirm(context, action === "install" ? "Install and turn on this version?" : "Turn on this version?"))) return;
  }
  const result =
    action === "install"
      ? await context.client.call("piPackages.install", name, pkg.version)
      : await context.client.call("piPackages.setEnabled", name, pkg.version, action === "enable");
  context.print(result, status);
}

export const piCommands = {
  pi: {
    summary: "Browse Pi packages and manage the ones used by Botkins",
    commands: {
      browse: {
        usage: "botkins pi browse [<search>] [--page <number>]",
        summary: "Search the pi.dev catalog",
        options: { page: { type: "string", value: "number", about: "Result page, starting at 1" } },
        async run(context) {
          if (context.args.length > 1) throw usage("Give one search in quotes.");
          const result = await context.client.call("piPackages.browse", {
            query: context.args[0] ?? "",
            page: Number(context.options.page ?? 1),
          });
          context.print(
            result,
            (view) =>
              (view.packages.length
                ? table(
                    ["PACKAGE", "TYPE", "DESCRIPTION"],
                    view.packages.map((p) => [safe(p.name), safe(p.types.join(", ")), safe(p.description)]),
                  )
                : "No Pi packages match.") + (view.nextPage ? "\nNext page: --page " + view.nextPage : ""),
          );
        },
      },
      show: {
        usage: "botkins pi show <package>",
        summary: "Show the current Pi catalog version and install command",
        async run(context) {
          const pkg = await context.client.call("piPackages.preview", packageName(context));
          context.print(pkg, (p) => "pi install npm:" + safe(p.name) + "@" + safe(p.version));
        },
      },
      list: {
        usage: "botkins pi list",
        summary: "List installed Pi packages and whether they are on",
        async run(context) {
          if (context.args.length) throw usage("botkins pi list");
          context.print(
            await context.client.call("piPackages.list"),
            (rows) => rows.map(status).join("\n") || "No Pi packages installed.",
          );
        },
      },
      install: {
        usage: "botkins pi install <package> [--revision <version>] [--yes]",
        summary: "Install and turn on a Pi package",
        asks: "--yes --revision",
        options: reviewed,
        run: (c) => change(c, "install"),
      },
      enable: {
        usage: "botkins pi enable <package> [--revision <version>] [--yes]",
        summary: "Turn on an installed Pi package",
        asks: "--yes --revision",
        options: reviewed,
        run: (c) => change(c, "enable"),
      },
      disable: {
        usage: "botkins pi disable <package>",
        summary: "Turn off an installed Pi package",
        run: (c) => change(c, "disable"),
      },
    },
  },
};
