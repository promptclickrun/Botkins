// Shared visual pieces for Settings › Channels: brand-colored channel kind tiles,
// glass/clean adaptive cards, tinted status badges with optional live dot, sender avatars,
// and owner-only guard.
import { AlertCircle, type LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import type { ChannelKind } from "@/link/types";
import { usePart } from "@/state/hooks";
import { usePrefs } from "@/state/prefs";
import { Badge, Dot, EmptyState, Glass, Page, radius, Sheet, space, T, tint, type Tone, useTheme } from "@/ui";
import { CHANNEL_KIND_SPECS, initialsOf, type StatusDisplay } from "./logic";

/**
 * Brand-colored square tile with the channel kind mark (matching the v2 mockups).
 * Drawn with inline react-native-svg (existing dependency), no extra deps.
 */
export function ChannelKindTile({ kind, size = 38 }: { kind: ChannelKind; size?: number }) {
  const spec = CHANNEL_KIND_SPECS[kind];
  const bg = spec?.brandColor ?? "#4A154B";
  const glyph = Math.round(size * 0.54);
  const corner = Math.round(size * 0.29);

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: corner,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="#FFFFFF">
        {kind === "slack" && (
          <>
            <Rect x={10} y={2} width={4} height={9} rx={2} fill="#FFFFFF" />
            <Rect x={10} y={13} width={4} height={9} rx={2} fill="#FFFFFF" />
            <Rect x={2} y={10} width={9} height={4} rx={2} fill="#FFFFFF" />
            <Rect x={13} y={10} width={9} height={4} rx={2} fill="#FFFFFF" />
          </>
        )}
        {kind === "telegram" && (
          <Path
            d="M21 4.5L2.8 11.4c-1 .4-1 1.6.1 1.9l4.6 1.4 1.8 5.4c.3.8 1.3 1 1.9.4l2.6-2.4 4.6 3.4c.7.5 1.7.1 1.9-.8L22.6 6c.3-1.1-.7-1.9-1.6-1.5zM9.6 14.3l8-6.7-6.2 7.8-.3 3z"
            fill="#FFFFFF"
          />
        )}
        {kind === "discord" && (
          <Path
            d="M19 5.6A16 16 0 0015 4.4l-.5 1a14.6 14.6 0 00-5 0l-.5-1a16 16 0 00-4 1.2C2.6 9.4 1.9 13 2.2 16.6a16 16 0 004.9 2.5l1-1.6a10.4 10.4 0 01-1.6-.8l.4-.3a11.4 11.4 0 0010.2 0l.4.3-1.6.8 1 1.6a16 16 0 004.9-2.5c.4-4.2-.7-7.8-2.8-11zM8.8 14.4c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2zm6.4 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2z"
            fill="#FFFFFF"
          />
        )}
        {kind === "imessage" && (
          <Path
            d="M12 3C6.5 3 2 6.8 2 11.4c0 2.6 1.4 4.9 3.7 6.4L5 21l3.6-1.9c1.1.3 2.2.4 3.4.4 5.5 0 10-3.8 10-8.4S17.5 3 12 3z"
            fill="#FFFFFF"
          />
        )}
      </Svg>
    </View>
  );
}

/**
 * Adaptive surface card: frosted Liquid Glass over Mesh/non-clean backdrops,
 * clean flat card with hairline border on the Clean backdrop (and dark mode).
 */
export function SurfaceCard({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, dark } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  if (hasBackdrop) {
    return (
      <Glass
        tintColor={tint(colors.surface, dark ? 0.3 : 0.44)}
        style={[{ borderRadius: radius.lg, overflow: "hidden" }, style]}
      >
        {children}
      </Glass>
    );
  }
  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderRadius: radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Tinted pill status badge with optional live dot matching v2 mockups. */
export function StatusPill({
  status,
  detail,
}: {
  status: StatusDisplay;
  detail?: boolean;
}) {
  const { colors } = useTheme();
  const toneColors: Record<Tone, [string, string]> = {
    neutral: [colors.sunken, colors.ink2],
    accent: [colors.accentSoft, colors.accentText],
    success: [colors.successSoft, colors.success],
    warning: [colors.warningSoft, colors.warning],
    danger: [colors.dangerSoft, colors.danger],
    info: [colors.infoSoft, colors.info],
  };
  const [bg, fg] = toneColors[status.tone];
  const label = detail ? status.detailLabel : status.pillLabel;
  return (
    <View
      style={{
        alignSelf: "flex-start",
        minHeight: 24,
        paddingHorizontal: 9,
        borderRadius: radius.pill,
        backgroundColor: bg,
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
      }}
    >
      {status.dot && <Dot tone={status.tone} size={6} />}
      <T variant="caption" weight="600" color={fg} numberOfLines={1}>
        {label}
      </T>
    </View>
  );
}

/** Small tinted pill badge (rounded pill shape for waiting counts, activity tags, time left). */
export function PillBadge({
  label,
  tone = "neutral",
  icon,
}: {
  label: string;
  tone?: Tone;
  icon?: LucideIcon;
}) {
  const { colors } = useTheme();
  if (icon) return <Badge label={label} tone={tone} icon={icon} />;
  const [bg, fg] = {
    neutral: [colors.sunken, colors.ink2],
    accent: [colors.accentSoft, colors.accentText],
    success: [colors.successSoft, colors.success],
    warning: [colors.warningSoft, colors.warning],
    danger: [colors.dangerSoft, colors.danger],
    info: [colors.infoSoft, colors.info],
  }[tone];
  return (
    <View
      style={{
        alignSelf: "flex-start",
        minHeight: 22,
        paddingHorizontal: 8,
        borderRadius: radius.pill,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <T variant="caption" weight="600" color={fg} numberOfLines={1}>
        {label}
      </T>
    </View>
  );
}

const AVATAR_PALETTE = [
  "#E65100",
  "#1D6FE0",
  "#7B3FE4",
  "#1F9D57",
  "#C2185B",
  "#00838F",
  "#5D4037",
];

function colorForSeed(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

/** Initials avatar circle for senders on Who can DM. */
export function SenderAvatar({
  name,
  seed,
  size = 38,
  owner,
}: {
  name: string;
  seed?: string;
  size?: number;
  owner?: boolean;
}) {
  const { colors } = useTheme();
  const bg = owner ? colors.primary : colorForSeed(seed || name);
  const fg = owner ? colors.onPrimary : "#FFFFFF";
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <T variant="caption" weight="700" color={fg}>
        {initialsOf(name)}
      </T>
    </View>
  );
}

/** Returns true when the current paired device is the owner (channels are strictly owner-only). */
export function useIsChannelsOwner(): boolean {
  const you = usePart("meta")?.you;
  return you?.kind !== "member";
}

export function OwnerOnlyPage({ title }: { title: string }) {
  return (
    <Page title={title}>
      <EmptyState
        icon={AlertCircle}
        title="Only the owner can manage channels"
        text="External messaging connections and tokens are managed on the owner's devices."
      />
    </Page>
  );
}

export function OwnerOnlySheet({ title }: { title: string }) {
  return (
    <Sheet title={title}>
      <EmptyState
        icon={AlertCircle}
        title="Only the owner can manage channels"
        text="External messaging connections and tokens are managed on the owner's devices."
      />
    </Sheet>
  );
}

/** Compact step progress bar for the 3-step Add Channel sheet. */
export function StepProgressBar({ step, total = 3 }: { step: number; total?: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <View style={{ flex: 1, flexDirection: "row", gap: 6 }}>
        {Array.from({ length: total }, (_, idx) => {
          const active = idx < step;
          return (
            <View
              key={idx}
              style={{
                flex: 1,
                height: 3.5,
                borderRadius: 2,
                backgroundColor: active ? colors.primary : colors.lineStrong,
              }}
            />
          );
        })}
      </View>
      <T variant="footnote" weight="600" color="muted">
        {`${step} of ${total}`}
      </T>
    </View>
  );
}
