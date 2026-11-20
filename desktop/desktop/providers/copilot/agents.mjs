// Reads the custom agents a person already has for GitHub Copilot: <Copilot home>/agents/*.agent.md.
// A file is YAML front matter (name, description, model, tools, ...) followed by the agent's prompt.
// Botkins offers each one as a bot. It only reads these files; it never changes them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_FILE = 256 * 1024;
const MAX_AGENTS = 200;

const unquote = (value) => value.replace(/^(["'])([\s\S]*)\1$/, "$2");

/**
 * The front matter fields of an agent file. Values are strings, lists of strings, or `{}` for a
 * nested block Botkins doesn't read (such as mcp-servers).
 */
function frontMatter(text) {
  const meta = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!field) continue;
    const key = field[1].toLowerCase();
    let value = field[2].trim();
    if (value.startsWith("#")) value = "";
    const indented = () => {
      const block = [];
      while (i + 1 < lines.length && /^(\s+\S|\s*$)/.test(lines[i + 1])) block.push(lines[++i]);
      return block;
    };
    if (/^[>|][+-]?\d*$/.test(value)) {
      // A folded or literal block: the indented lines that follow.
      const block = indented().map((line) => line.trim());
      meta[key] = block.join(value.startsWith(">") ? " " : "\n").trim();
    } else if (value === "") {
      const block = indented().filter((line) => line.trim() && !line.trim().startsWith("#"));
      meta[key] = block.length && block.every((line) => /^\s*-\s/.test(line) || /^\s*-$/.test(line))
        ? block.map((line) => unquote(line.replace(/^\s*-\s*/, "").trim())).filter(Boolean)
        : block.length
          ? {}
          : "";
    } else if (/^\[.*\]$/.test(value)) {
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => unquote(item.trim()))
        .filter(Boolean);
    } else meta[key] = unquote(value);
  }
  return meta;
}

/** { meta, prompt } for an agent file's text. A file without front matter is all prompt. */
export function parseAgentFile(source) {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  return { meta: match ? frontMatter(match[1]) : {}, prompt: (match ? source.slice(match[0].length) : source).trim() };
}

const WORDS = {
  ai: "AI", api: "API", aws: "AWS", cd: "CD", ci: "CI", css: "CSS", db: "DB", devops: "DevOps", gcp: "GCP",
  html: "HTML", ios: "iOS", js: "JS", ml: "ML", pr: "PR", qa: "QA", sdk: "SDK", seo: "SEO", sql: "SQL",
  sre: "SRE", ts: "TS", ui: "UI", ux: "UX",
};
/** "backend-development" → "Backend Development". A name that already reads as a title is kept. */
export function agentTitle(name) {
  if (/[A-Z ]/.test(name)) return name.trim();
  return name
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => WORDS[word] ?? word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** True when the agent names its own tools or MCP servers, which a Botkins bot doesn't take over. */
function ownTools(meta) {
  const tools = meta.tools;
  const all = tools == null || tools === "" || tools === "*" || (Array.isArray(tools) && tools.includes("*"));
  const servers = meta["mcp-servers"];
  return !all || (servers != null && servers !== "");
}

/**
 * The agents in a Copilot agents folder, by title:
 *   { name, title, description, instructions, model?, file, ownTools }
 * `model` is the text the file gives; the provider matches it to its catalog. Files that can't be
 * read, or that hold neither a prompt nor a description, are left out.
 */
export function readAgents(folder) {
  let names;
  try {
    names = readdirSync(folder).filter((n) => /\.md$/i.test(n) && !n.startsWith("."));
  } catch {
    return [];
  }
  const agents = new Map();
  for (const file of names.sort()) {
    if (agents.size >= MAX_AGENTS) break;
    const path = join(folder, file);
    let source;
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_FILE) continue;
      source = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const { meta, prompt } = parseAgentFile(source);
    const named = /\.agent\.md$/i.test(file);
    const text = (value) => (typeof value === "string" ? value.trim() : "");
    const description = text(meta.description);
    // A plain .md file counts only when its front matter says it is an agent (README.md is not one).
    if (!named && !text(meta.name) && !description) continue;
    const name = text(meta.name) || file.replace(/(\.agent)?\.md$/i, "");
    const instructions = prompt || description;
    // A name of only separators ("-.agent.md") has no title to show.
    const title = agentTitle(name) || name.trim();
    if (!name || !title || !instructions || agents.has(name.toLowerCase())) continue;
    agents.set(name.toLowerCase(), {
      name,
      title,
      description,
      instructions,
      ...(text(meta.model) && { model: text(meta.model) }),
      file: path,
      ownTools: ownTools(meta),
    });
  }
  return [...agents.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/** The catalog model an agent file's `model` means, or undefined. Files give an id or a display name. */
export function matchModel(catalog, wanted) {
  if (!wanted) return undefined;
  const plain = (value) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replace(/[\s_]+/g, "-")
      .trim();
  const target = plain(wanted);
  const usable = catalog.filter((m) => m.available);
  return usable.find((m) => plain(m.id) === target) ?? usable.find((m) => plain(m.name) === target);
}
