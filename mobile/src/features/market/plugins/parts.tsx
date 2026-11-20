// Pieces the Plugins screens share: a plugin's row in a list, and "What it adds".
import { Bot, Braces, ChevronDown, ChevronRight, Plug, Sparkles, SquareSlash, Terminal, TriangleAlert, Webhook } from "lucide-react-native";
import { memo, useState } from "react";
import { View } from "react-native";
import type { PluginContents, PluginListing } from "@/link/types";
import { usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { Button, Group, IconTile, Label, Row, space, T, Tap, useTheme } from "@/ui";
import { addsNothing, groupHooks, toolLine } from "./logic";

/** A plugin in a list: its name, one line of what it does, and who made it. "Installed" at the right where it is. */
export const PluginRow = memo(function PluginRow({ listing, by, installed, onPress }: { listing: PluginListing; by: string; installed: boolean; onPress: () => void }) {
  const { control } = useTheme();
  const label = [listing.name, listing.description, by, installed ? "Installed" : ""].filter(Boolean).join(", ");
  return (
    <Tap onPress={onPress} sink={1} feel="select" hitSlop={0} accessibilityLabel={label}>
      <View style={{ minHeight: control.row, paddingHorizontal: space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }}>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T variant="callout" weight="600" numberOfLines={1}>
            {listing.name}
          </T>
          {!!listing.description && (
            <T variant="subhead" color="ink2" numberOfLines={1}>
              {listing.description}
            </T>
          )}
          {!!by && (
            <T variant="footnote" color="muted" numberOfLines={1}>
              {by}
            </T>
          )}
        </View>
        {installed && (
          <T variant="footnote" weight="600" color="muted">
            Installed
          </T>
        )}
      </View>
    </Tap>
  );
});

/** One group of named things a plugin adds. */
function Names({ title, names, icon, prefix = "" }: { title: string; names: string[]; icon: typeof Sparkles; prefix?: string }) {
  const { colors } = useTheme();
  if (!names.length) return null;
  return (
    <View>
      <Label>{title}</Label>
      <Group>
        {names.map((name) => (
          <Row key={name} leading={<IconTile icon={icon} color={colors.ink2} />} title={prefix + name} />
        ))}
      </Group>
    </View>
  );
}

/** The hooks of one event: a row that opens to show each command as written. */
function HookGroup({ label, commands }: { label: string; commands: string[] }) {
  const { colors, control } = useTheme();
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <View>
      <Tap onPress={() => setOpen((was) => !was)} sink={1} feel="select" hitSlop={0} accessibilityLabel={label + ", " + commands.length + (commands.length === 1 ? " command" : " commands")} accessibilityState={{ expanded: open }}>
        <View style={{ minHeight: control.row, paddingHorizontal: space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }}>
          <IconTile icon={Webhook} color={colors.warning} />
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <T variant="callout" weight="500" numberOfLines={2}>
              {label}
            </T>
            <T variant="footnote" color="muted">
              {commands.length === 1 ? "Runs a command" : "Runs " + commands.length + " commands"}
            </T>
          </View>
          <Chevron size={18} color={colors.faint} strokeWidth={2.2} />
        </View>
      </Tap>
      {open && (
        <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.sm }}>
          {commands.map((command, index) => (
            <T key={index} variant="mono" color="ink2" selectable style={{ backgroundColor: colors.sunken, borderRadius: 8, padding: space.sm }}>
              {command}
            </T>
          ))}
        </View>
      )}
    </View>
  );
}

/** A tool (MCP server) the plugin adds. An installed one that signs in with OAuth can be signed in from here, on the computer. */
function ToolRow({ server, installed }: { server: PluginContents["mcpServers"][number]; installed: boolean }) {
  const { colors } = useTheme();
  const signedIn = usePart("mcp")?.find((item) => item.id === server.serverId)?.auth;
  const [busy, setBusy] = useState(false);
  const done = signedIn?.type === "oauth" && signedIn.signedIn;
  const line = toolLine(server) + (server.oauth ? (done ? " · Signed in" : " · Sign in on your computer") : "");
  const signIn = async () => {
    if (!server.serverId) return;
    setBusy(true);
    const auth = await attempt(api.signInMcpServer(server.serverId));
    setBusy(false);
    if (auth?.type === "oauth" && auth.signedIn) showToast("Signed in", "success");
  };
  return (
    <Row
      leading={<IconTile icon={server.kind === "local" ? Terminal : Plug} color={server.kind === "local" ? colors.warning : colors.ink2} />}
      title={server.name}
      subtitle={line}
      subtitleLines={3}
      trailing={installed && server.oauth && server.serverId && !done ? <Button title="Sign in" size="sm" variant="secondary" loading={busy || (signedIn?.type === "oauth" && signedIn.signingIn)} onPress={() => void signIn()} accessibilityLabel={"Sign in to " + server.name + " on your computer"} /> : undefined}
    />
  );
}

/** What a plugin adds: skills, agents, commands, tools, hooks by event, language servers. */
export function WhatItAdds({ contents, installed = false }: { contents: PluginContents; installed?: boolean }) {
  const hooks = groupHooks(contents.hooks);
  return (
    <>
      <Names title="Skills" names={contents.skills} icon={Sparkles} />
      <Names title="Agents" names={contents.agents} icon={Bot} />
      <Names title="Commands" names={contents.commands} icon={SquareSlash} prefix="/" />
      {contents.mcpServers.length > 0 && (
        <View>
          <Label>Tools (MCP)</Label>
          <Group>
            {contents.mcpServers.map((server) => (
              <ToolRow key={server.name} server={server} installed={installed} />
            ))}
          </Group>
        </View>
      )}
      {hooks.length > 0 && (
        <View>
          <Label>Runs on your computer</Label>
          <Group>
            {hooks.map((group) => (
              <HookGroup key={group.event} label={group.label} commands={group.commands} />
            ))}
          </Group>
        </View>
      )}
      <Names title="Language servers" names={contents.lspServers ?? []} icon={Braces} />
      {addsNothing(contents) && (
        <T variant="subhead" color="muted" style={{ paddingHorizontal: space.xs }}>
          Adds nothing this app can show
        </T>
      )}
    </>
  );
}

/** The sentences a preview warns with, one quiet line each. */
export function Warnings({ lines }: { lines?: string[] }) {
  const { colors } = useTheme();
  if (!lines?.length) return null;
  return (
    <View style={{ gap: space.xs, paddingHorizontal: space.xs }}>
      {lines.map((line) => (
        <View key={line} style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
          <TriangleAlert size={14} color={colors.muted} strokeWidth={2.3} style={{ marginTop: 2 }} />
          <T variant="footnote" color="muted" style={{ flex: 1 }}>
            {line}
          </T>
        </View>
      ))}
    </View>
  );
}
