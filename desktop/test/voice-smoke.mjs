// The voice smoke: Settings › Voice, the composer's Live Voice button rule, dictation and reading
// aloud, in the real app on a folder of the test's own.
//   - Settings › Voice opens with its four sections and saves a choice.
//   - A key is saved and then shows only as "Saved": its text is nowhere in the page, in what the
//     page can ask for, or in the workspace file.
//   - The composer shows Live Voice while the message box is empty, Send once there is text, and
//     Stop during a turn. With no live voice chosen, Live Voice shows a note that opens Settings › Voice.
//   - Dictation through a speech service records from Chromium's stand-in microphone, sends the
//     recording to a stand-in OpenAI server on 127.0.0.1, and puts the words in the message box
//     without sending them. Reading aloud gets its audio from the same stand-in.
//   - The live voice's microphone capture (public/pcm-capture.js) loads under the page's rules and
//     gives 16-bit samples at the rate asked for.
// No real speech provider, no relay, nothing outside this computer.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { goHome, signedInAs, skipWelcome } from "./welcome-helper.mjs";
import { starterBots } from "./starter.mjs";

const KEY = "sk-voice-smoke-NOT-A-REAL-KEY-0123456789";
const SPOKEN = "water the roses at six";
const dir = mkdtempSync(join(tmpdir(), "botkins-voice-"));
mkdirSync(join(dir, "data"), { recursive: true });
const now = Date.now();
writeFileSync(
  join(dir, "data", "workspace.json"),
  JSON.stringify({
    bots: starterBots,
    chats: [
      {
        id: "chat-pip",
        botId: "pip",
        title: "Garden",
        time: now,
        messages: [
          { role: "user", text: "What's next in the garden?", time: now - 2000 },
          { role: "assistant", text: "Next: **prune** the roses. See [the guide](https://example.com/roses).", time: now - 1000, botId: "pip" },
        ],
      },
    ],
    runs: [],
  }),
);
const env = { ...process.env, BOTKINS_DATA_DIR: dir, BOTKINS_PROVIDERS: "copilot" };
delete env.ELECTRON_RUN_AS_NODE;
const binary = process.env.BOTKINS_BINARY;
// Chromium's own stand-in microphone (a tone). The app's own permission handler decides who may use it.
const fakeMedia = ["--use-fake-device-for-media-stream"];

// A stand-in for OpenAI's speech routes. It hears every request the app makes to "OpenAI".
const heard = [];
const wav = (() => {
  const rate = 16000;
  const samples = rate / 4; // a quarter of a second of quiet
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples * 2, 40);
  return b;
})();
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    heard.push({ path: req.url, auth: req.headers.authorization ?? "", type: req.headers["content-type"] ?? "", size: body.length, text: body.subarray(0, 4000).toString("latin1") });
    if (req.url === "/v1/audio/transcriptions") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ text: SPOKEN }));
    }
    if (req.url === "/v1/audio/speech") {
      res.writeHead(200, { "content-type": "audio/wav" });
      return res.end(wav);
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not here." } }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port + "/v1";

const errors = [];
let app;
try {
  app = await _electron.launch({ args: binary ? fakeMedia : [".", ...fakeMedia], executablePath: binary, env });
  let page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && /Content Security Policy|Refused/.test(m.text()) && errors.push(m.text()));
  await signedInAs(app);
  page = await skipWelcome(page);
  await page.reload();
  // Set up, the workspace opens on its primary bot's chat; this smoke starts on Home.
  await goHome(page);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const entry = () => page.getByRole("combobox", { name: "Message", exact: true });
  const voice = () => page.evaluate(() => window.botkins.voiceSettings());

  // ---- Settings › Voice opens, shows its sections, and saves a choice.
  await button("Settings").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tablist", { name: "Settings" }).getByRole("tab", { name: "Voice", exact: true }).click();
  for (const title of ["Dictation", "Reading aloud", "Live voice", "Keys and servers"]) await expect(settings.locator(".voice-feature-row", { hasText: title })).toBeVisible();
  assert.equal((await voice()).stt.provider, "device", "dictation starts on this computer's own");
  assert.equal((await voice()).live.provider, null, "no live voice is chosen at first");
  await settings.locator(".voice-feature-row", { hasText: "Dictation" }).click();
  await expect(settings.locator("h2", { hasText: "Dictation" })).toBeVisible();
  // The local engine isn't built: it is listed, and says how a local server is used instead.
  await expect(settings.getByLabel("Speech to text", { exact: true }).locator("option", { hasText: "not available yet" })).toBeDisabled();
  await settings.getByLabel("Speech to text", { exact: true }).selectOption("openai");
  await expect.poll(async () => (await voice()).stt.provider).toBe("openai");
  await expect(settings.getByRole("button", { name: "Set up OpenAI", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Set up OpenAI", exact: true }).click();
  await expect(settings.locator("h2", { hasText: "Keys and servers" })).toBeVisible();

  // ---- A key is saved, then shows only as Saved. Its text is nowhere the page can see.
  await settings.getByLabel("OpenAI key", { exact: true }).fill(KEY);
  await settings.getByRole("button", { name: "Save OpenAI key", exact: true }).click();
  await expect(settings.getByRole("status", { name: "OpenAI key is saved" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Replace OpenAI key", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Remove OpenAI key", exact: true })).toBeVisible();
  assert.equal((await voice()).providers.openai.hasKey, true);
  const pageText = await page.content();
  const inputs = await page.evaluate(() => [...document.querySelectorAll("input, textarea")].map((el) => el.value).join("\n"));
  const visible = JSON.stringify([await voice(), await page.evaluate(() => window.botkins.snapshot())]);
  for (const [where, text] of [["page", pageText], ["fields", inputs], ["the app's state", visible], ["the workspace file", readFileSync(join(dir, "data", "workspace.json"), "utf8")]])
    assert.ok(!text.includes(KEY) && !text.includes(KEY.slice(3, 20)), "the key is not in " + where);
  // The stand-in server takes the place of OpenAI's address (a plain address is allowed for this computer).
  // A key is kept with the address it was given for: the change of address removes the saved key,
  // the page says so, and the key is given again for the new address.
  const address = settings.getByLabel("Address", { exact: true }).first();
  await address.fill(base);
  await address.press("Enter");
  await expect.poll(async () => (await voice()).providers.openai.baseUrl).toBe(base);
  assert.equal((await voice()).providers.openai.hasKey, false, "the key did not follow to an address it was not given for");
  await expect(settings.getByText("The saved key was removed because the address changed. Enter the key for the new address.")).toBeVisible();
  await settings.getByLabel("OpenAI key", { exact: true }).fill(KEY);
  await settings.getByRole("button", { name: "Save OpenAI key", exact: true }).click();
  await expect(settings.getByRole("status", { name: "OpenAI key is saved" })).toBeVisible();
  await expect(settings.getByText("The saved key was removed because the address changed.", { exact: false })).toHaveCount(0);
  assert.equal((await voice()).providers.openai.hasKey, true);
  // Reading aloud through "OpenAI": the stand-in's audio comes back in parts.
  await settings.locator(".voice-back").click();
  await settings.locator(".voice-feature-row", { hasText: "Reading aloud" }).click();
  await settings.getByLabel("Text to speech", { exact: true }).selectOption("openai");
  await expect.poll(async () => (await voice()).tts.provider).toBe("openai");
  const spoken = await page.evaluate(async () => {
    const answer = await window.botkins.speak("# Hi\n\nRead **this** please. See https://example.com/page");
    return "parts" in answer ? answer.parts.map((p) => [p.format, p.audio.length]) : answer;
  });
  assert.deepEqual(spoken, [["wav", 44 + 8000]]);
  const said = heard.find((h) => h.path === "/v1/audio/speech");
  assert.ok(said && said.auth === "Bearer " + KEY, "the key goes only to the provider, from the main process");
  assert.ok(!said.text.includes("example.com") && !said.text.includes("**") && said.text.includes("Read this please"), "Markdown and link addresses are not read: " + said.text);
  await settings.getByRole("button", { name: "Play a sample", exact: true }).click();
  await expect.poll(() => heard.filter((h) => h.path === "/v1/audio/speech").length).toBe(2);
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  // ---- The composer on Home: Live Voice while empty, Send once there is text.
  await expect(button("Live voice")).toBeVisible();
  await expect(button("Send message")).toHaveCount(0);
  await entry().fill("hello");
  await expect(button("Send message")).toBeVisible();
  await expect(button("Live voice")).toHaveCount(0);
  await entry().fill("");
  await expect(button("Live voice")).toBeVisible();
  // No live voice chosen: a note, and a way to Settings › Voice. No chat is made for it.
  const chatsBefore = (await page.evaluate(() => window.botkins.snapshot())).chats.length;
  await button("Live voice").click();
  await expect(page.getByText("Live voice needs a voice to talk with. Choose one in Settings › Voice.")).toBeVisible();
  assert.equal((await page.evaluate(() => window.botkins.snapshot())).chats.length, chatsBefore);
  await button("Choose in Settings › Voice").click();
  await expect(settings.getByRole("tab", { name: "Voice", exact: true })).toHaveAttribute("aria-selected", "true");
  await settings.locator(".voice-feature-row", { hasText: "Live voice" }).click();
  // A live voice is chosen but its key isn't there: the note says so, and no chat or microphone is opened.
  await settings.getByLabel("Live voice by", { exact: true }).selectOption("gemini");
  await expect.poll(async () => (await voice()).live.provider).toBe("gemini");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await button("Live voice").click();
  await expect(page.getByText("Live voice by Gemini needs a Gemini key. Add it in Settings › Voice.")).toBeVisible();
  assert.equal((await page.evaluate(() => window.botkins.snapshot())).chats.length, chatsBefore);
  await expect(page.getByRole("region", { name: "Live voice" })).toHaveCount(0);
  await button("Choose in Settings › Voice").click();
  await settings.locator(".voice-feature-row", { hasText: "Live voice" }).click();
  await settings.getByLabel("Live voice by", { exact: true }).selectOption("");
  await expect.poll(async () => (await voice()).live.provider).toBe(null);
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  // ---- In a chat: Stop during a turn, as before. The window is told the chat works, as the app tells it.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("open-chat", "chat-pip"));
  await expect(page.locator(".messages strong", { hasText: "prune" })).toBeVisible();
  await expect(button("Live voice")).toBeVisible();
  const working = async (on) => {
    const snapshot = await page.evaluate(() => window.botkins.snapshot());
    if (on) snapshot.streams = { ...snapshot.streams, "chat-pip": "" };
    await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send("changed", s), snapshot);
  };
  await working(true);
  await expect(button("Stop reply")).toBeVisible();
  await expect(button("Live voice")).toHaveCount(0);
  await expect(button("Send message")).toHaveCount(0);
  await entry().fill("and then?");
  await expect(button("Stop reply")).toBeVisible();
  await expect(button("Queue message")).toBeVisible();
  await entry().fill("");
  await working(false);
  await expect(button("Live voice")).toBeVisible();
  await expect(button("Stop reply")).toHaveCount(0);

  // ---- Dictation through "OpenAI": record, Done, and the words land in the message box, not sent.
  await entry().fill("Remind me to");
  await entry().press("End");
  await button("Dictate").click();
  await expect(page.getByRole("status", { name: "Recording" })).toBeVisible();
  await page.waitForTimeout(700);
  await button("Done").click();
  await expect(entry()).toHaveValue("Remind me to " + SPOKEN);
  const recording = heard.find((h) => h.path === "/v1/audio/transcriptions");
  assert.ok(recording && recording.size > 1000 && /multipart\/form-data/.test(recording.type) && recording.text.includes("audio/webm"), "a webm recording went to the stand-in");
  assert.equal((await page.evaluate(() => window.botkins.snapshot())).chats.find((c) => c.id === "chat-pip").messages.length, 2, "dictation sends nothing by itself");
  // Cancel drops a recording without sending it.
  const before = heard.length;
  await button("Dictate").click();
  await expect(page.getByRole("status", { name: "Recording" })).toBeVisible();
  await button("Cancel").click();
  await expect(page.getByRole("status", { name: "Recording" })).toHaveCount(0);
  assert.equal(heard.length, before);
  await entry().fill("");

  // ---- Read aloud on a reply, through the stand-in.
  const reply = page.locator(".messages article.assistant").last();
  await reply.hover();
  await reply.getByRole("button", { name: "Read aloud", exact: true }).click();
  await expect.poll(() => heard.filter((h) => h.path === "/v1/audio/speech").length).toBe(3);
  const prune = heard.filter((h) => h.path === "/v1/audio/speech").at(-1);
  assert.ok(prune.text.includes("Next: prune the roses. See the guide") && !prune.text.includes("example.com"), prune.text);

  // ---- The live voice's capture: 16-bit samples at the rate asked for, under the page's rules.
  const captured = await page.evaluate(async () => {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(new URL("./pcm-capture.js", document.baseURI).href);
    const node = new AudioWorkletNode(ctx, "botkins-pcm-capture", { processorOptions: { rate: 16000 } });
    ctx.createMediaStreamSource(mic).connect(node);
    const quiet = ctx.createGain();
    quiet.gain.value = 0;
    node.connect(quiet).connect(ctx.destination);
    const chunks = await new Promise((resolve) => {
      const got = [];
      node.port.onmessage = (e) => {
        got.push(e.data.byteLength);
        if (got.length === 10) resolve(got);
      };
    });
    for (const t of mic.getTracks()) t.stop();
    await ctx.close();
    return chunks;
  });
  assert.ok(captured.every((n) => n === 640 * 2), "40 ms of 16 kHz, 16-bit: " + captured.join(","));
  // The page may use the microphone and nothing more: the camera is refused (desktop/main.mjs).
  const camera = await page.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }).then(() => "allowed", (e) => e.name));
  assert.equal(camera, "NotAllowedError");

  // ---- Nothing else reached the stand-in, and the voice file is the link's own.
  assert.ok(heard.every((h) => h.path === "/v1/audio/transcriptions" || h.path === "/v1/audio/speech"), heard.map((h) => h.path).join(","));
  assert.ok(readdirSync(join(dir, "data", "link")).includes("voice.json"));
  assert.deepEqual(errors, []);
  console.log("voice smoke: ok");
} finally {
  await app?.close().catch(() => {});
  server.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
