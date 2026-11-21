// The control socket's calls for plugins that the app's own calls do not cover as they are: a
// plugin by its name, bots by their names, and a plugin's sign-outs. The other plugin calls go by
// the app's own names ("plugins.install", "plugins.preview", …), as a phone makes them
// (desktop/terminal/control.mjs).
import { ControlError } from "./socket.mjs";

/**
 * What of a plugin runs on this computer: each hook's command, and each tool that is a local
 * program. A plugin with any of these is shown to the person before it is installed, updated or
 * turned on (mobile/AGENTS.md: "A plugin that runs commands on the computer asks first").
 */
export const pluginRuns = (contents) => [
  ...(contents?.hooks ?? []).map((hook) => ({ what: "hook", when: hook.event, command: hook.command })),
  ...(contents?.mcpServers ?? []).filter((server) => server.kind === "local").map((server) => ({ what: "tool", name: server.name, command: server.command })),
];

export function pluginsApi({ workspace, handlers, bot }) {
  const installed = () => workspace.plugins.list();
  /** An installed plugin by its id, or by its name when exactly one has it. */
  const plugin = (ref) => {
    if (typeof ref !== "string" || !ref.trim()) throw new ControlError("Give a plugin's id or name.", "BAD_ARGUMENT");
    const wanted = ref.trim();
    const list = installed();
    const found = list.find((entry) => entry.id === wanted) ?? (() => {
      const named = list.filter((entry) => String(entry.name ?? "").toLowerCase() === wanted.toLowerCase());
      if (named.length > 1) throw new ControlError("More than one plugin is called " + wanted + ". Use its id (see `botkins plugins list`).", "AMBIGUOUS");
      return named[0];
    })();
    if (!found) throw new ControlError("No installed plugin is called " + wanted + ". See `botkins plugins list`.", "NOT_FOUND");
    return found;
  };
  /** "all", or bots by their names or ids, as the app's own call takes them: ids. */
  const botIds = (bots) => {
    if (bots === "all") return "all";
    if (!Array.isArray(bots) || !bots.length) throw new ControlError("Give `all`, or the bots.", "BAD_ARGUMENT");
    return bots.map((ref) => bot(ref).id);
  };
  const view = (entry) => ({ ...entry, runs: pluginRuns(entry.contents) });
  return {
    "plugins.list": () => installed().map(view),
    "plugins.get": ([ref]) => view(plugin(ref)),
    /** A plugin as its source is now, with what of it runs here, and the revision that an install or update of exactly this names. */
    async "plugins.preview"([id]) {
      const preview = await handlers["plugins.preview"](id);
      return { ...preview, runs: pluginRuns(preview.contents) };
    },
    // (Each answer says what of the plugin runs here, so a caller that reads JSON has it too.)
    "plugins.install": async ([id, options = {}]) => view(await handlers["plugins.install"](id, { ...options, ...(options?.bots !== undefined && { bots: botIds(options.bots) }) })),
    "plugins.update": async ([ref, options = {}]) => view(await handlers["plugins.update"](plugin(ref).id, options)),
    "plugins.setEnabled": ([ref, on]) => handlers["plugins.setEnabled"](plugin(ref).id, on === true),
    "plugins.configure": ([ref, values]) => handlers["plugins.configure"](plugin(ref).id, values),
    "plugins.uninstall": ([ref]) => handlers["plugins.uninstall"](plugin(ref).id),
    async "plugins.setBots"([ref, bots]) {
      const found = plugin(ref);
      await handlers["plugins.setBots"](found.id, botIds(bots));
      return view(plugin(found.id));
    },
    /** Forgets the sign-ins of a plugin's tools. Signing one in needs a browser: a paired phone or the app's window does that. */
    async "plugins.signOut"([ref]) {
      const found = plugin(ref);
      const ids = (found.contents?.mcpServers ?? []).map((server) => server.serverId).filter(Boolean);
      for (const id of ids) await handlers.signOutMcpServer(id);
      return { id: found.id, name: found.name, signedOut: ids.length };
    },
  };
}
