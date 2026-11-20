import { router } from "expo-router";
import { Bot, CheckCircle2, LayoutGrid } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import { searchToolkits } from "@/composio/catalog";
import { type BotsAccess, type Toolkit, useBotsAccess, useComposio } from "@/composio/store";
import { useCan, useOnline } from "@/state/hooks";
import { setPrefs, usePrefs } from "@/state/prefs";
import { AppLogo, Button, EmptyState, Group, IconTile, Label, Mascot, Page, radius, Row, Segmented, space, T, Tap, useTheme } from "@/ui";
import { AppRow, AppTile, RowSkeleton, SearchField, TileSkeleton } from "./parts";
import { PluginsPage } from "./plugins/Plugins";

const RESULTS = 60;

/** A heading over a section, with an optional link at its right. */
function SectionHead({ title, link, onLink }: { title: string; link?: string; onLink?: () => void }) {
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

/** Signed out: a few of the most used apps, fanned out, and the way in. */
function Hero({ apps }: { apps: Toolkit[] }) {
  const { colors } = useTheme();
  const signingIn = useComposio((state) => state.signingIn);
  const signIn = useComposio((state) => state.signIn);
  const tilt = [-14, -7, 0, 7, 14];
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, padding: space.xl, paddingTop: space.xxl, alignItems: "center", gap: space.md }}>
      <View style={{ height: 70, flexDirection: "row", alignItems: "center", justifyContent: "center" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {apps.length === 0 && <Mascot size={68} state="idle" />}
        {apps.slice(0, 5).map((app, index) => {
          const middle = index === 2;
          return (
            <View
              key={app.slug}
              style={{
                marginLeft: index === 0 ? 0 : -10,
                zIndex: middle ? 3 : index === 1 || index === 3 ? 2 : 1,
                padding: 3,
                borderRadius: 16,
                backgroundColor: colors.surface,
                transform: [{ rotate: tilt[index] + "deg" }, { translateY: Math.abs(index - 2) * 4 }],
              }}
            >
              <AppLogo name={app.name} uri={app.logo} size={middle ? 58 : 48} />
            </View>
          );
        })}
      </View>
      <View style={{ alignItems: "center", gap: 4 }}>
        <T variant="title2" center accessibilityRole="header">
          Connect your apps
        </T>
        <T variant="subhead" color="muted" center>
          Sign in with your own Composio account.
        </T>
      </View>
      <Button title="Sign in with Composio" wide loading={signingIn} onPress={() => void signIn()} style={{ marginTop: space.xs }} />
      <T variant="footnote" color="muted" center>
        {"You sign in on Composio's own page."}
      </T>
    </View>
  );
}

const ACCESS: Record<Exclude<BotsAccess, "unknown" | "ready">, { line: string; action?: string; label?: string }> = {
  setup: { line: "Not turned on yet", action: "Turn on", label: "Turn on for my bots" },
  off: { line: "Turned off", action: "Turn on", label: "Turn on for my bots" },
  signin: { line: "Needs a sign-in", action: "Sign in", label: "Sign in for my bots" },
  signingIn: { line: "Finishing on your computer…" },
};

/** Whether the bots on the computer can use these apps, with the one thing to do about it. */
function BotsCard() {
  const theme = useTheme();
  const { colors } = theme;
  const access = useBotsAccess();
  const online = useOnline();
  const busy = useComposio((state) => state.botsBusy);
  const enable = useComposio((state) => state.enableForBots);
  if (access === "unknown") return null;
  if (access === "ready")
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.lg, backgroundColor: colors.successSoft }}>
        <CheckCircle2 size={22} color={colors.success} strokeWidth={2.3} />
        <View style={{ flex: 1, gap: 1 }}>
          <T variant="subhead" weight="700" color="success">
            Your bots can use these apps
          </T>
          <T variant="footnote" color="success">
            Works in new chats
          </T>
        </View>
      </View>
    );
  const look = ACCESS[access];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: space.lg, paddingRight: space.md, paddingVertical: space.md, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
      <IconTile icon={Bot} size={36} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T variant="callout" weight="600" numberOfLines={1}>
          Your bots
        </T>
        <T variant="footnote" color="muted" numberOfLines={2}>
          {online ? look.line : "Can't reach your computer"}
        </T>
      </View>
      {look.action ? (
        <Button title={look.action} accessibilityLabel={look.label} size="sm" loading={busy} disabled={!online} onPress={() => void enable()} />
      ) : (
        <ActivityIndicator color={colors.muted} />
      )}
    </View>
  );
}

/** The apps with an active account, as a shelf. */
function YourApps() {
  const catalog = useComposio((state) => state.catalog);
  const connected = useComposio((state) => state.connected);
  const loaded = useComposio((state) => state.connectedLoaded);
  const apps = useMemo(() => (catalog ? catalog.toolkits.filter((toolkit) => connected[toolkit.slug]) : []), [catalog, connected]);
  return (
    <View>
      <SectionHead title="Your apps" />
      {!loaded || !catalog ? (
        <TileSkeleton rows={1} />
      ) : apps.length === 0 ? (
        <T variant="subhead" color="muted" style={{ paddingHorizontal: space.xs }}>
          Nothing connected yet
        </T>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.xl }} contentContainerStyle={{ paddingHorizontal: space.xl, paddingTop: 6, gap: space.sm }}>
          {apps.map((toolkit) => (
            <AppTile key={toolkit.slug} toolkit={toolkit} width={78} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function SignedInLine({ email }: { email?: string }) {
  const signOut = useComposio((state) => state.signOut);
  const confirm = () =>
    Alert.alert("Sign out of Composio?", "Your apps stay connected in Composio.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void signOut() },
    ]);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.xs }}>
      <T variant="footnote" color="muted" numberOfLines={1} style={{ flex: 1 }}>
        {email ? "Signed in as " + email : "Signed in to Composio"}
      </T>
      <Button title="Sign out" variant="ghost" size="sm" onPress={confirm} style={{ paddingHorizontal: space.sm }} />
    </View>
  );
}

const VIEWS: { value: "apps" | "plugins"; label: string }[] = [
  { value: "apps", label: "Apps" },
  { value: "plugins", label: "Plugins" },
];

/** The tab: Apps (Composio) or Plugins, with the last choice remembered on this phone. */
export default function Market() {
  const canPlugins = useCan("plugins", "view");
  const savedView = usePrefs((prefs) => prefs.marketView);
  const view = canPlugins ? savedView : "apps";
  const switcher = canPlugins ? <Segmented options={VIEWS} value={view} onChange={(marketView) => setPrefs({ marketView })} /> : undefined;
  return view === "plugins" ? <PluginsPage switcher={switcher} /> : <Apps switcher={switcher} />;
}

function Apps({ switcher }: { switcher: ReactNode }) {
  const catalog = useComposio((state) => state.catalog);
  const catalogStatus = useComposio((state) => state.catalogStatus);
  const authReady = useComposio((state) => state.authReady);
  const account = useComposio((state) => state.account);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    useComposio.getState().boot();
  }, []);

  const searching = query.trim().length > 0;
  const results = useMemo(() => (catalog && searching ? searchToolkits(catalog.toolkits, query, RESULTS) : []), [catalog, query, searching]);
  const popular = useMemo(() => catalog?.toolkits.slice(0, 12) ?? [], [catalog]);
  const heroApps = useMemo(() => catalog?.toolkits.filter((toolkit) => !toolkit.noAuth).slice(0, 5) ?? [], [catalog]);
  const rows = useMemo(() => [popular.slice(0, 4), popular.slice(4, 8), popular.slice(8, 12)].filter((row) => row.length > 0), [popular]);

  // The accounts of the apps on screen, a moment after the list settles.
  const onScreen = (searching ? results : popular).map((toolkit) => toolkit.slug).join(",");
  const signedIn = !!account;
  useEffect(() => {
    if (!signedIn || !onScreen) return;
    const timer = setTimeout(() => void useComposio.getState().loadStatus(onScreen.split(",")), 450);
    return () => clearTimeout(timer);
  }, [onScreen, signedIn]);

  const reload = async () => {
    setRefreshing(true);
    const store = useComposio.getState();
    await Promise.all([store.loadCatalog(true), store.refreshConnected()]);
    setRefreshing(false);
  };

  const failed = !catalog && catalogStatus === "error";

  return (
    <Page tab title="Marketplace" quietLink onRefresh={reload} refreshing={refreshing}>
      {switcher}
      <SearchField value={query} onChange={setQuery} />

      {searching ? (
        !catalog ? (
          failed ? (
            <EmptyState icon={LayoutGrid} title="The app list didn't load" action="Try again" onAction={() => void useComposio.getState().loadCatalog(true)} />
          ) : (
            <RowSkeleton rows={4} />
          )
        ) : results.length === 0 ? (
          <T variant="subhead" color="muted" center style={{ paddingVertical: space.huge }}>
            No apps match
          </T>
        ) : (
          <Group>
            {results.map((toolkit) => (
              <AppRow key={toolkit.slug} toolkit={toolkit} />
            ))}
          </Group>
        )
      ) : (
        <>
          {authReady && !account && <Hero apps={heroApps} />}
          {account && <BotsCard />}
          {account && <YourApps />}

          {failed ? (
            <EmptyState icon={LayoutGrid} title="The app list didn't load" action="Try again" onAction={() => void useComposio.getState().loadCatalog(true)} />
          ) : (
            <>
              <View>
                <SectionHead title="Popular" link={catalog ? "See all" : undefined} onLink={() => router.push({ pathname: "/market/category/[id]", params: { id: "all" } })} />
                {!catalog ? (
                  <TileSkeleton rows={3} />
                ) : (
                  <View style={{ gap: space.lg, paddingTop: 6 }}>
                    {rows.map((row) => (
                      <View key={row[0].slug} style={{ flexDirection: "row", gap: space.sm }}>
                        {row.map((toolkit) => (
                          <AppTile key={toolkit.slug} toolkit={toolkit} />
                        ))}
                        {Array.from({ length: 4 - row.length }, (_, index) => (
                          <View key={"gap" + index} style={{ flex: 1 }} />
                        ))}
                      </View>
                    ))}
                  </View>
                )}
              </View>

              {!!catalog && (
                <View>
                  <SectionHead title="Categories" />
                  <Group>
                    {catalog.categories.slice(0, 14).map((category) => (
                      <Row key={category.id} title={category.name} value={String(category.count)} chevron onPress={() => router.push({ pathname: "/market/category/[id]", params: { id: category.id } })} />
                    ))}
                  </Group>
                </View>
              )}
            </>
          )}

          {account && <SignedInLine email={account.email} />}
        </>
      )}
    </Page>
  );
}
