// One row of the chat: a person's bubble, a bot's reply on the canvas, its work line, cards and suggested replies,
// and the line for a turn that ended without finishing. Which rows there are, in which order, is turn.ts.
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { BookOpen, ChevronRight, CircleAlert, CirclePause, CornerDownRight, ExternalLink, FileText, FolderKanban, LayoutGrid, Sparkles, Square, TimerOff, Volume2 } from "lucide-react-native";
import { memo, type ComponentRef, type ReactNode, type RefObject } from "react";
import { ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { GestureDetector, useTapGesture } from "react-native-gesture-handler";
import type { Artifact, Bot, Message, Run, Step } from "@/link/types";
import { useChatPrefs } from "@/state/chatPrefs";
import { useChat, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { clockTime } from "@/state/time";
import { speakText, stopSpeech, useSpeakingNow } from "@/features/voice/tts";
import { ArtifactChips, InlineMedia } from "@/features/artifacts/ArtifactBits";
import { useMessageLinks } from "@/features/artifacts/data";
import type { MessagePart } from "@/features/artifacts/logic";
import { workWidth } from "./bits";
import { CONTINUE_OPEN_STEPS } from "./keep";
import { boardKindLabel, splitBoardQuote } from "./compose";
import { AlertActions } from "@/features/bots/AlertActions";
import { ConnectCard } from "./ConnectCard";
import { McpAppCard } from "./McpAppCard";
import { IncomingAgentRail } from "./AgentMessageRail";
import { isAgentMessage } from "./agentRailModel";
import { useChatPeople } from "./ChatPeopleLook";
import { authorOf, personTag, sideOf } from "./chatSides";
import { myself } from "./people";
import { PersonBadge } from "./PersonBadge";
import { accentOf, type PersonLook } from "./personLook";
import { DOUBLE_TAP_MS, select, selectionTouch, useSelecting } from "./selecting";
import { answerText, type Ending, type Item } from "./turn";
import { FACE_INDENT, mostIcon } from "./WorkRows";
import { openLink } from "@/ui/LinkHold";
import { Blocks, BotAvatar, Button, Chip, IconButton, Markdown, type PathLinks, radius, SelectableText, space, T, Tap, TextHoldMenu, useTheme } from "@/ui";
export type { Item };

/** What a message's menu can do beyond copying and selecting: quote it in a reply, and fork the chat from it. */
export type MessageActions = { onReact?: (index: number, time?: number) => void; onReply: (text: string) => void; /** Missing in a group chat, which can't be forked. */ onFork?: (index: number) => void; onMainFork?: (index: number) => void; /** A turn is under way, so forking waits. */ busy: boolean };

/** Reply and Fork from here, for a message's hold menu (the desktop's words). */
function extraActions(actions: MessageActions | undefined) {
  if (!actions) return [];
  return [
    ...(actions.onReact ? [{ id: "react", title: "React", image: "face.smiling" }] : []),
    { id: "reply", title: "Reply", image: "arrowshape.turn.up.left" },
    ...(actions.onMainFork ? [{ id: "main-fork", title: "Fork in Main chat", image: "arrow.triangle.branch", attributes: { disabled: actions.busy } }] : []),
    ...(actions.onFork ? [{ id: "fork", title: actions.onMainFork ? "Fork as new chat" : "Fork from here", image: "arrow.triangle.branch", attributes: { disabled: actions.busy } }] : []),
  ];
}
function runExtra(event: string, message: Message, index: number, actions: MessageActions | undefined) {
  if (event === "react") actions?.onReact?.(index, message.time);
  else if (event === "reply") actions?.onReply(message.text);
  else if (event === "fork") actions?.onFork?.(index);
  else if (event === "main-fork") actions?.onMainFork?.(index);
}

/**
 * Where a turn's work is shown: "Ran 2 commands ›", a quiet row on the chat with the icon of the
 * kind most of its steps are (WorkRows.tsx), in the work's column under the face. A tap opens the turn's activity.
 */
export function WorkLine({ chatId, runId, label, steps, failed }: { chatId: string; runId: string; label: string; steps?: Step[]; failed?: boolean }) {
  const { colors } = useTheme();
  const Icon = mostIcon(steps ?? []);
  return (
    <Tap
      onPress={() => router.push({ pathname: "/chat/activity", params: { chatId, runId } })}
      feel="select"
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      accessibilityLabel={label + ", show activity"}
      style={{ ...workWidth, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32, paddingLeft: FACE_INDENT }}
    >
      <View style={{ width: 20, alignItems: "center" }}>
        <Icon size={14} color={failed ? colors.danger : colors.muted} strokeWidth={2.2} />
      </View>
      <T variant="subhead" color={failed ? "danger" : "muted"} numberOfLines={1} style={{ flexShrink: 1 }}>
        {label}
      </T>
      <ChevronRight size={13} color={colors.faint} strokeWidth={2.4} />
    </Tap>
  );
}

/**
 * Wraps a message's text: a double tap turns it into text a part of which can be selected.
 * The phone itself recognizes the double tap (two quick presses on a view don't both arrive: the
 * text's own gestures take the second). One tap does nothing here, so a link inside still opens on
 * a tap, and a hold still opens the menu.
 */
function DoubleTap({ id, children }: { id: string; children: ReactNode }) {
  const twice = useTapGesture({ runOnJS: true, numberOfTaps: 2, maxDelay: DOUBLE_TAP_MS, onActivate: () => select(id) });
  return (
    <GestureDetector gesture={twice}>
      <View collapsable={false}>{children}</View>
    </GestureDetector>
  );
}

function Replies({ replies, onSend }: { replies: string[]; onSend: (text: string) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ marginHorizontal: -space.xl }} contentContainerStyle={{ paddingHorizontal: space.xl, gap: space.sm }}>
      {replies.map((reply) => (
        <Chip key={reply} label={reply} onPress={() => onSend(reply)} />
      ))}
    </ScrollView>
  );
}

function Cards({ run, latest, rich, onSend, onDraft }: { run: Run; latest: boolean; rich: boolean; onSend: (text: string) => void; onDraft?: (text: string) => void }) {
  const { colors } = useTheme();
  // Published Claude artifact link cards show whether rich cards are on or off.
  const claudeArtifacts = run.claudeArtifacts?.map((artifact) => (
    <View
      key={artifact.id}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        padding: space.md,
      }}
    >
      <View style={{ width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.sunken, alignItems: "center", justifyContent: "center" }}>
        <Sparkles size={18} color={colors.accent} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="callout" weight="600" numberOfLines={1}>
          {artifact.title}
        </T>
        <T variant="footnote" color="muted" numberOfLines={1}>
          {(artifact.action === "update" ? "Updated Claude artifact" : "Claude artifact") +
            (artifact.private ? " · Private on claude.ai" : " · On claude.ai")}
        </T>
      </View>
      <Button title="Open" icon={ExternalLink} variant="secondary" size="sm" onPress={() => openLink(artifact.url)} accessibilityLabel={"Open " + artifact.title + " on claude.ai"} />
    </View>
  ));
  // A Connect card is an action, not a picture: it shows with rich cards off too.
  const connects = run.connects?.map((card) => <ConnectCard key={card.id} chatId={run.chatId} card={card} />);
  // An MCP App's view; with rich cards off, its saved summary.
  const views = run.mcpApps?.map((card) => <McpAppCard key={card.id} chatId={run.chatId} card={card} rich={rich} />);
  if (!rich)
    return (
      <>
        {claudeArtifacts}
        {connects}
        {views}
        {run.cards?.map((card) => (
          <View key={card.id} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <LayoutGrid size={14} color={colors.faint} strokeWidth={2.2} />
            <T variant="footnote" color="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
              {"Card: " + (card.title || "Untitled")}
            </T>
          </View>
        ))}
      </>
    );
  return (
    <>
      {claudeArtifacts}
      {connects}
      {views}
      {run.cards?.map((card) => (
        <View key={card.id} style={{ gap: space.md }}>
          <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, padding: space.lg, gap: space.md }}>
            {!!card.title && <T variant="headline">{card.title}</T>}
            <Blocks blocks={card.blocks} title={card.title} onAnswer={onDraft} />
          </View>
          {latest && card.replies.length > 0 && <Replies replies={card.replies} onSend={onSend} />}
        </View>
      ))}
      {latest && !!run.options?.length && <Replies replies={run.options.map((option) => option.label)} onSend={(label) => onSend(run.options!.find((option) => option.label === label)?.prompt ?? label)} />}
    </>
  );
}

function Reactions({ message }: { message: Message }) {
  if (!message.reactions?.length) return null;
  return <T variant="callout">{message.reactions.map(r => r.emoji).join(" ")}</T>;
}

function Stamp({ time, align }: { time?: number; align: "flex-start" | "flex-end" }) {
  if (!time) return null;
  return (
    <T variant="caption" color="faint" style={{ alignSelf: align, fontWeight: "400" }}>
      {clockTime(time)}
    </T>
  );
}

/**
 * A person's message. This phone's own person's is on the right; anyone else's is on the left
 * (chatSides.ts), with their name in their accent color over it and their round badge at its top
 * left, on the first of their messages in a row.
 */
export function UserBubble({ message, index, timestamps, id, actions, paths, media, side = "right", speaker, person, first = true }: { message: Message; index: number; timestamps: boolean; id: string; actions?: MessageActions; paths?: PathLinks; media: Artifact[]; /** "left" for someone else's message. */ side?: "left" | "right"; /** Who wrote it, when it is someone else's. */ speaker?: string; /** Their badge's look. */ person?: PersonLook; /** The first of their messages in a row: it shows their name and badge. */ first?: boolean }) {
  const { colors, dark } = useTheme();
  const left = side === "left";
  const end = left ? "flex-start" : "flex-end";
  const corner = left ? { borderTopLeftRadius: first ? 6 : 20 } : { borderBottomRightRadius: 6 };
  const selecting = useSelecting((state) => state.id === id);
  // A Today item the person chose to discuss is a card here: it comes as a record the computer kept
  // with the message, or (from a computer that can't keep one) quoted at the top of the text.
  const quoted = splitBoardQuote(message.text ?? "");
  const record = message.mentions?.find((mention) => mention.kind === "board");
  const card = record?.kind === "board" ? { kind: boardKindLabel(record.board ?? "feed"), title: record.label, body: record.body ?? "" } : quoted.card;
  const rest = message.answer ? answerText(message) : record ? (message.text ?? "") : quoted.rest;
  const chips = (message.mentions ?? []).filter((mention) => mention.kind !== "board");
  // An answer to a bot's request shows the request it answered above it, as a quote does.
  const above = message.quote || message.answer?.title;
  const column = (
    <View style={left ? { flex: 1, minWidth: 0, alignItems: end, gap: 4 } : { alignItems: end, gap: 4, paddingLeft: "16%" }}>
      {left && first && !!speaker && (
        <T variant="footnote" weight="500" numberOfLines={1} style={{ color: accentOf(person?.id ?? authorOf(message), dark) }}>
          {speaker}
        </T>
      )}
      {!!above && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" }} accessibilityLabel={(message.answer ? "Answered: " : "Replying to: ") + above}>
          <CornerDownRight size={13} color={colors.faint} strokeWidth={2.2} />
          <T variant="footnote" color="muted" numberOfLines={message.answer ? 2 : 1} style={{ flexShrink: 1 }}>
            {above}
          </T>
        </View>
      )}
      {!!message.attachments?.length && (
        <View style={{ alignItems: end, gap: 4 }}>
          {message.attachments.map((file) => (
            <View key={file.path} style={{ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", height: 32, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: colors.sunken }}>
              <FileText size={14} color={colors.muted} strokeWidth={2.2} />
              <T variant="footnote" weight="600" color="ink2" numberOfLines={1} style={{ flexShrink: 1 }}>
                {file.name}
              </T>
            </View>
          ))}
        </View>
      )}
      {card && (
        <View accessible accessibilityLabel={card.kind + ": " + card.title} style={{ alignSelf: "stretch", gap: 2, padding: space.md, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface }}>
          <T variant="caption" weight="700" color="muted">
            {card.kind}
          </T>
          <T variant="subhead" weight="700" numberOfLines={2}>
            {card.title}
          </T>
          {!!card.body && (
            <T variant="footnote" color="ink2" numberOfLines={4}>
              {card.body}
            </T>
          )}
        </View>
      )}
      {chips.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: end, gap: 4 }}>
          {chips.map((mention) => {
            const Icon = mention.kind === "project" ? FolderKanban : mention.kind === "wiki" ? BookOpen : mention.kind === "file" ? FileText : null;
            return (
              <View key={mention.kind + ":" + ("path" in mention ? mention.path : mention.id)} style={{ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", height: 32, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: colors.sunken }}>
                {Icon && <Icon size={14} color={colors.muted} strokeWidth={2.2} />}
                <T variant="footnote" weight="600" color="ink2" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {mention.label}
                </T>
              </View>
            );
          })}
        </View>
      )}
      {!!rest &&
        (selecting ? (
          <View {...selectionTouch} style={{ backgroundColor: colors.bubble, borderRadius: 20, ...corner, paddingHorizontal: 15, paddingVertical: 10 }}>
            <SelectableText text={rest} markdown={false} color={colors.onBubble} onDone={() => useSelecting.getState().id === id && select(null)} />
          </View>
        ) : (
          <TextHoldMenu
            actions={[
              { id: "copy", title: "Copy", image: "doc.on.doc" },
              { id: "select", title: "Select text", image: "text.cursor" },
              ...extraActions(actions),
            ]}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === "copy") void Clipboard.setStringAsync(rest).then(() => showToast("Copied", "success"));
              else if (nativeEvent.event === "select") select(id);
              else runExtra(nativeEvent.event, message, index, actions);
            }}
          >
            <DoubleTap id={id}>
              <View style={{ backgroundColor: colors.bubble, borderRadius: 20, ...corner, paddingHorizontal: 15, paddingVertical: 10 }}>
                <Markdown text={rest} inline color={colors.onBubble} paths={paths} />
              </View>
            </DoubleTap>
          </TextHoldMenu>
        ))}
      {media.length > 0 && <ArtifactChips items={media} align={end} />}
      <Reactions message={message} />
      {timestamps && <Stamp time={message.time} align={end} />}
    </View>
  );
  // Someone else's: their badge at the top left (room kept for it under the first), then the column.
  const bubble = left ? (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingRight: "12%" }}>
      <View style={{ width: 26 }}>{first && !!person && <PersonBadge person={person} size={26} />}</View>
      {column}
    </View>
  ) : (
    column
  );
  if (rest || !actions?.onReact) return bubble;
  return <TextHoldMenu actions={extraActions(actions)} onPressAction={({ nativeEvent }) => runExtra(nativeEvent.event, message, index, actions)}>
    {bubble}
  </TextHoldMenu>;
}

function CommandBlock({ message }: { message: Message }) {
  const { colors, type } = useTheme();
  return (
    <View style={{ backgroundColor: colors.sunken, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm }}>
      <Text selectable maxFontSizeMultiplier={1.3} style={[type.mono, { color: colors.muted }]}>
        {message.text}
      </Text>
    </View>
  );
}

function Speaker({ bot }: { bot?: Bot }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <BotAvatar bot={bot} size={22} />
      <T variant="footnote" weight="700" color="ink2" numberOfLines={1}>
        {bot?.name ?? "Bot"}
      </T>
    </View>
  );
}

/** Reads a reply aloud, or stops it while it is being read. Small and quiet, with a 44-point target. */
function ReadAloud({ id, text, botId }: { id: string; text: string; botId?: string }) {
  const { colors } = useTheme();
  const reading = useSpeakingNow((state) => state.id === id);
  return (
    <IconButton
      icon={reading ? Square : Volume2}
      size={28}
      color={reading ? colors.accentText : colors.faint}
      label={reading ? "Stop reading" : "Read aloud"}
      onPress={() => (reading ? stopSpeech() : speakText(id, text, { botId }))}
      style={{ marginLeft: -6 }}
    />
  );
}

/** A bot's reply. A long press offers Copy, Select text, Read aloud (or Stop reading), Share, Reply and Fork from here. */
function Reply({ message, index, id, botId, markdown, actions, paths, parts }: { message: Message; index: number; id: string; /** The bot that wrote it, for its own voice. */ botId?: string; markdown: boolean; actions?: MessageActions; paths?: PathLinks; /** The text and its MEDIA: attachments in order, when it has any the computer knows. */ parts?: MessagePart[] }) {
  const reading = useSpeakingNow((state) => state.id === id);
  const selecting = useSelecting((state) => state.id === id);
  // While its text is being selected the message is one native text view, outside the menu: a
  // hold there belongs to the selection.
  if (selecting)
    return (
      <View {...selectionTouch}>
        <SelectableText text={message.text} markdown={markdown} onDone={() => useSelecting.getState().id === id && select(null)} />
      </View>
    );
  return (
    <TextHoldMenu
      actions={[
        { id: "copy", title: "Copy", image: "doc.on.doc" },
        { id: "select", title: "Select text", image: "text.cursor" },
        reading ? { id: "stop", title: "Stop reading", image: "speaker.slash" } : { id: "read", title: "Read aloud", image: "speaker.wave.2" },
        { id: "share", title: "Share", image: "square.and.arrow.up" },
        ...extraActions(actions),
      ]}
      onPressAction={({ nativeEvent }) => {
        const action = nativeEvent.event;
        if (action === "copy") void Clipboard.setStringAsync(message.text).then(() => showToast("Copied", "success"));
        else if (action === "select") select(id);
        else if (action === "read") speakText(id, message.text, { botId });
        else if (action === "stop") stopSpeech();
        else if (action === "share") void Share.share({ message: message.text }).catch(() => {});
        else runExtra(action, message, index, actions);
      }}
    >
      <DoubleTap id={id}>
        {parts ? (
          // Each attachment is drawn where it was written, and its raw MEDIA: line is not shown.
          <View style={{ gap: space.md }}>
            {parts.map((part, at) => (part.kind === "text" ? <Markdown key={at} text={part.text} plain={!markdown} paths={paths} /> : <InlineMedia key={part.artifact.id} artifact={part.artifact} />))}
          </View>
        ) : (
          <Markdown text={message.text} plain={!markdown} paths={paths} />
        )}
      </DoubleTap>
    </TextHoldMenu>
  );
}

export const MessageRow = memo(function MessageRow({ item, chatId, group, bots, onSend, onDraft, onOpenChat, actions, replyRef, continues = false }: { replyRef?: RefObject<ComponentRef<typeof View> | null>; item: Extract<Item, { kind: "message" }>; chatId: string; group: boolean; bots: Map<string, Bot>; /** It follows a message by the same person: no name or badge again. */ continues?: boolean; onSend: (text: string) => void; /** Text a custom view hands over, for the message box. */ onDraft?: (text: string) => void; onOpenChat?: (chatId: string) => void; actions?: MessageActions }) {
  const rich = useChatPrefs((prefs) => prefs.richCards);
  const markdown = useChatPrefs((prefs) => prefs.markdown);
  const timestamps = useChatPrefs((prefs) => prefs.timestamps);
  const { message, run, end, latest } = item;
  // Whose voice reads it: the bot that wrote it, or the chat's bot.
  const chat = useChat(chatId);
  const chatBot = chat?.botId;
  const speaker = message.botId ?? chatBot;
  // Someone else's message is on the left, with their name and badge (chatSides.ts).
  const people = useChatPeople();
  const me = myself(usePart("meta"));
  // Paths the computer knows become links, and a reply's MEDIA: attachments are drawn where they were
  // written (under the text in the person's own message). A reply still
  // being written is left alone until it ends, so half a path is never asked about.
  const links = useMessageLinks(chatId, message.text ?? "", message.role !== "command" && !(latest && run?.status === "Working"));
  if (message.role === "user") {
    if (isAgentMessage(message)) {
      return <IncomingAgentRail message={message} bots={bots} onOpenChat={onOpenChat} />;
    }
    const side = sideOf(message, me);
    const author = authorOf(message);
    const person = side === "left" ? (people.get(author) ?? { id: author, name: personTag(message, undefined, me, people) }) : undefined;
    return <UserBubble message={message} index={item.index} timestamps={timestamps} id={chatId + ":" + item.key} actions={actions} paths={links.paths} media={links.media} side={side} speaker={personTag(message, run, me, people)} person={person} first={!continues} />;
  }
  if (message.role === "command") return (
    <TextHoldMenu actions={extraActions(actions)} onPressAction={({ nativeEvent }) => runExtra(nativeEvent.event, message, item.index, actions)}>
      <View><CommandBlock message={message} /><Reactions message={message} /></View>
    </TextHoldMenu>
  );
  // A group chat's turn keeps its work line under its last reply; any other turn draws its work in place (turn.ts).
  return (
    <View ref={replyRef} collapsable={replyRef ? false : undefined} style={{ gap: space.sm }}>
      {group && <Speaker bot={message.botId ? bots.get(message.botId) : undefined} />}
      {message.voiceCaption ? (
        <Reply message={{ ...message, text: message.voiceCaption }} index={item.index} id={chatId + ":" + item.key} botId={speaker} markdown={markdown} actions={actions} />
      ) : (
        <Reply message={message} index={item.index} id={chatId + ":" + item.key} botId={speaker} markdown={markdown} actions={actions} paths={links.paths} parts={links.parts} />
      )}
      <Reactions message={message} />
      {/* A proactive alert: what the bot offers to do, and "Not now". */}
      {!!message.alert && !!speaker && <AlertActions botId={speaker} alert={message.alert} chatId={chatId} />}
      {!!message.text.trim() && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <ReadAloud id={chatId + ":" + item.key} text={message.text} botId={speaker} />
          {timestamps && <Stamp time={message.time} align="flex-start" />}
        </View>
      )}
      {!message.text.trim() && timestamps && <Stamp time={message.time} align="flex-start" />}
      {end && run && <Cards run={run} latest={latest} rich={rich} onSend={onSend} onDraft={onDraft} />}
    </View>
  );
});

/** The quiet line in a run the computer gave more turns by itself: "↻ Kept going: 3 plan steps were open". */
export function KeptNote({ line }: { line: string }) {
  return (
    <View style={{ minHeight: 28, justifyContent: "center" }} accessibilityLabel={line}>
      <T variant="footnote" color="faint" numberOfLines={2}>
        {line}
      </T>
    </View>
  );
}

/** A turn that ended with plan steps open: "Stopped with 2 open steps". The newest one offers Continue, which writes to the chat. */
export function OpenNote({ line, again, onSend }: { line: string; again: boolean; onSend: (text: string) => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32 }} accessibilityLabel={line}>
      <CirclePause size={14} color={colors.faint} strokeWidth={2.3} />
      <T variant="footnote" color="faint" numberOfLines={2} style={{ flexShrink: 1 }}>
        {line}
      </T>
      {again && <Button title="Continue" size="sm" variant="ghost" onPress={() => onSend(CONTINUE_OPEN_STEPS)} />}
    </View>
  );
}

/**
 * A turn that ended without finishing, in one line: how it ended and why, in the desktop app's
 * words ("Needs you · …", "Interrupted · …", "Stopped · Reply stopped."), or "Timed out". The
 * newest such turn offers Try again, which sends its message again.
 */
export function EndedNote({ run, ending, retry }: { run: Run; ending: Ending; retry: boolean }) {
  const { colors } = useTheme();
  const line = ending.label + " · " + ending.detail;
  if (ending.kind === "stopped")
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32 }} accessibilityLabel={line}>
        <CirclePause size={14} color={colors.faint} strokeWidth={2.3} />
        <T variant="footnote" color="faint" numberOfLines={2} style={{ flexShrink: 1 }}>
          {ending.label}
        </T>
        {retry && <Button title="Try again" size="sm" variant="ghost" onPress={() => void attempt(api.retry(run.id))} />}
      </View>
    );
  const soft = ending.kind === "failed" ? colors.dangerSoft : colors.warningSoft;
  const tone = ending.kind === "failed" ? "danger" : "warning";
  const Icon = ending.kind === "timed-out" ? TimerOff : CircleAlert;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, paddingLeft: space.lg, borderRadius: radius.lg, backgroundColor: soft }} accessible={!retry} accessibilityLabel={line}>
      <Icon size={18} color={colors[tone]} strokeWidth={2.3} />
      <T variant="subhead" color={tone} numberOfLines={3} style={{ flex: 1 }}>
        {line}
      </T>
      {retry && <Button title="Try again" size="sm" variant="secondary" onPress={() => void attempt(api.retry(run.id))} />}
    </View>
  );
}
