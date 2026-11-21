// Spaces in the window ("spaces-v1"), in an isolated data folder. No model runs. The computer's
// side of Spaces is not built yet, so stand-ins in the main process answer for it: `snapshot` gains
// `spaces` and the team's people, `spaces.read` answers a space's content, and every other spaces
// call is recorded and answered as the contract says. Changes reach the window as the app sends
// them, on "changed". Set SPACES_SHOTS to a folder for pictures at 1040 px wide: a space in light,
// its Share popover in dark, a panel pulled by its corner, and a project's "Spaces and panels" with
// Attach open. Names are invented.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { signedInAs, skipWelcome } from "./welcome-helper.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-spaces-"));
const shots = process.env.SPACES_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const env = { ...process.env, BOTKINS_DATA_DIR: dir, COMMANDER_DATA_DIR: dir, BOTKINS_PROVIDERS: "copilot", COMMANDER_PROVIDERS: "copilot" };
delete env.ELECTRON_RUN_AS_NODE;
const binary = process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY;

const now = Date.now();
const MIN = 60_000;
const start = new Date(now);
start.setHours(0, 0, 0, 0);
// Last opened yesterday evening: what changed since is "since yesterday".
const seenAt = start.getTime() - 6 * 3600_000;

// ---- The workspace: three bots, a chat each, a project, and two app pages for panels.
const bots = [
  ["luna", "Luna", "Plans launches", "luna"],
  ["pip", "Pip", "Watches the numbers", "pip"],
  ["morel", "Morel", "Reviews code", "morel"],
].map(([id, name, role, head]) => ({ id, name, role, instructions: "You are " + name + ".", face: "idle", look: { head, palette: "original" } }));
const chats = bots.map((b, i) => ({
  id: "chat-" + b.id,
  botId: b.id,
  title: "Launch notes",
  time: now - (i + 1) * 30 * MIN,
  established: false,
  messages: [
    { role: "user", text: "How is the launch going?" },
    { role: "assistant", text: "On track." },
  ],
}));
const checklistFrame = "0f1d2c3b-4a59-4687-9a1b-2c3d4e5f6a7b";
const pricingFrame = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const page = (body) => `<!doctype html><style>body{margin:0;font:14px -apple-system,system-ui,sans-serif;color:CanvasText}
.bar{height:6px;border-radius:3px;background:color-mix(in srgb,CanvasText 10%,transparent);margin:0 0 12px}.bar i{display:block;height:100%;width:62%;border-radius:3px;background:CanvasText}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 28px}.row{display:flex;gap:10px;align-items:center}
.cb{width:20px;height:20px;border-radius:50%;border:1.5px solid color-mix(in srgb,CanvasText 30%,transparent);display:inline-block}.on .cb{background:CanvasText}.on span:last-child{text-decoration:line-through;opacity:.5}
.top{display:flex;justify-content:space-between;align-items:baseline}b{font-size:18px}input{width:100%}</style>${body}`;
const data = join(dir, "data");
mkdirSync(join(data, "frames"), { recursive: true });
writeFileSync(join(data, "frames", checklistFrame + ".html"), page(`<div class="top"><span></span><small>5 of 8 done</small></div><div class="bar"><i></i></div><div class="grid">
<div class="row on"><span class="cb"></span><span>Final copy review</span></div><div class="row"><span class="cb"></span><span>Pricing page live</span></div>
<div class="row on"><span class="cb"></span><span>Press kit</span></div><div class="row"><span class="cb"></span><span>Email the waitlist</span></div></div>`));
writeFileSync(join(data, "frames", pricingFrame + ".html"), page(`<div class="top"><span>Seats</span><b>$228 <small>a month</small></b></div><input type="range" min="1" max="30" value="12">`));
for (const id of [checklistFrame, pricingFrame]) writeFileSync(join(data, "frames", id + ".json"), "null");
writeFileSync(
  join(data, "workspace.json"),
  JSON.stringify({
    bots,
    chats,
    runs: [],
    projects: [{ id: "p_web", name: "Website relaunch", color: "blue", todos: [], lastUsed: now, createdAt: now }],
    // A single panel attached to the project, as the project page shows it under its spaces.
    panels: [
      { id: "p_speed", key: "page-speed", botId: "morel", chatId: "chat-morel", title: "Page speed", hidden: false, size: "small", revision: 1, updatedAt: now - 30 * MIN, routine: null, projectId: "p_web",
        blocks: [{ type: "metric", label: "Score", value: "94", note: "Up 6 since Monday" }] },
    ],
    frames: [
      { id: checklistFrame, owner: "panel:p_check", botId: "luna", createdAt: now },
      { id: pricingFrame, owner: "panel:p_price", botId: "pip", createdAt: now },
    ],
  }),
);

// ---- What the computer's side of Spaces would send: the owner's view of a small team's spaces.
const owner = { id: "owner", name: "Studio Mac" };
const maya = { id: "m_maya", name: "Maya Chen" };
const dev = { id: "m_dev", name: "Dev Patel" };
const summary = (id, name, over = {}) => ({
  id, name, by: owner, mine: true, access: "private", can: "own", count: 0, changed: 0, pinned: true, notify: "daily", here: [], rev: 1, updatedAt: now - 5 * MIN, ...over,
});
const spaces = [
  summary("s_today", "Today", { builtin: "today", access: "team", teamCan: "edit", count: 1 }),
  summary("s_feed", "Feed", { builtin: "feed", access: "team", teamCan: "edit", count: 2, changed: 2 }),
  summary("s_launch", "Launch", { projectId: "p_web", count: 5, changed: 2 }),
  summary("s_money", "Money", { count: 0 }),
  summary("s_ideas", "Ideas", { builtin: "ideas", access: "team", teamCan: "edit" }),
  summary("s_goals", "Goals", { builtin: "goals", access: "team", teamCan: "edit" }),
  summary("s_reading", "Reading list", { pinned: false, count: 3, updatedAt: now - 26 * 3600_000 }),
  summary("s_trip", "Team offsite", { pinned: false, mine: false, by: maya, count: 2, notify: "off" }),
  // Shown to this person as view only, whatever the stand-in's owner could do: the window follows `can`.
  summary("s_maya_today", "Today", { builtin: "today", pinned: false, mine: false, by: maya, access: "team", teamCan: "view", can: "view", count: 1, notify: "off" }),
];
const panel = (id, botId, title, size, blocks, over = {}) => ({
  id, key: id, botId, chatId: "chat-" + botId, title, blocks, hidden: false, size, revision: 1, updatedAt: seenAt - 3600_000, routine: null, spaceId: "s_launch", ...over,
});
const tomorrowTen = start.getTime() + 34 * 3600_000;
const content = {
  s_launch: {
    id: "s_launch",
    rev: 1,
    seenAt,
    panels: [
      panel("p_signups", "pip", "Signups", "small", [{ type: "metric", label: "Today", value: "1,284", note: "Up 12% since yesterday" }], {
        updatedAt: now - 5 * MIN,
        routine: { cron: "0 10 * * *", timezone: "UTC", prompt: "Count the signups.", nextAt: tomorrowTen, enabled: true },
      }),
      panel("p_days", "luna", "Days to launch", "small", [{ type: "metric", label: "Launch day", value: "13", note: "Thursday, December 3" }]),
      panel("p_check", "luna", "Launch checklist", "wide", [{ type: "html", frame: checklistFrame, height: 110 }], {
        updatedAt: now - 2 * MIN,
        last: { by: "m_maya", name: "Maya Chen", label: "Ticked Press kit", at: now - 2 * MIN },
        notes: [
          { id: "n1", by: "m_maya", name: "Maya Chen", text: "Press kit is in the drive.", at: now - 3 * MIN },
          { id: "n2", by: "m_dev", name: "Dev Patel", text: "Thanks!", at: now - 2 * MIN },
        ],
      }),
      panel("p_price", "pip", "Pricing calculator", "small", [{ type: "html", frame: pricingFrame, height: 70 }]),
      panel("p_prs", "morel", "Open pull requests", "small", [{ type: "list", items: ["Pricing page copy #214", "Waitlist email template #209"] }]),
    ],
    cards: [],
  },
  s_feed: {
    id: "s_feed",
    rev: 1,
    seenAt,
    panels: [],
    cards: [
      { id: "c1", botId: "pip", kind: "feed", title: "Signups passed 1,000", body: "A good week.", status: "open", read: false, createdAt: now - 20 * MIN, updatedAt: now - 20 * MIN, spaceId: "s_feed" },
      { id: "c2", botId: "luna", kind: "feed", title: "Press kit is ready", body: "", status: "open", read: true, createdAt: now - 90 * MIN, updatedAt: now - 90 * MIN, spaceId: "s_feed" },
    ],
  },
  s_maya_today: {
    id: "s_maya_today",
    rev: 1,
    seenAt,
    panels: [panel("p_maya", "luna", "Maya's week", "small", [{ type: "list", items: ["Offsite venue", "Hiring plan"] }], { spaceId: "s_maya_today" })],
    cards: [],
  },
};

const errors = [];
let app, win;
const calls = () => app.evaluate(() => globalThis.__spaces.calls);
const callsOf = async (name) => (await calls()).filter((c) => c[0] === name).map((c) => c.slice(1));
const clearCalls = () => app.evaluate(() => void (globalThis.__spaces.calls = []));
/** Changes what the stand-in holds (`fn` runs in the main process, with globalThis.__spaces), then tells the window. */
const change = async (fn) => {
  await app.evaluate(fn);
  await app.evaluate(() => globalThis.__spaces.push());
};
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
const prefs = (patch) => win.evaluate((patch) => window.botkins.setPreferences(patch), patch);

try {
  app = await _electron.launch({ args: binary ? [] : ["."], executablePath: binary, env });
  win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(e.message));
  await signedInAs(app);
  // ---- The stand-ins.
  await app.evaluate(({ BrowserWindow, ipcMain }, fixture) => {
    const window = BrowserWindow.getAllWindows()[0];
    const t = (globalThis.__spaces = { ...fixture, calls: [], refuse: null });
    const real = ipcMain._invokeHandlers.get("snapshot");
    const team = (s) => {
      const own = s.team ?? {};
      return { name: "Studio", groups: [], members: [], invites: [], requests: [], ...own, roles: own.roles?.length ? own.roles : t.roles, people: t.people, linkSharing: t.linkSharing };
    };
    // The stand-in's spaces include two that members made, which a real computer sends the owner only with Admin mode on.
    const add = (s) => (s && typeof s === "object" ? { ...s, spaces: t.spaces, team: team(s), adminMode: true } : s);
    ipcMain.removeHandler("snapshot");
    ipcMain.handle("snapshot", async (e, ...args) => add(await real(e, ...args)));
    // The app's own pushes carry the spaces too.
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...args) => (channel === "changed" ? send(channel, add(args[0])) : send(channel, ...args));
    const event = () => ({ sender: window.webContents, senderFrame: { url: window.webContents.getURL() } });
    t.push = async () => window.webContents.send("changed", await real(event()));
    const find = (id) => t.spaces.find((s) => s.id === id);
    const bump = (s) => ((s.rev += 1), (s.updatedAt = Date.now()));
    const answers = {
      "spaces.read": (id) => {
        const s = find(id);
        if (!s) throw new Error("That space no longer exists.");
        return { ...(t.content[id] ?? { id, panels: [], cards: [] }), id, rev: s.rev, seenAt: t.content[id]?.seenAt ?? 0 };
      },
      "spaces.create": ({ name }) => {
        const id = "s_new" + t.spaces.length;
        t.spaces.push({ ...t.spaces.find((s) => s.id === "s_money"), id, name, count: 0, changed: 0, pinned: true, rev: 1 });
        return id;
      },
      "spaces.rename": (id, name) => void ((find(id).name = name), bump(find(id))),
      "spaces.remove": (id) => void (t.spaces = t.spaces.filter((s) => s.id !== id)),
      "spaces.newPanel": () => ({ chatId: "chat-luna" }),
      "spaces.ask": ({ botId }) => ({ chatId: "chat-" + botId }),
      "link.spaces.share": (id, input) => {
        const s = find(id);
        s.access = input.access;
        if (input.access === "members") s.people = input.grants.map((g) => ({ ...g, name: t.people.find((p) => p.id === g.id).name }));
        else delete s.people;
        if (input.teamCan) s.teamCan = input.teamCan;
        if (input.access === "link") s.link ??= "https://relay.example.invalid/s/AAAAAAAAAAAAAAAAAAAAAA#k=made-up";
        else delete s.link;
        bump(s);
        return input.access === "link" ? { link: s.link } : {};
      },
      "link.spaces.newLink": (id) => ({ link: (find(id).link = "https://relay.example.invalid/s/BBBBBBBBBBBBBBBBBBBBBB#k=made-up") }),
      "link.spaces.arrange": ({ order, pinned }) => {
        t.spaces = order.map((id) => ({ ...find(id), pinned: pinned.includes(id) }));
      },
      "link.spaces.notify": (id, mode) => void (find(id).notify = mode),
      // A panel leaves its space and goes in front of `before`, or to the end.
      "spaces.movePanel": (panelId, { spaceId, before }) => {
        const from = Object.values(t.content).find((c) => c.panels.some((p) => p.id === panelId));
        const panel = from.panels.find((p) => p.id === panelId);
        from.panels = from.panels.filter((p) => p !== panel);
        const to = (t.content[spaceId] ??= { id: spaceId, seenAt: 0, panels: [], cards: [] });
        const at = before ? to.panels.findIndex((p) => p.id === before) : -1;
        to.panels.splice(at < 0 ? to.panels.length : at, 0, { ...panel, spaceId });
        for (const id of new Set([from.id, spaceId])) {
          find(id).count = t.content[id].panels.length;
          bump(find(id));
        }
      },
      "spaces.note": (panelId, text) => {
        const c = Object.values(t.content).find((c) => c.panels.some((p) => p.id === panelId));
        const panel = c.panels.find((p) => p.id === panelId);
        const id = "n" + (t.notes = (t.notes ?? 2) + 1);
        panel.notes = [...(panel.notes ?? []), { id, by: "owner", name: "Studio Mac", text, at: Date.now() }];
        bump(find(c.id));
        return id;
      },
      "spaces.removeNote": (panelId, noteId) => {
        const c = Object.values(t.content).find((c) => c.panels.some((p) => p.id === panelId));
        const panel = c.panels.find((p) => p.id === panelId);
        panel.notes = panel.notes.filter((n) => n.id !== noteId);
        bump(find(c.id));
      },
      "spaces.setProject": (id, projectId) => {
        if (projectId) find(id).projectId = projectId;
        else delete find(id).projectId;
      },
      "link.team.setLinkSharing": (on) => void (t.linkSharing = on),
      // The computer's own call for a panel's size and order, for the panels the stand-in holds.
      changePanel: (panelId, action) => {
        const c = Object.values(t.content).find((c) => c.panels.some((p) => p.id === panelId));
        if (["small", "wide", "tall"].includes(action)) c.panels.find((p) => p.id === panelId).size = action;
        bump(find(c.id));
      },
    };
    const names = ["changePanel", "spaces.read", "spaces.create", "spaces.rename", "spaces.remove", "spaces.setProject", "spaces.setPanelProject", "spaces.newPanel", "spaces.ask", "spaces.movePanel", "spaces.patchState", "spaces.note", "spaces.removeNote", "link.spaces.share", "link.spaces.newLink", "link.spaces.arrange", "link.spaces.seen", "link.spaces.notify", "link.spaces.here", "link.team.setLinkSharing"];
    for (const name of names) {
      ipcMain.removeHandler(name);
      ipcMain.handle(name, async (_e, ...args) => {
        t.calls.push([name, ...JSON.parse(JSON.stringify(args))]);
        if (t.refuse?.name === name) {
          const message = t.refuse.message;
          t.refuse = null;
          throw new Error(message);
        }
        const answer = answers[name]?.(...args);
        if (name !== "spaces.read") await t.push();
        return answer;
      });
    }
    // This computer's name, and the clipboard left alone.
    for (const name of ["phoneLink", "copyText"]) ipcMain.removeHandler(name);
    ipcMain.handle("phoneLink", () => ({ enabled: false, listening: false, port: 0, name: "Studio Mac", addresses: [], devices: [], pairing: null }));
    ipcMain.handle("copyText", (_e, text) => void t.calls.push(["copyText", text]));
  }, { spaces, content, people: [owner, maya, dev], linkSharing: false, roles: [{ id: "r_member", name: "Member", perms: { agents: ["view", "chat"], today: ["view", "use"], skills: [], mcp: [], plugins: [], settings: [] }, bots: "all" }] });
  await win.reload();
  win = await skipWelcome(win);
  await size(1040, 720);
  // The side menu open, as in the mockups (the usual menu is icons only; collapsed is checked below).
  await prefs({ appearance: { theme: "light" }, sidebar: { collapsed: false } });
  await win.locator('html[data-mode="light"]').waitFor();
  await win.locator(".shell:not(.collapsed)").waitFor();

  // ---- The side menu: Spaces under their heading, and no Today place.
  const places = win.getByRole("navigation", { name: "Workspace" });
  const menu = win.getByRole("navigation", { name: "Spaces" });
  await menu.waitFor();
  await expect(win.locator("aside .sidebarlabel .nav-label").first()).toHaveText("Spaces");
  await expect(menu.getByRole("button")).toHaveText(["Today", "Feed", "Launch", "Money", "Ideas", "Goals", "All spaces"]);
  await expect(places.getByRole("button", { name: "Today", exact: true })).toHaveCount(0);
  await expect(places.getByRole("button", { name: "Home", exact: true })).toHaveCount(1);
  const dot = (name) => menu.getByRole("button", { name, exact: true }).locator("i");
  await expect(dot("Feed")).toHaveCount(1);
  await expect(dot("Launch")).toHaveCount(1);
  await expect(dot("Money")).toHaveCount(0);
  console.log("The side menu shows Spaces with their dots, and Today left the places.");

  // ---- Launch: its header, the changed line, five panels, the App badges and the last line.
  await menu.getByRole("button", { name: "Launch", exact: true }).click();
  const head = win.locator(".space-head");
  await expect(head.getByRole("heading", { level: 1 })).toHaveText("Launch");
  await expect(head.locator(".space-tag").first()).toHaveText("Only you");
  await expect(head.getByRole("button", { name: "Website relaunch" })).toBeVisible();
  await expect(win.locator(".space-changed")).toHaveText("2 panels changed since yesterday");
  const panels = win.locator(".space-page .live-panel");
  await expect(panels).toHaveCount(5);
  await expect(win.locator(".space-page .space-app")).toHaveCount(2);
  await expect(panels.filter({ hasText: "Launch checklist" }).locator(".space-app")).toHaveText("App");
  await expect(win.locator(".space-page .space-dot")).toHaveCount(2);
  await expect(panels.filter({ hasText: "Launch checklist" }).locator(".space-last")).toHaveText("Maya ticked Press kit · 2m");
  await expect(panels.filter({ hasText: "Launch checklist" }).getByLabel("2 notes")).toHaveText("2");
  await expect(panels.filter({ hasText: "Signups" }).locator("footer")).toContainText("Updated 5m");
  await expect.poll(() => callsOf("link.spaces.seen")).toEqual([["s_launch"]]);
  await expect.poll(() => callsOf("link.spaces.here")).toContainEqual(["s_launch"]);
  assert.ok((await callsOf("spaces.read")).some(([id]) => id === "s_launch"));
  console.log("Launch shows its header, the changed line, five panels, two App badges and the last line.");
  if (shots) {
    await win.locator(".space-page iframe").first().waitFor();
    await win.waitForTimeout(500);
    await win.screenshot({ path: join(shots, "space-light.png") });
  }

  // ---- Pin and Unpin.
  await clearCalls();
  await head.getByRole("button", { name: "Unpin", exact: true }).click();
  await expect.poll(() => callsOf("link.spaces.arrange")).toEqual([
    [{ order: ["s_today", "s_feed", "s_money", "s_ideas", "s_goals", "s_launch", "s_reading", "s_trip", "s_maya_today"], pinned: ["s_today", "s_feed", "s_money", "s_ideas", "s_goals"] }],
  ]);
  await expect(menu.getByRole("button", { name: "Launch", exact: true })).toHaveCount(0);
  await head.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(menu.getByRole("button", { name: "Launch", exact: true })).toHaveCount(1);
  assert.deepEqual((await callsOf("link.spaces.arrange"))[1][0].pinned, ["s_today", "s_feed", "s_money", "s_ideas", "s_goals", "s_launch"]);
  console.log("Pin and Unpin set the person's pins.");

  // ---- Share: four choices; picking a member shares with them; a refusal is shown in its words.
  await clearCalls();
  await head.getByRole("button", { name: "Share", exact: true }).click();
  const share = win.getByRole("dialog", { name: "Who can open Launch" });
  await expect(share.getByRole("heading")).toHaveText("Who can open Launch");
  await expect(share.getByRole("radio")).toHaveCount(4);
  for (const name of ["Only you", "Members you pick", "All members", "Anyone with the link"]) await expect(share.getByRole("radio", { name, exact: true })).toBeVisible();
  await expect(share.getByRole("radio", { name: "Only you", exact: true })).toBeChecked();
  await expect(share.locator(".space-choice small")).toHaveText(["Private", "3 on Studio Mac", "View only"]);
  await share.getByRole("radio", { name: "Members you pick", exact: true }).check();
  await expect(share.getByRole("checkbox")).toHaveCount(2);
  assert.deepEqual(await callsOf("link.spaces.share"), [], "nothing is shared before someone is picked");
  await share.getByRole("checkbox", { name: "Maya Chen" }).check();
  await expect.poll(() => callsOf("link.spaces.share")).toEqual([["s_launch", { access: "members", grants: [{ id: "m_maya", can: "edit" }] }]]);
  await expect(head.locator(".space-tag").first()).toHaveText("Maya");
  await expect(share.getByText("1 picked", { exact: true })).toBeVisible();
  await expect(share.getByRole("combobox", { name: "What Maya Chen can do" })).toHaveValue("edit");
  await app.evaluate(() => void (globalThis.__spaces.refuse = { name: "link.spaces.share", message: "That person's role can't open spaces. Change their role in Team settings first." }));
  await share.getByRole("checkbox", { name: "Dev Patel" }).click();
  await expect(share.getByRole("alert")).toHaveText("That person's role can't open spaces. Change their role in Team settings first.");
  await expect(share.getByRole("checkbox", { name: "Dev Patel" })).not.toBeChecked();
  await expect(share.getByRole("radio", { name: "Members you pick", exact: true })).toBeChecked();
  console.log("Share offers four choices, shares with a picked member, and shows a refusal in its own words.");
  // A refusal of a level puts the old one back.
  await app.evaluate(() => void (globalThis.__spaces.refuse = { name: "link.spaces.share", message: "Turn on the relay on your computer to share by link." }));
  await share.getByRole("radio", { name: "Anyone with the link", exact: true }).click();
  const confirm = win.getByRole("dialog", { name: "Anyone with the link" });
  await expect(confirm).toContainText("Anyone with the link can see everything on this space. They can't change it.");
  await confirm.getByRole("button", { name: "Share", exact: true }).click();
  await expect(share.getByRole("alert")).toHaveText("Turn on the relay on your computer to share by link.");
  await expect(share.getByRole("radio", { name: "Members you pick", exact: true })).toBeChecked();
  // By link, after the question: Copy link and New link.
  await share.getByRole("radio", { name: "Anyone with the link", exact: true }).click();
  await win.getByRole("dialog", { name: "Anyone with the link" }).getByRole("button", { name: "Share", exact: true }).click();
  await expect(share.getByRole("button", { name: "Copy link", exact: true })).toBeVisible();
  await share.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect.poll(() => callsOf("copyText")).toEqual([["https://relay.example.invalid/s/AAAAAAAAAAAAAAAAAAAAAA#k=made-up"]]);
  await share.getByRole("button", { name: "New link", exact: true }).click();
  await expect.poll(() => callsOf("link.spaces.newLink")).toEqual([["s_launch"]]);
  await expect(head.locator(".space-tag").first()).toHaveText("Anyone with the link");
  // The relay went off: the level stays, the link is gone.
  await change(() => {
    delete globalThis.__spaces.spaces.find((s) => s.id === "s_launch").link;
  });
  await expect(share.getByText("Links are off while the relay is off.", { exact: true })).toBeVisible();
  await expect(share.getByRole("button", { name: "Copy link", exact: true })).toHaveCount(0);
  // All members: one choice for everyone.
  await share.getByRole("radio", { name: "All members", exact: true }).check();
  await expect.poll(async () => (await callsOf("link.spaces.share")).at(-1)).toEqual(["s_launch", { access: "team", teamCan: "edit" }]);
  await share.getByRole("combobox", { name: "What all members can do" }).selectOption("view");
  await expect.poll(async () => (await callsOf("link.spaces.share")).at(-1)).toEqual(["s_launch", { access: "team", teamCan: "view" }]);
  await share.getByRole("combobox", { name: "Notify me" }).selectOption("all");
  await expect.poll(() => callsOf("link.spaces.notify")).toEqual([["s_launch", "all"]]);
  await expect(share.getByRole("combobox", { name: "Notify me" }).locator("option")).toHaveText(["Off", "Once a day", "Every change"]);
  await share.getByRole("button", { name: "Done", exact: true }).click();
  await expect(share).toHaveCount(0);
  console.log("Share by link asks first, then offers Copy link and New link; All members and Notify me are sent.");

  // The picture of mock 2: shared with two members, both here now, in dark.
  if (shots) {
    await change(() => {
      const s = globalThis.__spaces.spaces.find((x) => x.id === "s_launch");
      s.access = "members";
      s.people = [
        { id: "m_maya", name: "Maya Chen", can: "edit" },
        { id: "m_dev", name: "Dev Patel", can: "view" },
      ];
      s.here = [
        { id: "m_maya", name: "Maya Chen" },
        { id: "m_dev", name: "Dev Patel" },
      ];
    });
    await prefs({ appearance: { theme: "dark" } });
    await win.locator('html[data-mode="dark"]').waitFor();
    await head.getByRole("button", { name: "Share", exact: true }).click();
    await expect(share.getByText("2 picked", { exact: true })).toBeVisible();
    await win.waitForTimeout(500);
    await win.screenshot({ path: join(shots, "space-share-dark.png") });
    await share.getByRole("button", { name: "Done", exact: true }).click();
    await prefs({ appearance: { theme: "light" } });
    await win.locator('html[data-mode="light"]').waitFor();
  }

  // ---- The ask bar starts a chat about the space and opens it.
  await clearCalls();
  const askBox = win.getByRole("textbox", { name: "Ask about this space, or describe a new panel" });
  await askBox.fill("What is left before launch?");
  await askBox.press("Enter");
  await expect.poll(() => callsOf("spaces.ask")).toEqual([[{ spaceId: "s_launch", botId: "pip", text: "What is left before launch?" }]]);
  await expect(win.locator(".chathead h2")).toHaveText("Pip");
  await expect.poll(() => callsOf("link.spaces.here")).toContainEqual([null]);
  console.log("The ask bar asks the first panel's bot and opens its chat; leaving the space says so.");

  // ---- An app panel opens large, with "Ask <bot> to change it" under it; a panel that is not an app has no Open.
  await menu.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(win.getByRole("button", { name: "Open Signups" })).toHaveCount(0);
  await win.getByRole("button", { name: "Open Launch checklist" }).click();
  const openedPanel = win.getByRole("dialog", { name: "Launch checklist" });
  await expect(openedPanel.getByRole("heading", { name: "Launch checklist" })).toBeVisible();
  await expect(openedPanel.locator(".space-app")).toHaveText("App");
  await expect(openedPanel.locator(".html-frame")).not.toHaveClass(/loading/);
  if (shots) await win.screenshot({ path: join(shots, "space-panel-opened-light.png") });
  await clearCalls();
  const askLuna = openedPanel.getByRole("textbox", { name: "Ask Luna to change it" });
  await askLuna.fill("Add a row for the press release");
  await askLuna.press("Enter");
  await expect.poll(() => callsOf("spaces.ask")).toEqual([[{ spaceId: "s_launch", botId: "luna", text: "Add a row for the press release", panelId: "p_check" }]]);
  await expect(win.locator(".chathead h2")).toHaveText("Luna");
  console.log("An app panel opens large; asking there is about that panel and goes to its bot.");

  // ---- Add panel: the sheet "New panel".
  await menu.getByRole("button", { name: "Launch", exact: true }).click();
  await head.getByRole("button", { name: "Add panel", exact: true }).click();
  const sheet = win.getByRole("dialog", { name: "New panel" });
  await expect(sheet.getByRole("heading", { name: "New panel" })).toBeVisible();
  await expect(sheet.locator(".space-starts button")).toHaveText(["Checklist", "Tracker", "Chart", "Table", "Notes", "App"]);
  await sheet.getByLabel("What should it show?").fill("A countdown to launch day");
  await sheet.getByRole("combobox", { name: "Bot" }).selectOption({ label: "Luna" });
  await sheet.getByRole("button", { name: "Tracker", exact: true }).click();
  await sheet.getByRole("button", { name: "Checklist", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "Tracker", exact: true })).toHaveAttribute("aria-pressed", "false");
  await sheet.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => callsOf("spaces.newPanel")).toEqual([[{ spaceId: "s_launch", botId: "luna", prompt: "A countdown to launch day", start: "checklist" }]]);
  await expect(win.locator(".chathead h2")).toHaveText("Luna");
  console.log("Add panel opens New panel and makes one from a sentence, a bot and a start.");

  // ---- Arranging, with no edit mode. What the stand-in holds now is put back afterwards, so the
  // checks after this block see the spaces as they were.
  await app.evaluate(() => {
    const t = globalThis.__spaces;
    t.saved = structuredClone({ spaces: t.spaces, content: t.content });
  });
  const pinnedNow = ["s_today", "s_feed", "s_money", "s_ideas", "s_goals", "s_launch"];
  const restOrder = ["s_reading", "s_trip", "s_maya_today"];
  // Dragging a pinned space in the side menu: a line shows where it lands; dropping sends the new order.
  await clearCalls();
  const spaceRow = (name) => menu.getByRole("button", { name, exact: true });
  await spaceRow("Launch").dragTo(spaceRow("Feed"), { targetPosition: { x: 30, y: 3 } });
  await expect.poll(() => callsOf("link.spaces.arrange")).toEqual([
    [{ order: ["s_today", "s_launch", "s_feed", "s_money", "s_ideas", "s_goals", ...restOrder], pinned: ["s_today", "s_launch", "s_feed", "s_money", "s_ideas", "s_goals"] }],
  ]);
  await expect(menu.getByRole("button")).toHaveText(["Today", "Launch", "Feed", "Money", "Ideas", "Goals", "All spaces"]);
  // The line while dragging: shown on the row it lands next to, and gone after.
  const ideasBox = await spaceRow("Ideas").boundingBox();
  const goalsBox = await spaceRow("Goals").boundingBox();
  await win.mouse.move(ideasBox.x + 30, ideasBox.y + ideasBox.height / 2);
  await win.mouse.down();
  await win.mouse.move(goalsBox.x + 30, goalsBox.y + goalsBox.height - 3, { steps: 6 });
  await expect(spaceRow("Goals")).toHaveAttribute("data-drop", "after");
  await win.mouse.up();
  await expect.poll(async () => (await callsOf("link.spaces.arrange")).at(-1)?.[0].pinned).toEqual(["s_today", "s_launch", "s_feed", "s_money", "s_goals", "s_ideas"]);
  await expect(menu.locator("[data-drop]")).toHaveCount(0);
  // Move up and Move down, from the row's menu.
  await spaceRow("Launch").click({ button: "right" });
  await win.getByRole("menuitem", { name: "Move down", exact: true }).click();
  await expect.poll(async () => (await callsOf("link.spaces.arrange")).at(-1)?.[0].pinned).toEqual(["s_today", "s_feed", "s_launch", "s_money", "s_goals", "s_ideas"]);
  await spaceRow("Launch").click({ button: "right" });
  await win.getByRole("menuitem", { name: "Move up", exact: true }).click();
  await expect.poll(async () => (await callsOf("link.spaces.arrange")).at(-1)?.[0].pinned).toEqual(["s_today", "s_launch", "s_feed", "s_money", "s_goals", "s_ideas"]);
  await spaceRow("Today").click({ button: "right" });
  await expect(win.getByRole("menuitem", { name: "Move up", exact: true })).toBeDisabled();
  await win.keyboard.press("Escape");
  console.log("Spaces are dragged up and down the side menu with a line where they land; Move up and Move down work too.");

  // Dragging a panel by its header: the panel is the dashed slot where it lands, and dropping says in front of which.
  // Tall enough for every panel of Launch to be in view at once.
  await size(1040, 940);
  await spaceRow("Launch").click();
  await expect(panels).toHaveCount(5);
  await clearCalls();
  // By its title as text: a panel being dragged hides its content, so its heading is not a heading then.
  const card = (title) => panels.filter({ has: win.locator("h2", { hasText: new RegExp("^" + title + "$") }) });
  const titles = () => win.locator(".space-page .live-panel > h2").allTextContents();
  // The order the grid shows, by CSS order while dragging.
  const shownTitles = () =>
    win.evaluate(() =>
      [...document.querySelectorAll(".space-page .live-panel")]
        .map((el, i) => [Number(getComputedStyle(el).order) || 0, i, el.querySelector("h2").textContent])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1])
        .map((x) => x[2]),
    );
  // The custom views settle their heights first; then the boxes stay where they are measured.
  await expect(win.locator(".space-page iframe")).toHaveCount(2);
  await win.waitForTimeout(800);
  const grab = await card("Open pull requests").locator(".panel-top small").boundingBox();
  await win.mouse.move(grab.x + 4, grab.y + grab.height / 2);
  await win.mouse.down();
  const daysBox = await card("Days to launch").boundingBox();
  await win.mouse.move(daysBox.x + 24, daysBox.y + daysBox.height / 2, { steps: 8 });
  // A browser sends dragover while the pointer rests; the test sends one more after the slot moved under it.
  await win.mouse.move(daysBox.x + 28, daysBox.y + daysBox.height / 2, { steps: 2 });
  await expect(win.locator(".space-page .panel-slot")).toHaveCount(1);
  await expect(card("Open pull requests")).toHaveClass(/panel-slot/);
  assert.deepEqual(await shownTitles(), ["Signups", "Open pull requests", "Days to launch", "Launch checklist", "Pricing calculator"]);
  await win.mouse.up();
  await expect.poll(() => callsOf("spaces.movePanel")).toEqual([["p_prs", { spaceId: "s_launch", before: "p_days" }]]);
  await expect.poll(titles).toEqual(["Signups", "Open pull requests", "Days to launch", "Launch checklist", "Pricing calculator"]);
  await expect(win.locator(".space-page .panel-slot")).toHaveCount(0);
  // The header's buttons and the views inside a panel still take clicks.
  await card("Days to launch").getByRole("button", { name: "Manage Days to launch" }).click();
  await expect(win.locator("dialog[open]").getByRole("button", { name: /Earlier/ })).toBeVisible();
  await win.locator("dialog[open]").getByRole("button", { name: "Close dialog" }).click();
  console.log("A panel is dragged by its header to another slot; the dashed slot shows where, and movePanel names the panel after it.");

  // Pulling a corner: Small, Wide or Tall, the one it snaps to marked; letting go sets it.
  const days = card("Days to launch");
  await days.hover();
  const corner = days.getByRole("slider", { name: "Size of Days to launch" });
  await expect(corner).toHaveAttribute("aria-valuetext", "Small");
  const c = await corner.boundingBox();
  const gridBox = await win.locator(".space-page .panel-grid").boundingBox();
  await win.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await win.mouse.down();
  await win.mouse.move(gridBox.x + gridBox.width - 6, c.y + c.height / 2, { steps: 8 });
  await expect(days.locator(".panel-sizes span")).toHaveText(["Small", "Wide", "Tall"]);
  await expect(days.locator(".panel-sizes .on")).toHaveText("Wide");
  await expect(days).toHaveClass(/\bwide\b/);
  if (shots) {
    await win.waitForTimeout(300);
    await win.screenshot({ path: join(shots, "space-resize-light.png") });
  }
  await win.mouse.up();
  await expect.poll(() => callsOf("changePanel")).toEqual([["p_days", "wide"]]);
  await expect(days.locator(".panel-sizes")).toHaveCount(0);
  await expect(days).toHaveClass(/\bwide\b/);
  // With the keyboard: arrow keys on the focused corner.
  const signupsCorner = card("Signups").getByRole("slider", { name: "Size of Signups" });
  await signupsCorner.focus();
  await expect(signupsCorner).toBeVisible();
  await win.keyboard.press("ArrowRight");
  await expect.poll(async () => (await callsOf("changePanel")).at(-1)).toEqual(["p_signups", "wide"]);
  await expect(signupsCorner).toHaveAttribute("aria-valuetext", "Wide");
  await signupsCorner.focus();
  await win.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await callsOf("changePanel")).at(-1)).toEqual(["p_signups", "small"]);
  console.log("Pulling a corner snaps to Small, Wide or Tall and sets it on letting go; arrow keys do it too.");

  // Moving a panel to another space, from its ⋯; into a space shared by link, after the question.
  await clearCalls();
  await card("Pricing calculator").getByRole("button", { name: "Manage Pricing calculator" }).click();
  const manage = win.locator("dialog[open]");
  const where = manage.getByRole("combobox", { name: "Space" });
  await expect(where).toHaveValue("s_launch");
  await expect(where.locator("option")).not.toContainText(["Maya's Today"]);
  await where.selectOption({ label: "Money" });
  await expect.poll(() => callsOf("spaces.movePanel")).toEqual([["p_price", { spaceId: "s_money", before: null }]]);
  await expect(card("Pricing calculator")).toHaveCount(0);
  await change(() => void (globalThis.__spaces.spaces.find((s) => s.id === "s_reading").access = "link"));
  await card("Open pull requests").getByRole("button", { name: "Manage Open pull requests" }).click();
  await manage.getByRole("combobox", { name: "Space" }).selectOption({ label: "Reading list" });
  const linkQuestion = win.getByRole("dialog", { name: "Move to Reading list?" });
  await expect(linkQuestion).toContainText("Anyone with the link will see this panel.");
  await linkQuestion.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await callsOf("spaces.movePanel")).length, 1, "nothing moves before the question is answered");
  await manage.getByRole("combobox", { name: "Space" }).selectOption({ label: "Reading list" });
  await win.getByRole("dialog", { name: "Move to Reading list?" }).getByRole("button", { name: "Move", exact: true }).click();
  await expect.poll(async () => (await callsOf("spaces.movePanel")).at(-1)).toEqual(["p_prs", { spaceId: "s_reading", before: null }]);
  await expect(card("Open pull requests")).toHaveCount(0);
  console.log("A panel moves to another space from its ⋯, and into a link-shared one only after the question.");

  // New panel: the rows Space and Refresh.
  await clearCalls();
  await head.getByRole("button", { name: "Add panel", exact: true }).click();
  await expect(sheet.getByRole("combobox", { name: "Space" })).toHaveValue("s_launch");
  await sheet.getByLabel("What should it show?").fill("Signups by day");
  await sheet.getByRole("combobox", { name: "Bot" }).selectOption({ label: "Pip" });
  await sheet.getByRole("combobox", { name: "Space" }).selectOption({ label: "Money" });
  await expect(sheet.getByRole("combobox", { name: "Refresh" }).locator("option")).toHaveText(["Off", "On a schedule"]);
  await sheet.getByRole("combobox", { name: "Refresh" }).selectOption("on");
  await expect(sheet.getByRole("radiogroup", { name: "Repeats" })).toBeVisible();
  await sheet.getByLabel("Time zone").fill("UTC");
  await sheet.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => callsOf("spaces.newPanel")).toEqual([
    [{ spaceId: "s_money", botId: "pip", prompt: "Signups by day", refresh: { cron: "0 9 * * 1-5", timezone: "UTC" } }],
  ]);
  console.log("New panel sends the chosen space and a refresh schedule.");

  // Notes: the count opens them; a note is added and removed.
  await spaceRow("Launch").click();
  await clearCalls();
  await card("Launch checklist").getByRole("button", { name: "2 notes" }).click();
  const notes = win.getByRole("dialog", { name: "Launch checklist" });
  await expect(notes.getByRole("heading", { level: 2 })).toHaveText("Launch checklist");
  await expect(notes.getByRole("heading", { level: 3 })).toHaveText("Notes");
  const noteRows = notes.getByRole("list", { name: "Notes" }).getByRole("listitem");
  await expect(noteRows).toHaveCount(2);
  await expect(noteRows.first()).toContainText("Maya");
  await expect(noteRows.first()).toContainText("3m");
  await expect(noteRows.first()).toContainText("Press kit is in the drive.");
  // The owner removes any note.
  await expect(notes.getByRole("button", { name: /^Remove the note from / })).toHaveCount(2);
  await notes.getByRole("textbox", { name: "Write a note" }).fill("Booked the venue.");
  await notes.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => callsOf("spaces.note")).toEqual([["p_check", "Booked the venue."]]);
  await expect(noteRows).toHaveCount(3);
  await expect(noteRows.last()).toContainText("Booked the venue.");
  await expect(notes.getByRole("textbox", { name: "Write a note" })).toHaveValue("");
  await expect(notes.getByRole("textbox", { name: "Write a note" })).toHaveAttribute("maxlength", "2000");
  await notes.getByRole("button", { name: "Remove the note from Maya" }).click();
  await expect.poll(() => callsOf("spaces.removeNote")).toEqual([["p_check", "n1"]]);
  await expect(noteRows).toHaveCount(2);
  await notes.getByRole("button", { name: "Close dialog" }).click();
  await expect(card("Launch checklist").getByRole("button", { name: "2 notes" })).toBeVisible();
  // A panel with no notes gets its first from its ⋯.
  await card("Signups").getByRole("button", { name: "Manage Signups" }).click();
  await manage.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(win.getByRole("dialog", { name: "Signups" }).getByRole("textbox", { name: "Write a note" })).toBeVisible();
  await win.getByRole("dialog", { name: "Signups" }).getByRole("button", { name: "Close dialog" }).click();
  console.log("Notes list, add and remove, and open from a panel's ⋯.");

  // ---- A project's "Spaces and panels": the attached spaces as rows, then single panels; Attach.
  await change(() => {
    const t = globalThis.__spaces;
    const launch = t.spaces.find((s) => s.id === "s_launch");
    Object.assign(launch, { access: "members", count: 5, updatedAt: Date.now() - 5 * 60_000, people: [{ id: "m_maya", name: "Maya Chen", can: "edit" }, { id: "m_dev", name: "Dev Patel", can: "view" }] });
    Object.assign(t.spaces.find((s) => s.id === "s_reading"), { projectId: "p_web", access: "private" });
  });
  await places.getByRole("button", { name: "Work", exact: true }).click();
  await win.getByRole("tab", { name: "Projects", exact: true }).click();
  await win.getByRole("button", { name: /Website relaunch/ }).click();
  const projectMenu = win.getByRole("navigation", { name: "Project sections" });
  await expect(projectMenu.getByRole("button", { name: /panels/i })).toHaveText(/^Spaces and panels/);
  await projectMenu.getByRole("button", { name: /Spaces and panels/ }).click();
  const rows = win.locator(".project-space-list .space-row");
  await expect(rows.locator("strong")).toHaveText(["Launch", "Reading list"]);
  await expect(rows.first().locator("small")).toHaveText("5 panels · Maya and Dev · Updated 5m");
  await expect(rows.first().locator(".space-dot")).toHaveCount(1);
  await expect(win.locator(".project-spaces .panel-grid .live-panel h2")).toHaveText(["Page speed"]);
  const attach = win.getByRole("button", { name: "Attach", exact: true });
  await attach.click();
  const attachMenu = win.getByRole("menu", { name: "Attach" });
  await expect(attachMenu.getByRole("menuitem")).toHaveText(["New panel…", "New space…"]);
  await expect(attachMenu.getByText("Attach a space", { exact: true })).toBeVisible();
  await expect(attachMenu.getByRole("menuitemcheckbox")).toHaveText(["Launch", "Money", "Reading list"]);
  await expect(attachMenu.getByRole("menuitemcheckbox", { name: "Launch" })).toHaveAttribute("aria-checked", "true");
  await expect(attachMenu.getByRole("menuitemcheckbox", { name: "Money" })).toHaveAttribute("aria-checked", "false");
  if (shots) {
    await win.waitForTimeout(300);
    await win.screenshot({ path: join(shots, "project-attach-light.png") });
  }
  await clearCalls();
  await attachMenu.getByRole("menuitemcheckbox", { name: "Money" }).click();
  await expect.poll(() => callsOf("spaces.setProject")).toEqual([["s_money", "p_web"]]);
  await expect(attachMenu.getByRole("menuitemcheckbox", { name: "Money" })).toHaveAttribute("aria-checked", "true");
  await attachMenu.getByRole("menuitemcheckbox", { name: "Reading list" }).click();
  await expect.poll(async () => (await callsOf("spaces.setProject")).at(-1)).toEqual(["s_reading", null]);
  await expect(rows.locator("strong")).toHaveText(["Launch", "Money"]);
  await win.keyboard.press("Escape");
  await expect(attachMenu).toHaveCount(0);
  // New panel… opens the sheet for the owner's Today.
  await attach.click();
  await attachMenu.getByRole("menuitem", { name: "New panel…" }).click();
  await expect(sheet.getByRole("combobox", { name: "Space" })).toHaveValue("s_today");
  await sheet.getByRole("button", { name: "Close dialog" }).click();
  // New space… makes one, attaches it and opens it.
  await attach.click();
  await attachMenu.getByRole("menuitem", { name: "New space…" }).click();
  await win.getByRole("dialog", { name: "New space" }).getByLabel("Name").fill("Research");
  await win.getByRole("dialog", { name: "New space" }).getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => callsOf("spaces.create")).toEqual([[{ name: "Research" }]]);
  await expect.poll(async () => (await callsOf("spaces.setProject")).at(-1)).toEqual(["s_new9", "p_web"]);
  await expect(head.getByRole("heading", { level: 1 })).toHaveText("Research");
  await expect(head.getByRole("button", { name: "Website relaunch" })).toBeVisible();
  console.log("A project's Spaces and panels lists its spaces and panels; Attach ticks, unticks and makes new ones.");

  // ---- Team settings: the scope Today is shown as Spaces; the switch Members may share by link.
  await clearCalls();
  await win.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = win.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Team", exact: true }).click();
  const linkSwitch = settings.getByRole("switch", { name: "Members may share by link" });
  await expect(linkSwitch).not.toBeChecked();
  await linkSwitch.check();
  await expect.poll(() => callsOf("link.team.setLinkSharing")).toEqual([[true]]);
  await expect(linkSwitch).toBeChecked();
  await app.evaluate(() => void (globalThis.__spaces.refuse = { name: "link.team.setLinkSharing", message: "Turn on the relay on your computer to share by link." }));
  await linkSwitch.click();
  await expect(settings.getByRole("alert")).toHaveText("Turn on the relay on your computer to share by link.");
  await expect(linkSwitch).toBeChecked();
  await settings.getByRole("tab", { name: "Roles", exact: true }).click();
  await settings.getByRole("button", { name: "Edit", exact: true }).first().click();
  await expect(settings.locator(".team-scope strong")).toContainText(["Agents", "Spaces"]);
  await expect(settings.locator(".team-scope strong", { hasText: "Today" })).toHaveCount(0);
  await settings.getByRole("button", { name: "Close dialog" }).click();
  await expect(settings).toBeHidden();
  console.log("Team settings show Spaces for the scope Today, and the switch Members may share by link.");

  // Back as it was before this block.
  await change(() => {
    const t = globalThis.__spaces;
    const rev = Math.max(...t.spaces.map((s) => s.rev)) + 1;
    t.spaces = t.saved.spaces.map((s) => ({ ...s, rev }));
    t.content = t.saved.content;
  });
  await expect(menu.getByRole("button")).toHaveText(["Today", "Feed", "Money", "Ideas", "Goals", "Launch", "All spaces"]);
  await size(1040, 720);

  // ---- All spaces.
  await menu.getByRole("button", { name: "All spaces", exact: true }).click();
  await expect(win.getByRole("heading", { level: 1 })).toHaveText("All spaces");
  const section = (name) => win.getByRole("region", { name, exact: true });
  await expect(section("Pinned").locator(".space-row strong")).toHaveText(["Today", "Feed", "Money", "Ideas", "Goals", "Launch"]);
  await expect(section("More").locator(".space-row strong")).toHaveText(["Reading list"]);
  await expect(section("From members").locator(".space-row strong")).toHaveText(["Team offsite", "Maya's Today"]);
  await expect(section("More").locator(".space-row small")).toHaveText(["3 panels · Only you · Updated " + new Date(now - 26 * 3600_000).toLocaleDateString(undefined, { month: "short", day: "numeric" })]);
  await expect(section("Pinned").locator("li", { hasText: "Feed" }).locator(".space-dot")).toHaveCount(1);
  await clearCalls();
  await section("More").getByRole("button", { name: "Options for Reading list" }).click();
  await win.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect.poll(async () => (await callsOf("link.spaces.arrange"))[0]?.[0].pinned).toEqual(["s_today", "s_feed", "s_money", "s_ideas", "s_goals", "s_launch", "s_reading"]);
  await expect(menu.getByRole("button", { name: "Reading list", exact: true })).toHaveCount(1);
  console.log("All spaces lists Pinned, More and From members, and pins from a row's menu.");

  // ---- A space this person may only view: no Add panel, no Share, no ask bar, no panel actions.
  await section("From members").getByRole("button", { name: /^Maya's Today/ }).click();
  await expect(head.getByRole("heading", { level: 1 })).toHaveText("Maya's Today");
  await expect(head.locator(".space-tag").first()).toHaveText("All members");
  await expect(win.locator(".space-page .live-panel")).toHaveCount(1);
  await expect(head.getByRole("button", { name: "Add panel" })).toHaveCount(0);
  await expect(head.getByRole("button", { name: "Share" })).toHaveCount(0);
  await expect(head.getByRole("button", { name: "Options for Maya's Today" })).toHaveCount(0);
  await expect(win.getByRole("textbox", { name: "Ask about this space, or describe a new panel" })).toHaveCount(0);
  await expect(win.getByRole("button", { name: "Manage Maya's week" })).toHaveCount(0);
  await expect(win.getByRole("button", { name: "Refresh Maya's week" })).toHaveCount(0);
  await expect(win.locator(".space-page .panel-corner")).toHaveCount(0);
  await expect(win.locator('.space-page [draggable="true"]')).toHaveCount(0);
  console.log("A view-only space offers no Add panel, no Share, no ask bar, no panel actions and nothing to drag or pull.");

  // ---- Feed draws its cards as Today's board does.
  await menu.getByRole("button", { name: "Feed", exact: true }).click();
  await expect(win.locator(".space-page .board-panel .board-item")).toHaveCount(2);
  await expect(win.locator(".space-page .board-tabs")).toHaveCount(0);
  await expect(win.locator(".space-page .board-item strong").first()).toHaveText("Signups passed 1,000");
  console.log("Feed shows its cards.");

  // ---- A new space from the heading's +, then its menu: Rename and Delete space.
  await win.getByRole("button", { name: "New space…" }).click();
  const named = win.getByRole("dialog", { name: "New space" });
  await named.getByLabel("Name").fill("Offsite");
  await named.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => callsOf("spaces.create")).toEqual([[{ name: "Offsite" }]]);
  await expect(head.getByRole("heading", { level: 1 })).toHaveText("Offsite");
  await expect(menu.getByRole("button", { name: "Offsite", exact: true })).toHaveAttribute("aria-current", "page");
  await head.getByRole("button", { name: "Options for Offsite" }).click();
  await win.getByRole("menuitem", { name: "Rename" }).click();
  const rename = win.getByRole("dialog", { name: "Rename" });
  await rename.getByLabel("Name").fill("Offsite 2027");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(head.getByRole("heading", { level: 1 })).toHaveText("Offsite 2027");
  await menu.getByRole("button", { name: "Launch", exact: true }).click();
  await head.getByRole("button", { name: "Options for Launch" }).click();
  await win.getByRole("menuitem", { name: "Delete space" }).click();
  const remove = win.getByRole("dialog", { name: "Delete Launch and its 5 panels?" });
  await remove.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => callsOf("spaces.remove")).toEqual([["s_launch"]]);
  await expect(head.getByRole("heading", { level: 1 })).toHaveText("Today");
  await expect(menu.getByRole("button", { name: "Launch", exact: true })).toHaveCount(0);
  // A built-in space has no Rename or Delete.
  await expect(head.getByRole("button", { name: "Options for Today" })).toHaveCount(0);
  console.log("New space, Rename and Delete space work; a deleted space leads to the first pinned one.");

  // ---- Collapsed to icons, each space is its icon with its name for screen readers.
  await win.getByRole("button", { name: "Collapse side menu" }).click();
  await win.locator(".shell.collapsed").waitFor();
  await expect(menu.getByRole("button", { name: "Feed", exact: true })).toBeVisible();
  const box = await menu.getByRole("button", { name: "Feed", exact: true }).boundingBox();
  assert.ok(box && box.width <= 50, "a collapsed space is an icon button");
  await expect(menu.getByRole("button", { name: "All spaces", exact: true }).locator("svg")).toBeVisible();
  await menu.getByRole("button", { name: "Money", exact: true }).click();
  await expect(head.getByRole("heading", { level: 1 })).toHaveText("Money");
  await win.getByRole("button", { name: "Expand side menu" }).click();
  await win.locator(".shell:not(.collapsed)").waitFor();
  console.log("Collapsed, the spaces stay in the menu as icons.");

  // ---- Without Spaces, the side menu and Today are as before.
  await change(() => {
    globalThis.__spaces.spaces = undefined;
  });
  await expect(menu).toHaveCount(0);
  await expect(places.getByRole("button", { name: "Today", exact: true })).toHaveCount(1);
  await places.getByRole("button", { name: "Today", exact: true }).click();
  await expect(win.getByRole("heading", { level: 1 })).toHaveText("Today");
  console.log("Without Spaces, Today is a place and a page again.");

  assert.deepEqual(errors, []);
  console.log("Spaces smoke passed. No renderer exceptions.");
} finally {
  if (app) await app.close();
  rmSync(dir, { recursive: true, force: true });
}
