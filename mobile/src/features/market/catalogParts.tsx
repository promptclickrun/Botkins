// Pieces of the new Market: a section heading with "See all", an app of the direct catalog as a
// tile and as a row, a bot template as a card, and a featured skill as a card and as a row.
import { type Href, router } from "expo-router";
import { memo } from "react";
import { View } from "react-native";
import type { FeaturedSkill, MarketAgent, McpCatalogEntry } from "@/link/types";
import { AppLogo, BotAvatar, Button, Label, radius, space, T, Tap, useTheme } from "@/ui";
import { agentHref } from "./agents/logic";
import { cardLine, entryLine, entryState, featuredLine } from "./catalog";
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

/** An app as a tile: its letter, its name, and the check when it is added and ready. */
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
        <AppLogo name={entry.name} size={size} />
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

/** An app as a row: its letter, its name, and its state then what it does. */
export const CatalogRow = memo(function CatalogRow({ entry }: { entry: McpCatalogEntry }) {
  const { control } = useTheme();
  const line = entryLine(entry);
  return (
    <Tap onPress={() => router.push(toolHref(entry.id))} sink={1} feel="select" hitSlop={0} accessibilityLabel={[entry.name, line].filter(Boolean).join(", ")}>
      <View style={{ minHeight: Math.max(64, control.row), paddingHorizontal: space.lg, paddingVertical: space.md, flexDirection: "row", alignItems: "center", gap: space.md }}>
        <AppLogo name={entry.name} size={40} />
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

/** A template on a shelf: its Botkin (bare), its name, what it delivers, and Add. */
export const BotCard = memo(function BotCard({ agent, width = 156 }: { agent: MarketAgent; width?: number }) {
  const { colors } = useTheme();
  const line = cardLine(agent);
  return (
    <View style={{ width, padding: space.md, gap: space.sm, borderRadius: radius.lg, backgroundColor: colors.surface }}>
      <Tap onPress={() => router.push(agentHref(agent.id))} sink={0.96} hitSlop={0} accessibilityLabel={[agent.name, agent.summary, line].filter(Boolean).join(", ")} style={{ gap: space.sm }}>
        <BotAvatar bot={{ id: agent.id, look: agent.look }} size={56} />
        <View style={{ gap: 2 }}>
          <T variant="name" numberOfLines={1}>
            {agent.name}
          </T>
          <T variant="footnote" color="muted" numberOfLines={2} style={{ minHeight: 36 }}>
            {line}
          </T>
        </View>
      </Tap>
      <Button title="Add" size="sm" variant="secondary" wide accessibilityLabel={"Add " + agent.name} onPress={() => addTemplate(agent.id)} />
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
