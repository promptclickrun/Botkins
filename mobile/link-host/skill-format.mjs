/** name and description from a SKILL.md, and the instructions under its front matter. */
export function parseSkill(source, fallbackName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  const meta = {};
  if (match) {
    const lines = match[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
      if (!field) continue;
      let value = field[2].trim();
      if (/^[>|][+-]?$/.test(value)) {
        // A folded or literal block: the indented lines that follow.
        const block = [];
        while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1])) block.push(lines[++i].trim());
        value = block.join(value.startsWith(">") ? " " : "\n").trim();
      } else value = value.replace(/^(["'])(.*)\1$/, "$2");
      meta[field[1].toLowerCase()] = value;
    }
  }
  return {
    name: (meta.name || fallbackName || "").trim(),
    description: (meta.description || "").trim(),
    instructions: (match ? source.slice(match[0].length) : source).trim(),
  };
}
export const slug = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
