// The settings that belong to the app on the computer (src/features/settings/computer.ts), the tools
// and skills helpers, and the demo computer's side of each new control.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REMOTE_METHODS } from "../link-host/methods.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { liveTurnDisplay } from "../src/features/chat/liveDisplay";
import { clockToDate, dateToClock, desktopFonts, desktopFontShown, everyBotAllowed, grantSummary, isHexColor, isUsualOrder, megabytes, movePlace, PLACES, placeOrder, platformName, shareLine, tokens, usageDays, cachePercent } from "../src/features/settings/computer";
import { filterSkills, folderName, skillOrigin, skillsIn } from "../src/features/skills/shared";
import { importText, keyHeaderOf, listText } from "../src/features/tools/shared";
import type { SkillInfo, UsageReport } from "../src/link/types";

test("every call the new controls make is one a phone may make", () => {
  for (const name of ["setPreferences", "appInfo", "cacheInfo", "credentials", "importMcpServers", "removeSkillFolder", "connectProviderService", "finishProviderService", "cancelProviderService"]) assert.ok(REMOTE_METHODS.has(name), name);
  // The file dialogs stay on the computer (tests/computer-files.test.ts has the calls a phone makes in their place).
  for (const name of ["importMcpServerFile", "addSkillFolder", "revealSkill", "exportUsage", "copyText"]) assert.equal(REMOTE_METHODS.has(name), false, name);
});

test("the side menu's order is made whole, and a place moves one step at a time", () => {
  assert.deepEqual(placeOrder(undefined), [...PLACES]);
  assert.deepEqual(placeOrder(["Wiki", "Nope", "Home", "Wiki"]), ["Wiki", "Home", "Today", "Chats", "Work", "Market"]);
  const order = placeOrder();
  assert.deepEqual(movePlace(order, "Today", -1), ["Today", "Home", "Chats", "Work", "Wiki", "Market"]);
  assert.deepEqual(movePlace(order, "Market", 1), order);
  assert.deepEqual(movePlace(order, "Home", -1), order);
  assert.equal(isUsualOrder(order), true);
  assert.equal(isUsualOrder(movePlace(order, "Chats", 1)), false);
});

test("the computer's fonts are the desktop's, with Windows' own names and faces", () => {
  assert.deepEqual(
    desktopFonts("darwin").map((font) => font.name),
    ["San Francisco", "Botkins", "SF Rounded", "Avenir Next", "Georgia", "Lora", "SF Mono"],
  );
  assert.deepEqual(
    desktopFonts("win32").map((font) => font.name),
    ["Segoe UI", "Botkins", "Georgia", "Lora", "Cascadia Mono"],
  );
  assert.equal(desktopFontShown("rounded", "darwin"), "rounded");
  assert.equal(desktopFontShown("rounded", "win32"), "system");
  assert.equal(desktopFontShown(undefined, "darwin"), "system");
  assert.equal(isHexColor("#a1B2c3"), true);
  assert.equal(isHexColor("theme"), false);
});

test("quiet hours go to a picker and back as the computer saves them", () => {
  const date = clockToDate("22:05", new Date(2026, 10, 19, 9, 30));
  assert.equal(date.getHours(), 22);
  assert.equal(date.getMinutes(), 5);
  assert.equal(dateToClock(date), "22:05");
  assert.equal(dateToClock(new Date(2026, 10, 19, 7, 0)), "07:00");
  assert.equal(dateToClock(clockToDate("late")), "00:00");
});

test("access reads as the desktop says it", () => {
  const projects = [{ id: "p1" }, { id: "p2" }];
  assert.equal(everyBotAllowed(undefined), true);
  assert.equal(everyBotAllowed({ access: { allBots: false } }), false);
  assert.equal(grantSummary(true, {}, projects), "Every project");
  assert.equal(grantSummary(false, { access: { all: true, projects: [] } }, projects), "All projects");
  assert.equal(grantSummary(false, { access: { all: false, projects: ["p1", "gone"] } }, projects), "1 project");
  assert.equal(grantSummary(false, { access: { all: false, projects: ["p1", "p2"] } }, projects), "2 projects");
  assert.equal(grantSummary(false, {}, projects), "No projects");
});

test("about, storage and usage figures", () => {
  assert.equal(platformName("darwin"), "macOS");
  assert.equal(platformName("freebsd"), "freebsd");
  assert.equal(megabytes(48_340_992), "46.1 MB");
  assert.equal(tokens(950), "950");
  assert.equal(tokens(1_420_000), "1.4M");
  assert.equal(tokens(96_000), "96K");
  assert.equal(shareLine({ turns: 1, input: 1200, output: 80, cacheRead: 0, cost: 0, priced: 0 }), "1 turn · 1.2K in · 80 out");
  // A computer that counts the cache adds its hit rate; an older one leaves it out.
  assert.equal(shareLine({ turns: 2, input: 1200, output: 80, cacheRead: 9000, cacheWrite: 300, cost: 0, priced: 0, cacheHitRate: 0.857 }), "2 turns · 1.2K in · 80 out · 86% cached");
  assert.equal(shareLine({ turns: 2, input: 1200, output: 80, cacheRead: 0, cost: 0, priced: 0, cacheHitRate: null }), "2 turns · 1.2K in · 80 out");
  assert.equal(cachePercent(0.004), "<1%");
  assert.equal(cachePercent(0), "0%");
  assert.equal(cachePercent(undefined), "");

  const today = Date.UTC(2026, 10, 19);
  const totals = { cacheRead: 0, cost: 0, priced: 0 };
  const report: UsageReport = {
    days: 7,
    totals: { turns: 3, input: 30, output: 3, ...totals },
    byDay: [
      { date: "2026-11-19", turns: 2, input: 20, output: 2, ...totals },
      { date: "2026-11-17", turns: 1, input: 10, output: 1, ...totals },
    ],
    byModel: [],
    byBot: [],
  };
  const days = usageDays(report, 7, today);
  assert.equal(days.length, 7);
  assert.equal(days[6].time, today);
  assert.deepEqual(
    days.map((day) => day.input + day.output),
    [0, 0, 0, 0, 11, 0, 22],
  );
});

test("a key goes in Authorization or in a header that carries a key by its name", () => {
  assert.equal(keyHeaderOf(["Authorization", "X-Team"]), "Authorization");
  assert.equal(keyHeaderOf(["X-API-Key"]), "X-API-Key");
  assert.equal(keyHeaderOf(["X-API-Key", "X-Team"]), undefined);
  assert.equal(keyHeaderOf(["X-Team"]), undefined);
  assert.equal(listText(["a", "b", "c"]), "a, b and c");
  assert.equal(importText({ added: ["github"], skipped: [] }), "Added github.");
  assert.equal(importText({ added: [], skipped: ["a", "b"] }), "No servers added. Skipped a and b (servers with those names exist).");
});

test("skills show where they come from, and the filter finds by name, words or origin", () => {
  const folders = [{ id: "f1", path: "/Users/me/team-skills/" }];
  const skill = (name: string, origin: SkillInfo["origin"], folderId?: string): SkillInfo => ({ name, description: name + " helps", path: "/" + name, origin, enabled: true, ...(folderId && { folderId }) });
  const skills = [skill("weekly-review", "botkins"), skill("wiki", "built-in"), skill("standup", "folder", "f1"), skill("lost", "folder", "gone")];
  assert.equal(folderName("/Users/me/team-skills/"), "team-skills");
  assert.deepEqual(
    skills.map((item) => skillOrigin(item, folders)),
    ["Botkins", "Built in", "team-skills", "Linked folder"],
  );
  assert.deepEqual(
    filterSkills(skills, "team", folders).map((item) => item.name),
    ["standup"],
  );
  assert.deepEqual(
    filterSkills(skills, "Weekly review", folders).map((item) => item.name),
    ["weekly-review"],
  );
  assert.equal(filterSkills(skills, "  ", folders).length, 4);
  assert.equal(skillsIn(skills, "f1"), 1);
});

test("the demo computer keeps part of the side menu and Background, and can refuse startup", async () => {
  const backend = new MockBackend();
  await backend.call("setPreferences", [{ sidebar: { order: ["Wiki"] } }]);
  assert.deepEqual(backend.state.settings.sidebar, { order: ["Wiki", "Home", "Today", "Chats", "Work"], collapsed: true });
  await backend.call("setPreferences", [{ sidebar: { collapsed: false } }]);
  assert.equal(backend.state.settings.sidebar.collapsed, false);
  assert.equal(backend.state.settings.sidebar.order[0], "Wiki");

  await backend.call("setPreferences", [{ appearance: { colorTheme: "fern" } }]);
  assert.equal(backend.state.settings.appearance.themePicked, true);
  await backend.call("setPreferences", [{ appearance: { avatarAnimations: false } }]);
  assert.equal(backend.state.settings.appearance.avatarAnimations, false);
  await assert.rejects(backend.call("setPreferences", [{ appearance: { avatarAnimations: "no" } }]));
  await assert.rejects(backend.call("setPreferences", [{ appearance: { bubble: "red" } }]));

  const was = process.env.BOTKINS_DEV_STARTUP;
  process.env.BOTKINS_DEV_STARTUP = "refuse";
  try {
    await assert.rejects(backend.call("setPreferences", [{ background: { keepRunning: true, runAtStartup: true } }]));
    assert.equal(backend.state.settings.background.runAtStartup, false);
    await backend.call("setPreferences", [{ background: { keepRunning: false, runAtStartup: false } }]);
    assert.equal(backend.state.settings.background.keepRunning, false);
  } finally {
    if (was === undefined) delete process.env.BOTKINS_DEV_STARTUP;
    else process.env.BOTKINS_DEV_STARTUP = was;
  }
});

test("the demo computer imports servers, unlinks skill folders and finishes a sign-in with a code", async () => {
  const backend = new MockBackend({ speed: 0.01 });
  const result = await backend.call("importMcpServers", [JSON.stringify({ mcpServers: { linear: { url: "https://x" }, github: { command: "npx", args: ["-y", "server-github"] } } })]);
  assert.deepEqual(result, { added: ["github"], skipped: ["linear"] });
  assert.ok(backend.state.mcpServers.some((server: { name: string; type: string }) => server.name === "github" && server.type === "stdio"));
  await assert.rejects(backend.call("importMcpServers", ["not json"]));

  const before = await backend.call("skills", []);
  assert.equal(before.skills.length > 8, true);
  assert.equal(before.folders[0].skills, 5);
  await backend.call("removeSkillFolder", ["folder-team"]);
  const after = await backend.call("skills", []);
  assert.equal(after.folders.length, 0);
  assert.equal(after.skills.some((item: SkillInfo) => item.folderId === "folder-team"), false);

  backend.sleep = async () => {};
  const started = await backend.call("connectProviderService", ["opencode", "google", { method: "oauth" }]);
  assert.ok(started.code?.attempt);
  assert.deepEqual(await backend.call("finishProviderService", ["opencode", "google", started.code.attempt, "0000"]), { done: false });
  assert.deepEqual(await backend.call("finishProviderService", ["opencode", "google", started.code.attempt, "1234"]), { done: true });
  const services = await backend.call("providerServices", ["opencode"]);
  assert.equal(services.find((item: { id: string }) => item.id === "google").connected, true);
});

test("the demo computer keeps a tool's own OAuth client and working folder, never a secret", async () => {
  const backend = new MockBackend();
  const id = await backend.call("saveMcpServer", [{ name: "acme", type: "http", url: "https://acme.example/mcp", headers: {}, oauth: { clientId: "abc", scope: "read", clientSecret: "s3cret" } }]);
  const server = backend.state.mcpServers.find((item: { id: string }) => item.id === id);
  assert.equal(server.auth.clientId, "abc");
  assert.equal(server.auth.clientSecret, true);
  assert.equal(JSON.stringify(server).includes("s3cret"), false);
  await backend.call("saveMcpServer", [{ id, name: "acme", type: "http", url: "https://acme.example/mcp", headers: {}, oauth: { clientId: "abc", clientSecret: null } }]);
  assert.equal(backend.state.mcpServers.find((item: { id: string }) => item.id === id).auth.clientSecret, true);

  const local = await backend.call("saveMcpServer", [{ name: "files", type: "stdio", command: "npx", args: [], env: {}, cwd: "/Users/me/tools" }]);
  assert.equal(backend.state.mcpServers.find((item: { id: string }) => item.id === local).cwd, "/Users/me/tools");
});

test("thinking and interim updates are controlled independently on phone and computer", async () => {
  const sample = { stream: "Looking at your calendar…", thinking: "Check conflicts first", intent: "Checking calendar" };

  assert.deepEqual(
    liveTurnDisplay({ ...sample, thinkingMode: "hide", showUpdates: true }),
    { thinking: undefined, stream: "Looking at your calendar…", intent: "Checking calendar" },
  );
  assert.deepEqual(
    liveTurnDisplay({ ...sample, thinkingMode: "show", showUpdates: false }),
    { thinking: "Check conflicts first", stream: "", intent: undefined },
  );
  assert.deepEqual(
    liveTurnDisplay({ ...sample, thinkingMode: "folded", showUpdates: true }),
    { thinking: "Check conflicts first", stream: "Looking at your calendar…", intent: "Checking calendar" },
  );
  assert.deepEqual(
    liveTurnDisplay({ ...sample, thinkingMode: "hide", showUpdates: false }),
    { thinking: undefined, stream: "", intent: undefined },
  );

  const backend = new MockBackend();
  assert.equal(backend.state.settings.showThinking, true);
  assert.equal(backend.state.settings.showUpdates, true);
  await backend.call("setPreferences", [{ showUpdates: false }]);
  assert.equal(backend.state.settings.showThinking, true);
  assert.equal(backend.state.settings.showUpdates, false);
  await backend.call("setPreferences", [{ showThinking: false, showUpdates: true }]);
  assert.equal(backend.state.settings.showThinking, false);
  assert.equal(backend.state.settings.showUpdates, true);
  await assert.rejects(backend.call("setPreferences", [{ showUpdates: "no" }]));
});

test("the demo computer keeps Keep prompt cache longer on by default and takes only a boolean", async () => {
  const backend = new MockBackend();
  assert.equal(backend.state.settings.longPromptCache, true);
  await backend.call("setPreferences", [{ longPromptCache: false }]);
  assert.equal(backend.state.settings.longPromptCache, false);
  await assert.rejects(backend.call("setPreferences", [{ longPromptCache: "no" }]));
});
