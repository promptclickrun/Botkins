import { router, useLocalSearchParams } from "expo-router";
import { Check } from "lucide-react-native";
import { useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import type { Bot, ChatMode } from "@/link/types";
import { FolderChoice } from "../projects/ProjectFolders";
import { useCapability, useBots, useCan, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { BotAvatar, Chip, EmptyState, Group, Label, Mascot, Segmented, Sheet, space, T, Tap, useTheme } from "@/ui";

const MAX_GROUP = 6;
type Kind = "one" | "group";

function BotChoice({ bot, multi, selected, busy, disabled, onPress }: { bot: Bot; multi: boolean; selected: boolean; busy: boolean; disabled: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Tap onPress={onPress} disabled={disabled} sink={1} feel="select" hitSlop={0} accessibilityLabel={bot.name + (bot.role ? ", " + bot.role : "")} accessibilityState={multi ? { checked: selected } : undefined} accessibilityRole={multi ? "checkbox" : "button"}>
      <View style={{ minHeight: 64, paddingHorizontal: space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }}>
        <BotAvatar bot={bot} size={44} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T variant="callout" weight="600" numberOfLines={1}>
            {bot.name}
          </T>
          {!!bot.role && (
            <T variant="footnote" color="muted" numberOfLines={1}>
              {bot.role}
            </T>
          )}
        </View>
        {busy ? (
          <ActivityIndicator color={colors.muted} />
        ) : multi ? (
          <View style={{ width: 26, height: 26, borderRadius: 13, borderWidth: selected ? 0 : 1.5, borderColor: colors.lineStrong, backgroundColor: selected ? colors.primary : "transparent", alignItems: "center", justifyContent: "center" }}>
            {selected && <Check size={15} color={colors.onPrimary} strokeWidth={3} />}
          </View>
        ) : null}
      </View>
    </Tap>
  );
}

export default function NewChat() {
  const { botId } = useLocalSearchParams<{ botId?: string }>();
  const allBots = useBots();
  const projects = usePart("projects");
  const canChat = useCan("agents", "chat");
  const canCreate = useCan("agents", "create");
  const bots = useMemo(() => {
    const shown = allBots.filter((bot) => !bot.hidden || bot.id === botId);
    return [...shown].sort((a, b) => Number(b.id === botId) - Number(a.id === botId) || Number(!!b.pinned) - Number(!!a.pinned));
  }, [allBots, botId]);
  const [kind, setKind] = useState<Kind>("one");
  const [picked, setPicked] = useState<string[]>(botId ? [botId] : []);
  const [projectId, setProjectId] = useState<string | null>(null);
  const savedMode = useCapability("project-mode-v1");
  const [folder, setFolder] = useState<string>();
  const chosen = projects?.find((p) => p.id === projectId);
  const [mode, setMode] = useState<ChatMode>("default");
  const [busy, setBusy] = useState<string | null>(null);

  const open = (id: string | undefined) => {
    if (id) router.replace({ pathname: "/chat/[id]", params: { id } });
    else setBusy(null);
  };
  const start = async (botIds: string[], marker: string) => {
    if (busy) return;
    setBusy(marker);
    if (projectId) open(await attempt(api.startProjectChat(botIds, projectId, savedMode ? chosen?.mode ?? "default" : mode, folder)));
    else if (botIds.length === 1) open(await attempt(api.createChat(botIds[0])));
    else open(await attempt(api.createGroupChat(botIds)));
  };
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : picked.length >= MAX_GROUP ? picked : [...picked, id]);
  const multi = kind === "group";
  const ready = picked.length >= 2 && picked.length <= MAX_GROUP;
  if (!canChat) return <Sheet title="New chat"><EmptyState title="You can view, not chat" /></Sheet>;

  if (bots.length === 0)
    return (
      <Sheet title="New chat">
        <EmptyState art={<Mascot state="happy" size={88} />} title="No bots yet" action={canCreate ? "Create a bot" : undefined} onAction={canCreate ? () => router.replace("/bot/new") : undefined} />
      </Sheet>
    );

  return (
    <Sheet title="New chat" action={multi ? "Start" : undefined} onAction={() => void start(picked, "group")} actionDisabled={!ready} actionLoading={busy === "group"}>
      {bots.length > 1 && (
        <Segmented
          options={[
            { value: "one", label: "One bot" },
            { value: "group", label: "Group chat" },
          ]}
          value={kind}
          onChange={setKind}
        />
      )}

      {!!projects?.length && (
        <View style={{ gap: space.md }}>
          <View>
            <Label>Project</Label>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.xl }} contentContainerStyle={{ paddingHorizontal: space.xl, gap: space.sm }}>
              <Chip label="None" selected={!projectId} onPress={() => setProjectId(null)} />
              {projects.map((project) => (
                <Chip key={project.id} label={project.name} selected={projectId === project.id} onPress={() => { setProjectId(project.id); setFolder(undefined); }} />
              ))}
            </ScrollView>
          </View>
          <FolderChoice project={chosen} value={folder} change={setFolder} />
          {!!projectId && (!savedMode || !!chosen?.folder) && (
            <Segmented
              options={[
                { value: "default", label: "Default" },
                { value: "plan", label: "Plan" },
                { value: "yolo", label: "YOLO" },
              ]}
              value={savedMode ? chosen?.mode ?? "default" : mode}
              onChange={(next) => savedMode ? void attempt(api.updateProject(projectId, { mode: next })) : setMode(next)}
            />
          )}
        </View>
      )}

      <View>
        <Label>{multi ? "Pick 2 to 6 · " + picked.length + " chosen" : "Bots"}</Label>
        <Group>
          {bots.map((bot) => (
            <BotChoice
              key={bot.id}
              bot={bot}
              multi={multi}
              selected={picked.includes(bot.id)}
              busy={busy === bot.id}
              disabled={!!busy || (multi && !picked.includes(bot.id) && picked.length >= MAX_GROUP)}
              onPress={() => (multi ? toggle(bot.id) : void start([bot.id], bot.id))}
            />
          ))}
        </Group>
      </View>
    </Sheet>
  );
}
