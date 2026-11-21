// What is in a space: its panels (small ones two up, an app right in its card) and its cards (Feed,
// Ideas, Goals). Shown on the space's own page and, for a pinned space, in place on Home.
import { Maximize2 } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { ItemCard } from "@/features/today/Today";
import type { Bot, PanelView, SpaceSummary } from "@/link/types";
import { myself } from "@/features/chat/people";
import { useBots, useCan, usePart } from "@/state/hooks";
import { ago } from "@/state/time";
import { Badge, Blocks, BotAvatar, Dot, EmptyState, lift, Loading, Mascot, radius, space, T, Tap, TwoUp, useShape, useTheme } from "@/ui";
import { markItemSeen, markSeen, openNewPanel, openPanel, panelState, useSeenMarks, useSpaceContent } from "./data";
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
  const open = () => {
    if (changed) markItemSeen(spaceId, panel.id, panel.updatedAt);
    openPanel(spaceId, panel.id);
  };
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
 * clear the next time). On Home it is shown in place, and counts as seen only once the person
 * `picked` its chip; its line and dots follow what was marked from the next `look` (Home came back
 * into view). A panel opened on its own loses its dot at once, wherever it is shown.
 */
export function SpaceView({ space: summary, visit, picked, look = 0 }: { space: SpaceSummary; visit?: boolean; picked?: boolean; look?: number }) {
  const { content, error, loading, retry } = useSpaceContent(summary.id);
  const allBots = useBots();
  const canCreate = useCan("today", "create");
  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const rev = content?.rev;
  useEffect(() => {
    // Seen once its content is on screen; again when it changes while the person is here.
    if ((visit || picked) && rev !== undefined) markSeen(summary.id);
  }, [visit, picked, rev, summary.id]);

  const panels = useMemo(() => (content?.panels ?? []).filter((panel) => !panel.hidden), [content]);
  const cards = useMemo(() => (content?.cards ?? []).filter((card) => card.status === "open").sort((a, b) => Number(a.read) - Number(b.read) || b.createdAt - a.createdAt), [content]);
  // What this phone marked since the read: the space as of this look, and each panel opened on its own.
  const marked = useSeenMarks((marks) => marks.spaces[summary.id] ?? 0);
  const [held, setHeld] = useState({ look, marked });
  if (held.look !== look) setHeld({ look, marked });
  const seenAt = Math.max(content?.seenAt ?? 0, visit ? 0 : held.marked);
  const items = useSeenMarks((marks) => marks.items);
  const opened = useMemo(() => ({ ...content?.seenItems, ...items }), [content?.seenItems, items]);
  const me = myself(usePart("meta"));
  const changed = useMemo(() => changedSince(panels, seenAt, me, opened), [panels, seenAt, me, opened]);
  const line = changedLine(panels, seenAt, Date.now(), me, opened);
  const mayAdd = canCreate && (summary.can === "own" || summary.can === "edit");
  const { wide } = useShape();

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
      {/* With room, two panels to a row whatever their size (an even split at the Duo's fold); small ones share a row otherwise. */}
      <TwoUp>
        {wide
          ? panels.map((panel) => <PanelCard key={panel.id} panel={panel} bot={bots.get(panel.botId)} changed={changed.has(panel.id)} half={false} space={summary} />)
          : panelRows(panels).map((row) => (
              <View key={row.map((panel) => panel.id).join("+")} style={{ flexDirection: "row", gap: space.md }}>
                {row.map((panel) => (
                  <PanelCard key={panel.id} panel={panel} bot={bots.get(panel.botId)} changed={changed.has(panel.id)} half={row.length > 1} space={summary} />
                ))}
              </View>
            ))}
      </TwoUp>
      <TwoUp>
        {cards.map((card) => (
          // A computer that keeps single marks (`seenItems`) is told each card the person saw.
          <ItemCard key={card.id} item={card} bot={bots.get(card.botId)} onSeen={content.seenItems && card.updatedAt > Math.max(seenAt, opened[card.id] ?? 0) ? () => markItemSeen(summary.id, card.id, card.updatedAt) : undefined} />
        ))}
      </TwoUp>
    </View>
  );
}
