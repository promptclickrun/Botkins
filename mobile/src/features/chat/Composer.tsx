// Where a person writes: a growing field, a Today card being discussed, files and mentions as chips,
// then the row: attach on the left; on the right the model in use and the main button
// (Send with text or a file, Stop while the bot works, else Live voice). "/", "@" and "#" at the
// caret open a list of suggestions above it.
import { MenuView } from "@react-native-menu/menu";
import { router } from "expo-router";
import { ArrowUp, AudioLines, BookOpen, CircleAlert, FileText, FolderKanban, ImageIcon, Lightbulb, Newspaper, Plus, Quote, Sparkles, Square, Target, X } from "lucide-react-native";
import { type ComponentRef, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Alert, Linking, ScrollView, Text, TextInput, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import type { BoardItem, Bot, MentionInput } from "@/link/types";
import { useChatPrefs } from "@/state/chatPrefs";
import { useCan, usePart, useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { ProviderIcon, radius, space, T, Tap, useTheme } from "@/ui";
import { endTalk, openLiveVoice, startTalk, useLiveVoiceReady, useTalk, useTalkReady } from "../voice/api";
import { boardKindLabel, teammates, toInput } from "./compose";
import { documentPickerModule, imagePickerModule, NEEDS_UPDATE } from "./native";
import {
  botOptions,
  type DraftMention,
  findTrigger,
  MAX_MENTIONS,
  mentionKey,
  type Option,
  pullOptions,
  recordOptions,
  slashOptions,
  SuggestionList,
  tokenOf,
  useCatalog,
  useMentionables,
  usePullRequests,
} from "./Suggestions";
import { type Attachment, MAX_BYTES, MAX_FILES, sizeOf, upload } from "./uploads";

/** The field grows with the text up to this many lines, then scrolls inside. */
const MAX_LINES = 4;
/** The field's own padding, top and bottom. */
const FIELD_PAD_TOP = 8;
const FIELD_PAD_BOTTOM = 4;

export type ModelPill = { provider?: string; name: string; effort?: string };
export type SendOptions = { mentions?: MentionInput[]; attachments?: { name: string; path: string }[]; /** A message being replied to (the chat screen adds it). */ quote?: string };

/** A thin ring that fills as a file goes up. */
function ProgressRing({ progress, size = 18 }: { progress: number; size?: number }) {
  const { colors } = useTheme();
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  return (
    <Svg width={size} height={size} accessibilityLabel={"Uploading, " + Math.round(progress * 100) + "%"}>
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.line} strokeWidth={stroke} fill="none" />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={colors.accent}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - Math.max(0.04, progress))}
        transform={"rotate(-90 " + size / 2 + " " + size / 2 + ")"}
      />
    </Svg>
  );
}

/** A small removable pill above the field: a file going up, or a file, page or project mentioned. */
function Pill({ icon, label, tone, onRemove, removeLabel }: { icon: ReactNode; label: string; tone?: "danger"; onRemove: () => void; removeLabel: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ height: 32, maxWidth: 220, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 10, borderRadius: radius.pill, backgroundColor: tone === "danger" ? colors.dangerSoft : colors.sunken }}>
      {icon}
      <T variant="footnote" weight="600" color={tone === "danger" ? "danger" : "ink2"} numberOfLines={1} style={{ flexShrink: 1 }}>
        {label}
      </T>
      <Tap onPress={onRemove} feel="select" sink={0.9} hitSlop={{ top: 6, bottom: 6, right: 6 }} accessibilityLabel={removeLabel} style={{ width: 30, height: 32, alignItems: "center", justifyContent: "center" }}>
        <X size={14} color={colors.muted} strokeWidth={2.4} />
      </Tap>
    </View>
  );
}

function mentionIcon(kind: DraftMention["kind"], color: string) {
  const Icon = kind === "project" ? FolderKanban : kind === "wiki" ? BookOpen : FileText;
  return <Icon size={14} color={color} strokeWidth={2.2} />;
}

const BOARD_ICON = { feed: Newspaper, idea: Lightbulb, goal: Target } as const;

/** The Today card being discussed, pinned above the field until the first message goes. */
function PinnedCard({ item, onRemove }: { item: BoardItem; onRemove: () => void }) {
  const { colors } = useTheme();
  const Icon = BOARD_ICON[item.kind] ?? Newspaper;
  const body = item.body.trim();
  return (
    <View
      testID="composer-pinned"
      style={{ marginHorizontal: space.sm, marginTop: 4, flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingLeft: space.md, paddingVertical: space.sm, borderRadius: radius.md, backgroundColor: colors.sunken }}
    >
      <View accessible accessibilityLabel={boardKindLabel(item.kind) + ": " + item.title + (body ? ". " + body : "")} style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Icon size={13} color={colors.muted} strokeWidth={2.3} />
          <T variant="caption" color="muted" numberOfLines={1}>
            {boardKindLabel(item.kind)}
          </T>
        </View>
        <T variant="subhead" weight="600" numberOfLines={1}>
          {item.title}
        </T>
        {!!body && (
          <T variant="footnote" color="muted" numberOfLines={2}>
            {body}
          </T>
        )}
      </View>
      <Tap onPress={onRemove} feel="select" sink={0.9} hitSlop={4} accessibilityLabel={"Unpin " + item.title} style={{ width: 40, height: 40, marginTop: -space.xs, alignItems: "center", justifyContent: "center" }}>
        <X size={15} color={colors.muted} strokeWidth={2.4} />
      </Tap>
    </View>
  );
}

/** The message being replied to, above the field until the next message goes. */
function QuoteBar({ text, onRemove }: { text: string; onRemove: () => void }) {
  const { colors } = useTheme();
  return (
    <View testID="composer-quote" style={{ marginHorizontal: space.sm, marginTop: 4, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.md, borderRadius: radius.md, backgroundColor: colors.sunken }}>
      <Quote size={13} color={colors.muted} strokeWidth={2.3} />
      <T variant="footnote" color="muted" numberOfLines={2} style={{ flex: 1, paddingVertical: space.sm }} accessibilityLabel={"Replying to: " + text}>
        {text}
      </T>
      <Tap onPress={onRemove} feel="select" sink={0.9} hitSlop={4} accessibilityLabel="Cancel reply" style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}>
        <X size={15} color={colors.muted} strokeWidth={2.4} />
      </Tap>
    </View>
  );
}

const nameFromUri = (uri: string, fallback: string) => decodeURIComponent(uri.split("/").pop() || "") || fallback;

export function Composer({
  chatId,
  botId,
  group,
  members,
  bots,
  pinned,
  onUnpin,
  quote,
  onUnquote,
  value,
  onChange,
  onSend,
  onStop,
  working,
  placeholder,
  model,
  inputRef,
}: {
  chatId: string;
  botId?: string;
  group: boolean;
  /** A group chat's members, in answer order. */
  members?: string[];
  bots: Map<string, Bot>;
  /** The Today card being discussed; the chat screen sends it with the first message. */
  pinned?: BoardItem;
  onUnpin?: () => void;
  /** The message being replied to; the chat screen sends it with the next message. */
  quote?: string;
  onUnquote?: () => void;
  value: string;
  onChange: (text: string) => void;
  /** Resolves to false when the message didn't go, so the chips come back. */
  onSend: (options: SendOptions) => Promise<boolean>;
  onStop: () => void;
  working: boolean;
  placeholder: string;
  model: ModelPill;
  inputRef: RefObject<ComponentRef<typeof TextInput> | null>;
}) {
  const canManage = useCan("agents", "manage");
  const { colors, dark, type } = useTheme();
  const enterSends = useChatPrefs((prefs) => prefs.enterSends);
  const capabilities = usePart("meta")?.capabilities;
  const canUpload = !!capabilities?.includes("uploads-v1");
  const canListPulls = !!capabilities?.includes("prs-v1");
  // One voice button. Live voice takes it when it is on (Settings › Voice); otherwise it talks by
  // turns: the phone listens, sends what was said, and reads the reply aloud. Neither is for a group chat.
  const liveReady = useLiveVoiceReady();
  const talkReady = useTalkReady();
  const canVoice = !group && !!botId && (liveReady || talkReady);
  const talking = useTalk((talk) => talk.chatId === chatId && talk.phase !== "off");
  const teamworkOn = useSettings()?.teamwork;

  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(value.length);
  const [mentions, setMentions] = useState<DraftMention[]>([]);
  const [files, setFiles] = useState<Attachment[]>([]);
  const removed = useRef(new Set<string>());
  const placeCaret = useRef<number | null>(null);

  // --- Suggestions
  const trigger = focused ? findTrigger(value, Math.min(caret, value.length)) : null;
  const sigil = trigger?.sigil;
  const query = trigger?.query ?? "";
  const catalog = useCatalog(sigil === "/", botId, chatId);
  const records = useMentionables(sigil === "@" || sigil === "#", chatId, botId);
  const pulls = usePullRequests(sigil === "#", canListPulls, chatId, query);

  let options: Option[] = [];
  let loading = false;
  let note: string | undefined;
  if (sigil === "/") {
    options = slashOptions(query, catalog.items, colors.muted);
    loading = catalog.loading;
    note = catalog.error || undefined;
  } else if (sigil === "@") {
    // Bots first: a group chat's members and "everyone", or the teammates a one-bot chat's bot can ask.
    const roster = group ? (members ?? []).flatMap((id) => bots.get(id) ?? []) : teammates([...bots.values()], botId, teamworkOn);
    options = [...botOptions(query, roster, group, colors.muted), ...recordOptions(query, records.data, colors.muted)];
    loading = records.loading;
    note = records.error || undefined;
  } else if (sigil === "#") {
    // Records first, as on the desktop, then the chat's pull requests where the computer can list them.
    const pullsShown = canListPulls && !(pulls.value && !pulls.value.available);
    options = [...recordOptions(query, records.data, colors.muted), ...(pullsShown ? pullOptions(pulls.value?.items ?? [], colors) : [])];
    loading = records.loading || (pullsShown && pulls.loading && !pulls.value);
    note = records.error || (pullsShown ? pulls.error : "") || undefined;
  }
  const listOpen = !!trigger;

  // The field is as tall as its text, from one line to MAX_LINES; past that it scrolls inside.
  // React Native 0.88 doesn't grow a field that keeps its own text (and reports its text's height
  // only when its layout changes), so the height comes from a hidden copy of the text drawn at the
  // field's width and type (`Measure` below).
  const [textHeight, setTextHeight] = useState(0);
  const fieldPad = FIELD_PAD_TOP + FIELD_PAD_BOTTOM;
  const fieldMin = type.body.lineHeight + fieldPad;
  const fieldMax = type.body.lineHeight * MAX_LINES + fieldPad;
  const fieldHeight = Math.min(fieldMax, Math.max(fieldMin, textHeight + fieldPad));

  // The field keeps its own text: it is never handed `value` back as a person types. Writing text
  // into an iPhone's field between keystrokes resets its autocorrect and inline predictions, so
  // only text that comes from somewhere else (a picked suggestion, a draft that was cleared or put
  // back) is pushed in, once, with the caret after it.
  const shown = useRef("");
  // What was last pushed in as a prop. The phone acts on a pushed text only when it differs from
  // the one pushed before, whatever was typed since, so a repeat needs a nudge first.
  const pushed = useRef("");
  const push = (text: string) => {
    const field = inputRef.current;
    if (!field) return;
    if (text === "") {
      // Emptying goes by command: it works whatever was pushed before.
      field.clear();
      return;
    }
    if (text === pushed.current) field.setNativeProps({ text: text + " " });
    field.setNativeProps({ text });
    pushed.current = text;
  };
  useEffect(() => {
    if (value === shown.current) return;
    shown.current = value;
    push(value);
    // The phone drops a push that crosses a keystroke it has not reported yet. When nothing was
    // typed since, the same text is pushed once more a moment later, so the field can't be left behind.
    const again = setTimeout(() => shown.current === value && push(value), 180);
    const at = placeCaret.current;
    placeCaret.current = null;
    if (at == null) return () => clearTimeout(again);
    inputRef.current?.focus();
    // After the new text is in the field, or the caret would be clamped to the old text.
    const frame = requestAnimationFrame(() => inputRef.current?.setSelection(at, at));
    const later = setTimeout(() => shown.current === value && inputRef.current?.setSelection(at, at), 240);
    return () => {
      clearTimeout(again);
      clearTimeout(later);
      cancelAnimationFrame(frame);
    };
  }, [value, inputRef]);

  const replace = (next: string, at: number) => {
    placeCaret.current = at;
    setCaret(at);
    onChange(next);
  };

  const pick = (option: Option) => {
    if (!trigger) return;
    if (option.action) {
      replace(value.slice(0, trigger.start) + value.slice(trigger.end).replace(/^ /, ""), trigger.start);
      if (option.action === "model") {
        if (canManage) router.push({ pathname: "/chat/model", params: { scope: "chat", id: chatId } });
      } else void attempt(api.compact(chatId), "Compacting");
      return;
    }
    const mention = option.mention;
    if (mention && !mentions.some((m) => mentionKey(m) === mentionKey(mention))) {
      if (mentions.length >= MAX_MENTIONS) {
        showToast("Mention up to " + MAX_MENTIONS + " things in one message.", "error");
        return;
      }
      setMentions([...mentions, mention]);
    }
    const text = (mention ? tokenOf(mention) : (option.insert ?? "")) + " ";
    const rest = value.slice(trigger.end).replace(/^ /, "");
    replace(value.slice(0, trigger.start) + text + rest, trigger.start + text.length);
  };

  // A mention whose "@label" left the text goes with it.
  const liveMentions = mentions.filter((mention) => value.includes(tokenOf(mention)));
  const removeMention = (mention: DraftMention) => {
    setMentions(mentions.filter((m) => m !== mention));
    const token = tokenOf(mention);
    const at = value.indexOf(token);
    if (at >= 0) {
      const end = at + token.length + (value[at + token.length] === " " ? 1 : 0);
      replace(value.slice(0, at) + value.slice(end), at);
    }
  };

  // --- Files
  const update = (key: string, patch: Partial<Attachment>) => setFiles((list) => list.map((file) => (file.key === key ? { ...file, ...patch } : file)));
  const addFiles = (picked: { name: string; uri: string; size: number; kind: Attachment["kind"] }[]) => {
    let room = MAX_FILES - files.length;
    const accepted: Attachment[] = [];
    for (const file of picked) {
      if (room <= 0) {
        showToast("Up to " + MAX_FILES + " files in one message.", "error");
        break;
      }
      if (file.size > MAX_BYTES) {
        showToast(file.name + " is over 25 MB.", "error");
        continue;
      }
      room--;
      accepted.push({ ...file, key: file.uri + ":" + Date.now() + ":" + accepted.length, progress: 0, status: "uploading" });
    }
    if (!accepted.length) return;
    setFiles((list) => [...list, ...accepted]);
    for (const file of accepted)
      upload(
        file.uri,
        file.name,
        (progress) => update(file.key, { progress }),
        () => removed.current.has(file.key),
      ).then(
        (result) => update(file.key, { status: "done", progress: 1, path: result.path, name: result.name || file.name }),
        (error: unknown) => {
          if (removed.current.has(file.key)) return;
          const message = error instanceof Error ? error.message : "Couldn't send this file.";
          update(file.key, { status: "failed", error: message });
          showToast(file.name + ": " + message, "error");
        },
      );
  };
  const removeFile = (key: string) => {
    removed.current.add(key);
    setFiles((list) => list.filter((file) => file.key !== key));
  };

  const pickPhotos = async () => {
    const ImagePicker = imagePickerModule();
    if (!ImagePicker) return showToast(NEEDS_UPDATE, "error");
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], allowsMultipleSelection: true, selectionLimit: Math.max(1, MAX_FILES - files.length), quality: 1 });
    if (result.canceled) return;
    addFiles(result.assets.map((asset) => ({ name: asset.fileName || nameFromUri(asset.uri, "Photo.jpg"), uri: asset.uri, size: asset.fileSize ?? sizeOf(asset.uri), kind: "image" as const })));
  };
  const takePhoto = async () => {
    const ImagePicker = imagePickerModule();
    if (!ImagePicker) return showToast(NEEDS_UPDATE, "error");
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera access is off", "Turn it on in Settings to take a photo here.", [
        { text: "Not now", style: "cancel" },
        { text: "Settings", onPress: () => void Linking.openSettings() },
      ]);
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (result.canceled) return;
    addFiles(result.assets.map((asset) => ({ name: asset.fileName || nameFromUri(asset.uri, "Photo.jpg"), uri: asset.uri, size: asset.fileSize ?? sizeOf(asset.uri), kind: "image" as const })));
  };
  const pickFiles = async () => {
    const DocumentPicker = documentPickerModule();
    if (!DocumentPicker) return showToast(NEEDS_UPDATE, "error");
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;
    addFiles(result.assets.map((asset) => ({ name: asset.name, uri: asset.uri, size: asset.size ?? sizeOf(asset.uri), kind: "file" as const })));
  };
  const attachAction = (id: string) => {
    const run = id === "library" ? pickPhotos : id === "camera" ? takePhoto : pickFiles;
    run().catch((error: unknown) => showToast(error instanceof Error ? error.message : "Couldn't open that.", "error"));
  };
  const attachBlocked = group ? "Group chats take text only." : !canUpload ? "Your computer can't take files yet. Update Botkins there." : null;

  // --- Send
  const uploading = files.some((file) => file.status === "uploading");
  const ready = files.filter((file) => file.status === "done" && file.path);
  const empty = !value.trim() && ready.length === 0 && !pinned;
  // The main button: Stop while a turn is under way and nothing is written, Live voice when nothing
  // is written and the computer can talk, else Send.
  const stop = working && empty && files.length === 0;
  const voice = !working && empty && files.length === 0 && canVoice;
  // While a talk is under way and the bot is not working, the button ends the talk.
  const endVoice = voice && talking;
  const sendDisabled = !stop && !voice && (empty || uploading);
  const startVoice = () => {
    if (!botId) return;
    if (liveReady) openLiveVoice(chatId, botId);
    else startTalk(chatId);
  };
  const submit = async () => {
    if (empty || uploading) return;
    const sentMentions = liveMentions;
    const sentFiles = files;
    setMentions([]);
    setFiles([]);
    const ok = await onSend({
      ...(sentMentions.length ? { mentions: sentMentions.map(toInput) } : {}),
      ...(ready.length ? { attachments: ready.map((file) => ({ name: file.name, path: file.path! })) } : {}),
    });
    if (!ok) {
      setMentions(sentMentions);
      setFiles(sentFiles);
    }
  };

  const chips = liveMentions.length > 0 || files.length > 0;
  const mainLabel = stop ? "Stop" : endVoice ? "End voice" : voice ? (liveReady ? "Live voice" : "Talk") : uploading ? "Send, waiting for files" : working ? "Send, it waits its turn" : "Send";
  const plus = (
    <View accessible accessibilityRole="button" accessibilityLabel="Attach" style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.sunken, alignItems: "center", justifyContent: "center" }}>
      <Plus size={18} color={colors.ink2} strokeWidth={2.4} />
    </View>
  );

  return (
    <View style={{ gap: space.sm }}>
      {listOpen && (
        <SuggestionList
          options={options}
          onPick={pick}
          loading={loading}
          note={note}
          label={sigil === "/" ? "Commands and skills" : sigil === "@" ? "Mention a bot, project, page or file" : "Mention a project, page, file or pull request"}
        />
      )}
      <View style={{ backgroundColor: colors.surface, borderRadius: 24, borderWidth: 1, borderColor: colors.line, paddingTop: 4 }}>
        {pinned && <PinnedCard item={pinned} onRemove={() => onUnpin?.()} />}
        {!!quote && <QuoteBar text={quote} onRemove={() => onUnquote?.()} />}
        {chips && (
          <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingHorizontal: space.sm, paddingTop: 4 }}>
            {files.map((file) => (
              <Pill
                key={file.key}
                label={file.name}
                tone={file.status === "failed" ? "danger" : undefined}
                removeLabel={"Remove " + file.name}
                onRemove={() => removeFile(file.key)}
                icon={
                  file.status === "uploading" ? (
                    <ProgressRing progress={file.progress} />
                  ) : file.status === "failed" ? (
                    <CircleAlert size={15} color={colors.danger} strokeWidth={2.3} />
                  ) : file.kind === "image" ? (
                    <ImageIcon size={15} color={colors.muted} strokeWidth={2.2} />
                  ) : (
                    <FileText size={15} color={colors.muted} strokeWidth={2.2} />
                  )
                }
              />
            ))}
            {liveMentions.map((mention) => (
              <Pill key={mentionKey(mention)} label={mention.label} icon={mentionIcon(mention.kind, colors.muted)} removeLabel={"Remove " + mention.label} onRemove={() => removeMention(mention)} />
            ))}
          </ScrollView>
        )}
        <TextInput
          ref={inputRef}
          testID="composer-input"
          onChangeText={(text) => {
            shown.current = text;
            // Typing at the end keeps the caret at the end until the field reports where it is.
            if (caret >= value.length) setCaret(text.length);
            onChange(text);
          }}
          onSelectionChange={(event) => setCaret(event.nativeEvent.selection.end)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          keyboardAppearance={dark ? "dark" : "light"}
          selectionColor={colors.accent}
          multiline
          submitBehavior={enterSends ? "submit" : "newline"}
          returnKeyType={enterSends ? "send" : "default"}
          onSubmitEditing={
            enterSends
              ? () => {
                  if (listOpen && options[0]) pick(options[0]);
                  else void submit();
                }
              : undefined
          }
          maxFontSizeMultiplier={1.3}
          accessibilityLabel={placeholder}
          textAlignVertical="top"
          // It scrolls inside only once the text is taller than the field can be.
          scrollEnabled={textHeight + fieldPad > fieldMax}
          style={[type.body, { color: colors.ink, paddingHorizontal: space.lg, paddingTop: FIELD_PAD_TOP, paddingBottom: FIELD_PAD_BOTTOM, height: fieldHeight }]}
        />
        {/* The hidden copy of the text that says how tall the field should be. A line break at the end gets a character after it, so the new line counts. */}
        <Text
          onLayout={(event) => setTextHeight(Math.ceil(event.nativeEvent.layout.height))}
          maxFontSizeMultiplier={1.3}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={[type.body, { position: "absolute", top: 0, left: space.lg, right: space.lg, opacity: 0 }]}
        >
          {value.endsWith("\n") ? value + "\u200b" : value || " "}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 6, paddingRight: 6, paddingBottom: 6, gap: space.sm }}>
          {attachBlocked ? (
            <Tap onPress={() => Alert.alert("Can't attach files here", attachBlocked)} feel="select" sink={0.9} hitSlop={6} accessibilityLabel="Attach" accessibilityHint={attachBlocked}>
              {plus}
            </Tap>
          ) : (
            <MenuView
              title={files.length >= MAX_FILES ? "Up to " + MAX_FILES + " files" : undefined}
              actions={[
                { id: "library", title: "Photo library", image: "photo.on.rectangle", attributes: { disabled: files.length >= MAX_FILES } },
                { id: "camera", title: "Take a photo", image: "camera", attributes: { disabled: files.length >= MAX_FILES } },
                { id: "file", title: "File", image: "doc", attributes: { disabled: files.length >= MAX_FILES } },
              ]}
              onPressAction={({ nativeEvent }) => attachAction(nativeEvent.event)}
              style={{ padding: 6, margin: -6 }}
            >
              {plus}
            </MenuView>
          )}
          <View style={{ flex: 1 }} />
          {/* The model: only its provider's mark, beside the main button. The chat's header names the model. */}
          <Tap
            onPress={canManage ? () => router.push({ pathname: "/chat/model", params: { scope: "chat", id: chatId } }) : undefined}
            disabled={!canManage}
            feel="select"
            sink={0.9}
            hitSlop={6}
            testID="composer-model"
            accessibilityLabel={"Model, " + model.name + (model.effort ? ", " + model.effort : "")}
            accessibilityHint="Changes the model"
            style={{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.sunken }}
          >
            {model.provider ? <ProviderIcon provider={model.provider} size={17} /> : <Sparkles size={17} color={colors.ink2} strokeWidth={2.2} />}
          </Tap>
          <Tap
            onPress={
              stop
                ? () => {
                    // Stopping the bot also ends a talk: the person took over.
                    if (talking) endTalk();
                    onStop();
                  }
                : endVoice
                  ? endTalk
                  : voice
                    ? startVoice
                    : () => void submit()
            }
            disabled={sendDisabled}
            sink={0.88}
            hitSlop={4}
            testID={voice ? "composer-voice" : "composer-send"}
            accessibilityLabel={mainLabel}
            accessibilityHint={voice && !endVoice ? (liveReady ? "Opens live voice with the bot" : "Listens, sends what you say, and reads the reply aloud") : undefined}
            style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: sendDisabled ? colors.lineStrong : colors.primary }}
          >
            {stop ? (
              <Square size={13} color={colors.onPrimary} fill={colors.onPrimary} strokeWidth={2} />
            ) : endVoice ? (
              <X size={19} color={colors.onPrimary} strokeWidth={2.6} />
            ) : voice ? (
              <AudioLines size={19} color={colors.onPrimary} strokeWidth={2.4} />
            ) : (
              <ArrowUp size={20} color={sendDisabled ? colors.surface : colors.onPrimary} strokeWidth={2.6} />
            )}
          </Tap>
        </View>
      </View>
    </View>
  );
}
