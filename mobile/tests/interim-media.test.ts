// Phone interim updates with MEDIA: attachments:
// - TurnText / Aside (inline in chat & expanded fold) must resolve MEDIA: and render InlineMedia instead of raw MEDIA:/path text.
// - RunActivity (activity sheet) must also resolve MEDIA: in interim updates (both while Working and after Completed).
// - Unknown paths stay raw text; known paths render InlineMedia once without the raw MEDIA: line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as el } from "react";
import type { Artifact, Message, Run } from "../src/link/types";
import { messageParts, mediaOf, linkedSpans } from "../src/features/artifacts/logic";
import { detectPaths } from "../src/features/chat/paths";
import { chatTimeline } from "../src/features/chat/turn";
import { mount, phoneModule } from "./render-phone";

const native = { Text: "Text", View: "View", StyleSheet: { hairlineWidth: 0.5 }, Platform: { OS: "ios" }, ActivityIndicator: "ActivityIndicator" };
const theme = { colors: { ink: "ink", ink2: "ink2", muted: "muted", faint: "faint", line: "line", lineStrong: "lineStrong", accent: "accent", accentText: "accentText", danger: "danger", warning: "warning", success: "success", sunken: "sunken" }, type: { body: {}, callout: {}, footnote: {}, subhead: {}, mono: {}, title3: {} } };
const space = { xs: 4, sm: 8, md: 12, lg: 16, huge: 32 };

const knownShot: Artifact = {
  id: "art-shot",
  botId: "pip",
  chatId: "chat-1",
  path: "/opt/data/files/pip/shot.png",
  name: "shot.png",
  kind: "image",
  mime: "image/png",
  size: 2048,
  time: 1000,
  source: "media",
};
const knownPdf: Artifact = {
  id: "art-pdf",
  botId: "pip",
  chatId: "chat-1",
  path: "/opt/data/files/pip/report.pdf",
  name: "report.pdf",
  kind: "file",
  mime: "application/pdf",
  size: 4096,
  time: 1000,
  source: "media",
};

const knownMacShot: Artifact = {
  id: "art-mac-shot",
  botId: "pip",
  chatId: "chat-1",
  path: "/Users/gordieai/Library/Application Support/Botkins/data/files/04104688/botkins-a2ui-desktop.png",
  name: "botkins-a2ui-desktop.png",
  kind: "image",
  mime: "image/png",
  size: 472000,
  time: 1000,
  source: "media",
};

const knownByChat: Record<string, Record<string, Artifact | null>> = {
  "chat-1": {
    [knownShot.path]: knownShot,
    [knownPdf.path]: knownPdf,
    [knownMacShot.path]: knownMacShot,
    "/tmp/secret.txt": null,
  },
};

function fakeUseMessageLinks(chatId: string, text: string, active: boolean) {
  if (!active || !chatId || !text) return { media: [] };
  const spans = detectPaths(text);
  const known = knownByChat[chatId];
  const resolved = linkedSpans(spans, known);
  if (!resolved.length) return { media: [] };
  const media = mediaOf(spans, known);
  return {
    paths: {
      has: (p: string) => Boolean(known?.[p]),
      find: (part: string) => detectPaths(part).filter((s) => Boolean(known?.[s.path])),
      open: () => {},
    },
    media,
    ...(media.length > 0 && { parts: messageParts(text, spans, known) }),
  };
}

const prefs = {
  useChatPrefs: (sel: (p: { thinking: string; updates: boolean; markdown: boolean }) => unknown) =>
    sel({ thinking: "show", updates: true, markdown: true }),
};
const uiStub = {
  BotAvatar: "BotAvatar",
  Badge: "Badge",
  EmptyState: "EmptyState",
  Group: "Group",
  Label: "Label",
  Markdown: "Markdown",
  Row: "Row",
  Sheet: "Sheet",
  T: "T",
  Tap: "Tap",
  space,
  useTheme: () => theme,
};
const artifactBitsStub = {
  InlineMedia: "InlineMedia",
};
const artifactDataStub = {
  useMessageLinks: fakeUseMessageLinks,
};

const { Aside } = phoneModule("../src/features/chat/Aside", {
  "react-native": native,
  "@/state/chatPrefs": prefs,
  "@/ui": uiStub,
  "@/ui/Shimmer": { Shimmer: "Shimmer" },
  "@/features/artifacts/data": artifactDataStub,
  "@/features/artifacts/ArtifactBits": artifactBitsStub,
  "./bits": { plainPreview: (s: string) => s },
  "./WorkRows": { FACE: 18 },
});

const { TurnText } = phoneModule("../src/features/chat/LiveTurn", {
  "react-native": native,
  "@/state/chatPrefs": prefs,
  "@/state/hooks": { useChatActivity: () => "talking", activityLabel: () => "Working" },
  "@/state/store": { useApp: (sel: (s: Record<string, unknown>) => unknown) => sel({ parts: {}, texts: {}, running: {} }) },
  "@/ui": uiStub,
  "./Aside": { Aside },
  "./bits": { workWidth: {} },
  "./islandModel": { islandOn: () => false },
  "./liveDisplay": { liveTurnDisplay: () => ({ stream: "" }) },
  "./turn": { resolveLiveBody: () => ({ text: "", thinking: "" }), segmentThinking: () => "" },
  "./WorkRows": { FACE_INDENT: 26, StepLine: "StepLine" },
});

test("mobile TurnText and Aside render InlineMedia for known MEDIA: in interim updates (during and after a run) and keep unknown paths as text", async (t) => {
  const interimText = [
    "Here is the screenshot:",
    `MEDIA:${knownShot.path}`,
    `MEDIA:${knownPdf.path}`,
    "MEDIA:/tmp/secret.txt",
  ].join("\n");

  const ask: Message = { role: "user", text: "Capture it", runId: "r1", time: 100 };
  const interim: Message = { role: "assistant", text: interimText, runId: "r1", time: 200, interim: true };
  const reply: Message = { role: "assistant", text: "Finished.", runId: "r1", time: 500 };
  const liveRun: Run = { id: "r1", chatId: "chat-1", title: "Capture", status: "Working", time: 100, steps: [{ id: "s1", name: "bash", label: "run", status: "Running", started: 250 }] };
  const doneRun: Run = { ...liveRun, status: "Completed", finished: 500, steps: [{ ...liveRun.steps![0]!, status: "Done", finished: 400 }] };

  const during = chatTimeline({
    messages: [ask, interim],
    from: 0,
    runs: {},
    running: liveRun,
    live: { stream: "" },
    timeline: true,
    group: false,
    prefs: { steps: "show", thinking: "show", updates: true, foldFinishedSteps: false },
  });
  const liveTextItem = during.find((item) => item.kind === "text");
  assert.ok(liveTextItem && liveTextItem.kind === "text", "timeline emits a text item for interim update during Working");

  const screenLive = await mount(el(TurnText, { chatId: "chat-1", item: liveTextItem }));
  t.after(screenLive.unmount);

  const mediaNodes = screenLive.root.root.findAllByType("InlineMedia" as never);
  assert.deepEqual(
    mediaNodes.map((n) => n.props.artifact.id),
    ["art-shot", "art-pdf"],
    "TurnText renders InlineMedia for both image and non-image MEDIA: attachments during a Working run",
  );
  const mdTexts = screenLive.root.root.findAllByType("Markdown" as never).map((n) => String(n.props.text));
  assert.ok(mdTexts.some((txt) => txt.includes("Here is the screenshot:")));
  assert.ok(mdTexts.every((txt) => !txt.includes(knownShot.path) && !txt.includes(knownPdf.path)), "raw MEDIA: lines for known files are stripped");
  assert.ok(mdTexts.some((txt) => txt.includes("MEDIA:/tmp/secret.txt")), "unknown MEDIA: path stays raw text");

  // After the run completes, the interim message in Every-step mode still renders InlineMedia.
  const after = chatTimeline({
    messages: [ask, interim, reply],
    from: 0,
    runs: { r1: doneRun },
    running: null,
    timeline: true,
    group: false,
    prefs: { steps: "show", thinking: "show", updates: true, foldFinishedSteps: false },
  });
  const doneTextItem = after.find((item) => item.kind === "text");
  assert.ok(doneTextItem && doneTextItem.kind === "text");

  const screenDone = await mount(el(TurnText, { chatId: "chat-1", item: doneTextItem }));
  t.after(screenDone.unmount);
  assert.deepEqual(
    screenDone.root.root.findAllByType("InlineMedia" as never).map((n) => n.props.artifact.id),
    ["art-shot", "art-pdf"],
    "TurnText renders InlineMedia after the run completes",
  );

  // Also verify FoldRow forwards chatId into Aside when an ended turn's fold is expanded.
  const foldModule = phoneModule("../src/features/chat/FoldRow", {
    "react-native": native,
    "expo-router": { router: { push: () => {} } },
    "lucide-react-native": { ChevronDown: "ChevronDown", ChevronRight: "ChevronRight", CornerDownRight: "CornerDownRight" },
    "react-native-reanimated": { __esModule: true, default: { View: "View" }, FadeIn: { duration: () => ({}) } },
    "@/ui": uiStub,
    "./Aside": { Aside },
    "./bits": { workWidth: {} },
    "./WorkRows": { FACE: 18, FACE_INDENT: 26, StepLine: "StepLine" },
  });
  const foldedTimeline = chatTimeline({
    messages: [ask, interim, reply],
    from: 0,
    runs: { r1: doneRun },
    running: null,
    timeline: true,
    group: false,
    prefs: { steps: "folded", thinking: "folded", updates: true, foldFinishedSteps: true },
  });
  const foldItem = foldedTimeline.find((item) => item.kind === "fold");
  assert.ok(foldItem && foldItem.kind === "fold", "folded timeline emits a fold item containing the interim update");
  const foldScreen = await mount(el(foldModule.FoldRow, { chatId: "chat-1", group: false, item: foldItem }));
  t.after(foldScreen.unmount);
  // Tap the fold header to expand it.
  const headerTap = foldScreen.root.root.findAllByType("Tap" as never)[0];
  await (await import("react")).act(async () => {
    headerTap.props.onPress();
  });
  assert.deepEqual(
    foldScreen.root.root.findAllByType("InlineMedia" as never).map((n) => n.props.artifact.id),
    ["art-shot", "art-pdf"],
    "expanded FoldRow renders InlineMedia for MEDIA: in folded interim updates",
  );
});

test("mobile TurnText renders InlineMedia for macOS Application Support MEDIA: path with spaces in interim updates", async (t) => {
  const interimText = `Screenshot ready:\nMEDIA: ${knownMacShot.path}`;
  const ask: Message = { role: "user", text: "Capture on Mac", runId: "r-mac", time: 100 };
  const interim: Message = { role: "assistant", text: interimText, runId: "r-mac", time: 200, interim: true };
  const liveRun: Run = { id: "r-mac", chatId: "chat-1", title: "Capture", status: "Working", time: 100, steps: [{ id: "s1", name: "bash", label: "run", status: "Running", started: 250 }] };

  const during = chatTimeline({
    messages: [ask, interim],
    from: 0,
    runs: {},
    running: liveRun,
    live: { stream: "" },
    timeline: true,
    group: false,
    prefs: { steps: "show", thinking: "show", updates: true, foldFinishedSteps: false },
  });
  const liveTextItem = during.find((item) => item.kind === "text");
  assert.ok(liveTextItem && liveTextItem.kind === "text");

  const screenLive = await mount(el(TurnText, { chatId: "chat-1", item: liveTextItem }));
  t.after(screenLive.unmount);

  const mediaNodes = screenLive.root.root.findAllByType("InlineMedia" as never);
  assert.deepEqual(
    mediaNodes.map((n) => n.props.artifact.id),
    ["art-mac-shot"],
    "TurnText renders InlineMedia for macOS Application Support path with spaces in interim update",
  );
  const mdTexts = screenLive.root.root.findAllByType("Markdown" as never).map((n) => String(n.props.text));
  assert.ok(mdTexts.every((txt) => !txt.includes("MEDIA:") && !txt.includes("Application Support")), "raw MEDIA: line with spaces is stripped");
});

test("mobile RunActivity sheet renders InlineMedia for MEDIA: in interim updates (during and after a run)", async (t) => {
  const interimText = `Update with chart:\nMEDIA:${knownShot.path}`;
  const liveRun: Run = { id: "r1", chatId: "chat-1", title: "Chart", status: "Working", time: 100, steps: [{ id: "s1", name: "bash", label: "plot", status: "Running", started: 250 }] };
  let activeRun: Run = liveRun;
  const messages: Message[] = [
    { role: "user", text: "Plot", runId: "r1", time: 100 },
    { role: "assistant", text: interimText, runId: "r1", time: 200, interim: true },
  ];

  const { default: RunActivity } = phoneModule("../src/features/chat/RunActivity", {
    "react-native": native,
    "expo-router": { router: { push: () => {} }, useLocalSearchParams: () => ({ chatId: "chat-1", runId: "r1" }) },
    "lucide-react-native": { ChevronDown: "ChevronDown", ChevronRight: "ChevronRight", CircleDashed: "CircleDashed", MessageCircle: "MessageCircle" },
    "@/state/chatPrefs": prefs,
    "@/state/hooks": { useBots: () => [], useModels: () => [], useWatchedChat: () => ({ messages }) },
    "@/state/link": { api: {} },
    "@/state/models": { modelName: (m: string) => m },
    "@/state/store": {
      useApp: (sel: (s: Record<string, unknown>) => unknown) =>
        sel({
          chats: { "chat-1": { runs: { r1: activeRun } } },
          running: { "chat-1": activeRun.status === "Working" ? activeRun : null },
        }),
    },
    "@/state/time": { compactNumber: String, duration: String },
    "@/ui": uiStub,
    "@/features/artifacts/data": artifactDataStub,
    "@/features/artifacts/ArtifactBits": artifactBitsStub,
    "./useWatchedReasoning": { useWatchedReasoning: () => {} },
    "./ActivityWidgets": { CommandCard: "CommandCard", DiffCard: "DiffCard", KindIcon: "KindIcon", StepDetailView: "StepDetailView" },
    "./TodoList": { TodoList: "TodoList" },
    "./bits": { StepMark: "StepMark" },
    "./HelperRail": { commandSheet: () => "", helperSheet: () => "" },
  });

  const liveSheet = await mount(el(RunActivity));
  t.after(liveSheet.unmount);
  assert.deepEqual(
    liveSheet.root.root.findAllByType("InlineMedia" as never).map((n) => n.props.artifact.id),
    ["art-shot"],
    "RunActivity renders InlineMedia for interim update MEDIA: while Working",
  );
  assert.ok(
    liveSheet.root.root.findAllByType("Markdown" as never).every((n) => !String(n.props.text).includes(knownShot.path)),
    "RunActivity strips raw MEDIA: line when resolved",
  );

  activeRun = { ...liveRun, status: "Completed", finished: 500, steps: [{ ...liveRun.steps![0]!, status: "Done", finished: 400 }] };
  const doneSheet = await mount(el(RunActivity));
  t.after(doneSheet.unmount);
  assert.deepEqual(
    doneSheet.root.root.findAllByType("InlineMedia" as never).map((n) => n.props.artifact.id),
    ["art-shot"],
    "RunActivity renders InlineMedia for interim update MEDIA: after Completed",
  );
});
