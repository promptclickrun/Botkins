// WorkflowActionCard mounts with React Compiler enabled across open, rich-cards-off, dispatched, and dismissed states.
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as el } from "react";
import type { WorkflowActionCard as ActionCardData } from "../src/link/types";
import { mount, phoneModule } from "./render-phone";

type Calls = {
  cardActions: unknown[][];
  openedLinks: string[];
  openedChats: string[];
};

function loadCard(calls: Calls, you: { kind: "owner" } | { kind: "member"; memberId: string } = { kind: "owner" }) {
  return phoneModule("../src/features/chat/WorkflowActionCard", {
    "lucide-react-native": {
      AlertCircle: "AlertCircle",
      ArrowUpRight: "ArrowUpRight",
      CheckCircle2: "CheckCircle2",
      ChevronDown: "ChevronDown",
      ChevronRight: "ChevronRight",
      ExternalLink: "ExternalLink",
      Send: "Send",
      X: "X",
    },
    "react-native": {
      StyleSheet: { hairlineWidth: 1 },
      View: "View",
    },
    "@/state/hooks": {
      usePart: () => ({ you }),
    },
    "@/state/link": {
      chatCardAction: (...args: unknown[]) => {
        calls.cardActions.push(args);
        return Promise.resolve({ card: {}, dispatchedChatId: "chat-new" });
      },
    },
    "@/ui/LinkHold": {
      openLink: (url: string) => calls.openedLinks.push(url),
    },
    "@/ui": {
      Badge: "Badge",
      Blocks: "Blocks",
      Button: "Button",
      Markdown: "Markdown",
      T: "T",
      Tap: "Tap",
      radius: { sm: 8, lg: 14 },
      space: { xs: 4, sm: 8, md: 12, lg: 16 },
      useTheme: () => ({
        colors: {
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
    WorkflowActionCard: (props: {
      chatId: string;
      card: ActionCardData;
      rich: boolean;
      onOpenChat?: (chatId: string) => void;
    }) => ReturnType<typeof el>;
  };
}

function makeCard(overrides: Partial<ActionCardData> = {}): ActionCardData {
  return {
    id: "ac-1",
    title: "Botkins #336: Mobile parity for channel configuration",
    subtitle: "[promptclickrun/Botkins#336](https://github.com/promptclickrun/Botkins/issues/336)",
    needsYou: true,
    blocks: [
      { type: "badges", items: [{ label: "Priority: P1", tone: "warning" }, { label: "Feature", tone: "accent" }] },
      { type: "markdown", text: "Needs a quick decision on mobile step config layout." },
    ],
    link: { label: "View GitHub comment", url: "https://github.com/promptclickrun/Botkins/issues/336#issuecomment-1" },
    dispatch: {
      botId: "bot-alfie",
      botName: "Alfie",
      chatTitle: "Botkins #336: Mobile parity for channel configuration",
      prompt: "Work on #336",
    },
    state: "open",
    ...overrides,
  };
}

test("WorkflowActionCard renders needs-you badge, Dispatch/Dismiss buttons, and calls chatCardAction", async (t) => {
  const calls: Calls = { cardActions: [], openedLinks: [], openedChats: [] };
  const { WorkflowActionCard } = loadCard(calls);

  const screen = await mount(el(WorkflowActionCard, { chatId: "chat-1", card: makeCard(), rich: true }));
  t.after(screen.unmount);

  const tree = screen.root.root;
  const badges = tree.findAllByType("Badge" as never);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].props.label, "Needs your direction");
  assert.equal(badges[0].props.tone, "warning");

  // Rich mode renders Blocks + Markdown subtitle
  assert.equal(tree.findAllByType("Blocks" as never).length, 1);
  assert.equal(tree.findAllByType("Markdown" as never).length, 1);

  // Buttons: Dispatch to Alfie + Dismiss
  const buttons = tree.findAllByType("Button" as never);
  assert.deepEqual(
    buttons.map((b) => b.props.title),
    ["Dispatch to Alfie", "Dismiss"],
  );

  // Pressing Dispatch invokes chatCardAction("chat-1", "ac-1", "dispatch")
  await act(async () => {
    buttons[0].props.onPress();
  });
  assert.deepEqual(calls.cardActions[0], ["chat-1", "ac-1", "dispatch"]);

  // Pressing Dismiss invokes chatCardAction("chat-1", "ac-1", "dismiss")
  await act(async () => {
    buttons[1].props.onPress();
  });
  assert.deepEqual(calls.cardActions[1], ["chat-1", "ac-1", "dismiss"]);

  // Pressing link opens external URL
  const taps = tree.findAllByType("Tap" as never);
  taps[0].props.onPress();
  assert.deepEqual(calls.openedLinks, ["https://github.com/promptclickrun/Botkins/issues/336#issuecomment-1"]);
});

test("WorkflowActionCard with rich=false (rich cards off) still shows badge, summary, and Dispatch/Dismiss buttons", async (t) => {
  const calls: Calls = { cardActions: [], openedLinks: [], openedChats: [] };
  const { WorkflowActionCard } = loadCard(calls);

  const screen = await mount(
    el(WorkflowActionCard, { chatId: "chat-1", card: makeCard({ needsYou: false }), rich: false }),
  );
  t.after(screen.unmount);

  const tree = screen.root.root;
  const badges = tree.findAllByType("Badge" as never);
  assert.equal(badges[0].props.label, "No input needed");
  assert.equal(badges[0].props.tone, "success");

  // Does not render heavy Blocks/Markdown in rich-cards-off mode
  assert.equal(tree.findAllByType("Blocks" as never).length, 0);
  assert.equal(tree.findAllByType("Markdown" as never).length, 0);

  // Action buttons are still present
  const buttons = tree.findAllByType("Button" as never);
  assert.deepEqual(
    buttons.map((b) => b.props.title),
    ["Dispatch to Alfie", "Dismiss"],
  );
});

test("WorkflowActionCard shows Dispatched state with Open chat link and collapsed Dismissed state", async (t) => {
  const calls: Calls = { cardActions: [], openedLinks: [], openedChats: [] };
  const { WorkflowActionCard } = loadCard(calls);

  const openedViaProp: string[] = [];
  const dispatchedScreen = await mount(
    el(WorkflowActionCard, {
      chatId: "chat-1",
      card: makeCard({
        state: "dispatched",
        dispatchedChatId: "chat-spawned-42",
        dispatchedBotName: "Alfie",
      }),
      rich: true,
      onOpenChat: (id) => openedViaProp.push(id),
    }),
  );
  t.after(dispatchedScreen.unmount);

  const dTree = dispatchedScreen.root.root;
  const dBadges = dTree.findAllByType("Badge" as never);
  assert.ok(dBadges.some((b) => b.props.label === "Dispatched to Alfie"));
  const dButtons = dTree.findAllByType("Button" as never);
  assert.deepEqual(
    dButtons.map((b) => b.props.title),
    ["Open chat"],
  );
  dButtons[0].props.onPress();
  assert.deepEqual(openedViaProp, ["chat-spawned-42"]);

  // Dismissed state collapses details and hides action buttons until expanded
  const dismissedScreen = await mount(
    el(WorkflowActionCard, {
      chatId: "chat-1",
      card: makeCard({ state: "dismissed" }),
      rich: true,
    }),
  );
  t.after(dismissedScreen.unmount);

  const xTree = dismissedScreen.root.root;
  assert.equal(xTree.findAllByType("Button" as never).length, 0);
  assert.equal(xTree.findAllByType("Blocks" as never).length, 0);
  assert.equal(xTree.findAllByType("Badge" as never)[0].props.label, "Dismissed");

  // Expanding a dismissed card reveals its Blocks
  const toggle = xTree.findAllByType("Tap" as never)[0];
  await act(async () => {
    toggle.props.onPress();
  });
  assert.equal(xTree.findAllByType("Blocks" as never).length, 1);
});

test("WorkflowActionCard hides Dispatch/Dismiss buttons for non-owner team members", async (t) => {
  const calls: Calls = { cardActions: [], openedLinks: [], openedChats: [] };
  const { WorkflowActionCard } = loadCard(calls, { kind: "member", memberId: "m-2" });

  const screen = await mount(el(WorkflowActionCard, { chatId: "chat-1", card: makeCard(), rich: true }));
  t.after(screen.unmount);

  assert.equal(screen.root.root.findAllByType("Button" as never).length, 0);
});
