// What is in a space: its panels (small ones two up, an app right in its card) and its cards (Feed,
// Ideas, Goals). Shown on the space's own page and, for a pinned space, in place on Home.
import { Maximize2 } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { ItemCard } from "@/features/today/Today";
import type { Bot, PanelView, SpaceSummary } from "@/link/types";
import { myself } from "@/features/chat/people";
import { useBots, useCan, usePart } from "@/state/hooks";
import { ago } from "@/state/time";
import { Badge, Blocks, BotAvatar, Dot, EmptyState, lift, Loading, Mascot, radius, space, T, Tap, useTheme } from "@/ui";
import { markSeen, openNewPanel, openPanel, panelState, useSpaceContent } from "./data";
import { changedLine, changedSince, lastLine, panelRows } from "./logic";

const isApp = (panel: Pick<PanelView, "blocks">) => panel.blocks.some((block) => block.type === "html");

function Card({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const { colors } = theme;
  return <View style={[{ flex: 1, minWidth: 0, padding: space.lg, gap: space.md, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }, lift(theme)]}>{children}</View>;
}

/** A panel in its space. Its heading opens it; an app panel runs right here. `half`: it shares its row with another small panel. */
export function PanelCard({ panel, bot, changed, half, space: summary }: { panel: PanelView; bot?: Bot; changed: boolean; half: boolean; space: SpaceSummary }) {
  const { colors } = useTheme();
  const canUse = useCan("today", "use");
  const spaceId = summary.id;
  // An app keeps what people do in it: its state, and a way to change it for those who may act here.
  const state = isApp(panel) ? panelState(panel, summary, canUse) : undefined;
  const last = lastLine(panel.last, ago);
  const open = () => openPanel(spaceId, panel.id);
  const label = panel.title + (changed ? ", changed" : "") + ", open";
  return (
    <Card>
      {half ? (
        <Tap onPress={open} feel="select" sink={0.98} accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 28 }}>
          <T variant="footnote" color="muted" numberOfLines={2} style={{ flex: 1 }}>
            {panel.title}
          </T>
          {changed && <Dot size={8} />}
        </Tap>
      ) : (
        <Tap onPress={open} feel="select" sink={0.99} accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <BotAvatar bot={bot} size={32} badge={false} />
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <T variant="headline" numberOfLines={2} accessibilityRole="header">
              {panel.title}
            </T>
            <T variant="footnote" color="muted" numberOfLines={1}>
              {[bot?.name, "Updated " + ago(panel.updatedAt)].filter(Boolean).join(" · ")}
            </T>
          </View>
          {changed && <Dot size={8} />}
          {isApp(panel) && <Badge label="App" />}
          <Maximize2 size={16} color={colors.muted} strokeWidth={2.2} />
        </Tap>
      )}
      <Blocks blocks={panel.blocks} title={panel.title} state={state} />
      {!!last && (
        <T variant="footnote" color="faint" numberOfLines={2}>
          {last}
        </T>
      )}
    </Card>
  );
}

/**
 * A space's content. `visit`: the person is on the space itself, so it counts as seen (its dots
 * clear the next time). On Home it is only shown in place, and stays unseen until opened.
 */
export function SpaceView({ space: summary, visit }: { space: SpaceSummary; visit?: boolean }) {
  const { content, error, loading, retry } = useSpaceContent(summary.id);
  const allBots = useBots();
  const canCreate = useCan("today", "create");
  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const rev = content?.rev;
  useEffect(() => {
    // Seen once its content is on screen; again when it changes while the person is here.
    if (visit && rev !== undefined) markSeen(summary.id);
  }, [visit, rev, summary.id]);

  const panels = useMemo(() => (content?.panels ?? []).filter((panel) => !panel.hidden), [content]);
  const cards = useMemo(() => (content?.cards ?? []).filter((card) => card.status === "open").sort((a, b) => Number(a.read) - Number(b.read) || b.createdAt - a.createdAt), [content]);
  const seenAt = content?.seenAt ?? 0;
  const me = myself(usePart("meta"));
  const changed = useMemo(() => changedSince(panels, seenAt, me), [panels, seenAt, me]);
  const line = changedLine(panels, seenAt, Date.now(), me);
  const mayAdd = canCreate && (summary.can === "own" || summary.can === "edit");

  if (loading) return <Loading />;
  if (!content) return <EmptyState title={error ?? "Couldn't open this space."} action="Try again" onAction={retry} />;
  if (!panels.length && !cards.length)
    return <EmptyState art={<Mascot size={96} />} title={summary.builtin && summary.builtin !== "today" ? "Nothing here yet" : "Build your first panel"} action={mayAdd ? "Add panel" : undefined} onAction={mayAdd ? () => openNewPanel(summary.id) : undefined} />;

  return (
    <View style={{ gap: space.md }}>
      {!!line && (
        <T variant="footnote" color="muted">
          {line}
        </T>
      )}
      {panelRows(panels).map((row) => (
        <View key={row.map((panel) => panel.id).join("+")} style={{ flexDirection: "row", gap: space.md }}>
          {row.map((panel) => (
            <PanelCard key={panel.id} panel={panel} bot={bots.get(panel.botId)} changed={changed.has(panel.id)} half={row.length > 1} space={summary} />
          ))}
        </View>
      ))}
      {cards.map((card) => (
        <ItemCard key={card.id} item={card} bot={bots.get(card.botId)} />
      ))}
    </View>
  );
}
