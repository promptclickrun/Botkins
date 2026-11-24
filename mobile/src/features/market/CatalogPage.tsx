// Market › Skills: with no query, the featured shelf by group (each with its license and author) and
// the skills built into Botkins; a search of two characters or more asks skills.sh. A featured
// skill's preview shows its license, author, source (repo@commit) and files.
import * as WebBrowser from "expo-web-browser";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Linking, Modal, View } from "react-native";
import type { CatalogPreview, CatalogSkill } from "@/link/types";
import { refresh, useCan, useCapability, useOnline, useSkills } from "@/state/hooks";
import { api } from "@/state/link";
import { useApp } from "@/state/store";
import { Button, Group, Label, Page, Row, Sheet, space, T } from "@/ui";
import { shownText } from "@/ui/shownText";
import { finishSkillImport } from "../skills/importSkill";
import { askReplace } from "../skills/replaceSkill";
import { builtInSkills, featuredGroups, openableUrl, sourceLine } from "./catalog";
import { SkillRow } from "./catalogParts";
import { useFeaturedSkills } from "./data";
import { SearchField } from "./parts";

export function CatalogPage() {
  const online = useOnline();
  const supported = useCapability("skills-catalog-v1");
  const host = useApp((s) => s.pairing?.serverId);
  if (!online || !supported || !host)
    return (
      <Page title="Skills">
        <T>{online ? "Update the app on your computer to browse skills." : "Connect to your computer to browse skills."}</T>
      </Page>
    );
  return <Catalog key={host} host={host} />;
}

/** What a preview links to: skills.sh for a skills.sh skill, the pinned source for a featured one. */
type Detail = { id: string; preview: CatalogPreview; link?: { label: string; url: string } };

function Catalog({ host }: { host: string }) {
  const params = useLocalSearchParams<{ q?: string; open?: string }>();
  const canInstall = useCan("skills", "create");
  const [query, setQuery] = useState(() => (typeof params.q === "string" ? params.q.slice(0, 200) : ""));
  const [rows, setRows] = useState<CatalogSkill[]>();
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState("");
  const [failedSource, setFailedSource] = useState<CatalogSkill>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const featured = useFeaturedSkills();
  const skills = useSkills();
  const builtIn = useMemo(() => builtInSkills(skills), [skills]);
  const groups = useMemo(() => featuredGroups(featured.value ?? []), [featured.value]);
  const connected = () => useApp.getState().pairing?.serverId === host && useApp.getState().link === "online";
  const searching = query.trim().length > 0;

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
  const previewFeatured = (id: string) =>
    void act(async () => {
      const preview = await api["skillsCatalog.preview"](id);
      setDetail({ id, preview });
    });

  // Opened from the landing on one featured skill: its preview, once.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened || typeof params.open !== "string" || !featured.value) return;
    setOpened(true);
    const skill = featured.value.find((item) => item.id === params.open);
    if (skill?.installed) open(skill.installed);
    else if (skill) previewFeatured(skill.id);
    // Once, when the featured list is in.
  }, [opened, params.open, featured.value]);

  const shownSource = detail?.preview.source;
  return (
    <Page title="Skills" keyboard>
      <SearchField value={query} onChange={(q) => setQuery(q.slice(0, 200))} label="Search skills.sh" />
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
                    setDetail({ id: row.id, preview: await api["skillsCatalog.preview"](row.id), link: { label: row.source + " · Open on skills.sh", url: "https://skills.sh/" + row.id } });
                  }
                })
              }
            />
          ))}
        </Group>
      )}

      {!searching && (
        <>
          {groups.map((group) => (
            <View key={group.group}>
              <Label>{group.group}</Label>
              <Group>
                {group.skills.map((skill) => (
                  <SkillRow key={skill.id} skill={skill} disabled={busy} onPress={() => (skill.installed ? open(skill.installed) : previewFeatured(skill.id))} />
                ))}
              </Group>
            </View>
          ))}
          {!!featured.error && !featured.value && (
            <Group>
              <Row title="Featured skills didn't load" tone="accent" value="Try again" onPress={featured.retry} />
            </Group>
          )}
          {builtIn.length > 0 && (
            <View>
              <Label>Built into Botkins</Label>
              <Group>
                {builtIn.map((skill) => (
                  <Row key={skill.name} title={skill.name} subtitle={skill.description} subtitleLines={2} chevron onPress={() => open(skill.name)} />
                ))}
              </Group>
            </View>
          )}
        </>
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
            {!!shownSource && (
              <Group>
                <Row title="License" value={shownSource.license} />
                <Row title="Author" value={shownSource.author} />
                <Row
                  title="Source"
                  subtitle={shownText(sourceLine(shownSource))}
                  tone={openableUrl(shownSource.url) ? "accent" : undefined}
                  chevron={openableUrl(shownSource.url)}
                  onPress={openableUrl(shownSource.url) ? () => void WebBrowser.openBrowserAsync(shownSource.url) : undefined}
                />
              </Group>
            )}
            {!!detail.link && <Button title={detail.link.label} variant="ghost" onPress={() => void act(() => WebBrowser.openBrowserAsync(detail.link!.url).then(() => undefined))} />}
            {!!detail.preview.files?.length && (
              <View>
                <Label>Files</Label>
                <Group>
                  {detail.preview.files.map((file) => (
                    <Row key={file} title={shownText(file)} />
                  ))}
                </Group>
              </View>
            )}
            {!!error && <T color="danger">{error}</T>}
            <T selectable style={{ marginTop: space.xs }}>
              {detail.preview.text}
            </T>
          </Sheet>
        </Modal>
      )}
    </Page>
  );
}
