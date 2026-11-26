// Direct approval sheet for node-host permission requests (`nodeJob: true` / `node-job-*`).
// Node-host jobs are not backed by a chat, so tapping a node approval notification or Home row
// opens this sheet directly instead of navigating to `/chat/[id]`.
import { router, useLocalSearchParams } from "expo-router";
import { ShieldAlert, ShieldCheck } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { looksDangerous, wordsFor } from "@/features/chat/request/logic";
import { Code, Disclosure, HOLD_EXTRA, HoldToAllow, Pair } from "@/features/chat/request/parts";
import { switchToHost, whenSynced } from "@/features/open/opening";
import type { AgentRequest, RequestAnswer } from "@/link/types";
import { api, attempt } from "@/state/link";
import { isNodeJobRequest } from "@/state/pushRouting";
import { useApp } from "@/state/store";
import { Button, Loading, radius, space, T, useTheme } from "@/ui";
import { shownText } from "@/ui/shownText";

function findNodeRequest(
  requests: AgentRequest[] | undefined,
  requestId?: string,
  chatId?: string,
): AgentRequest | undefined {
  if (!requests?.length) return undefined;
  if (requestId) {
    const byId = requests.find((item) => item.id === requestId);
    if (byId) return byId;
  }
  if (chatId) {
    const byChat = requests.find((item) => item.chatId === chatId);
    if (byChat) return byChat;
  }
  return requests.find((item) => isNodeJobRequest(item));
}

export default function NodeApprovalSheet() {
  const { request: requestId, chat: chatId, host } = useLocalSearchParams<{
    request?: string;
    chat?: string;
    host?: string;
  }>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [ready, setReady] = useState(!host);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const requests = useApp((state) => state.parts.live?.requests);
  const synced = useApp((state) => state.synced);
  const hostName = useApp((state) => state.pairing?.name ?? "This computer");
  const request = findNodeRequest(requests, requestId, chatId);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (host) await switchToHost(host);
      await whenSynced();
      if (active) setReady(true);
    })();
    return () => {
      active = false;
    };
  }, [host]);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const respond = async (answer: RequestAnswer, which: string) => {
    if (!request || busy) return;
    setBusy(which);
    const shownWhole = request.review && ["approve", "today", "remember"].includes(answer.action);
    const ok = await attempt(
      api.respond(request.id, shownWhole ? { ...answer, reviewed: true } : answer).then(() => true),
    );
    setBusy(null);
    if (ok) {
      setDone(true);
      close();
    }
  };

  if (!ready || (!synced && !request)) {
    return <Loading />;
  }

  if (!request) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: space.xl, gap: space.md }}>
        <ShieldCheck size={36} color={colors.muted} />
        <T variant="headline" center>
          {done ? "Decision sent" : "This approval is no longer waiting"}
        </T>
        <T variant="subhead" color="muted" center>
          {done
            ? "Your answer was delivered to the node host."
            : "It may have already been answered on another device or timed out."}
        </T>
        <Button title="Close" variant="secondary" onPress={close} />
      </View>
    );
  }

  const danger = looksDangerous(request);
  const words = wordsFor("permission", true);
  const approve = () => void respond({ action: "approve" }, "approve");
  const always = () => void respond({ action: "remember" }, "remember");
  const subtitleParts = [
    request.sourceBotName && request.sourceHostName
      ? `${request.sourceBotName} on ${request.sourceHostName}`
      : request.sourceBotName || request.sourceHostName,
    `Target: ${request.targetHostName || hostName}`,
  ].filter(Boolean);

  return (
    <View style={{ flex: 1, paddingBottom: Math.max(insets.bottom, space.lg) }}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space.xl,
          paddingTop: space.xl,
          paddingBottom: space.lg,
          gap: space.md,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: radius.md,
              backgroundColor: danger ? colors.dangerSoft : colors.sunken,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <ShieldAlert size={20} color={danger ? colors.danger : colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <T variant="footnote" color="muted">
              Node host approval
            </T>
            <T variant="subhead" weight="600" numberOfLines={2}>
              {shownText(subtitleParts.join(" · "))}
            </T>
          </View>
        </View>

        <T variant="headline" selectable>
          {shownText(request.title)}
        </T>

        {!!request.label && (
          <T variant="subhead" color="muted" selectable>
            {shownText(request.label, { lines: true })}
          </T>
        )}

        {!!request.preview && (
          <Code danger={danger}>{shownText(request.preview, { lines: true })}</Code>
        )}

        {!!request.detail &&
          (request.preview && !request.review ? (
            <Disclosure title="Full request">
              <Code>{shownText(request.detail, { lines: true })}</Code>
            </Disclosure>
          ) : (
            <Code danger={danger}>{shownText(request.detail, { lines: true })}</Code>
          ))}
      </ScrollView>

      <View
        style={{
          paddingHorizontal: space.xl,
          paddingTop: space.md,
          borderTopWidth: 1,
          borderTopColor: colors.line,
          gap: space.xs,
        }}
      >
        <Pair
          quiet={{
            label: words.quiet,
            render: (style) => (
              <Button
                title={words.quiet}
                variant="secondary"
                style={style}
                loading={busy === "deny"}
                disabled={!!busy}
                onPress={() => void respond({ action: "deny" }, "deny")}
              />
            ),
          }}
          main={
            danger
              ? {
                  label: "Hold to " + words.main.toLowerCase(),
                  extra: HOLD_EXTRA,
                  render: (style) => (
                    <HoldToAllow
                      label={words.main}
                      style={style}
                      busy={busy === "approve"}
                      disabled={!!busy}
                      onConfirm={approve}
                    />
                  ),
                }
              : {
                  label: words.main,
                  render: (style) => (
                    <Button
                      title={words.main}
                      style={style}
                      loading={busy === "approve"}
                      disabled={!!busy}
                      onPress={approve}
                    />
                  ),
                }
          }
        />
        <Button
          title="Allow for today"
          variant="secondary"
          wide
          loading={busy === "today"}
          disabled={!!busy}
          onPress={() => void respond({ action: "today" }, "today")}
        />
        {!!words.remember && (
          <Button
            title={words.remember}
            variant="ghost"
            size="sm"
            wide
            loading={busy === "remember"}
            disabled={!!busy}
            onPress={
              danger
                ? () =>
                    Alert.alert(words.remember + "?", "This node operation will be allowed without asking again.", [
                      { text: "Cancel", style: "cancel" },
                      { text: words.remember ?? "Always allow", style: "destructive", onPress: always },
                    ])
                : always
            }
          />
        )}
      </View>
    </View>
  );
}
