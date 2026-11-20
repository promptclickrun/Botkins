// Home: the computer it talks to, the bots up top, then every bot as a flat list: the primary bot,
// pinned bots, each section, then the rest. Filters show pinned or hidden bots.
import { MenuView } from "@react-native-menu/menu";
import { type Href, router } from "expo-router";
import { ChevronDown, ChevronRight, ChevronUp, Ellipsis, Plus, Sunrise } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { plainPreview } from "@/features/chat/bits";
import { newBotChat, openBotChat } from "@/features/chat/open";
import { makeSeenSignal, TodayContent } from "@/features/today/Today";
import { addable } from "@/features/bots/agents";
import { hideAction, moveToSection, runSectionAction, runSectionChoice, SECTION_ACTIONS, toggleHidden } from "@/features/bots/menus";
import type { AgentRequest, Bot, ChatSummary, Section } from "@/link/types";
import { activityLabel, isConversation, useBotActivity, useBots, useChats, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { setPrefs, usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { ago } from "@/state/time";
import { BotAvatar, Button, Chip, Dot, EmptyState, Group, HoldMenu, IconButton, IconTile, Mascot, Page, Row, space, T, Tap, useTheme } from "@/ui";
import { computerActions } from "@/state/computers";
import { arrangeBots, type BotFilter, filterBots, filterLabels } from "./arrange";
import { runComputerChoice } from "./computers";

const AVATAR = 48;
const TOP = 4;

/** Long-press on a bot: the desktop's bot menu (New chat, Bot page, Pin, Move to section, Make primary, Duplicate, Hide, Delete). */
function BotMenu({ bot, children }: { bot: Bot; children: ReactNode }) {
  const bots = useBots();
  const sections = usePart("sections");
  const primary = bots[0]?.id === bot.id;
  return (
    <HoldMenu
      actions={[
        { id: "new", title: "New chat", image: "square.and.pencil" },
        { id: "page", title: "Bot page", image: "person.crop.circle" },
        { id: "pin", title: bot.pinned ? "Unpin" : "Pin", image: bot.pinned ? "pin.slash" : "pin" },
        moveToSection(bot, sections),
        { id: "primary", title: "Make primary", image: "star", attributes: { disabled: primary } },
        { id: "duplicate", title: "Duplicate", image: "doc.on.doc" },
        hideAction(bot, primary),
        { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true, disabled: bots.length < 2 } },
      ]}
      onPressAction={({ nativeEvent }) => {
        const event = nativeEvent.event;
        if (runSectionChoice(bot, event)) return;
        if (event === "new") void newBotChat(bot.id);
        else if (event === "page") router.push({ pathname: "/bot/[id]", params: { id: bot.id } });
        else if (event === "pin") void attempt(api.setBotFlags(bot.id, { pinned: !bot.pinned }));
        else if (event === "primary") void attempt(api.makePrimary(bot.id), bot.name + " is first now");
        else if (event === "duplicate") void attempt(api.duplicateBot(bot.id), "Bot duplicated");
        else if (event === "hide") toggleHidden(bot);
        else if (event === "delete")
          Alert.alert("Delete " + bot.name + "?", "Its chats and history are deleted too.", [
            { text: "Cancel", style: "cancel" },
            { text: "Delete", style: "destructive", onPress: () => void attempt(api.deleteBot(bot.id)) },
          ]);
      }}
    >
      {children}
    </HoldMenu>
  );
}

/** A section's heading: its name and count fold it; its menu renames or deletes it. */
function SectionHead({ section, count, open, onToggle }: { section: Section; count: number; open: boolean; onToggle: () => void }) {
  const { colors } = useTheme();
  const Fold = open ? ChevronDown : ChevronRight;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginBottom: -space.sm }}>
      <Tap
        onPress={onToggle}
        feel="select"
        accessibilityLabel={section.name + ", " + count + (count === 1 ? " bot" : " bots")}
        accessibilityState={{ expanded: open }}
        style={{ flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs }}
      >
        <T variant="label" color="muted" numberOfLines={1} style={{ textTransform: "uppercase", flexShrink: 1 }} accessibilityRole="header">
          {section.name}
        </T>
        <T variant="label" color="faint">
          {String(count)}
        </T>
        <Fold size={14} color={colors.faint} strokeWidth={2.4} />
      </Tap>
      <MenuView title={section.name} actions={SECTION_ACTIONS} onPressAction={({ nativeEvent }) => runSectionAction(section, nativeEvent.event)}>
        <View accessible accessibilityRole="button" accessibilityLabel={"Options for section " + section.name} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <Ellipsis size={18} color={colors.muted} strokeWidth={2.2} />
        </View>
      </MenuView>
    </View>
  );
}

/** A plain heading in the list ("Other bots"). */
function ListHead({ title }: { title: string }) {
  return (
    <View style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: space.xs, marginBottom: -space.sm }}>
      <T variant="label" color="muted" style={{ textTransform: "uppercase" }} accessibilityRole="header">
        {title}
      </T>
    </View>
  );
}

/** A big bare avatar with its name under it, for the row at the top. */
function TopBot({ bot, size }: { bot: Bot; size: number }) {
  const state = useBotActivity(bot.id);
  const status = activityLabel(state);
  return (
    <View style={{ flex: 1, alignItems: "center" }}>
      <BotMenu bot={bot}>
        <Tap onPress={() => void openBotChat(bot.id)} sink={0.94} accessibilityLabel={bot.name + (status ? ", " + status : "")} style={{ alignItems: "center", gap: 6, paddingHorizontal: space.xs }}>
          <BotAvatar bot={bot} state={state} size={size} />
          <T variant="caption" color="ink2" numberOfLines={1} center>
            {bot.name}
          </T>
        </Tap>
      </BotMenu>
    </View>
  );
}

/** One bot in the list: its face, its name, one line, and when it last spoke. */
function BotRow({ bot, chat, unread }: { bot: Bot; chat?: ChatSummary; unread: boolean }) {
  const state = useBotActivity(bot.id);
  const status = activityLabel(state);
  const last = chat?.last ? plainPreview(chat.last.text) : undefined;
  const line = status || last || bot.role || "Bot";
  const busy = !!status;
  return (
    <BotMenu bot={bot}>
      <Tap
        onPress={() => void openBotChat(bot.id)}
        feel="select"
        sink={0.98}
        hitSlop={0}
        accessibilityLabel={bot.name + ", " + line + (unread ? ", unread" : "")}
        style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: 10 }}
      >
        <BotAvatar bot={bot} state={state} size={AVATAR} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
            <T variant="name" numberOfLines={1} style={{ flex: 1 }}>
              {bot.name}
            </T>
            {!!chat && (
              <T variant="footnote" color="muted">
                {ago(chat.time)}
              </T>
            )}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <T variant="subhead" color={state === "waiting" ? "warning" : busy ? "accentText" : "muted"} numberOfLines={1} style={{ flex: 1 }}>
              {line}
            </T>
            {unread && <Dot />}
          </View>
        </View>
      </Tap>
    </BotMenu>
  );
}

function NeedsYou({ request, bot }: { request: AgentRequest; bot?: Bot }) {
  return (
    <Row
      leading={bot ? <BotAvatar bot={bot} state="waiting" size={40} /> : undefined}
      title={request.title}
      subtitle={(bot?.name ?? "A bot") + " needs you"}
      trailing={<Dot tone="warning" />}
      chevron
      onPress={() => router.push({ pathname: "/chat/[id]", params: { id: request.chatId } })}
    />
  );
}

/** Gray rows while the first state is on its way. */
function Placeholder() {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space.xl, paddingTop: space.sm }} accessibilityLabel="Loading">
      {[0, 1, 2, 3].map((index) => (
        <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <View style={{ width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, backgroundColor: colors.sunken }} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={{ width: "40%", height: 12, borderRadius: 6, backgroundColor: colors.sunken }} />
            <View style={{ width: "75%", height: 10, borderRadius: 5, backgroundColor: colors.sunken }} />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * A computer with no bots yet. When the person already has agents in a provider's own tool, bringing
 * them in comes first, as in the app on the computer; otherwise, or if they prefer, a new bot.
 */
function FirstBot() {
  const online = useApp((state) => state.link === "online");
  const [found, setFound] = useState(0);
  useEffect(() => {
    if (!online) return;
    let live = true;
    api.importableAgents().then(
      (list) => live && setFound(addable(list).length),
      () => live && setFound(0),
    );
    return () => {
      live = false;
    };
  }, [online]);
  if (!found) return <EmptyState art={<Mascot size={104} state="completed" />} title="Make your first bot" action="Create a bot" onAction={() => router.push("/bot/new")} />;
  return (
    <View>
      <EmptyState
        art={<Mascot size={104} state="completed" />}
        title="Bring in your agents"
        text={found === 1 ? "Botkins found an agent you already use." : "Botkins found " + found + " agents you already use."}
        action="Choose agents"
        onAction={() => router.push("/bot/agents" as Href)}
        style={{ paddingBottom: space.sm }}
      />
      <Button title="Create a new bot instead" variant="ghost" onPress={() => router.push("/bot/new")} style={{ alignSelf: "center" }} />
    </View>
  );
}

export default function Home() {
  const { colors } = useTheme();
  const bots = useBots();
  const chats = useChats();
  const synced = useApp((state) => state.synced);
  const online = useApp((state) => state.link === "online");
  const computer = useApp((state) => state.pairing?.name) ?? "Computer";
  const computers = useApp((state) => state.pairings);
  const inUse = useApp((state) => state.pairing?.serverId);
  const requests = usePart("live")?.requests;
  const board = usePart("board");
  const panels = usePart("panels");

  const shown = useMemo(() => bots.filter((bot) => !bot.hidden).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)), [bots]);
  const top = useMemo(() => {
    const pinned = shown.filter((bot) => bot.pinned);
    return (pinned.length > 0 ? pinned : shown).slice(0, pinned.length > 0 ? TOP : 3);
  }, [shown]);
  // Each bot's latest one-to-one chat, and whether any of its chats is unread.
  const latest = useMemo(() => {
    const out = new Map<string, { chat?: ChatSummary; unread: boolean }>();
    for (const chat of chats) {
      if (chat.botIds || !isConversation(chat)) continue;
      const entry = out.get(chat.botId) ?? { unread: false };
      if (!entry.chat || chat.time > entry.chat.time) entry.chat = chat;
      if (chat.unread) entry.unread = true;
      out.set(chat.botId, entry);
    }
    return out;
  }, [chats]);
  // The list: in the computer's order, or one filter's bots. Sections fold while the app is open.
  const sections = usePart("sections");
  const arranged = useMemo(() => arrangeBots(bots, sections), [bots, sections]);
  const [filter, setFilter] = useState<BotFilter>("All");
  const filtered = useMemo(() => filterBots(bots, filter), [bots, filter]);
  const [folded, setFolded] = useState<string[]>([]);
  const showFilters = bots.length > 3 || arranged.hidden.length > 0 || filter !== "All";
  const rows = (list: Bot[]) => (
    <Group flat inset={space.lg + AVATAR + space.md}>
      {list.map((bot) => {
        const entry = latest.get(bot.id);
        return <BotRow key={bot.id} bot={bot} chat={entry?.chat} unread={!!entry?.unread} />;
      })}
    </Group>
  );
  const today = (board?.filter((item) => item.status === "open").length ?? 0) + (panels?.filter((panel) => !panel.hidden).length ?? 0);
  // Today sits open under the bots until the person folds it; the choice is kept.
  const todayOpen = usePrefs((prefs) => prefs.todayOpen);
  const [seen] = useState(makeSeenSignal);
  const Fold = todayOpen ? ChevronUp : ChevronDown;
  const waiting = requests ?? [];

  return (
    <Page tab onScroll={seen.scrolled}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md }}>
        {/* A tap opens the computer's page; a hold opens the switcher. */}
        <HoldMenu title="Computers" actions={computerActions(computers, inUse)} onPressAction={({ nativeEvent }) => runComputerChoice(nativeEvent.event)} style={{ flexShrink: 1 }}>
          <Tap
            onPress={() => router.push("/settings/desktop")}
            feel="select"
            accessibilityLabel={computer + (online ? ", connected" : ", not connected")}
            accessibilityHint="Hold to switch computers"
            style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 7, height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.surface }}
          >
            <Dot tone={online ? "success" : "warning"} size={7} />
            <T variant="footnote" weight="600" color="ink2" numberOfLines={1}>
              {computer}
            </T>
          </Tap>
        </HoldMenu>
        <IconButton icon={Plus} label="New bot" variant="soft" size={44} onPress={() => router.push("/bot/new")} />
      </View>

      {waiting.length > 0 && (
        <Group flat inset={space.lg + 40 + space.md}>
          {waiting.slice(0, 3).map((request) => (
            <NeedsYou key={request.id} request={request} bot={bots.find((bot) => bot.id === request.botId)} />
          ))}
        </Group>
      )}

      {!synced ? (
        <Placeholder />
      ) : bots.length === 0 ? (
        <FirstBot />
      ) : shown.length === 0 ? (
        <EmptyState art={<Mascot size={104} state="completed" />} title="Make your first bot" action="Create a bot" onAction={() => router.push("/bot/new")} />
      ) : (
        <Animated.View entering={FadeIn.duration(240)} style={{ gap: space.lg }}>
          <View style={{ flexDirection: "row", justifyContent: "space-evenly" }}>
            {top.map((bot) => (
              <TopBot key={bot.id} bot={bot} size={top.length > 3 ? 64 : 76} />
            ))}
          </View>
          {showFilters && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.xl }} contentContainerStyle={{ paddingHorizontal: space.xl, gap: space.sm }}>
              {filterLabels(bots).map((option) => (
                <Chip key={option.value} label={option.label} selected={filter === option.value} onPress={() => setFilter(option.value)} />
              ))}
            </ScrollView>
          )}
          {filter !== "All" ? (
            filtered.length > 0 ? (
              rows(filtered)
            ) : (
              <T variant="subhead" color="muted" center>
                {filter === "Hidden" ? "No hidden bots." : "No pinned bots."}
              </T>
            )
          ) : (
            <>
              {rows([...(arranged.primary ? [arranged.primary] : []), ...arranged.pinned, ...(arranged.sections.length ? [] : arranged.rest)])}
              {arranged.sections.map(({ section, bots: inSection }) => {
                const open = !folded.includes(section.id);
                return (
                  <View key={section.id}>
                    <SectionHead section={section} count={inSection.length} open={open} onToggle={() => setFolded(open ? [...folded, section.id] : folded.filter((id) => id !== section.id))} />
                    {open &&
                      (inSection.length > 0 ? (
                        rows(inSection)
                      ) : (
                        <T variant="footnote" color="faint" style={{ paddingHorizontal: space.xs, paddingTop: space.sm }}>
                          {bots.some((bot) => bot.sectionId === section.id && !bot.hidden) ? "Its bots are pinned above." : "No bots here yet."}
                        </T>
                      ))}
                  </View>
                );
              })}
              {arranged.sections.length > 0 && arranged.rest.length > 0 && (
                <View>
                  <ListHead title="Other bots" />
                  {rows(arranged.rest)}
                </View>
              )}
            </>
          )}
          {today > 0 && (
            <View style={{ gap: space.lg }}>
              <Group flat>
                <Row
                  leading={<IconTile icon={Sunrise} />}
                  title="Today"
                  value={todayOpen ? undefined : String(today)}
                  trailing={<Fold size={18} color={colors.faint} strokeWidth={2.2} />}
                  onPress={() => setPrefs({ todayOpen: !todayOpen })}
                />
              </Group>
              {todayOpen && <TodayContent seen={seen} />}
            </View>
          )}
        </Animated.View>
      )}
    </Page>
  );
}
