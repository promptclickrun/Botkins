// Pieces the Plugins screens share: a plugin's row in a list, "What it adds" with everything it
// starts on the computer shown whole (a tool's line, folder and environment, a hook's command),
// what is not run, its other files, the computer's warnings, and a notice shown one time.
// Text a plugin wrote is drawn as text that was made safe to read (logic.ts, src/ui/shownText.ts).
import { Bot, Braces, ChevronDown, ChevronRight, FileText, Plug, Sparkles, SquareSlash, Terminal, TriangleAlert, Webhook } from "lucide-react-native";
import { memo, useState } from "react";
import { View } from "react-native";
import type { PluginContents, PluginHook, PluginListing, PluginTool } from "@/link/types";
import { usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { Button, Group, IconTile, Label, radius, Row, space, T, Tap, useTheme } from "@/ui";
import { shownText } from "@/ui/shownText";
import { addsNothing, type Fact, groupHooks, hookFacts, notRunRows, otherFilesRows, showsAll, toolFacts, toolLine } from "./logic";

/** A plugin in a list: its name, one line of what it does, and who made it. "Installed" at the right where it is. */
export const PluginRow = memo(function PluginRow({ listing, by, installed, onPress }: { listing: PluginListing; by: string; installed: boolean; onPress: () => void }) {
  const { control } = useTheme();
  const label = [listing.name, listing.description, by, installed ? "Installed" : ""].filter(Boolean).join(", ");
  return (
    <Tap onPress={onPress} sink={1} feel="select" hitSlop={0} accessibilityLabel={label}>
      <View style={{ minHeight: control.row, paddingHorizontal: space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }}>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T variant="callout" weight="600" numberOfLines={1}>
            {shownText(listing.name)}
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
          <Row key={name} leading={<IconTile icon={icon} color={colors.ink2} />} title={prefix + shownText(name)} />
        ))}
      </Group>
    </View>
  );
}

/** How much of a long text shows before "Show all": never less than is said, and the whole is one tap away. */
const FOLD = { characters: 400, lines: 8, shown: 6 };

/**
 * Text as the plugin wrote it, whole, in mono. A long one shows its first lines and says how long
 * it is, with "Show all": nothing is cut without saying so.
 */
function Whole({ text }: { text: string }) {
  const { colors } = useTheme();
  const long = text.length > FOLD.characters || text.split("\n").length > FOLD.lines;
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 2 }}>
      <T variant="mono" color="ink2" selectable numberOfLines={long && !open ? FOLD.shown : undefined} style={{ backgroundColor: colors.sunken, borderRadius: 8, padding: space.sm }}>
        {text}
      </T>
      {long && <Button title={open ? "Show less" : "Show all " + text.length.toLocaleString() + " characters"} variant="ghost" size="sm" onPress={() => setOpen((was) => !was)} style={{ alignSelf: "flex-start" }} />}
    </View>
  );
}

/** What a tool or a hook starts, one labelled part after another. */
function Facts({ facts }: { facts: Fact[] }) {
  return (
    <View style={{ gap: space.sm }}>
      {facts.map((fact) => (
        <View key={fact.label} style={{ gap: 4 }}>
          <T variant="footnote" weight="600" color="muted">
            {fact.label}
          </T>
          {fact.text !== undefined && <Whole text={fact.text} />}
          {fact.lines?.map((line, index) => <Whole key={index} text={line} />)}
          {fact.notes?.map((note) => (
            <View key={note.name} style={{ gap: 1 }}>
              <T variant="mono" color="ink2" selectable>
                {note.name}
              </T>
              {!!note.why && (
                <T variant="footnote" color="muted">
                  {note.why}
                </T>
              )}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/** The hooks of one event, each with its whole command, its time limit and its environment. The heading folds them. */
function HookGroup({ label, hooks }: { label: string; hooks: PluginHook[] }) {
  const { colors, control } = useTheme();
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <View>
      <Tap onPress={() => setOpen((was) => !was)} sink={1} feel="select" hitSlop={0} accessibilityLabel={label + ", " + hooks.length + (hooks.length === 1 ? " command" : " commands")} accessibilityState={{ expanded: open }}>
        <View style={{ minHeight: control.row, paddingHorizontal: space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }}>
          <IconTile icon={Webhook} color={colors.warning} />
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <T variant="callout" weight="500" numberOfLines={2}>
              {label}
            </T>
            <T variant="footnote" color="muted">
              {hooks.length === 1 ? "Runs a command" : "Runs " + hooks.length + " commands"}
            </T>
          </View>
          <Chevron size={18} color={colors.faint} strokeWidth={2.2} />
        </View>
      </Tap>
      {open && (
        <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.lg }}>
          {hooks.map((hook, index) => (
            <Facts key={index} facts={hookFacts(hook)} />
          ))}
        </View>
      )}
    </View>
  );
}

/** A tool (MCP server) the plugin adds, with everything it starts or reaches. An installed one that signs in with OAuth can be signed in from here, on the computer. */
function ToolRow({ server, installed }: { server: PluginTool; installed: boolean }) {
  const { colors } = useTheme();
  const signedIn = usePart("mcp")?.find((item) => item.id === server.serverId)?.auth;
  const [busy, setBusy] = useState(false);
  const done = signedIn?.type === "oauth" && signedIn.signedIn;
  const line = toolLine(server) + (server.oauth && installed ? (done ? " · Signed in" : " · Sign in on your computer") : "");
  const name = shownText(server.name);
  const signIn = async () => {
    if (!server.serverId) return;
    setBusy(true);
    const auth = await attempt(api.signInMcpServer(server.serverId));
    setBusy(false);
    if (auth?.type === "oauth" && auth.signedIn) showToast("Signed in", "success");
  };
  return (
    <View>
      <Row
        leading={<IconTile icon={server.kind === "local" ? Terminal : Plug} color={server.kind === "local" ? colors.warning : colors.ink2} />}
        title={name}
        subtitle={line}
        subtitleLines={3}
        trailing={installed && server.oauth && server.serverId && !done ? <Button title="Sign in" size="sm" variant="secondary" loading={busy || (signedIn?.type === "oauth" && signedIn.signingIn)} onPress={() => void signIn()} accessibilityLabel={"Sign in to " + name + " on your computer"} /> : undefined}
      />
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md }}>
        <Facts facts={toolFacts(server)} />
      </View>
    </View>
  );
}

/** Hooks and tools the plugin has that the computer does not run, each with the computer's reason. */
function NotRun({ contents }: { contents: PluginContents }) {
  const { rows, more } = notRunRows(contents);
  if (!rows.length && !more) return null;
  return (
    <View>
      <Label>Not run</Label>
      <Group>
        {rows.map((row, index) => (
          <View key={index} style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: 2 }}>
            <T variant="mono" color="ink2" selectable>
              {row.name}
            </T>
            {!!row.why && (
              <T variant="footnote" color="muted">
                {row.why}
              </T>
            )}
          </View>
        ))}
        {more > 0 && (
          <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md }}>
            <T variant="subhead" color="muted">
              {"and " + more + " more"}
            </T>
          </View>
        )}
      </Group>
    </View>
  );
}

/** The plugin's other files: how many and how large, and the ones that tools read by themselves. */
function OtherFiles({ contents }: { contents: PluginContents }) {
  const { colors } = useTheme();
  const files = otherFilesRows(contents);
  if (!files) return null;
  return (
    <View>
      <Label>Other files</Label>
      <Group>
        <Row leading={<IconTile icon={FileText} color={colors.ink2} />} title={files.line} />
        {files.config.length > 0 && (
          <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: 4 }}>
            <T variant="footnote" weight="600" color="muted">
              Files that tools read by themselves
            </T>
            {files.config.map((line, index) => (
              <T key={index} variant="mono" color="ink2" selectable>
                {line}
              </T>
            ))}
          </View>
        )}
      </Group>
    </View>
  );
}

/**
 * What a plugin adds: skills, agents, commands, tools and hooks with everything they start, what
 * is not run, language servers and its other files. `about` is the description (a preview or an
 * installed plugin); `older`: the computer's app is from before it could show everything.
 */
export function WhatItAdds({ about, installed = false, older = false }: { about: { contents: PluginContents; starts?: unknown }; installed?: boolean; older?: boolean }) {
  const contents = about.contents;
  const hooks = groupHooks(contents.hooks);
  return (
    <>
      {!showsAll(about) && (
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
          {older ? "Update the app on your computer to see everything a plugin runs." : "Your computer could not show everything this plugin runs."}
        </T>
      )}
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
              <HookGroup key={group.event} label={group.label} hooks={group.hooks} />
            ))}
          </Group>
        </View>
      )}
      <NotRun contents={contents} />
      <Names title="Language servers" names={contents.lspServers ?? []} icon={Braces} />
      <OtherFiles contents={contents} />
      {addsNothing(contents) && (
        <T variant="subhead" color="muted" style={{ paddingHorizontal: space.xs }}>
          Adds nothing this app can show
        </T>
      )}
    </>
  );
}

/** Something the person is told one time: a title, one line, an action and "OK", which closes it for good. */
export function Notice({ title, text, action, onAction, onClose }: { title: string; text: string; action?: string; onAction?: () => void; onClose: () => void }) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.sm }}>
      <T variant="callout" weight="600">
        {title}
      </T>
      <T variant="subhead" color="ink2">
        {text}
      </T>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
        {!!action && !!onAction && <Button title={action} variant="secondary" size="sm" onPress={onAction} />}
        <Button title="OK" variant="ghost" size="sm" onPress={onClose} />
      </View>
    </View>
  );
}

/** The computer's own sentence about a plugin (why it is off, what is wrong), whole. */
export function Said({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start", backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg }}>
      <TriangleAlert size={16} color={colors.warning} strokeWidth={2.3} style={{ marginTop: 2 }} />
      <T variant="subhead" color="ink" style={{ flex: 1 }}>
        {text}
      </T>
    </View>
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
