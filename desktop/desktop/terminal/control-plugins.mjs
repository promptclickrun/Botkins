// The control socket's calls for plugins that the app's own calls do not cover as they are: a
// plugin by its name, bots by their names, and a plugin's sign-outs. The other plugin calls go by
// the app's own names ("plugins.install", "plugins.preview", …), as a phone makes them
// (desktop/terminal/control.mjs).
import { ControlError } from "./socket.mjs";

/**
 * What of a plugin runs on this computer: each hook's command, and each tool that is a local
 * program, with every word of its line, its folder and each environment value as written. A
 * plugin with any of these is shown to the person before it is installed, updated or turned on
 * (mobile/AGENTS.md: "A plugin that runs commands on the computer asks first").
 * It is made from the plugin's description and from nothing else. The description is what the
 * app starts (desktop/plugin-reading.mjs), so this list is too.
 */
export const pluginRuns = (contents) => [
  ...(contents?.hooks ?? []).map((hook) => ({ what: "hook", when: hook.event, command: hook.command, env: hook.env ?? [], ...(hook.envNotSet?.length && { envNotSet: hook.envNotSet }) })),
  ...(contents?.mcpServers ?? []).filter((server) => server.kind === "local").map((server) => ({ what: "tool", name: server.name, command: server.command, args: server.args ?? [], env: server.env ?? [], ...(server.envNotSet?.length && { envNotSet: server.envNotSet }), ...(server.cwd && { cwd: server.cwd }) })),
];
/** Where a plugin reaches on the web: each tool that is an address, with the names of the headers it is sent. */
export const pluginReaches = (contents) => (contents?.mcpServers ?? []).filter((server) => server.kind === "remote").map((server) => ({ name: server.name, url: server.url, headers: server.headers ?? [], ...(server.oauth && { signsIn: true }) }));
const LOOK_AGAIN = "This plugin is not the one that was looked at: its revision is another one now. Look at it again with `botkins plugins show`.";

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
  const view = (entry) => ({ ...entry, runs: pluginRuns(entry.contents), reaches: pluginReaches(entry.contents) });
  /** The revision that was looked at: the app takes no install and no update without one (Plugins.install), and this says so in the command line's words. */
  const looked = (options) => {
    if (typeof options?.revision !== "string" || !/^[a-f0-9]{64}$/.test(options.revision)) throw new ControlError("Give the revision of the plugin that was looked at (`botkins plugins show` prints it). A plugin is not installed or updated without it.", "BAD_ARGUMENT");
    return options;
  };
  return {
    "plugins.list": () => installed().map(view),
    "plugins.get": ([ref]) => view(plugin(ref)),
    /** A plugin as its source is now, with what of it runs here, and the revision that an install or update of exactly this names. */
    async "plugins.preview"([id]) {
      const preview = await handlers["plugins.preview"](id);
      return { ...preview, runs: pluginRuns(preview.contents), reaches: pluginReaches(preview.contents) };
    },
    // (Each answer says what of the plugin runs here, so a caller that reads JSON has it too.)
    "plugins.install": async ([id, options = {}]) => view(await handlers["plugins.install"](id, { ...looked(options), ...(options?.bots !== undefined && { bots: botIds(options.bots) }) })),
    "plugins.update": async ([ref, options = {}]) => view(await handlers["plugins.update"](plugin(ref).id, looked(options))),
    /**
     * On or off. To switch on a plugin that runs commands here, the caller names the revision
     * that was looked at, and it must be the installed one: a plugin that was updated between
     * the look and the yes is not switched on by that yes.
     */
    async "plugins.setEnabled"([ref, on, revision]) {
      const found = plugin(ref);
      if (on === true && found.enabled === false && pluginRuns(found.contents).length && revision !== found.revision) throw new ControlError(revision == null ? "This plugin runs commands on this computer. Give the revision that was looked at (`botkins plugins show` prints it)." : LOOK_AGAIN, "BAD_ARGUMENT");
      await handlers["plugins.setEnabled"](found.id, on === true);
      return view(plugin(found.id));
    },
    "plugins.configure": ([ref, values]) => handlers["plugins.configure"](plugin(ref).id, values),
    "plugins.uninstall": ([ref]) => handlers["plugins.uninstall"](plugin(ref).id),
    /** Which bots have a plugin. `revision`, when given, must be the installed one (the caller showed that plugin before a wider choice). */
    async "plugins.setBots"([ref, bots, revision]) {
      const found = plugin(ref);
      if (revision != null && revision !== found.revision) throw new ControlError(LOOK_AGAIN, "BAD_ARGUMENT");
      await handlers["plugins.setBots"](found.id, botIds(bots));
      return view(plugin(found.id));
    },
    /** Forgets the sign-ins of a plugin's tools. Signing one in needs a browser: a paired phone or the app's window does that. */
    async "plugins.signOut"([ref]) {
      const found = plugin(ref);
      // The plugin's own list of the tools that sign in, whatever state the plugin is in: one that
      // needs a setting, or has an error, can still hold a sign-in.
      const row = workspace.plugins.get(found.id);
      const servers = workspace.plugins.knownOAuthServers(row);
      const held = servers.filter((server) => workspace.plugins.oauth.status(server).signedIn);
      for (const server of servers) await handlers.signOutMcpServer(server.id);
      return { id: found.id, name: found.name, tools: servers.length, signedOut: held.length };
    },
  };
}
