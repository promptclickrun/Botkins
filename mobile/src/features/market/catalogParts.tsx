// Pieces of the new Market: a section heading with "See all", an app of the direct catalog as a
// tile, as a row and as a card, a bot template as a card and as a starter, and a featured skill as a card and as a row.
import { type Href, router } from "expo-router";
import { memo, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import type { FeaturedSkill, MarketAgent, McpCatalogEntry } from "@/link/types";
import { Badge, Button, Label, radius, space, T, Tap, useTheme } from "@/ui";
import { agentHref } from "./agents/logic";
import { BotArt, BrandIcon, useBrandTint } from "./art";
import { appBadge, asksFirst, cardLine, deliverableLine, entryLine, entryPlan, entryState, featuredLine, jobLine } from "./catalog";
import { CheckBadge } from "./parts";

// Ids are opaque and may hold any character, so they travel as query parameters.
export const toolHref = (id: string) => ("/market/tool?id=" + encodeURIComponent(id)) as unknown as Href;
export const skillsHref = (query?: string) => ("/market/skills" + (query ? "?q=" + encodeURIComponent(query) : "")) as unknown as Href;
export const addTemplate = (id: string) => router.push({ pathname: "/bot/new", params: { template: id } });

/** A heading over a section, with an optional link at its right. */
export function SectionHead({ title, link, onLink }: { title: string; link?: string; onLink?: () => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginBottom: space.sm }}>
      <Label style={{ flex: 1, marginBottom: 0 }}>{title}</Label>
      {!!link && (
        <Tap onPress={onLink} feel="select" hitSlop={{ top: 14, bottom: 14, left: 16, right: 12 }} accessibilityLabel={link + ", " + title}>
          <T variant="subhead" weight="600" color="accentText">
            {link}
          </T>
        </Tap>
      )}
    </View>
  );
}

// Sizes of the cards, in points, for tuning on a device.
export const CARD = {
  /** A Starters card: its art band and its Botkin. */
  starter: { width: 240, art: 120, avatar: 80 },
  /** A bot in a grid or on a shelf. */
  bot: { art: 88, avatar: 60 },
  /** An app in a category's carousel, and in the Featured one. */
  app: { width: 160, icon: 48 },
  featured: { width: 300, icon: 56 },
} as const;

/** An app as a tile: its mark, its name, and the check when it is added and ready. */
export const CatalogTile = memo(function CatalogTile({ entry, size = 54 }: { entry: McpCatalogEntry; size?: number }) {
  const { colors } = useTheme();
  const state = entryState(entry);
  const ready = !!state && !state.attention && state.line !== "Off";
  return (
    <Tap
      onPress={() => router.push(toolHref(entry.id))}
      accessibilityLabel={[entry.name, state?.line].filter(Boolean).join(", ")}
      sink={0.94}
      hitSlop={0}
      style={{ flex: 1, minWidth: 0, minHeight: 44, alignItems: "center", gap: 6, paddingVertical: 2 }}
    >
      <View>
        <BrandIcon id={entry.id} name={entry.name} size={size} />
        {ready && (
          <View style={{ position: "absolute", top: -5, right: -5 }}>
            <CheckBadge ring={colors.canvas} />
          </View>
        )}
      </View>
      <T variant="caption" weight="600" color="ink2" center numberOfLines={1} style={{ alignSelf: "stretch" }}>
        {entry.name}
      </T>
    </Tap>
  );
});

/** Tiles four to a row. */
export function TileGrid({ entries }: { entries: McpCatalogEntry[] }) {
  const rows: McpCatalogEntry[][] = [];
  for (let index = 0; index < entries.length; index += 4) rows.push(entries.slice(index, index + 4));
  return (
    <View style={{ gap: space.lg, paddingTop: 6 }}>
      {rows.map((row) => (
        <View key={row[0].id} style={{ flexDirection: "row", gap: space.sm }}>
          {row.map((entry) => (
            <CatalogTile key={entry.id} entry={entry} />
          ))}
          {Array.from({ length: 4 - row.length }, (_, index) => (
            <View key={"gap" + index} style={{ flex: 1 }} />
          ))}
        </View>
      ))}
    </View>
  );
}

/** An app as a row: its mark, its name, and its state then what it does. */
export const CatalogRow = memo(function CatalogRow({ entry }: { entry: McpCatalogEntry }) {
  const { control } = useTheme();
  const line = entryLine(entry);
  return (
    <Tap onPress={() => router.push(toolHref(entry.id))} sink={1} feel="select" hitSlop={0} accessibilityLabel={[entry.name, line].filter(Boolean).join(", ")}>
      <View style={{ minHeight: Math.max(64, control.row), paddingHorizontal: space.lg, paddingVertical: space.md, flexDirection: "row", alignItems: "center", gap: space.md }}>
        <BrandIcon id={entry.id} name={entry.name} size={40} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T variant="callout" weight="600" numberOfLines={1}>
            {entry.name}
          </T>
          {!!line && (
            <T variant="footnote" color={entryState(entry)?.attention ? "warning" : "muted"} numberOfLines={2}>
              {line}
            </T>
          )}
        </View>
      </View>
    </Tap>
  );
});

/** What an app's card ends with: its state when it is added, else Add (or Connect) to open its sheet. */
function AppAction({ entry, size = "sm" }: { entry: McpCatalogEntry; size?: "sm" | "md" }) {
  const badge = appBadge(entry);
  if (badge) return <Badge label={badge.label} tone={badge.attention ? "warning" : badge.label === "Off" ? "neutral" : "success"} />;
  const plan = entryPlan(entry);
  return <Button title={plan.kind === "connect" ? "Connect" : "Add"} size={size} variant="secondary" accessibilityLabel={plan.label + " " + entry.name} onPress={() => router.push(toolHref(entry.id))} />;
}

/** An app in a category's carousel: its mark, its name, two lines of what it does, and its state or Add. */
export const AppCard = memo(function AppCard({ entry, width }: { entry: McpCatalogEntry; /** A shelf's fixed width; in a grid the card shares its row. */ width?: number }) {
  const { colors } = useTheme();
  const state = entryState(entry);
  return (
    <Tap
      onPress={() => router.push(toolHref(entry.id))}
      sink={0.96}
      hitSlop={0}
      accessibilityLabel={[entry.name, entry.description, state?.line].filter(Boolean).join(", ")}
      style={{ width, flex: width ? undefined : 1, minWidth: 0, padding: space.md, gap: space.sm, borderRadius: radius.lg, backgroundColor: colors.surface }}
    >
      <BrandIcon id={entry.id} name={entry.name} size={CARD.app.icon} />
      <View style={{ gap: 2 }}>
        <T variant="name" numberOfLines={1}>
          {entry.name}
        </T>
        <T variant="footnote" color="muted" numberOfLines={2} style={{ minHeight: 36 }}>
          {entry.description}
        </T>
      </View>
      <View style={{ minHeight: 32, justifyContent: "center", alignItems: "flex-start" }}>
        <AppAction entry={entry} />
      </View>
    </Tap>
  );
});

/** An app in the Featured carousel: a wide card washed in its brand color, with its big mark. */
export const FeaturedAppCard = memo(function FeaturedAppCard({ entry, width = CARD.featured.width }: { entry: McpCatalogEntry; width?: number }) {
  const wash = useBrandTint(entry.id, entry.name);
  const state = entryState(entry);
  return (
    <Tap
      onPress={() => router.push(toolHref(entry.id))}
      sink={0.97}
      hitSlop={0}
      accessibilityLabel={[entry.name, entry.description, state?.line].filter(Boolean).join(", ")}
      style={{ width, padding: space.lg, gap: space.md, borderRadius: radius.xl, backgroundColor: wash }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <BrandIcon id={entry.id} name={entry.name} size={CARD.featured.icon} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="headline" numberOfLines={1}>
            {entry.name}
          </T>
          {!!entry.categoryName && (
            <T variant="caption" color="muted" numberOfLines={1}>
              {entry.categoryName}
            </T>
          )}
        </View>
        <AppAction entry={entry} />
      </View>
      <T variant="subhead" color="ink2" numberOfLines={2}>
        {entry.description}
      </T>
    </Tap>
  );
});

/** A shelf that runs to the page's edges. */
export function Shelf({ children, gap = space.sm }: { children: ReactNode; gap?: number }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.xl }} contentContainerStyle={{ paddingHorizontal: space.xl, gap }}>
      {children}
    </ScrollView>
  );
}

/** A template as a card: its art band with its Botkin, its name, two lines of what it does, where it is from, and Add. */
export const BotCard = memo(function BotCard({ agent, width }: { agent: MarketAgent; width?: number }) {
  const { colors } = useTheme();
  const line = cardLine(agent);
  return (
    <View style={{ width, flex: width ? undefined : 1, minWidth: 0, borderRadius: radius.lg, backgroundColor: colors.surface, overflow: "hidden" }}>
      <Tap onPress={() => router.push(agentHref(agent.id))} sink={0.97} hitSlop={0} accessibilityLabel={[agent.name, agent.summary, line, asksFirst(agent) && "Asks first"].filter(Boolean).join(", ")}>
        <BotArt id={agent.id} look={agent.look} height={CARD.bot.art} avatar={CARD.bot.avatar} />
        <View style={{ padding: space.md, paddingBottom: space.sm, gap: 2 }}>
          <T variant="name" numberOfLines={1}>
            {agent.name}
          </T>
          <T variant="footnote" color="ink2" numberOfLines={2} style={{ minHeight: 36 }}>
            {agent.summary || agent.role}
          </T>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 22, marginTop: 2 }}>
            {asksFirst(agent) ? (
              <Badge label="Asks first" tone="info" />
            ) : (
              <T variant="caption" color="muted" numberOfLines={1} style={{ flex: 1 }}>
                {agent.categoryName || agent.marketplaceName}
              </T>
            )}
          </View>
        </View>
      </Tap>
      <View style={{ paddingHorizontal: space.md, paddingBottom: space.md }}>
        <Button title="Add" size="sm" wide accessibilityLabel={"Add " + agent.name} onPress={() => addTemplate(agent.id)} />
      </View>
    </View>
  );
});

/** A starter: a tall card with a big art band, its Botkin, its name, its job, what it hands back, and Add. */
export const StarterCard = memo(function StarterCard({ agent, width = CARD.starter.width }: { agent: MarketAgent; width?: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ width, borderRadius: radius.xl, backgroundColor: colors.surface, overflow: "hidden" }}>
      <Tap onPress={() => router.push(agentHref(agent.id))} sink={0.97} hitSlop={0} accessibilityLabel={[agent.name, jobLine(agent), agent.deliverable, asksFirst(agent) && "Asks first"].filter(Boolean).join(", ")}>
        <BotArt id={agent.id} look={agent.look} height={CARD.starter.art} avatar={CARD.starter.avatar} />
        <View style={{ padding: space.lg, paddingBottom: space.md, gap: 4 }}>
          <T variant="title3" numberOfLines={1}>
            {agent.name}
          </T>
          <T variant="subhead" color="ink2" numberOfLines={2} style={{ minHeight: 40 }}>
            {jobLine(agent)}
          </T>
          <T variant="caption" color="muted" numberOfLines={1}>
            {deliverableLine(agent)}
          </T>
        </View>
      </Tap>
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.lg }}>
        <Button title="Add" wide accessibilityLabel={"Add " + agent.name} onPress={() => addTemplate(agent.id)} />
      </View>
    </View>
  );
});

/** A featured skill on a shelf: its name, what it does, its license and author. */
export const SkillCard = memo(function SkillCard({ skill, onPress, width = 220 }: { skill: FeaturedSkill; onPress: () => void; width?: number }) {
  const { colors } = useTheme();
  const line = featuredLine(skill);
  return (
    <Tap onPress={onPress} sink={0.96} hitSlop={0} accessibilityLabel={[skill.name, skill.summary, line, skill.installed && "Installed"].filter(Boolean).join(", ")} style={{ width, padding: space.md, gap: 4, borderRadius: radius.lg, backgroundColor: colors.surface }}>
      <T variant="callout" weight="600" numberOfLines={1}>
        {skill.name}
      </T>
      <T variant="footnote" color="ink2" numberOfLines={3} style={{ minHeight: 54 }}>
        {skill.summary}
      </T>
      <T variant="caption" color="muted" numberOfLines={1}>
        {[skill.installed && "Installed", line].filter(Boolean).join(" · ")}
      </T>
    </Tap>
  );
});

/** A featured skill as a row: its name, what it does, then its license and author. */
export const SkillRow = memo(function SkillRow({ skill, onPress, disabled }: { skill: FeaturedSkill; onPress: () => void; disabled?: boolean }) {
  const { control } = useTheme();
  const line = [skill.installed && "Installed", featuredLine(skill)].filter(Boolean).join(" · ");
  return (
    <Tap onPress={onPress} disabled={disabled} sink={1} feel="select" hitSlop={0} accessibilityLabel={[skill.name, skill.summary, line].filter(Boolean).join(", ")}>
      <View style={{ minHeight: control.row, paddingHorizontal: space.lg, paddingVertical: 10, gap: 1 }}>
        <T variant="callout" weight="500" numberOfLines={1}>
          {skill.name}
        </T>
        {!!skill.summary && (
          <T variant="footnote" color="ink2" numberOfLines={2}>
            {skill.summary}
          </T>
        )}
        <T variant="footnote" color="muted" numberOfLines={1}>
          {line}
        </T>
      </View>
    </Tap>
  );
});
