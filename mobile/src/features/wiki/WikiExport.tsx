// Wiki › Export…: what to export (the whole wiki, a project, one page), which of its pages, and the
// format. The computer makes the file and hands it over (`files-v1`); the phone's share sheet saves
// or sends it. The choices and their words are the app's on the computer.
import { router, useLocalSearchParams } from "expo-router";
import { Check, FileOutput } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import type { WikiExportFormat, WikiExportPlan } from "@/link/types";
import { shareFile } from "@/state/files";
import { useCapability, useOnline } from "@/state/hooks";
import { api } from "@/state/link";
import { showToast } from "@/state/store";
import { Chip, EmptyState, Field, Group, Label, Loading, Row, Segmented, Sheet, space, T, useTheme } from "@/ui";
import { useWikiTree } from "./data";
import { ABOUT, exportGroups, exportRequest, type ExportScope, FORMATS, scopeFor, SCOPES } from "./exporting";
import { byTitle, message, pageTitle, plural } from "./model";

const NONE: ReadonlySet<string> = new Set();
const MATCHES = 6;

export default function WikiExport() {
  const { start } = useLocalSearchParams<{ start?: string }>();
  const { colors } = useTheme();
  const can = useCapability("files-v1");
  const online = useOnline();
  const { tree } = useWikiTree();
  const pages = tree ? tree.pages.filter((page) => !page.template).sort(byTitle) : [];
  const projects = pages.filter((page) => page.path.toLowerCase().startsWith("projects/"));

  const firstScope: ExportScope = start ? scopeFor(start) : "all";
  const [scope, setScope] = useState<ExportScope>(firstScope);
  const [picked, setPicked] = useState<{ project?: string; page?: string }>({ project: firstScope === "project" ? start : undefined, page: start });
  const path = scope === "project" ? (picked.project ?? projects[0]?.path) : scope === "page" ? (picked.page ?? pages.find((page) => page.path !== tree?.guide)?.path) : undefined;
  const [find, setFind] = useState("");
  const [format, setFormat] = useState<WikiExportFormat>("zip");
  const [busy, setBusy] = useState(false);
  // The plan and the pages switched off belong to one choice of scope and page.
  const key = scope + ":" + (path ?? "");
  const [result, setResult] = useState<{ key: string; plan?: WikiExportPlan; error?: string }>();
  const [skipped, setSkipped] = useState<{ key: string; paths: ReadonlySet<string> }>();
  const waiting = scope !== "all" && !path;

  useEffect(() => {
    if (!can || !online || waiting) return;
    let live = true;
    api.wikiExportPlan(scope === "all" ? { scope } : { scope, path }).then(
      (plan) => live && setResult({ key, plan }),
      (error: unknown) => live && setResult({ key, error: message(error) }),
    );
    return () => {
      live = false;
    };
  }, [can, online, waiting, scope, path, key]);

  const loaded = result?.key === key ? result : undefined;
  const plan = loaded?.plan;
  const off = skipped?.key === key ? skipped.paths : NONE;
  const chosen = plan ? plan.pages.filter((page) => !off.has(page.path)) : [];
  const toggle = (page: string, on: boolean) => {
    const next = new Set(off);
    if (on) next.delete(page);
    else next.add(page);
    setSkipped({ key, paths: next });
  };

  const go = async () => {
    if (!plan || !chosen.length || busy) return;
    setBusy(true);
    try {
      const sent = await shareFile(await api.exportWikiFile(exportRequest(plan, scope, off, format)));
      if (sent) {
        showToast("Exported", "success");
        router.back();
      }
    } catch (error) {
      showToast(message(error), "error");
    }
    setBusy(false);
  };

  const wanted = find.trim().toLowerCase();
  const matches = pages.filter((page) => !wanted || page.title.toLowerCase().includes(wanted) || page.path.toLowerCase().includes(wanted)).slice(0, MATCHES);
  const check = <Check size={18} color={colors.accentText} strokeWidth={2.6} />;

  return (
    <Sheet title="Export" action="Export" onAction={() => void go()} actionDisabled={!chosen.length || busy || !online} actionLoading={busy}>
      {!can ? (
        <EmptyState icon={FileOutput} title="Update the app on your computer" />
      ) : !tree ? (
        <Loading />
      ) : (
        <>
          <View style={{ gap: space.sm }}>
            <Segmented options={SCOPES} value={scope} onChange={setScope} />
            <T variant="footnote" color="muted">
              {scope === "project" && !projects.length ? "No project pages yet." : ABOUT[scope]}
            </T>
          </View>

          {scope === "project" && projects.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ marginHorizontal: -space.xl }} contentContainerStyle={{ paddingHorizontal: space.xl, gap: space.sm }}>
              {projects.map((page) => (
                <Chip key={page.path} label={pageTitle(page)} selected={page.path === path} onPress={() => setPicked({ ...picked, project: page.path })} />
              ))}
            </ScrollView>
          )}

          {scope === "page" && (
            <View style={{ gap: space.sm }}>
              <Field placeholder="Find a page" accessibilityLabel="Find a page" value={find} onChangeText={setFind} autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" returnKeyType="search" />
              {matches.length > 0 && (
                <Group>
                  {matches.map((page) => (
                    <Row key={page.path} title={pageTitle(page)} subtitle={page.path} trailing={page.path === path ? check : undefined} onPress={() => setPicked({ ...picked, page: page.path })} />
                  ))}
                </Group>
              )}
            </View>
          )}

          {waiting ? null : !loaded ? (
            <Loading />
          ) : !plan ? (
            <T variant="subhead" color="danger">
              {loaded.error}
            </T>
          ) : (
            <>
              {exportGroups(plan, scope).map((group) => (
                <View key={group.key}>
                  <Label>{group.label}</Label>
                  <Group>
                    {group.pages.map((page) => (
                      <Row key={page.path} title={page.title} subtitle={scope === "all" ? undefined : page.section} toggled={!off.has(page.path)} onToggle={(on) => toggle(page.path, on)} />
                    ))}
                  </Group>
                </View>
              ))}
              <View>
                <Label>{"Format · " + plural(chosen.length, "page")}</Label>
                <Group>
                  {FORMATS.map((item) => (
                    <Row key={item.value} title={item.label} subtitle={item.hint} trailing={item.value === format ? check : undefined} onPress={() => setFormat(item.value)} />
                  ))}
                </Group>
              </View>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}
