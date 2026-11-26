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

async function startHttpsFixtureServer(tls, { redirectTarget = null, crossOriginFrameUrl = null } = {}) {
  const server = https.createServer(tls, (req, res) => {
    const cleanPath = (req.url || "/").split("?")[0];
    if (cleanPath === "/redirect" && redirectTarget) {
      res.writeHead(302, { Location: redirectTarget });
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
      "--ignore-certificate-errors",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderrBuf = "";
  const wsBrowserUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chromium timed out. stderr:\n${stderrBuf}`)), 15000);
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

  const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

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

  return {
    cdp,
    navigate,
    close,
    getUrl: async () => (currentUrl = await cdp.eval("location.href")),
  };
}

const chromeBin = findChromiumBinary();

test(
  "HTTPS login integration: Ask -> approve fill+submit, Always allow -> no card, redirect & different origin refused, TOTP in same-origin iframe",
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
    });
    t.after(() => {
      trustedServer.server.close();
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
            const iso = await browser.cdp.send("Page.createIsolatedWorld", {
              frameId: cf.frame.id,
              worldName: `botkins-vault-sub-${fid}`,
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

    const secureInputs = new SecureInputs(
      fakeWs,
      (plan, values, opts) => performSecureUse(plan, values, {
        ...opts,
        extensionFill: (args) => controller.run("browser_secure_fill", args),
      }),
      {
        credentials: () => creds,
        credentialGrants: grants,
        savedLogins: (_chatId, origin, opts) => creds.findForSite({ url: opts?.url ?? origin, query: opts?.query }),
      },
    );
    const tools = new Map(secureInputs.tools(bot, chat, run, task).map((tool) => [tool.name, tool.handler]));

    // 1. Navigate to the local HTTPS login page (with foreign chrome-extension:// iframe!)
    await navigateAndBind(`${trustedServer.origin}/`);

    // 2. Fill & submit under default Ask (card raised & approved once)
    nextCardAction = "approve";
    const fillRes1 = JSON.parse(await tools.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: `${trustedServer.origin}/`,
      fields: [
        { selector: "#email", source: "username" },
        { selector: "#password", source: "value" },
      ],
      submit: { selector: "#submit-btn" },
    }));
    assert.equal(cards.length, 1, "First use under Ask must raise an approval card");
    assert.equal(fillRes1.applied, true);
    assert.equal(fillRes1.submitted, true);
    assert.ok(!JSON.stringify(fillRes1).includes(secretPassword), "Secret must never appear in tool output");

    // Verify React state + DOM value + form submit event actually happened on the real HTTPS page!
    const pageCheck1 = await browser.cdp.eval(`({
      email: document.querySelector('#email').value,
      reactEmail: window.__reactInputState?.email,
      passwordMatches: document.querySelector('#password').value === ${JSON.stringify(secretPassword)},
      submitted: window.__submits?.[0] ?? null,
    })`);
    assert.equal(pageCheck1.email, "colt@scissorsscotch.com");
    assert.equal(pageCheck1.reactEmail, "colt@scissorsscotch.com");
    assert.equal(pageCheck1.passwordMatches, true);
    assert.ok(pageCheck1.submitted && pageCheck1.submitted.email === "colt@scissorsscotch.com");
    assert.equal(pageCheck1.submitted.passwordLength, secretPassword.length);

    // Verify a bot snapshot of the page NEVER reads the filled password back!
    const snap = await controller.run("browser_snapshot", { tabId });
    assert.ok(!JSON.stringify(snap).includes(secretPassword), "browser_snapshot must never expose password value");

    // 3. Reload, approve with "remember" (Always allow for this site), then fill AGAIN with NO card!
    await navigateAndBind(`${trustedServer.origin}/`);
    nextCardAction = "remember";
    const fillRes2 = JSON.parse(await tools.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: `${trustedServer.origin}/`,
      fields: [
        { selector: "#email", source: "username" },
        { selector: "#password", source: "value" },
      ],
      submit: { selector: "#submit-btn" },
    }));
    assert.equal(cards.length, 2);
    assert.equal(fillRes2.applied, true);
    assert.equal(fillRes2.grantLevel, "always");

    // Reload and invoke again — must run immediately with ZERO new approval card!
    await navigateAndBind(`${trustedServer.origin}/`);
    const fillRes3 = JSON.parse(await tools.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: `${trustedServer.origin}/`,
      fields: [
        { selector: "#email", source: "username" },
        { selector: "#password", source: "value" },
      ],
      submit: { selector: "#submit-btn" },
    }));
    assert.equal(cards.length, 2, "Standing Always-allow grant must fill without raising another card");
    assert.equal(fillRes3.applied, true);
    assert.equal(fillRes3.grantLevel, "always");

    const pageCheck3 = await browser.cdp.eval(`({
      passwordMatches: document.querySelector('#password').value === ${JSON.stringify(secretPassword)},
      submitted: (window.__submits?.length ?? 0) > 0,
    })`);
    assert.equal(pageCheck3.passwordMatches, true);
    assert.equal(pageCheck3.submitted, true);

    // 4. Malicious redirect attack: page navigated to /redirect -> evilServer.origin!
    // Even though the bot has a standing Always-allow grant for trustedServer.origin,
    // the extension DOM driver checks window.location.origin at fill time and MUST REFUSE!
    await navigateAndBind(`${trustedServer.origin}/redirect`);
    const redirectedUrl = await browser.getUrl();
    assert.ok(redirectedUrl.startsWith(evilServer.origin), "Expected 302 redirect to evil origin");

    await assert.rejects(
      () => tools.get("use_credential")({
        credentialId: credId,
        operation: "extension_fill",
        destination: `${trustedServer.origin}/`,
        fields: [{ selector: "#password", source: "value" }],
      }),
      /origin mismatch|does not match/i,
    );
    // Verify the evil page's password input NEVER received our secret!
    const evilPassValue = await browser.cdp.eval(`document.querySelector('#password').value`);
    assert.notEqual(evilPassValue, secretPassword, "Redirected origin must NEVER receive the secret");

    // 5. Asking directly for the evil origin does NOT reuse the trusted origin's Always-allow grant
    nextCardAction = "deny";
    const evilDirectRes = JSON.parse(await tools.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: `${evilServer.origin}/`,
      fields: [{ selector: "#password", source: "value" }],
    }));
    assert.equal(cards.length, 3, "Different origin must NOT inherit trusted origin's standing grant");
    assert.equal(evilDirectRes.applied, false);
    assert.equal(evilDirectRes.denied, true);

    // 6. Cross-origin iframe host page: attempting to fill into the evil cross-origin iframe fails closed
    await navigateAndBind(`${trustedServer.origin}/xorigin-host`);
    await assert.rejects(
      () => tools.get("use_credential")({
        credentialId: credId,
        operation: "extension_fill",
        destination: `${trustedServer.origin}/xorigin-host`,
        fields: [{ selector: "#frame-code", source: "value" }],
      }),
      /not found|mismatch|could not/i,
    );

    // 7. TOTP 2FA code fill into the same-origin #reachable-iframe on trustedServer under the same grant
    await navigateAndBind(`${trustedServer.origin}/`);
    const snapBefore2fa = await controller.run("browser_snapshot", { tabId });
    const otpEl = snapBefore2fa.elements.find((e) => e.name === "2FA Code");
    assert.ok(otpEl, "Same-origin 2FA iframe input should be indexed");

    const totpRes = JSON.parse(await tools.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: `${trustedServer.origin}/`,
      fields: [{ ref: otpEl.ref, source: "totp" }],
      totp: true,
    }));
    assert.equal(cards.length, 3, "TOTP on same trusted origin reuses the standing grant");
    assert.equal(totpRes.applied, true);

    const otpFilled = await browser.cdp.eval(
      `document.getElementById('reachable-iframe').contentDocument.querySelector('#frame-code').value`,
    );
    assert.match(otpFilled, /^\d{6}$/, "Expected 6-digit TOTP code filled into same-origin iframe");
    assert.ok(!JSON.stringify(totpRes).includes(otpFilled), "TOTP code must be scrubbed from tool output");

    // 8. Security: tainted tab blocks browser_eval and browser_cdp, snapshot redacts secret-filled TOTP input,
    // and filling a password secret into a non-password input (#email) is refused!
    await assert.rejects(
      () => controller.run("browser_eval", { tabId, expression: "document.querySelector('#password').value" }),
      /received a vault credential|cannot run browser_eval/i,
    );
    await assert.rejects(
      () => controller.run("browser_cdp", { tabId, method: "Runtime.evaluate", params: { expression: "1+1" } }),
      /received a vault credential|cannot run browser_cdp/i,
    );
    const snapAfterTotp = await controller.run("browser_snapshot", { tabId });
    const snapJson = JSON.stringify(snapAfterTotp);
    assert.ok(!snapJson.includes(secretPassword), "snapshot must never contain filled password");
    assert.ok(!snapJson.includes(otpFilled), "snapshot must never contain secret-filled TOTP value");

    await assert.rejects(
      () =>
        tools.get("use_credential")({
          credentialId: credId,
          operation: "extension_fill",
          destination: `${trustedServer.origin}/`,
          fields: [{ selector: "#email", source: "value" }],
        }),
      /non-password input/i,
    );
  },
);
