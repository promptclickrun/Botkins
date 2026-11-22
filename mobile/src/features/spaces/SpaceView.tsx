// What is in a space, on its page: its panels and its cards (Feed, Ideas, Goals). The panels show
// as cards (PanelTile: a title and the one thing each says, nothing running) until the person sets
// the space to Open; then small ones sit two up and an app runs right in its card.
import { Maximize2 } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { ItemCard } from "@/features/today/Today";
import type { Bot, PanelView, SpaceSummary } from "@/link/types";
import { myself } from "@/features/chat/people";
import { useBots, useCan, usePart } from "@/state/hooks";
import { ago } from "@/state/time";
import { Badge, Blocks, BotAvatar, Dot, EmptyState, lift, Loading, Mascot, radius, Segmented, space, T, Tap, TwoUp, useShape, useTheme } from "@/ui";
import { markItemSeen, markSeen, openNewPanel, openPanel, panelState, setSpaceOpen, useSeenMarks, useSpaceContent, useSpaceOpen } from "./data";
import { changedLine, changedSince, isApp, lastLine, panelRows } from "./logic";
import { PanelTile } from "./PanelTile";

const VIEWS: { value: "cards" | "open"; label: string }[] = [
  { value: "cards", label: "Cards" },
  { value: "open", label: "Open" },
];

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
 * A space's content, on its own page: being here counts as seen (its dots clear the next time). A
 * panel opened on its own loses its dot at once.
 */
export function SpaceView({ space: summary }: { space: SpaceSummary }) {
  const { content, error, loading, retry } = useSpaceContent(summary.id);
  const allBots = useBots();
  const canCreate = useCan("today", "create");
  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const open = useSpaceOpen(summary.id);
  const rev = content?.rev;
  useEffect(() => {
    // Seen once its content is on screen; again when it changes while the person is here.
    if (rev !== undefined) markSeen(summary.id);
  }, [rev, summary.id]);

  const panels = useMemo(() => (content?.panels ?? []).filter((panel) => !panel.hidden), [content]);
  const cards = useMemo(() => (content?.cards ?? []).filter((card) => card.status === "open").sort((a, b) => Number(a.read) - Number(b.read) || b.createdAt - a.createdAt), [content]);
  // What the read says was seen, and each panel opened on its own since.
  const seenAt = content?.seenAt ?? 0;
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
      {panels.length > 0 && <Segmented options={VIEWS} value={open ? "open" : "cards"} onChange={(view) => setSpaceOpen(summary.id, view === "open")} />}
      {/* As cards: a small panel shares its row, any other has its own. With room, two rows side by side. */}
      {!open && (
        <TwoUp>
          {panelRows(panels).map((row) => (
            <View key={row.map((panel) => panel.id).join("+")} style={{ flexDirection: "row", gap: space.md }}>
              {row.map((panel) => (
                <PanelTile key={panel.id} panel={panel} spaceId={summary.id} bot={bots.get(panel.botId)} changed={changed.has(panel.id)} wide={row.length === 1 && panel.size !== "small"} />
              ))}
              {/* A small panel alone in its row keeps a card's width. */}
              {row.length === 1 && row[0].size === "small" && <View style={{ flex: 1 }} />}
            </View>
          ))}
        </TwoUp>
      )}
      {/* Open, with room: two panels to a row whatever their size (an even split at the Duo's fold); small ones share a row otherwise. */}
      {open && <TwoUp>
        {wide
          ? panels.map((panel) => <PanelCard key={panel.id} panel={panel} bot={bots.get(panel.botId)} changed={changed.has(panel.id)} half={false} space={summary} />)
          : panelRows(panels).map((row) => (
              <View key={row.map((panel) => panel.id).join("+")} style={{ flexDirection: "row", gap: space.md }}>
                {row.map((panel) => (
                  <PanelCard key={panel.id} panel={panel} bot={bots.get(panel.botId)} changed={changed.has(panel.id)} half={row.length > 1} space={summary} />
                ))}
              </View>
            ))}
      </TwoUp>}
      <TwoUp>
        {cards.map((card) => (
          // A computer that keeps single marks (`seenItems`) is told each card the person saw.
          <ItemCard key={card.id} item={card} bot={bots.get(card.botId)} onSeen={content.seenItems && card.updatedAt > Math.max(seenAt, opened[card.id] ?? 0) ? () => markItemSeen(summary.id, card.id, card.updatedAt) : undefined} />
        ))}
      </TwoUp>
    </View>
  );
}
