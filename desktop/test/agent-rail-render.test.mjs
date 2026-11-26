// Desktop agent rail model & React SSR renderer tests:
// - incoming recipient rail card (teamwork, task handoff, remote host dispatch)
// - outgoing sender rail card (teamwork ask, remote ask, task handoff)
// - accessibility attributes (role/region, aria-label, aria-expanded, aria-controls)
// - no double rendering with activityModel / activityStory
import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

globalThis.window ??= { botkins: {} };
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
// Bundle the desktop TSX/TS modules once via esbuild inside desktop/test (so node_modules resolves)
// so node:test can SSR-render the real components.
const outFile = join(new URL(".", import.meta.url).pathname, `.agent-rail-bundle-${process.pid}.mjs`);
const srcDir = new URL("../src/", import.meta.url).pathname;
await build({
  stdin: {
    contents: [
      `export * from "./agentRailModel";`,
      `export * from "./activityModel";`,
      `export * from "./activityStory";`,
      `export * from "./AgentMessageRail";`,
    ].join("\n"),
    resolveDir: srcDir,
    loader: "ts",
  },
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom", "react-dom/server", "react/jsx-runtime"],
  plugins: [
    {
      name: "test-stubs",
      setup(b) {
        b.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
        b.onResolve({ filter: /^\.\/Avatar$/ }, () => ({ path: "Avatar", namespace: "test-avatar" }));
        b.onLoad({ filter: /.*/, namespace: "test-avatar" }, () => ({
          contents: `import React from "react";
export function BotAvatar(props) { return React.createElement("span", { className: "avatar-stub", "data-bot": props.bot?.id ?? "" }); }
export const activityLabel = () => "";
export const botActivity = () => "idle";
export const chatActivity = () => "idle";`,
          loader: "js",
        }));
        b.onResolve({ filter: /^\.\/RichText$/ }, () => ({ path: "RichText", namespace: "test-richtext" }));
        b.onLoad({ filter: /.*/, namespace: "test-richtext" }, () => ({
          contents: `import React from "react"; export function RichText(props) { return React.createElement("div", { className: "rich-text-stub" }, props.text); }`,
          loader: "js",
        }));
      },
    },
  ],
});
let mod;
try {
  mod = await import(pathToFileURL(outFile).href);
} finally {
  try { unlinkSync(outFile); } catch {}
}
const {
  buildIncomingRail,
  buildOutgoingRail,
  buildTaskHandoffRail,
  foldPreview,
  isAgentMessage,
  readableAgentBody,
  isStepCoveredByRail,
  storySteps,
  AgentMessageRail,
  IncomingAgentRail,
} = mod;
const bots = [
  { id: "alfie", name: "Alfie", role: "Chief of staff", color: "#5f7161", accent: "#c7d4c8" },
  { id: "glory", name: "Glory", role: "Front-end", color: "#b66a4a", accent: "#e8cfc3" },
];

test("buildIncomingRail strips internal task boilerplate and formats sender + source link", () => {
  const longDetails = [
    "Audit the chat rail card spacing across compact desktop and phone viewports.",
    "Verify light and dark theme contrast for the accent bar, metadata badges, and collapsible reply.",
    "Line 3 with extra detail",
    "Line 4 with extra detail",
    "Line 5 with extra detail",
  ].join("\n");
  const msg = {
    role: "user",
    text: `Work on this task from the person's task board.\n\nTask: Rail polish\n\nDetails:\n${longDetails}\n\nDo the work with your tools. Finish with a short summary.`,
    time: 1730000000000,
    from: { kind: "bot", botId: "alfie", name: "Alfie", chatId: "chat-alfie-1", via: "task" },
  };
  assert.equal(isAgentMessage(msg), true);
  assert.equal(isAgentMessage({ role: "user", text: "Hi from person" }), false);

  const model = buildIncomingRail(msg);
  assert.ok(model);
  assert.equal(model.senderName, "Alfie");
  assert.equal(model.viaLabel, "Task Board");
  assert.equal(model.sourceChatId, "chat-alfie-1");
  assert.equal(model.ariaLabel, "Message from Alfie");
  assert.equal(model.taskTitle, "Rail polish");
  assert.equal(model.body.includes("Work on this task"), false, "task boilerplate stripped");
  assert.equal(model.body.includes("Do the work with your tools"), false, "trailing task instructions stripped");
  assert.equal(model.collapsible, true, "5-line message folds by default");
  assert.ok(model.preview.length < model.body.length);
});

test("buildIncomingRail includes host attribution for remote dispatches", () => {
  const msg = {
    role: "user",
    text: "Check disk space on Mac Studio",
    from: { kind: "bot", botId: "alfie", name: "Alfie", hostId: "vps-1", hostName: "Alfie VPS", via: "remote" },
  };
  const model = buildIncomingRail(msg);
  assert.ok(model);
  assert.equal(model.hostLabel, "Alfie VPS");
  assert.equal(model.viaLabel, "Remote · Alfie VPS");
  assert.equal(model.ariaLabel, "Message from Alfie on Alfie VPS");
  assert.equal(model.collapsible, false);
});

test("buildOutgoingRail and buildTaskHandoffRail expose live status and folded reply", () => {
  const ask = {
    id: "ask-1",
    botId: "glory",
    message: "Please verify the light/dark tokens for rail cards.",
    status: "answered",
    reply: "Checked tokens.css: --surface, --ink, --accent and --accent-soft all resolve cleanly in light and dark modes.",
    started: 1000,
    finished: 3500,
    from: { kind: "bot", botId: "alfie", name: "Alfie", chatId: "c1", via: "teamwork" },
  };
  const out = buildOutgoingRail(ask, bots);
  assert.equal(out.targetName, "Glory");
  assert.equal(out.statusLabel, "Answered");
  assert.equal(out.statusTone, "success");
  assert.equal(out.ariaLabel, "Message to Glory, Answered");
  assert.equal(out.reply, ask.reply);

  const handoff = buildTaskHandoffRail(
    {
      id: "t1",
      taskId: "t1",
      botId: "glory",
      fromBotId: "alfie",
      title: "Build rail cards",
      details: "Desktop and mobile light/dark.",
      status: "working",
      chatId: "task-chat-1",
      started: 2000,
      from: { kind: "bot", botId: "alfie", name: "Alfie", chatId: "c1", via: "task" },
    },
    { bots },
  );
  assert.equal(handoff.targetName, "Glory");
  assert.equal(handoff.statusLabel, "Working");
  assert.equal(handoff.taskChatId, "task-chat-1");
  assert.equal(handoff.ariaLabel, "Task handed to Glory: Build rail cards, Working");
});

test("desktop IncomingAgentRail renders semantic rail card with a11y labels, source link, and expand button", () => {
  const longText = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6";
  const html = renderToStaticMarkup(
    React.createElement(IncomingAgentRail, {
      message: {
        role: "user",
        text: longText,
        time: Date.UTC(2026, 10, 25, 14, 30),
        from: { kind: "bot", botId: "alfie", name: "Alfie", chatId: "chat-alfie", via: "teamwork" },
      },
      bots,
      accessibleChatIds: new Set(["chat-alfie"]),
      openChat: () => {},
    }),
  );
  assert.match(html, /<article[^>]*aria-label="Message from Alfie"/);
  assert.match(html, /agent-rail-incoming/);
  assert.match(html, />from<\/span>/);
  assert.match(html, /Alfie/);
  assert.match(html, /Teamwork/);
  assert.match(html, /Source chat/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Show full message/);
  assert.equal(html.includes("user-bubble"), false, "never renders as a person bubble");
});

test("desktop AgentMessageRail renders sender teamwork asks and task handoff cards with reply toggle", () => {
  const html = renderToStaticMarkup(
    React.createElement(AgentMessageRail, {
      run: {
        id: "r1",
        chatId: "c1",
        title: "Turn",
        time: 1000,
        status: "Completed",
        teamwork: [
          {
            id: "a1",
            botId: "glory",
            message: "Audit the sidebar spacing.",
            status: "answered",
            reply: "Spacing matches #259 tokens.",
            started: 1000,
            finished: 2500,
            from: { kind: "bot", botId: "alfie", name: "Alfie", chatId: "c1", via: "teamwork" },
          },
        ],
        taskHandoffs: [
          {
            id: "t1",
            taskId: "t1",
            botId: "glory",
            fromBotId: "alfie",
            title: "Ship rail cards",
            status: "review",
            chatId: "task-chat-1",
            started: 1200,
            from: { kind: "bot", botId: "alfie", name: "Alfie", chatId: "c1", via: "task" },
          },
        ],
      },
      bots,
      openChat: () => {},
    }),
  );
  assert.match(html, /aria-label="Message to Glory, Answered"/);
  assert.match(html, /Reply from Glory/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="Task handed to Glory: Ship rail cards, Ready for review"/);
  assert.match(html, /Open task/);
});

test("no double rendering: storySteps omits ask_teammate and task_create steps covered by rail cards", () => {
  const run = {
    teamwork: [{ id: "tw1", botId: "glory", message: "Check", status: "answered", started: 10 }],
    taskHandoffs: [{ id: "th1", taskId: "t1", botId: "glory", fromBotId: "alfie", title: "Ship it", status: "ready", started: 20 }],
  };
  const steps = [
    { id: "s1", name: "read", label: "Read file", status: "Done", started: 5 },
    { id: "s2", name: "ask_teammate", label: "Ask Glory", status: "Done", started: 10 },
    { id: "s3", name: "task_create", label: "Create task", status: "Done", started: 20 },
    { id: "s4", name: "ask_teammate", label: "Ask failed", status: "Failed", started: 30 },
  ];
  assert.equal(isStepCoveredByRail(steps[1], run), true);
  assert.equal(isStepCoveredByRail(steps[2], run), true);
  assert.equal(isStepCoveredByRail(steps[3], run), false);

  const kept = storySteps(steps, run);
  assert.deepEqual(kept.map((s) => s.id), ["s1", "s4"]);
});

test("readableAgentBody and foldPreview handle empty/legacy text gracefully", () => {
  assert.deepEqual(readableAgentBody("Simple teammate question", "teamwork"), { body: "Simple teammate question" });
  const short = foldPreview("Short line");
  assert.equal(short.collapsible, false);
  assert.equal(short.preview, "Short line");
});
