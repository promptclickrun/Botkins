import { useLocalSearchParams } from "expo-router";
import { AlertCircle, CheckCircle2, SearchX } from "lucide-react-native";
import { useEffect } from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import { type Account, useComposio } from "@/composio/store";
import { AppLogo, Button, EmptyState, Group, Label, Loading, radius, Row, Sheet, space, T, Tap, useTheme } from "@/ui";

function AccountRow({ slug, app, account }: { slug: string; app: string; account: Account }) {
  const { colors } = useTheme();
  const removing = useComposio((state) => !!state.removing[account.id]);
  const remove = useComposio((state) => state.removeAccount);
  const active = account.status === "active";
  const confirm = () =>
    Alert.alert("Remove this " + app + " account?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void remove(slug, account.id) },
    ]);
  return (
    <Row
      leading={active ? <CheckCircle2 size={22} color={colors.success} strokeWidth={2.3} /> : <AlertCircle size={22} color={colors.warning} strokeWidth={2.3} />}
      title={account.label ?? (active ? "Connected" : "Needs sign-in")}
      subtitle={account.label && !active ? "Needs sign-in" : undefined}
      trailing={
        removing ? (
          <ActivityIndicator color={colors.muted} style={{ width: 64 }} />
        ) : (
          <Tap onPress={confirm} feel="select" accessibilityLabel={"Remove " + (account.label ?? app + " account")} style={{ minHeight: 44, minWidth: 64, alignItems: "flex-end", justifyContent: "center" }}>
            <T variant="subhead" weight="600" color="danger">
              Remove
            </T>
          </Tap>
        )
      }
    />
  );
}

export default function AppSheet() {
  const { colors } = useTheme();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const catalog = useComposio((state) => state.catalog);
  const catalogStatus = useComposio((state) => state.catalogStatus);
  const authReady = useComposio((state) => state.authReady);
  const signedIn = useComposio((state) => !!state.account);
  const signingIn = useComposio((state) => state.signingIn);
  const accounts = useComposio((state) => state.accounts[slug]);
  const statusFailed = useComposio((state) => !!state.statusFailed[slug]);
  const connecting = useComposio((state) => !!state.connecting[slug]);
  const app = catalog?.bySlug.get(slug);

  useEffect(() => {
    useComposio.getState().boot();
  }, []);
  useEffect(() => {
    if (signedIn && slug) void useComposio.getState().loadStatus([slug], true);
  }, [signedIn, slug]);

  if (!app)
    return (
      <Sheet title="">
        {!catalog && catalogStatus !== "error" ? <Loading /> : <EmptyState icon={SearchX} title="This app isn't in the list" />}
      </Sheet>
    );

  const categories = app.categories.map((id) => catalog?.categories.find((category) => category.id === id)?.name).filter(Boolean) as string[];
  const shown = (accounts ?? []).filter((account) => account.status === "active" || account.status === "failed");
  const hasActive = shown.some((account) => account.status === "active");
  const store = useComposio.getState;

  const signInThenConnect = async () => {
    if (await store().signIn()) void store().connect(app.slug);
  };

  let body;
  if (app.noAuth) {
    body = (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.md, backgroundColor: colors.successSoft }}>
        <CheckCircle2 size={22} color={colors.success} strokeWidth={2.3} />
        <T variant="subhead" weight="600" color="success" style={{ flex: 1 }}>
          Ready. No sign-in needed.
        </T>
      </View>
    );
  } else if (!authReady) {
    body = <Loading />;
  } else if (!signedIn) {
    body = <Button title="Sign in to connect" wide size="lg" loading={signingIn} onPress={() => void signInThenConnect()} />;
  } else {
    body = (
      <>
        {accounts === undefined ? (
          statusFailed ? (
            <Group>
              <Row title="Couldn't load your accounts" tone="accent" value="Try again" onPress={() => void store().loadStatus([app.slug], true)} />
            </Group>
          ) : (
            <Loading />
          )
        ) : (
          shown.length > 0 && (
            <View>
              <Label>Accounts</Label>
              <Group>
                {shown.map((account) => (
                  <AccountRow key={account.id} slug={app.slug} app={app.name} account={account} />
                ))}
              </Group>
            </View>
          )
        )}
        {connecting ? (
          <View style={{ gap: space.sm }}>
            <View style={{ height: 54, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.md, borderRadius: radius.md, backgroundColor: colors.sunken }} accessibilityLiveRegion="polite">
              <ActivityIndicator color={colors.muted} />
              <T variant="headline" color="ink2" numberOfLines={1}>
                {"Waiting for " + app.name + "…"}
              </T>
            </View>
            <Button title="Cancel" variant="ghost" wide onPress={() => store().cancelConnect(app.slug)} />
          </View>
        ) : (
          <Button title={hasActive ? "Add another account" : "Connect"} wide size="lg" disabled={accounts === undefined && !statusFailed} onPress={() => void store().connect(app.slug)} />
        )}
      </>
    );
  }

  return (
    <Sheet title="">
      <View style={{ gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
          <AppLogo name={app.name} uri={app.logo} size={64} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T variant="title2" numberOfLines={2} accessibilityRole="header">
              {app.name}
            </T>
            {categories.length > 0 && (
              <T variant="footnote" color="muted" numberOfLines={1}>
                {categories.join(" · ")}
              </T>
            )}
          </View>
        </View>
        {!!app.description && (
          <T variant="subhead" color="ink2" numberOfLines={4}>
            {app.description}
          </T>
        )}
      </View>

      {body}

      {!app.noAuth && (
        <T variant="footnote" color="muted" center>
          {"You sign in to " + app.name + " on its own page, through Composio."}
        </T>
      )}
    </Sheet>
  );
}
