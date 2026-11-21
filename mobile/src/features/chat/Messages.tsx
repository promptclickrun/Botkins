// One row of the chat: a person's bubble, a bot's reply on the canvas, its work line, cards and suggested replies,
// and the line for a turn that ended without finishing. Which rows there are, in which order, is turn.ts.
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { BookOpen, ChevronRight, CircleAlert, CirclePause, CornerDownRight, FileText, FolderKanban, LayoutGrid, Square, TimerOff, Volume2 } from "lucide-react-native";
import { memo, type ReactNode } from "react";
import { ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { GestureDetector, useTapGesture } from "react-native-gesture-handler";
import type { Artifact, Bot, Message, Run } from "@/link/types";
import { type ChatPrefs, useChatPrefs } from "@/state/chatPrefs";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { clockTime } from "@/state/time";
import { speakText, stopSpeech, useSpeakingNow } from "@/features/voice/tts";
import { ArtifactChips, InlineMedia } from "@/features/artifacts/ArtifactBits";
import { useMessageLinks } from "@/features/artifacts/data";
import type { MessagePart } from "@/features/artifacts/logic";
import { workWidth } from "./bits";
import { boardKindLabel, splitBoardQuote } from "./compose";
import { DOUBLE_TAP_MS, select, selectionTouch, useSelecting } from "./selecting";
import { answerText, type Ending, type Item, workSummary } from "./turn";
import { Blocks, BotAvatar, Button, Chip, HoldMenu, IconButton, Markdown, type PathLinks, radius, SelectableText, space, T, Tap, useTheme } from "@/ui";

export type { Item };

/** What a message's menu can do beyond copying and selecting: quote it in a reply, and fork the chat from it. */
export type MessageActions = { onReply: (text: string) => void; /** Missing in a group chat, which can't be forked. */ onFork?: (index: number) => void; /** A turn is under way, so forking waits. */ busy: boolean };

/** Reply and Fork from here, for a message's hold menu (the desktop's words). */
function extraActions(actions: MessageActions | undefined) {
  if (!actions) return [];
  return [
    { id: "reply", title: "Reply", image: "arrowshape.turn.up.left" },
    ...(actions.onFork ? [{ id: "fork", title: "Fork from here", image: "arrow.triangle.branch", attributes: { disabled: actions.busy } }] : []),
  ];
}
function runExtra(event: string, message: Message, index: number, actions: MessageActions | undefined) {
  if (event === "reply") actions?.onReply(message.text);
  else if (event === "fork") actions?.onFork?.(index);
}

const failedSteps = (run: Run) => (run.steps ?? []).filter((step) => step.status === "Failed").length;

/** A group chat's work line, under its turn's last reply. */
function GroupWorkLine({ chatId, run, mode }: { chatId: string; run: Run; mode: ChatPrefs["steps"] }) {
  const steps = run.steps?.length ?? 0;
  const failed = failedSteps(run);
  if (mode === "hide" || (mode === "failed" && failed === 0)) return null;
  const label = mode === "failed" ? (failed === 1 ? "1 step failed" : failed + " steps failed") : run.summary || workSummary(run.steps ?? []) || (steps === 1 ? "1 step" : steps + " steps");
  return <WorkLine chatId={chatId} runId={run.id} label={label} failed={mode === "failed"} />;
}

/** Where a turn's work is shown: "Ran 2 commands ›". A tap opens the turn's activity. */
export function WorkLine({ chatId, runId, label, failed }: { chatId: string; runId: string; label: string; failed?: boolean }) {
  const { colors } = useTheme();
  return (
    <Tap
      onPress={() => router.push({ pathname: "/chat/activity", params: { chatId, runId } })}
      feel="select"
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      accessibilityLabel={label + ", show activity"}
      style={{ ...workWidth, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 2, minHeight: 32 }}
    >
      <T variant="footnote" color={failed ? "danger" : "muted"} numberOfLines={1} style={{ flexShrink: 1 }}>
        {label}
      </T>
      <ChevronRight size={14} color={colors.faint} strokeWidth={2.4} />
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
  if (!rich)
    return (
      <>
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

function Stamp({ time, align }: { time?: number; align: "flex-start" | "flex-end" }) {
  if (!time) return null;
  return (
    <T variant="caption" color="faint" style={{ alignSelf: align, fontWeight: "400" }}>
      {clockTime(time)}
    </T>
  );
}

function UserBubble({ message, index, timestamps, id, actions, paths, media }: { message: Message; index: number; timestamps: boolean; id: string; actions?: MessageActions; paths?: PathLinks; media: Artifact[] }) {
  const { colors } = useTheme();
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
  return (
    <View style={{ alignItems: "flex-end", gap: 4, paddingLeft: "16%" }}>
      {!!above && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" }} accessibilityLabel={(message.answer ? "Answered: " : "Replying to: ") + above}>
          <CornerDownRight size={13} color={colors.faint} strokeWidth={2.2} />
          <T variant="footnote" color="muted" numberOfLines={message.answer ? 2 : 1} style={{ flexShrink: 1 }}>
            {above}
          </T>
        </View>
      )}
      {!!message.attachments?.length && (
        <View style={{ alignItems: "flex-end", gap: 4 }}>
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
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 4 }}>
          {chips.map((mention) => {
            const Icon = mention.kind === "project" ? FolderKanban : mention.kind === "wiki" ? BookOpen : FileText;
            return (
              <View key={mention.kind + ":" + ("path" in mention ? mention.path : mention.id)} style={{ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", height: 32, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: colors.sunken }}>
                <Icon size={14} color={colors.muted} strokeWidth={2.2} />
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
          <View {...selectionTouch} style={{ backgroundColor: colors.bubble, borderRadius: 20, borderBottomRightRadius: 6, paddingHorizontal: 15, paddingVertical: 10 }}>
            <SelectableText text={rest} markdown={false} color={colors.onBubble} onDone={() => useSelecting.getState().id === id && select(null)} />
          </View>
        ) : (
          <HoldMenu
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
              <View style={{ backgroundColor: colors.bubble, borderRadius: 20, borderBottomRightRadius: 6, paddingHorizontal: 15, paddingVertical: 10 }}>
                <Markdown text={rest} inline color={colors.onBubble} paths={paths} />
              </View>
            </DoubleTap>
          </HoldMenu>
        ))}
      {media.length > 0 && <ArtifactChips items={media} align="flex-end" />}
      {timestamps && <Stamp time={message.time} align="flex-end" />}
    </View>
  );
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
function ReadAloud({ id, text }: { id: string; text: string }) {
  const { colors } = useTheme();
  const reading = useSpeakingNow((state) => state.id === id);
  return (
    <IconButton
      icon={reading ? Square : Volume2}
      size={28}
      color={reading ? colors.accentText : colors.faint}
      label={reading ? "Stop reading" : "Read aloud"}
      onPress={() => (reading ? stopSpeech() : speakText(id, text))}
      style={{ marginLeft: -6 }}
    />
  );
}

/** A bot's reply. A long press offers Copy, Select text, Read aloud (or Stop reading), Share, Reply and Fork from here. */
function Reply({ message, index, id, markdown, actions, paths, parts }: { message: Message; index: number; id: string; markdown: boolean; actions?: MessageActions; paths?: PathLinks; /** The text and its MEDIA: attachments in order, when it has any the computer knows. */ parts?: MessagePart[] }) {
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
    <HoldMenu
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
        else if (action === "read") speakText(id, message.text);
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
    </HoldMenu>
  );
}

export const MessageRow = memo(function MessageRow({ item, chatId, group, bots, onSend, onDraft, actions }: { item: Extract<Item, { kind: "message" }>; chatId: string; group: boolean; bots: Map<string, Bot>; onSend: (text: string) => void; /** Text a custom view hands over, for the message box. */ onDraft?: (text: string) => void; actions?: MessageActions }) {
  const steps = useChatPrefs((prefs) => prefs.steps);
  const rich = useChatPrefs((prefs) => prefs.richCards);
  const markdown = useChatPrefs((prefs) => prefs.markdown);
  const timestamps = useChatPrefs((prefs) => prefs.timestamps);
  const { message, run, end, latest } = item;
  // Paths the computer knows become links, and a reply's MEDIA: attachments are drawn where they were
  // written (under the text in the person's own message). A reply still
  // being written is left alone until it ends, so half a path is never asked about.
  const links = useMessageLinks(chatId, message.text ?? "", message.role !== "command" && !(latest && run?.status === "Working"));
  if (message.role === "user") return <UserBubble message={message} index={item.index} timestamps={timestamps} id={chatId + ":" + item.key} actions={actions} paths={links.paths} media={links.media} />;
  if (message.role === "command") return <CommandBlock message={message} />;
  // A group chat's turn keeps its work line under its last reply; any other turn draws its work in place (turn.ts).
  const worked = item.workUnder && run && run.status !== "Working";
  return (
    <View style={{ gap: space.sm }}>
      {group && <Speaker bot={message.botId ? bots.get(message.botId) : undefined} />}
      <Reply message={message} index={item.index} id={chatId + ":" + item.key} markdown={markdown} actions={actions} paths={links.paths} parts={links.parts} />
      {!!message.text.trim() && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <ReadAloud id={chatId + ":" + item.key} text={message.text} />
          {timestamps && <Stamp time={message.time} align="flex-start" />}
        </View>
      )}
      {!message.text.trim() && timestamps && <Stamp time={message.time} align="flex-start" />}
      {worked && <GroupWorkLine chatId={chatId} run={run} mode={steps} />}
      {end && run && <Cards run={run} latest={latest} rich={rich} onSend={onSend} onDraft={onDraft} />}
    </View>
  );
});

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
