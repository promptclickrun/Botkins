import { type Href, router, Stack } from "expo-router";
import { BookOpen, Folder, FolderPlus, Plus, Puzzle, Sparkles } from "lucide-react-native";
import { useState } from "react";
import { Alert, View } from "react-native";
import type { SkillInfo } from "@/link/types";
import { refresh, useCapability, useOnline, usePart, useSkills } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { brand, Button, Field, Group, IconButton, IconTile, Label, Loading, Page, Row, space, T } from "@/ui";
import { FILTER_FROM, filterSkills, folderName, isBuiltIn, readableName, skillOrigin, skillsIn } from "./shared";

const open = (name: string) => router.push({ pathname: "/skills/[name]", params: { name } });

/** The skills on the computer: the person's own and the ones that ship with it, then the linked folders and plugins. */
export default function Skills() {
  const online = useOnline();
  const canFolders = useCapability("folders-v1");
  const skills = useSkills();
  const part = usePart("skills");
  const off = part?.disabled;
  const folders = part?.folders ?? [];
  const plugins = part?.plugins ?? [];
  const [query, setQuery] = useState("");
  // A switch holds its new place until the list comes back from the computer.
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const toggle = async (name: string, on: boolean) => {
    setPending((held) => ({ ...held, [name]: on }));
    await attempt(api.setSkillEnabled(name, on));
    await refresh("skills");
    setPending(({ [name]: _, ...rest }) => rest);
  };

  // Stops using a linked folder or plugin; the folder itself stays where it is.
  const unlink = (item: { id: string; path: string }, plugin: boolean) => {
    const name = folderName(item.path);
    Alert.alert((plugin ? "Remove the plugin " : "Remove the folder ") + name + "?", "The folder itself stays on your computer.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          await attempt(api.removeSkillFolder(item.id), plugin ? "Removed the plugin " + name : "Unlinked " + name);
          await refresh("skills");
        },
      },
    ]);
  };

  const row = (skill: SkillInfo) => (
    <Row
      key={skill.name}
      leading={<IconTile icon={isBuiltIn(skill) ? Sparkles : skill.origin === "folder" ? Folder : BookOpen} color={isBuiltIn(skill) ? brand.tide : brand.clay} size={36} />}
      title={readableName(skill.name)}
      subtitle={[skillOrigin(skill, folders), skill.description].filter(Boolean).join(" · ")}
      toggled={pending[skill.name] ?? (skill.enabled && !off?.includes(skill.name))}
      onToggle={(on) => void toggle(skill.name, on)}
      onPress={() => open(skill.name)}
    />
  );

  const shown = skills ? filterSkills(skills, query, folders) : [];
  const yours = shown.filter((skill) => !isBuiltIn(skill));
  const builtIn = shown.filter(isBuiltIn);
  const filtering = !!query.trim();

  const folderRow = (item: { id: string; path: string }, plugin: boolean) => {
    const count = plugin ? undefined : skillsIn(skills ?? [], item.id);
    return (
      <Row
        key={item.id}
        leading={<IconTile icon={plugin ? Puzzle : Folder} color={brand.clay} size={36} />}
        title={folderName(item.path)}
        subtitle={count === undefined ? item.path : count + (count === 1 ? " skill · " : " skills · ") + item.path}
        trailing={<Button title="Remove" variant="secondary" size="sm" disabled={!online} accessibilityLabel={(plugin ? "Remove the plugin " : "Remove the folder ") + folderName(item.path)} onPress={() => unlink(item, plugin)} />}
      />
    );
  };

  return (
    <Page title="Skills" caption="What your bots know how to do" keyboard>
      <Stack.Screen options={{ headerRight: () => <IconButton icon={Plus} label="New skill" size={44} onPress={() => open("new")} /> }} />
      {!skills ? (
        <Loading />
      ) : (
        <>
          {skills.length > FILTER_FROM && <Field placeholder="Filter skills" accessibilityLabel="Filter skills" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" returnKeyType="search" />}
          {(!filtering || yours.length > 0) && (
            <View>
              <Label>Yours</Label>
              <Group>{yours.length ? yours.map(row) : <Row leading={<IconTile icon={Plus} />} title="Write your first skill" tone="accent" onPress={() => open("new")} />}</Group>
            </View>
          )}
          {builtIn.length > 0 && (
            <View>
              <Label>Built in</Label>
              <Group>{builtIn.map(row)}</Group>
            </View>
          )}
          {filtering && shown.length === 0 && (
            <T variant="subhead" color="muted" style={{ paddingHorizontal: space.xs }}>
              {"No skills match “" + query.trim() + "”."}
            </T>
          )}
          {(folders.length > 0 || canFolders) && (
            <View>
              <Label>Linked folders</Label>
              <Group>
                {folders.map((item) => folderRow(item, false))}
                {canFolders && (
                  <Row
                    leading={<IconTile icon={FolderPlus} />}
                    title="Add from folder…"
                    subtitle="A skill, a folder of skills or a plugin"
                    tone="accent"
                    disabled={!online}
                    onPress={() => router.push({ pathname: "/folders", params: { use: "skills" } } as unknown as Href)}
                  />
                )}
              </Group>
            </View>
          )}
          {plugins.length > 0 && (
            <View>
              <Label>Plugins</Label>
              <Group>{plugins.map((item) => folderRow(item, true))}</Group>
            </View>
          )}
        </>
      )}
    </Page>
  );
}
