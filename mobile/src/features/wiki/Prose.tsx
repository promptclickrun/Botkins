// A wiki page's Markdown, set for reading: larger text, roomy lines, and links the page decides about.
// It follows @/ui's Markdown block for block; that one opens web links only, and a wiki page also
// links to other pages.
import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import { marked, type Token, type Tokens } from "marked";
import { memo, type ReactNode, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, type TextStyle, View } from "react-native";
import { haptic, radius, Tap, type Theme, type TypeScale, useTheme } from "@/ui";
import { plainNames } from "./model";

type Colors = Theme["colors"];
export type LinkKind = "page" | "missing" | "web";
type Ctx = { colors: Colors; scale: TypeScale; base: TextStyle & { fontSize: number }; onLink?: (href: string, label: string) => void; kindOf?: (href: string) => LinkKind };

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
      case "codespan":
        return (
          <Text key={k} style={[ctx.scale.mono, { fontSize: ctx.base.fontSize - 3, backgroundColor: ctx.colors.sunken, color: ctx.colors.ink }]}>
            {"\u00A0" + unescape((token as Tokens.Codespan).text) + "\u00A0"}
          </Text>
        );
      case "link":
      case "image": {
        const link = token as Tokens.Link | Tokens.Image;
        const label = unescape(link.text || link.href);
        const missing = ctx.kindOf?.(link.href) === "missing";
        return (
          <Text
            key={k}
            style={{ color: missing ? ctx.colors.muted : ctx.colors.accentText, textDecorationLine: "underline", textDecorationStyle: missing ? "dotted" : "solid" }}
            onPress={ctx.onLink ? () => ctx.onLink?.(link.href, label) : undefined}
            accessibilityRole="link"
            accessibilityHint={missing ? "Not written yet" : undefined}
          >
            {token.type === "image" ? label : inline((link as Tokens.Link).tokens, ctx, k)}
          </Text>
        );
      }
      case "br":
        return "\n";
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens ? inline(text.tokens, ctx, k) : unescape(text.text);
      }
      case "escape":
        return (token as Tokens.Escape).text;
      default:
        return "raw" in token ? String(token.raw) : null;
    }
  });
}

function CodeBlock({ code, lang, colors, scale }: { code: string; lang?: string; colors: Colors; scale: TypeScale }) {
  const [copied, setCopied] = useState(false);
  return (
    <View style={{ borderRadius: radius.md, backgroundColor: colors.sunken, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 12, paddingRight: 4, height: 36 }}>
        <Text style={[scale.caption, { color: colors.muted }]}>{lang || "code"}</Text>
        <Tap
          accessibilityLabel="Copy code"
          feel="none"
          onPress={() => {
            void Clipboard.setStringAsync(code);
            haptic.success();
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          style={{ width: 44, height: 36, alignItems: "center", justifyContent: "center" }}
        >
          {copied ? <Check size={15} color={colors.success} strokeWidth={2.4} /> : <Copy size={15} color={colors.muted} strokeWidth={2.2} />}
        </Tap>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12 }}>
        <Text selectable style={[scale.mono, { color: colors.ink }]}>
          {code.replace(/\n$/, "")}
        </Text>
      </ScrollView>
    </View>
  );
}

const CALLOUT = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i;

function blocks(tokens: Token[], ctx: Ctx, key = "b"): ReactNode[] {
  const { colors, base, scale } = ctx;
  const out: ReactNode[] = [];
  tokens.forEach((token, index) => {
    const k = key + index;
    switch (token.type) {
      case "space":
        return;
      case "heading": {
        const heading = token as Tokens.Heading;
        const size = Math.round(base.fontSize * (heading.depth <= 1 ? 1.4 : heading.depth === 2 ? 1.18 : 1.06));
        out.push(
          <Text key={k} accessibilityRole="header" style={[base, { fontSize: size, lineHeight: size + 7, fontWeight: "700", marginTop: heading.depth <= 2 ? 10 : 4 }]}>
            {inline(heading.tokens, ctx, k)}
          </Text>,
        );
        return;
      }
      case "paragraph":
        out.push(
          <Text key={k} selectable style={base}>
            {inline((token as Tokens.Paragraph).tokens, ctx, k)}
          </Text>,
        );
        return;
      case "text": {
        const text = token as Tokens.Text;
        out.push(
          <Text key={k} selectable style={base}>
            {text.tokens ? inline(text.tokens, ctx, k) : unescape(text.text)}
          </Text>,
        );
        return;
      }
      case "code": {
        const code = token as Tokens.Code;
        out.push(<CodeBlock key={k} code={code.text} lang={code.lang?.split(/\s/)[0]} colors={colors} scale={scale} />);
        return;
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        const kind = CALLOUT.exec(quote.text)?.[1]?.toUpperCase();
        const tone = kind === "WARNING" || kind === "CAUTION" ? colors.warning : kind === "TIP" ? colors.success : kind ? colors.info : colors.lineStrong;
        const inner = kind ? (marked.lexer(quote.text.replace(CALLOUT, "")) as Token[]) : quote.tokens;
        out.push(
          <View key={k} style={{ borderLeftWidth: 3, borderLeftColor: tone, paddingLeft: 14, gap: 8 }}>
            {kind && <Text style={[scale.label, { color: tone }]}>{kind.charAt(0) + kind.slice(1).toLowerCase()}</Text>}
            {blocks(inner, { ...ctx, base: { ...base, color: kind ? colors.ink : colors.ink2 } }, k)}
          </View>,
        );
        return;
      }
      case "list": {
        const list = token as Tokens.List;
        out.push(
          <View key={k} style={{ gap: 8 }}>
            {list.items.map((item, i) => (
              <View key={i} style={{ flexDirection: "row", gap: 10 }}>
                {item.task ? (
                  <View style={{ width: 19, height: 19, marginTop: 4, borderRadius: 5, borderWidth: 1.5, borderColor: item.checked ? colors.accent : colors.lineStrong, backgroundColor: item.checked ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
                    {item.checked && <Check size={12} color={colors.onAccent} strokeWidth={3} />}
                  </View>
                ) : (
                  <Text style={[base, { color: colors.muted, minWidth: list.ordered ? 22 : 12, textAlign: list.ordered ? "right" : "center" }]}>{list.ordered ? Number(list.start || 1) + i + "." : "•"}</Text>
                )}
                <View style={{ flex: 1, gap: 8 }}>{blocks(item.tokens, ctx, k + "-" + i)}</View>
              </View>
            ))}
          </View>,
        );
        return;
      }
      case "table": {
        const table = token as Tokens.Table;
        const cell = (content: Tokens.TableCell, header: boolean, ck: string) => (
          <View key={ck} style={{ minWidth: 96, maxWidth: 240, paddingHorizontal: 12, paddingVertical: 9 }}>
            <Text style={[base, { fontSize: base.fontSize - 2, lineHeight: Math.round((base.fontSize - 2) * 1.4) }, header && { fontWeight: "700" }]}>{inline(content.tokens, ctx, ck)}</Text>
          </View>
        );
        out.push(
          <ScrollView key={k} horizontal showsHorizontalScrollIndicator={false} style={{ borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface }}>
            <View>
              <View style={{ flexDirection: "row", backgroundColor: colors.sunken }}>{table.header.map((content, c) => cell(content, true, k + "h" + c))}</View>
              {table.rows.map((row, r) => (
                <View key={r} style={{ flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
                  {row.map((content, c) => cell(content, false, k + "r" + r + "c" + c))}
                </View>
              ))}
            </View>
          </ScrollView>,
        );
        return;
      }
      case "hr":
        out.push(<View key={k} style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong, marginVertical: 6 }} />);
        return;
      default:
        if ("raw" in token && String(token.raw).trim())
          out.push(
            <Text key={k} selectable style={base}>
              {String(token.raw).trim()}
            </Text>,
          );
    }
  });
  return out;
}

/** Drops the page's own first "# " heading: the screen shows the title itself. */
function withoutTitle(tokens: Token[]) {
  const first = tokens.findIndex((token) => token.type !== "space");
  const head = tokens[first];
  return head?.type === "heading" && (head as Tokens.Heading).depth === 1 ? tokens.filter((_, index) => index !== first) : tokens;
}

export type ProseProps = {
  text: string;
  onLink?: (href: string, label: string) => void;
  kindOf?: (href: string) => LinkKind;
  /** Leaves out the first "# " heading when the screen already shows the title. */
  hideTitle?: boolean;
};

export const Prose = memo(function Prose({ text, onLink, kindOf, hideTitle }: ProseProps) {
  const { colors, type: scale } = useTheme();
  const tokens = useMemo(() => {
    const all = marked.lexer(plainNames(text), { gfm: true }) as Token[];
    return hideTitle ? withoutTitle(all) : all;
  }, [text, hideTitle]);
  // Reading text: one point above body, with room between the lines.
  const size = scale.body.fontSize + 1;
  const base = { ...scale.body, fontSize: size, lineHeight: Math.round(size * 1.6), color: colors.ink };
  return <View style={{ gap: 14 }}>{blocks(tokens, { colors, scale, base, onLink, kindOf })}</View>;
});
