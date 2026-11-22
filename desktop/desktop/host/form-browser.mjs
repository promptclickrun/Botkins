// Chromium on the Linux host's screen. Its DevTools connection is an inherited pipe,
// never a port another process can connect to. Only fixed Botkins operations use it.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { findTool, toolEnv } from "../link/tools.mjs";
import { webAddress } from "../sidepane.mjs";
import { bindForm, callInPage, fillPageFields, inspectForm } from "../webviewer.mjs";

const closed = () => new Error("Open the sign-in page in this chat’s screen browser first.");
const unavailable = () => new Error("Chromium did not answer. Check that the Botkins service can open its X11 display and run sandboxed Chromium.");
const systemDirs = ["/usr/bin", "/usr/local/bin", "/opt/google/chrome", "/snap/bin"];

// The pipe carries NUL-terminated UTF-8 JSON. Never log commands, replies or Chromium output.
function connection(child) {
  const input = child.stdio[3], output = child.stdio[4];
  const pending = new Map();
  let seq = 0, buffer = "", ended = false;
  const end = () => {
    ended = true;
    for (const job of pending.values()) job.reject(unavailable());
    pending.clear();
  };
  for (const stream of [input, output]) stream.on("error", end);
  child.once("error", end);
  output.on("close", end);
  output.setEncoding("utf8").on("data", chunk => {
    buffer += chunk;
    if (buffer.length > 4_000_000) return child.kill();
    let boundary;
    while ((boundary = buffer.indexOf("\0")) >= 0) {
      let message;
      try { message = JSON.parse(buffer.slice(0, boundary)); } catch { return child.kill(); }
      buffer = buffer.slice(boundary + 1);
      const job = pending.get(message.id);
      if (job) {
        pending.delete(message.id);
        if (message.error) job.reject(unavailable());
        else job.resolve(message.result);
      }
    }
  });
  return async (method, params = {}, sessionId) => {
    if (ended) throw unavailable();
    const id = ++seq;
    const job = Promise.withResolvers();
    pending.set(id, job);
    const timer = setTimeout(() => job.reject(unavailable()), 15000);
    try {
      input.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
      return await job.promise;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
}

export class ScreenBrowser {
  constructor({ executable, args = [], env = process.env } = {}) {
    Object.assign(this, { executable, args, env });
  }

  async launch(chatId) {
    const executable = this.executable ?? ["chromium", "chromium-browser", "google-chrome"].map(name => findTool(name, systemDirs)).find(Boolean);
    if (!executable) throw new Error("Install Chromium or Google Chrome in the Linux screen setup, then open the page again.");
    const profile = mkdtempSync(join(tmpdir(), "botkins-form-"));
    const env = toolEnv(systemDirs);
    for (const name of ["DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG"]) if (this.env[name]) env[name] = this.env[name];
    const child = spawn(executable, ["--remote-debugging-pipe", "--user-data-dir=" + profile, "--incognito",
      "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-extensions", "--disable-breakpad",
      ...this.args, "about:blank"], { env, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const session = { chatId, child };
    this.session = session;
    session.done = new Promise(resolve => child.once("close", () => {
      if (this.session === session) this.session = null;
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* The profile remains private if the OS is still using it. */ }
      resolve();
    }));
    const command = connection(child);
    // Attach to the initial tab in the private profile. Closing it ends this chat’s browser.
    let targetId;
    const deadline = Date.now() + 10000;
    while (!targetId && Date.now() < deadline) {
      const { targetInfos } = await command("Target.getTargets");
      targetId = targetInfos.find(target => target.type === "page" && target.url === "about:blank")?.targetId;
      if (!targetId) await delay(60);
    }
    if (!targetId) throw unavailable();
    const { sessionId } = await command("Target.attachToTarget", { targetId, flatten: true });
    session.send = (method, params) => command(method, params, sessionId);
    await session.send("Page.bringToFront");
    return session;
  }

  async open(chatId, address) {
    if (this.opening || (this.session && this.session.chatId !== chatId)) throw new Error("Another browser operation is in progress. Close the other chat’s screen browser first.");
    this.opening = true;
    const firstPage = !this.session;
    try {
      const url = await webAddress(address);
      if (this.stopped) throw closed();
      if (!url.startsWith("https:")) throw new Error("Open an HTTPS sign-in page.");
      const session = this.session ?? await this.launch(chatId);
      const { errorText } = await session.send("Page.navigate", { url });
      if (errorText) throw new Error("The sign-in page could not be opened.");
      const end = Date.now() + 12000;
      while (Date.now() < end) {
        const { frameTree } = await session.send("Page.getFrameTree");
        if (frameTree.frame.unreachableUrl) throw new Error("The sign-in page could not be opened securely.");
        if (frameTree.frame.url !== "about:blank" && await callInPage(session.send, () => document.readyState !== "loading", [])) break;
        await delay(80);
      }
      return await this.inspect(chatId);
    } catch (error) {
      if (firstPage) await this.close(chatId);
      throw error;
    } finally {
      this.opening = false;
    }
  }

  page(chatId) {
    if (!this.session?.send || this.session.chatId !== chatId) throw closed();
    return this.session.send;
  }
  async inspect(chatId) {
    const page = await inspectForm(this.page(chatId));
    if (!page) throw new Error("Bring the sign-in tab to the front. Secure fill needs a visible HTTPS page.");
    return page;
  }
  async bind(chatId, url) {
    const document = await bindForm(this.page(chatId), url);
    if (!document) throw closed();
    return document;
  }
  async fill(plan, values, signal) {
    if (!plan.document) throw closed();
    await fillPageFields(this.page(plan.chatId), plan, values, signal);
  }
  stop() {
    this.stopped = true;
    return this.close();
  }
  async close(chatId) {
    const session = this.session;
    if (!session || (chatId && session.chatId !== chatId)) return;
    session.child.kill();
    const kill = setTimeout(() => session.child.kill("SIGKILL"), 2000);
    try { await session.done; } finally { clearTimeout(kill); }
  }
}
