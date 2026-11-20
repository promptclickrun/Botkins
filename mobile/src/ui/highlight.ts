// Code coloring for Markdown code blocks: highlight.js's core with a set of common languages, its
// output turned into plain runs of text with a scope each, and colors taken from the theme.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { TextStyle } from "react-native";
import type { Colors } from "./theme";

const LANGUAGES = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, php, plaintext, python, ruby, rust, scss, shell, sql, swift, typescript, xml, yaml };
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);
hljs.registerAliases(["sh", "zsh", "console"], { languageName: "bash" });
hljs.registerAliases(["toml"], { languageName: "ini" });
hljs.registerAliases(["jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["tsx", "mts"], { languageName: "typescript" });
hljs.registerAliases(["html", "svg", "plist"], { languageName: "xml" });
hljs.registerAliases(["text", "txt"], { languageName: "plaintext" });

/** A run of code text and the highlight.js scope it is in ("keyword", "title.function"), if any. */
export type CodeRun = { text: string; scope?: string };

const unescapeHtml = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** highlight.js's HTML as runs: `<span class="hljs-keyword">const</span>` → { text: "const", scope: "keyword" }. */
function toRuns(html: string): CodeRun[] {
  const runs: CodeRun[] = [];
  const stack: string[] = [];
  const pattern = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (match[1] !== undefined) stack.push(match[1].replace(/hljs-/g, "").split(" ")[0]);
    else if (match[2] !== undefined) {
      const text = unescapeHtml(match[2]);
      const scope = stack[stack.length - 1];
      const last = runs[runs.length - 1];
      if (last && last.scope === scope) last.text += text;
      else runs.push({ text, scope });
    } else stack.pop();
  }
  return runs;
}

// Finished blocks are colored once: a list that scrolls or a reply that grows asks again for the same code.
const cache = new Map<string, CodeRun[] | null>();
const CACHE_SIZE = 120;
const MAX_LENGTH = 60_000;

/** The code as colored runs, or null when the language isn't known or the code is too long to color quickly. */
export function highlightCode(code: string, lang: string | undefined): CodeRun[] | null {
  const name = (lang ?? "").toLowerCase();
  if (!name || !hljs.getLanguage(name) || code.length > MAX_LENGTH) return null;
  const key = name + "\u0000" + code;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let runs: CodeRun[] | null = null;
  try {
    runs = toRuns(hljs.highlight(code, { language: name, ignoreIllegals: true }).value);
  } catch {
    runs = null;
  }
  cache.set(key, runs);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return runs;
}

/** A small palette from the theme's own colors, so code reads in light and dark alike. */
export function codePalette(colors: Colors): (scope: string | undefined) => TextStyle | undefined {
  const keyword: TextStyle = { color: colors.accent };
  const text: TextStyle = { color: colors.success };
  const number: TextStyle = { color: colors.warning };
  const comment: TextStyle = { color: colors.faint, fontStyle: "italic" };
  const name: TextStyle = { color: colors.info };
  const attribute: TextStyle = { color: colors.danger };
  const strong: TextStyle = { fontWeight: "700" };
  const table: Record<string, TextStyle> = {
    keyword,
    "selector-tag": keyword,
    doctag: keyword,
    meta: keyword,
    built_in: name,
    type: name,
    title: name,
    section: { ...name, fontWeight: "700" },
    name,
    tag: name,
    "selector-class": name,
    "selector-id": name,
    string: text,
    regexp: text,
    symbol: text,
    addition: text,
    "template-tag": text,
    char: text,
    number,
    literal: number,
    bullet: number,
    link: number,
    "selector-pseudo": number,
    comment,
    quote: comment,
    attr: attribute,
    attribute,
    property: attribute,
    variable: attribute,
    "template-variable": attribute,
    params: { color: colors.ink2 },
    deletion: { color: colors.danger },
    strong,
    emphasis: { fontStyle: "italic" },
  };
  return (scope) => (scope ? (table[scope] ?? table[scope.split(".")[0]]) : undefined);
}
