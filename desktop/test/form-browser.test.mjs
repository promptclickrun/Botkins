import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { headlessHost } from "../desktop/host/headless.mjs";
import { createRuntime } from "../desktop/runtime.mjs";
import { LinkClient, pair, parsePairingUrl } from "../desktop/remote/link-client.mjs";
import { seedBots } from "./starter.mjs";

const binary = ["/usr/bin/chromium", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);

for (const split of [false, true]) {
  const topology = split ? "separate vault and workspace processes" : "a terminal host";
  const skip = !binary || (split && (process.platform !== "linux" || !existsSync("/usr/bin/xdotool")));
  test("a chat fills a saved login privately with " + topology, { skip, timeout: 30000 }, t => browserLogin(t, split));
}

async function browserLogin(t, split) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-browser-test-"));

  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1", "-keyout", key, "-out", cert], { stdio: "ignore" });
  const canary = "fixture-only-credential";
  const received = Promise.withResolvers();
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
    if (req.url === "/receipt") {
      let value = "";
      for await (const chunk of req) value += chunk;
      received.resolve(value === canary);
      return res.end();
    }
    res.setHeader("content-type", "text/html");
    res.end('<input name="password" type="password" onchange="fetch(\'/receipt\', {method:\'POST\',body:this.value})">');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const host = headlessHost({ version: "1.0.0", platform: "linux", env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" } });
  const browser = host.formBrowser;
  browser.executable = binary;
  browser.args = [...(process.env.DISPLAY && process.platform === "linux" ? [] : ["--headless=new"]), "--allow-insecure-localhost"];
  const dataDir = join(dir, "data");
  seedBots(dataDir);
  const socket = join(dir, "backend.sock");
  const previousSocket = process.env.BOTKINS_WORKSPACE_SOCKET;
  if (split) process.env.BOTKINS_WORKSPACE_SOCKET = socket;
  else delete process.env.BOTKINS_WORKSPACE_SOCKET;
  let runtime, phone, child, exit;
  try {
    runtime = await createRuntime({ host, dataDir, trial: true, link: { port: 0, announce: false } });
  } finally {
    if (previousSocket === undefined) delete process.env.BOTKINS_WORKSPACE_SOCKET;
    else process.env.BOTKINS_WORKSPACE_SOCKET = previousSocket;
  }
  t.after(async () => {
    phone?.stop();
    if (child) { child.kill("SIGTERM"); await exit; }
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const ws = runtime.workspace;
  const chat = ws.chat(ws.createChat("pip")), task = { stream: "" };
  ws.active.set(chat.id, task);
  await runtime.listening;
  let offer;
  if (split) {
    const file = join(dir, "pairing.json");
    child = spawn(process.execPath, [fileURLToPath(new URL("../desktop/headless/host.mjs", import.meta.url))], { env: { ...process.env,
      BOTKINS_DATA_DIR: join(dir, "link"), BOTKINS_OWNER_PAIRING_FILE: file,
      BOTKINS_WORKSPACE_SOCKET: socket, BOTKINS_LINK_PORT: "0", BOTKINS_RELAY_URL: "", BOTKINS_PAIR_ADDRESS: "",
    }, stdio: "ignore" });
    exit = once(child, "exit");
    const deadline = Date.now() + 5000;
    while (!existsSync(file) && Date.now() < deadline && child.exitCode === null) await delay(30);
    offer = parsePairingUrl(JSON.parse(readFileSync(file, "utf8")).url);
  } else {
    await runtime.link.setEnabled(true);
    offer = { hosts: ["127.0.0.1:" + runtime.link.status().port], code: runtime.link.startPairing().code };
  }
  const pairing = await pair(fetch, offer, { name: "Fixture", platform: "ios" });
  const tools = new Map(ws.sessionTools(ws.bot("pip"), chat, { id: "test-turn" }, task).map(tool => [tool.name, tool.handler]));
  const invoke = async (name, args) => JSON.parse(await tools.get(name)(args));
  const pending = Promise.withResolvers();
  phone = new LinkClient(pairing, { fetch, onState() {}, onParts(parts) {
    if (parts.live?.requests?.length) pending.resolve(parts.live.requests[0]);
  } });
  phone.start();
  const url = "https://127.0.0.1:" + server.address().port + "/";
  const page = await invoke("browser_form", { action: "open", url: url + "?state=fixture-private#step" });
  assert.deepEqual(page, { url, fields: [{ key: "password", type: "password" }] });
  await assert.rejects(browser.open(chat.id, "http://localhost"), /HTTPS/);
  assert.deepEqual(await browser.inspect(chat.id), page);
  const plan = { chatId: chat.id, url, document: await browser.bind(chat.id, url), fields: [{ key: "password" }] };
  const signal = AbortSignal.timeout(8000);
  await assert.rejects(browser.fill({ ...plan, chatId: "chat-b" }, { password: canary }, signal));
  await assert.rejects(browser.bind(chat.id, url + "other"));
  await assert.rejects(browser.fill(plan, { password: canary }, AbortSignal.abort()));
  const credential = await phone.call("link.credentials.save", { name: "Fixture login", kind: "login", website: url, value: canary });
  assert.deepEqual(await invoke("find_saved_credentials", { url }), [{ name: "Fixture login", kind: "login" }]);
  const asked = invoke("request_secure_input", { title: "Sign in", operation: "page_fill", url: page.url,
    fields: [{ key: "password", label: "Password", kind: "password" }] });
  const request = await pending.promise;
  assert.ok(!request.detail.includes("fixture-private"));
  await phone.call("respond", request.id, { action: "accept", content: { password: { $credential: credential } } });
  const grant = await asked;
  assert.deepEqual(await invoke("use_secure_input", { handles: Object.values(grant.handles) }), { applied: true });
  for (const surface of [grant, ws.snapshot(), readFileSync(join(dataDir, "workspace.json"), "utf8")]) assert.ok(!JSON.stringify(surface).includes(canary));
  assert.equal(await received.promise, true);
  assert.deepEqual(await browser.inspect(chat.id), page);
  await browser.open(chat.id, url + "?state=second");
  await browser.open(chat.id, url + "?state=fixture-private#step");
  await assert.rejects(browser.fill(plan, { password: canary }, signal));
  await invoke("browser_form", { action: "close" });
  await browser.open(chat.id, url);
  ws.active.delete(chat.id);
  await runtime.handlers.deleteChat(chat.id);
  await assert.rejects(browser.inspect(chat.id));
}
