// An app of the computer's apps catalog: what it is, how it connects, and the one way to add it.
// None: Add. OAuth: Connect (add, then the browser sign-in on the computer). Key: a masked field per
// key, sent once with the add and cleared; never shown, logged, put in a route or a toast. A program
// on the computer shows its exact line and asks first. Owner only, as the computer says.
import * as WebBrowser from "expo-web-browser";
import { router, useLocalSearchParams } from "expo-router";
import { SearchX } from "lucide-react-native";
import { useState } from "react";
import { Alert, View } from "react-native";
import type { McpCatalogEntry } from "@/link/types";
import { useCan, useMember, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { AppLogo, Button, EmptyState, Group, Label, Loading, radius, Row, Sheet, space, T, useTheme } from "@/ui";
import { shownText } from "@/ui/shownText";
import { SecretField } from "../credentials/shared";
import { addOptions, connectsLine, entryPlan, entryState, keysFilled, needsConfirm, openableUrl } from "./catalog";
import { loadMcpCatalog, useMcpCatalog } from "./data";

/** The browser sign-in, as a tool's page starts it: not awaited for long, "Signed in" when it is. */
function startSignIn(id: string, done?: () => void) {
  void attempt(api.signInMcpServer(id)).then((auth) => {
    done?.();
    void loadMcpCatalog();
    if (auth?.type === "oauth" && auth.signedIn) showToast("Signed in", "success");
  });
}

/** Asks before a program starts on the computer, with its exact line. */
function confirmStart(entry: McpCatalogEntry, then: () => void) {
  Alert.alert("Start this on your computer?", shownText(entry.command ?? ""), [
    { text: "Cancel", style: "cancel" },
    { text: "Start", onPress: then },
  ]);
}

export default function ToolSheet() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { supported, allowed, catalog, error } = useMcpCatalog();
  if (!supported) return <Sheet title="App"><EmptyState title="Update the app on your computer" /></Sheet>;
  if (!allowed) return <Sheet title="App"><EmptyState title="Your team role can't view tools" /></Sheet>;
  const entry = catalog?.entries.find((item) => item.id === id);
  if (!entry)
    return (
      <Sheet title="App">
        {catalog ? <EmptyState icon={SearchX} title="This app isn't in the list" /> : error ? <EmptyState title="The apps didn't load" text={error} action="Try again" onAction={() => void loadMcpCatalog()} /> : <Loading />}
      </Sheet>
    );
  return <Entry key={entry.id} entry={entry} />;
}

function Entry({ entry }: { entry: McpCatalogEntry }) {
  const { colors } = useTheme();
  const owner = !useMember();
  const online = useOnline();
  const canView = useCan("mcp", "view");
  const canManage = useCan("mcp", "manage");
  const plan = entryPlan(entry);
  const state = entryState(entry);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState(false);
  const [toggling, setToggling] = useState<boolean>();

  const send = async (confirmed: boolean) => {
    const typed = keys;
    // The field is cleared as the key leaves: it is sent once, and never kept on the phone.
    setKeys({});
    setBusy(true);
    const result = await attempt(api["mcpCatalog.add"](entry.id, addOptions(entry, typed, confirmed)));
    setBusy(false);
    if (!result) return;
    setChanging(false);
    void loadMcpCatalog();
    if (result.next === "sign-in") {
      setSigning(true);
      startSignIn(result.serverId, () => setSigning(false));
    } else showToast(Object.keys(typed).length ? "Key saved" : entry.name + " added", "success");
  };
  const add = () => {
    if (entry.transport === "stdio" && !entry.command) return;
    if (needsConfirm(entry)) confirmStart(entry, () => void send(true));
    else void send(false);
  };

  const toggle = async (on: boolean) => {
    if (!entry.serverId) return;
    setToggling(on);
    await attempt(api.setMcpServerEnabled(entry.serverId, on));
    await loadMcpCatalog();
    setToggling(undefined);
  };

  const keyForm = (first: boolean) => (
    <View style={{ gap: space.md }}>
      {entry.keys.map((key) => (
        <SecretField
          key={key.id}
          label={key.label}
          placeholder={key.hint}
          value={keys[key.id] ?? ""}
          onChangeText={(value) => setKeys((all) => ({ ...all, [key.id]: value }))}
          editable={!busy}
        />
      ))}
      <Button title="Save" wide loading={busy} disabled={!online || (first ? !keysFilled(entry, keys) : !Object.values(keys).some((value) => value.trim()))} onPress={add} />
      {!first && <Button title="Cancel" variant="ghost" wide onPress={() => (setKeys({}), setChanging(false))} />}
    </View>
  );

  let actions;
  if (!owner) actions = <T variant="footnote" color="muted" center>Only the owner of your computer can add apps</T>;
  else if (!entry.added) actions = plan.kind === "key" ? keyForm(true) : <Button title={plan.label} wide size="lg" loading={busy || signing} disabled={!online} accessibilityLabel={plan.label + " " + entry.name} onPress={add} />;
  else if (changing || entry.commandChanged) actions = keyForm(!!entry.commandChanged);

  // A program on the computer: its exact line, what it gets, its package and license, before the yes.
  const program = entry.transport === "stdio" && !!entry.command && (
    <View>
      <Label>Starts on your computer</Label>
      <T variant="mono" color="ink2" selectable style={{ backgroundColor: colors.sunken, borderRadius: 8, padding: space.sm }}>
        {shownText(entry.command)}
      </T>
    </View>
  );
  const facts = (
    <View>
      <Label>How it connects</Label>
      <Group>
        <Row title={connectsLine(entry)} subtitleLines={3} subtitle={entry.transport === "http" && entry.url ? shownText(entry.url) : undefined} />
        {entry.transport === "stdio" && !!entry.env?.length && <Row title="Gets" subtitle={entry.env.map((name) => shownText(name)).join(", ")} subtitleLines={3} />}
        {entry.transport === "stdio" && !!entry.package && (
          <Row title="Package" subtitle={[shownText(entry.package) + (entry.version ? "@" + shownText(entry.version) : ""), entry.license].filter(Boolean).join(" · ")} subtitleLines={2} />
        )}
        {openableUrl(entry.docs) && <Row title="Docs" tone="accent" chevron onPress={() => void WebBrowser.openBrowserAsync(entry.docs)} />}
      </Group>
    </View>
  );

  return (
    <Sheet title="">
      <View style={{ gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
          <AppLogo name={entry.name} size={64} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T variant="title2" numberOfLines={2} accessibilityRole="header">
              {entry.name}
            </T>
            <T variant="footnote" color="muted" numberOfLines={1}>
              {[entry.categoryName, state?.line].filter(Boolean).join(" · ")}
            </T>
          </View>
        </View>
        {!!entry.description && (
          <T variant="subhead" color="ink2">
            {entry.description}
          </T>
        )}
      </View>

      {!!plan.local && (
        <View style={{ padding: space.md, borderRadius: radius.md, backgroundColor: colors.warningSoft }}>
          <T variant="subhead" color="warning">
            {plan.local}
          </T>
        </View>
      )}

      {entry.added && (
        <Group>
          {canManage && !!entry.serverId && <Row title={(toggling ?? entry.enabled !== false) ? "On" : "Off"} toggled={toggling ?? entry.enabled !== false} disabled={toggling !== undefined || !online} onToggle={(on) => void toggle(on)} />}
          {entry.auth === "oauth" &&
            (entry.signedIn ? (
              <Row title="Signed in" />
            ) : entry.signingIn || signing ? (
              <Row title="Signing in…" subtitle="Finish in the browser on your computer" />
            ) : owner && !!entry.serverId ? (
              <Row title="Sign in" tone="accent" disabled={!online} onPress={() => (setSigning(true), startSignIn(entry.serverId!, () => setSigning(false)))} />
            ) : (
              <Row title="Needs sign-in" />
            ))}
          {entry.keys.length > 0 && !changing && !entry.commandChanged && (
            <Row title={entry.keysSet ? "Key saved" : "Needs a key"} value={owner ? (entry.keysSet ? "Change key" : "Add key") : undefined} onPress={owner ? () => setChanging(true) : undefined} />
          )}
          {canView && !!entry.serverId && <Row title="Open tool" subtitle={entry.serverName} chevron onPress={() => router.push({ pathname: "/tools/[id]", params: { id: entry.serverId! } })} />}
        </Group>
      )}

      {entry.transport === "stdio" ? (
        <>
          {program}
          {facts}
          {actions}
        </>
      ) : (
        <>
          {actions}
          {facts}
        </>
      )}
    </Sheet>
  );
}
