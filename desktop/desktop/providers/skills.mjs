// Skills for the backends that are command-line tools.
//
// The Copilot runtime loads skill folders itself. The other backends each have their own idea of
// a skill, kept in the person's own setup, so Botkins gives them its skills the same plain way:
// the bot's instructions list the skills it has (name and one line each), and a tool on the
// bridge, skill_read, returns a skill's instructions when the bot is about to do that work.
// Which skills a bot has is exactly what Settings › Skills and the bot's own switches say.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { defineTool } from "./provider.mjs";
import { skillsIn } from "../integrations.mjs";

const MAX_TEXT = 60000;
const MAX_FILES = 60;

/** The files that come with a skill (scripts, references), as paths inside its folder. */
function filesOf(folder) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) walk(path, depth + 1);
      } else if (entry.isFile() && !(dir === folder && entry.name === "SKILL.md")) out.push(relative(folder, path));
    }
  };
  walk(folder, 1);
  return out;
}

/**
 * The skills a session spec switches on: [{ name, description, path }], each name once. A
 * plugin's skills (its "skills" folder) count too: the Copilot runtime loads a plugin whole, and
 * these backends at least get the skills in it, so a skill doesn't vanish with a change of harness.
 */
export function enabledSkills(spec) {
  const off = new Set(spec.skills?.disabled ?? []);
  const seen = new Set();
  const list = [];
  const plugins = (spec.plugins ?? []).map((folder) => join(folder, "skills")).filter((folder) => existsSync(folder));
  for (const folder of [...(spec.skills?.directories ?? []), ...plugins])
    for (const skill of skillsIn(folder)) {
      if (seen.has(skill.name) || off.has(skill.name)) continue;
      seen.add(skill.name);
      list.push({ name: skill.name, description: skill.description, path: skill.path });
    }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What a session needs to use Botkins' skills:
 *   list          the skills, for the "/" menu
 *   instructions  text for the system prompt ("" when the bot has no skills)
 *   tools         the skill_read tool (none when the bot has no skills)
 */
export function skillSupport(spec) {
  const list = enabledSkills(spec);
  if (!list.length) return { list, instructions: "", tools: [] };
  const instructions =
    "\n\nYou have skills: written instructions for particular kinds of work. Before you do work that a skill covers, call the skill_read tool with the skill's name and follow what it returns. " +
    "A message that starts with a slash and a skill's name (such as /" + list[0].name + ") asks for that skill.\nYour skills:\n" +
    list.map((s) => "- " + s.name + ": " + s.description.replace(/\s+/g, " ").trim()).join("\n");
  const tool = defineTool("skill_read", {
    description: "Read one of your skills before doing the work it covers. Returns the skill's instructions, its folder, and the files that come with it.",
    parameters: { type: "object", properties: { name: { type: "string", description: "The skill's name, as listed in your instructions." } }, required: ["name"], additionalProperties: false },
    handler: ({ name }) => {
      const wanted = String(name ?? "").trim().replace(/^\//, "").toLowerCase();
      const skill = list.find((s) => s.name.toLowerCase() === wanted);
      if (!skill) throw new Error("You have no skill named " + JSON.stringify(String(name ?? "")) + ". Your skills: " + list.map((s) => s.name).join(", ") + ".");
      const text = readFileSync(join(skill.path, "SKILL.md"), "utf8");
      if (!statSync(skill.path).isDirectory()) throw new Error("This skill's folder is missing.");
      return JSON.stringify({
        name: skill.name,
        // The frontmatter is the name and description the bot already has.
        instructions: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim().slice(0, MAX_TEXT),
        folder: skill.path,
        files: filesOf(skill.path),
      });
    },
  });
  return { list, instructions, tools: [tool] };
}

/** The skills as entries of the "/" menu (see commands.mjs buildInventory `native`). */
export const skillChoices = (list) => list.map((s) => ({ name: s.name, description: s.description, kind: "Skill", source: "Botkins" }));
