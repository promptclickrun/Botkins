// Mobile agent rail model, timeline deduplication, and React Native renderer tests:
// - incoming recipient rail card (teamwork, task handoff, remote dispatch)
// - outgoing sender rail card + task handoff card with folded reply
// - accessibility labels/roles/states (accessibilityRole, accessibilityLabel, accessibilityState.expanded)
// - chatTimeline emits agent-rail and omits duplicate ask_teammate / task_create steps
// - continuingKeys breaks person message grouping when an agent message arrives
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as el } from "react";
import {
  answerReceiptLabel,
  askRowSummary,
  buildIncomingRail,
  buildOutgoingRail,
  buildTaskHandoffGroup,
  buildTaskHandoffRail,
  formatCompactElapsed,
  groupAsks,
  groupRailAsks,
  isAgentMessage,
  isAnswerReceipt,
} from "../src/features/chat/agentRailModel";
import { finishedCrewLine, crewOf } from "../src/features/chat/activityStory";
import { formatFeedWork, isStepCoveredByRail } from "../src/features/chat/activityModel";
import { baseParts } from "../link-host/parts.mjs";
import { continuingKeys } from "../src/features/chat/chatSides";
import { islandLines } from "../src/features/chat/islandModel";
import { chatTimeline } from "../src/features/chat/turn";
import type { Bot, Message, Run } from "../src/link/types";
import { mount, phoneModule } from "./render-phone";

const T0 = 1_730_000_000_000;
const bots: Bot[] = [
  { id: "alfie", name: "Alfie", role: "Chief of staff", color: "#5f7161", accent: "#c7d4c8" },
  { id: "glory", name: "Glory", role: "Front-end", color: "#b66a4a", accent: "#e8cfc3" },
];
const botMap = new Map(bots.map((b) => [b.id, b]));

const mockTheme = {
  dark: false,
  colors: {
    canvas: "#f7f5f1",
    surface: "#ffffff",
    surfaceTint: "#f2efe9",
    line: "#e5e0d8",
    lineSoft: "#ede9e2",
    ink: "#1c1917",
    ink2: "#57534e",
    ink3: "#8a857e",
    muted: "#78716c",
    subtle: "#f2efe9",
    accent: "#b66a4a",
    accentSoft: "#f5e7e0",
    accentText: "#8f4b2f",
    info: "#4a6fa5",
    infoSoft: "#e6eef8",
    success: "#3d7a5a",
    successSoft: "#e4f2ea",
    warning: "#b07625",
    warningSoft: "#f8eedc",
    danger: "#b8473e",
    dangerSoft: "#f9e5e3",
  },
};

function makeIcons() {
  const mk = (name: string) => (props: Record<string, unknown>) => el(name, props);
  return {
    ArrowRight: mk("ArrowRight"),
    ArrowUpRight: mk("ArrowUpRight"),
    Bot: mk("BotIcon"),
    Check: mk("Check"),
    ChevronDown: mk("ChevronDown"),
    ChevronRight: mk("ChevronRight"),
    CircleAlert: mk("CircleAlert"),
    ClipboardList: mk("ClipboardList"),
    Globe: mk("Globe"),
    X: mk("X"),
  };
}

function loadMobileRail(extra: Record<string, unknown> = {}) {
  return phoneModule("../src/features/chat/AgentMessageRail", {
    "react-native": {
      View: "View",
      StyleSheet: { create: (s: unknown) => s },
    },
    "react-native-reanimated": {
      default: { View: "AnimatedView" },
      useAnimatedStyle: (fn: () => unknown) => fn(),
      useReducedMotion: () => true,
      useSharedValue: (v: unknown) => ({ value: v }),
      withRepeat: (v: unknown) => v,
      withSequence: (v: unknown) => v,
      withTiming: (v: unknown) => v,
    },
    "lucide-react-native": makeIcons(),
    "@/state/hooks": {
      useChats: () => [{ id: "chat-alfie", title: "Alfie", botId: "alfie", updated: T0 }],
      usePart: () => [],
    },
    "@/ui": {
      useTheme: () => mockTheme,
      useOnShow: () => true,
      radius: { sm: 8, md: 12, lg: 16, pill: 999 },
      space: { 1: 4, 2: 8, 3: 12, 4: 16 },
      T: "T",
      Tap: "Tap",
      BotAvatar: "BotAvatar",
      Markdown: "Markdown",
    },
    "./navigate": { openChat: () => {} },
    "./useElapsedClock": { useElapsedClock: () => T0 + 2000 },
    ...extra,
  });
}

test("mobile chatTimeline mixed run: hides correlated rail calls, keeps uncovered task_create and failed rows, and agrees with Link summary", () => {
  const run: Run = {
    id: "r1",
    chatId: "c1",
    title: "Ask Glory",
    time: T0,
    status: "Completed",
    steps: [
      { id: "s1", name: "read", label: "Read tokens.css", status: "Done", started: T0 + 100 },
      { id: "s2", name: "ask_teammate", label: "Ask Glory", status: "Done", started: T0 + 200 },
      { id: "s3", name: "task_create", label: "Delegate to Glory", status: "Done", started: T0 + 300 },
      { id: "s4", name: "task_create", label: "Personal reminder", status: "Done", started: T0 + 350 },
      { id: "s5", name: "task_create", label: "Failed task", status: "Failed", started: T0 + 400 },
    ],
    teamwork: [
      {
        id: "tw1",
        toolCallId: "s2",
        botId: "glory",
        message: "Audit light/dark rail tokens.",
        status: "answered",
        reply: "Tokens verified.",
        started: T0 + 200,
        finished: T0 + 900,
        from: { kind: "bot", botId: "alfie", name: "Alfie", chatId: "c1", via: "teamwork" },
      },
    ],
    taskHandoffs: [
      {
        id: "th1",
        taskId: "t1",
        toolCallId: "s3",
        botId: "glory",
        fromBotId: "alfie",
        title: "Ship rail cards",
        status: "working",
        chatId: "task-chat-1",
        started: T0 + 300,
        from: { kind: "bot", botId: "alfie", name: "Alfie", chatId: "c1", via: "task" },
      },
    ],
  };

  assert.equal(isStepCoveredByRail(run.steps![0], run), false);
  assert.equal(isStepCoveredByRail(run.steps![1], run), true);
  assert.equal(isStepCoveredByRail(run.steps![2], run), true);
  assert.equal(isStepCoveredByRail(run.steps![3], run), false, "uncovered task_create remains visible");
  assert.equal(isStepCoveredByRail(run.steps![4], run), false, "failed task_create remains visible");

  const lines = islandLines(run, { steps: true, thoughts: false });
  assert.deepEqual(lines.map((l) => l.key), ["s:s1", "s:s4", "s:s5"]);

  const items = chatTimeline({
    messages: [
      { role: "user", text: "Coordinate with Glory", runId: "r1", time: T0 },
      { role: "assistant", text: "Done — Glory checked tokens and picked up the task.", runId: "r1", time: T0 + 1000 },
    ],
    from: 0,
    runs: { r1: run },
    timeline: true,
    group: false,
    prefs: { steps: "show", thinking: "show", foldFinishedSteps: false },
  });

  const rails = items.filter((item) => item.kind === "agent-rail");
  assert.equal(rails.length, 1, "one agent-rail item emitted for the run");
  const workItems = items.filter((item) => item.kind === "work");
  assert.equal(workItems.length, 1);
  assert.deepEqual(
    workItems[0].steps.map((s) => s.id),
    ["s1", "s4", "s5"],
    "delegated calls appear once via rail card while uncovered & failed task_create steps remain visible",
  );

  // Phone activity model and Link summary agree on step count, kinds, and failure count.
  const phoneWork = formatFeedWork(run);
  const linkParts = baseParts({ runs: [run] }, {});
  assert.equal(phoneWork.stepCount, 3);
  assert.equal(phoneWork.failedCount, 1);
  assert.deepEqual(phoneWork.kinds, ["read", "tool"]);
  assert.equal(linkParts.runs[0].stepCount, phoneWork.stepCount);
  assert.equal(linkParts.runs[0].failedCount, phoneWork.failedCount);
  assert.deepEqual(linkParts.runs[0].stepKinds, phoneWork.kinds);
});

test("mobile legacy rail entries without toolCallId preserve unprovable or ambiguous rows and align with Link summary", () => {
  const legacyRun: Run = {
    id: "r-legacy",
    chatId: "c1",
    title: "Legacy run",
    time: T0,
    status: "Completed",
    steps: [
      { id: "s-matched", name: "task_create", label: "Delegated", status: "Done", started: T0 + 10, output: JSON.stringify({ id: "t-del", title: "Delegated" }) },
      { id: "s-self", name: "task_create", label: "Self", status: "Done", started: T0 + 20, output: JSON.stringify({ id: "t-self", title: "Self" }) },
      { id: "s-unprovable", name: "task_create", label: "Legacy no output", status: "Done", started: T0 + 30 },
      { id: "s-ask-exact", name: "ask_teammate", label: "Ask Glory", status: "Done", started: T0 + 40, input: JSON.stringify({ teammate: "Glory", message: "Exact ask" }) },
      { id: "s-ask-uniq", name: "ask_teammate", label: "Ask Scout", status: "Done", started: T0 + 50, input: JSON.stringify({ teammate: "Scout", message: "Unique legacy ask" }) },
      { id: "s-ask-dup-1", name: "ask_teammate", label: "Ask Glory", status: "Done", started: T0 + 60, input: JSON.stringify({ teammate: "Glory", message: "Same text" }) },
      { id: "s-ask-dup-2", name: "ask_teammate", label: "Ask Scout", status: "Done", started: T0 + 70, input: JSON.stringify({ teammate: "Scout", message: "Same text" }) },
    ],
    teamwork: [
      { id: "tw-exact", toolCallId: "s-ask-exact", botId: "glory", fromBotId: "alfie", message: "Exact ask", status: "answered", started: T0 + 40 },
      { id: "tw-uniq", botId: "scout", fromBotId: "alfie", message: "Unique legacy ask", status: "answered", started: T0 + 50 },
      { id: "tw-ambig", botId: "glory", fromBotId: "alfie", message: "Same text", status: "answered", started: T0 + 60 },
    ],
    taskHandoffs: [
      { id: "t-del", taskId: "t-del", botId: "glory", fromBotId: "alfie", title: "Delegated", status: "ready", started: T0 + 10 },
    ],
  };
  assert.equal(isStepCoveredByRail(legacyRun.steps![0], legacyRun), true);
  assert.equal(isStepCoveredByRail(legacyRun.steps![1], legacyRun), false);
  assert.equal(isStepCoveredByRail(legacyRun.steps![2], legacyRun), false);
  assert.equal(isStepCoveredByRail(legacyRun.steps![3], legacyRun), true);
  assert.equal(isStepCoveredByRail(legacyRun.steps![4], legacyRun), true);
  assert.equal(isStepCoveredByRail(legacyRun.steps![5], legacyRun), false, "ambiguous duplicate-text legacy ask 1 stays visible");
  assert.equal(isStepCoveredByRail(legacyRun.steps![6], legacyRun), false, "ambiguous duplicate-text legacy ask 2 stays visible");

  const lines = islandLines(legacyRun, { steps: true, thoughts: false });
  assert.deepEqual(lines.map((l) => l.key), ["s:s-self", "s:s-unprovable", "s:s-ask-dup-1", "s:s-ask-dup-2"]);

  const items = chatTimeline({
    messages: [
      { role: "user", text: "Mixed legacy run", runId: "r-legacy", time: T0 },
      { role: "assistant", text: "Done", runId: "r-legacy", time: T0 + 200 },
    ],
    from: 0,
    runs: { "r-legacy": legacyRun },
    timeline: true,
    group: false,
    prefs: { steps: "show", thinking: "show", foldFinishedSteps: false },
  });
  const workItems = items.filter((item) => item.kind === "work");
  assert.equal(workItems.length, 1);
  assert.deepEqual(workItems[0].steps.map((s) => s.id), ["s-self", "s-unprovable", "s-ask-dup-1", "s-ask-dup-2"]);

  const phoneWork = formatFeedWork(legacyRun);
  const linkParts = baseParts({ runs: [legacyRun] }, {});
  assert.equal(phoneWork.stepCount, 4);
  assert.equal(linkParts.runs[0].stepCount, 4);
  assert.equal(linkParts.runs[0].summary, phoneWork.summary);
});

test("continuingKeys does not merge an incoming agent message with an adjacent person bubble", () => {
  const msgs: Message[] = [
    { role: "user", text: "Person prompt", time: T0 },
    {
      role: "user",
      text: "Forwarded from Alfie",
      time: T0 + 1000,
      from: { kind: "bot", botId: "alfie", name: "Alfie", via: "teamwork" },
    },
    { role: "user", text: "Follow-up from person", time: T0 + 2000 },
  ];
  assert.equal(isAgentMessage(msgs[1]), true);
  const cont = continuingKeys(msgs, 0);
  assert.equal(cont.size, 0, "neither agent message nor following person message merges into prior bubble");
});

test("mobile IncomingAgentRail renders accessible rail card with source link and collapsible preview", async (t) => {
  const { IncomingAgentRail } = loadMobileRail();
  const longMessage: Message = {
    role: "user",
    text: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
    time: T0,
    from: { kind: "bot", botId: "alfie", name: "Alfie", chatId: "chat-alfie", via: "teamwork" },
  };
  const model = buildIncomingRail(longMessage, { bots, accessibleChatIds: new Set(["chat-alfie"]) });
  assert.ok(model);
  assert.equal(model.ariaLabel, "Message from Alfie");

  const screen = await mount(el(IncomingAgentRail, { message: longMessage, bots: botMap }));
  t.after(screen.unmount);

  const card = screen.root.root.find((n) => n.props?.accessibilityLabel === "Message from Alfie");
  assert.ok(card, "root container has accessibilityLabel 'Message from Alfie'");

  const sourceBtn = screen.root.root.find((n) => n.props?.accessibilityLabel === "Open chat with Alfie");
  assert.ok(sourceBtn, "source chat link is rendered for accessible source chat");

  const expandBtn = screen.root.root.find((n) => n.props?.accessibilityState?.expanded === false);
  assert.ok(expandBtn, "collapsible body starts folded with accessibilityState.expanded = false");
});

test("mobile AgentMessageRail renders outgoing ask and task handoff cards with folded reply & task link", async (t) => {
  const { AgentMessageRail } = loadMobileRail();
  const run: Run = {
    id: "r2",
    chatId: "c1",
    title: "Delegate",
    time: T0,
    status: "Completed",
    teamwork: [
      {
        id: "ask-1",
        botId: "glory",
        message: "Check contrast in dark mode.",
        status: "answered",
        reply: "All contrast ratios exceed 4.5:1.",
        started: T0,
        finished: T0 + 1500,
        from: { kind: "bot", botId: "alfie", name: "Alfie", chatId: "c1", via: "teamwork" },
      },
    ],
    taskHandoffs: [
      {
        id: "th-1",
        taskId: "t-9",
        botId: "glory",
        fromBotId: "alfie",
        title: "Polish mobile cards",
        status: "review",
        chatId: "task-chat-9",
        started: T0 + 200,
        from: { kind: "bot", botId: "alfie", name: "Alfie", chatId: "c1", via: "task" },
      },
    ],
  };

  const outModel = buildOutgoingRail(run.teamwork![0], bots);
  assert.equal(outModel.ariaLabel, "Message to Glory, Answered");
  const handoffModel = buildTaskHandoffRail(run.taskHandoffs![0], { bots });
  assert.equal(handoffModel.ariaLabel, "Task handed to Glory: Polish mobile cards, Ready for review");

  const screen = await mount(el(AgentMessageRail, { run, bots: botMap }));
  t.after(screen.unmount);

  const outgoingRow = screen.root.root.find(
    (n) => n.props?.accessibilityRole === "button" && n.props?.accessibilityLabel === "Message to Glory, Answered",
  );
  assert.ok(outgoingRow, "outgoing ask row rendered as expandable button with accessible label");
  assert.equal(outgoingRow.props?.accessibilityState?.expanded, false, "outgoing ask row starts folded");

  const handoffRow = screen.root.root.find(
    (n) =>
      n.props?.accessibilityRole === "button" &&
      n.props?.accessibilityLabel === "Task handed to Glory: Polish mobile cards, Ready for review",
  );
  assert.ok(handoffRow, "task handoff row rendered as expandable button with accessible label");
  assert.equal(handoffRow.props?.accessibilityState?.expanded, false, "task handoff row starts folded");
});

test("groupAsks groups consecutive teammate asks into one quiet card header and leaves node calls separate", () => {
  const extraBots: Bot[] = [
    ...bots,
    { id: "gordie", name: "Gordie", role: "Ops", color: "#4a6fa5", accent: "#d8e3f2" },
  ];
  const asks = [
    { id: "a1", botId: "alfie", message: "Check calendar", status: "answered" as const, reply: "Tuesday at 3pm is open.", started: T0, finished: T0 + 1200 },
    { id: "a2", botId: "gordie", message: "Check thermostat", status: "answered" as const, reply: "Set to 70F.", started: T0 + 100, finished: T0 + 2100 },
    { id: "a3", botId: "alfie", message: "Draft invite", status: "answered" as const, reply: "Draft ready.", started: T0 + 200, finished: T0 + 3400 },
    { id: "a4", botId: "gordie", message: "Verify lights are off", status: "working" as const, started: T0 + 300 },
  ];
  const grouped = groupAsks(asks, extraBots);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, "ask-group");
  if (grouped[0].kind !== "ask-group") return;
  assert.equal(grouped[0].header, "4 asks to Alfie and Gordie · 3 answered · 1 working");
  assert.equal(grouped[0].asks.length, 4);
  assert.equal(askRowSummary(buildOutgoingRail(grouped[0].asks[0], extraBots)), "Tuesday at 3pm is open.");
  assert.equal(askRowSummary(buildOutgoingRail(grouped[0].asks[3], extraBots)), "Verify lights are off");

  const handoffs = buildTaskHandoffGroup(
    [
      { id: "th1", taskId: "t1", botId: "glory", fromBotId: "alfie", title: "Ship cleanup", status: "working", started: T0 },
      { id: "th2", taskId: "t2", botId: "alfie", fromBotId: "glory", title: "Review PR", status: "done", started: T0 + 10 },
    ],
    { bots: extraBots },
  );
  assert.ok(handoffs);
  assert.equal(handoffs.header, "2 tasks to Glory and Alfie · 1 done · 1 working");
  assert.equal(formatCompactElapsed(2064_000), "34m");
});

test("isAnswerReceipt recognizes receipt marker and legacy receipt after a request, and excludes normal user messages", () => {
  assert.equal(isAnswerReceipt({ role: "user", text: "Allow once", receipt: true }), true);
  assert.equal(answerReceiptLabel({ role: "user", text: "Allow once", receipt: true }), "You answered · Allow once");
  assert.equal(answerReceiptLabel({ role: "user", text: "Answered", receipt: true }), "You answered");
  assert.equal(
    isAnswerReceipt(
      { role: "user", text: "Allow once" },
      { role: "assistant", text: "Run git push?", request: { id: "req1", title: "Approve" } },
    ),
    true,
  );
  assert.equal(
    isAnswerReceipt(
      { role: "user", text: "Allow once" },
      { role: "assistant", text: "Here is the summary." },
    ),
    false,
    "without receipt flag or preceding request, ordinary message stays a bubble",
  );
  const steer = { role: "user" as const, text: "Deny", steeredRunId: "r1" };
  const interim = { role: "assistant" as const, interim: true, runId: "r1" };
  assert.equal(isAnswerReceipt(steer, interim), false);
  assert.equal(isAnswerReceipt({ role: "assistant", text: "Answered", receipt: true }), false);

  // Answer receipts never merge with surrounding user bubbles.
  const cont = continuingKeys(
    [
      { role: "user", text: "First", time: T0 },
      { role: "user", text: "Allow once", receipt: true, time: T0 + 1000 },
      { role: "user", text: "Second", time: T0 + 2000 },
    ],
    0,
  );
  assert.equal(cont.size, 0);

  // finishedCrewLine formats helpers and commands cleanly.
  const crew = crewOf({
    id: "r-crew",
    chatId: "c1",
    title: "Crew",
    time: T0,
    status: "Completed",
    agents: [
      { id: "a1", label: "h1", status: "Done", started: T0, finished: T0 + 1000 },
      { id: "a2", label: "h2", status: "Done", started: T0, finished: T0 + 1000 },
    ],
    steps: [
      { id: "s1", name: "bash", label: "cmd", status: "Done", background: true, started: T0, finished: T0 + 1000 },
    ],
  });
  assert.ok(crew);
  assert.equal(finishedCrewLine(crew), "2 helpers finished · 1 command");
});

const nodeAsk = (id: string, status: "working" | "answered" | "failed", host = "Mac Studio") => ({
  id,
  botId: "node:system.run",
  fromBotId: "alfie",
  remote: { hostId: "mac", hostName: host, botName: "system.run" },
  message: "system.run: ls " + id,
  status,
  started: T0,
});

test("back-to-back node calls fold into one group; teammate asks and lone node calls stay as cards", async (t) => {
  const teammate = { id: "ask-g", botId: "glory", fromBotId: "alfie", message: "Review", status: "answered" as const, started: T0 };
  const items = groupRailAsks([nodeAsk("a", "answered"), nodeAsk("b", "failed"), nodeAsk("c", "working"), teammate, nodeAsk("d", "answered")]);
  assert.deepEqual(items.map((i) => i.kind), ["node-group", "ask", "ask"]);
  const group = items[0];
  assert.equal(group.kind, "node-group");
  if (group.kind !== "node-group") return;
  assert.equal(group.title, "3 node calls on Mac Studio");
  assert.equal(group.running, 1);
  assert.equal(group.failed, 1);
  assert.equal(group.live, true);
  assert.equal(group.summary, "system.run: ls c");
  assert.equal(group.statusTone, "danger");
  const spread = groupRailAsks([nodeAsk("x", "answered", "Mac"), nodeAsk("y", "answered", "VPS")]);
  assert.equal(spread[0].kind === "node-group" && spread[0].title, "2 node calls on 2 hosts");
  assert.equal(spread[0].kind === "node-group" && spread[0].summary, "All done");

  const { AgentMessageRail } = loadMobileRail();
  const run: Run = { id: "r9", chatId: "c1", title: "Node", time: T0, status: "Working", teamwork: Array.from({ length: 12 }, (_, i) => nodeAsk("n" + i, "answered")) };
  const screen = await mount(el(AgentMessageRail, { run, bots: botMap }));
  t.after(screen.unmount);
  const toggle = screen.root.root.find((n) => n.props?.accessibilityLabel === "12 node calls on Mac Studio, all done, expand");
  assert.ok(toggle, "one folded group card instead of 12 cards");
  assert.equal(screen.root.root.findAll((n) => n.props?.accessibilityLabel === "Message to system.run on Mac Studio, Answered" && n.props?.accessible).length, 0);
});
