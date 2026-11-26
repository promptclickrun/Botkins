// The control socket's calls for tools (MCP servers), skills, and a bot's tools, skills and
// access: the part of the command line that lets a person, or an agent whose person asked,
// change what a bot can reach. Each is a thin wrapper over the app's own call
// (`runtime.handlers`), which checks what it is given.
//
// "Tool" is the app's and the phone's word for a thing a bot can call. One that a person adds is
// an MCP server: a program this computer starts (`command`), or a web address (`url`).
//
// A secret (an environment value, a header's value, a client secret) goes in through these calls
// and never comes out: every answer names the keys that have a value, not the values.
import { parseServers } from "../integrations.mjs";
import { botSkillRows } from "../link/bot-skills.mjs";
import { cleanScriptCommand, scriptRevision, whatRuns } from "../script-commands.mjs";
import { thingForLog } from "./coverage.mjs";
import { ControlError } from "./socket.mjs";

const text = (value, max, what) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ControlError("Give " + what + ".", "BAD_ARGUMENT");
  return value.trim();
};
const names = (value, what) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new ControlError(what + " are a list of names.", "BAD_ARGUMENT");
  return value.map((item) => item.trim());
};
/** One of a list by its id, or by its name when exactly one has it. */
function pick(list, ref, what, see) {
  const wanted = text(ref, 200, "a " + what + "'s name or id");
  const byId = list.find((entry) => entry.id === wanted);
  if (byId) return byId;
  const named = list.filter((entry) => String(entry.name ?? "").toLowerCase() === wanted.toLowerCase());
  if (named.length > 1) throw new ControlError("More than one " + what + " is called " + wanted + ". Use its id" + (see ? " (see `" + see + "`)" : "") + ".", "AMBIGUOUS");
  if (!named.length) throw new ControlError("There is no " + what + " called " + wanted + "." + (see ? " See `" + see + "`." : ""), "NOT_FOUND");
  return named[0];
}

/** What a tool starts on this computer, as one line, or null for a web address. */
export const runs = (server) => (server.type === "stdio" || (!server.type && !server.url) || server.type === "local" ? [server.command, ...(server.args ?? [])] : null);

/** The mark `{ agreed: true }` as the last argument: a call that loses something refuses without it. */
export const needsYesToLose = (options, what, command) => {
  if (options?.agreed !== true) throw new ControlError(what + " needs a yes, because it cannot be got back. Show that to the person, and give `{ \"agreed\": true }` as the last argument (on the command line, `" + command + " --yes`).", "NEEDS_YES");
};
/** Does this input of the app's own form start a program on this computer? */
const startsProgram = (input) => !!input && typeof input === "object" && typeof input.command === "string" && runs(input) !== null;
/**
 * A change that starts a program is shown to the person first. The socket cannot show anything, so it takes the
 * caller's word: `agreed: true` says that the caller showed the line and got a yes (the command line does: `--yes`,
 * or the question at a terminal). Without it the call is refused.
 */
const needAgreed = (options, what) => {
  if (options?.agreed !== true) throw new ControlError(what + " starts a program on this computer, as the user that runs Botkins. Show the person the line that will run, and give `agreed: true` (on the command line, `--yes`).", "NEEDS_YES");
};

/**
 * Starts the sign-in of a tool on the web through a browser on any device, for a tool of the list
 * the person added (Integrations) and for a tool of a plugin (Plugins): both sign in, take the
 * pasted address and end a sign-in by the tool's id. The answer is { session, minutes, id, name }.
 * With `options.hold` a second start for the same tool gives the same sign-in again, with `already: true`.
 * Nothing of it, the page or the address, reaches the log (desktop/terminal/coverage.mjs). The one line
 * the log has is written here, when the sign-in is done: `call` and the tool's name, "signed in" or
 * "signed in again". A sign-in that is started, cancelled, turned away or runs out of time leaves none.
 * The name is the service's own record of the tool, never a word the caller typed.
 */
export const startToolSignIn = async (signIns, owner, { id, name }, options, { call, log } = {}) => {
  // `hold`: step 1 of the two steps (`--start`): nobody follows the sign-in, and it is not taken over.
  const done = ({ again }) => {
    const thing = thingForLog(name);
    log?.("Changed from the command line: " + call + (thing ? " " + thing : "") + " (signed in" + (again ? " again" : "") + ")");
  };
  const started = await signIns.startTool({ id, name }, { signIn: (opened) => owner.signIn(id, opened), answer: (address) => owner.answerSignIn(id, address), cancel: () => owner.cancelSignIn(id) }, { hold: options?.hold === true, done });
  return { ...started, id, name };
};
/**
 * @param workspace  The app's workspace.
 * @param handlers   `runtime.handlers`.
 * @param bot        (ref) → a bot, by id or by a name only one bot has (desktop/terminal/control.mjs).
 * @param signIns    The service's sign-in sessions (desktop/terminal/signin.mjs).
 * @param log        (line) → writes a line to the service's log, for a sign-in that is done.
 */
export function toolsApi({ workspace, handlers, bot, signIns, log }) {
  const state = () => workspace.state;
  const servers = () => workspace.integrations.publicServers();
  const tool = (ref) => pick(servers(), ref, "tool", "botkins tools list");
  /** A tool as the command line shows it. `env` and `headers` are the names that have a value. */
  const toolView = (server) => ({
    id: server.id,
    name: server.name,
    // (One rule says what starts a program, for what is shown and for what is asked.)
    kind: runs(server) ? "command" : "web",
    type: server.type,
    enabled: server.enabled !== false,
    ...(runs(server) ? { command: server.command, args: server.args ?? [], ...(server.cwd && { cwd: server.cwd }), runs: runs(server) } : { url: server.url }),
    env: server.env ?? [],
    headers: server.headers ?? [],
    ...(server.needs?.length && { needs: server.needs }),
    ...(server.auth && { auth: server.auth }),
  });
  /** A stored tool as the app's own save takes it again: every secret kept (`null`), nothing read. */
  const asInput = (id) => {
    const raw = (state().mcpServers ?? []).find((entry) => entry.id === id);
    const kept = (map) => Object.fromEntries(Object.keys(map ?? {}).map((key) => [key, null]));
    return raw.type === "stdio"
      ? { id, name: raw.name, type: "stdio", enabled: raw.enabled, command: raw.command, args: [...(raw.args ?? [])], env: kept(raw.env), ...(raw.cwd && { cwd: raw.cwd }) }
      : { id, name: raw.name, type: raw.type, enabled: raw.enabled, url: raw.url, headers: kept(raw.headers), ...(raw.oauth && { oauth: { clientId: raw.oauth.clientId, scope: raw.oauth.scope, clientSecret: raw.oauth.clientSecret ? null : undefined } }) };
  };
  const skillList = () => handlers.skills();
  /** What a file of tools holds, before anything is saved. */
  const importPreview = (json) => {
    if (typeof json !== "string") throw new ControlError("Give the file's JSON as text.", "BAD_ARGUMENT");
    return parseServers(json.slice(0, 1_000_000)).map((server) => ({
      name: server.name,
      kind: runs(server) ? "command" : "web",
      ...(runs(server) ? { runs: runs(server), ...(server.cwd && { cwd: server.cwd }) } : { url: server.url }),
      env: Object.keys(server.env ?? {}),
      headers: Object.keys(server.headers ?? {}),
      exists: servers().some((existing) => existing.name.toLowerCase() === server.name.toLowerCase()),
    }));
  };
  const skill = (ref, all = skillList().skills, command = "botkins skills list") => {
    const wanted = text(ref, 200, "a skill's name");
    // Skills of linked folders can differ only by capitals. The exact name wins; otherwise one name must match one skill.
    const exact = all.filter((entry) => entry.name === wanted);
    const named = exact.length ? exact : all.filter((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
    if (named.length > 1) throw new ControlError("More than one skill is called " + wanted + ". Give its name exactly as `" + command + "` shows it, or remove one of the two.", "AMBIGUOUS");
    if (!named.length) throw new ControlError("There is no skill called " + wanted + ". See `" + command + "`.", "NOT_FOUND");
    return named[0];
  };
  /** Which workspace tools and skills and which bundled skills a bot has on. */
  const botTools = (entry) => {
    const all = servers();
    return {
      id: entry.id,
      name: entry.name,
      tools: all.map((server) => ({ id: server.id, name: server.name, on: !(entry.mcpOff ?? []).includes(server.id), enabled: server.enabled !== false })),
      skills: botSkillRows(skillList().skills, entry).map((item) => ({
        name: item.name, on: !(entry.skillsOff ?? []).includes(item.name), enabled: item.enabled, ...(!item.shared && { bundled: true }),
      })),
    };
  };
  const projects = () => state().projects ?? [];
  const access = (entry) => {
    const own = entry.access ?? {};
    return {
      id: entry.id,
      name: entry.name,
      all: own.all === true,
      projects: (own.projects ?? []).map((id) => ({ id, name: projects().find((project) => project.id === id)?.name ?? id })),
      // One switch in Preferences gives every bot every project, whatever its own list says.
      everyBot: state().settings?.access?.allBots !== false,
    };
  };

  return {
    // ── Tools (MCP servers) ──
    "tools.list": () => servers().map(toolView),
    "tools.get": ([ref]) => toolView(tool(ref)),
    /**
     * A new tool. `data` is the app's own form: { name, command, args?, cwd?, env? } or { name, url, type?, headers?, oauth? }.
     * A tool that is a program needs `options.agreed: true`.
     */
    async "tools.add"([data = {}, options]) {
      if (data?.id !== undefined) throw new ControlError("A new tool has no id. Use `tools.edit` to change one.", "BAD_ARGUMENT");
      if (startsProgram(data)) needAgreed(options, "A tool with a command");
      return toolView(tool(await handlers.saveMcpServer(data)));
    },
    /**
     * Changes a tool. `patch` holds only what changes. `env` and `headers` are { NAME: value } to
     * set a value and { NAME: false } to take a name away; every other stored value is kept.
     * A change to what a program starts (its line, its folder, an environment value) needs `options.agreed: true`.
     */
    async "tools.edit"([ref, patch = {}, options]) {
      const found = tool(ref);
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ControlError("Give what to change.", "BAD_ARGUMENT");
      const input = asInput(found.id);
      const merge = (kept, changes, what) => {
        if (changes === undefined) return kept;
        if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new ControlError("Give " + what + " as names with their values.", "BAD_ARGUMENT");
        const out = { ...kept };
        for (const [name, value] of Object.entries(changes)) {
          if (value === false) delete out[name];
          else out[name] = value;
        }
        return out;
      };
      for (const key of ["name", "command", "args", "cwd", "url", "type"]) if (patch[key] !== undefined) input[key] = patch[key];
      if (input.type === "stdio") input.env = merge(input.env, patch.env, "environment values");
      else input.headers = merge(input.headers, patch.headers, "headers");
      if (patch.oauth !== undefined) input.oauth = patch.oauth === null ? null : { ...(input.oauth ?? {}), ...patch.oauth };
      if (startsProgram(input)) {
        const before = toolView(found);
        const same = before.kind === "command" && JSON.stringify([input.command, ...(input.args ?? [])]) === JSON.stringify(before.runs) && (input.cwd ?? "") === (before.cwd ?? "") && !Object.keys(patch.env ?? {}).length;
        if (!same) needAgreed(options, "This change to \"" + found.name + "\"");
      }
      await handlers.saveMcpServer(input);
      return toolView(tool(found.id));
    },
    async "tools.remove"([ref, options]) {
      const found = tool(ref);
      needsYesToLose(options, "Removing the tool " + found.name + ", which deletes its stored values and its sign-in,", "botkins tools remove");
      await handlers.removeMcpServer(found.id);
      return { removed: found.id, name: found.name };
    },
    /** Turning on a tool that is a program needs `options.agreed: true`. */
    async "tools.enable"([ref, on, options]) {
      const found = tool(ref);
      if (on === true && found.enabled === false && runs(found)) needAgreed(options, "Turning on \"" + found.name + "\"");
      await handlers.setMcpServerEnabled(found.id, on === true);
      return toolView(tool(found.id));
    },
    /** Connects the tool once and lists what it offers. A tool that is a command is started for it; one that is switched off needs `options.agreed: true`. */
    async "tools.test"([ref, options]) {
      const found = tool(ref);
      if (found.enabled === false && runs(found)) needAgreed(options, "Testing \"" + found.name + "\"");
      return { id: found.id, name: found.name, ...(await handlers.testMcpServer(found.id)) };
    },
    /** What a file of tools holds, before anything is saved: each one's name, and what it would start or reach. No value is answered. */
    "tools.import.preview": ([json]) => importPreview(json),
    /** Adds the tools of a file; one that is a program and is new needs `options.agreed: true`. The answer names what was added and left out, and `starts`: each added tool that is a program, with its line, its folder and the names of its environment values. */
    async "tools.import"([json, options]) {
      const listed = importPreview(json);
      if (listed.some((entry) => entry.kind === "command" && !entry.exists)) needAgreed(options, "This file");
      const result = await handlers.importMcpServers(json);
      return { ...result, starts: listed.filter((entry) => entry.kind === "command" && result.added.includes(entry.name)).map(({ name, runs: line, cwd, env }) => ({ name, runs: line, ...(cwd && { cwd }), env })) };
    },
    async "tools.signOut"([ref, options]) {
      const found = tool(ref);
      needsYesToLose(options, "Signing out of the tool " + found.name + ", which forgets its sign-in,", "botkins tools sign-out");
      await handlers.signOutMcpServer(found.id);
      return toolView(tool(found.id));
    },
    /**
     * Starts a tool's sign-in through a browser on any device (desktop/terminal/signin.mjs). The
     * answer is { session, id, name, minutes }; the session's events say the page to open, and it then
     * waits for the address the browser was sent back to. Nothing of that reaches the log.
     */
    async "tools.signIn"([ref, options]) {
      const found = tool(ref);
      if (runs(found)) throw new ControlError(found.name + " is a program on this computer. It signs in with its environment values (`botkins tools edit`).", "BAD_ARGUMENT");
      return startToolSignIn(signIns, workspace.integrations, found, options, { call: "tools.signIn", log });
    },
    // The session is read, typed to and ended by its id, for a tool of the list and for a tool of a plugin alike.
    "tools.signIn.read": ([session, after], { signal } = {}) => signIns.read(String(session), { after: Number(after) || 0, signal }),
    "tools.signIn.input": ([session, line]) => void signIns.input(String(session), line),
    "tools.signIn.cancel": ([session]) => signIns.cancel(String(session)),
    /** The second step with no terminal: the address the browser was sent back to. Waits for the end of the sign-in. */
    async "tools.signIn.answer"([ref, address]) {
      return signIns.answerTool(tool(ref).id, address);
    },
    /** Ends a tool's open sign-in, whoever started it. */
    async "tools.signIn.end"([ref]) {
      const found = tool(ref);
      return { id: found.id, name: found.name, ...(await signIns.cancelTool(found.id)) };
    },
    /** Forgets the tool approvals a person gave "for this chat", in one chat or in all of them. */
    "tools.forgetApprovals": ([chatId]) => void handlers.clearApprovals(chatId === undefined || chatId === null ? undefined : text(chatId, 200, "a chat's id")),

    // ── Skills ──
    "skills.list": () => skillList(),
    "skills.get": ([ref]) => {
      const found = skill(ref);
      // Only a skill that Botkins keeps can be read whole; one from a linked folder is read in its folder.
      // A script command is read with its script: the terminal is the owner's.
      return found.editable ? { ...found, ...handlers.readSkill(found.name), ...(found.command === "script" && { script: handlers["skills.readScript"](found.name).script }) } : found;
    },
    /**
     * A script command as it will be saved, and the revision that a yes for it names: { name, description, script, existing, revision }.
     * Nothing is saved. A name that a model provider has is refused here.
     */
    async "skills.review"([data = {}]) {
      const fields = cleanScriptCommand(data);
      const existing = skillList().skills.find((entry) => entry.name === fields.name)?.command === "script";
      await workspace.assertScriptName(fields.name, existing ? fields.name : undefined);
      return { ...fields, existing, ...(existing && { original: fields.name }), revision: scriptRevision({ ...fields, ...(existing && { original: fields.name }) }), ...(whatRuns(workspace, fields.name).length && { alsoRunsOn: whatRuns(workspace, fields.name) }) };
    },
    /**
     * A script command, or with `original` a change to one: { name, description, script, original? }. It runs on this computer
     * whenever a person types it, so the caller shows the person the whole script (`skills.review`) and gets a yes:
     * `options` is { agreed: true, revision } with the revision that `skills.review` gave for exactly this script. A yes for
     * another script, or none, is refused. (The window and the phone's editors are the person at the screen: they have no yes to give here.)
     */
    async "skills.saveScript"([data = {}, options]) {
      if (options?.agreed !== true) throw new ControlError("A script command runs a script on this computer each time a person types it. Show the person the whole script (`skills.review` gives it, with its revision), and give `{ \"agreed\": true, \"revision\": \"<its revision>\" }` as the last argument (on the command line, `--yes --revision <it>`).", "NEEDS_YES");
      if (typeof options.revision !== "string" || options.revision !== scriptRevision(data)) throw new ControlError("The revision is not the one of this script. Run `skills.review` for the script that is to be saved, show it to the person, and give its revision.", "BAD_ARGUMENT");
      const name = await handlers["skills.saveScript"](data);
      return skill(name);
    },
    /** A new skill, or with `original` a change to one: { name, description, instructions, original? }. */
    async "skills.save"([data = {}]) {
      const name = await handlers.saveSkill(data);
      return skill(name);
    },
    async "skills.remove"([ref]) {
      const found = skill(ref);
      await handlers.removeSkill(found.name);
      return { removed: found.name };
    },
    async "skills.enable"([ref, on]) {
      const found = skill(ref);
      await handlers.setSkillEnabled(found.name, on === true);
      return skill(found.name);
    },
    /** Adds a skill folder, or a folder of skills, by its full path on this computer. */
    // A plugin folder is refused here: it can run commands, and this call shows nothing before it links.
    "skills.addFolder": async ([path]) => {
      const folder = text(path, 4000, "a folder's full path");
      try {
        return await handlers.addSkillFolderAt(folder, { plugins: false });
      } catch (error) {
        // The plugins' own command takes such a folder: it shows what the plugin would run, and one that runs commands goes on only after a yes.
        if (/This folder is a plugin/.test(String(error?.message))) throw new ControlError(error.message + " Add it with `botkins plugins add-folder`, which shows what it runs first.", "BAD_ARGUMENT");
        throw error;
      }
    },
    async "skills.removeFolder"([id]) {
      const folders = skillList();
      const found = [...(folders.folders ?? []), ...(folders.plugins ?? [])].find((entry) => entry.id === id || entry.path === id);
      if (!found) throw new ControlError("No linked folder has that id or path. See `botkins skills folders`.", "NOT_FOUND");
      await handlers.removeSkillFolder(found.id);
      return { removed: found.id, path: found.path };
    },

    // ── A bot's tools, skills and access ──
    /** What a bot has on and off: each tool and each skill, by name. */
    "bots.tools": ([ref]) => botTools(bot(ref)),
    /** Turns tools and skills on and off for one bot: { toolsOn?, toolsOff?, skillsOn?, skillsOff? }, each a list of names. */
    async "bots.tools.set"([ref, patch]) {
      const found = bot(ref);
      {
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ControlError("Give what to turn on and off.", "BAD_ARGUMENT");
        const off = (now, turnOff, turnOn) => [...new Set([...now.filter((item) => !(turnOn ?? []).includes(item)), ...(turnOff ?? [])])];
        const toolIds = (list) => names(list, "Tools")?.map((name) => tool(name).id);
        const next = {};
        if (patch.toolsOn !== undefined || patch.toolsOff !== undefined) next.mcpOff = off(found.mcpOff ?? [], toolIds(patch.toolsOff), toolIds(patch.toolsOn));
        if (patch.skillsOn !== undefined || patch.skillsOff !== undefined) {
          const rows = botSkillRows(skillList().skills, found);
          const skillNames = (list) => names(list, "Skills")?.map((name) => skill(name, rows, "botkins bots skills " + found.id).name);
          next.skillsOff = off(found.skillsOff ?? [], skillNames(patch.skillsOff), skillNames(patch.skillsOn));
        }
        await handlers.setBotIntegrations(found.id, next);
      }
      return botTools(bot(found.id));
    },
    /** Which projects a bot may use. */
    "bots.access": ([ref]) => access(bot(ref)),
    /** Sets which projects a bot may use: { all: true }, or { projects: [name or id…] }. */
    async "bots.access.set"([ref, change]) {
      const found = bot(ref);
      {
        if (!change || typeof change !== "object" || Array.isArray(change)) throw new ControlError("Give `all`, or the projects.", "BAD_ARGUMENT");
        const ids = (names(change.projects, "Projects") ?? []).map((name) => pick(projects(), name, "project", null).id);
        await handlers.setBotAccess(found.id, { all: change.all === true, projects: change.all === true ? [] : ids });
      }
      return access(bot(found.id));
    },
    /** What a bot's chat offers when a person types "/": its commands, skills and tools, as the model's own runtime lists them. */
    "bots.menu": ([ref, refresh]) => handlers.catalog(bot(ref).id, undefined, refresh === true),
    /** The folders of this computer that a person may choose from: the home folder and plugged-in disks. */
    "folders.list": ([path]) => handlers.listFolders(path === undefined || path === null || path === "" ? undefined : text(path, 4000, "a folder's full path")),
  };
}
