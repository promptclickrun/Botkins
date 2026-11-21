// The control socket's calls for plugins that the app's own calls do not cover as they are: a
// plugin by its name, bots by their names, and a plugin's sign-outs. The other plugin calls go by
// the app's own names ("plugins.install", "plugins.preview", …), as a phone makes them
// (desktop/terminal/control.mjs).
import { ControlError } from "./socket.mjs";
import { pluginRuns } from "../plugin-reading.mjs";

// (Where the app itself needs this list too: Plugins.setEnabled in desktop/plugins.mjs. It lives with the one reading.)
export { pluginRuns };

/** Where a plugin reaches on the web: each tool that is an address, with how Botkins talks to it, each header with its value as the plugin wrote it, and the client id of its sign-in. */
export const pluginReaches = (contents) => (contents?.mcpServers ?? []).filter((server) => server.kind === "remote").map((server) => ({ name: server.name, ...(server.type && { type: server.type }), url: server.url, headers: server.headers ?? [], ...(server.oauth && { signsIn: true }), ...(server.oauthClientId && { oauthClientId: server.oauthClientId }) }));
const LOOK_AGAIN = "This plugin is not the one that was looked at: its revision is another one now. Look at it again with `botkins plugins show`.";

export function pluginsApi({ workspace, handlers, bot }) {
  /**
   * The installed plugins as they are now. What the app keeps of the last check of a copy can be
   * old (a file was changed since), so each copy is checked first. It reads no file when nothing
   * below the copy's folder changed.
   */
  const installed = () => {
    for (const row of workspace.plugins.records) {
      const was = workspace.plugins.checked.get(row.folder)?.ok;
      if (!workspace.plugins.intact(row) && was !== false) workspace.notify?.();
    }
    return workspace.plugins.list();
  };
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
  /** Who gets a plugin, by name: "all", or the names in the order of the plugin's own list (a bot that is gone is left out). */
  const botNames = (bots) => (bots === "all" ? "all" : (Array.isArray(bots) ? bots : []).flatMap((id) => workspace.state.bots.find((entry) => entry.id === id)?.name ?? []));
  const view = (entry) => ({ ...entry, botNames: botNames(entry.bots), runs: pluginRuns(entry.contents), reaches: pluginReaches(entry.contents) });
  /** A revision as a caller gives it: the string, or { revision } as a phone sends it to the app. Nothing when none was given. */
  const revisionOf = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value.revision : value ?? undefined);
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
     * the look and the yes is not switched on by that yes. The refusal here is the friendly
     * one, in the words of the command line. The app holds the rule itself too: it refuses a
     * switch-on with no revision, and compares the revision again inside its queue, which is
     * the one that holds when an update is under way.
     */
    async "plugins.setEnabled"([ref, on, third]) {
      const found = plugin(ref);
      const revision = revisionOf(third);
      if (on === true && found.enabled === false && pluginRuns(found.contents).length && revision !== found.revision) throw new ControlError(revision == null ? "This plugin runs commands on this computer. Give the revision that was looked at (`botkins plugins show` prints it)." : LOOK_AGAIN, "BAD_ARGUMENT");
      await handlers["plugins.setEnabled"](found.id, on === true, revision == null ? undefined : { revision });
      return view(plugin(found.id));
    },
    "plugins.configure": ([ref, values]) => handlers["plugins.configure"](plugin(ref).id, values),
    "plugins.uninstall": ([ref]) => handlers["plugins.uninstall"](plugin(ref).id),
    /**
     * Which bots have a plugin. A plugin that is on and runs commands here is shown first before
     * more bots get it, and the caller names the revision that was looked at. The app compares
     * it inside its queue.
     */
    async "plugins.setBots"([ref, bots, third]) {
      const found = plugin(ref);
      const revision = revisionOf(third);
      const ids = botIds(bots);
      const wider = found.bots !== "all" && (ids === "all" || ids.some((id) => !found.bots.includes(id)));
      if (found.enabled && wider && pluginRuns(found.contents).length && revision == null) throw new ControlError("This plugin is on and runs commands on this computer. Look at it first (`botkins plugins show`), then give the revision that was looked at, to give it to more bots.", "BAD_ARGUMENT");
      if (revision != null && revision !== found.revision) throw new ControlError(LOOK_AGAIN, "BAD_ARGUMENT");
      await handlers["plugins.setBots"](found.id, ids, revision == null ? undefined : { revision });
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
