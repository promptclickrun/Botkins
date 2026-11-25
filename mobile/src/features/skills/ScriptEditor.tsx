import { router } from "expo-router";
import { Trash2 } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import type { ScriptCommand } from "@/link/types";
import { refresh, useCan, useMember, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { EmptyState, Field, Group, IconTile, Loading, Row, Sheet, useTheme } from "@/ui";
import { readableName, scriptName, scriptProblems } from "./shared";

const EMPTY: ScriptCommand = { name: "", description: "", script: "" };

/**
 * New script command / a script command's page: a slash command that runs a script on the computer with
 * no model ("script-commands-v1"). The whole script is in the field, and Save is the person's yes to it.
 * The owner's alone: the computer refuses anyone else.
 */
export default function ScriptEditor({ name }: { name?: string }) {
  const online = useOnline();
  const member = useMember();
  const [loaded, setLoaded] = useState<{ name: string; command?: ScriptCommand }>();

  useEffect(() => {
    if (!name || !online || member) return;
    let live = true;
    void attempt(api["skills.readScript"](name)).then((command) => live && setLoaded({ name, command }));
    return () => {
      live = false;
    };
  }, [name, online, member]);

  if (member)
    return (
      <Sheet title="Script command">
        <EmptyState title="Only the computer's owner can open script commands" action="Close" onAction={() => router.back()} />
      </Sheet>
    );
  if (!name) return <Editor key="new" />;
  if (loaded?.name !== name)
    return (
      <Sheet title={readableName(name)}>
        <Loading />
      </Sheet>
    );
  if (!loaded.command)
    return (
      <Sheet title={readableName(name)}>
        <EmptyState title="This command is gone" action="Go back" onAction={() => router.back()} />
      </Sheet>
    );
  return <Editor key={name} original={name} command={loaded.command} />;
}

function Editor({ original, command }: { original?: string; command?: ScriptCommand }) {
  const { colors } = useTheme();
  const [start] = useState(() => command ?? EMPTY);
  const [draft, setDraft] = useState(start);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const canDelete = useCan("skills", "delete");
  const isNew = !original;
  const set = (patch: Partial<ScriptCommand>) => setDraft((held) => ({ ...held, ...patch }));
  const changed = draft.name !== start.name || draft.description !== start.description || draft.script !== start.script;
  const problems = scriptProblems(draft);
  const shown = checked ? problems : {};

  const save = async () => {
    setChecked(true);
    if (Object.keys(problems).length) return;
    setSaving(true);
    const saved = await attempt(
      api["skills.saveScript"]({ name: draft.name.trim(), description: draft.description.trim(), script: draft.script, ...(original && { original }) }),
      isNew ? "Command created" : "Saved",
    );
    if (saved === undefined) return setSaving(false);
    await refresh("skills");
    setSaving(false);
    router.back();
  };

  const remove = () => {
    if (!original) return;
    Alert.alert("Remove /" + original + "?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          const done = await attempt(api.removeSkill(original), "Command removed");
          if (done === undefined) return;
          await refresh("skills");
          router.back();
        },
      },
    ]);
  };

  return (
    <Sheet title={isNew ? "New script command" : "/" + original} action={isNew ? "Create" : "Save"} onAction={() => void save()} actionDisabled={!changed} actionLoading={saving}>
      <Field
        label="Name"
        placeholder="deploy-preview"
        hint="You type it as /name in a chat"
        value={draft.name}
        onChangeText={(name) => set({ name: scriptName(name) })}
        autoCapitalize="none"
        autoCorrect={false}
        mono
        error={shown.name}
        autoFocus={isNew}
      />
      <Field label="What it does" placeholder="Builds the site and opens a preview" value={draft.description} onChangeText={(description) => set({ description })} returnKeyType="next" error={shown.description} />
      <Field
        label="Script"
        placeholder={'echo "You typed: $BOTKINS_ARGS"'}
        hint="Runs on your computer, with your account's access, each time you type the command. No model reads it. Stop ends it. The words after the name are in $BOTKINS_ARGS and on standard input."
        value={draft.script}
        onChangeText={(script) => set({ script })}
        autoCapitalize="none"
        autoCorrect={false}
        area
        mono
        scrollEnabled={false}
        error={shown.script}
        style={{ minHeight: 280 }}
      />
      {!isNew && canDelete && (
        <Group>
          <Row leading={<IconTile icon={Trash2} color={colors.danger} />} title="Remove command" tone="danger" onPress={remove} />
        </Group>
      )}
    </Sheet>
  );
}
