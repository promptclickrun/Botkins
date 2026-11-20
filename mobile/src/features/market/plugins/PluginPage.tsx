// A plugin's page: what it is, what it adds and what it runs on the computer, then Install. Once
// installed: its status, on and off, its settings, the bots that use it, Update and Remove.
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Check, ExternalLink, Puzzle } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { CredentialPicker } from "@/features/credentials/CredentialPicker";
import type { InstalledPlugin, PluginContents } from "@/link/types";
import { useBots, useOnline } from "@/state/hooks";
import { attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { BotAvatar, Button, EmptyState, Field, Group, IconTile, Label, Loading, Page, Row, space, T, useTheme } from "@/ui";
import { installHref, loadPreview, pluginCalls, updateHref, useInstalledPlugin, usePluginMarketplaces, usePluginsReady, usePreview } from "./calls";
import { botsLine, byLine, consent, fieldState, hostOf, safeLink, statusLine } from "./logic";
import { WhatItAdds, Warnings } from "./parts";

/** Asks first when a plugin runs commands on the computer; otherwise goes straight on. */
export function askToRun(contents: PluginContents, verb: "install" | "update" | "turn on", go: () => void) {
  const ask = consent(contents, verb);
  if (!ask) return go();
  Alert.alert(ask.title, ask.message, [
    { text: "Cancel", style: "cancel" },
    { text: ask.action, onPress: go },
  ]);
}

export default function PluginPage() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const can = usePluginsReady();
  const online = useOnline();
  const installed = useInstalledPlugin(id);
  const loaded = usePreview(id);
  const markets = usePluginMarketplaces((state) => state.list);
  const [tries, setTries] = useState(0);

  // The preview is read again each time the page opens: Install sends its revision.
  useEffect(() => {
    if (id && can && online) void loadPreview(id);
  }, [id, can, online, tries]);

  if (!id || !can) return <Page title="Plugin">{!can ? <EmptyState icon={Puzzle} title="Update the app on your computer" /> : <EmptyState icon={Puzzle} title="This plugin is gone" />}</Page>;
  const preview = loaded?.preview;
  const about = installed ?? preview;
  if (!about) {
    return (
      <Page title="Plugin">
        {loaded?.error ? <EmptyState icon={Puzzle} title="This plugin couldn't be read" text={loaded.error} action="Try again" onAction={() => setTries((n) => n + 1)} /> : <Loading />}
      </Page>
    );
  }
  const by = [byLine(about, markets), about.version && "Version " + about.version].filter(Boolean).join(" · ");
  const links = [
    { label: "Homepage", url: safeLink(about.homepage) },
    { label: "Repository", url: safeLink(about.repository) },
  ].filter((link): link is { label: string; url: string } => !!link.url);

  return (
    <Page title={about.name} caption={installed ? statusLine(installed) : by}>
      {!!installed && !!by && (
        <T variant="footnote" color="muted" style={{ marginTop: -space.lg }}>
          {by}
        </T>
      )}
      {!!about.description && <T variant="body">{about.description}</T>}
      <Warnings lines={preview?.warnings} />

      {installed ? (
        <Installed plugin={installed} />
      ) : (
        <Button title="Install" wide disabled={!online || !preview} onPress={() => preview && askToRun(preview.contents, "install", () => router.push(installHref(id)))} />
      )}

      <WhatItAdds contents={installed?.contents ?? preview!.contents} installed={!!installed} />

      {links.length > 0 && (
        <Group>
          {links.map((link) => (
            <Row key={link.label} leading={<IconTile icon={ExternalLink} />} title={link.label} value={hostOf(link.url)} chevron onPress={() => void WebBrowser.openBrowserAsync(link.url).catch(() => {})} />
          ))}
        </Group>
      )}
      {!!about.license && (
        <T variant="footnote" color="muted" center>
          {"License: " + about.license}
        </T>
      )}

      {installed && <RemoveRow plugin={installed} />}
    </Page>
  );
}

/** What an installed plugin's page adds: on and off, Update, settings, bots, limits. */
function Installed({ plugin }: { plugin: InstalledPlugin }) {
  const online = useOnline();
  const names = Object.fromEntries(useBots().map((bot) => [bot.id, bot.name]));
  const [busy, setBusy] = useState(false);
  const turn = (on: boolean) => {
    const go = async () => {
      setBusy(true);
      await attempt(pluginCalls.setEnabled(plugin.id, on), on ? "Turned on" : undefined);
      setBusy(false);
    };
    if (on) askToRun(plugin.contents, "turn on", () => void go());
    else void go();
  };
  return (
    <>
      {plugin.enabled ? (
        <Group>
          <Row title="On" subtitle={botsLine(plugin.bots, names)} toggled disabled={!online || busy} onToggle={turn} />
        </Group>
      ) : (
        <Button title="Turn on" wide loading={busy} disabled={!online} onPress={() => turn(true)} />
      )}
      {(plugin.updateAvailable || !!plugin.folder) && <Button title={plugin.folder ? "Update from folder" : "Update"} variant="secondary" wide disabled={!online} onPress={() => router.push(updateHref(plugin.id))} />}
      {!!plugin.folder && (
        <View style={{ gap: 2, paddingHorizontal: space.xs }}>
          <T variant="footnote" color="muted">
            A copy of a folder on your computer
          </T>
          <T variant="mono" color="muted" numberOfLines={2} ellipsizeMode="middle">
            {plugin.folder}
          </T>
        </View>
      )}
      <Settings plugin={plugin} />
      <Bots plugin={plugin} />
      {!!plugin.limits && (
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: -space.md }}>
          {plugin.limits}
        </T>
      )}
    </>
  );
}

/** Each setting: a value shows and is edited in place; a secret shows only whether it is set, and is replaced or cleared. */
function Settings({ plugin }: { plugin: InstalledPlugin }) {
  const [open, setOpen] = useState<string>();
  if (!plugin.config.length) return null;
  return (
    <View>
      <Label>Settings</Label>
      <Group>
        {plugin.config.map((field) =>
          open === field.key ? (
            <FieldEditor key={field.key} pluginId={plugin.id} field={field} onDone={() => setOpen(undefined)} />
          ) : (
            <Row key={field.key} title={field.label + (field.required ? "" : " (optional)")} subtitle={field.description} value={fieldState(field)} chevron onPress={() => setOpen(field.key)} />
          ),
        )}
      </Group>
    </View>
  );
}

/**
 * One setting being changed. A secret is typed only here and sent once, then forgotten; a saved
 * credential is sent as its reference. Nothing typed goes anywhere else.
 */
function FieldEditor({ pluginId, field, onDone }: { pluginId: string; field: InstalledPlugin["config"][number]; onDone: () => void }) {
  const online = useOnline();
  const [text, setText] = useState(field.secret ? "" : (field.value ?? field.default ?? ""));
  const [busy, setBusy] = useState(false);
  const send = async (value: string | { $credential: string } | null, done: string) => {
    setBusy(true);
    const ok = await attempt(pluginCalls.configure(pluginId, { [field.key]: value }).then(() => true), done);
    if (field.secret) setText("");
    setBusy(false);
    if (ok) onDone();
  };
  const typed = field.secret ? text.length > 0 : text.trim() !== (field.value ?? "");
  return (
    <View style={{ padding: space.lg, gap: space.sm }}>
      <Field
        label={field.label}
        hint={field.description}
        value={text}
        onChangeText={setText}
        placeholder={field.secret ? (field.set ? "Type a new value" : "Value") : (field.default ?? "")}
        secureTextEntry={field.secret}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        editable={!busy}
        accessibilityLabel={field.label}
      />
      {field.secret && <CredentialPicker disabled={busy || !online} onPick={(ref, name) => void send({ $credential: ref.$credential }, "Uses " + name)} />}
      <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
        {field.set && <Button title="Clear" variant="ghost" size="sm" disabled={busy || !online} onPress={() => void send(null, "Cleared")} />}
        <Button title="Cancel" variant="ghost" size="sm" disabled={busy} onPress={onDone} />
        <Button title="Save" size="sm" loading={busy} disabled={!typed || !online} onPress={() => void send(field.secret ? text : text.trim(), "Saved")} />
      </View>
    </View>
  );
}

/** Which bots use the plugin: all of them, or the chosen ones. */
function Bots({ plugin }: { plugin: InstalledPlugin }) {
  const { colors } = useTheme();
  const online = useOnline();
  const bots = useBots();
  const all = plugin.bots === "all";
  const chosen = new Set(all ? [] : plugin.bots);
  const set = (next: "all" | string[]) => void attempt(pluginCalls.setBots(plugin.id, next));
  const flip = (id: string) => {
    const next = chosen.has(id) ? [...chosen].filter((item) => item !== id) : [...chosen, id];
    if (!next.length) return showToast("Choose at least one bot, or turn the plugin off.", "info");
    set(next);
  };
  if (!bots.length) return null;
  return (
    <View>
      <Label>Bots</Label>
      <Group>
        <Row title="All bots" subtitle={all ? "New bots too" : undefined} toggled={all} disabled={!online} onToggle={(on) => set(on ? "all" : bots.map((bot) => bot.id))} />
        {!all &&
          bots.map((bot) => (
            <Row
              key={bot.id}
              leading={<BotAvatar bot={bot} size={32} badge={false} />}
              title={bot.name}
              subtitle={chosen.has(bot.id) ? "Uses it" : undefined}
              disabled={!online}
              trailing={chosen.has(bot.id) ? <Check size={20} color={colors.accentText} strokeWidth={2.6} /> : undefined}
              onPress={() => flip(bot.id)}
            />
          ))}
      </Group>
    </View>
  );
}

function RemoveRow({ plugin }: { plugin: InstalledPlugin }) {
  const online = useOnline();
  const remove = () =>
    Alert.alert("Remove " + plugin.name + "?", "Your bots stop using it. Its settings are removed from your computer.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          void attempt(pluginCalls.uninstall(plugin.id).then(() => true), "Removed").then((done) => {
            if (done) router.back();
          }),
      },
    ]);
  return (
    <Group>
      <Row title="Remove" tone="danger" disabled={!online} onPress={remove} />
    </Group>
  );
}
