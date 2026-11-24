// One password manager on the computer: get it ready, then pick a field of an item to link as a
// credential. Vaults, items and fields are steps on this one screen. Values never reach the phone.
import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { ChevronLeft, Copy, ExternalLink, Lock, RefreshCw, Search, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import type { PasswordManagerId, PasswordManagerItem, PasswordManagerStatus, PasswordManagerVault } from "@/link/types";
import { useProtonSetup } from "@/link/proton-pass";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { Badge, Button, EmptyState, Field, Group, IconButton, IconTile, Label, lift, Loading, Page, radius, Row, space, T, Tap, useTheme } from "@/ui";
import { GateView, isManagerId, KeptNote, loadManagers, ManagerMark, managerBadge, managerName, putManager, SecretField, useGate, useManagers, useProtonSupport } from "./shared";
import { ProtonManagerActions, ProtonPassSheet, protonCalls } from "./ProtonPassSetup";

export default function ManagerPage() {
  const { id, share } = useLocalSearchParams<{ id: string; share?: string }>();
  const gate = useGate();
  if (gate !== "open")
    return (
      <Page>
        <GateView gate={gate} />
      </Page>
    );
  if (!isManagerId(id))
    return (
      <Page>
        <EmptyState title="This password manager isn't known" />
      </Page>
    );
  return <Manager key={id} id={id} share={share === "1"} />;
}

function Manager({ id, share }: { id: PasswordManagerId; share: boolean }) {
  const { colors } = useTheme();
  const status = useManagers((state) => state.managers?.find((manager) => manager.id === id));
  const loaded = useManagers((state) => state.managers !== undefined);
  const unlockedHere = useManagers((state) => state.unlockedHere.includes(id));
  const [checking, setChecking] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [protonBrowsing, setProtonBrowsing] = useState(false);
  const protonSupported = useProtonSupport() && id === "protonpass";
  const proton = useProtonSetup(protonCalls, (next) => {
    putManager(next, false);
    setProtonBrowsing(false);
  });
  const opened = useRef(false);

  useEffect(() => {
    if (protonSupported && status && share && !opened.current) {
      opened.current = true;
      proton.begin("sign-in", true);
    }
  }, [protonSupported, status, share, proton]);

  useEffect(() => {
    void loadManagers();
  }, []);

  const checkAgain = async () => {
    setChecking(true);
    await loadManagers(true);
    setChecking(false);
  };
  const unlock = async () => {
    const secret = { password };
    // The field empties at once; the password only lives for the length of the call.
    setPassword("");
    setUnlocking(true);
    const next = await attempt(api["link.credentials.unlock"](id, secret));
    secret.password = "";
    setUnlocking(false);
    if (next) putManager(next, next.state === "ready");
  };
  const lock = async () => {
    const next = await attempt(api["link.credentials.lock"](id), "Locked");
    if (next) putManager(next, false);
  };
  const copy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    showToast("Copied", "success");
  };

  const name = status?.name ?? managerName(id);
  const badge = managerBadge(status, protonSupported);
  const facts = [status?.account, status?.version && "Version " + status.version].filter(Boolean).join(" · ");
  const card = { gap: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line } as const;

  return (
    <Page onRefresh={checkAgain} refreshing={checking} keyboard>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
        <ManagerMark id={id} size={64} />
        <View style={{ flex: 1, gap: space.xs }}>
          <T variant="title1" accessibilityRole="header" numberOfLines={2}>
            {name}
          </T>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }} accessible accessibilityLabel={"Status: " + badge.label}>
            <Badge label={badge.label} tone={badge.tone} />
            {!!facts && (protonSupported || status?.state === "ready") && (
              <T variant="footnote" color="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                {facts}
              </T>
            )}
          </View>
        </View>
      </View>

      {!loaded ? (
        <Loading />
      ) : !status ? (
        <Button title="Check again" icon={RefreshCw} size="lg" wide loading={checking} onPress={() => void checkAgain()} />
      ) : protonSupported ? (
        <>
          <ProtonManagerActions status={status} setup={proton} browse={() => setProtonBrowsing(true)} />
          {protonBrowsing && (status.state === "ready" || status.state === "expiring") && <Browser status={status} />}
          {proton.view && <ProtonPassSheet setup={proton} />}
        </>
      ) : status.state === "missing" ? (
        <View style={card}>
          <T variant="callout" weight="600">
            {status.message ?? "Install its command-line tool on your computer."}
          </T>
          {!!status.install?.command && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.md, borderRadius: radius.sm, backgroundColor: colors.sunken }}>
              <T variant="mono" selectable style={{ flex: 1, paddingVertical: space.md }}>
                {status.install.command}
              </T>
              <IconButton icon={Copy} label="Copy install command" size={44} color={colors.ink2} onPress={() => void copy(status.install!.command!)} />
            </View>
          )}
          {!!status.install?.url && (
            <Group style={{ marginHorizontal: -space.lg, marginBottom: -space.lg, borderRadius: 0, borderWidth: 0, backgroundColor: "transparent" }}>
              <Row leading={<IconTile icon={ExternalLink} color={colors.ink2} />} title="Install guide" chevron onPress={() => void WebBrowser.openBrowserAsync(status.install!.url)} />
            </Group>
          )}
        </View>
      ) : status.state === "locked" && status.canUnlock ? (
        <View style={{ gap: space.md }}>
          <SecretField label="Master password" value={password} onChangeText={setPassword} placeholder={unlocking ? "Unlocking…" : undefined} returnKeyType="go" onSubmitEditing={() => password && void unlock()} editable={!unlocking} />
          <Button title="Unlock" size="lg" wide loading={unlocking} disabled={!password} onPress={() => void unlock()} />
          <KeptNote text="Sent to your computer, never saved" />
        </View>
      ) : status.state !== "ready" ? (
        <View style={{ gap: space.md }}>
          <T variant="callout" color="muted">
            {status.message ?? (status.state === "locked" ? "Unlock it on your computer." : status.state === "signed-out" ? "Sign in on your computer." : "Something is wrong with it on your computer.")}
          </T>
          <Button title="Check again" icon={RefreshCw} size="lg" wide loading={checking} onPress={() => void checkAgain()} />
        </View>
      ) : (
        <>
          <Browser status={status} />
          {unlockedHere && (
            <Group>
              <Row leading={<IconTile icon={Lock} color={colors.ink2} />} title="Lock" onPress={() => void lock()} />
            </Group>
          )}
        </>
      )}
    </Page>
  );
}

type Item = PasswordManagerItem;
type ItemField = NonNullable<Item["fields"]>[number];

/** Vaults, then a vault's items, then an item's fields: one step at a time, in place. */
function Browser({ status }: { status: PasswordManagerStatus }) {
  const theme = useTheme();
  const { colors } = theme;
  const manager = status.id;
  const [vaults, setVaults] = useState<PasswordManagerVault[] | null | undefined>(undefined);
  const [vault, setVault] = useState<PasswordManagerVault | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[] | null | undefined>(undefined);
  const [item, setItem] = useState<Item | undefined>(undefined);
  const [detail, setDetail] = useState<Item | null | undefined>(undefined);
  const [field, setField] = useState<ItemField | undefined>(undefined);
  const [name, setName] = useState("");
  const [linking, setLinking] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    void attempt(api["link.credentials.vaults"](manager)).then((list) => live && setVaults(list ?? null));
    return () => {
      live = false;
    };
  }, [manager, round]);

  // Items are searched on the computer, a moment after typing stops.
  useEffect(() => {
    if (!vault) return;
    let live = true;
    const text = query.trim();
    const timer = setTimeout(() => void attempt(api["link.credentials.items"](manager, vault.id, text || undefined)).then((list) => live && setItems(list ?? null)), text ? 300 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [manager, vault, query]);

  useEffect(() => {
    if (!vault || !item) return;
    let live = true;
    void attempt(api["link.credentials.item"](manager, vault.id, item.id)).then((full) => live && setDetail(full ?? null));
    return () => {
      live = false;
    };
  }, [manager, vault, item]);

  const toVaults = () => {
    setVault(undefined);
    setItems(undefined);
    setQuery("");
    toItems();
  };
  const toItems = () => {
    setItem(undefined);
    setDetail(undefined);
    setField(undefined);
  };
  const openVault = (next: PasswordManagerVault) => {
    setItems(undefined);
    setQuery("");
    setVault(next);
  };
  const openItem = (next: Item) => {
    setDetail(undefined);
    setField(undefined);
    setItem(next);
  };
  const pickField = (next: ItemField) => {
    setField(next);
    setName((item?.title ?? "") + " " + next.label);
  };
  const link = async () => {
    if (!vault || !item || !field || !name.trim()) return;
    setLinking(true);
    const id = await attempt(api["link.credentials.link"]({ manager, vaultId: vault.id, itemId: item.id, fieldId: field.id, name: name.trim() }), "Linked " + name.trim());
    setLinking(false);
    if (id) router.back();
  };

  const crumbs = [vault?.name, item?.title].filter((part): part is string => !!part);

  return (
    <View style={{ gap: space.md }}>
      {vault ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, marginLeft: -space.sm }}>
          <IconButton icon={ChevronLeft} label={item ? "Back to " + vault.name : "Back to vaults"} size={44} color={colors.accentText} onPress={item ? toItems : toVaults} />
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", flexWrap: "wrap" }} accessibilityRole="header">
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1;
              return (
                <View key={index} style={{ flexDirection: "row", alignItems: "center" }}>
                  {index > 0 && (
                    <T variant="callout" color="faint">
                      {" / "}
                    </T>
                  )}
                  {last ? (
                    <T variant="callout" weight="600" numberOfLines={1}>
                      {crumb}
                    </T>
                  ) : (
                    <Tap onPress={toItems} feel="select" accessibilityLabel={"Back to " + crumb} style={{ minHeight: 44, justifyContent: "center" }}>
                      <T variant="callout" weight="600" color="accentText" numberOfLines={1}>
                        {crumb}
                      </T>
                    </Tap>
                  )}
                </View>
              );
            })}
          </View>
        </View>
      ) : (
        <Label style={{ marginBottom: 0 }}>Vaults</Label>
      )}

      {!vault ? (
        vaults === undefined ? (
          <Loading />
        ) : (
          <Group>
            {(vaults ?? []).map((entry) => (
              <Row key={entry.id} title={entry.name} value={entry.count === undefined ? undefined : String(entry.count)} chevron onPress={() => openVault(entry)} />
            ))}
            {vaults?.length === 0 && <Row title="No vaults" />}
            {vaults === null && <Row title="Vaults didn't load" value="Retry" tone="accent" onPress={() => setRound(round + 1)} />}
          </Group>
        )
      ) : !item ? (
        <>
          <View>
            <Field placeholder={"Search " + vault.name} accessibilityLabel={"Search " + vault.name} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing" style={{ paddingLeft: 42 }} />
            <View pointerEvents="none" style={{ position: "absolute", left: space.lg, top: 0, bottom: 0, justifyContent: "center" }}>
              <Search size={17} color={colors.muted} strokeWidth={2.3} />
            </View>
          </View>
          {items === undefined ? (
            <Loading />
          ) : (
            <Group>
              {(items ?? []).map((entry) => (
                <Row key={entry.id} title={entry.title} subtitle={entry.subtitle} chevron onPress={() => openItem(entry)} />
              ))}
              {items?.length === 0 && <Row title={query.trim() ? "Nothing matches" : "No items"} />}
              {items === null && <Row title="Items didn't load" value="Retry" tone="accent" onPress={() => openVault({ ...vault })} />}
            </Group>
          )}
        </>
      ) : (
        <Animated.View entering={FadeIn.duration(180)} style={[{ borderRadius: radius.lg, backgroundColor: colors.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden" }, lift(theme)]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.lg, paddingRight: space.xs, paddingTop: space.xs }}>
            <View style={{ flex: 1, paddingVertical: space.sm }}>
              <T variant="headline" numberOfLines={2}>
                {item.title}
              </T>
              {!!item.subtitle && (
                <T variant="footnote" color="muted" numberOfLines={1}>
                  {item.subtitle}
                </T>
              )}
            </View>
            <IconButton icon={X} label="Close item" size={44} color={colors.muted} onPress={toItems} />
          </View>
          {field ? (
            <View style={{ padding: space.lg, paddingTop: space.sm, gap: space.md }}>
              <Field label="Name" value={name} onChangeText={setName} autoFocus selectTextOnFocus returnKeyType="done" onSubmitEditing={() => void link()} error={name.trim() ? undefined : "Give it a name."} />
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <Button title="Cancel" variant="secondary" onPress={() => setField(undefined)} style={{ flex: 1 }} />
                <Button title="Link" loading={linking} disabled={!name.trim()} onPress={() => void link()} style={{ flex: 1 }} />
              </View>
            </View>
          ) : detail === undefined ? (
            <View style={{ paddingVertical: space.xl, alignItems: "center" }}>
              <ActivityIndicator color={colors.muted} />
            </View>
          ) : (
            <Group flush={false} style={{ borderRadius: 0, borderWidth: 0, borderTopWidth: StyleSheet.hairlineWidth, backgroundColor: "transparent" }}>
              {(detail?.fields ?? []).map((entry) => (
                <Row key={entry.id} title={entry.label} trailing={entry.secret ? <Lock size={15} color={colors.muted} strokeWidth={2.3} /> : undefined} chevron onPress={() => pickField(entry)} />
              ))}
              {detail?.fields?.length === 0 && <Row title="No fields to link" />}
              {detail === null && <Row title="This item didn't load" value="Retry" tone="accent" onPress={() => openItem({ ...item })} />}
            </Group>
          )}
        </Animated.View>
      )}
    </View>
  );
}
