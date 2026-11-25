// The blocks a bot publishes in a Today panel or a card in a chat: metrics, lists, tables, charts.
import { ScrollView, StyleSheet, View } from "react-native";
import Svg, { Polyline } from "react-native-svg";
import type { PanelBlock } from "@/link/types";
import { Badge, type Tone } from "./Bits";
import { type FrameState, HtmlFrame } from "./HtmlFrame";
import { Markdown } from "./Markdown";
import { T } from "./Text";
import { brand, radius, space, useTheme } from "./theme";

const TONES: Record<string, Tone> = { neutral: "neutral", positive: "success", warning: "warning", negative: "danger", accent: "accent" };
const SERIES = [brand.clay, brand.tide, brand.honey, brand.fern, brand.rose];

function Block({ block, title, onAnswer, state, fill, bottom }: { block: PanelBlock; title?: string; onAnswer?: (text: string) => void; state?: FrameState; fill?: boolean; bottom?: number }) {
  const { colors } = useTheme();
  switch (block.type) {
    case "markdown":
      return <Markdown text={block.text} size="small" />;
    case "metric":
      return (
        <View style={{ gap: 2 }}>
          <T variant="footnote" color="muted">
            {block.label}
          </T>
          <T variant="title1">{block.value}</T>
          {!!block.note && (
            <T variant="footnote" color="muted">
              {block.note}
            </T>
          )}
        </View>
      );
    case "list":
      return (
        <View style={{ gap: 6 }}>
          {block.items.map((item, index) => (
            <View key={index} style={{ flexDirection: "row", gap: 8 }}>
              <T variant="subhead" color="faint">
                •
              </T>
              <T variant="subhead" style={{ flex: 1 }}>
                {item}
              </T>
            </View>
          ))}
        </View>
      );
    case "table":
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
          <View>
            <View style={{ flexDirection: "row", backgroundColor: colors.sunken }}>
              {block.columns.map((column, c) => (
                <T key={c} variant="footnote" weight="700" style={{ width: 120, paddingHorizontal: 10, paddingVertical: 8 }} numberOfLines={2}>
                  {column}
                </T>
              ))}
            </View>
            {block.rows.map((row, r) => (
              <View key={r} style={{ flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
                {row.map((cell, c) => (
                  <T key={c} variant="footnote" style={{ width: 120, paddingHorizontal: 10, paddingVertical: 8 }}>
                    {cell}
                  </T>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    case "bars": {
      const max = Math.max(1, ...block.items.map((item) => item.value));
      return (
        <View style={{ gap: space.sm }}>
          <T variant="footnote" color="muted">
            {block.label}
          </T>
          {block.items.map((item, index) => (
            <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }} accessibilityLabel={item.label + ", " + item.value}>
              <T variant="footnote" style={{ width: 72 }} numberOfLines={1}>
                {item.label}
              </T>
              <View style={{ flex: 1, height: 10, borderRadius: 5, backgroundColor: colors.sunken }}>
                <View style={{ width: `${Math.max(2, (item.value / max) * 100)}%`, height: 10, borderRadius: 5, backgroundColor: colors.accent }} />
              </View>
              <T variant="footnote" weight="600" style={{ minWidth: 30, textAlign: "right" }}>
                {String(item.value)}
              </T>
            </View>
          ))}
        </View>
      );
    }
    case "progress": {
      const part = block.max > 0 ? Math.max(0, Math.min(1, block.value / block.max)) : 0;
      return (
        <View style={{ gap: 6 }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(part * 100) }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <T variant="footnote" color="muted">
              {block.label}
            </T>
            <T variant="footnote" weight="600">
              {Math.round(part * 100)}%
            </T>
          </View>
          <View style={{ height: 10, borderRadius: 5, backgroundColor: colors.sunken }}>
            <View style={{ width: `${part * 100}%`, height: 10, borderRadius: 5, backgroundColor: colors.accent }} />
          </View>
          {!!block.note && (
            <T variant="footnote" color="muted">
              {block.note}
            </T>
          )}
        </View>
      );
    }
    case "badges":
      return (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {block.items.map((item, index) => (
            <Badge key={index} label={item.label} tone={TONES[item.tone] ?? "neutral"} />
          ))}
        </View>
      );
    case "line": {
      const all = block.series.flatMap((series) => series.values);
      const low = Math.min(...all, 0);
      const high = Math.max(...all, 1);
      const points = (values: number[]) => values.map((value, index) => `${values.length > 1 ? (index / (values.length - 1)) * 100 : 50},${38 - ((value - low) / (high - low || 1)) * 36}`).join(" ");
      return (
        <View style={{ gap: 6 }}>
          <T variant="footnote" color="muted">
            {block.label}
          </T>
          <Svg width="100%" height={84} viewBox="0 0 100 40" preserveAspectRatio="none">
            {block.series.map((series, index) => (
              <Polyline key={index} points={points(series.values)} fill="none" stroke={SERIES[index % SERIES.length]} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            ))}
          </Svg>
          {block.series.length > 1 && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
              {block.series.map((series, index) => (
                <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: SERIES[index % SERIES.length] }} />
                  <T variant="caption" color="muted">
                    {series.name}
                  </T>
                </View>
              ))}
            </View>
          )}
        </View>
      );
    }
    case "html":
      // A page the bot wrote, drawn in a web view that can't reach the network or the app.
      return <HtmlFrame frame={block.frame} height={block.height} title={title} onAnswer={onAnswer} state={state} fill={fill} inset={!fill} bottom={bottom} />;
    default:
      return null;
  }
}

/**
 * Draws a panel's or card's blocks, top to bottom. `title` names a custom view for VoiceOver, and
 * `onAnswer` takes the text such a view hands over (a chat puts it in its message box).
 */
export function Blocks({
  blocks,
  title,
  onAnswer,
  state,
  fill,
  bottom,
}: {
  blocks: PanelBlock[];
  title?: string;
  onAnswer?: (text: string) => void;
  /** A panel's saved state, for its app. */
  state?: FrameState;
  /** Let an HTML app block fill the available height on an opened panel page. */
  fill?: boolean;
  /** With `fill`, room under an app's page for what floats over it. */
  bottom?: number;
}) {
  return (
    <View style={[{ gap: space.lg }, fill && { flex: 1 }]}>
      {blocks.map((block, index) => (
        <Block key={block.type === "html" ? block.frame : index} block={block} title={title} onAnswer={onAnswer} state={state} fill={fill} bottom={bottom} />
      ))}
    </View>
  );
}
