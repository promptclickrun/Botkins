// Model names as people read them. A provider's catalog usually gives a name ("Claude Opus 5.5"),
// but some give an id dressed as one ("GPT-6-Luna"), a run recorded long ago may name a model the
// catalog no longer has, and the Copilot runtime knows another plan's model as "<plan>/<id>". A
// person should never be shown an id, so every name passes through here. The app's page and the
// phone both get their names from this file (desktop/providers/index.mjs, src/providers.ts).

const FAMILIES = { opus: "Claude Opus", sonnet: "Claude Sonnet", haiku: "Claude Haiku", fable: "Claude Fable", mythos: "Claude Mythos" };
// Words that are written their own way.
const WORDS = { gpt: "GPT", ai: "AI", api: "API", oss: "OSS", xl: "XL", llama: "Llama", glm: "GLM", qwen: "Qwen", grok: "Grok", gemini: "Gemini", claude: "Claude", codex: "Codex", deepseek: "DeepSeek", mistral: "Mistral", kimi: "Kimi" };
const word = (text) => WORDS[text.toLowerCase()] ?? (/^[a-z]/.test(text) && !/\d/.test(text) ? text[0].toUpperCase() + text.slice(1) : text);

/** A model id as a name: "gpt-6.2-sol" → "GPT-6.2 Sol", "claude-opus-5-5" → "Claude Opus 5.5", "chatgpt/gpt-6-astra" → "GPT-6 Astra", "opus" → "Claude Opus". */
export function friendlyModel(id) {
  let text = String(id ?? "").trim();
  if (!text) return "";
  // The Copilot runtime's "<plan>/<model>", a route's context mark ("[1m]") and a date stamp are not part of the name.
  text = text.replace(/^[a-z0-9_.-]+\//i, "").replace(/\[[^\]]*\]$/, "").replace(/[-_@]20\d{6}$/, "").replace(/[-_]latest$/i, "");
  const lower = text.toLowerCase();
  if (lower === "auto") return "Auto";
  if (FAMILIES[lower]) return FAMILIES[lower];
  // claude-<family>-<major>[-<minor>], and the older claude-<major>-<minor>-<family>.
  let match = /^claude-([a-z]+)-(\d+)(?:[-.](\d+))?$/.exec(lower);
  if (match && FAMILIES[match[1]]) return FAMILIES[match[1]] + " " + match[2] + (match[3] ? "." + match[3] : "");
  match = /^claude-(\d+)(?:[-.](\d+))?-([a-z]+)$/.exec(lower);
  if (match && FAMILIES[match[3]]) return FAMILIES[match[3]] + " " + match[1] + (match[2] ? "." + match[2] : "");
  // gpt-<version>-<name…>: the version stays with "GPT", the rest are words.
  match = /^gpt-([0-9][0-9a-z.]*)(?:-(.+))?$/.exec(lower);
  if (match) return ["GPT-" + match[1], ...(match[2] ? match[2].split(/[-_]/).map(word) : [])].join(" ");
  return text.split(/[-_\s]+/).filter(Boolean).map(word).join(" ");
}

/** True when a catalog's "name" is really an id: one unbroken word with dashes, underscores or a slash in it. */
const idLike = (name) => !/\s/.test(name) && /[-_/]/.test(name);

/** The name to show for a catalog entry: its own name when it has a real one, otherwise the id made readable. */
export function friendlyName(name, id) {
  const given = typeof name === "string" ? name.trim() : "";
  if (!given || given === id || idLike(given)) return friendlyModel(given || id);
  return given;
}
