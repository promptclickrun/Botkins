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
  openedLinks: string[];
  openedChats: string[];
};

function loadSurface(calls: Calls) {
  const iconStubs = new Proxy(
    {},
    {
      get: (_t, prop) => String(prop),
    },
  );
  return phoneModule("../src/features/chat/A2uiSurface", {
    "lucide-react-native": iconStubs,
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
    },
    "@/ui/LinkHold": {
      openLink: (url: string) => calls.openedLinks.push(url),
    },
    "@/ui": {
      Badge: "Badge",
      Button: "Button",
      T: "T",
      Tap: "Tap",
      radius: { sm: 8, lg: 14 },
      space: { xs: 4, sm: 8, md: 12, lg: 16 },
      useTheme: () => ({
        colors: {
          ink: "#ffffff",
          surface: "#1a1a1a",
          sunken: "#111111",
          line: "#333333",
          accent: "#3b82f6",
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
  const calls: Calls = { actions: [], openedLinks: [], openedChats: [] };
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
  const calls: Calls = { actions: [], openedLinks: [], openedChats: [] };
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
  const calls: Calls = { actions: [], openedLinks: [], openedChats: [] };
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
