// Mobile A2uiSurface renderer tests (React Compiler enabled via render-phone harness).
// Covers Basic Catalog rendering, data-model binding + user edits, action dispatch with sendDataModel,
// rich-cards-off plain-text + action-buttons fallback, unsafe URL blocking, and dispatched/dismissed states.
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as el } from "react";
import type { A2uiSurface as A2uiSurfaceData } from "../src/link/types";
import { mount, phoneModule } from "./render-phone";

type Calls = {
  actions: unknown[][];
  functions: unknown[][];
  openedLinks: string[];
  openedChats: string[];
  audioPlays: string[];
  audioPauses: number;
};

function makeCalls(): Calls {
  return { actions: [], functions: [], openedLinks: [], openedChats: [], audioPlays: [], audioPauses: 0 };
}

function loadSurface(calls: Calls) {
  const iconStubs = new Proxy(
    {},
    {
      get: (_t, prop) => String(prop),
    },
  );
  return phoneModule("../src/features/chat/A2uiSurface", {
    "lucide-react-native": iconStubs,
    "react-native-svg": {
      default: "Svg",
      Svg: "Svg",
      Circle: "Circle",
      Line: "Line",
      Polyline: "Polyline",
    },
    "react-native-webview": {
      WebView: "WebView",
    },
    "@/features/voice/native": {
      audioModule: () => ({
        createAudioPlayer: ({ uri }: { uri: string }) => ({
          play: () => calls.audioPlays.push(uri),
          pause: () => {
            calls.audioPauses++;
          },
          remove: () => {},
        }),
      }),
    },
    "react-native": {
      Image: "Image",
      Modal: "Modal",
      ScrollView: "ScrollView",
      StyleSheet: { hairlineWidth: 1 },
      Switch: "Switch",
      TextInput: "TextInput",
      View: "View",
    },
    "@/state/link": {
      chatA2uiAction: (...args: unknown[]) => {
        calls.actions.push(args);
        return Promise.resolve({ ok: true, idempotent: false, actionId: "a1", route: "bot", surface: {} });
      },
      chatA2uiFunction: (...args: unknown[]) => {
        calls.functions.push(args);
        return Promise.resolve({ ok: true, idempotent: false, kind: "callAgentFunction", functionCallId: "f1" });
      },
    },
    "@/ui/LinkHold": {
      openLink: (url: string) => calls.openedLinks.push(url),
    },
    "@/ui": {
      Badge: "Badge",
      Button: "Button",
      T: "T",
      Tap: "Tap",
      radius: { sm: 8, md: 12, lg: 14 },
      space: { xs: 4, sm: 8, md: 12, lg: 16 },
      useTheme: () => ({
        dark: true,
        colors: {
          ink: "#ffffff",
          surface: "#1a1a1a",
          sunken: "#111111",
          line: "#333333",
          accent: "#3b82f6",
          onAccent: "#ffffff",
          warning: "#f59e0b",
          muted: "#888888",
          danger: "#ef4444",
        },
      }),
    },
    "./navigate": {
      openChat: (id: string) => calls.openedChats.push(id),
    },
  }) as {
    A2uiSurface: (props: {
      chatId: string;
      surface: A2uiSurfaceData;
      rich: boolean;
      onOpenChat?: (chatId: string) => void;
    }) => ReturnType<typeof el>;
  };
}

function makeSurface(overrides: Partial<A2uiSurfaceData> = {}): A2uiSurfaceData {
  return {
    surfaceId: "deploy-ui",
    version: "1.0",
    sendDataModel: true,
    components: [
      { id: "root", component: "Column", children: ["heading", "bad_img", "note_in", "smoke_chk", "env_pick", "btn_row"] },
      { id: "heading", component: "Text", text: "Deploy relay v0.18", variant: "h2" },
      { id: "bad_img", component: "Image", url: "javascript:alert(1)", description: "Unsafe image" },
      { id: "note_in", component: "TextField", label: "Release note", value: { "@path": "/note" } },
      { id: "smoke_chk", component: "CheckBox", label: "Run smoke suite", value: { "@path": "/smoke" } },
      {
        id: "env_pick",
        component: "ChoicePicker",
        label: "Environment",
        variant: "mutuallyExclusive",
        options: [
          { label: "Staging", value: "staging" },
          { label: "Production", value: "prod" },
        ],
        value: { "@path": "/env" },
      },
      { id: "btn_row", component: "Row", children: ["deploy_btn", "docs_btn"] },
      {
        id: "deploy_btn",
        component: "Button",
        child: "deploy_lbl",
        variant: "primary",
        action: {
          event: {
            name: "deploy",
            userMessage: "Deploy relay",
            context: { note: { "@path": "/note" }, env: { "@path": "/env" } },
          },
        },
      },
      { id: "deploy_lbl", component: "Text", text: "Deploy now" },
      {
        id: "docs_btn",
        component: "Button",
        child: "docs_lbl",
        variant: "borderless",
        action: { functionCall: { "@call": "openUrl", args: { url: "https://botkins.app/faq" } } },
      },
      { id: "docs_lbl", component: "Text", text: "Docs" },
    ],
    dataModel: { note: "Initial note", smoke: true, env: ["staging"] },
    ...overrides,
  };
}

test("Mobile A2uiSurface renders Basic Catalog inputs, updates bound dataModel, dispatches action, and opens safe links", async (t) => {
  const calls = makeCalls();
  const { A2uiSurface } = loadSurface(calls);

  const screen = await mount(el(A2uiSurface, { chatId: "chat-1", surface: makeSurface(), rich: true }));
  t.after(screen.unmount);

  const tree = screen.root.root;
  // Unsafe javascript: image is NOT rendered as an Image element
  assert.equal(tree.findAllByType("Image" as never).length, 0);

  // Edit TextField bound to /note
  const inputs = tree.findAllByType("TextInput" as never);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].props.value, "Initial note");
  await act(async () => {
    inputs[0].props.onChangeText("Ready to ship");
  });

  // Toggle CheckBox bound to /smoke
  const switches = tree.findAllByType("Switch" as never);
  assert.equal(switches.length, 1);
  assert.equal(switches[0].props.value, true);
  await act(async () => {
    switches[0].props.onValueChange(false);
  });

  // Press Deploy now button -> sends chatA2uiAction with updated context & dataModel
  const buttons = tree.findAllByType("Button" as never);
  assert.deepEqual(
    buttons.map((b) => b.props.title),
    ["Deploy now", "Docs"],
  );
  await act(async () => {
    await buttons[0].props.onPress();
  });
  assert.equal(calls.actions.length, 1);
  assert.equal(calls.actions[0][0], "chat-1");
  const sentPayload = calls.actions[0][1] as Record<string, any>;
  assert.equal(sentPayload.surfaceId, "deploy-ui");
  assert.equal(sentPayload.name, "deploy");
  assert.equal(sentPayload.context.note, "Ready to ship");
  assert.equal(sentPayload.dataModel.smoke, false);

  // Press Docs button -> invokes safe openLink
  await act(async () => {
    await buttons[1].props.onPress();
  });
  assert.deepEqual(calls.openedLinks, ["https://botkins.app/faq"]);
});

test("Mobile A2uiSurface rich-cards-off mode renders text summary plus interactive action buttons", async (t) => {
  const calls = makeCalls();
  const { A2uiSurface } = loadSurface(calls);

  const screen = await mount(el(A2uiSurface, { chatId: "chat-1", surface: makeSurface(), rich: false }));
  t.after(screen.unmount);

  const tree = screen.root.root;
  // No TextInput / Switch in plain fallback
  assert.equal(tree.findAllByType("TextInput" as never).length, 0);
  assert.equal(tree.findAllByType("Switch" as never).length, 0);
  // Action buttons remain clickable
  const buttons = tree.findAllByType("Button" as never);
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].props.title, "Deploy now");
  await act(async () => {
    await buttons[0].props.onPress();
  });
  assert.equal(calls.actions.length, 1);
});

test("Mobile A2uiSurface renders dispatched Open chat jump button and dismissed collapsed state", async (t) => {
  const calls = makeCalls();
  const { A2uiSurface } = loadSurface(calls);

  const dispatched = makeSurface({
    state: "dispatched",
    dispatchedChatId: "chat-glory-9",
    dispatchedBotName: "Glory",
  });
  const s1 = await mount(el(A2uiSurface, { chatId: "chat-1", surface: dispatched, rich: true }));
  t.after(s1.unmount);

  const openBtn = s1.root.root.findAllByType("Button" as never).find((b) => b.props.title === "Open chat");
  assert.ok(openBtn, "Open chat button should appear when dispatched");
  await act(async () => {
    openBtn!.props.onPress();
  });
  assert.deepEqual(calls.openedChats, ["chat-glory-9"]);

  const dismissed = makeSurface({ state: "dismissed" });
  const s2 = await mount(el(A2uiSurface, { chatId: "chat-1", surface: dismissed, rich: true }));
  t.after(s2.unmount);

  const badges = s2.root.root.findAllByType("Badge" as never);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].props.label, "Dismissed");
});

test("Mobile A2uiSurface renders Botkins Catalog (Chart, Table, ApprovalCard, Metric, Progress), inline audio/video, and unknown catalog fallback", async (t) => {
  const calls = makeCalls();
  const { A2uiSurface } = loadSurface(calls);

  const botkinsSurface: A2uiSurfaceData = {
    surfaceId: "mobile-botkins-1",
    version: "1.0",
    catalogId: "https://botkins.app/a2ui/catalog/v1.json",
    components: [
      { id: "root", component: "Column", children: ["av", "m1", "prog", "chart", "tbl", "appr", "aud", "vid", "bad_vid"] },
      { id: "av", component: "BotAvatar", name: "Glory", role: "Partner", status: "online" },
      { id: "m1", component: "Metric", label: "Tests", value: "1,245", delta: "+31", tone: "positive" },
      { id: "prog", component: "Progress", label: "Rollout", value: 80, max: 100 },
      {
        id: "chart",
        component: "Chart",
        kind: "line",
        title: "Latency",
        labels: ["Mon", "Tue", "Wed"],
        series: [{ name: "p95", values: [140, 128, 118] }],
      },
      {
        id: "tbl",
        component: "Table",
        title: "Services",
        columns: ["Service", "State"],
        rows: [["Relay", "Healthy"], ["Desktop", "Healthy"]],
      },
      {
        id: "appr",
        component: "ApprovalCard",
        title: "Approve production deploy",
        summary: "Includes A2UI 1.0 + Botkins Catalog",
        risk: "medium",
        status: "pending",
        approveAction: { event: { name: "approve_deploy" } },
        rejectAction: { event: { name: "reject_deploy" } },
      },
      { id: "aud", component: "AudioPlayer", url: "https://media.botkins.app/brief.mp3", description: "Morning audio" },
      { id: "vid", component: "Video", url: "https://media.botkins.app/demo.mp4" },
      { id: "bad_vid", component: "Video", url: "data:video/mp4;base64,AAAA" },
    ],
    dataModel: {},
  };

  const screen = await mount(el(A2uiSurface, { chatId: "chat-1", surface: botkinsSurface, rich: true }));
  t.after(screen.unmount);

  const tree = screen.root.root;
  // Line chart renders react-native-svg Svg
  assert.equal(tree.findAllByType("Svg" as never).length, 1);
  // Safe https Video renders WebView with mediaPlaybackRequiresUserAction (no autoplay with sound); data:video does NOT render a WebView
  const webviews = tree.findAllByType("WebView" as never);
  assert.equal(webviews.length, 1);
  assert.equal(webviews[0].props.mediaPlaybackRequiresUserAction, true);

  // Audio play button plays via expo-audio
  const playBtn = tree.findAllByType("Button" as never).find((b) => b.props.title === "Play");
  assert.ok(playBtn, "Play button should appear for https audio");
  await act(async () => {
    playBtn!.props.onPress();
  });
  assert.deepEqual(calls.audioPlays, ["https://media.botkins.app/brief.mp3"]);

  // ApprovalCard Approve button triggers chatA2uiAction
  const approveBtn = tree.findAllByType("Button" as never).find((b) => b.props.title === "Approve");
  assert.ok(approveBtn);
  await act(async () => {
    await approveBtn!.props.onPress();
  });
  assert.equal(calls.actions.length, 1);
  assert.equal((calls.actions[0][1] as any).name, "approve_deploy");

  // Unknown catalog falls back to plain-text + action buttons without crashing
  const unknownSurface: A2uiSurfaceData = {
    surfaceId: "mobile-unk-1",
    version: "1.0",
    catalogId: "https://example.com/unknown/v1.json",
    components: [
      { id: "root", component: "Column", "@catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json", children: ["u", "btn"] },
      { id: "u", component: "HoloDeck", title: "Spatial view" },
      { id: "btn", component: "Button", "@catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json", child: "btn_t", action: { event: { name: "continue" } } },
      { id: "btn_t", component: "Text", "@catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json", text: "Continue" },
    ],
    dataModel: {},
  };
  const sUnk = await mount(el(A2uiSurface, { chatId: "chat-1", surface: unknownSurface, rich: true }));
  t.after(sUnk.unmount);
  const contBtn = sUnk.root.root.findAllByType("Button" as never).find((b) => b.props.title === "Continue");
  assert.ok(contBtn, "Fallback action button must render for unknown catalog");
});

test("Mobile A2uiSurface dispatches callAgentFunction and responds to pendingRendererCalls", async (t) => {
  const calls = makeCalls();
  const { A2uiSurface } = loadSurface(calls);

  const fnSurface: A2uiSurfaceData = {
    surfaceId: "mobile-fn-1",
    version: "1.0",
    catalogId: "https://botkins.app/a2ui/catalog/v1.json",
    pendingRendererCalls: [
      {
        surfaceId: "mobile-fn-1",
        functionCallId: "rcall-m-1",
        callFunction: { "@call": "getThemeMode", catalogId: "https://botkins.app/a2ui/catalog/v1.json" },
      },
    ],
    components: [
      { id: "root", component: "Column", children: ["btn"] },
      {
        id: "btn",
        component: "Button",
        child: "btn_t",
        variant: "primary",
        action: {
          functionCall: {
            "@call": "computeSummary",
            catalogId: "https://botkins.app/a2ui/catalog/v1.json",
            args: { topic: "release" },
          },
        },
      },
      { id: "btn_t", component: "Text", text: "Compute Summary" },
    ],
    dataModel: {},
  };

  const screen = await mount(el(A2uiSurface, { chatId: "chat-1", surface: fnSurface, rich: true }));
  t.after(screen.unmount);

  // Wait a microtask for pendingRendererCalls effect
  await act(async () => {
    await new Promise((r) => setTimeout(r, 15));
  });
  assert.ok(
    calls.functions.some((c) => (c[1] as any)?.kind === "rendererFunctionResponse" && (c[1] as any)?.response?.value === "dark"),
    "Renderer should auto-respond to pending getThemeMode call with 'dark'",
  );

  const btn = screen.root.root.findAllByType("Button" as never).find((b) => b.props.title === "Compute Summary");
  assert.ok(btn);
  await act(async () => {
    await btn!.props.onPress();
  });
  assert.ok(
    calls.functions.some((c) => (c[1] as any)?.kind === "callAgentFunction" && (c[1] as any)?.callFunction?.["@call"] === "computeSummary"),
    "Pressing functionCall button should invoke callAgentFunction over Link",
  );
});
