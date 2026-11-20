import { router, useLocalSearchParams } from "expo-router";
import { Trash2 } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import type { SkillDetail, SkillInfo } from "@/link/types";
import { refresh, useCan, useOnline, useSkills } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Badge, EmptyState, Field, Group, IconTile, Loading, Row, Sheet, useTheme } from "@/ui";
import { canEdit, readableName } from "./shared";

const EMPTY: SkillDetail = { name: "", description: "", instructions: "" };

export default function SkillEditor() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const skills = useSkills();
  const online = useOnline();
  const isNew = name === "new";
  const canRead = useCan("skills", "read");
  const canCreate = useCan("skills", "create");
  const info = skills?.find((skill) => skill.name === name);
  const [loaded, setLoaded] = useState<{ name: string; detail?: SkillDetail }>();

  useEffect(() => {
    if (isNew || !online || !canRead) return;
    let live = true;
    void attempt(api.readSkill(name)).then((detail) => live && setLoaded({ name, detail }));
    return () => {
      live = false;
    };
  }, [isNew, online, name, canRead]);

  if (!canRead || (isNew && !canCreate)) return <Sheet title="Skill"><EmptyState title="Your team role can't use this skill screen" action="Close" onAction={() => router.back()} /></Sheet>;
  if (isNew) return <Editor key="new" />;
  const detail = loaded?.name === name ? loaded : undefined;
  if (!detail || !skills)
    return (
      <Sheet title={readableName(name)}>
        <Loading />
      </Sheet>
    );
  if (!detail.detail || !info)
    return (
      <Sheet title={readableName(name)}>
        <EmptyState title="This skill is gone" action="Go back" onAction={() => router.back()} />
      </Sheet>
    );
  return <Editor key={name} info={info} detail={detail.detail} />;
}

function Editor({ info, detail }: { info?: SkillInfo; detail?: SkillDetail }) {
  const { colors } = useTheme();
  const [start] = useState(() => detail ?? EMPTY);
  const [draft, setDraft] = useState(start);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const canManage = useCan("skills", "manage");
  const canCreate = useCan("skills", "create");
  const canDelete = useCan("skills", "delete");
  const isNew = !info;
  const editable = (!info ? canCreate : canManage && canEdit(info));
  const set = (patch: Partial<SkillDetail>) => setDraft((held) => ({ ...held, ...patch }));
  const changed = draft.name !== start.name || draft.description !== start.description || draft.instructions !== start.instructions;
  const problems = { name: draft.name.trim() ? undefined : "Give the skill a name.", instructions: draft.instructions.trim() ? undefined : "Write what the bot should do." };
  const shown: Partial<typeof problems> = checked ? problems : {};

  const save = async () => {
    setChecked(true);
    if (problems.name || problems.instructions) return;
    setSaving(true);
    const saved = await attempt(
      api.saveSkill({ name: draft.name.trim(), description: draft.description.trim(), instructions: draft.instructions, ...(info && { original: info.name }) }),
      isNew ? "Skill created" : "Saved",
    );
    if (saved === undefined) return setSaving(false);
    await refresh("skills");
    setSaving(false);
    router.back();
  };

  const remove = () => {
    if (!info) return;
    Alert.alert("Remove " + readableName(info.name) + "?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          const done = await attempt(api.removeSkill(info.name), "Skill removed");
          if (done === undefined) return;
          await refresh("skills");
          router.back();
        },
      },
    ]);
  };

  return (
    <Sheet
      title={isNew ? "New skill" : readableName(info.name)}
      {...(editable && { action: isNew ? "Create" : "Save", onAction: () => void save(), actionDisabled: !changed, actionLoading: saving })}
    >
      {!editable && (
        <View style={{ alignItems: "center" }}>
          <Badge label={info?.origin === "built-in" ? "Built in" : "Read only"} tone="info" />
        </View>
      )}
      <Field
        label="Name"
        placeholder="weekly-review"
        hint="Lower-case words joined by hyphens"
        value={draft.name}
        onChangeText={(name) => set({ name: name.toLowerCase().replace(/\s+/g, "-") })}
        autoCapitalize="none"
        autoCorrect={false}
        mono
        editable={editable}
        error={shown.name}
        autoFocus={isNew}
      />
      <Field label="Description" placeholder="When a bot should use it" value={draft.description} onChangeText={(description) => set({ description })} editable={editable} returnKeyType="next" />
      <Field
        label="Instructions"
        placeholder={"# Steps\n\n1. …"}
        hint={editable ? "Markdown" : undefined}
        value={draft.instructions}
        onChangeText={(instructions) => set({ instructions })}
        area
        mono
        editable={editable}
        scrollEnabled={false}
        error={shown.instructions}
        style={{ minHeight: 280 }}
      />
      {info && canDelete && (
        <Group>
          <Row leading={<IconTile icon={Trash2} color={colors.danger} />} title="Remove skill" tone="danger" onPress={remove} />
        </Group>
      )}
    </Sheet>
  );
}
