// The computer's folders, to choose one from the phone. It stands in for the folder dialog the app
// on the computer opens ("Add folder…", "Choose folder…", "Add from folder…"). The computer names the
// folders in the person's home folder and on plugged-in disks, never a file (`folders-v1`), and it
// checks the chosen folder again when it is used.
import { router, useLocalSearchParams } from "expo-router";
import { CornerLeftUp, Folder, HardDrive, House } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { FolderList } from "@/link/types";
import { addedSkillsNote, folderName, placeOf } from "@/state/fileText";
import { pluginCalls, pluginHref, usePluginsReady } from "@/features/market/plugins/calls";
import { refresh, useCapability, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { Button, Chip, EmptyState, Group, IconTile, Loading, Row, Sheet, space, T, useTheme } from "@/ui";

/** What the chosen folder is for: a new project, a project's own folder (`id`), skills, or a plugin ("plugins-v1"). */
type Use = "project-new" | "project" | "skills" | "plugin";
const WORDS: Record<Use, { title: string; action: string }> = {
  "project-new": { title: "Add folder", action: "Add" },
  project: { title: "Choose folder", action: "Choose" },
  skills: { title: "Add from folder", action: "Add" },
  plugin: { title: "Add a plugin", action: "Add" },
};

export default function FolderPicker() {
  const params = useLocalSearchParams<{ use?: Use; id?: string }>();
  const use: Use = params.use && params.use in WORDS ? params.use : "project";
  const words = WORDS[use];
  const pluginsOk = usePluginsReady() || use !== "plugin";
  const { colors } = useTheme();
  const can = useCapability("folders-v1") && pluginsOk;
  const online = useOnline();
  // `at` is the folder asked for (none: the home folder). `good` is the last one the computer listed.
  const [at, setAt] = useState<string>();
  const [tries, setTries] = useState(0);
  const [result, setResult] = useState<{ key: string; list?: FolderList; error?: string }>();
  const [good, setGood] = useState<FolderList>();
  const [busy, setBusy] = useState(false);
  const key = (at ?? "") + ":" + tries;

  useEffect(() => {
    if (!can || !online) return;
    let live = true;
    api.listFolders(at).then(
      (list) => {
        if (!live) return;
        setGood(list);
        setResult({ key, list });
      },
      (error: unknown) => live && setResult({ key, error: error instanceof Error ? error.message : "Couldn't read that folder." }),
    );
    return () => {
      live = false;
    };
  }, [can, online, at, key]);

  const loaded = result?.key === key ? result : undefined;
  const list = loaded?.list;

  // The sheet's button uses the folder that is open.
  const choose = async () => {
    if (!list || busy) return;
    setBusy(true);
    if (use === "project-new") {
      const made = await attempt(api.addProjectFolder(list.path));
      setBusy(false);
      if (made) router.replace({ pathname: "/projects/[id]", params: { id: made } });
      return;
    }
    if (use === "plugin") {
      // A folder plugin arrives on (an older computer added it off): its page shows what it runs.
      const added = await attempt(pluginCalls.addFolder(list.path));
      setBusy(false);
      if (added) router.replace(pluginHref(added.id));
      return;
    }
    let done = false;
    if (use === "skills") {
      const added = await attempt(api.addSkillFolderAt(list.path));
      if (added) {
        showToast(addedSkillsNote(added), "success");
        void refresh("skills");
        // A plugin folder is never linked: it is installed as a plugin. Its page shows what it runs.
        if (added.kind === "plugin" && added.id) {
          setBusy(false);
          router.replace(pluginHref(added.id));
          return;
        }
        done = true;
      }
    } else if (params.id) {
      done = (await attempt(api.updateProject(params.id, { folder: list.path }).then(() => true), "Folder chosen")) === true;
    }
    setBusy(false);
    if (done) router.back();
  };

  const place = list && placeOf(list);
  return (
    <Sheet title={words.title} action={words.action} onAction={() => void choose()} actionDisabled={!list || busy || !online} actionLoading={busy}>
      {!can ? (
        <EmptyState icon={Folder} title="Update the app on your computer" />
      ) : !loaded ? (
        <Loading />
      ) : !list ? (
        <View style={{ gap: space.md }}>
          <EmptyState icon={Folder} title="Couldn't open this folder" text={loaded.error} action="Try again" onAction={() => setTries((n) => n + 1)} />
          {good && good.path !== at && <Button title={"Back to " + folderName(good.path)} variant="ghost" onPress={() => setAt(good.path)} />}
        </View>
      ) : (
        <>
          {!!list.roots && list.roots.length > 1 && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {list.roots.map((root, index) => (
                <Chip key={root.path} label={root.name} icon={index === 0 ? House : HardDrive} selected={place === root.path} onPress={() => setAt(root.path)} />
              ))}
            </View>
          )}
          <View style={{ gap: space.xs }} accessible accessibilityLabel={"Folder on your computer, " + list.path}>
            <T variant="title3" numberOfLines={1}>
              {folderName(list.path)}
            </T>
            <T variant="mono" color="muted" numberOfLines={2} ellipsizeMode="middle">
              {list.path}
            </T>
          </View>
          {(!!list.parent || list.folders.length > 0) && (
            <Group>
              {!!list.parent && <Row leading={<IconTile icon={CornerLeftUp} color={colors.ink2} />} title={folderName(list.parent)} subtitle="Up one folder" onPress={() => setAt(list.parent ?? undefined)} />}
              {list.folders.map((folder) => (
                <Row key={folder.path} leading={<IconTile icon={Folder} color={colors.ink2} />} title={folder.name} chevron onPress={() => setAt(folder.path)} />
              ))}
            </Group>
          )}
          {(list.folders.length === 0 || list.more) && (
            <T variant="footnote" color="muted" center>
              {list.more ? "Showing the first " + list.folders.length + " folders" : "No folders inside"}
            </T>
          )}
        </>
      )}
    </Sheet>
  );
}
