// A plugin's page: what it is, what it adds and everything it runs on the computer, then Install.
// Once installed: its status, the computer's own sentence when it switched the plugin off or
// something is wrong, on and off, its settings (with where each value goes), the bots that use it,
// Update and Remove. A switch-on and a choice of bots send the revision that was on the screen.
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Check, ExternalLink, Puzzle } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { CredentialPicker } from "@/features/credentials/CredentialPicker";
import type { InstalledPlugin, PluginContents } from "@/link/types";
import { shownText } from "@/ui/shownText";
import { useBots, useCan, useOnline } from "@/state/hooks";
import { attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { BotAvatar, Button, EmptyState, Field, Group, IconTile, Label, Loading, Page, Row, space, T, useTheme } from "@/ui";
import { installHref, loadPreview, pluginCalls, updateHref, useInstalledPlugin, useOlderComputer, usePluginMarketplaces, usePluginsReady, usePreview } from "./calls";
import { botsLine, byLine, consent, fieldState, hostOf, needsReview, safeLink, sentToLines, statusLine } from "./logic";
import { Said, WhatItAdds, Warnings } from "./parts";

/**
 * Asks first when a plugin runs commands on the computer, and always when its description does not
 * carry the computer's mark (it may not show everything); otherwise goes straight on. `older`: the
 * computer's app is from before the mark.
 */
export function askToRun(about: { contents: PluginContents; starts?: unknown }, verb: "install" | "update" | "turn on", go: () => void, older = false) {
  const ask = consent(about, verb, older);
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
  const canView = useCan("plugins", "view");
  const canInstall = useCan("plugins", "install");
  const older = useOlderComputer();
  const installed = useInstalledPlugin(id);
  const loaded = usePreview(id);
  const markets = usePluginMarketplaces((state) => state.list);
  const [tries, setTries] = useState(0);

  // The preview is read again each time the page opens: Install sends its revision.
  useEffect(() => {
    if (id && can && online) void loadPreview(id);
  }, [id, can, online, tries]);

  if (!id || !can || !canView) return <Page title="Plugin">{!canView ? <EmptyState icon={Puzzle} title="Your team role can't view this plugin" /> : !can ? <EmptyState icon={Puzzle} title="Update the app on your computer" /> : <EmptyState icon={Puzzle} title="This plugin is gone" />}</Page>;
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

  // What is shown is what is decided about: the installed plugin's own description, else the preview's.
  const shown = installed ?? preview!;
  // The computer's sentence, whole: why it switched the plugin off, or what is wrong.
  const review = !!installed && needsReview(installed);
  const said = installed && (review || installed.status === "error") ? installed.detail : undefined;
  return (
    <Page title={shownText(about.name)} caption={installed ? statusLine(installed, { page: true }) : by}>
      {!!installed && !!by && (
        <T variant="footnote" color="muted" style={{ marginTop: -space.lg }}>
          {by}
        </T>
      )}
      {!!said && <Said text={said} />}
      {!!about.description && <T variant="body">{about.description}</T>}
      <Warnings lines={installed?.warnings ?? preview?.warnings} />

      {/* A plugin the computer switched off is looked at first: its reason, all that it runs, then "Turn on". */}
      {review && <WhatItAdds about={shown} installed older={older} />}
      {installed ? (
        <Installed plugin={installed} older={older} />
      ) : (
        canInstall ? <Button title="Install" wide disabled={!online || !preview} onPress={() => preview && askToRun(preview, "install", () => router.push(installHref(id)), older)} /> : null
      )}

      {!review && <WhatItAdds about={shown} installed={!!installed} older={older} />}

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
function Installed({ plugin, older }: { plugin: InstalledPlugin; older: boolean }) {
  const online = useOnline();
  const canManage = useCan("plugins", "manage");
  const names = Object.fromEntries(useBots().map((bot) => [bot.id, bot.name]));
  const [busy, setBusy] = useState(false);
  const turn = (on: boolean) => {
    // The revision that is on the screen as the person decides: the computer refuses when the plugin is another one by then.
    const looked = plugin.revision;
    const go = async () => {
      setBusy(true);
      await attempt(pluginCalls.setEnabled(plugin.id, on, looked), on ? "Turned on" : undefined);
      setBusy(false);
    };
    if (on) askToRun(plugin, "turn on", () => void go(), older);
    else void go();
  };
  // An update is the repair (the copy is not the reviewed files, or could not be read): Update comes first, and "Turn on" after it.
  const repair = plugin.repair === "update";
  // A plugin in error that no update repairs (a linked folder that could not be copied) can only be removed.
  const canTurnOn = !repair && plugin.status !== "error";
  const update = plugin.updateAvailable || !!plugin.folder || repair;
  return (
    <>
      {canManage && repair && <Button title="Update" wide disabled={!online} onPress={() => router.push(updateHref(plugin.id))} />}
      {canManage && (plugin.enabled ? (
        <Group>
          <Row title="On" subtitle={botsLine(plugin.bots, names)} toggled disabled={!online || busy} onToggle={turn} />
        </Group>
      ) : canTurnOn ? (
        <Button title="Turn on" wide loading={busy} disabled={!online} onPress={() => turn(true)} />
      ) : null)}
      {canManage && update && !repair && <Button title={plugin.folder ? "Update from folder" : "Update"} variant="secondary" wide disabled={!online} onPress={() => router.push(updateHref(plugin.id))} />}
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
      {canManage && <Settings plugin={plugin} />}
      {canManage && <Bots plugin={plugin} />}
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
            <Row key={field.key} title={field.label + (field.required ? "" : " (optional)")} subtitle={[field.description, ...sentToLines(field)].filter(Boolean).join("\n")} subtitleLines={8} value={fieldState(field)} chevron onPress={() => setOpen(field.key)} />
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
      <WhereItGoes field={field} />
      {field.secret && <CredentialPicker disabled={busy || !online} onPick={(ref, name) => void send({ $credential: ref.$credential }, "Uses " + name)} />}
      <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
        {field.set && <Button title="Clear" variant="ghost" size="sm" disabled={busy || !online} onPress={() => void send(null, "Cleared")} />}
        <Button title="Cancel" variant="ghost" size="sm" disabled={busy} onPress={onDone} />
        <Button title="Save" size="sm" loading={busy} disabled={!typed || !online} onPress={() => void send(field.secret ? text : text.trim(), "Saved")} />
      </View>
    </View>
  );
}

/** Under a setting's field, where its value is asked for: where the value goes, and its default when it is not a secret. */
export function WhereItGoes({ field }: { field: Pick<InstalledPlugin["config"][number], "sentTo" | "default" | "secret"> }) {
  const lines = [...sentToLines(field), ...(!field.secret && field.default ? ["Default: " + shownText(field.default)] : [])];
  if (!lines.length) return null;
  return (
    <View style={{ gap: 1, paddingHorizontal: space.xs }}>
      {lines.map((line, index) => (
        <T key={index} variant="footnote" color="muted">
          {line}
        </T>
      ))}
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
  const set = (next: "all" | string[]) => void attempt(pluginCalls.setBots(plugin.id, next, plugin.revision));
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
  const canRemove = useCan("plugins", "uninstall");
  if (!canRemove) return null;
  const remove = () =>
    Alert.alert("Remove " + shownText(plugin.name) + "?", "Your bots stop using it. Its settings are removed from your computer.", [
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
