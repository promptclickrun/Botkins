// GitHub-flavored Markdown as native text: headings, emphasis, code, links and autolinks, nested and
// task lists, quotes and callouts, tables with alignment, rules, footnotes and line breaks.
// HTML in a message is shown as text and images as links, as on the desktop: nothing remote is
// loaded into a chat.
//
// Fast while a reply streams: marked tokens for blank-line-separated top-level blocks are retained,
// while marked lexes only the active tail until its Markdown shape is definitely closed.
import * as Clipboard from "expo-clipboard";
import { Check, ChevronDown, Copy, Info, Lightbulb, type LucideIcon, MessageSquareWarning, OctagonAlert, TriangleAlert } from "lucide-react-native";
import { Marked, type Token, type Tokens } from "marked";
import { Fragment, memo, type ReactNode, useContext, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, type TextStyle, View } from "react-native";
import { useChatPrefs } from "@/state/chatPrefs";
import { haptic } from "./haptics";
import { codePalette, type CodeRun, highlightCode } from "./highlight";
import { pullRequestUrl } from "../../link-host/pr-url.mjs";
import { LinkHold, type LinkHoldApi, linkPress, MessageLink, openLink as defaultOpenLink } from "./LinkHold";
import { parseStreamingMarkdown, type MarkdownStreamCache } from "./markdownCache";
import { CELL_PAD, tableWidths } from "./tables";
import { Tap } from "./Tap";
import { type Colors, radius, space, type TypeScale, useTheme } from "./theme";

// ---------------------------------------------------------------------------------------------
// Parsing

/** Footnote references ("[^1]") as their own inline token; their definitions are taken out beforehand. */
const lexer = new Marked({ gfm: true, breaks: true }).use({
  extensions: [
    {
      name: "footnoteRef",
      level: "inline",
      start: (src: string) => {
        const at = src.indexOf("[^");
        return at < 0 ? undefined : at;
      },
      tokenizer: (src: string) => {
        const match = /^\[\^([^\]\s]+)\]/.exec(src);
        return match ? { type: "footnoteRef", raw: match[0], id: match[1] } : undefined;
      },
    },
  ],
});
const lex = (text: string) => lexer.lexer(text) as Token[];

type Footnote = { id: string; text: string };

/** Takes footnote definitions ("[^id]: text", with indented lines that continue it) out of the text. Code fences are left alone. */
function splitFootnotes(text: string): { body: string; notes: Footnote[] } {
  if (!text.includes("[^")) return { body: text, notes: [] };
  const lines = text.split("\n");
  const body: string[] = [];
  const notes: Footnote[] = [];
  let fence: string | null = null;
  let current: Footnote | null = null;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence ? null : marker;
    if (!fence) {
      const def = /^ {0,3}\[\^([^\]\s]+)\]:\s?(.*)$/.exec(line);
      if (def) {
        current = { id: def[1], text: def[2] };
        notes.push(current);
        continue;
      }
      if (current && /^( {2,}|\t)\S/.test(line)) {
        current.text += "\n" + line.trim();
        continue;
      }
    }
    current = null;
    body.push(line);
  }
  return { body: body.join("\n"), notes };
}

/** Footnotes are numbered in the order they are first referred to. */
function numberNotes(body: string, notes: Footnote[]): Map<string, number> {
  const numbers = new Map<string, number>();
  if (!body.includes("[^") && notes.length === 0) return numbers;
  const prose = body.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, "").replace(/`[^`\n]*`/g, "");
  const pattern = /\[\^([^\]\s]+)\]/g;
  for (let match = pattern.exec(prose); match; match = pattern.exec(prose)) if (!numbers.has(match[1])) numbers.set(match[1], numbers.size + 1);
  for (const note of notes) if (!numbers.has(note.id)) numbers.set(note.id, numbers.size + 1);
  return numbers;
}

/** Whether a code token's fence is closed: while a reply streams, an open block is shown plainly until it ends. */
function fenceClosed(raw: string): boolean {
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
  if (!open) return true;
  const close = new RegExp("\\n {0,3}" + (open[0] === "`" ? "`" : "~") + "{" + open.length + ",}[ \\t]*\\n?$");
  return close.test(raw.replace(/\n+$/, "\n"));
}

// ---------------------------------------------------------------------------------------------
// Rendering

/**
 * Paths in a message that open something on a tap (a bot's artifacts, "artifacts-v1"). The chat
 * decides which; this only draws them. `find` gives the linked paths in a run of text, `has` says
 * whether a whole piece of code or a whole line in a code block is one.
 */
export type PathLinks = { has: (path: string) => boolean; find: (text: string) => { start: number; end: number; path: string }[]; open: (path: string) => void };

/** `scale` is the type scale at the person's text size and in their font. */
type Ctx = { colors: Colors; scale: TypeScale; base: TextStyle; highlight: boolean; wrap: boolean; notes: Map<string, number>; onLink: (url: string) => void; hold: LinkHoldApi | null; paths?: PathLinks };

/** Text with the paths in it that open something drawn as links. Without any, the text as it is. */
function withPaths(text: string, paths: PathLinks | undefined, color: string, k: string): ReactNode {
  if (!paths || !text) return text;
  let spans: { start: number; end: number; path: string }[];
  try {
    spans = paths.find(text);
  } catch {
    return text;
  }
  if (spans.length === 0) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const span of spans) {
    if (span.start < last || span.end > text.length) continue;
    if (span.start > last) out.push(text.slice(last, span.start));
    out.push(
      <Text key={k + "p" + span.start} style={{ color, textDecorationLine: "underline" }} onPress={() => paths.open(span.path)} accessibilityRole="link">
        {text.slice(span.start, span.end)}
      </Text>,
    );
    last = span.end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const unescape = (text: string) => text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function inline(tokens: Token[] | undefined, ctx: Ctx, key = "i"): ReactNode[] {
  return (tokens ?? []).map((token, index) => {
    const k = key + index;
    switch (token.type) {
      case "strong":
        return (
          <Text key={k} style={{ fontWeight: "700" }}>
            {inline((token as Tokens.Strong).tokens, ctx, k)}
          </Text>
        );
      case "em":
        return (
          <Text key={k} style={{ fontStyle: "italic" }}>
            {inline((token as Tokens.Em).tokens, ctx, k)}
          </Text>
        );
      case "del":
        return (
          <Text key={k} style={{ textDecorationLine: "line-through" }}>
            {inline((token as Tokens.Del).tokens, ctx, k)}
          </Text>
        );
      case "codespan": {
        const code = unescape((token as Tokens.Codespan).text);
        // Code that is one whole path the chat links opens it.
        const linked = !!ctx.paths?.has(code);
        return (
          <Text
            key={k}
            style={[ctx.scale.mono, { fontSize: (ctx.base.fontSize ?? ctx.scale.callout.fontSize) - 2, lineHeight: undefined, backgroundColor: ctx.colors.sunken, color: linked ? ctx.colors.accentText : ctx.colors.ink }, linked && { textDecorationLine: "underline" }]}
            {...(linked && { onPress: () => ctx.paths?.open(code), accessibilityRole: "link" as const })}
          >
            {/* No-break spaces: an ordinary one is left behind as an empty box when the code wraps to the next line. */}
            {"\u00A0" + code + "\u00A0"}
          </Text>
        );
      }
      case "link": {
        const link = token as Tokens.Link;
        return (
          <Text key={k} style={{ color: ctx.colors.accentText, textDecorationLine: "underline" }} {...linkPress(ctx.hold, link.href, () => ctx.onLink(link.href))} accessibilityRole="link">
            {inline(link.tokens, ctx, k)}
          </Text>
        );
      }
      case "image": {
        const image = token as Tokens.Image;
        return (
          <Text key={k} style={{ color: ctx.colors.accentText, textDecorationLine: "underline" }} {...linkPress(ctx.hold, image.href, () => ctx.onLink(image.href))} accessibilityRole="link">
            {image.text || image.href}
          </Text>
        );
      }
      case "footnoteRef": {
        const number = ctx.notes.get((token as Tokens.Generic).id as string);
        return (
          <Text key={k} style={[ctx.scale.caption, { color: ctx.colors.accentText }]} accessibilityLabel={"Footnote " + (number ?? "")}>
            {"[" + (number ?? "?") + "]"}
          </Text>
        );
      }
      case "br":
        return "\n";
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens ? inline(text.tokens, ctx, k) : withPaths(unescape(text.text), ctx.paths, ctx.colors.accentText, k);
      }
      case "escape":
        return (token as Tokens.Escape).text;
      case "checkbox":
        return null;
      default:
        // Inline HTML and anything unknown stays as the text that was written.
        return "raw" in token ? String(token.raw) : null;
    }
  });
}

const FOLD_LINES = 30;

/** Splits colored runs at a line count, for a folded block. */
function firstLines(runs: CodeRun[], lines: number): CodeRun[] {
  const out: CodeRun[] = [];
  let left = lines;
  for (const run of runs) {
    const parts = run.text.split("\n");
    if (parts.length - 1 < left) {
      out.push(run);
      left -= parts.length - 1;
      continue;
    }
    out.push({ text: parts.slice(0, left).join("\n"), scope: run.scope });
    break;
  }
  return out;
}

/** The colored runs of some code, line by line. */
function runsByLine(runs: CodeRun[] | null, text: string): CodeRun[][] {
  if (!runs) return text.split("\n").map((line) => [{ text: line }]);
  const lines: CodeRun[][] = [[]];
  for (const run of runs) {
    run.text.split("\n").forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ text: part, scope: run.scope });
    });
  }
  return lines;
}

/** A line of a code block that is nothing but a path the chat links (without white space or quotes around it). */
function linkedLine(line: string, paths: PathLinks): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const path = /^(["'`]).+\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
  return paths.has(path) ? path : null;
}

const CodeBlock = memo(function CodeBlock({ code, lang, closed, highlight, wrap, colors, paths }: { code: string; lang?: string; closed: boolean; highlight: boolean; wrap: boolean; colors: Colors; paths?: PathLinks }) {
  const scale = useTheme().type;
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const text = code.replace(/\n$/, "");
  const lineCount = text.split("\n").length;
  const folded = !open && lineCount > FOLD_LINES + 5;
  const runs = useMemo(() => (highlight && closed ? highlightCode(text, lang) : null), [text, lang, highlight, closed]);
  const paint = useMemo(() => codePalette(colors), [colors]);
  const shown = folded ? (runs ? firstLines(runs, FOLD_LINES) : text.split("\n").slice(0, FOLD_LINES).join("\n")) : (runs ?? text);
  // Lines that are a path the chat links open it; the rest of the block is drawn as always.
  const links = useMemo(() => (paths && closed ? text.split("\n").map((line) => linkedLine(line, paths)) : null), [paths, closed, text]);
  const lines = useMemo(() => (links?.some(Boolean) ? runsByLine(runs, text) : null), [links, runs, text]);
  const body = (
    <Text selectable style={[scale.mono, { color: colors.ink }]}>
      {lines && links
        ? (folded ? lines.slice(0, FOLD_LINES) : lines).map((line, index) => {
            const path = links[index];
            return (
              <Fragment key={index}>
                {index > 0 ? "\n" : null}
                {path ? (
                  <Text style={{ color: colors.accentText, textDecorationLine: "underline" }} onPress={() => paths?.open(path)} accessibilityRole="link">
                    {line.map((run) => run.text).join("")}
                  </Text>
                ) : (
                  line.map((run, at) => (
                    <Text key={at} style={paint(run.scope)}>
                      {run.text}
                    </Text>
                  ))
                )}
              </Fragment>
            );
          })
        : typeof shown === "string"
          ? shown
          : shown.map((run, index) => (
              <Text key={index} style={paint(run.scope)}>
                {run.text}
              </Text>
            ))}
    </Text>
  );
  return (
    <View style={{ borderRadius: radius.md, backgroundColor: colors.sunken, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: space.md, paddingRight: space.xs, height: 36 }}>
        <Text style={[scale.caption, { color: colors.muted }]}>{lang || "code"}</Text>
        <Tap
          accessibilityLabel={copied ? "Copied" : "Copy code"}
          feel="none"
          onPress={() => {
            void Clipboard.setStringAsync(text);
            haptic.success();
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
        >
          {copied ? <Check size={15} color={colors.success} strokeWidth={2.4} /> : <Copy size={15} color={colors.muted} strokeWidth={2.2} />}
        </Tap>
      </View>
      {wrap ? (
        <View style={{ paddingHorizontal: space.md, paddingBottom: space.md }}>{body}</View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.md, paddingBottom: space.md }}>
          {body}
        </ScrollView>
      )}
      {lineCount > FOLD_LINES + 5 && (
        <Tap
          onPress={() => setOpen(!open)}
          feel="select"
          sink={1}
          accessibilityLabel={open ? "Show less" : "Show all " + lineCount + " lines"}
          accessibilityState={{ expanded: open }}
          style={{ minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }}
        >
          <Text style={[scale.footnote, { color: colors.accentText, fontWeight: "600" }]}>{open ? "Show less" : "Show all " + lineCount + " lines"}</Text>
          <ChevronDown size={14} color={colors.accentText} strokeWidth={2.4} style={open ? { transform: [{ rotate: "180deg" }] } : undefined} />
        </Tap>
      )}
    </View>
  );
});

const CALLOUT = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/i;
type CalloutKind = "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION";
const CALLOUT_ICON: Record<CalloutKind, LucideIcon> = { NOTE: Info, TIP: Lightbulb, IMPORTANT: MessageSquareWarning, WARNING: TriangleAlert, CAUTION: OctagonAlert };
const calloutColor = (colors: Colors, kind: CalloutKind) => ({ NOTE: colors.info, TIP: colors.success, IMPORTANT: colors.accentText, WARNING: colors.warning, CAUTION: colors.danger })[kind];

function headingStyle(depth: number, base: TextStyle, scale: TypeScale): TextStyle {
  const small = (base.fontSize ?? 16) < scale.callout.fontSize;
  const variant = small ? (depth <= 1 ? scale.headline : scale.subhead) : depth <= 1 ? scale.title3 : depth === 2 ? scale.headline : scale.callout;
  return { ...base, fontSize: variant.fontSize, lineHeight: variant.lineHeight, fontWeight: "700", marginTop: depth <= 2 ? 4 : 0 };
}

// A table always fits the width it is given: each column gets a share by how much it holds, never
// less than its longest word needs, and text wraps inside its cell. Only when even the narrowest
// columns can't fit side by side (many columns on a phone) does the table scroll sideways.
const cellChars = (cell: Tokens.TableCell | undefined) => {
  const text = cell?.text ?? "";
  return { word: Math.max(0, ...text.split(/\s+/).map((word) => word.length)), longest: text.length };
};

function TableBlock({ table, ctx, k }: { table: Tokens.Table; ctx: Ctx; k: string }) {
  const { colors, scale, base } = ctx;
  const [room, setRoom] = useState(0);
  const cellText: TextStyle = { ...base, fontSize: scale.footnote.fontSize, lineHeight: scale.footnote.lineHeight };
  const columns = table.header.map((head, c) => {
    const cells = [cellChars(head), ...table.rows.map((row) => cellChars(row[c]))];
    return { word: Math.max(...cells.map((cell) => cell.word)), longest: Math.max(...cells.map((cell) => cell.longest)) };
  });
  // Bold header text runs a little wider than the body, so the estimate leans wide.
  const { widths, scroll } = tableWidths(columns, room, scale.footnote.fontSize * 0.58);
  const cell = (content: Tokens.TableCell | undefined, column: number, header: boolean, ck: string) => (
    <View key={ck} style={{ width: widths[column], paddingHorizontal: CELL_PAD, paddingVertical: 8 }}>
      <Text selectable style={[cellText, header && { fontWeight: "700" }, { textAlign: table.align[column] ?? "left" }]}>
        {content ? inline(content.tokens, ctx, ck) : null}
      </Text>
    </View>
  );
  const grid = (
    <View>
      <View style={{ flexDirection: "row", backgroundColor: colors.sunken }}>{table.header.map((content, c) => cell(content, c, true, k + "h" + c))}</View>
      {table.rows.map((row, r) => (
        <View key={r} style={{ flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
          {table.header.map((_, c) => cell(row[c], c, false, k + "r" + r + "c" + c))}
        </View>
      ))}
    </View>
  );
  return (
    <View
      onLayout={(event) => setRoom(Math.floor(event.nativeEvent.layout.width - 2 * StyleSheet.hairlineWidth))}
      style={{ alignSelf: "stretch", borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface, overflow: "hidden", opacity: room ? 1 : 0 }}
    >
      {scroll ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {grid}
        </ScrollView>
      ) : (
        grid
      )}
    </View>
  );
}

function blocks(tokens: Token[], ctx: Ctx, key = "b"): ReactNode[] {
  const out: ReactNode[] = [];
  tokens.forEach((token, index) => {
    const node = block(token, ctx, key + index);
    if (node) out.push(node);
  });
  return out;
}

function block(token: Token, ctx: Ctx, k: string): ReactNode {
  const { colors, base, scale } = ctx;
  switch (token.type) {
    case "space":
    case "checkbox":
      return null;
    case "heading": {
      const heading = token as Tokens.Heading;
      return (
        <Text key={k} accessibilityRole="header" selectable style={headingStyle(heading.depth, base, scale)}>
          {inline(heading.tokens, ctx, k)}
        </Text>
      );
    }
    case "paragraph":
      return (
        <Text key={k} selectable style={base}>
          {inline((token as Tokens.Paragraph).tokens, ctx, k)}
        </Text>
      );
    case "text": {
      const text = token as Tokens.Text;
      return (
        <Text key={k} selectable style={base}>
          {text.tokens ? inline(text.tokens, ctx, k) : unescape(text.text)}
        </Text>
      );
    }
    case "code": {
      const code = token as Tokens.Code;
      return <CodeBlock key={k} code={code.text} lang={code.lang?.split(/\s/)[0]} closed={fenceClosed(code.raw)} highlight={ctx.highlight} wrap={ctx.wrap} colors={colors} paths={ctx.paths} />;
    }
    case "blockquote": {
      const quote = token as Tokens.Blockquote;
      const kind = CALLOUT.exec(quote.text)?.[1]?.toUpperCase() as CalloutKind | undefined;
      const tone = kind ? calloutColor(colors, kind) : colors.lineStrong;
      const inner = kind ? lex(quote.text.replace(CALLOUT, "")) : quote.tokens;
      const Icon = kind ? CALLOUT_ICON[kind] : undefined;
      return (
        <View key={k} style={{ borderLeftWidth: 3, borderLeftColor: tone, paddingLeft: space.md, gap: 6 }}>
          {kind && Icon && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Icon size={15} color={tone} strokeWidth={2.4} />
              <Text style={[scale.label, { color: tone }]}>{kind.charAt(0) + kind.slice(1).toLowerCase()}</Text>
            </View>
          )}
          {blocks(inner, { ...ctx, base: { ...base, color: kind ? colors.ink : colors.ink2 } }, k)}
        </View>
      );
    }
    case "list": {
      const list = token as Tokens.List;
      const start = Number(list.start || 1);
      return (
        <View key={k} style={{ gap: 6 }} accessibilityRole="list">
          {list.items.map((item, i) => (
            <View key={i} style={{ flexDirection: "row", gap: space.sm }}>
              {item.task ? (
                <View
                  accessibilityLabel={item.checked ? "Done" : "Not done"}
                  style={{ width: 18, height: 18, marginTop: Math.max(0, ((base.lineHeight ?? 22) - 18) / 2), borderRadius: 5, borderWidth: 1.5, borderColor: item.checked ? colors.accent : colors.lineStrong, backgroundColor: item.checked ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}
                >
                  {item.checked && <Check size={12} color={colors.onAccent} strokeWidth={3} />}
                </View>
              ) : (
                <Text style={[base, { color: colors.muted, minWidth: list.ordered ? 22 : 12, textAlign: list.ordered ? "right" : "center" }]}>{list.ordered ? start + i + "." : "•"}</Text>
              )}
              <View style={{ flex: 1, minWidth: 0, gap: 6 }}>{blocks(item.tokens, ctx, k + "-" + i)}</View>
            </View>
          ))}
        </View>
      );
    }
    case "table":
      return <TableBlock key={k} table={token as Tokens.Table} ctx={ctx} k={k} />;
    case "hr":
      return <View key={k} style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong, marginVertical: 4 }} />;
    default:
      // Block HTML and anything unknown stays as the text that was written.
      if ("raw" in token && String(token.raw).trim())
        return (
          <Text key={k} selectable style={base}>
            {String(token.raw).trim()}
          </Text>
        );
      return null;
  }
}

/** One top-level block. It renders again only when its own source changes (or the look does). */
const Block = memo(function Block({ token, ctx, index }: { token: Token; ctx: Ctx; index: number }) {
  return <>{block(token, ctx, "b" + index)}</>;
});

const Footnotes = memo(function Footnotes({ notes, ctx }: { notes: Footnote[]; ctx: Ctx }) {
  const small: Ctx = { ...ctx, base: { ...ctx.base, ...ctx.scale.footnote, color: ctx.colors.muted } };
  const ordered = [...notes].sort((a, b) => (ctx.notes.get(a.id) ?? 0) - (ctx.notes.get(b.id) ?? 0));
  return (
    <View style={{ gap: 6, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ctx.colors.line }} accessibilityLabel="Footnotes">
      {ordered.map((note) => (
        <View key={note.id} style={{ flexDirection: "row", gap: 6 }}>
          <Text style={[small.base, { minWidth: 20 }]}>{(ctx.notes.get(note.id) ?? "?") + "."}</Text>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>{blocks(lex(note.text), small, "n" + note.id)}</View>
        </View>
      ))}
    </View>
  );
});

// ---------------------------------------------------------------------------------------------
// Inline-only text (a person's own message): links and inline code, nothing else.

const INLINE = /\[((?:\\.|[^\]\\\n])+)\]\((https?:\/\/[^\s)]+)\)|`([^`\n]+)`|(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]])/g;

function InlineOnly({ text, base, paths, plain }: { text: string; base: TextStyle; paths?: PathLinks; plain?: boolean }) {
  const scale = useTheme().type;
  const openLink = useContext(MessageLink);
  const hold = useContext(LinkHold);
  // A person's bubble has its own text color; a path in it is underlined in that color.
  const linkColor = String(base.color ?? "");
  const parts = useMemo(() => {
    const out: ReactNode[] = [];
    let last = 0;
    INLINE.lastIndex = 0;
    for (let match = INLINE.exec(text); match; match = INLINE.exec(text)) {
      if (plain && !pullRequestUrl(match[2] ?? match[4])) continue;
      if (match.index > last) out.push(withPaths(text.slice(last, match.index), paths, linkColor, "t" + last));
      const k = "u" + match.index;
      const code = match[3];
      if (code !== undefined)
        out.push(
          <Text
            key={k}
            style={[scale.mono, { fontSize: (base.fontSize ?? scale.callout.fontSize) - 2, lineHeight: undefined, color: base.color }, !!paths?.has(code) && { textDecorationLine: "underline" }]}
            {...(paths?.has(code) && { onPress: () => paths.open(code), accessibilityRole: "link" as const })}
          >
            {code}
          </Text>,
        );
      else {
        const href = match[2] ?? match[4];
        out.push(
          <Text key={k} style={{ textDecorationLine: "underline", fontWeight: "600" }} {...linkPress(hold, href, () => openLink(href))} accessibilityRole="link">
            {plain ? match[0] : match[1]?.replace(/\\([[\]\\])/g, "$1") ?? match[4]}
          </Text>,
        );
      }
      last = match.index + match[0].length;
    }
    if (last < text.length) out.push(withPaths(text.slice(last), paths, linkColor, "t" + last));
    return out;
  }, [text, base, paths, linkColor, hold, scale, openLink, plain]);
  return (
    <Text selectable maxFontSizeMultiplier={1.35} style={base}>
      {parts}
    </Text>
  );
}

// ---------------------------------------------------------------------------------------------

export type MarkdownProps = {
  text: string;
  /** The text color. Defaults to the theme's ink. */
  color?: string;
  /** "body" for chat messages, "small" for cards and panels. */
  size?: "body" | "small";
  /** Shows the text as written, without Markdown. */
  plain?: boolean;
  /** Only links and inline code, for a person's own message. */
  inline?: boolean;
  /** Colors code blocks. Defaults to the chat setting. */
  highlight?: boolean;
  /** Wraps long code lines instead of scrolling sideways. Defaults to the chat setting. */
  wrapCode?: boolean;
  /** Paths that open something on a tap (a chat's artifacts). */
  paths?: PathLinks;
  /** The text is still arriving. Only blocks followed by a blank-line separator are cached. */
  streaming?: boolean;
};

/** Renders Markdown. Safe to re-render while a reply streams in. */
export const Markdown = memo(function Markdown({ text, color, size = "body", plain, inline: inlineOnly, highlight, wrapCode, paths, streaming = false }: MarkdownProps) {
  const { colors, type: scale } = useTheme();
  const openLink = useContext(MessageLink);
  const hold = useContext(LinkHold);
  const prefHighlight = useChatPrefs((prefs) => prefs.highlight);
  const prefWrap = useChatPrefs((prefs) => prefs.wrapCode);
  const doHighlight = highlight ?? prefHighlight;
  const wrap = wrapCode ?? prefWrap;
  const base = useMemo<TextStyle>(() => ({ ...(size === "small" ? scale.subhead : scale.callout), color: color ?? colors.ink }), [size, color, colors, scale]);
  const streamCache = useRef<MarkdownStreamCache | undefined>(undefined);

  const parsed = useMemo(() => {
    if (plain || inlineOnly) return null;
    const { body, notes } = splitFootnotes(text);
    if (!streaming) {
      streamCache.current = undefined;
      const tokens = lex(body);
      return { tokens, notes, numbers: numberNotes(body, notes) };
    }
    const result = parseStreamingMarkdown(body, lex, streamCache.current, notes.length > 0);
    streamCache.current = result.cache;
    return { tokens: result.tokens, notes, numbers: numberNotes(body, notes) };
  }, [text, plain, inlineOnly, streaming]);
  // The numbering changes only when a new footnote appears, so blocks keep their memo while text streams.
  const noteKey = parsed ? [...parsed.numbers.keys()].join("\u0000") : "";
  const ctx = useMemo<Ctx>(() => {
    const notes = new Map<string, number>(noteKey ? noteKey.split("\u0000").map((id, index) => [id, index + 1]) : []);
    return { colors, scale, base, highlight: doHighlight, wrap, notes, onLink: openLink, hold, paths };
  }, [colors, scale, base, doHighlight, wrap, noteKey, hold, paths, openLink]);

  if (inlineOnly || (plain && openLink !== defaultOpenLink)) return <InlineOnly text={text} base={base} paths={paths} plain={!inlineOnly && plain} />;
  if (!parsed)
    return (
      <Text selectable maxFontSizeMultiplier={1.35} style={base}>
        {withPaths(text, paths, colors.accentText, "plain")}
      </Text>
    );
  return (
    <View style={{ gap: 10 }}>
      {parsed.tokens.map((token, index) => (token.type === "space" ? null : <Block key={index} token={token} ctx={ctx} index={index} />))}
      {parsed.notes.length > 0 && <Footnotes notes={parsed.notes} ctx={ctx} />}
    </View>
  );
});
