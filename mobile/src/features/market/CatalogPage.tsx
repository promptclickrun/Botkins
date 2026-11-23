import { useEffect, useState, type ReactNode } from "react";
import { Linking, Modal, View } from "react-native";
import { router } from "expo-router";
import type { CatalogSkill, CatalogPreview } from "@/link/types";
import { refresh, useCan, useCapability, useOnline } from "@/state/hooks";
import { api } from "@/state/link";
import { useApp } from "@/state/store";
import { Button, Group, Page, Row, Sheet, space, T } from "@/ui";
import { finishSkillImport } from "../skills/importSkill";
import { askReplace } from "../skills/replaceSkill";
import { SearchField } from "./parts";

export function CatalogPage({ switcher }: { switcher: ReactNode }) {
  const online = useOnline();
  const supported = useCapability("skills-catalog-v1");
  const host = useApp((s) => s.pairing?.serverId);
  if (!online || !supported || !host)
    return (
      <Page tab title="Marketplace">
        {switcher}
        <T>{online ? "Update the app on your computer to browse skills." : "Connect to your computer to browse skills."}</T>
      </Page>
    );
  return <Catalog key={host} host={host} switcher={switcher} />;
}

function Catalog({ host, switcher }: { host: string; switcher: ReactNode }) {
  const canInstall = useCan("skills", "create");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<CatalogSkill[]>();
  const [detail, setDetail] = useState<{ row: CatalogSkill; preview: CatalogPreview }>();
  const [error, setError] = useState("");
  const [failedSource, setFailedSource] = useState<CatalogSkill>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const connected = () => useApp.getState().pairing?.serverId === host && useApp.getState().link === "online";
  useEffect(() => {
    let live = true;
    setFailedSource(undefined);
    setRows(undefined);
    setError("");
    if (query.trim().length < 2) return;
    const timer = setTimeout(
      () =>
        api["skillsCatalog.search"](query).then(
          (next) => {
            if (live) setRows(next);
          },
          (e: Error) => {
            if (live) setError(e.message);
          },
        ),
      250,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, revision]);
  const open = (name: string) => {
    setDetail(undefined);
    router.push({ pathname: "/skills/[name]", params: { name } });
  };
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The catalog request failed.");
    } finally {
      setBusy(false);
    }
  }
  async function install() {
    if (!detail) return;
    const added = await finishSkillImport((replace) => api["skillsCatalog.install"](detail.preview.token, replace ?? []), askReplace, connected);
    if (!added) return;
    setDetail({ ...detail, preview: { ...detail.preview, installed: added[0] } });
    setRevision((n) => n + 1);
    await refresh("skills");
  }
  const source = (row: CatalogSkill) => Linking.openURL("https://skills.sh/" + row.id);
  return (
    <Page tab title="Marketplace" keyboard>
      {switcher}
      <SearchField value={query} onChange={(q) => setQuery(q.slice(0, 200))} label="Search skills" />
      {!query.trim() && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          {["design", "react", "testing", "docs", "writing"].map((q) => (
            <Button key={q} title={q} size="sm" variant="secondary" onPress={() => setQuery(q)} />
          ))}
        </View>
      )}
      {query.trim().length === 1 && <T>Enter at least two characters.</T>}
      {!!error && !detail && <T color="danger">{error}</T>}
      {query.trim().length >= 2 && !rows && !error && <T>Searching…</T>}
      {failedSource && error && !detail && <Button title="Open on skills.sh" onPress={() => void act(() => source(failedSource))} />}
      {rows && (
        <Group>
          {!rows.length && <Row title="No matching skills." />}
          {rows.map((row) => (
            <Row
              key={row.id}
              title={row.name}
              subtitle={[
                row.source,
                row.installs.toLocaleString() + " installs",
                row.installed ? "Installed · Open skill" : row.available ? "Preview" : "Open on skills.sh",
              ].join(" · ")}
              disabled={busy}
              onPress={() =>
                void act(async () => {
                  if (row.installed) open(row.installed);
                  else if (!row.available) await source(row);
                  else {
                    setFailedSource(row);
                    setDetail({ row, preview: await api["skillsCatalog.preview"](row.id) });
                  }
                })
              }
            />
          ))}
        </Group>
      )}
      {detail && (
        <Modal visible presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setDetail(undefined)}>
          <Sheet
            title={detail.preview.name}
            onClose={() => setDetail(undefined)}
            action={detail.preview.installed ? "Open skill" : canInstall ? "Install" : undefined}
            actionDisabled={busy}
            onAction={() => (detail.preview.installed ? open(detail.preview.installed) : void act(install))}
          >
            <T>{detail.preview.description}</T>
            <Button title={detail.row.source + " · Open on skills.sh"} variant="ghost" onPress={() => void act(() => source(detail.row))} />
            {!!error && <T color="danger">{error}</T>}
            <T selectable>{detail.preview.text}</T>
          </Sheet>
        </Modal>
      )}
    </Page>
  );
}
