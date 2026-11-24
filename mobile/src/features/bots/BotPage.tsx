import { MenuView } from "@react-native-menu/menu";
import { type Href, router, Stack, useLocalSearchParams } from "expo-router";
import { AudioLines, BookmarkPlus, Brain, Copy, Download, Eye, EyeOff, Folder, FolderKanban, MessageCircle, Palette, Pin, Plus, Repeat, ScreenShare, ScrollText, Sparkles, SquarePen, Star, Trash2, Users, Wrench } from "lucide-react-native";
import { useMemo } from "react";
import { Alert, View } from "react-native";
import { newBotChat, openBotChat } from "@/features/chat/open";
import { describeChoice, useDefaultProvider } from "@/features/models/shared";
import type { Bot } from "@/link/types";
import { shareFrom } from "@/state/files";
import { isConversation, useBot, useBotActivity, useBots, useCan, useCapability, useChats, useMember, useModels, usePart, useRoutines, useSettings, useSkills, useCanArrange } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { ago, cadenceLabel } from "@/state/time";
import { AvatarMotion, BotAvatar, brand, Button, EmptyState, Group, IconTile, Label, Loading, Page, ProviderIcon, Row, space, T, Tap, useTextPrompt, useTheme } from "@/ui";
import { BotArtifacts } from "@/features/artifacts/ArtifactBits";
import { sectionOf } from "@/features/home/arrange";
import { usePhoneVoice } from "@/features/voice/prefs";
import { botVoiceSummary } from "@/features/voice/settings/summary";
import { useBotVoiceSupported, useVoiceSettings } from "@/features/voice/state";
import { grantSummary } from "./projectAccess";
import { myself } from "@/features/chat/people";
import { peopleOf, PROACTIVE_CAPABILITY, proactiveStanding } from "./proactive";
import { moveToSection, runSectionChoice, toggleHidden } from "./menus";

function BotPageScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const bot = useBot(id);
  const synced = useApp((state) => state.synced);
  if (!bot)
    return <Page>{synced ? <EmptyState title="This bot is gone" action="Go back" onAction={() => router.back()} /> : <Loading />}</Page>;
  return <BotDetail bot={bot} />;
}

function EditButton({ id }: { id: string }) {
  return (
    <Tap onPress={() => router.push({ pathname: "/bot/[id]/edit", params: { id } })} feel="select" accessibilityLabel="Edit name and role" style={{ minWidth: 44, height: 44, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" }}>
      <T variant="headline" color="accentText">
        Edit
      </T>
    </Tap>
  );
}

function BotDetail({ bot }: { bot: Bot }) {
  const { colors } = useTheme();
  const prompt = useTextPrompt();
  const canFiles = useCapability("files-v1");
  const state = useBotActivity(bot.id);
  const bots = useBots();
  const chats = useChats();
  const settings = useSettings();
  const models = useModels();
  const defaultProvider = useDefaultProvider();
  const skills = useSkills();
  const skillsOffForAll = usePart("skills")?.disabled;
  const servers = usePart("mcp");
  const routines = useRoutines();
  const sections = usePart("sections");
  const projects = usePart("projects");
  const section = sectionOf(bot, sections);
  const canChat = useCan("agents", "chat");
  const canCreate = useCan("agents", "create");
  const canManage = useCan("agents", "manage");
  const canArrange = useCanArrange();
  const canDelete = useCan("agents", "delete");
  const canSeeToday = useCan("today", "view");
  const botVoice = useBotVoiceSupported();
  const sharedVoice = useVoiceSettings();
  const phoneVoice = usePhoneVoice((prefs) => prefs.bots?.[bot.id]);
  const canCreateToday = useCan("today", "create");
  const member = useMember();
  const proactiveSupported = useCapability(PROACTIVE_CAPABILITY);
  const proactivePart = usePart("proactive");
  const me = myself(usePart("meta"));
  // Where the bot's agent stands for the person looking, in a word and one line (the same words as on its own page).
  const standing = proactiveStanding(proactivePart, proactivePart?.bots?.[bot.id], me);
  const looksOutForMe = !!peopleOf(proactivePart?.bots?.[bot.id])[me];

  const model = describeChoice(bot.model ?? settings?.model, models, defaultProvider);
  const firstLine = bot.instructions.split("\n").find((line) => line.trim())?.trim();
  const mine = routines.filter((routine) => routine.chat.botId === bot.id);
  const recent = useMemo(() => chats.filter((chat) => chat.botId === bot.id && !chat.botIds && isConversation(chat)).sort((a, b) => b.time - a.time).slice(0, 3), [chats, bot.id]);

  // Skills and tools this bot can use: on for everyone, and not switched off for it.
  const skillsOn = skills?.filter((skill) => skill.enabled && !skillsOffForAll?.includes(skill.name) && !bot.skillsOff?.includes(skill.name)).length;
  const toolsOn = servers?.filter((server) => server.enabled && !bot.mcpOff?.includes(server.id)).length ?? 0;
  const capabilities = skillsOn === undefined ? undefined : skillsOn + toolsOn + " on";
  const primary = bots[0]?.id === bot.id;

  const remove = () =>
    Alert.alert("Delete " + bot.name + "?", "Its chats and history are deleted too.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          router.back();
          void attempt(api.deleteBot(bot.id), bot.name + " deleted");
        },
      },
    ]);
  const duplicate = async () => {
    const copy = await attempt(api.duplicateBot(bot.id), "Bot duplicated");
    if (copy) router.push({ pathname: "/bot/[id]", params: { id: copy } });
  };

  return (
    <Page>
      <Stack.Screen options={{ headerRight: canManage ? () => <EditButton id={bot.id} /> : undefined }} />
      {prompt.node}

      <View style={{ alignItems: "center", gap: space.lg }}>
        <BotAvatar bot={bot} state={state} size={136} />
        <View style={{ alignItems: "center", gap: 2, paddingHorizontal: space.md }}>
          <T variant="title1" center accessibilityRole="header" numberOfLines={2}>
            {bot.name}
          </T>
          {!!bot.role && (
            <T variant="callout" color="muted" center numberOfLines={2}>
              {bot.role}
            </T>
          )}
          {!!bot.summary && (
            <T variant="footnote" color="ink2" center numberOfLines={3} style={{ marginTop: space.xs }}>
              {bot.summary}
            </T>
          )}
        </View>
        {canChat && (
          <View style={{ flexDirection: "row", gap: space.md, alignSelf: "stretch" }}>
            <Button title="Chat" icon={MessageCircle} onPress={() => void openBotChat(bot.id)} style={{ flex: 1 }} accessibilityLabel={"Chat with " + bot.name} />
            <Button title="New chat" icon={SquarePen} variant="secondary" onPress={() => void newBotChat(bot.id)} style={{ flex: 1 }} />
          </View>
        )}
      </View>

      <Group>
        <Row
          leading={<ProviderIcon provider={model.provider} name={model.providerLabel} size={32} tile />}
          title="Model"
          subtitle={bot.model ? undefined : "Default"}
          value={models ? model.label : undefined}
          chevron
          onPress={canManage ? () => router.push({ pathname: "/chat/model", params: { scope: "bot", id: bot.id } }) : undefined}
        />
        {canManage && <Row leading={<IconTile icon={ScrollText} color={colors.info} />} title="Instructions" subtitle={firstLine ?? "None yet"} chevron onPress={() => router.push({ pathname: "/bot/[id]/instructions", params: { id: bot.id } })} />}
        {canManage && <Row leading={<IconTile icon={Palette} color={colors.accent} />} title="Look" chevron onPress={() => router.push({ pathname: "/bot/[id]/look", params: { id: bot.id } })} />}
        {/* A role that manages bots sets a bot's voice. The shared settings are sent to it without keys or addresses; an older computer sends a member none, and then there is nothing to choose from. */}
        {canManage && (!member || !!sharedVoice) && <Row leading={<IconTile icon={AudioLines} color={colors.ink2} />} title="Voice" subtitle={botVoice ? botVoiceSummary(bot.voice, sharedVoice, phoneVoice) : "Update the app on your computer"} chevron={botVoice} disabled={!botVoice} onPress={botVoice ? () => router.push({ pathname: "/bot/[id]/voice", params: { id: bot.id } }) : undefined} />}
        {/* The route is new: typed routes learn it the next time Metro starts. A role that manages bots sets a bot's Proactive agent up; anyone it looks out for has their own alerts there. */}
        {proactiveSupported && (canManage || looksOutForMe) && (
          <Row
            leading={<IconTile icon={Sparkles} color={colors.accent} />}
            title="Proactive"
            subtitle={standing === "paused" ? "Paused on this computer" : standing === "mine-off" ? "Your alerts are off" : standing === "out" ? "Doesn't look out for you" : undefined}
            value={standing === "setup" ? "Set up" : standing === "on" ? "On" : standing === "out" ? undefined : "Off"}
            chevron
            onPress={() => router.push(("/bot/" + encodeURIComponent(bot.id) + "/proactive") as Href)}
          />
        )}
        {!member && <Row leading={<IconTile icon={Wrench} color={colors.success} />} title="Skills & tools" value={capabilities} chevron onPress={() => router.push({ pathname: "/bot/[id]/capabilities", params: { id: bot.id } })} />}
        {!member && <Row leading={<IconTile icon={Brain} color={colors.warning} />} title="Memory" chevron onPress={() => router.push({ pathname: "/bot/[id]/memory", params: { id: bot.id } })} />}
        {/* The route is new: typed routes learn it the next time Metro starts. */}
        {!member && <Row leading={<IconTile icon={FolderKanban} color={colors.info} />} title="Access" value={projects ? grantSummary(settings, bot, projects) : undefined} chevron onPress={() => router.push(("/bot/access?id=" + encodeURIComponent(bot.id)) as Href)} />}
      </Group>

      {(canManage || canArrange || !member) && <Group>
        {!member && <Row leading={<IconTile icon={ScreenShare} color={brand.tide} />} title="Screen" subtitle={"Watch " + bot.name + " work on your computer"} chevron onPress={() => router.push("/remote")} />}
        {canArrange && <Row leading={<IconTile icon={Pin} color={colors.ink2} />} title="Pinned" toggled={!!bot.pinned} onToggle={(pinned) => void attempt(api.setBotFlags(bot.id, { pinned }))} />}
        {canManage && !member && sections && (
          <MenuView title="Move to section" actions={moveToSection(bot, sections).subactions ?? []} onPressAction={({ nativeEvent }) => runSectionChoice(bot, nativeEvent.event, prompt.ask)}>
            <View accessible accessibilityRole="button" accessibilityLabel={"Section, " + (section?.name ?? "None")} accessibilityHint="Moves the bot to a section">
              <Row leading={<IconTile icon={Folder} color={colors.ink2} />} title="Section" value={section?.name ?? "None"} chevron />
            </View>
          </MenuView>
        )}
        {canManage && settings?.teamwork !== false && (
          <Row leading={<IconTile icon={Users} color={colors.ink2} />} title="Teamwork" subtitle="Other bots can ask it for help" toggled={bot.teamwork !== false} onToggle={(teamwork) => void attempt(api.setBotFlags(bot.id, { teamwork }))} />
        )}
      </Group>}

      {canSeeToday && <View>
        <Label>Routines</Label>
        <Group>
          {mine.slice(0, 3).map((routine) => (
            <Row
              key={routine.id}
              leading={<IconTile icon={Repeat} color={routine.entry.enabled === false ? colors.muted : colors.accent} />}
              title={routine.entry.name ?? routine.chat.title}
              subtitle={routine.entry.enabled === false ? "Paused" : cadenceLabel(routine.entry.cadence)}
              chevron
              onPress={() => router.push({ pathname: "/routine/[id]", params: { id: routine.id } })}
            />
          ))}
          {canCreateToday && <Row leading={<IconTile icon={Plus} />} title="New routine" tone="accent" onPress={() => router.push({ pathname: "/routine/[id]", params: { id: "new", botId: bot.id } })} />}
        </Group>
      </View>}

      {!member && <BotArtifacts botId={bot.id} />}

      {recent.length > 0 && (
        <View>
          <Label>Recent chats</Label>
          <Group>
            {recent.map((chat) => (
              <Row key={chat.id} title={chat.title || "New chat"} value={ago(chat.time)} chevron onPress={() => router.push({ pathname: "/chat/[id]", params: { id: chat.id } })} />
            ))}
          </Group>
        </View>
      )}

      {(canCreate || canManage || canArrange || canDelete || !member) && <Group>
        {canCreate && <Row leading={<IconTile icon={Copy} color={colors.ink2} />} title="Duplicate" onPress={() => void duplicate()} />}
        {!member && <Row leading={<IconTile icon={BookmarkPlus} color={colors.ink2} />} title="Save as template" onPress={() => void attempt(api.saveTemplate(bot.id), "Saved as a template")} />}
        {!member && <Row
          leading={<IconTile icon={Download} color={colors.ink2} />}
          title="Export template…"
          subtitle={canFiles ? undefined : "Update the app on your computer"}
          disabled={!canFiles}
          onPress={() => void shareFrom(api.exportTemplateText({ botId: bot.id }), "Template exported. Anyone with Botkins can import it.")}
        />}
        {canManage && !primary && <Row leading={<IconTile icon={Star} color={colors.ink2} />} title="Make primary" subtitle="Shown first on Home" onPress={() => void attempt(api.makePrimary(bot.id), bot.name + " is first now")} />}
        {canArrange && <Row
          leading={<IconTile icon={bot.hidden ? Eye : EyeOff} color={colors.ink2} />}
          title={bot.hidden ? "Show" : "Hide"}
          subtitle={primary && !bot.hidden ? "The primary bot can't be hidden" : bot.hidden ? "Hidden from the bot list" : undefined}
          disabled={primary && !bot.hidden}
          onPress={() => toggleHidden(bot)}
        />}
        {canDelete && <Row leading={<IconTile icon={Trash2} color={colors.danger} />} title="Delete bot" tone="danger" onPress={remove} />}
      </Group>}
    </Page>
  );
}

/** Avatars move on this screen (see `AvatarMotion`). */
export default function BotPage() {
  return (
    <AvatarMotion>
      <BotPageScreen />
    </AvatarMotion>
  );
}
