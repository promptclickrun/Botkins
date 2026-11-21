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

/**
 * @param workspace  The app's workspace.
 * @param handlers   `runtime.handlers`.
 * @param bot        (ref) → a bot, by id or by a name only one bot has (desktop/terminal/control.mjs).
 */
export function toolsApi({ workspace, handlers, bot }) {
  const state = () => workspace.state;
  const servers = () => workspace.integrations.publicServers();
  const tool = (ref) => pick(servers(), ref, "tool", "botkins tools list");
  /** A tool as the command line shows it. `env` and `headers` are the names that have a value. */
  const toolView = (server) => ({
    id: server.id,
    name: server.name,
    kind: server.type === "stdio" ? "command" : "web",
    type: server.type,
    enabled: server.enabled !== false,
    ...(server.type === "stdio" ? { command: server.command, args: server.args ?? [], ...(server.cwd && { cwd: server.cwd }), runs: runs(server) } : { url: server.url }),
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
  const skill = (ref) => {
    const wanted = text(ref, 200, "a skill's name");
    const found = skillList().skills.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
    if (!found) throw new ControlError("There is no skill called " + wanted + ". See `botkins skills list`.", "NOT_FOUND");
    return found;
  };
  /** What a bot leaves out, by name: the tools and skills that are on for every bot and off for this one. */
  const botTools = (entry) => {
    const all = servers();
    return {
      id: entry.id,
      name: entry.name,
      tools: all.map((server) => ({ id: server.id, name: server.name, on: !(entry.mcpOff ?? []).includes(server.id), enabled: server.enabled !== false })),
      skills: skillList().skills.map((item) => ({ name: item.name, on: !(entry.skillsOff ?? []).includes(item.name), enabled: item.enabled !== false })),
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
    /** A new tool. `data` is the app's own form: { name, command, args?, cwd?, env? } or { name, url, type?, headers?, oauth? }. */
    async "tools.add"([data = {}]) {
      if (data?.id !== undefined) throw new ControlError("A new tool has no id. Use `tools.edit` to change one.", "BAD_ARGUMENT");
      return toolView(tool(await handlers.saveMcpServer(data)));
    },
    /**
     * Changes a tool. `patch` holds only what changes. `env` and `headers` are { NAME: value } to
     * set a value and { NAME: false } to take a name away; every other stored value is kept.
     */
    async "tools.edit"([ref, patch = {}]) {
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
      await handlers.saveMcpServer(input);
      return toolView(tool(found.id));
    },
    async "tools.remove"([ref]) {
      const found = tool(ref);
      await handlers.removeMcpServer(found.id);
      return { removed: found.id, name: found.name };
    },
    async "tools.enable"([ref, on]) {
      const found = tool(ref);
      await handlers.setMcpServerEnabled(found.id, on === true);
      return toolView(tool(found.id));
    },
    /** Connects the tool once and lists what it offers. A tool that is a command is started for it. */
    async "tools.test"([ref]) {
      const found = tool(ref);
      return { id: found.id, name: found.name, ...(await handlers.testMcpServer(found.id)) };
    },
    /** What a file of tools holds, before anything is saved: each one's name, and what it would start or reach. No value is answered. */
    "tools.import.preview"([json]) {
      if (typeof json !== "string") throw new ControlError("Give the file's JSON as text.", "BAD_ARGUMENT");
      return parseServers(json.slice(0, 1_000_000)).map((server) => ({
        name: server.name,
        kind: server.type === "stdio" ? "command" : "web",
        ...(server.type === "stdio" ? { runs: runs(server), ...(server.cwd && { cwd: server.cwd }) } : { url: server.url }),
        env: Object.keys(server.env ?? {}),
        headers: Object.keys(server.headers ?? {}),
        exists: servers().some((existing) => existing.name.toLowerCase() === server.name.toLowerCase()),
      }));
    },
    "tools.import": ([json]) => {
      if (typeof json !== "string") throw new ControlError("Give the file's JSON as text.", "BAD_ARGUMENT");
      return handlers.importMcpServers(json);
    },
    async "tools.signOut"([ref]) {
      const found = tool(ref);
      await handlers.signOutMcpServer(found.id);
      return toolView(tool(found.id));
    },
    /** Forgets the tool approvals a person gave "for this chat", in one chat or in all of them. */
    "tools.forgetApprovals": ([chatId]) => void handlers.clearApprovals(chatId === undefined || chatId === null ? undefined : text(chatId, 200, "a chat's id")),

    // ── Skills ──
    "skills.list": () => skillList(),
    "skills.get": ([ref]) => {
      const found = skill(ref);
      // Only a skill that Botkins keeps can be read whole; one from a linked folder is read in its folder.
      return found.editable ? { ...found, ...handlers.readSkill(found.name) } : found;
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
    "skills.addFolder": ([path]) => handlers.addSkillFolderAt(text(path, 4000, "a folder's full path")),
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
        const skillNames = (list) => names(list, "Skills")?.map((name) => skill(name).name);
        const next = {};
        if (patch.toolsOn !== undefined || patch.toolsOff !== undefined) next.mcpOff = off(found.mcpOff ?? [], toolIds(patch.toolsOff), toolIds(patch.toolsOn));
        if (patch.skillsOn !== undefined || patch.skillsOff !== undefined) next.skillsOff = off(found.skillsOff ?? [], skillNames(patch.skillsOff), skillNames(patch.skillsOn));
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
