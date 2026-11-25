import type { CSSProperties, ReactNode } from "react";
import { SegmentedControl, TabBar, type SegmentedControlProps, type TabBarProps } from "glisse";

/**
 * Computes a comfortable equal tab width in px for glisse's SegmentedControl / TabBar
 * so multi-word desktop labels never clip or wrap awkwardly.
 */
export function tabWidthFor(labels: readonly string[], min = 78, max = 148): number {
  const longest = labels.reduce((best, label) => Math.max(best, label.length), 0);
  return Math.min(max, Math.max(min, longest * 8 + 24));
}

export function GlassSegmented({
  items,
  style,
  minTabWidth = 74,
  ...rest
}: SegmentedControlProps & { minTabWidth?: number }) {
  const textLabels = items.map((item) => (typeof item.label === "string" ? item.label : ""));
  const tabWidth = tabWidthFor(textLabels, minTabWidth);
  const merged = { "--lg-tab-width": `${tabWidth}px`, ...style } as CSSProperties;
  return <SegmentedControl items={items} style={merged} {...rest} />;
}

export function GlassTabBar({
  items,
  style,
  minTabWidth = 88,
  labelTexts,
  ...tabProps
}: TabBarProps & { minTabWidth?: number; labelTexts?: string[] }) {
  const texts = labelTexts ?? items.map((item) => (typeof item.label === "string" ? item.label : ""));
  const tabWidth = tabWidthFor(texts, minTabWidth, 140);
  const merged = { "--lg-tab-width": `${tabWidth}px`, ...style } as CSSProperties;
  return <TabBar items={items} style={merged} {...tabProps} />;
}

export function buttonIcon(node: ReactNode) {
  return node;
}
