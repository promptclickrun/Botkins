import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import type { InstalledPiPackage, PiPackageListing } from "@/link/types";
import { useCan, useCapability, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { Button, Group, Label, Page, Row, space, T, useOnShow } from "@/ui";
import { shownText } from "@/ui/shownText";
import { SearchField } from "./parts";

export function PiPage() {
  const pairing = useApp((state) => state.pairing);
  const supported = useCapability("pi-packages-v1");
  const online = useOnline();
  if (!online || !supported || !pairing)
    return (
      <Page title="Pi packages">
        <T color="muted">
          {online ? "Update the app on your computer to manage Pi packages." : "Connect to your computer to manage Pi packages."}
        </T>
      </Page>
    );
  return <Packages key={pairing.serverId} host={pairing.serverId} hostName={pairing.name} />;
}

function Packages({ host, hostName }: { host: string; hostName: string }) {
  const shown = useOnShow();
  const [refreshing, setRefreshing] = useState(false);
  const canInstall = useCan("plugins", "install");
  const canManage = useCan("plugins", "manage");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [revision, setRevision] = useState(0);
  const [installed, setInstalled] = useState<InstalledPiPackage[]>();
  const [listing, setListing] = useState<{ packages: PiPackageListing[]; nextPage?: number }>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const sameHost = () => useApp.getState().pairing?.serverId === host && useApp.getState().link === "online";
  useEffect(() => {
    if (!shown) return;
    let live = true;
    setError("");
    api["piPackages.list"]().then(
      (next) => {
        if (live) setInstalled(next);
      },
      (e: Error) => {
        if (live) setError(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, [shown, refresh, revision]);
  useEffect(() => {
    let live = true;
    setListing(undefined);
    setCatalogError("");
    const timer = setTimeout(() => {
      api["piPackages.browse"]({ query, page })
        .then(
          (next) => {
            if (live) setListing(next);
          },
          (e: Error) => {
            if (live) setCatalogError(e.message);
          },
        )
        .finally(() => {
          if (live) setRefreshing(false);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, page, refresh]);
  async function change(name: string, current?: InstalledPiPackage) {
    setBusy(name);
    setError("");
    try {
      const { version } = current ?? (await api["piPackages.preview"](name));
      if (!sameHost()) return;
      if (!current?.enabled) {
        const action = current ? "Turn on" : "Install and turn on";
        const yes = await new Promise<boolean>((resolve) =>
          Alert.alert(
            action + " " + shownText(name + "@" + version) + "?",
            (current ? "" : "Pi will run pi install npm:" + shownText(name + "@" + version) + ". ") +
              "This package can run code on " +
              shownText(hostName) +
              ". It will load on the next turn in every Botkins chat using Pi or OMP.",
            [
              { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
              { text: action, onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          ),
        );
        if (!yes || !sameHost()) return;
      }
      if (current) await api["piPackages.setEnabled"](name, version, !current.enabled);
      else await api["piPackages.install"](name, version);
      setRevision((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The package could not be changed.");
    } finally {
      setBusy("");
    }
  }
  return (
    <Page
      title="Pi packages"
      keyboard
      onRefresh={() => {
        setRefreshing(true);
        setRefresh((n) => n + 1);
      }}
      refreshing={refreshing}
    >
      <Label>Installed in Pi</Label>
      {installed?.length ? (
        <Group>
          {installed.map((pkg) => (
            <Row
              key={pkg.name}
              title={pkg.name}
              subtitle={pkg.version + " · " + (pkg.enabled ? "On" : "Off")}
              toggled={pkg.enabled}
              onToggle={() => void change(pkg.name, pkg)}
              disabled={!canManage || !!busy}
            />
          ))}
        </Group>
      ) : (
        <T color="muted">
          {installed ? "No Pi packages installed." : error ? "Installed packages unavailable." : "Loading installed packages…"}
        </T>
      )}
      <T variant="footnote" color="muted">
        Changes apply on the next turn in every Botkins chat using Pi or OMP.
      </T>
      {!!error && <T color="danger">{shownText(error)}</T>}
      <SearchField
        value={query}
        onChange={(next) => {
          setQuery(next.slice(0, 200));
          setPage(1);
        }}
        label="Search Pi packages"
      />
      <Label>Pi package catalog</Label>
      {catalogError ? (
        <T color="danger">{catalogError}</T>
      ) : !listing ? (
        <T color="muted">Loading Pi packages…</T>
      ) : !listing.packages.length ? (
        <T color="muted">No Pi packages match.</T>
      ) : (
        <Group>
          {listing.packages.map((pkg) => {
            const present = installed?.some((p) => p.name === pkg.name);
            return (
              <View key={pkg.name} style={{ flexDirection: "row", alignItems: "center", paddingRight: space.md }}>
                <View style={{ flex: 1 }}>
                  <Row
                    title={pkg.name}
                    titleLines={2}
                    subtitle={[pkg.types.join(" · "), pkg.description].filter(Boolean).join(" · ")}
                    subtitleLines={3}
                    onPress={() => void attempt(WebBrowser.openBrowserAsync("https://pi.dev/packages/" + pkg.name))}
                  />
                </View>
                {present ? (
                  <T variant="footnote" color="muted">
                    Installed
                  </T>
                ) : (
                  canInstall && (
                    <Button
                      title="Install"
                      variant="secondary"
                      size="sm"
                      accessibilityLabel={"Install " + pkg.name}
                      loading={busy === pkg.name}
                      disabled={!installed || !!busy}
                      onPress={() => void change(pkg.name)}
                    />
                  )
                )}
              </View>
            );
          })}
        </Group>
      )}
      {(page > 1 || !!listing?.nextPage) && (
        <View style={{ flexDirection: "row", gap: space.md }}>
          {page > 1 && <Button title="Previous" variant="secondary" onPress={() => setPage(page - 1)} />}
          {!!listing?.nextPage && <Button title="Next" variant="secondary" onPress={() => setPage(listing.nextPage!)} />}
        </View>
      )}
    </Page>
  );
}
