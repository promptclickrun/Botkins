// New panel: one sentence and a bot, as on Today before. "Start from" only shapes the request; the
// rows say which space it goes in, which project it belongs to (the owner's row: projects are the
// owner's) and how often it refreshes. The computer starts a chat with the bot in that space, and
// the chat opens.
import { MenuView } from "@react-native-menu/menu";
import { router, useLocalSearchParams } from "expo-router";
import { AppWindow, ChartColumn, ChevronRight, FileText, ListChecks, type LucideIcon, Table, TrendingUp } from "lucide-react-native";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { openChat } from "@/features/chat/navigate";
import { BotChips } from "@/features/work/bits";
import type { PanelStart } from "@/link/types";
import { useBots, useCan, useMember, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { hostOfId } from "@/state/unified";
import { EmptyState, Field, Group, Label, radius, Row, Sheet, space as gap, T, Tap, useTheme } from "@/ui";
import { useSpaces } from "./data";
import { panelProject, REFRESH, spaceTitle, STARTS } from "./logic";

const START_ICONS: Record<PanelStart, LucideIcon> = { checklist: ListChecks, tracker: TrendingUp, chart: ChartColumn, table: Table, notes: FileText, app: AppWindow };

export default function NewPanel() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const { colors } = useTheme();
  const canCreate = useCan("today", "create");
  const canChat = useCan("agents", "chat");
  const bots = useBots();
  const shown = useMemo(() => bots.filter((bot) => !bot.hidden), [bots]);
  const spaces = useSpaces();
  const primaryId = useApp((s) => s.pairing?.serverId ?? null);
  const settingsHost = usePrefs((p) => p.settingsHost);
  // A panel goes in a space the person may change.
  const places = useMemo(() => spaces.filter((space) => space.can === "own" || space.can === "edit"), [spaces]);
  const [place, setPlace] = useState<string | undefined>(spaceId);
  const [chosenHost, setChosenHost] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [start, setStart] = useState<PanelStart | null>(null);
  const [refresh, setRefresh] = useState("never");
  // The owner's "Project" row. Until the person picks, it follows the space's own project.
  const member = useMember();
  const projects = usePart("projects");
  const [pickedProject, setPickedProject] = useState<string | null | undefined>(undefined);
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const space = places.find((one) => one.id === place) ?? places[0];
  const mergedSources = space?.merged?.sources ?? [];
  const defaultMergedHost =
    (settingsHost && mergedSources.some((s) => s.hostId === settingsHost) ? settingsHost : null) ??
    (primaryId && mergedSources.some((s) => s.hostId === primaryId) ? primaryId : null) ??
    (mergedSources.length === 1 ? mergedSources[0]!.hostId : null);
  const targetHostId = space?.merged ? (chosenHost && mergedSources.some((s) => s.hostId === chosenHost) ? chosenHost : defaultMergedHost) : null;
  const hostBots = useMemo(() => {
    if (!space?.merged) return shown;
    if (!targetHostId) return shown;
    const filtered = shown.filter((b) => hostOfId(b.id, primaryId) === targetHostId);
    return filtered.length ? filtered : shown;
  }, [shown, space?.merged, targetHostId, primaryId]);
  // After every hook: a return above one changes the hook order when the role does (a computer change, a role edited).
  if (!canCreate || !canChat) return <Sheet title="New panel"><EmptyState title="Your team role can't create panels" /></Sheet>;
  const bot = (chosen && hostBots.some((b) => b.id === chosen) ? chosen : null) ?? hostBots[0]?.id ?? null;
  const needsHostPick = !!space?.merged && mergedSources.length > 1 && !targetHostId;
  const ready = !!bot && !!space && !needsHostPick && !!text.trim() && !asking;
  const every = REFRESH.find((choice) => choice.value === refresh) ?? REFRESH[0]!;
  const projectId = member ? undefined : panelProject(pickedProject, space, projects);

  const create = async () => {
    if (!ready || !bot || !space) return;
    setAsking(true);
    const payload = {
      spaceId: space.id,
      botId: bot,
      prompt: text.trim(),
      ...(targetHostId && { hostId: targetHostId }),
      ...(start && { start }),
      ...(projectId && { projectId }),
      ...(every.cron && { refresh: { cron: every.cron, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } }),
    };
    const made = await attempt(api["spaces.newPanel"](payload as Parameters<typeof api["spaces.newPanel"]>[0]));
    setAsking(false);
    if (!made) return;
    router.back();
    openChat(made.chatId);
  };

  return (
    <Sheet title="New panel" action="Create" onAction={() => void create()} actionDisabled={!ready} actionLoading={asking}>
      <View>
        <Label>What should it show?</Label>
        <Field placeholder="A checklist for launch week that the team can tick off" value={text} onChangeText={setText} area maxLength={8000} autoFocus accessibilityLabel="What should it show?" />
      </View>
      <View>
        <Label>Bot</Label>
        {hostBots.length ? <BotChips bots={hostBots} value={bot} onChange={(next) => next && setChosen(next)} /> : <T variant="subhead" color="muted">Make a bot first.</T>}
      </View>
      <View>
        <Label>Start from</Label>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: gap.sm }}>
          {STARTS.map((choice) => {
            const Icon = START_ICONS[choice.value];
            const on = start === choice.value;
            return (
              <Tap
                key={choice.value}
                onPress={() => setStart(on ? null : choice.value)}
                feel="select"
                sink={0.97}
                accessibilityLabel={choice.label}
                accessibilityState={{ selected: on }}
                style={{ flexBasis: "30%", flexGrow: 1, minHeight: 64, alignItems: "center", justifyContent: "center", gap: 4, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: on ? 2 : 0, borderColor: colors.ink }}
              >
                <Icon size={18} color={colors.ink} strokeWidth={2.2} />
                <T variant="footnote" weight="600">
                  {choice.label}
                </T>
              </Tap>
            );
          })}
        </View>
      </View>
      <Group>
        <MenuView title="Space" actions={places.map((one) => ({ id: one.id, title: spaceTitle(one), state: one.id === space?.id ? ("on" as const) : ("off" as const) }))} onPressAction={({ nativeEvent }) => setPlace(nativeEvent.event)}>
          <Row title="Space" value={space ? spaceTitle(space) : "None"} trailing={<ChevronRight size={16} color={colors.faint} strokeWidth={2.4} />} />
        </MenuView>
        {mergedSources.length > 1 && (
          <MenuView
            title="Computer"
            actions={mergedSources.map((src) => ({ id: src.hostId, title: src.hostName, state: src.hostId === targetHostId ? ("on" as const) : ("off" as const) }))}
            onPressAction={({ nativeEvent }) => {
              setChosenHost(nativeEvent.event);
              setChosen(null);
            }}
          >
            <Row title="Computer" value={mergedSources.find((src) => src.hostId === targetHostId)?.hostName ?? "Choose computer"} trailing={<ChevronRight size={16} color={colors.faint} strokeWidth={2.4} />} />
          </MenuView>
        )}
        {!member && !!projects?.length && (
          <MenuView
            title="Project"
            actions={[{ id: "", title: "None", state: projectId ? ("off" as const) : ("on" as const) }, ...(projects ?? []).map((one) => ({ id: one.id, title: one.name, state: one.id === projectId ? ("on" as const) : ("off" as const) }))]}
            onPressAction={({ nativeEvent }) => setPickedProject(nativeEvent.event || null)}
          >
            <Row title="Project" value={(projects ?? []).find((one) => one.id === projectId)?.name ?? "None"} trailing={<ChevronRight size={16} color={colors.faint} strokeWidth={2.4} />} />
          </MenuView>
        )}
        <MenuView title="Refresh" actions={REFRESH.map((choice) => ({ id: choice.value, title: choice.label, state: choice.value === refresh ? ("on" as const) : ("off" as const) }))} onPressAction={({ nativeEvent }) => setRefresh(nativeEvent.event)}>
          <Row title="Refresh" value={every.label} trailing={<ChevronRight size={16} color={colors.faint} strokeWidth={2.4} />} />
        </MenuView>
      </Group>
    </Sheet>
  );
}
