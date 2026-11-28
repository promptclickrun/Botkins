// Receives a handoff from the native iOS Share Extension (`botkins://open/share?id=<id>`).
// Reads the staged payload from the shared App Group, lets the person review or edit the target
// bot and context (or sends directly when ready), uploads any attached files/photos/videos to the
// computer, sends the message in that bot's chat, cleans up the staged folder, and opens the chat.
import { router, useLocalSearchParams } from "expo-router";
import { Check, FileText, Film, Image as ImageIcon, Link2, MessageSquareText } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { TextInput, View } from "react-native";
import { Activities } from "../../../modules/botkins-activity";
import { upload } from "@/features/chat/uploads";
import { homeBots, homeChat } from "@/features/home/homeBot";
import type { UploadedFile } from "@/link/types";
import { useBots, useCan, useCapability, useChats, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast, useApp } from "@/state/store";
import { idForHost } from "@/state/unified";
import { BotAvatar, Button, EmptyState, Group, Label, Loading, Page, radius, Row, space, T, useTheme } from "@/ui";
import { showChat, switchToHost, whenSynced } from "./opening";
import { formatSharedMessage, parseSharedPayload, type SharedPayload } from "./share";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function OpenShare() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { colors, dark, type } = useTheme();
  const bots = useBots();
  const chats = useChats();
  const online = useOnline();
  const canChat = useCan("agents", "chat");
  const mainCap = useCapability("main-chat-v1");
  const person = useApp((state) => (state.parts.meta?.you?.kind === "member" ? state.parts.meta.you.memberId : "owner"));
  const unified = useApp((state) => state.unified);
  const primaryId = useApp((state) => state.pairing?.serverId ?? null);

  const visibleBots = useMemo(() => homeBots(bots), [bots]);
  const [payload, setPayload] = useState<SharedPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedBotId, setSelectedBotId] = useState<string>("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!id || !Activities?.readShare) {
        if (active) setLoading(false);
        return;
      }
      const raw = await Activities.readShare(id).catch(() => null);
      const parsed = parseSharedPayload(raw);
      if (!active) return;
      if (!parsed) {
        setLoading(false);
        return;
      }
      setPayload(parsed);
      setNote(parsed.note);
      if (parsed.hostId && !useApp.getState().unified) {
        await switchToHost(parsed.hostId);
      }
      await whenSynced();
      if (!active) return;
      if (parsed.botId) {
        const state = useApp.getState();
        const candidate = state.unified && parsed.hostId
          ? idForHost(parsed.hostId, parsed.botId, state.pairing?.serverId ?? null)
          : parsed.botId;
        const matched = (state.parts.bots ?? []).find((b) => b.id === candidate || b.id === parsed.botId);
        setSelectedBotId(matched?.id ?? "");
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [id]);

  // Default to primary visible bot once bots are loaded if none was picked or matched.
  useEffect(() => {
    if (!selectedBotId && visibleBots.length > 0) {
      setSelectedBotId(visibleBots[0]!.id);
    }
  }, [selectedBotId, visibleBots]);

  const dismiss = async () => {
    if (id) await Activities?.clearShare?.(id).catch(() => {});
    router.replace("/");
  };

  const sendShare = async () => {
    if (!payload || !selectedBotId || sending) return;
    if (!canChat) {
      showToast("Your team role can't start chats.", "error");
      return;
    }
    setSending(true);
    try {
      // 1. Resolve target chat (Main chat where supported, else latest chat, else new chat).
      const want = homeChat(chats, selectedBotId, mainCap, person);
      let chatId = want && "id" in want ? want.id : undefined;
      if (!chatId) {
        setProgress("Opening chat…");
        chatId = mainCap
          ? await attempt(api.mainChat(selectedBotId))
          : await attempt(api.createChat(selectedBotId));
      }
      if (!chatId) {
        setSending(false);
        setProgress("");
        return;
      }

      // 2. Upload any shared files/photos/videos to the computer.
      const uploaded: UploadedFile[] = [];
      for (let i = 0; i < payload.attachments.length; i++) {
        const file = payload.attachments[i]!;
        setProgress(`Uploading ${i + 1} of ${payload.attachments.length} (${file.name})…`);
        const res = await upload(
          file.uri,
          file.name,
          () => {},
          () => false,
        );
        uploaded.push(res);
      }

      // 3. Compose and send the message.
      const message = formatSharedMessage({ ...payload, note }, uploaded.length);
      if (!message && uploaded.length === 0) {
        showToast("Nothing to send.", "error");
        setSending(false);
        setProgress("");
        return;
      }
      setProgress("Sending…");
      const ok = await attempt(
        api.send(chatId, message || "See the shared file.", uploaded.length ? { attachments: uploaded } : undefined),
      );
      if (ok !== undefined) {
        if (id) await Activities?.clearShare?.(id).catch(() => {});
        showChat(chatId);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not send shared items.", "error");
    } finally {
      setSending(false);
      setProgress("");
    }
  };

  if (loading) {
    return (
      <Page title="Share to Botkins">
        <Loading />
      </Page>
    );
  }

  if (!payload) {
    return (
      <Page title="Share to Botkins">
        <EmptyState title="Nothing shared" text="The shared item is no longer available." action="Done" onAction={() => void dismiss()} />
      </Page>
    );
  }

  const chosenBot = visibleBots.find((b) => b.id === selectedBotId) ?? visibleBots[0];
  const hostNote = unified && payload.hostId && payload.hostId !== primaryId ? undefined : undefined;

  return (
    <Page title="Share to Botkins" keyboard>
      <View style={{ gap: space.lg }}>
        <View>
          <Label>Send to</Label>
          <Group>
            {visibleBots.map((b) => {
              const selected = b.id === (chosenBot?.id ?? "");
              return (
                <Row
                  key={b.id}
                  leading={<BotAvatar bot={b} size={32} />}
                  title={b.name}
                  subtitle={b.role || hostNote}
                  trailing={selected ? <Check size={18} color={colors.accentText} strokeWidth={2.6} /> : undefined}
                  onPress={sending ? undefined : () => setSelectedBotId(b.id)}
                />
              );
            })}
          </Group>
        </View>

        <View>
          <Label>Context</Label>
          <Group>
            <View style={{ padding: space.md }}>
              <TextInput
                value={note}
                onChangeText={setNote}
                editable={!sending}
                placeholder="Add instructions or context…"
                placeholderTextColor={colors.faint}
                keyboardAppearance={dark ? "dark" : "light"}
                selectionColor={colors.accent}
                multiline
                style={[type.body, { color: colors.ink, minHeight: 72, textAlignVertical: "top", borderRadius: radius.md }]}
              />
            </View>
          </Group>
        </View>

        <View>
          <Label>Shared items</Label>
          <Group>
            {payload.urls.map((link) => (
              <Row
                key={link}
                leading={<Link2 size={18} color={colors.muted} strokeWidth={2.1} />}
                title={link}
                titleLines={2}
              />
            ))}
            {!!payload.text && (
              <Row
                leading={<MessageSquareText size={18} color={colors.muted} strokeWidth={2.1} />}
                title={payload.text}
                titleLines={4}
              />
            )}
            {payload.attachments.map((file) => {
              const Icon = file.kind === "image" ? ImageIcon : file.kind === "video" ? Film : FileText;
              return (
                <Row
                  key={file.id}
                  leading={<Icon size={18} color={colors.muted} strokeWidth={2.1} />}
                  title={file.name}
                  subtitle={formatBytes(file.size) || undefined}
                />
              );
            })}
          </Group>
        </View>

        {!!progress && (
          <T variant="footnote" color="muted" center>
            {progress}
          </T>
        )}

        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button title="Cancel" variant="secondary" disabled={sending} onPress={() => void dismiss()} />
          </View>
          <View style={{ flex: 2 }}>
            <Button
              title={sending ? "Sending…" : chosenBot ? `Send to ${chosenBot.name}` : "Send"}
              disabled={sending || !online || !chosenBot}
              loading={sending}
              onPress={() => void sendShare()}
            />
          </View>
        </View>
      </View>
    </Page>
  );
}
