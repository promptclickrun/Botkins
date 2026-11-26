// Integration tests for the DOM-first driver (dist/dom-driver.js) and BrowserController
// against real HTML fixture pages in headless Chromium, including a foreign
// chrome-extension:// iframe (simulating Proton Pass / 1Password / Bitwarden).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BrowserController } from "../src/browser-controller.mjs";
import { DRIVER_VERSION } from "../src/dom-driver.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = join(__dirname, "..");
const fixturesDir = join(__dirname, "fixtures");
const driverBundlePath = join(extRoot, "dist", "dom-driver.js");

function findChromiumBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const cleanPath = (req.url || "/").split("?")[0];
    const rel = cleanPath === "/" ? "login-with-foreign-extension.html" : cleanPath.replace(/^\/+/, "");
    const filePath = join(fixturesDir, rel);
    if (!filePath.startsWith(fixturesDir) || !existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(filePath, "utf8"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

class HarnessCdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", (e) => reject(new Error(e.message || "WebSocket open failed")), { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "CDP error"));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalInContext(expression, { contextId, awaitPromise = true } = {}) {
    const params = { expression, returnByValue: true, awaitPromise };
    if (contextId !== undefined) params.contextId = contextId;
    const res = await this.send("Runtime.evaluate", params);
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Eval error");
    }
    return res.result?.value;
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

async function launchChromium(chromeBin) {
  const userDataDir = mkdtempSync(join(tmpdir(), "botkins-ext-test-"));
  const proc = spawn(
    chromeBin,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderrBuf = "";
  const wsBrowserUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chromium timed out starting. stderr:\n${stderrBuf}`)), 15000);
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited early (${code}). stderr:\n${stderrBuf}`));
    });
  });

  const baseHttp = wsBrowserUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "");
  const targets = await fetch(`${baseHttp}/json/list`).then((r) => r.json());
  const pageTarget = targets.find((t) => t.type === "page") || targets[0];
  assert.ok(pageTarget?.webSocketDebuggerUrl, "Expected a Chromium page target");

  const cdp = new HarnessCdpClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  async function navigate(url) {
    await cdp.send("Page.navigate", { url });
    // Wait until document + subframes are loaded
    for (let i = 0; i < 60; i++) {
      const ready = await cdp.evalInContext(
        `document.readyState === "complete" && (!document.getElementById("reachable-iframe") || document.getElementById("reachable-iframe").contentDocument?.readyState === "complete")`,
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function close() {
    cdp.close();
    proc.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
        resolve();
      }, 3000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    rmSync(userDataDir, { recursive: true, force: true });
  }

  return { cdp, navigate, close };
}

const chromeBin = findChromiumBinary();

test(
  "DOM driver indexes shadow DOM + reachable iframe, redacts passwords, fills React inputs, submits forms, and ignores foreign chrome-extension:// iframes",
  { skip: !chromeBin ? "No Chromium/Chrome binary available on this host" : false },
  async () => {
    assert.ok(existsSync(driverBundlePath), "dist/dom-driver.js must exist (run `npm run build`)");
    const driverCode = readFileSync(driverBundlePath, "utf8");
    const { server, baseUrl } = await startFixtureServer();
    const browser = await launchChromium(chromeBin);

    try {
      await browser.navigate(`${baseUrl}/login-with-foreign-extension.html`);

      // Verify the foreign chrome-extension:// iframe actually exists in the DOM next to password
      const foreignSrc = await browser.cdp.evalInContext(
        `document.getElementById("proton-pass-iframe")?.getAttribute("src")`,
      );
      assert.match(foreignSrc, /^chrome-extension:\/\//);

      // Inject the built DOM driver bundle into an isolated world (just like chrome.scripting.executeScript)
      const frameTree = await browser.cdp.send("Page.getFrameTree");
      const mainFrameId = frameTree.frameTree.frame.id;
      const isolated = await browser.cdp.send("Page.createIsolatedWorld", {
        frameId: mainFrameId,
        worldName: "botkins-test-isolated",
      });
      const ctxId = isolated.executionContextId;

      await browser.cdp.evalInContext(driverCode, { contextId: ctxId });
      const version = await browser.cdp.evalInContext(`window.__botkinsDomDriver?.version`, { contextId: ctxId });
      assert.equal(version, DRIVER_VERSION);

      const callDriver = (action, payload = {}) =>
        browser.cdp.evalInContext(
          `window.__botkinsDomDriver.dispatch(${JSON.stringify(action)}, ${JSON.stringify(payload)})`,
          { contextId: ctxId },
        );

      // 1. Snapshot indexing (with same-origin iframe traversal enabled)
      const snap = await callDriver("snapshot", { traverseSameOriginIframes: true });
      assert.equal(snap.ok, true);
      assert.equal(snap.title, "Scotch Login Fixture");
      assert.ok(snap.elements.length >= 9, `Expected >= 9 indexed elements, got ${snap.elements.length}`);

      // Strict password redaction: secret value must NEVER appear anywhere in snapshot
      const snapJson = JSON.stringify(snap);
      assert.equal(snapJson.includes("SuperSecretPassword123!"), false, "Password leaked in snapshot!");

      const emailEl = snap.elements.find((e) => e.name === "Email address");
      const passEl = snap.elements.find((e) => e.name === "Password");
      const planEl = snap.elements.find((e) => e.name === "Membership Plan");
      const rememberEl = snap.elements.find((e) => e.name === "Remember this browser");
      const bioEl = snap.elements.find((e) => e.name === "Delivery Notes");
      const richEl = snap.elements.find((e) => e.name === "Rich Note");
      const submitEl = snap.elements.find((e) => e.name === "Sign In");
      const shadowInputEl = snap.elements.find((e) => e.name === "Shadow Promo Code");
      const shadowBtnEl = snap.elements.find((e) => e.name === "Apply Shadow Promo");
      const iframeInputEl = snap.elements.find((e) => e.name === "2FA Code");
      const iframeBtnEl = snap.elements.find((e) => e.name === "Verify Code");

      assert.ok(emailEl, "Email input indexed");
      assert.equal(emailEl.role, "textbox");
      assert.ok(emailEl.box.width > 0 && emailEl.box.height > 0, "Bounding box populated");

      assert.ok(passEl, "Password input indexed");
      assert.equal(passEl.type, "password");
      assert.equal(passEl.value, undefined, "Password value must not be emitted");
      assert.equal(passEl.hasValue, true);
      assert.equal(passEl.valueState, "filled");

      assert.ok(planEl && planEl.role === "combobox", "Select element indexed");
      assert.ok(rememberEl && rememberEl.role === "checkbox" && rememberEl.checked === false);
      assert.ok(bioEl && bioEl.tag === "textarea");
      assert.ok(richEl && richEl.role === "textbox");
      assert.ok(submitEl && submitEl.role === "button");
      assert.ok(shadowInputEl && shadowInputEl.inShadow === true, "Open shadow input indexed");
      assert.ok(shadowBtnEl && shadowBtnEl.inShadow === true, "Open shadow button indexed");
      assert.ok(iframeInputEl && iframeBtnEl, "Reachable same-origin iframe elements indexed");
      assert.equal(
        snap.elements.some((e) => e.name === "Should Not Appear"),
        false,
        "Hidden elements excluded",
      );

      // 2. React/Vue-compatible fill via native value setter + _valueTracker reset
      const typedEmail = await callDriver("type", {
        ref: emailEl.ref,
        text: "colt@botkins.app",
        clear: true,
      });
      assert.equal(typedEmail.ok, true);
      const reactState = await browser.cdp.evalInContext(`window.__reactInputState`);
      assert.equal(reactState.email, "colt@botkins.app", "React value tracker detected native setter fill");

      const emailEvents = await browser.cdp.evalInContext(
        `window.__events.filter((e) => e.target === "email").map((e) => e.type)`,
      );
      for (const expected of ["keydown", "beforeinput", "input", "keyup", "change"]) {
        assert.ok(emailEvents.includes(expected), `Expected ${expected} event on email input`);
      }

      // 3. Clearing password updates valueState to "empty" without leaking value
      await callDriver("type", { ref: passEl.ref, text: "", clear: true });
      const snapAfterClear = await callDriver("snapshot", { traverseSameOriginIframes: true });
      const passAfterClear = snapAfterClear.elements.find((e) => e.name === "Password");
      assert.equal(passAfterClear.hasValue, false);
      assert.equal(passAfterClear.valueState, "empty");

      // Re-resolve new refs after snapshot (also verify old refs stay cleared cleanly)
      const freshPlan = snapAfterClear.elements.find((e) => e.name === "Membership Plan");
      const freshRemember = snapAfterClear.elements.find((e) => e.name === "Remember this browser");
      const freshBio = snapAfterClear.elements.find((e) => e.name === "Delivery Notes");
      const freshRich = snapAfterClear.elements.find((e) => e.name === "Rich Note");
      const freshSubmit = snapAfterClear.elements.find((e) => e.name === "Sign In");
      const freshShadowInput = snapAfterClear.elements.find((e) => e.name === "Shadow Promo Code");
      const freshShadowBtn = snapAfterClear.elements.find((e) => e.name === "Apply Shadow Promo");
      const freshIframeInput = snapAfterClear.elements.find((e) => e.name === "2FA Code");
      const freshIframeBtn = snapAfterClear.elements.find((e) => e.name === "Verify Code");

      await callDriver("type", { ref: passAfterClear.ref, text: "NewPass!99", clear: true });
      const selRes = await callDriver("select", { ref: freshPlan.ref, label: "Reserve Club" });
      assert.equal(selRes.ok, true);
      assert.equal(selRes.value, "reserve");

      // Click checkbox, type into textarea & contenteditable
      await callDriver("click", { ref: freshRemember.ref });
      await callDriver("type", { ref: freshBio.ref, text: "Leave at side gate", clear: true });
      await callDriver("type", { ref: freshRich.ref, text: "Updated note", clear: true });

      // Open shadow DOM type + click (refs still valid because no snapshot ran since snapAfterClear!)
      await callDriver("type", { ref: freshShadowInput.ref, text: "SCOTCH20", clear: true });
      await callDriver("click", { ref: freshShadowBtn.ref });
      assert.equal(await browser.cdp.evalInContext(`window.__shadowApplied`), "SCOTCH20");

      // Same-origin iframe type + click
      await callDriver("type", { ref: freshIframeInput.ref, text: "482910", clear: true });
      await callDriver("click", { ref: freshIframeBtn.ref });
      assert.equal(await browser.cdp.evalInContext(`window.__frameVerified`), "482910");

      // Click submit button: verifies full pointer/mouse sequence + form.requestSubmit firing once
      await browser.cdp.evalInContext(`window.__events = []; window.__submits = [];`);
      const clickSubmit = await callDriver("click", { ref: freshSubmit.ref });
      assert.equal(clickSubmit.ok, true);
      const submitEvents = await browser.cdp.evalInContext(
        `window.__events.filter((e) => e.target === "submit-btn").map((e) => e.type)`,
      );
      assert.deepEqual(
        submitEvents.slice(0, 9),
        ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"],
      );
      const submits = await browser.cdp.evalInContext(`window.__submits`);
      assert.equal(submits.length, 1, "form.requestSubmit must fire submit exactly once (no double submit)");
      assert.equal(submits[0].submitterId, "submit-btn");
      assert.equal(submits[0].email, "colt@botkins.app");
      assert.equal(submits[0].passwordLength, 10);
      assert.equal(submits[0].plan, "reserve");
      assert.equal(submits[0].remember, true);

      // 4. Wait check (visible text + shadow selector)
      const waitOk = await callDriver("checkWait", { text: "Signed in as colt@botkins.app", selector: "#shadow-apply" });
      assert.equal(waitOk.matched, true);
      const waitMiss = await callDriver("checkWait", { text: "Nonexistent Banner Text" });
      assert.equal(waitMiss.matched, false);

      // 5. Scroll page + scrollable container
      const scrolledPage = await callDriver("scroll", { direction: "down", amount: 500 });
      assert.equal(scrolledPage.ok, true);
      assert.ok(scrolledPage.scrollY > 0);
      const scrolledBox = await callDriver("scroll", { selector: "#scroll-box", direction: "down", amount: 200 });
      assert.equal(scrolledBox.ok, true);
      assert.ok(scrolledBox.scrollY > 0);

      // 6. DOM press (Backspace edits focused input, Space toggles checkbox)
      await browser.cdp.evalInContext(`document.getElementById("bio").focus()`);
      await callDriver("press", { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, rawKey: "Backspace" });
      assert.equal(await browser.cdp.evalInContext(`document.getElementById("bio").value`), "Leave at side gat");

      await browser.cdp.evalInContext(`document.getElementById("remember").focus()`);
      await callDriver("press", { key: " ", code: "Space", windowsVirtualKeyCode: 32, rawKey: "Space" });
      assert.equal(await browser.cdp.evalInContext(`document.getElementById("remember").checked`), false);

      // 7. Click by text & selector, and type with submit: true (triggers form.requestSubmit)
      await callDriver("click", { selector: "#remember" });
      assert.equal(await browser.cdp.evalInContext(`document.getElementById("remember").checked`), true);

      await browser.cdp.evalInContext(`window.__submits = [];`);
      const textClick = await callDriver("click", { text: "Sign In" });
      assert.equal(textClick.ok, true);
      assert.equal(await browser.cdp.evalInContext(`window.__submits.length`), 1);

      await browser.cdp.evalInContext(`window.__submits = [];`);
      const typeSubmit = await callDriver("type", { selector: "#email", text: "enter@botkins.app", clear: true, submit: true });
      assert.equal(typeSubmit.ok, true);
      const enterSubmits = await browser.cdp.evalInContext(`window.__submits`);
      assert.equal(enterSubmits.length, 1);
      assert.equal(enterSubmits[0].email, "enter@botkins.app");

      // 8. Stale refs from a previous snapshot are cleared when a new snapshot runs
      await browser.cdp.evalInContext(`document.getElementById("submit-btn").style.display = "none";`);
      const snapAfterHide = await callDriver("snapshot", { traverseSameOriginIframes: true });
      assert.equal(snapAfterHide.elements.some((e) => e.name === "Sign In"), false);
      const staleAttr = await browser.cdp.evalInContext(`document.getElementById("submit-btn").getAttribute("data-botkins-ref")`);
      assert.equal(staleAttr, null);
    } finally {
      await browser.close();
      server.close();
    }
  },
);

test(
  "BrowserController completes full login flow on foreign chrome-extension:// iframe page even when chrome.debugger is blocked",
  { skip: !chromeBin ? "No Chromium/Chrome binary available on this host" : false },
  async () => {
    const driverCode = readFileSync(driverBundlePath, "utf8");
    const { server, baseUrl } = await startFixtureServer();
    const browser = await launchChromium(chromeBin);

    try {
      const pageUrl = `${baseUrl}/login-with-foreign-extension.html`;
      await browser.navigate(pageUrl);

      // Prepare isolated worlds for reachable frames (top frame = 0, same-origin subframe = 2);
      // the foreign chrome-extension:// iframe is NOT reachable by chrome.scripting either.
      const frameTree = await browser.cdp.send("Page.getFrameTree");
      const topFrame = frameTree.frameTree.frame;
      const subFrame = (frameTree.frameTree.childFrames || []).find((cf) =>
        String(cf.frame.url || "").includes("/subframe.html"),
      )?.frame;
      assert.ok(subFrame, "Expected reachable same-origin subframe in Chromium");

      const topIso = await browser.cdp.send("Page.createIsolatedWorld", {
        frameId: topFrame.id,
        worldName: "botkins-ctrl-top",
      });
      const subIso = await browser.cdp.send("Page.createIsolatedWorld", {
        frameId: subFrame.id,
        worldName: "botkins-ctrl-sub",
      });
      const frameContexts = new Map([
        [0, topIso.executionContextId],
        [2, subIso.executionContextId],
      ]);

      const tab = {
        id: 101,
        windowId: 1,
        title: "Scotch Login Fixture",
        url: pageUrl,
        active: true,
        pinned: false,
        groupId: -1,
        incognito: false,
        status: "complete",
      };
      let debuggerAttachAttempts = 0;

      globalThis.chrome = {
        tabs: {
          query: async () => [tab],
          get: async () => tab,
          update: async (_id, patch) => Object.assign(tab, patch),
          captureVisibleTab: async () => "data:image/jpeg;base64,Vk1JR0VDTk9DRFA=",
        },
        windows: { update: async () => ({}) },
        tabGroups: { query: async () => [] },
        scripting: {
          executeScript: async (injection) => {
            if (injection.world === "MAIN") {
              const fnSrc = injection.func.toString();
              const argsJson = JSON.stringify(injection.args || []);
              const result = await browser.cdp.evalInContext(`(${fnSrc})(...${argsJson})`);
              return [{ frameId: 0, result }];
            }
            const targetFrames = injection.target.frameIds || (injection.target.allFrames ? [0, 2] : [0]);
            const out = [];
            for (const fid of targetFrames) {
              const ctxId = frameContexts.get(fid);
              if (!ctxId) continue;
              if (injection.files) {
                await browser.cdp.evalInContext(driverCode, { contextId: ctxId });
                out.push({ frameId: fid, result: undefined });
              } else {
                const fnSrc = injection.func.toString();
                const argsJson = JSON.stringify(injection.args || []);
                const result = await browser.cdp.evalInContext(`(${fnSrc})(...${argsJson})`, { contextId: ctxId });
                out.push({ frameId: fid, result });
              }
            }
            return out;
          },
        },
        debugger: {
          onDetach: { addListener: () => {} },
          attach: async () => {
            debuggerAttachAttempts++;
            throw new Error("Cannot access a chrome-extension:// URL of different extension");
          },
          detach: async () => {},
          sendCommand: async () => {
            throw new Error("Cannot access a chrome-extension:// URL of different extension");
          },
        },
      };

      const ctrl = new BrowserController({
        getSettings: async () => ({ enabled: true, mode: "all", groupName: "Botkins", groupColor: "orange", pausedTabIds: [] }),
        uploadScreenshot: async (b64, name) => `uploaded:${name}:${b64.length}`,
      });

      // Full DOM-first login workflow succeeds with ZERO chrome.debugger calls!
      const snap = await ctrl.run("browser_snapshot", { tabId: 101 });
      assert.equal(debuggerAttachAttempts, 0);
      assert.equal(JSON.stringify(snap).includes("SuperSecretPassword123!"), false);

      const emailRef = snap.elements.find((e) => e.name === "Email address")?.ref;
      const passRef = snap.elements.find((e) => e.name === "Password")?.ref;
      const submitRef = snap.elements.find((e) => e.name === "Sign In")?.ref;
      const codeRef = snap.elements.find((e) => e.name === "2FA Code")?.ref;
      const verifyRef = snap.elements.find((e) => e.name === "Verify Code")?.ref;
      assert.ok(emailRef && passRef && submitRef && codeRef && verifyRef);

      await ctrl.run("browser_type", { tabId: 101, ref: emailRef, text: "colt@scissorsscotch.com", clear: true });
      await ctrl.run("browser_type", { tabId: 101, ref: passRef, text: "FreshSecret#1", clear: true });
      await ctrl.run("browser_click", { tabId: 101, ref: submitRef });

      // Interact across subframe refs too
      await ctrl.run("browser_type", { tabId: 101, ref: codeRef, text: "991122", clear: true });
      await ctrl.run("browser_click", { tabId: 101, ref: verifyRef });

      const waited = await ctrl.run("browser_wait", { tabId: 101, text: "Signed in as colt@scissorsscotch.com", timeoutMs: 2000 });
      assert.equal(waited.matched, "text");

      const evalVal = await ctrl.run("browser_eval", {
        tabId: 101,
        expression: `({ submits: window.__submits.length, email: window.__submits[0]?.email, frameCode: window.__frameVerified })`,
      });
      assert.deepEqual(evalVal.result, { submits: 1, email: "colt@scissorsscotch.com", frameCode: "991122" });

      const shot = await ctrl.run("browser_screenshot", { tabId: 101 });
      assert.equal(shot.path, "uploaded:browser-tab-101.jpg:16");
      assert.equal(debuggerAttachAttempts, 0, "Primary DOM-first tools must never attach chrome.debugger");

      // CDP-only operations fail with a clear, actionable message about the foreign extension
      await assert.rejects(
        () => ctrl.run("browser_screenshot", { tabId: 101, fullPage: true }),
        /another extension.*Proton Pass/i,
      );
      await assert.rejects(
        () => ctrl.run("browser_cdp", { tabId: 101, method: "DOM.getDocument" }),
        /different extension/i,
      );
      assert.equal(debuggerAttachAttempts, 2);
    } finally {
      await browser.close();
      server.close();
    }
  },
);
