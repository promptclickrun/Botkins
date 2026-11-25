// Opened space panel full-screen smoke: mounts the real OpenedPanel <dialog> in Electron with a
// sandboxed HTML app panel and a second panel. Verifies Escape hold/repeat restore without closing,
// single close invocation, forged iframe postMessage rejection, trusted main-process Cmd/Ctrl+Shift+F
// and Escape handling when focus is inside the iframe, and one-shot "Open full screen" menu behavior.
// Set PANEL_OPEN_SHOTS to a folder to save light and dark screenshots (normal + full screen).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { signedInAs, skipWelcome } from "./welcome-helper.mjs";

const shotsDir = process.env.PANEL_OPEN_SHOTS;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "botkins-panel-open-"));
const env = { ...process.env, BOTKINS_DATA_DIR: dir, BOTKINS_PROVIDERS: "copilot" };
delete env.ELECTRON_RUN_AS_NODE;

const now = Date.now();
const frameId = "9f8e7d6c-5b4a-4321-89ab-cdef01234567";
const frameId2 = "1a2b3c4d-5e6f-4321-89ab-cdef01234568";
const data = join(dir, "data");
mkdirSync(join(data, "frames"), { recursive: true });

const html = `<!doctype html>
<style>
  html, body { height: 100%; margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: var(--ink, CanvasText); }
  .app { min-height: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; padding: 16px; border: 1px solid var(--line, #ddd); border-radius: 12px; background: var(--paper, transparent); }
  .hero { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .hero h1 { margin: 0; font-size: 20px; }
  .pill { font-size: 12px; padding: 4px 10px; border-radius: 999px; background: var(--sunken, rgba(128,128,128,.14)); color: var(--muted, inherit); }
  .grid { flex: 1; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; align-content: stretch; }
  .card { padding: 14px; border-radius: 10px; border: 1px solid var(--line, #ddd); background: var(--surface, transparent); display: flex; flex-direction: column; justify-content: space-between; min-height: 140px; }
  .card h3 { margin: 0 0 6px; font-size: 14px; }
  .num { font-size: 28px; font-weight: 700; letter-spacing: -0.5px; }
  .sub { font-size: 12px; color: var(--muted, #666); }
  .foot { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--muted, #666); border-top: 1px solid var(--line, #ddd); padding-top: 10px; }
  button { font: inherit; padding: 5px 10px; border-radius: 8px; border: 1px solid var(--line, #ccc); background: var(--surface, transparent); color: inherit; cursor: pointer; }
</style>
<div class="app">
  <div class="hero">
    <h1>Q2 Launch Command Board</h1>
    <span class="pill" id="dims">Measuring…</span>
  </div>
  <div class="grid">
    <div class="card"><h3>Waitlist signups</h3><div class="num">4,820</div><div class="sub">+18% week over week</div></div>
    <div class="card"><h3>Beta conversion</h3><div class="num">31.4%</div><div class="sub">1,514 active workspaces</div></div>
    <div class="card"><h3>Checklist progress</h3><div class="num">14 / 16</div><div class="sub">2 items remaining before launch</div></div>
    <div class="card"><h3>API latency (p95)</h3><div class="num">118 ms</div><div class="sub">All regions green</div></div>
    <div class="card"><h3>Press kit</h3><div class="num">Ready</div><div class="sub">Reviewed by Luna &amp; Maya</div></div>
    <div class="card"><h3>Billing checks</h3><div class="num">Pass</div><div class="sub">Stripe live webhooks verified</div></div>
  </div>
  <div class="foot">
    <span>Interactive app panel</span>
    <button type="button" id="focus-inside">Focus inside app</button>
  </div>
</div>
<script>
  const el = document.getElementById("dims");
  const update = () => { el.textContent = "Viewport: " + window.innerWidth + " × " + window.innerHeight + " px"; };
  update();
  addEventListener("resize", update);
  window.__frameKeys = { escape: 0, toggle: 0 };
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.__frameKeys.escape++;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") window.__frameKeys.toggle++;
  });
</script>`;

writeFileSync(join(data, "frames", frameId + ".html"), html);
writeFileSync(join(data, "frames", frameId + ".json"), "null");
writeFileSync(
  join(data, "frames", frameId2 + ".html"),
  `<!doctype html><body style='font:14px system-ui;margin:16px'>All launch milestones are green. <button type="button" id="focus-other">Focus summary</button><script>window.__otherKeys={toggle:0};addEventListener("keydown",(e)=>{if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key.toLowerCase()==="f")window.__otherKeys.toggle++;});</script></body>`,
);
writeFileSync(join(data, "frames", frameId2 + ".json"), "null");

const bots = [
  { id: "luna", name: "Luna", role: "Plans launches", instructions: "You are Luna.", face: "idle", look: { head: "luna", palette: "original" } },
];
writeFileSync(
  join(data, "workspace.json"),
  JSON.stringify({
    bots,
    chats: [
      { id: "chat-luna", botId: "luna", title: "Launch notes", time: now - 30 * 60_000, established: false, messages: [{ role: "user", text: "Status?" }, { role: "assistant", text: "On track." }] },
    ],
    runs: [],
    projects: [],
    panels: [],
    frames: [
      { id: frameId, owner: "panel:p_board", botId: "luna", createdAt: now },
      { id: frameId2, owner: "panel:p_notes", botId: "luna", createdAt: now },
    ],
  }),
);

const owner = { id: "owner", name: "Studio Mac" };
const spaces = [
  { id: "s_launch", name: "Launch", by: owner, mine: true, access: "private", can: "own", count: 2, changed: 0, pinned: true, notify: "daily", here: [], rev: 1, updatedAt: now },
];
const content = {
  s_launch: {
    id: "s_launch",
    rev: 1,
    seenAt: now,
    panels: [
      {
        id: "p_board",
        spaceId: "s_launch",
        key: "launch-board",
        botId: "luna",
        chatId: "chat-luna",
        title: "Launch board",
        hidden: false,
        size: "wide",
        revision: 2,
        updatedAt: now - 60_000,
        routine: null,
        state: {},
        stateRev: 0,
        last: { by: "owner", name: "Studio Mac", label: "checked beta conversion", at: now - 60_000 },
        asks: ["Add a regional breakdown", "Highlight what is still blocking launch"],
        blocks: [{ type: "html", frame: frameId, height: 480, title: "Launch board" }],
      },
      {
        id: "p_notes",
        spaceId: "s_launch",
        key: "status-summary",
        botId: "luna",
        chatId: "chat-luna",
        title: "Status summary",
        hidden: false,
        size: "compact",
        revision: 1,
        updatedAt: now - 120_000,
        routine: null,
        state: {},
        stateRev: 0,
        last: null,
        asks: [],
        blocks: [{ type: "html", frame: frameId2, height: 220, title: "Status summary" }],
      },
    ],
    cards: [],
  },
};

const mod = process.platform === "darwin" ? "Meta" : "Control";
const errors = [];
let app;
try {
  app = await _electron.launch({ args: ["."], env });
  const win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(e.message));
  await signedInAs(app);
  await app.evaluate(({ BrowserWindow, ipcMain }, fixture) => {
    const w = BrowserWindow.getAllWindows()[0];
    const real = ipcMain._invokeHandlers.get("snapshot");
    const add = (s) => (s && typeof s === "object" ? { ...s, spaces: fixture.spaces, team: { name: "Studio", groups: [], members: [], invites: [], requests: [], roles: [], people: [fixture.owner], linkSharing: true }, adminMode: true } : s);
    ipcMain.removeHandler("snapshot");
    ipcMain.handle("snapshot", async (e, ...args) => add(await real(e, ...args)));
    const send = w.webContents.send.bind(w.webContents);
    w.webContents.send = (ch, ...args) => (ch === "changed" ? send(ch, add(args[0])) : send(ch, ...args));
    ipcMain.removeHandler("spaces.read");
    ipcMain.handle("spaces.read", async (_e, id) => fixture.content[id]);
    for (const ch of ["link.spaces.seen", "link.spaces.here"]) {
      ipcMain.removeHandler(ch);
      ipcMain.handle(ch, async () => null);
    }
  }, { spaces, content, owner });

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
  await skipWelcome(win);

  await win.locator("aside").getByRole("button", { name: /^Launch/ }).click();
  await expect(win.getByRole("button", { name: "Open Launch board" })).toBeVisible();

  const dialog = win.locator("dialog.space-opened");
  const storedFullscreen = () =>
    win.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.endsWith("panel.fullscreen")) return localStorage.getItem(k);
      }
      return null;
    });

  // 1. Open normally (light mode)
  await win.getByRole("button", { name: "Open Launch board" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveClass(/fullscreen/);
  const toggleBtn = dialog.getByRole("button", { name: "Full screen" });
  await expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
  await win.waitForTimeout(450);
  if (shotsDir) await win.screenshot({ path: join(shotsDir, "01-normal-light.png") });

  // 2. Toggle full screen explicitly via button (light mode) -> persists preference
  await toggleBtn.click();
  await expect(dialog).toHaveClass(/fullscreen/);
  await expect(dialog.getByRole("button", { name: "Exit full screen" })).toHaveAttribute("aria-pressed", "true");
  assert.equal(await storedFullscreen(), "1");
  await win.waitForTimeout(350);
  if (shotsDir) await win.screenshot({ path: join(shotsDir, "02-fullscreen-light.png") });

  // 3. Switch to dark mode in full screen
  await win.evaluate(() => window.botkins.setPreferences({ appearance: { theme: "dark" } }));
  await win.waitForTimeout(300);
  if (shotsDir) await win.screenshot({ path: join(shotsDir, "03-fullscreen-dark.png") });

  // 4. Hold Escape in full screen (initial + auto-repeat keydown) -> restores without closing
  await win.evaluate(() => {
    window.__dialogCloseEvents = 0;
    window.__repeatEscapeSaw = 0;
    window.__repeatEscapePrevented = 0;
    const el = document.querySelector("dialog.space-opened");
    el?.addEventListener("close", () => { window.__dialogCloseEvents++; });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && e.repeat) {
        window.__repeatEscapeSaw++;
        if (e.defaultPrevented) window.__repeatEscapePrevented++;
      }
    });
  });
  await win.keyboard.down("Escape");
  await win.keyboard.down("Escape");
  await win.keyboard.down("Escape");
  await win.keyboard.up("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveClass(/fullscreen/);
  assert.equal(await win.evaluate(() => window.__dialogCloseEvents), 0, "holding Esc in full screen must not fire close");
  assert.ok(await win.evaluate(() => window.__repeatEscapeSaw) >= 2, "hold test should deliver repeated Escape keydowns");
  assert.equal(
    await win.evaluate(() => window.__repeatEscapePrevented),
    await win.evaluate(() => window.__repeatEscapeSaw),
    "repeated Escape keydowns on the dialog should be prevented",
  );
  await win.waitForTimeout(300);
  if (shotsDir) await win.screenshot({ path: join(shotsDir, "04-normal-dark.png") });

  // 5. Press Escape again -> closes dialog and fires native close once
  await win.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  assert.equal(await win.evaluate(() => window.__dialogCloseEvents), 1, "dialog close should fire once on Esc");

  // 6. Re-open -> still full screen (Esc-restore did not wipe explicit full-screen preference)
  await win.getByRole("button", { name: "Open Launch board" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/fullscreen/);

  // 7. Click inside the sandboxed iframe -> forged postMessage key messages do nothing; real trusted keys work
  const frameBtn = dialog.frameLocator("iframe").locator("#focus-inside");
  await expect(frameBtn).toBeVisible();
  await frameBtn.click();
  assert.equal(
    await win.evaluate(() => document.activeElement === document.querySelector("dialog.space-opened iframe")),
    true,
    "focus should be inside the opened panel iframe",
  );

  // Page-script postMessage and synthetic KeyboardEvent imitating panel keys must be ignored
  const iframeHandle = await dialog.locator("iframe").elementHandle();
  const panelFrame = await iframeHandle?.contentFrame();
  assert.ok(panelFrame, "panel iframe should be present");
  await panelFrame.evaluate(() => {
    parent.postMessage({ botkins: 1, type: "key", key: "toggle" }, "*");
    parent.postMessage({ botkins: 1, type: "key", key: "escape" }, "*");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F", metaKey: true, ctrlKey: true, shiftKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await win.waitForTimeout(150);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/fullscreen/);
  assert.equal(await storedFullscreen(), "1", "forged postMessage and synthetic keys must not toggle or save fullscreen");

  // Reset frame key counters after synthetic dispatch check
  await panelFrame.evaluate(() => {
    window.__frameKeys = { escape: 0, toggle: 0 };
  });

  // Real Cmd/Ctrl+Shift+F typed via Playwright keyboard.press while iframe has focus -> toggles and saves
  await win.keyboard.press(`${mod}+Shift+F`);
  await expect(dialog).not.toHaveClass(/fullscreen/);
  assert.equal(await storedFullscreen(), "0");

  // Forged postMessage escape outside full screen must not close the panel either
  await panelFrame.evaluate(() => {
    parent.postMessage({ botkins: 1, type: "key", key: "escape" }, "*");
    parent.postMessage({ botkins: 1, type: "key", key: "toggle" }, "*");
  });
  await win.waitForTimeout(150);
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveClass(/fullscreen/);
  assert.equal(await storedFullscreen(), "0");

  // Main-process before-input-event path: auto-repeat is ignored; non-repeat toggles, saves, and prevents default
  const sendInputKey = async (keyCode, modifiers = []) => {
    await app.evaluate(({ BrowserWindow }, payload) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.webContents.sendInputEvent({ type: "keyDown", keyCode: payload.keyCode, modifiers: payload.modifiers });
      w.webContents.sendInputEvent({ type: "keyUp", keyCode: payload.keyCode, modifiers: payload.modifiers });
    }, { keyCode, modifiers });
  };
  const inputMod = process.platform === "darwin" ? "meta" : "control";
  const toggleCountBefore = await panelFrame.evaluate(() => window.__frameKeys.toggle);
  await sendInputKey("F", [inputMod, "shift", "isAutoRepeat"]);
  await win.waitForTimeout(150);
  await expect(dialog).not.toHaveClass(/fullscreen/);
  assert.equal(await storedFullscreen(), "0");

  await sendInputKey("F", [inputMod, "shift"]);
  await expect(dialog).toHaveClass(/fullscreen/);
  assert.equal(await storedFullscreen(), "1");
  assert.equal(
    await panelFrame.evaluate(() => window.__frameKeys.toggle),
    toggleCountBefore,
    "before-input-event should prevent Cmd/Ctrl+Shift+F so the frame does not receive it",
  );

  // Escape typed inside the iframe in full screen -> restores, does not close, and frame still sees Escape
  await win.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveClass(/fullscreen/);
  assert.equal(await panelFrame.evaluate(() => window.__frameKeys.escape), 1, "frame should keep its own Escape key");

  // Escape typed inside the iframe outside full screen -> does nothing, panel stays open, frame still sees Escape
  await win.keyboard.press("Escape");
  await win.waitForTimeout(150);
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveClass(/fullscreen/);
  assert.equal(await panelFrame.evaluate(() => window.__frameKeys.escape), 2, "frame should keep Escape outside full screen");

  // Cmd/Ctrl+Shift+F when focus is in the dialog (outside iframe) toggles once via dialog handler, no double-toggle
  await dialog.getByRole("button", { name: "Full screen" }).focus();
  await win.keyboard.press(`${mod}+Shift+F`);
  await expect(dialog).toHaveClass(/fullscreen/);
  await win.keyboard.press(`${mod}+Shift+F`);
  await expect(dialog).not.toHaveClass(/fullscreen/);
  // Restore saved fullscreen preference to "1" for the next section
  await win.keyboard.press(`${mod}+Shift+F`);
  await expect(dialog).toHaveClass(/fullscreen/);
  assert.equal(await storedFullscreen(), "1");

  // Close cleanly from dialog button after iframe Escape check
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);

  // 8. Toggle saved preference back to normal, then verify Close button uses dialog.close() and fires close once
  await win.getByRole("button", { name: "Open Launch board" }).click();
  await expect(dialog).toHaveClass(/fullscreen/);
  await dialog.getByRole("button", { name: "Exit full screen" }).click();
  await expect(dialog).not.toHaveClass(/fullscreen/);
  assert.equal(await storedFullscreen(), "0");

  await win.evaluate(() => {
    window.__dialogCloseEvents = 0;
    window.__nativeCloseCalls = 0;
    const el = document.querySelector("dialog.space-opened");
    if (el) {
      const orig = el.close.bind(el);
      el.close = (...args) => {
        window.__nativeCloseCalls++;
        return orig(...args);
      };
      el.addEventListener("close", () => { window.__dialogCloseEvents++; });
    }
  });
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal(await win.evaluate(() => window.__nativeCloseCalls), 1, "Close button should call dialog.close() once");
  assert.equal(await win.evaluate(() => window.__dialogCloseEvents), 1, "Close button should fire dialog close once");

  // 9. Finding 4: "Open full screen" applies to this opening only; Esc-restore then open another panel -> opens normally
  await win.getByRole("button", { name: "Manage Launch board" }).click();
  await expect(win.getByRole("button", { name: "Open full screen" })).toBeVisible();
  await win.getByRole("button", { name: "Open full screen" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/fullscreen/);
  assert.equal(await storedFullscreen(), "0", "Open full screen must not overwrite saved preference");

  await win.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveClass(/fullscreen/);
  await win.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Open another panel normally -> opens at normal size
  await win.getByRole("button", { name: "Open Status summary" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveClass(/fullscreen/);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);

  // 10. Shortcut is bound to the open panel's frame id, not other custom frames.
  // Even if main still holds `frameId` as open when focus is in `frameId2`, neither
  // `before-input-event` nor `frame-panel-key` swallows or forwards Cmd/Ctrl+Shift+F.
  const otherIframe = win.locator(`iframe[src="botkins-app://frame-${frameId2}/"]`).first();
  await expect(otherIframe).toBeVisible();
  const otherBtn = win.frameLocator(`iframe[src="botkins-app://frame-${frameId2}/"]`).first().locator("#focus-other");
  await expect(otherBtn).toBeVisible();
  await otherBtn.click();
  const otherFrame = await (await otherIframe.elementHandle())?.contentFrame();
  assert.ok(otherFrame, "other custom frame should be present");
  await otherFrame.evaluate(() => { window.__otherKeys = { toggle: 0 }; });
  await win.evaluate((staleFrameId) => {
    window.__strayPanelKeys = [];
    window.__offStrayPanelKeys = window.botkins.onPanelKey?.((data) => window.__strayPanelKeys.push(data));
    window.botkins.setPanelOpen?.(staleFrameId);
  }, frameId);
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const prevented = [];
      const listener = (event, input) => {
        if (input.type === "keyDown" && String(input.key).toLowerCase() === "f") {
          prevented.push(event.defaultPrevented);
        }
      };
      w.webContents.on("before-input-event", listener);
      w.__stopPanelKeyProbe = () => {
        w.webContents.removeListener("before-input-event", listener);
        return prevented;
      };
    });
    await sendInputKey("F", [inputMod, "shift"]);
    const prevented = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].__stopPanelKeyProbe());
    assert.deepEqual(prevented, [false], "before-input-event must not swallow Cmd/Ctrl+Shift+F in another custom frame");

    await win.keyboard.press(`${mod}+Shift+F`);
    await expect.poll(() => otherFrame.evaluate(() => window.__otherKeys.toggle)).toBe(1);
    await win.waitForTimeout(150);
    assert.deepEqual(await win.evaluate(() => window.__strayPanelKeys), [], "main must not forward panel-key from a different custom frame");
    await expect(dialog).toHaveCount(0);
  } finally {
    await win.evaluate(() => {
      window.__offStrayPanelKeys?.();
      window.botkins.setPanelOpen?.(null);
    });
  }

  assert.deepEqual(errors, [], "Unexpected renderer errors: " + errors.join("; "));
  console.log("Panel open smoke passed.");
} finally {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
}
