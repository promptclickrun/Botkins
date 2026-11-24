// Voice: speech to text, text to speech and live sessions, for every provider. No test touches the
// network: most use a fake `fetch` that plays each provider and records the exact request it got;
// a few start a local node:http server and point the module at it, so the real multipart and JSON
// bytes go over a real socket. Run by `npm test` (tsx).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ackFirstRule, ASK_BOT_DESCRIPTION, botVoiceField, cleanBotVoice, LIVE_LIMITS, liveContextOf, liveInstructions, liveTranscript, Voice, wavFromPcm } from "../link-host/voice.mjs";
import { remoteArgs } from "../link-host/methods.mjs";
import { missing } from "../src/features/voice/choices";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { LinkHost } from "../link-host/server.mjs";

const folders: string[] = [];
const scratch = () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "botkins-voice-")));
  folders.push(folder);
  return folder;
};
const closers: (() => void)[] = [];
after(() => {
  for (const close of closers) close();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const KEY = "sk-test-0123456789abcdefghij";
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.alloc(40, 7)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(30, 9)]);
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

type Seen = { url: URL; method: string; headers: Headers; body: any; signal: AbortSignal };
type Handler = (seen: Seen) => Response | object | Promise<Response | object>;

/** A fake internet: routes are "METHOD host/path"; a handler gets what was sent and answers. */
function fake(routes: Record<string, Handler>) {
  const seen: Seen[] = [];
  const fetch = async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const entry: Seen = { url: u, method: (init.method ?? "GET").toUpperCase(), headers: new Headers(init.headers), body: init.body, signal: init.signal as AbortSignal };
    seen.push(entry);
    const handler = routes[`${entry.method} ${u.host}${u.pathname}`];
    if (!handler) throw new Error("No route for " + entry.method + " " + u.host + u.pathname);
    const answer = await handler(entry);
    return answer instanceof Response ? answer : Response.json(answer);
  };
  return { seen, fetch, last: () => seen[seen.length - 1] };
}
const say = (status: number, body: unknown) => Response.json(body, { status });
const json = (seen: Seen) => JSON.parse(String(seen.body));
const fields = (seen: Seen) => Object.fromEntries([...(seen.body as FormData).entries()].map(([k, v]) => [k, typeof v === "string" ? v : "(file)"]));

function make(routes: Record<string, Handler> = {}, extra: Record<string, unknown> = {}) {
  const net = fake(routes);
  const dir = scratch();
  const voice = new Voice({ dir, fetch: net.fetch, now: () => NOW, ...extra });
  return { voice, net, dir, file: join(dir, "voice.json") };
}

/** A real server on this computer that records what it is sent. */
async function serve(answer: (req: { method: string; url: string; headers: Record<string, any>; body: Buffer }) => { status?: number; type?: string; body: Buffer | string }) {
  const seen: { method: string; url: string; headers: Record<string, any>; body: Buffer }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(entry);
      const out = answer(entry);
      res.writeHead(out.status ?? 200, { "content-type": out.type ?? "application/json" });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => server.close());
  return { seen, origin: `http://127.0.0.1:${(server.address() as any).port}` };
}
const parseForm = (entry: { headers: Record<string, any>; body: Buffer }) => new Response(entry.body, { headers: { "content-type": entry.headers["content-type"] } }).formData();

const protect = (text: string) => "wrapped:" + Buffer.from(text).toString("base64");
const reveal = (text: string) => {
  assert.ok(text.startsWith("wrapped:"), "a wrapped value");
  return Buffer.from(text.slice(8), "base64").toString();
};

// ── Settings and keys ─────────────────────────────────────────────────────────────────────────

test("settings start with the device's own speech and no live choice, and never hold a key", () => {
  const { voice } = make();
  const s = voice.settings();
  assert.deepEqual(s.stt, { provider: "device" });
  assert.equal(s.tts.provider, "device");
  assert.equal(s.tts.speed, 1);
  assert.deepEqual(s.live, { provider: null });
  assert.equal(s.providers.openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(s.providers.openai.hasKey, false);
  assert.deepEqual(s.providers.local, { available: false, models: [] });
  assert.deepEqual(s.providers.codex, { available: false, signedIn: false });
  voice.setKey("openai", KEY);
  voice.setKey("gemini", "AIza-gemini-key-123456");
  const after = voice.settings();
  assert.equal(after.providers.openai.hasKey, true);
  assert.equal(after.providers.gemini.hasKey, true);
  assert.equal(JSON.stringify(after).includes(KEY), false);
  assert.equal(JSON.stringify(after).includes("AIza-gemini"), false);
});

test("settings round trip, reload from disk, and onChange", () => {
  const dir = scratch();
  let changes = 0;
  const voice = new Voice({ dir, onChange: () => changes++ });
  voice.set({
    stt: { provider: "elevenlabs", model: "scribe_v2", language: "en-US" },
    tts: { provider: "openai", model: "gpt-4o-mini-tts", voice: "cedar", speed: 1.25, auto: true },
    live: { provider: "gemini", model: "gemini-3.8-live", voice: "Puck" },
    providers: {
      azure: { kind: "speech", region: "swedencentral", sttDeployment: "stt1", ttsDeployment: "tts1", apiVersion: "2025-04-01-preview" },
      custom: { baseUrl: "http://192.168.1.20:8000/v1/" },
      elevenlabs: { agentId: "agent_abc" },
    },
  });
  assert.equal(changes, 1);
  voice.setKey("custom", "local-key-abcdef");
  assert.equal(changes, 2);
  const before = voice.settings();
  assert.equal(before.providers.custom.baseUrl, "http://192.168.1.20:8000/v1");
  assert.equal(before.tts.speed, 1.25);
  // Sending settings() back whole is fine: hasKey, local and codex are read only.
  voice.set(before);
  assert.deepEqual(voice.settings(), before);
  const again = new Voice({ dir });
  assert.deepEqual(again.settings(), before);
  assert.equal(again.settings().providers.custom.hasKey, true);
  // The file is private, and written whole.
  assert.equal(statSync(join(dir, "voice.json")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(dir, "voice.json.tmp")), false);
});

test("a section is merged, null clears, and another provider drops the old model and voice", () => {
  const { voice } = make();
  voice.set({ tts: { provider: "openai", model: "tts-1", voice: "nova", speed: 1.5 } });
  voice.set({ tts: { speed: 1.2 } });
  assert.deepEqual(voice.settings().tts, { provider: "openai", model: "tts-1", voice: "nova", speed: 1.2, auto: false });
  voice.set({ tts: { voice: null } });
  assert.equal(voice.settings().tts.voice, undefined);
  voice.set({ tts: { provider: "elevenlabs" } });
  assert.deepEqual(voice.settings().tts, { provider: "elevenlabs", speed: 1.2, auto: false });
  voice.set({ live: { provider: "openai" } });
  voice.set({ live: { provider: null } });
  assert.equal(voice.settings().live.provider, null);
});

test("bad settings are refused with a plain sentence and change nothing", () => {
  const { voice, file } = make();
  voice.set({ tts: { provider: "openai", voice: "marin" } });
  const kept = voice.settings();
  const refused = (patch: unknown, message: RegExp | string) => {
    assert.throws(() => voice.set(patch), (error: Error) => (typeof message === "string" ? error.message === message : message.test(error.message)));
    assert.deepEqual(voice.settings(), kept);
  };
  refused(null, "Those voice settings can't be saved.");
  refused({ stt: { provider: "gemini" } }, "That speech to text choice isn't supported.");
  refused({ tts: { provider: "nope" } }, "That text to speech choice isn't supported.");
  refused({ live: { provider: "custom" } }, "That live voice choice isn't supported.");
  refused({ tts: { speed: 3 } }, "Speed is between 0.5 and 2.");
  refused({ tts: { speed: "fast" } }, "Speed is between 0.5 and 2.");
  refused({ tts: { auto: "yes" } }, "Reading replies aloud is on or off.");
  refused({ stt: { language: "not a language!" } }, /language/);
  refused({ tts: { voice: "x".repeat(300) } }, /voice/);
  refused({ providers: { openai: { baseUrl: "ftp://example.com" } } }, "Use an https address for the OpenAI address.");
  refused({ providers: { openai: { baseUrl: "http://example.com/v1" } } }, "Use an https address for the OpenAI address.");
  refused({ providers: { openai: { baseUrl: "https://user:pw@example.com/v1" } } }, "That OpenAI address isn't a valid web address.");
  refused({ providers: { openai: { baseUrl: "https://example.com/v1?x=1" } } }, "That OpenAI address isn't a valid web address.");
  refused({ providers: { openai: { baseUrl: "not a url" } } }, "That OpenAI address isn't a valid web address.");
  refused({ providers: { azure: { kind: "other" } } }, "Azure is either OpenAI audio or Speech.");
  refused({ providers: { azure: { region: "Not A Region" } } }, /region/);
  refused({ providers: { azure: { sttDeployment: "../../x" } } }, /deployment/);
  refused({ providers: { azure: { endpoint: "http://example.com" } } }, "Use an https address for the Azure endpoint.");
  refused({ providers: { elevenlabs: { agentId: "agent id with spaces" } } }, /agent id/);
  refused({ providers: { custom: { baseUrl: "javascript:alert(1)" } } }, /server address/);
  refused({ providers: { openai: "x" } }, "Those OpenAI settings can't be saved.");
  // A change on disk is the same as the one in memory: nothing half-saved.
  assert.equal(JSON.parse(readFileSync(file, "utf8")).settings.tts.voice, "marin");
  // This computer may speak plain http; a server of the person's own may too.
  voice.set({ providers: { openai: { baseUrl: "http://localhost:9999/v1" }, custom: { baseUrl: "http://my-mac.local:8080" } } });
});

test("a key is saved, removed, checked, and never comes back", () => {
  const { voice } = make();
  for (const bad of ["", "abc", "has space in it", "line\nbreak-key", 5, "x".repeat(5000)]) assert.throws(() => voice.setKey("openai", bad as string), { message: "That key isn't valid." });
  assert.throws(() => voice.setKey("codex", KEY), { message: "That provider doesn't take a key." });
  assert.throws(() => voice.setKey("local", KEY), { message: "That provider doesn't take a key." });
  voice.setKey("elevenlabs", "  xi-eleven-key-12345  ");
  assert.equal(voice.settings().providers.elevenlabs.hasKey, true);
  voice.setKey("elevenlabs", null);
  assert.equal(voice.settings().providers.elevenlabs.hasKey, false);
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(voice))) assert.notEqual(name, "getKey");
});

test("keys survive a reload and are wrapped on disk when protect is given", async () => {
  const dir = scratch();
  const net = fake({ "POST api.openai.com/v1/audio/transcriptions": () => ({ text: "hi" }) });
  const a = new Voice({ dir, protect, reveal, fetch: net.fetch });
  a.setKey("openai", KEY);
  a.set({ stt: { provider: "openai" } });
  const raw = readFileSync(join(dir, "voice.json"), "utf8");
  assert.equal(raw.includes(KEY), false);
  assert.ok(raw.includes("wrapped:"));
  assert.equal(JSON.parse(raw).wrapped, true);
  const b = new Voice({ dir, protect, reveal, fetch: net.fetch });
  assert.equal(b.settings().providers.openai.hasKey, true);
  await b.transcribe({ audio: WAV, format: "wav" });
  assert.equal(net.last().headers.get("authorization"), "Bearer " + KEY);
  // Without a keychain the same key is kept as it is, like the credentials vault in development.
  const plain = scratch();
  const c = new Voice({ dir: plain });
  c.setKey("openai", KEY);
  assert.equal(JSON.parse(readFileSync(join(plain, "voice.json"), "utf8")).keys.openai, KEY);
});

test("a file that can't be read, or a wrapped key that can't be opened, locks saving and is left alone", () => {
  const dir = scratch();
  const file = join(dir, "voice.json");
  writeFileSync(file, "{ this is not json");
  const damaged = new Voice({ dir });
  assert.equal(damaged.settings().stt.provider, "device");
  assert.throws(() => damaged.set({ tts: { provider: "openai" } }), { message: "The saved voice settings can't be read." });
  assert.throws(() => damaged.setKey("openai", KEY), { message: "The saved voice settings can't be read." });
  assert.equal(readFileSync(file, "utf8"), "{ this is not json");
  // Wrapped by a keychain this run doesn't have.
  const other = scratch();
  new Voice({ dir: other, protect, reveal }).setKey("openai", KEY);
  const before = readFileSync(join(other, "voice.json"), "utf8");
  const locked = new Voice({ dir: other });
  assert.throws(() => locked.set({ tts: { speed: 1.5 } }), { message: "The saved voice keys can't be opened on this computer." });
  assert.equal(readFileSync(join(other, "voice.json"), "utf8"), before);
  // A keychain that fails on save saves nothing.
  const fails = new Voice({ dir: scratch(), protect: () => { throw new Error("no keychain"); }, reveal });
  assert.throws(() => fails.setKey("openai", KEY), { message: "The computer's keychain didn't answer, so nothing was saved." });
  assert.equal(fails.settings().providers.openai.hasKey, false);
  // A file that is not there yet is a fresh start, in a folder that is made.
  const fresh = join(scratch(), "nested", "voice");
  new Voice({ dir: fresh }).set({ tts: { provider: "openai" } });
  assert.ok(existsSync(join(fresh, "voice.json")));
  chmodSync(fresh, 0o700);
});

test("a hand-edited file can't make a bad address", () => {
  const dir = scratch();
  writeFileSync(join(dir, "voice.json"), JSON.stringify({ version: 1, settings: { tts: { provider: "openai", voice: "nova", speed: 1.5 }, stt: { provider: "nonsense" }, providers: { openai: { baseUrl: "file:///etc/passwd" } } }, keys: { openai: KEY, bogus: "x" } }));
  const voice = new Voice({ dir });
  const s = voice.settings();
  assert.equal(s.tts.voice, "nova");
  assert.equal(s.stt.provider, "device");
  assert.equal(s.providers.openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(s.providers.openai.hasKey, true);
});

// ── The device, and limits ────────────────────────────────────────────────────────────────────

test("the device does its own speech", async () => {
  const { voice, net } = make();
  await assert.rejects(voice.transcribe({ audio: WAV, format: "wav" }), { message: "This device does its own speech." });
  await assert.rejects(voice.speak({ text: "hello" }), { message: "This device does its own speech." });
  assert.equal(net.seen.length, 0);
  assert.deepEqual(await voice.options("stt", "device"), { models: [], voices: [] });
});

test("limits: audio size and format, text length and speed, with a plain sentence each", async () => {
  const { voice, net } = make({ "POST api.openai.com/v1/audio/transcriptions": () => ({ text: "x" }), "POST api.openai.com/v1/audio/speech": () => new Response(MP3) });
  voice.setKey("openai", KEY);
  voice.set({ stt: { provider: "openai" }, tts: { provider: "openai" } });
  await assert.rejects(voice.transcribe({ audio: Buffer.alloc(0), format: "wav" }), { message: "There is no audio to transcribe." });
  await assert.rejects(voice.transcribe({ audio: "text" as any, format: "wav" }), { message: "There is no audio to transcribe." });
  await assert.rejects(voice.transcribe({ audio: Buffer.alloc(25 * 1024 * 1024 + 1), format: "wav" }), { message: "That recording is over 25 MB." });
  await assert.rejects(voice.transcribe({ audio: WAV, format: "ogg" as any }), { message: "Use a wav, m4a, mp3 or webm recording." });
  await assert.rejects(voice.transcribe({ audio: WAV, format: "wav", language: "not valid" }), { message: "That language isn't valid." });
  await voice.transcribe({ audio: Buffer.alloc(25 * 1024 * 1024), format: "wav" });
  await assert.rejects(voice.speak({ text: "" }), { message: "There is nothing to read." });
  await assert.rejects(voice.speak({ text: "   " }), { message: "There is nothing to read." });
  await assert.rejects(voice.speak({ text: "a".repeat(4001) }), /too long to read at once/);
  await assert.rejects(voice.speak({ text: "hi", speed: 2.5 }), { message: "Speed is between 0.5 and 2." });
  await assert.rejects(voice.speak({ text: "hi", speed: 0.1 }), { message: "Speed is between 0.5 and 2." });
  await assert.rejects(voice.speak({ text: "hi", voice: "../x" }), { message: "That voice isn't valid." });
  assert.equal(net.seen.length, 1); // only the 25 MB one went out
  await voice.speak({ text: "a".repeat(4000) });
  assert.equal(net.seen.length, 2);
});

test("a missing key or setting is a plain sentence that says where to fix it", async () => {
  const { voice } = make();
  for (const [provider, message] of [
    ["openai", "Add an OpenAI key in Settings › Voice first."],
    ["azure", "Add an Azure key in Settings › Voice first."],
    ["elevenlabs", "Add an ElevenLabs key in Settings › Voice first."],
  ] as const) {
    voice.set({ stt: { provider }, tts: { provider } });
    await assert.rejects(voice.transcribe({ audio: WAV, format: "wav" }), { message });
    await assert.rejects(voice.speak({ text: "hi" }), { message });
  }
  voice.set({ tts: { provider: "gemini" } });
  await assert.rejects(voice.speak({ text: "hi" }), { message: "Add a Gemini key in Settings › Voice first." });
  voice.set({ stt: { provider: "custom" }, tts: { provider: "custom" } });
  await assert.rejects(voice.transcribe({ audio: WAV, format: "wav" }), { message: "Add the address of your speech server in Settings › Voice first." });
  voice.setKey("azure", "azure-key-0123456789");
  voice.set({ stt: { provider: "azure" }, tts: { provider: "azure" } });
  await assert.rejects(voice.transcribe({ audio: WAV, format: "wav" }), { message: "Add your Azure endpoint and speech to text deployment in Settings › Voice first." });
  await assert.rejects(voice.speak({ text: "hi" }), { message: "Add your Azure endpoint and text to speech deployment in Settings › Voice first." });
  voice.set({ providers: { azure: { kind: "speech" } } });
  await assert.rejects(voice.speak({ text: "hi" }), { message: "Add your Azure Speech region or endpoint in Settings › Voice first." });
  await assert.rejects(voice.live({}), { message: "Pick a live voice in Settings › Voice first." });
  await assert.rejects(voice.live({ provider: "openai" }), { message: "Add an OpenAI key in Settings › Voice first." });
  await assert.rejects(voice.options("stt", "gemini"), { message: "That provider doesn't do speech to text." });
  await assert.rejects(voice.options("live", "custom"), { message: "That provider doesn't do live voice." });
  await assert.rejects(voice.options("music" as any, "openai"), { message: "That isn't a kind of voice." });
});

// ── Speech to text ────────────────────────────────────────────────────────────────────────────

test("OpenAI transcription: route, bearer key, model, languages[] for gpt-transcribe, language for older models", async () => {
  const { voice, net } = make({ "POST api.openai.com/v1/audio/transcriptions": () => ({ text: " Bonjour tout le monde. ", languages: [{ code: "fr" }] }) });
  voice.setKey("openai", KEY);
  voice.set({ stt: { provider: "openai", language: "fr-FR" } });
  assert.deepEqual(await voice.transcribe({ audio: WAV, format: "m4a" }), { text: "Bonjour tout le monde." });
  const seen = net.last();
  assert.equal(seen.method, "POST");
  assert.equal(seen.headers.get("authorization"), "Bearer " + KEY);
  assert.deepEqual(fields(seen), { file: "(file)", model: "gpt-transcribe", "languages[]": "fr" });
  const file = (seen.body as FormData).get("file") as File;
  assert.equal(file.name, "audio.m4a");
  assert.equal(file.type, "audio/mp4");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), WAV);
  assert.ok(seen.signal instanceof AbortSignal);
  voice.set({ stt: { model: "whisper-1" } });
  await voice.transcribe({ audio: WAV, format: "mp3", language: "zh-CN" });
  assert.deepEqual(fields(net.last()), { file: "(file)", model: "whisper-1", language: "zh-cn" });
  assert.equal(((net.last().body as FormData).get("file") as File).type, "audio/mpeg");
  voice.set({ stt: { language: null } });
  await voice.transcribe({ audio: WAV, format: "webm" });
  assert.deepEqual(fields(net.last()), { file: "(file)", model: "whisper-1" });
});

/** `ms` of 16 kHz mono PCM16: a steady tone `loud` high (0 is silence). */
const clip = (ms: number, loud: number) => {
  const pcm = Buffer.alloc((16 * ms) * 2);
  if (loud) for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(loud * Math.sin(i / 3)), i * 2);
  return wavFromPcm(pcm, 16000);
};

test("transcription never asks the provider about a clip that is too short or has no speech in it", async () => {
  // A silent clip is what makes a speech model invent a word ("Qué"), and a language to go with it.
  const { voice, net } = make({ "POST api.openai.com/v1/audio/transcriptions": () => ({ text: "Qué" }) });
  voice.setKey("openai", KEY);
  voice.set({ stt: { provider: "openai" } });
  assert.deepEqual(await voice.transcribe({ audio: clip(1000, 0), format: "wav" }), { text: "" }, "silence");
  assert.deepEqual(await voice.transcribe({ audio: clip(1000, 100), format: "wav" }), { text: "" }, "room noise");
  assert.deepEqual(await voice.transcribe({ audio: clip(100, 8000), format: "wav" }), { text: "" }, "a tap");
  assert.equal(net.seen.length, 0);
  assert.deepEqual(await voice.transcribe({ audio: clip(1000, 8000), format: "wav" }), { text: "Qué" }, "speech goes through");
  assert.equal(net.seen.length, 1);
  // A recording this module can't read (not a PCM WAV) is the provider's to judge.
  await voice.transcribe({ audio: WAV, format: "wav" });
  await voice.transcribe({ audio: MP3, format: "mp3" });
  assert.equal(net.seen.length, 3);
});

test("Azure OpenAI transcription: deployment route, api-version, api-key header", async () => {
  const { voice, net } = make({ "POST contoso.openai.azure.com/openai/deployments/whisper%20one/audio/transcriptions": () => ({ text: "azure words" }), "POST contoso.openai.azure.com/openai/deployments/stt1/audio/transcriptions": () => ({ text: "azure words" }) });
  voice.set({ stt: { provider: "azure", language: "en-GB" }, providers: { azure: { kind: "openai", endpoint: "https://contoso.openai.azure.com/", sttDeployment: "stt1" } } });
  voice.setKey("azure", "azure-key-0123456789");
  assert.deepEqual(await voice.transcribe({ audio: WAV, format: "wav" }), { text: "azure words" });
  const seen = net.last();
  assert.equal(seen.url.pathname, "/openai/deployments/stt1/audio/transcriptions");
  assert.equal(seen.url.searchParams.get("api-version"), "2025-04-01-preview");
  assert.equal(seen.headers.get("api-key"), "azure-key-0123456789");
  assert.equal(seen.headers.get("authorization"), null);
  assert.deepEqual(fields(seen), { file: "(file)", model: "stt1", language: "en" });
  voice.set({ providers: { azure: { apiVersion: "2024-10-21" } } });
  await voice.transcribe({ audio: WAV, format: "wav" });
  assert.equal(net.last().url.searchParams.get("api-version"), "2024-10-21");
});

test("Azure Speech transcription: fast transcription route, subscription key, definition", async () => {
  const { voice, net } = make({
    "POST swedencentral.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe": () => ({ durationMilliseconds: 1000, combinedPhrases: [{ text: "first part." }, { text: "second part." }] }),
    "POST contoso.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe": () => ({ combinedPhrases: [{ text: "custom host" }] }),
  });
  voice.set({ stt: { provider: "azure", language: "sv-SE" }, providers: { azure: { kind: "speech", region: "swedencentral" } } });
  voice.setKey("azure", "azure-key-0123456789");
  assert.deepEqual(await voice.transcribe({ audio: WAV, format: "mp3" }), { text: "first part. second part." });
  let seen = net.last();
  assert.equal(seen.url.searchParams.get("api-version"), "2025-10-15");
  assert.equal(seen.headers.get("ocp-apim-subscription-key"), "azure-key-0123456789");
  assert.equal((seen.body as FormData).get("definition"), JSON.stringify({ locales: ["sv-SE"] }));
  assert.equal(((seen.body as FormData).get("audio") as File).name, "audio.mp3");
  voice.set({ stt: { language: null }, providers: { azure: { endpoint: "https://contoso.cognitiveservices.azure.com" } } });
  // The key was given for the region's address. For another address it has to be given again.
  assert.equal(voice.settings().providers.azure.hasKey, false);
  await assert.rejects(voice.transcribe({ audio: WAV, format: "wav" }), /key/i);
  voice.setKey("azure", "azure-key-0123456789");
  assert.deepEqual(await voice.transcribe({ audio: WAV, format: "wav" }), { text: "custom host" });
  seen = net.last();
  assert.equal(seen.url.host, "contoso.cognitiveservices.azure.com");
  assert.equal((seen.body as FormData).get("definition"), JSON.stringify({ locales: [] }));
});

test("ElevenLabs transcription: route, xi-api-key, model_id, language_code", async () => {
  const { voice, net } = make({ "POST api.elevenlabs.io/v1/speech-to-text": () => ({ language_code: "eng", language_probability: 0.99, text: "scribe says hi", words: [] }) });
  voice.setKey("elevenlabs", "xi-eleven-key-12345");
  voice.set({ stt: { provider: "elevenlabs" } });
  assert.deepEqual(await voice.transcribe({ audio: WAV, format: "wav" }), { text: "scribe says hi" });
  assert.equal(net.last().headers.get("xi-api-key"), "xi-eleven-key-12345");
  assert.deepEqual(fields(net.last()), { model_id: "scribe_v2", file: "(file)" });
  voice.set({ stt: { model: "scribe_v3", language: "de" } });
  await voice.transcribe({ audio: WAV, format: "wav" });
  assert.deepEqual(fields(net.last()), { model_id: "scribe_v3", file: "(file)", language_code: "de" });
});

test("a speech server of the person's own: same routes under its address, key optional", async () => {
  const server = await serve((req) => (req.url === "/v1/audio/transcriptions" ? { body: JSON.stringify({ text: "from my server" }) } : { status: 404, body: "{}" }));
  const { voice } = make({}, { fetch: undefined });
  voice.set({ stt: { provider: "custom", model: "small" }, providers: { custom: { baseUrl: server.origin + "/v1" } } });
  assert.deepEqual(await voice.transcribe({ audio: WAV, format: "wav", language: "en" }), { text: "from my server" });
  const entry = server.seen[0];
  assert.equal(entry.method, "POST");
  assert.equal(entry.headers.authorization, undefined);
  assert.match(entry.headers["content-type"], /^multipart\/form-data; boundary=/);
  const form = await parseForm(entry);
  assert.equal(form.get("model"), "small");
  assert.equal(form.get("language"), "en");
  assert.deepEqual(Buffer.from(await (form.get("file") as File).arrayBuffer()), WAV);
  // With a key, it is sent as a bearer.
  voice.setKey("custom", "custom-key-0123456789");
  await voice.transcribe({ audio: WAV, format: "wav" });
  assert.equal(server.seen[1].headers.authorization, "Bearer custom-key-0123456789");
});

test("real sockets: OpenAI and Azure OpenAI go out as real multipart and JSON", async () => {
  const server = await serve((req) => {
    if (req.url?.startsWith("/openai/deployments/tts1/audio/speech")) return { type: "audio/mpeg", body: MP3 };
    if (req.url === "/v1/audio/speech") return { type: "audio/mpeg", body: MP3 };
    return { body: JSON.stringify({ text: "over a real socket" }) };
  });
  const { voice } = make({}, { fetch: undefined });
  voice.set({
    stt: { provider: "openai" },
    tts: { provider: "openai", voice: "ash", speed: 1.5 },
    providers: { openai: { baseUrl: server.origin + "/v1" }, azure: { kind: "openai", endpoint: server.origin, sttDeployment: "stt1", ttsDeployment: "tts1" } },
  });
  voice.setKey("openai", KEY);
  voice.setKey("azure", "azure-key-0123456789");
  assert.deepEqual(await voice.transcribe({ audio: WAV, format: "wav" }), { text: "over a real socket" });
  assert.equal(server.seen[0].url, "/v1/audio/transcriptions");
  assert.equal(server.seen[0].headers.authorization, "Bearer " + KEY);
  assert.equal((await parseForm(server.seen[0])).get("model"), "gpt-transcribe");
  const spoken = await voice.speak({ text: "Say this." });
  assert.deepEqual(spoken, { audio: MP3, format: "mp3" });
  assert.equal(server.seen[1].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(server.seen[1].body.toString()), { model: "gpt-4o-mini-tts", input: "Say this.", voice: "ash", response_format: "mp3", speed: 1.5 });
  voice.set({ stt: { provider: "azure" }, tts: { provider: "azure" } });
  await voice.transcribe({ audio: WAV, format: "wav" });
  assert.equal(server.seen[2].url, "/openai/deployments/stt1/audio/transcriptions?api-version=2025-04-01-preview");
  assert.equal(server.seen[2].headers["api-key"], "azure-key-0123456789");
  await voice.speak({ text: "Azure says this.", voice: "nova" });
  assert.equal(server.seen[3].url, "/openai/deployments/tts1/audio/speech?api-version=2025-04-01-preview");
  assert.equal(server.seen[3].headers["api-key"], "azure-key-0123456789");
  assert.deepEqual(JSON.parse(server.seen[3].body.toString()), { model: "tts1", input: "Azure says this.", voice: "nova", response_format: "mp3", speed: 1.5 });
});

test("local speech goes to the app's helper: wav in, the first installed model, plain sentences for failures", async () => {
  const calls: any[] = [];
  let fail = false;
  const adapter = () => ({
    local: {
      models: () => [
        { id: "big", name: "Big", kind: "stt", installed: false },
        { id: "small", name: "Small", kind: "stt", installed: true },
        { id: "kokoro", name: "Kokoro", kind: "tts", installed: true, voices: [{ id: "af", name: "Af" }] },
        { id: "bad", kind: "stt" },
      ],
      transcribe: async (wav: Buffer, o: any) => {
        calls.push(["stt", wav, o]);
        if (fail) throw new Error("model crashed at /Users/someone/secret");
        return { text: " local words " };
      },
      synthesize: async (text: string, o: any) => {
        calls.push(["tts", text, o]);
        return { audio: WAV };
      },
    },
  });
  const { voice } = make({}, { adapter });
  assert.equal(voice.settings().providers.local.available, true);
  assert.deepEqual(voice.settings().providers.local.models.map((m: any) => m.id), ["big", "small", "kokoro"]);
  voice.set({ stt: { provider: "local", language: "en" }, tts: { provider: "local", voice: "af", speed: 0.8 } });
  assert.deepEqual(await voice.transcribe({ audio: WAV, format: "wav" }), { text: "local words" });
  assert.deepEqual(calls[0], ["stt", WAV, { model: "small", language: "en" }]);
  await assert.rejects(voice.transcribe({ audio: WAV, format: "m4a" }), { message: "Local speech needs a wav recording." });
  assert.deepEqual(await voice.speak({ text: "hello" }), { audio: WAV, format: "wav" });
  assert.deepEqual(calls[1], ["tts", "hello", { model: "kokoro", voice: "af", speed: 0.8 }]);
  voice.set({ stt: { model: "big" } });
  await voice.transcribe({ audio: WAV, format: "wav" });
  assert.equal(calls[2][2].model, "big");
  fail = true;
  await assert.rejects(voice.transcribe({ audio: WAV, format: "wav" }), { message: "The local speech model couldn't read that." });
  assert.deepEqual(await voice.options("stt", "local"), { models: [{ id: "small", name: "Small" }], voices: [] });
  assert.deepEqual(await voice.options("tts", "local"), { models: [{ id: "kokoro", name: "Kokoro" }], voices: [{ id: "af", name: "Af" }] });
  // Without the app's helpers it says so.
  const bare = make();
  bare.voice.set({ stt: { provider: "local" }, tts: { provider: "local" } });
  await assert.rejects(bare.voice.transcribe({ audio: WAV, format: "wav" }), { message: "Local speech isn't available in this app." });
  await assert.rejects(bare.voice.speak({ text: "hi" }), { message: "Local speech isn't available in this app." });
  // With no model installed it says that.
  const empty = make({}, { adapter: () => ({ local: { models: () => [], transcribe: async () => ({ text: "" }), synthesize: async () => ({ audio: WAV }) } }) });
  empty.voice.set({ stt: { provider: "local" } });
  await assert.rejects(empty.voice.transcribe({ audio: WAV, format: "wav" }), { message: "Install a speech to text model in the app first." });
});

// ── Text to speech ────────────────────────────────────────────────────────────────────────────

test("OpenAI speech: JSON body, mp3 asked for, speed only when it isn't 1", async () => {
  const { voice, net } = make({ "POST api.openai.com/v1/audio/speech": () => new Response(MP3, { headers: { "content-type": "audio/mpeg" } }) });
  voice.setKey("openai", KEY);
  voice.set({ tts: { provider: "openai" } });
  assert.deepEqual(await voice.speak({ text: "Hello there." }), { audio: MP3, format: "mp3" });
  let seen = net.last();
  assert.equal(seen.headers.get("authorization"), "Bearer " + KEY);
  assert.equal(seen.headers.get("content-type"), "application/json");
  assert.deepEqual(json(seen), { model: "gpt-4o-mini-tts", input: "Hello there.", voice: "marin", response_format: "mp3" });
  voice.set({ tts: { model: "tts-1-hd", voice: "cedar", speed: 1.75 } });
  await voice.speak({ text: "Faster." });
  assert.deepEqual(json(net.last()), { model: "tts-1-hd", input: "Faster.", voice: "cedar", response_format: "mp3", speed: 1.75 });
  await voice.speak({ text: "Per call.", voice: "sage", speed: 1 });
  assert.deepEqual(json(net.last()), { model: "tts-1-hd", input: "Per call.", voice: "sage", response_format: "mp3" });
});

test("a speech server may answer in wav; anything else it can't play is a plain sentence", async () => {
  let answer: Buffer = WAV;
  const { voice, net } = make({ "POST speech.lan:8000/v1/audio/speech": () => new Response(answer) }, {});
  voice.set({ tts: { provider: "custom", model: "kokoro", voice: "af_heart" }, providers: { custom: { baseUrl: "http://speech.lan:8000/v1" } } });
  assert.deepEqual(await voice.speak({ text: "Hi" }), { audio: WAV, format: "wav" });
  assert.equal(net.last().headers.get("authorization"), null);
  assert.deepEqual(json(net.last()), { model: "kokoro", input: "Hi", voice: "af_heart", response_format: "mp3" });
  answer = Buffer.from("not audio at all");
  await assert.rejects(voice.speak({ text: "Hi" }), { message: "Your speech server sent audio this app can't play." });
  answer = Buffer.alloc(0);
  await assert.rejects(voice.speak({ text: "Hi" }), { message: "Your speech server sent back no audio." });
});

test("Azure OpenAI speech: deployment route, api-key, JSON body with the deployment as the model", async () => {
  const { voice, net } = make({ "POST contoso.openai.azure.com/openai/deployments/tts1/audio/speech": () => new Response(MP3) });
  voice.set({ tts: { provider: "azure" }, providers: { azure: { kind: "openai", endpoint: "https://contoso.openai.azure.com", ttsDeployment: "tts1" } } });
  voice.setKey("azure", "azure-key-0123456789");
  assert.deepEqual(await voice.speak({ text: "Hello" }), { audio: MP3, format: "mp3" });
  const seen = net.last();
  assert.equal(seen.url.searchParams.get("api-version"), "2025-04-01-preview");
  assert.equal(seen.headers.get("api-key"), "azure-key-0123456789");
  assert.deepEqual(json(seen), { model: "tts1", input: "Hello", voice: "alloy", response_format: "mp3" });
});

test("Azure Speech: SSML with the voice's language, rate, escaping and the mp3 output format", async () => {
  const { voice, net } = make({
    "POST swedencentral.tts.speech.microsoft.com/cognitiveservices/v1": () => new Response(MP3),
    "POST contoso.cognitiveservices.azure.com/tts/cognitiveservices/v1": () => new Response(MP3),
  });
  voice.set({ tts: { provider: "azure" }, providers: { azure: { kind: "speech", region: "swedencentral" } } });
  voice.setKey("azure", "azure-key-0123456789");
  assert.deepEqual(await voice.speak({ text: "Fish & chips <now>" }), { audio: MP3, format: "mp3" });
  let seen = net.last();
  assert.equal(seen.headers.get("ocp-apim-subscription-key"), "azure-key-0123456789");
  assert.equal(seen.headers.get("content-type"), "application/ssml+xml");
  assert.equal(seen.headers.get("x-microsoft-outputformat"), "audio-24khz-96kbitrate-mono-mp3");
  assert.equal(seen.headers.get("user-agent"), "Botkins");
  assert.equal(seen.body, "<speak version='1.0' xml:lang='en-US'><voice xml:lang='en-US' name='en-US-JennyNeural'>Fish &amp; chips &lt;now&gt;</voice></speak>");
  await voice.speak({ text: "Slower.", voice: "sv-SE-SofieNeural", speed: 0.75 });
  assert.equal(net.last().body, "<speak version='1.0' xml:lang='sv-SE'><voice xml:lang='sv-SE' name='sv-SE-SofieNeural'><prosody rate=\"0.75\">Slower.</prosody></voice></speak>");
  voice.set({ providers: { azure: { endpoint: "https://contoso.cognitiveservices.azure.com" } } });
  voice.setKey("azure", "azure-key-0123456789");
  await voice.speak({ text: "Custom host." });
  assert.equal(net.last().url.pathname, "/tts/cognitiveservices/v1");
  assert.equal(net.last().url.host, "contoso.cognitiveservices.azure.com");
  // The person's own text can't break out of the markup.
  await voice.speak({ text: "</voice><voice name='x'>'\"" });
  seen = net.last();
  assert.equal(String(seen.body).includes("<voice name='x'>"), false);
});

test("ElevenLabs speech: voice id in the path, mp3 output format, model and speed in the body", async () => {
  const { voice, net } = make({
    "POST api.elevenlabs.io/v1/text-to-speech/voice_9": () => new Response(MP3),
    "GET api.elevenlabs.io/v2/voices": () => ({ voices: [{ voice_id: "voice_9", name: "Nine" }], has_more: false }),
    "GET api.elevenlabs.io/v1/models": () => [{ model_id: "eleven_multilingual_v2", name: "Multilingual v2", can_do_text_to_speech: true }],
  });
  voice.setKey("elevenlabs", "xi-eleven-key-12345");
  voice.set({ tts: { provider: "elevenlabs", voice: "voice_9" } });
  assert.deepEqual(await voice.speak({ text: "Hello" }), { audio: MP3, format: "mp3" });
  let seen = net.last();
  assert.equal(seen.url.searchParams.get("output_format"), "mp3_44100_128");
  assert.equal(seen.headers.get("xi-api-key"), "xi-eleven-key-12345");
  assert.deepEqual(json(seen), { text: "Hello", model_id: "eleven_multilingual_v2" });
  voice.set({ tts: { model: "eleven_flash_v2_5", speed: 1.1 } });
  await voice.speak({ text: "Quick" });
  assert.deepEqual(json(net.last()), { text: "Quick", model_id: "eleven_flash_v2_5", voice_settings: { speed: 1.1 } });
  // No voice chosen: the first of the person's voices is used.
  voice.set({ tts: { voice: null } });
  await voice.speak({ text: "Default voice" });
  assert.equal(net.last().url.pathname, "/v1/text-to-speech/voice_9");
  // A voice id can't change the path.
  await assert.rejects(voice.speak({ text: "x", voice: "voice/../../admin" }), { message: "That voice isn't valid." });
});

test("Gemini speech: interactions route, x-goog-api-key, audio from the last model_output, headerless audio wrapped as wav", async () => {
  const pcm = Buffer.alloc(480, 3);
  let answer: any = { steps: [{ type: "user_input", content: [] }, { type: "model_output", content: [{ type: "audio", data: WAV.toString("base64") }] }] };
  const { voice, net } = make({ "POST generativelanguage.googleapis.com/v1beta/interactions": () => answer });
  voice.setKey("gemini", "AIza-gemini-key-123456");
  voice.set({ tts: { provider: "gemini" } });
  assert.deepEqual(await voice.speak({ text: "Have a wonderful day!", speed: 1.5 }), { audio: WAV, format: "wav" });
  const seen = net.last();
  assert.equal(seen.headers.get("x-goog-api-key"), "AIza-gemini-key-123456");
  assert.deepEqual(json(seen), {
    model: "gemini-3.8-flash-tts",
    input: [{ type: "user_input", content: [{ type: "text", text: "Have a wonderful day!" }] }],
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice: "Kore" }] },
  });
  answer = { steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }, { type: "audio", data: pcm.toString("base64") }] }] };
  voice.set({ tts: { model: "gemini-3.8-flash-lite-tts", voice: "Puck" } });
  const wrapped = await voice.speak({ text: "Raw samples" });
  assert.equal(wrapped.format, "wav");
  assert.deepEqual(wrapped.audio, wavFromPcm(pcm, 24000));
  assert.equal(wrapped.audio.length, 44 + 480);
  assert.equal(wrapped.audio.readUInt32LE(24), 24000);
  assert.equal(json(net.last()).generation_config.speech_config[0].voice, "Puck");
  answer = { steps: [{ type: "model_output", content: [{ type: "text", text: "no audio" }] }] };
  await assert.rejects(voice.speak({ text: "Nothing" }), { message: "Gemini sent back no audio." });
});

// ── Models and voices ─────────────────────────────────────────────────────────────────────────

test("options: documented lists where a provider has no list route", async () => {
  const { voice, net } = make();
  const stt = await voice.options("stt", "openai");
  assert.equal(stt.models[0].id, "gpt-transcribe");
  const tts = await voice.options("tts", "openai");
  assert.deepEqual(tts.models.map((m: any) => m.id), ["gpt-4o-mini-tts", "tts-1-hd", "tts-1"]);
  assert.equal(tts.voices.length, 13);
  assert.ok(tts.voices.some((v: any) => v.id === "marin"));
  const live = await voice.options("live", "openai");
  assert.equal(live.models[0].id, "gpt-realtime-2.1");
  assert.ok(live.voices.some((v: any) => v.id === "cedar"));
  assert.equal((await voice.options("tts", "gemini")).voices.length, 30);
  assert.equal((await voice.options("live", "gemini")).models[0].id, "gemini-3.8-live");
  assert.equal((await voice.options("stt", "elevenlabs")).models[0].id, "scribe_v2");
  assert.deepEqual((await voice.options("tts", "azure")).voices.map((v: any) => v.id), ["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);
  assert.deepEqual(await voice.options("live", "codex"), { models: [], voices: [] });
  assert.equal(net.seen.length, 0);
  voice.set({ providers: { azure: { kind: "openai", sttDeployment: "stt1" } } });
  assert.deepEqual((await voice.options("stt", "azure")).models, [{ id: "stt1", name: "stt1" }]);
});

test("options: ElevenLabs voices (every page) and the models that can speak, kept for 5 minutes", async () => {
  let clock = NOW;
  const net = fake({
    "GET api.elevenlabs.io/v2/voices": (seen) =>
      seen.url.searchParams.get("next_page_token")
        ? { voices: [{ voice_id: "v2", name: "Second", verified_languages: [{ language: "fr" }] }], has_more: false }
        : { voices: [{ voice_id: "v1", name: "First", labels: { language: "en" }, preview_url: "https://cdn.example/v1.mp3" }, { name: "no id" }], has_more: true, next_page_token: "tok 1" },
    "GET api.elevenlabs.io/v1/models": () => [
      { model_id: "eleven_multilingual_v2", name: "Multilingual v2", can_do_text_to_speech: true },
      { model_id: "scribe_v2", name: "Scribe", can_do_text_to_speech: false },
    ],
  });
  const voice = new Voice({ dir: scratch(), fetch: net.fetch, now: () => clock });
  voice.setKey("elevenlabs", "xi-eleven-key-12345");
  const first = await voice.options("tts", "elevenlabs");
  assert.deepEqual(first.models, [{ id: "eleven_multilingual_v2", name: "Multilingual v2" }]);
  assert.deepEqual(first.voices, [
    { id: "v1", name: "First", language: "en", preview: "https://cdn.example/v1.mp3" },
    { id: "v2", name: "Second", language: "fr" },
  ]);
  const voiceRequests = net.seen.filter((s) => s.url.pathname === "/v2/voices");
  assert.equal(voiceRequests[0].url.searchParams.get("page_size"), "100");
  assert.equal(voiceRequests[1].url.searchParams.get("next_page_token"), "tok 1");
  assert.equal(voiceRequests[0].headers.get("xi-api-key"), "xi-eleven-key-12345");
  const count = net.seen.length;
  assert.deepEqual(await voice.options("tts", "elevenlabs"), first);
  assert.equal(net.seen.length, count);
  clock += 4 * 60_000;
  await voice.options("tts", "elevenlabs");
  assert.equal(net.seen.length, count);
  clock += 2 * 60_000;
  await voice.options("tts", "elevenlabs");
  assert.ok(net.seen.length > count);
  // A changed key or setting is a fresh list at once, and the answer is a copy.
  const now = net.seen.length;
  voice.setKey("elevenlabs", "xi-eleven-key-67890");
  const live = await voice.options("live", "elevenlabs");
  assert.deepEqual(live.models, []);
  assert.equal(live.voices.length, 2);
  assert.ok(net.seen.length > now);
  live.voices.length = 0;
  assert.equal((await voice.options("live", "elevenlabs")).voices.length, 2);
});

test("options: Azure Speech voices from the voices list", async () => {
  const { voice, net } = make({
    "GET swedencentral.tts.speech.microsoft.com/cognitiveservices/voices/list": () => [
      { Name: "Microsoft Server Speech Text to Speech Voice (en-US, JennyNeural)", DisplayName: "Jenny", ShortName: "en-US-JennyNeural", Gender: "Female", Locale: "en-US" },
      { ShortName: "sv-SE-SofieNeural", LocalName: "Sofie", Locale: "sv-SE" },
      { DisplayName: "no short name" },
    ],
  });
  voice.set({ providers: { azure: { kind: "speech", region: "swedencentral" } } });
  voice.setKey("azure", "azure-key-0123456789");
  const tts = await voice.options("tts", "azure");
  assert.deepEqual(tts.voices, [{ id: "en-US-JennyNeural", name: "Jenny (Female)", language: "en-US" }, { id: "sv-SE-SofieNeural", name: "Sofie", language: "sv-SE" }]);
  assert.equal(net.last().headers.get("ocp-apim-subscription-key"), "azure-key-0123456789");
  assert.deepEqual((await voice.options("stt", "azure")).models.map((m: any) => m.id), ["", "MAI-Transcribe-2", "MAI-Transcribe-1.5"]);
});

test("options: a speech server's models, its own voices when it has them, else the standard names", async () => {
  let voices: { status?: number; body: string } = { body: JSON.stringify({ voices: [{ id: "af_heart", name: "Heart" }, "bm_george"] }) };
  const server = await serve((req) => {
    if (req.url === "/v1/models") return { body: JSON.stringify({ data: [{ id: "whisper-small" }, { id: "kokoro" }] }) };
    if (req.url === "/v1/audio/voices") return voices;
    return { status: 404, body: "{}" };
  });
  const { voice } = make({}, { fetch: undefined });
  voice.set({ providers: { custom: { baseUrl: server.origin + "/v1" } } });
  voice.setKey("custom", "custom-key-0123456789");
  const tts = await voice.options("tts", "custom");
  assert.deepEqual(tts.models, [{ id: "whisper-small", name: "whisper-small" }, { id: "kokoro", name: "kokoro" }]);
  assert.deepEqual(tts.voices, [{ id: "af_heart", name: "Heart" }, { id: "bm_george", name: "bm_george" }]);
  assert.equal(server.seen[0].headers.authorization, "Bearer custom-key-0123456789");
  assert.equal((await voice.options("stt", "custom")).voices.length, 0);
  voices = { status: 404, body: "not found" };
  voice.setKey("custom", "custom-key-9876543210"); // a new key clears the kept lists
  const plain = await voice.options("tts", "custom");
  assert.ok(plain.voices.some((v: any) => v.id === "alloy"));
  assert.ok(plain.voices.length >= 9);
  // A server that can't list its models is an error the person can read.
  voice.set({ providers: { custom: { baseUrl: server.origin + "/missing" } } });
  await assert.rejects(voice.options("stt", "custom"), /^Error: Your speech server returned 404\.$/);
});

// ── Errors ────────────────────────────────────────────────────────────────────────────────────

test("a provider's error is one plain sentence with the status and its own message", async () => {
  let reply: Response = say(401, { error: { message: "Incorrect API key provided.", type: "invalid_request_error" } });
  const { voice } = make({ "POST api.openai.com/v1/audio/speech": () => reply, "POST api.elevenlabs.io/v1/text-to-speech/v1": () => reply });
  voice.setKey("openai", KEY);
  voice.set({ tts: { provider: "openai" } });
  await assert.rejects(voice.speak({ text: "hi" }), { message: "OpenAI returned 401: Incorrect API key provided." });
  reply = say(429, { error: { message: "Rate limit reached\n  for   requests" } });
  await assert.rejects(voice.speak({ text: "hi" }), { message: "OpenAI returned 429: Rate limit reached for requests." });
  reply = say(500, "<html><body>Bad gateway</body></html>");
  await assert.rejects(voice.speak({ text: "hi" }), { message: "OpenAI returned 500." });
  reply = new Response("overloaded, try later", { status: 503 });
  await assert.rejects(voice.speak({ text: "hi" }), { message: "OpenAI returned 503: overloaded, try later." });
  reply = say(422, { detail: [{ loc: ["body"], msg: "field required", type: "x" }] });
  voice.setKey("elevenlabs", "xi-eleven-key-12345");
  voice.set({ tts: { provider: "elevenlabs", voice: "v1" } });
  await assert.rejects(voice.speak({ text: "hi" }), { message: "ElevenLabs returned 422: field required." });
  reply = say(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } });
  await assert.rejects(voice.speak({ text: "hi" }), { message: "ElevenLabs returned 401: Invalid API key." });
  // A good answer that is not what was promised.
  const odd = make({ "POST api.openai.com/v1/audio/transcriptions": () => ({ nothing: true }) });
  odd.voice.setKey("openai", KEY);
  odd.voice.set({ stt: { provider: "openai" } });
  await assert.rejects(odd.voice.transcribe({ audio: WAV, format: "wav" }), { message: "OpenAI sent back something unexpected." });
});

test("no error holds a key, a token or the audio, even when a provider echoes one", async () => {
  const keys = { openai: KEY, azure: "azure-key-0123456789", elevenlabs: "xi-eleven-key-12345", gemini: "AIza-gemini-key-123456", custom: "custom-key-0123456789" };
  const audio = Buffer.from("SECRET-AUDIO-BYTES-".repeat(10)).toString("base64");
  const echo = (status: number) => (seen: Seen) =>
    say(status, {
      error: { message: `Bad key ${Object.values(keys).join(" ")} bearer ${seen.headers.get("authorization")} audio ${audio} token ek_abcdef0123456789 ${encodeURIComponent(keys.openai)}` },
      detail: { message: "also " + keys.elevenlabs },
    });
  const { voice } = make({
    "POST api.openai.com/v1/audio/transcriptions": echo(401),
    "POST api.openai.com/v1/audio/speech": echo(401),
    "POST api.openai.com/v1/realtime/client_secrets": echo(401),
    "POST api.openai.com/v1/realtime/calls": echo(401),
    "POST api.elevenlabs.io/v1/speech-to-text": echo(401),
    "POST api.elevenlabs.io/v1/text-to-speech/v1": echo(401),
    "GET api.elevenlabs.io/v2/voices": echo(401),
    "POST api.elevenlabs.io/v1/convai/agents/create": echo(403),
    "POST generativelanguage.googleapis.com/v1beta/interactions": echo(400),
    "POST generativelanguage.googleapis.com/v1beta/auth_tokens": echo(400),
    "POST contoso.openai.azure.com/openai/deployments/d1/audio/speech": echo(401),
    "POST contoso.openai.azure.com/openai/deployments/d1/audio/transcriptions": echo(401),
    "POST eastus.tts.speech.microsoft.com/cognitiveservices/v1": echo(401),
    "POST speech.lan/v1/audio/speech": echo(401),
  });
  for (const [provider, key] of Object.entries(keys)) voice.setKey(provider, key);
  const secrets = [...Object.values(keys), audio, audio.slice(0, 30), "ek_abcdef0123456789", encodeURIComponent(keys.openai)];
  const attempts: [object, (v: Voice) => Promise<unknown>][] = [
    [{ stt: { provider: "openai" } }, (v) => v.transcribe({ audio: WAV, format: "wav" })],
    [{ tts: { provider: "openai" } }, (v) => v.speak({ text: "hello" })],
    [{ stt: { provider: "elevenlabs" } }, (v) => v.transcribe({ audio: WAV, format: "wav" })],
    [{ tts: { provider: "elevenlabs", voice: "v1" } }, (v) => v.speak({ text: "hello" })],
    [{ tts: { provider: "gemini" } }, (v) => v.speak({ text: "hello" })],
    [{ providers: { azure: { kind: "openai", endpoint: "https://contoso.openai.azure.com", sttDeployment: "d1", ttsDeployment: "d1" } }, stt: { provider: "azure" }, tts: { provider: "azure" } }, (v) => v.speak({ text: "hello" })],
    [{}, (v) => v.transcribe({ audio: WAV, format: "wav" })],
    [{ providers: { azure: { kind: "speech", region: "eastus", endpoint: null } } }, (v) => v.speak({ text: "hello" })],
    [{ tts: { provider: "custom" }, providers: { custom: { baseUrl: "http://speech.lan/v1" } } }, (v) => v.speak({ text: "hello" })],
    [{}, (v) => v.options("tts", "elevenlabs")],
    [{}, (v) => v.live({ provider: "openai" })],
    [{}, (v) => v.live({ provider: "openai", sdp: "v=0\r\n" })],
    [{}, (v) => v.live({ provider: "gemini" })],
    [{}, (v) => v.live({ provider: "elevenlabs" })],
  ];
  let failures = 0;
  for (const [patch, run] of attempts) {
    voice.set(patch);
    // A changed address drops that provider's key, so the keys go in again after each change.
    for (const [provider, key] of Object.entries(keys)) voice.setKey(provider, key);
    await run(voice).then(
      () => assert.fail("a failing provider should fail"),
      (error: Error) => {
        failures++;
        for (const secret of secrets) assert.equal(error.message.includes(secret), false, `"${error.message}" holds a secret`);
        assert.match(error.message, /returned (400|401|403)/);
        assert.equal(error.message.includes("\n"), false);
      },
    );
  }
  assert.equal(failures, attempts.length);
});

test("a request that takes too long ends with a plain sentence, and every request has a time limit and an abort signal", async () => {
  const keep = setTimeout(() => {}, 5000); // timers behind AbortSignal.timeout don't keep the process alive
  try {
    const hang: Handler = (seen) => new Promise((_, reject) => seen.signal.addEventListener("abort", () => reject(seen.signal.reason)));
    const net = fake({ "POST api.openai.com/v1/audio/speech": hang, "GET api.elevenlabs.io/v2/voices": hang });
    const voice = new Voice({ dir: scratch(), fetch: net.fetch, timeouts: { request: 40, list: 40 } });
    voice.setKey("openai", KEY);
    voice.setKey("elevenlabs", "xi-eleven-key-12345");
    voice.set({ tts: { provider: "openai" } });
    await assert.rejects(voice.speak({ text: "hello" }), { message: "OpenAI took too long to answer." });
    await assert.rejects(voice.options("tts", "elevenlabs"), { message: "ElevenLabs took too long to answer." });
    assert.ok(net.seen.every((s) => s.signal instanceof AbortSignal && s.signal.aborted));
    // close() stops what is waiting.
    const pending = voice.speak({ text: "hello" });
    setTimeout(() => voice.close(), 5);
    await assert.rejects(pending, { message: "Voice was stopped." });
  } finally {
    clearTimeout(keep);
  }
});

test("a provider that can't be reached is a plain sentence without the cause", async () => {
  const voice = new Voice({ dir: scratch(), fetch: (async () => { throw new TypeError("fetch failed: getaddrinfo ENOTFOUND https://api.openai.com/?key=" + KEY); }) as any });
  voice.setKey("openai", KEY);
  voice.set({ tts: { provider: "openai" } });
  await assert.rejects(voice.speak({ text: "hello" }), { message: "Couldn't reach OpenAI." });
});

// ── Live sessions ─────────────────────────────────────────────────────────────────────────────

const TOOLS = [
  { name: "open_page", description: "Opens a page.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" } },
  { name: "list_bots", description: "Lists the bots.", parameters: { type: "object", properties: {} } },
];

test("live with OpenAI and the caller's offer: the computer posts it with the real key and returns only the answer", async () => {
  const offer = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n";
  const answer = "v=0\r\no=openai 2 2 IN IP4 0.0.0.0\r\n";
  const { voice, net } = make({ "POST api.openai.com/v1/realtime/calls": () => new Response(answer, { status: 201, headers: { "content-type": "application/sdp", location: "/v1/realtime/calls/rtc_abc123" } }) });
  voice.setKey("openai", KEY);
  voice.set({ live: { provider: "openai", voice: "cedar" } });
  const session = await voice.live({ sdp: offer, instructions: "Be brief.", tools: TOOLS });
  assert.deepEqual(session, { id: "rtc_abc123", kind: "webrtc", sdp: answer });
  const seen = net.last();
  assert.equal(seen.headers.get("authorization"), "Bearer " + KEY);
  const form = seen.body as FormData;
  assert.equal(form.get("sdp"), offer);
  assert.deepEqual(JSON.parse(String(form.get("session"))), {
    type: "realtime",
    model: "gpt-realtime-2.1",
    instructions: "Be brief.",
    output_modalities: ["audio"],
    audio: { input: { turn_detection: { type: "semantic_vad" }, transcription: { model: "gpt-transcribe" } }, output: { voice: "cedar" } },
    tools: [
      { type: "function", name: "open_page", description: "Opens a page.", parameters: TOOLS[0].parameters },
      { type: "function", name: "list_bots", description: "Lists the bots.", parameters: TOOLS[1].parameters },
    ],
    tool_choice: "auto",
  });
  assert.equal(JSON.stringify(session).includes(KEY), false);
  // No Location header: the computer names the session.
  const bare = make({ "POST api.openai.com/v1/realtime/calls": () => new Response(answer) });
  bare.voice.setKey("openai", KEY);
  const two = await bare.voice.live({ provider: "openai", sdp: offer });
  assert.match(two.id, /^live-/);
  // A body that isn't an answer is not passed on.
  const odd = make({ "POST api.openai.com/v1/realtime/calls": () => new Response("<html>") });
  odd.voice.setKey("openai", KEY);
  await assert.rejects(odd.voice.live({ provider: "openai", sdp: offer }), { message: "OpenAI sent back something unexpected." });
});

test("live with OpenAI: the chosen language is a hint to the person's transcript, so silence can't flip it", async () => {
  const { voice, net } = make({ "POST api.openai.com/v1/realtime/calls": () => new Response("v=0\r\no=openai 2 2 IN IP4 0.0.0.0\r\n") });
  voice.setKey("openai", KEY);
  voice.set({ stt: { language: "en-US" } });
  await voice.live({ provider: "openai", sdp: "v=0\r\n" });
  const session = JSON.parse(String((net.last().body as FormData).get("session")));
  assert.deepEqual(session.audio.input.transcription, { model: "gpt-transcribe", language: "en" });
});

test("live with OpenAI and no offer: a short-lived secret and the session.update to send first", async () => {
  const { voice, net } = make({ "POST api.openai.com/v1/realtime/client_secrets": () => ({ value: "ek_short_lived_secret_value", expires_at: Math.floor(NOW / 1000) + 600, session: { id: "sess_1", object: "realtime.session" } }) });
  voice.setKey("openai", KEY);
  const session = await voice.live({ provider: "openai", instructions: "Be brief.", voice: "marin", tools: TOOLS });
  const seen = net.last();
  assert.equal(seen.headers.get("authorization"), "Bearer " + KEY);
  const body = json(seen);
  assert.deepEqual(body.expires_after, { anchor: "created_at", seconds: 600 });
  assert.equal(body.session.type, "realtime");
  assert.equal(body.session.model, "gpt-realtime-2.1");
  assert.deepEqual(body.session.audio.input.format, { type: "audio/pcm", rate: 24000 });
  assert.deepEqual(body.session.audio.output, { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" });
  assert.equal(session.kind, "openai-ws");
  assert.equal(session.url, "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1");
  assert.equal(session.token, "ek_short_lived_secret_value");
  assert.equal(session.expiresAt, NOW + 600_000);
  assert.match(session.id, /^live-/);
  assert.equal(session.session.type, "session.update");
  assert.deepEqual(session.session.session, body.session);
  assert.equal(session.session.session.tools[0].type, "function");
  assert.equal(JSON.stringify(session).includes(KEY), false);
  // A chosen model, and a server of the person's own address, are followed.
  voice.set({ live: { provider: "openai", model: "gpt-realtime-2.1-mini" } });
  const mini = await voice.live({});
  assert.equal(mini.url, "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini");
  assert.equal(json(net.last()).session.model, "gpt-realtime-2.1-mini");
  assert.equal(json(net.last()).session.instructions, undefined);
});

test("live with Gemini: a one-use token, the constrained socket, and the setup message with tools as function declarations", async () => {
  const { voice, net } = make({ "POST generativelanguage.googleapis.com/v1beta/auth_tokens": () => ({ name: "auth_tokens/abc+/=def", uses: 1 }) });
  voice.setKey("gemini", "AIza-gemini-key-123456");
  const session = await voice.live({ provider: "gemini", instructions: "Be brief.", voice: "Puck", tools: TOOLS });
  const seen = net.last();
  assert.equal(seen.headers.get("x-goog-api-key"), "AIza-gemini-key-123456");
  assert.deepEqual(json(seen), { uses: 1, expireTime: new Date(NOW + 30 * 60_000).toISOString(), newSessionExpireTime: new Date(NOW + 2 * 60_000).toISOString() });
  assert.equal(session.kind, "gemini-ws");
  assert.equal(session.url, "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fabc%2B%2F%3Ddef");
  assert.equal(session.expiresAt, NOW + 2 * 60_000);
  assert.deepEqual(session.input, { sampleRate: 16000 });
  assert.deepEqual(session.output, { sampleRate: 24000 });
  assert.deepEqual(session.setup, {
    setup: {
      model: "models/gemini-3.8-live",
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } } },
      systemInstruction: { parts: [{ text: "Be brief." }] },
      tools: [
        {
          functionDeclarations: [
            { name: "open_page", description: "Opens a page.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
            { name: "list_bots", description: "Lists the bots." },
          ],
        },
      ],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  });
  assert.equal(JSON.stringify(session).includes("AIza-gemini"), false);
  // No tools and no instructions: neither is in the message. The chosen model and voice are used.
  voice.set({ live: { provider: "gemini", model: "gemini-3.8-live-extended-thinking", voice: "Kore" } });
  const plain = await voice.live({});
  assert.equal(plain.setup.setup.model, "models/gemini-3.8-live-extended-thinking");
  assert.equal(plain.setup.setup.tools, undefined);
  assert.equal(plain.setup.setup.systemInstruction, undefined);
  assert.equal(plain.setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
});

test("live with Gemini: the chosen speech language goes in its instructions, so unclear sound isn't answered in another language", async () => {
  const { voice } = make({ "POST generativelanguage.googleapis.com/v1beta/auth_tokens": () => ({ name: "auth_tokens/abc", uses: 1 }) });
  voice.setKey("gemini", "AIza-gemini-key-123456");
  voice.set({ live: { provider: "gemini" }, stt: { language: "en-US" } });
  // After the caller's own instructions.
  const told = await voice.live({ instructions: "Be brief." });
  const [own, language] = told.setup.setup.systemInstruction.parts[0].text.split("\n\n");
  assert.equal(own, "Be brief.");
  assert.match(language, /^The person speaks American English \(en-US\)\. Always answer in American English/);
  assert.match(language, /noise/);
  // Alone, when the caller has none.
  const alone = await voice.live({});
  assert.equal(alone.setup.setup.systemInstruction.parts[0].text, language);
  // No language chosen: nothing is added.
  voice.set({ stt: { language: "" } });
  const none = await voice.live({});
  assert.equal(none.setup.setup.systemInstruction, undefined);
});

test("live with ElevenLabs: tools and the agent are made once, reused after a reload, and the signed URL comes with the overrides", async () => {
  let tools = 0;
  let agents = 0;
  const routes: Record<string, Handler> = {
    "POST api.elevenlabs.io/v1/convai/tools": () => ({ id: "tool_" + ++tools, tool_config: {} }),
    "POST api.elevenlabs.io/v1/convai/agents/create": () => ({ agent_id: "agent_" + ++agents }),
    "GET api.elevenlabs.io/v1/convai/conversation/get-signed-url": (seen) => ({ signed_url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${seen.url.searchParams.get("agent_id")}&conversation_signature=SIGNED` }),
  };
  const net = fake(routes);
  const dir = scratch();
  const voice = new Voice({ dir, fetch: net.fetch });
  voice.setKey("elevenlabs", "xi-eleven-key-12345");
  const session = await voice.live({ provider: "elevenlabs", instructions: "Be brief.", voice: "voice_9", tools: TOOLS, firstMessage: "Hi!" });
  const toolBodies = net.seen.filter((s) => s.url.pathname === "/v1/convai/tools").map(json);
  assert.deepEqual(toolBodies[0], {
    tool_config: { type: "client", name: "open_page", description: "Opens a page.", expects_response: true, parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  });
  assert.deepEqual(toolBodies[1], { tool_config: { type: "client", name: "list_bots", description: "Lists the bots.", expects_response: true } });
  const created = json(net.seen.find((s) => s.url.pathname === "/v1/convai/agents/create")!);
  assert.equal(created.name, "Botkins");
  assert.ok(created.conversation_config.conversation.client_events.includes("tentative_user_transcript"));
  assert.ok(created.conversation_config.conversation.client_events.includes("agent_chat_response_part"));
  assert.deepEqual(created.conversation_config.agent.prompt.tool_ids, ["tool_1", "tool_2"]);
  assert.deepEqual(created.platform_settings.overrides.conversation_config_override, { agent: { first_message: true, language: true, prompt: { prompt: true, tool_ids: true } }, tts: { voice_id: true } });
  for (const s of net.seen) assert.equal(s.headers.get("xi-api-key"), "xi-eleven-key-12345");
  assert.equal(voice.settings().providers.elevenlabs.agentId, "agent_1");
  const signed = net.seen.find((s) => s.url.pathname.endsWith("get-signed-url"))!;
  assert.equal(signed.url.searchParams.get("agent_id"), "agent_1");
  assert.equal(session.kind, "elevenlabs-ws");
  assert.equal(session.url, "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_1&conversation_signature=SIGNED");
  assert.deepEqual(session.init, {
    type: "conversation_initiation_client_data",
    conversation_config_override: { agent: { prompt: { prompt: "Be brief.", tool_ids: ["tool_1", "tool_2"] }, first_message: "Hi!" }, tts: { voice_id: "voice_9" } },
  });
  assert.deepEqual(session.input, { sampleRate: 16000 });
  assert.deepEqual(session.output, { sampleRate: 16000 });
  // The next session, and one after a reload, create nothing new.
  const before = net.seen.length;
  await voice.live({ provider: "elevenlabs", tools: TOOLS });
  const again = new Voice({ dir, fetch: net.fetch });
  const third = await again.live({ provider: "elevenlabs", tools: TOOLS });
  assert.deepEqual(net.seen.slice(before).map((s) => s.url.pathname), ["/v1/convai/conversation/get-signed-url", "/v1/convai/conversation/get-signed-url"]);
  assert.deepEqual(third.init, { type: "conversation_initiation_client_data", conversation_config_override: { agent: { prompt: { tool_ids: ["tool_1", "tool_2"] } } } });
  assert.equal(tools, 2);
  assert.equal(agents, 1);
  // A tool that changes is a new tool.
  await again.live({ provider: "elevenlabs", tools: [{ ...TOOLS[1], description: "Lists every bot." }] });
  assert.equal(tools, 3);
  // Nothing to override: the first message is just the opening.
  const bare = await again.live({ provider: "elevenlabs" });
  assert.deepEqual(bare.init, { type: "conversation_initiation_client_data" });
});

test("live with ElevenLabs and a pasted agent id makes no agent; if one can't be made, the sentence says to paste one", async () => {
  const net = fake({ "GET api.elevenlabs.io/v1/convai/conversation/get-signed-url": () => ({ signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_mine&conversation_signature=S" }) });
  const voice = new Voice({ dir: scratch(), fetch: net.fetch });
  voice.setKey("elevenlabs", "xi-eleven-key-12345");
  voice.set({ providers: { elevenlabs: { agentId: "agent_mine" } } });
  await voice.live({ provider: "elevenlabs", instructions: "Hi" });
  assert.deepEqual(net.seen.map((s) => s.url.pathname), ["/v1/convai/conversation/get-signed-url"]);
  assert.equal(net.last().url.searchParams.get("agent_id"), "agent_mine");
  const denied = make({ "POST api.elevenlabs.io/v1/convai/agents/create": () => say(401, { detail: { status: "missing_permissions", message: "The API key is missing the convai_write permission." } }) });
  denied.voice.setKey("elevenlabs", "xi-eleven-key-12345");
  await assert.rejects(denied.voice.live({ provider: "elevenlabs" }), { message: "ElevenLabs returned 401: The API key is missing the convai_write permission. You can also paste an agent id in Settings › Voice." });
  assert.equal(denied.voice.settings().providers.elevenlabs.agentId, undefined);
});

test("live with Codex goes through the app's helper, and ends there", async () => {
  const calls: any[] = [];
  const ended: string[] = [];
  const state = { present: true, signedIn: false, fail: false };
  const adapter = () =>
    state.present
      ? { codex: { signedIn: () => state.signedIn, live: async (a: any) => { calls.push(a); if (state.fail) throw new Error("codex crashed at /Users/someone"); return { sdp: "v=0 codex answer", id: "codex-1" }; }, end: (id: string) => ended.push(id) } }
      : undefined;
  const { voice } = make({}, { adapter });
  assert.deepEqual(voice.settings().providers.codex, { available: true, signedIn: false });
  await assert.rejects(voice.live({ provider: "codex", sdp: "v=0\r\n" }), { message: "Sign in to Codex on your computer first." });
  state.signedIn = true;
  assert.deepEqual(voice.settings().providers.codex, { available: true, signedIn: true });
  await assert.rejects(voice.live({ provider: "codex" }), { message: "Live voice with Codex needs a connection offer." });
  voice.set({ live: { provider: "codex", voice: "marin" } });
  const session = await voice.live({ sdp: "v=0 offer", instructions: "Hi", tools: TOOLS });
  assert.deepEqual(session, { id: "codex-1", kind: "webrtc", sdp: "v=0 codex answer" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sdp, "v=0 offer");
  assert.equal(calls[0].voice, "marin");
  assert.equal(calls[0].instructions, "Hi");
  assert.deepEqual(calls[0].tools.map((t: any) => t.name), ["open_page", "list_bots"]);
  voice.endLive("codex-1");
  voice.endLive("codex-1");
  voice.endLive("never-heard-of-it");
  voice.endLive(undefined as any);
  assert.deepEqual(ended, ["codex-1"]);
  state.fail = true;
  await assert.rejects(voice.live({ provider: "codex", sdp: "v=0 offer" }), { message: "Codex couldn't start a live voice session." });
  state.present = false;
  assert.deepEqual(voice.settings().providers.codex, { available: false, signedIn: false });
  await assert.rejects(voice.live({ provider: "codex", sdp: "v=0 offer" }), { message: "Codex isn't available in this app." });
});

test("a ChatGPT sign-in made under Model providers counts for phones and for live voice", async () => {
  // Shaped like the app's helper (desktop/desktop/codexvoice.mjs): `signedIn()` is its last answer,
  // and only `refresh()` asks Codex. Nothing on the computer asks on a phone's behalf, so the link does.
  const codex = { codexSays: true, last: false, asked: 0, signedIn: () => codex.last, refresh: async () => ((codex.asked += 1), (codex.last = codex.codexSays)), live: async () => ({ sdp: "v=0 codex answer", id: "codex-2" }), end() {} };
  let clock = NOW;
  let sent = 0;
  const { voice } = make({}, { adapter: () => ({ codex }), onChange: () => sent++, now: () => clock });
  // The first read answers at once with what the app knew, and asks again behind it.
  assert.equal(voice.settings().providers.codex.signedIn, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(codex.asked, 1);
  assert.equal(sent, 1, "the settings are sent again with the new answer");
  const phone = voice.settings();
  assert.equal(phone.providers.codex.signedIn, true);
  // The phone's live voice and a bot's own voice offer ChatGPT once nothing is missing.
  assert.equal(missing("live", "codex", phone), null);
  // Reads close together don't ask Codex each time.
  voice.settings();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(codex.asked, 1);
  // A sign-out is seen at the next read after a while, and sent again.
  codex.codexSays = false;
  clock += 20_000;
  voice.settings();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(voice.settings().providers.codex.signedIn, false);
  assert.equal(missing("live", "codex", voice.settings()), "Sign in to ChatGPT on your computer");
  assert.equal(sent, 2);
  // A live call asks Codex itself first, so a sign-in a moment ago counts.
  codex.codexSays = true;
  voice.set({ live: { provider: "codex" } });
  assert.deepEqual(await voice.live({ sdp: "v=0 offer" }), { id: "codex-2", kind: "webrtc", sdp: "v=0 codex answer" });
});

test("live: input is checked, and a session of another provider ends without calling Codex", async () => {
  const ended: string[] = [];
  const { voice } = make({ "POST api.openai.com/v1/realtime/client_secrets": () => ({ value: "ek_x_secret_value", expires_at: Math.floor(NOW / 1000) + 600 }) }, { adapter: () => ({ codex: { signedIn: () => true, live: async () => ({ sdp: "v=0", id: "c" }), end: (id: string) => ended.push(id) } }) });
  voice.setKey("openai", KEY);
  await assert.rejects(voice.live({ provider: "custom" as any }), { message: "That provider doesn't do live voice." });
  await assert.rejects(voice.live({ provider: "openai", sdp: "not an offer" }), { message: "That connection offer isn't valid." });
  await assert.rejects(voice.live({ provider: "openai", instructions: "x".repeat(20_001) }), { message: "The instructions are up to 20,000 characters." });
  await assert.rejects(voice.live({ provider: "openai", voice: "bad voice!" }), { message: "That voice isn't valid." });
  await assert.rejects(voice.live({ provider: "openai", tools: "none" as any }), /Use up to 64 tools/);
  await assert.rejects(voice.live({ provider: "openai", tools: [{ name: "bad name!" }] as any }), /needs its own name/);
  await assert.rejects(voice.live({ provider: "openai", tools: [{ name: "a" }, { name: "a" }] as any }), /needs its own name/);
  await assert.rejects(voice.live({ provider: "openai", tools: [{ name: "a", parameters: "x" }] as any }), /JSON schema object/);
  await assert.rejects(voice.live({ provider: "openai", tools: Array.from({ length: 65 }, (_, i) => ({ name: "t" + i })) }), /Use up to 64 tools/);
  const session = await voice.live({ provider: "openai", tools: [{ name: "plain" }] });
  voice.endLive(session.id);
  assert.deepEqual(ended, []);
  // The most sessions kept is bounded: the oldest are forgotten.
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) ids.push((await voice.live({ provider: "openai" })).id);
  assert.equal(new Set(ids).size, 40);
});

test("a key stays with the address it was given for, and Codex is told whom the voice speaks for", async () => {
  const { voice } = make();
  voice.setKey("openai", KEY);
  voice.setKey("custom", "custom-key-0123456789");
  // A first address drops a key that was saved before it: that key was given for no address, and a
  // call that only sets an address must not get it sent there.
  voice.set({ providers: { custom: { baseUrl: "http://speech.lan/v1" } } });
  assert.equal(voice.settings().providers.custom.hasKey, false);
  assert.equal(voice.settings().providers.openai.hasKey, true, "another provider's key is not touched");
  // The order for a provider: the address, then the key.
  voice.setKey("custom", "custom-key-0123456789");
  assert.equal(voice.settings().providers.custom.hasKey, true);
  // A change that names no address keeps the key.
  voice.set({ providers: { custom: {} }, tts: { auto: false } });
  assert.equal(voice.settings().providers.custom.hasKey, true);
  // The same address again changes nothing.
  voice.set({ providers: { custom: { baseUrl: "http://speech.lan/v1" }, openai: { baseUrl: "https://api.openai.com/v1" } } });
  assert.equal(voice.settings().providers.custom.hasKey, true);
  assert.equal(voice.settings().providers.openai.hasKey, true);
  // Another address: the key is not sent there. It has to be entered again.
  voice.set({ providers: { custom: { baseUrl: "https://elsewhere.example/v1" }, openai: { baseUrl: "https://proxy.example/v1" } } });
  assert.equal(voice.settings().providers.custom.hasKey, false);
  assert.equal(voice.settings().providers.openai.hasKey, false);
  assert.equal(voice.locked, null);
  // An address that is taken away takes its key with it.
  voice.setKey("custom", "custom-key-0123456789");
  voice.set({ providers: { custom: { baseUrl: "" } } });
  assert.deepEqual([voice.settings().providers.custom.baseUrl, voice.settings().providers.custom.hasKey], [undefined, false]);
  // Azure: a first region, a first endpoint and a change of either drop the key; the other details keep it.
  const azure = make().voice;
  const keyed = () => (azure.setKey("azure", "azure-key-0123456789"), azure.settings().providers.azure.hasKey);
  assert.equal(keyed(), true);
  azure.set({ providers: { azure: { kind: "speech", region: "eastus" } } });
  assert.equal(azure.settings().providers.azure.hasKey, false, "a first region");
  assert.equal(keyed(), true);
  azure.set({ providers: { azure: { apiVersion: "2025-04-01-preview", sttDeployment: "whisper" } } });
  assert.equal(azure.settings().providers.azure.hasKey, true, "a deployment and a version are not an address");
  azure.set({ providers: { azure: { endpoint: "https://name.cognitiveservices.azure.com" } } });
  assert.equal(azure.settings().providers.azure.hasKey, false, "a first endpoint, where the key would go in place of the region");
  assert.equal(keyed(), true);
  // With an endpoint the region is not where the key goes: changing it keeps the key.
  azure.set({ providers: { azure: { region: "westeurope" } } });
  assert.equal(azure.settings().providers.azure.hasKey, true);
  azure.set({ providers: { azure: { endpoint: "https://other.cognitiveservices.azure.com" } } });
  assert.equal(azure.settings().providers.azure.hasKey, false, "another endpoint");

  // Codex answers the voice's tool call itself, so it is handed the chat, the bot and its name.
  const calls: any[] = [];
  const codex = { signedIn: () => true, live: async (input: any) => (calls.push(input), { sdp: "v=0\r\nanswer", id: "live-1" }), end() {}, voices: async () => [{ id: "juniper", name: "Juniper" }, { id: "bad id!" }, "maple"] };
  const withCodex = make({}, { adapter: () => ({ codex }) }).voice;
  const session = await withCodex.live({ provider: "codex", sdp: "v=0\r\noffer", instructions: "Be brief.", tools: [], about: { chatId: "chat-1", botId: "bot-1", botName: "Pip" } });
  assert.deepEqual(session, { id: "live-1", kind: "webrtc", sdp: "v=0\r\nanswer" });
  assert.deepEqual({ chatId: calls[0].chatId, botId: calls[0].botId, botName: calls[0].botName }, { chatId: "chat-1", botId: "bot-1", botName: "Pip" });
  assert.deepEqual(await withCodex.options("live", "codex"), { models: [], voices: [{ id: "juniper", name: "Juniper" }] });
});

// ---- What the live voice knows: the chat so far, a light identity, and where the person is

const bot = { id: "bot-pip", name: "Pip", role: "Chief of staff", instructions: "Keep my week in order. ".repeat(200) };
const said = (role: string, text: string, extra: Record<string, unknown> = {}) => ({ role, text, ...extra });

test("live voice: the chat so far, newest last, only what was said, labelled and within its budget", () => {
  const messages = [
    said("user", "What's on Friday?"),
    said("assistant", "Looking at your calendar…", { interim: true }),
    said("command", "/compact"),
    said("assistant", "Friday has the launch review at 10 and lunch with Ana."),
    said("user", "  Move   lunch\n\nto Thursday.  "),
    said("assistant", "Done. Here is the change:\n```diff\n- Fri lunch\n+ Thu lunch\n```\nAnything else?"),
    said("assistant", "Sure.", { botId: "bot-quill" }),
  ];
  const text = liveTranscript(messages, { botName: "Pip", bots: [bot, { id: "bot-quill", name: "Quill" }], userName: "Sam" });
  assert.equal(
    text,
    [
      "Sam: What's on Friday?",
      "Pip: Friday has the launch review at 10 and lunch with Ana.",
      "Sam: Move lunch to Thursday.",
      "Pip: Done. Here is the change: (code) Anything else?",
      "Quill: Sure.",
    ].join("\n"),
  );
  // Without a name the person is "Person".
  assert.match(liveTranscript([said("user", "Hi")], { botName: "Pip" }), /^Person: Hi$/);

  // A long chat keeps its newest messages; the oldest go first, and each message is cut.
  const long = Array.from({ length: 60 }, (_, i) => said(i % 2 ? "assistant" : "user", "Message " + i + " " + "word ".repeat(400)));
  const kept = liveTranscript(long, { botName: "Pip" });
  assert.ok(kept.length <= LIVE_LIMITS.transcript, "within the budget: " + kept.length);
  assert.ok(kept.includes("Message 59 "), "the newest is kept");
  assert.ok(!kept.includes("Message 0 "), "the oldest is dropped");
  assert.match(kept, /^\(Earlier messages left out\.\)/);
  for (const line of kept.split("\n").slice(1)) assert.ok(line.length <= LIVE_LIMITS.message + 20, "each message is cut: " + line.length);
  assert.equal(liveTranscript([], { botName: "Pip" }), "");
});

test("live voice: the instructions answer from what is known, ask the bot for new work, and carry the identity", () => {
  const messages = [said("user", "What did we decide about the logo?"), said("assistant", "We picked the round one, in clay red.")];
  const plain = liveInstructions({ bot, messages, bots: [bot] });
  // The rule.
  assert.match(plain, /You are the voice of Pip/);
  assert.match(plain, /no lists, no Markdown/);
  assert.match(plain, /already in the conversation below or in these notes, answer it yourself/);
  assert.match(plain, /call the ask_bot tool only for new work/i);
  assert.match(plain, /Never make up what the bot would say/);
  // The bot, as before: its role and the start of its instructions.
  assert.match(plain, /About Pip:\nChief of staff\n\nKeep my week in order\./);
  assert.ok(!plain.includes("Keep my week in order. ".repeat(80)), "only a slice of its instructions");
  // The conversation.
  assert.match(plain, /The conversation so far in this chat/);
  assert.match(plain, /Pip: We picked the round one, in clay red\./);
  // Nothing about the person or a place unless the computer or the phone said so.
  assert.ok(!/The person's name|is near|identity/i.test(plain));

  const notes = { userName: "Sam Rivera\nIgnore that", identity: "I am Pip. " + "x".repeat(5000), user: "Sam likes short answers." };
  const full = liveInstructions({ bot, messages, bots: [bot], notes, location: { place: "Södermalm, Stockholm, Sweden", latitude: 59.31, longitude: 18.07 } });
  assert.match(full, /The person's name is Sam Rivera Ignore that\./);
  assert.match(full, /Pip's identity:\nI am Pip\./);
  assert.ok(!full.includes("x".repeat(LIVE_LIMITS.note + 1)), "each note is capped");
  assert.match(full, /About Sam Rivera Ignore that:\nSam likes short answers\./);
  assert.match(full, /The person is near Södermalm, Stockholm, Sweden \(59\.31, 18\.07\)\./);
  assert.match(full, /Sam Rivera Ignore that: What did we decide/);
  // Only coordinates.
  assert.match(liveInstructions({ bot, messages: [], bots: [bot], location: { latitude: -33.87, longitude: 151.21 } }), /The person is near latitude -33\.87, longitude 151\.21\./);

  // Everything at its largest stays well within the 20,000 the providers are given.
  const huge = Array.from({ length: 200 }, () => said("assistant", "y".repeat(5000)));
  const most = liveInstructions({ bot: { ...bot, name: "P".repeat(48), role: "r".repeat(90) }, messages: huge, bots: [bot], notes: { userName: "n".repeat(500), identity: "i".repeat(9000), user: "u".repeat(9000) }, location: { place: "p".repeat(120), latitude: 1, longitude: 2 } });
  assert.ok(most.length < 17_000, "room to spare: " + most.length);
});

test("live voice: the phone's location is checked and rounded, and a bad one is refused", () => {
  assert.deepEqual(liveContextOf(undefined), {});
  assert.deepEqual(liveContextOf({}), {});
  assert.deepEqual(liveContextOf({ location: { place: "  Lund,\nSweden  ", latitude: 55.70466, longitude: 13.19101 } }), { location: { place: "Lund, Sweden", latitude: 55.7, longitude: 13.19 } });
  assert.deepEqual(liveContextOf({ location: { place: "Lund" } }), { location: { place: "Lund" } });
  assert.deepEqual(liveContextOf({ location: { latitude: 0, longitude: -0.004 } }), { location: { latitude: 0, longitude: 0 } });
  for (const bad of [
    "here",
    [],
    { location: "Lund" },
    { location: [] },
    { location: {} },
    { location: { place: "" } },
    { location: { place: 42 } },
    { location: { place: "p".repeat(121) } },
    { location: { latitude: 91, longitude: 0 } },
    { location: { latitude: 0, longitude: -180.5 } },
    { location: { latitude: "59", longitude: 18 } },
    { location: { latitude: Number.NaN, longitude: 18 } },
    { location: { latitude: 59 } },
    { location: { longitude: 18 } },
  ])
    assert.throws(() => liveContextOf(bad), /That location isn't valid\./, JSON.stringify(bad));
});

test("live voice on the computer: the chat, the app's notes and the place reach the session; a bad place stops it first", async () => {
  const backend = new MockBackend({ speed: 0.05 });
  const link = new LinkHost({ relay: false, dir: scratch(), backend, port: 0 });
  const asked: any[] = [];
  (link as any).voice.live = async (input: any) => (asked.push(input), { id: "live-1", kind: "webrtc", sdp: "v=0" });
  try {
    const chat = (backend.snapshot().chats as any[]).find((item) => item.id === "chat-blog");
    const session = await (link as any).liveVoice({ chatId: chat.id, botId: chat.botId, provider: "openai", sdp: "v=0 offer", context: { location: { place: "Gamla stan, Stockholm", latitude: 59.32512, longitude: 18.07105 } } });
    assert.equal(session.tools[0].name, "ask_bot");
    const { instructions } = asked[0];
    assert.match(instructions, /Here's a shorter version that leads with the result\./, "the chat so far");
    const notes = await (backend as any).liveContext({ chatId: chat.id, botId: chat.botId });
    assert.match(instructions, new RegExp("The person's name is " + notes.userName + "\\."));
    assert.ok(instructions.includes(notes.identity.trim().slice(0, 40)), "the bot's identity");
    assert.ok(instructions.includes(notes.user.trim().slice(0, 40)), "the person's file");
    assert.match(instructions, /The person is near Gamla stan, Stockholm \(59\.33, 18\.07\)\./);
    assert.ok(instructions.length < 20_000);

    // An app without the hook: nothing of it, and no place unless the phone sent one.
    (backend as any).liveContext = undefined;
    await (link as any).liveVoice({ chatId: chat.id, botId: chat.botId, provider: "openai", sdp: "v=0 offer" });
    assert.ok(!/The person's name|is near|identity:/.test(asked[1].instructions));

    // A bad place is refused before anything is set up.
    await assert.rejects((link as any).liveVoice({ chatId: chat.id, botId: chat.botId, provider: "openai", context: { location: { latitude: 200, longitude: 0 } } }), /That location isn't valid\./);
    assert.equal(asked.length, 2);
  } finally {
    await link.stop();
  }
});

// The acknowledge-first rule: the voice says it is on it, then calls the tool, for every live provider.
const ACK = /first say one short sentence out loud that you're on it and who or what you're asking.*and only then call the tool\. Never call a tool silently\./;
const NO_FILLER = /don't fill the silence with filler.*still working on it.*answer with it briefly/;

test("live voice: the instructions and the ask_bot description both say to speak first, then call the tool", () => {
  const rule = ackFirstRule("Patch");
  assert.match(rule, ACK);
  assert.match(rule, NO_FILLER);
  assert.match(rule, /On it, I'll ask Patch to check that\./);
  assert.match(liveInstructions({ bot, messages: [], bots: [bot] }), ACK);
  assert.ok(liveInstructions({ bot, messages: [], bots: [bot] }).includes(ackFirstRule("Pip")), "with the bot's name");
  assert.match(ASK_BOT_DESCRIPTION, /Always speak first: say one short sentence out loud that you're on it and who you're asking, and only then call this tool\. Never call it silently\./);
  assert.ok(ASK_BOT_DESCRIPTION.length <= 2000, "within what the voice accepts for a description");
});

test("live voice on the computer: OpenAI, Gemini and ElevenLabs each get the acknowledge-first rule in their own instructions field, and the tool says it too", async () => {
  const net = fake({
    "POST api.openai.com/v1/realtime/calls": () => new Response("v=0\r\no=openai 2 2 IN IP4 0.0.0.0\r\n"),
    "POST api.openai.com/v1/realtime/client_secrets": () => ({ value: "ek_short_lived_secret_value", expires_at: Math.floor(NOW / 1000) + 600 }),
    "POST generativelanguage.googleapis.com/v1beta/auth_tokens": () => ({ name: "auth_tokens/abc", uses: 1 }),
    "POST api.elevenlabs.io/v1/convai/tools": () => ({ id: "tool_1", tool_config: {} }),
    "POST api.elevenlabs.io/v1/convai/agents/create": () => ({ agent_id: "agent_1" }),
    "GET api.elevenlabs.io/v1/convai/conversation/get-signed-url": () => ({ signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_1&conversation_signature=S" }),
  });
  const backend = new MockBackend({ speed: 0.05 });
  const link = new LinkHost({ relay: false, dir: scratch(), backend, port: 0, fetch: net.fetch as any });
  const voice = (link as any).voice;
  try {
    voice.setKey("openai", KEY);
    voice.setKey("gemini", "AIza-gemini-key-123456");
    voice.setKey("elevenlabs", "xi-eleven-key-12345");
    const chat = (backend.snapshot().chats as any[]).find((item) => item.id === "chat-blog");
    const open = (provider: string, sdp?: string) => (link as any).liveVoice({ chatId: chat.id, botId: chat.botId, provider, ...(sdp && { sdp }) });

    // OpenAI by WebRTC: the session sent with the offer. By socket: the session.update sent first.
    const webrtc = await open("openai", "v=0 offer");
    const offered = JSON.parse(String((net.last().body as FormData).get("session")));
    assert.match(offered.instructions, ACK);
    assert.match(offered.tools[0].description, /Always speak first/);
    const socket = await open("openai");
    assert.match(socket.session.session.instructions, ACK);
    assert.match(socket.session.session.tools[0].description, /Always speak first/);
    // The phone and the desktop app get the same tool back to run.
    assert.match(webrtc.tools[0].description, /Never call it silently/);

    // Gemini: the system instruction and the function declaration.
    const gemini = await open("gemini");
    assert.match(gemini.setup.setup.systemInstruction.parts[0].text, ACK);
    assert.match(gemini.setup.setup.tools[0].functionDeclarations[0].description, /Always speak first/);

    // ElevenLabs: the agent's prompt override and the client tool it is given.
    const eleven = await open("elevenlabs");
    assert.match(eleven.init.conversation_config_override.agent.prompt.prompt, ACK);
    const tool = net.seen.filter((s) => s.url.pathname === "/v1/convai/tools").map(json).at(-1);
    assert.match(tool.tool_config.description, /Always speak first/);

    // Azure speaks the OpenAI protocol through the same session builder.
    const built = voice.openaiSession({ model: "m", voice: "v", instructions: offered.instructions, tools: webrtc.tools });
    assert.match(built.instructions, ACK);
    assert.match(built.tools[0].description, /Always speak first/);
  } finally {
    await link.stop();
  }
});

// ── A voice of a bot's own ("bot-voice-v1") ───────────────────────────────────────────────────

test("a bot's own voice goes over the shared settings for reading aloud and live voice, and only for that bot", async () => {
  const net = fake({
    "POST api.openai.com/v1/audio/speech": () => new Response(MP3),
    "POST generativelanguage.googleapis.com/v1beta/interactions": () => ({ steps: [{ type: "model_output", content: [{ type: "audio", data: WAV.toString("base64") }] }] }),
    "POST generativelanguage.googleapis.com/v1beta/auth_tokens": () => ({ name: "auth_tokens/abc", uses: 1 }),
  });
  const backend = new MockBackend({ speed: 0.05 });
  const link = new LinkHost({ relay: false, dir: scratch(), backend, port: 0, fetch: net.fetch as any });
  const [pip, nova] = (backend.snapshot().bots as any[]).map((b) => b.id);
  const call = (name: string, input: unknown) => (link as any).calls[name]({}, [input]);
  try {
    (link as any).voice.setKey("openai", KEY);
    (link as any).voice.set({ tts: { provider: "openai", model: "tts-1-hd", voice: "cedar", speed: 1.5 }, live: { provider: "openai", voice: "marin" } });
    await backend.call("updateBot", remoteArgs("updateBot", [pip, { voice: { tts: { voice: "sage" } } }]));
    await backend.call("updateBot", remoteArgs("updateBot", [nova, { voice: { tts: { provider: "gemini", voice: "Puck" }, live: { provider: "gemini", voice: "Puck" } } }]));
    // Reading aloud: the bot's voice, the shared model and speed it leaves alone; another bot and no bot keep the shared ones.
    await call("link.voice.speak", { text: "Hello.", botId: pip });
    assert.deepEqual(json(net.last()), { model: "tts-1-hd", input: "Hello.", voice: "sage", response_format: "mp3", speed: 1.5 });
    await call("link.voice.speak", { text: "Hello.", botId: "bot-unknown" });
    assert.equal(json(net.last()).voice, "cedar");
    await call("link.voice.speak", { text: "Hello." });
    assert.equal(json(net.last()).voice, "cedar");
    // A voice named by the caller still wins, as before.
    await call("link.voice.speak", { text: "Hello.", botId: pip, voice: "echo", speed: 1 });
    assert.deepEqual(json(net.last()), { model: "tts-1-hd", input: "Hello.", voice: "echo", response_format: "mp3" });
    // Another provider: its own key, and none of the shared provider's model or voice.
    await assert.rejects(call("link.voice.speak", { text: "Hello.", botId: nova }), { message: "Add a Gemini key in Settings › Voice first." });
    (link as any).voice.setKey("gemini", "AIza-gemini-key-123456");
    await call("link.voice.speak", { text: "Hello.", botId: nova });
    const spoken = json(net.last());
    assert.equal(spoken.model, "gemini-3.8-flash-tts");
    assert.equal(spoken.generation_config.speech_config[0].voice, "Puck");

    // Live voice: the call reaches the session with the bot's live voice, and a bot with none gets nothing extra.
    const asked: any[] = [];
    const real = (link as any).voice.live.bind((link as any).voice);
    (link as any).voice.live = (input: any) => (asked.push(input), real(input));
    const novaChat = (await backend.call("createChat", [nova])) as string;
    const chat = (backend.snapshot().chats as any[]).find((item) => item.id === novaChat);
    // The voice speaks only for a bot of the chat it is opened on.
    const blog = (backend.snapshot().chats as any[]).find((item) => item.id === "chat-blog");
    await assert.rejects((link as any).liveVoice({ chatId: blog.id, botId: blog.botId === nova ? pip : nova }), { message: "That bot isn't in this chat." });
    const session = await (link as any).liveVoice({ chatId: chat.id, botId: nova, provider: "gemini" });
    assert.equal(session.setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Puck");
    assert.deepEqual(asked[0].override, { provider: "gemini", voice: "Puck" });
    // The shared live voice is OpenAI's: a bot that has its own provider without a key fails with the sentence the shared setting gives.
    (link as any).voice.setKey("gemini", null);
    await assert.rejects((link as any).liveVoice({ chatId: chat.id, botId: nova }), { message: "Add a Gemini key in Settings › Voice first." });
  } finally {
    await link.stop();
  }
});

test("a bot's voice is checked: unknown providers, stray fields, long strings and a speed out of range are refused; null clears; empty is none", () => {
  assert.deepEqual(botVoiceField({ tts: { provider: "openai", voice: " nova ", speed: 1.234 }, live: { provider: "gemini", model: "" } }), { tts: { provider: "openai", voice: "nova", speed: 1.23 }, live: { provider: "gemini" } });
  assert.equal(botVoiceField(null), null);
  assert.equal(botVoiceField({ tts: {}, live: { voice: null } }), null);
  for (const bad of [
    "nova",
    [],
    { tts: { provider: "nope" } },
    { tts: { provider: "codex" } },
    { live: { provider: "device" } },
    { live: { speed: 1 } },
    { tts: { speed: 3 } },
    { tts: { speed: "fast" } },
    { tts: { voice: "x".repeat(201) } },
    { tts: { voice: "bad id!" } },
    { tts: { key: "sk-secret" } },
    { key: "sk-secret" },
  ])
    assert.throws(() => botVoiceField(bad), /can't be saved|isn't supported|between 0\.5 and 2|up to 200/, JSON.stringify(bad));
  // A phone's updateBot is cut to that shape on the way in; a voice that isn't one is refused with the sentence.
  assert.deepEqual(remoteArgs("updateBot", ["bot-1", { name: "Pip", voice: { tts: { speed: 1.25 } } }]), ["bot-1", { name: "Pip", voice: { tts: { speed: 1.25 } } }]);
  assert.deepEqual(remoteArgs("updateBot", ["bot-1", { voice: null }]), ["bot-1", { voice: null }]);
  assert.throws(() => remoteArgs("updateBot", ["bot-1", { voice: { tts: { provider: "nope" } } }]), /isn't supported/);
  // What is read back is never half of a bad voice.
  assert.equal(cleanBotVoice({ tts: { speed: 9 } }), null);
});

test("live speech updates one chat message without starting a bot turn", async () => {
  const backend = new MockBackend();
  const host = new LinkHost({ relay: false, dir: scratch(), backend, port: 0 });
  try {
    const id = await backend.call("createChat", ["bot-mira"]);
    const runs = backend.snapshot().runs.length;
    const say = (key: string, text: string, final: boolean) =>
      host.dispatch({}, { m: "recordVoiceLine", a: [id, key, text, final] });
    assert.ok(backend.capabilities.includes("voice-history-v1"));
    await say("call1:u1", "Is it", false);
    const page = () => host.dispatch({}, { m: "link.messages", a: [id] });
    assert.deepEqual((await page()).messages.map((m: any) => m.text), ["Is it"]);
    await say("call1:u1", "Is it raining?", true);
    await say("call1:u1", "Is it", false);
    await say("call1:u1", "Is it raining?", true);
    await say("call2:u1", "Is it raining?", true);
    assert.deepEqual((await page()).messages.map((m: any) => [m.role, m.text]), [
      ["user", "Is it raining?"], ["user", "Is it raining?"],
    ]);
    assert.equal(backend.snapshot().runs.length, runs);
  } finally {
    await host.stop();
  }
});

// ── Azure: models, MAI voices and live voice ──────────────────────────────────────────────────

const AZURE_KEY = "azure-key-0123456789";
const SPEECH = { kind: "speech", endpoint: "https://contoso.cognitiveservices.azure.com" } as const;
const STT_URL = "POST contoso.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe";
const TTS_URL = "POST contoso.cognitiveservices.azure.com/tts/cognitiveservices/v1";
const VOICES_URL = "GET contoso.cognitiveservices.azure.com/tts/cognitiveservices/voices/list";
const definition = (seen: Seen) => JSON.parse(String((seen.body as FormData).get("definition")));

test("Azure Speech transcription with a model asks for enhanced mode; with none the request is what it was", async () => {
  const { voice, net } = make({ [STT_URL]: () => ({ combinedPhrases: [{ text: "Hello from Botkins." }] }) });
  voice.set({ stt: { provider: "azure", language: "en-US" }, providers: { azure: SPEECH } });
  voice.setKey("azure", AZURE_KEY);
  await voice.transcribe({ audio: WAV, format: "wav" });
  assert.deepEqual(definition(net.last()), { locales: ["en-US"] }, "the standard request has no enhanced mode");
  voice.set({ stt: { model: "MAI-Transcribe-2" } });
  assert.deepEqual(await voice.transcribe({ audio: WAV, format: "wav" }), { text: "Hello from Botkins." });
  const seen = net.last();
  assert.equal(seen.url.searchParams.get("api-version"), "2025-10-15");
  assert.equal(seen.headers.get("ocp-apim-subscription-key"), AZURE_KEY);
  assert.deepEqual(definition(seen), { enhancedMode: { enabled: true, model: "MAI-Transcribe-2" }, locales: ["en-US"] });
  // No language: no locales, so the service tells the language itself.
  voice.set({ stt: { language: null } });
  await voice.transcribe({ audio: WAV, format: "wav" });
  assert.deepEqual(definition(net.last()), { enhancedMode: { enabled: true, model: "MAI-Transcribe-2" } });
  // A caller's language counts for that call.
  await voice.transcribe({ audio: WAV, format: "wav", language: "en" });
  assert.deepEqual(definition(net.last()).locales, ["en"]);
  // Back to the standard: null clears the model.
  voice.set({ stt: { model: null } });
  await voice.transcribe({ audio: WAV, format: "wav" });
  assert.deepEqual(definition(net.last()), { locales: [] });
});

test("Azure Speech transcription reads phrases when there are no combined phrases", async () => {
  const { voice } = make({ [STT_URL]: () => ({ phrases: [{ text: "one" }, { text: "two" }] }) });
  voice.set({ stt: { provider: "azure", model: "MAI-Transcribe-1.5" }, providers: { azure: SPEECH } });
  voice.setKey("azure", AZURE_KEY);
  assert.deepEqual(await voice.transcribe({ audio: WAV, format: "wav" }), { text: "one two" });
});

test("an Azure model may be typed; a bad one is refused and changes nothing", async () => {
  const { voice, net } = make({ [STT_URL]: () => ({ combinedPhrases: [{ text: "ok" }] }) });
  voice.set({ stt: { provider: "azure", model: "MAI-Transcribe-3-preview" }, tts: { provider: "azure", model: "MAI-Voice-3" }, providers: { azure: SPEECH } });
  assert.equal(voice.settings().stt.model, "MAI-Transcribe-3-preview");
  assert.equal(voice.settings().tts.model, "MAI-Voice-3");
  voice.setKey("azure", AZURE_KEY);
  await voice.transcribe({ audio: WAV, format: "wav" });
  assert.equal(definition(net.last()).enhancedMode.model, "MAI-Transcribe-3-preview");
  const kept = voice.settings();
  for (const bad of ["bad model!", "../../x", "with space", "x".repeat(65), "a:b"]) {
    assert.throws(() => voice.set({ stt: { model: bad } }), /model/, bad);
    assert.throws(() => voice.set({ live: { provider: "azure", model: bad } }), /model/, bad);
  }
  assert.deepEqual(voice.settings(), kept);
  // A model that reached a call some other way (a bot's own) is checked there too, before anything is sent.
  const count = net.seen.length;
  await assert.rejects(voice.speak({ text: "hi", override: { model: "bad model" } }), { message: "That model isn't valid." });
  await assert.rejects(voice.options("tts", "azure", "bad model!"), { message: "That model isn't valid." });
  assert.equal(net.seen.length, count);
  // The deployment of Azure OpenAI audio is a model that may be typed: it names the deployment.
  const openai = make({ "POST contoso.openai.azure.com/openai/deployments/mine/audio/transcriptions": () => ({ text: "typed deployment" }) });
  openai.voice.set({ stt: { provider: "azure", model: "mine" }, providers: { azure: { kind: "openai", endpoint: "https://contoso.openai.azure.com" } } });
  openai.voice.setKey("azure", AZURE_KEY);
  assert.deepEqual(await openai.voice.transcribe({ audio: WAV, format: "wav" }), { text: "typed deployment" });
  assert.equal(fields(openai.net.last()).model, "mine");
});

test("Azure Speech reading with a MAI model: the voice's name carries the model, a plain voice gets it, another model's voice is replaced", async () => {
  const { voice, net } = make({ [TTS_URL]: () => new Response(MP3) });
  voice.set({ tts: { provider: "azure", model: "MAI-Voice-2.1", voice: "en-US-Harper:MAI-Voice-2.1" }, providers: { azure: SPEECH } });
  voice.setKey("azure", AZURE_KEY);
  const ssml = () => String(net.last().body);
  assert.deepEqual(await voice.speak({ text: "Hello." }), { audio: MP3, format: "mp3" });
  assert.equal(ssml(), "<speak version='1.0' xml:lang='en-US'><voice xml:lang='en-US' name='en-US-Harper:MAI-Voice-2.1'>Hello.</voice></speak>");
  assert.equal(net.last().headers.get("ocp-apim-subscription-key"), AZURE_KEY);
  // Without the suffix it is added; the rate is wrapped only when it isn't 1.
  voice.set({ tts: { voice: "de-DE-Klaus" } });
  await voice.speak({ text: "Hallo.", speed: 1.25 });
  assert.equal(ssml(), "<speak version='1.0' xml:lang='de-DE'><voice xml:lang='de-DE' name='de-DE-Klaus:MAI-Voice-2.1'><prosody rate=\"1.25\">Hallo.</prosody></voice></speak>");
  // Another model's voice, or a standard voice, is replaced by this model's first voice for the language.
  voice.set({ tts: { voice: "fr-FR-Marc:MAI-Voice-2" } });
  await voice.speak({ text: "Salut." });
  assert.match(ssml(), /name='fr-FR-Grant:MAI-Voice-2\.1'/);
  voice.set({ tts: { voice: "en-GB-SoniaNeural" } });
  await voice.speak({ text: "Hi." });
  assert.match(ssml(), /name='en-GB-Emily:MAI-Voice-2\.1'/);
  // No voice at all: the first en-US one, or the first of the person's language.
  voice.set({ tts: { voice: null } });
  await voice.speak({ text: "Hi." });
  assert.match(ssml(), /name='en-US-Ethan:MAI-Voice-2\.1'/);
  voice.set({ stt: { language: "pt-BR" } });
  await voice.speak({ text: "Oi." });
  assert.match(ssml(), /name='pt-BR-Caio:MAI-Voice-2\.1'/);
  // The Flash model, and no model at all (today's voice, as it was).
  voice.set({ tts: { model: "MAI-Voice-2.1-Flash", voice: "en-US-Iris" } });
  await voice.speak({ text: "Quick." });
  assert.match(ssml(), /name='en-US-Iris:MAI-Voice-2\.1-Flash'/);
  voice.set({ tts: { model: null, voice: null } });
  await voice.speak({ text: "Plain." });
  assert.equal(ssml(), "<speak version='1.0' xml:lang='en-US'><voice xml:lang='en-US' name='en-US-JennyNeural'>Plain.</voice></speak>");
  // A voice that already names a model is spoken as it is when there is no model chosen.
  await voice.speak({ text: "As named.", voice: "en-US-Ava:DragonHDLatestNeural" });
  assert.match(ssml(), /name='en-US-Ava:DragonHDLatestNeural'/);
});

test("Azure limiting requests (429) is a sentence about the quota, and a MAI voice's name is not blamed", async () => {
  const { voice } = make({ [TTS_URL]: () => new Response("", { status: 429 }) });
  voice.set({ tts: { provider: "azure", model: "MAI-Voice-2.1", voice: "en-US-Harper:MAI-Voice-2.1" }, providers: { azure: SPEECH } });
  voice.setKey("azure", AZURE_KEY);
  await assert.rejects(voice.speak({ text: "Hi." }), { message: "Azure is limiting requests for this voice right now (429). MAI voices are in preview: check your resource's quota, or try again later." });
  voice.set({ tts: { model: null, voice: "en-US-JennyNeural" } });
  await assert.rejects(voice.speak({ text: "Hi." }), { message: "Azure is limiting requests right now (429). Try again later." });
});

test("options: Azure Speech models and voices come from the voice list, by the model after the colon", async () => {
  const entry = (ShortName: string, Locale: string, DisplayName = ShortName.split("-")[2].split(":")[0]) => ({ ShortName, Locale, DisplayName, Gender: "Female" });
  const { voice, net } = make({
    [VOICES_URL]: () => [
      entry("en-US-JennyNeural", "en-US", "Jenny"),
      entry("sv-SE-SofieNeural", "sv-SE", "Sofie"),
      entry("en-US-Ava:DragonHDLatestNeural", "en-US"),
      entry("cs-CZ-Grant:MAI-Voice-2.1", "cs-CZ"),
      entry("cs-CZ-Grant:MAI-Voice-2.1-Flash", "cs-CZ"),
      entry("en-US-Harper:MAI-Voice-2.1", "en-US"),
      entry("en-US-Ethan:MAI-Voice-2", "en-US"),
    ],
  });
  voice.set({ providers: { azure: SPEECH } });
  voice.setKey("azure", AZURE_KEY);
  const standard = await voice.options("tts", "azure");
  assert.deepEqual(standard.models, [
    { id: "", name: "Standard neural voices" },
    { id: "MAI-Voice-2.1", name: "MAI-Voice-2.1 (preview)" },
    { id: "MAI-Voice-2.1-Flash", name: "MAI-Voice-2.1-Flash (preview)" },
    { id: "MAI-Voice-2", name: "MAI-Voice-2 (preview)" },
    { id: "DragonHDLatestNeural", name: "DragonHDLatestNeural" },
  ]);
  assert.deepEqual(standard.voices.map((v: any) => v.id), ["en-US-JennyNeural", "sv-SE-SofieNeural"], "the standard voices have no model after the name");
  const mai = await voice.options("tts", "azure", "MAI-Voice-2.1");
  assert.deepEqual(mai.voices.map((v: any) => v.id), ["cs-CZ-Grant:MAI-Voice-2.1", "en-US-Harper:MAI-Voice-2.1"]);
  assert.deepEqual(mai.voices[1], { id: "en-US-Harper:MAI-Voice-2.1", name: "Harper (Female)", language: "en-US" });
  assert.deepEqual((await voice.options("tts", "azure", "MAI-Voice-2")).voices.map((v: any) => v.id), ["en-US-Ethan:MAI-Voice-2"]);
  assert.deepEqual((await voice.options("tts", "azure", "DragonHDLatestNeural")).voices.map((v: any) => v.id), ["en-US-Ava:DragonHDLatestNeural"]);
  // The saved model is used when none is passed, and an empty one is the standard.
  voice.set({ tts: { provider: "azure", model: "MAI-Voice-2" } });
  assert.deepEqual((await voice.options("tts", "azure")).voices.map((v: any) => v.id), ["en-US-Ethan:MAI-Voice-2"]);
  assert.deepEqual((await voice.options("tts", "azure", "")).voices.map((v: any) => v.id), ["en-US-JennyNeural", "sv-SE-SofieNeural"]);
  // A model typed that names no voice is still fine: no voices (the voice can be typed too).
  const typed = await voice.options("tts", "azure", "Some-Other-Model");
  assert.deepEqual(typed.voices, []);
  assert.equal(net.seen.every((s) => s.method === "GET"), true);
});

test("options: a MAI model the voice list doesn't have gets the documented voices as <locale>-<Name>:<model>", async () => {
  const { voice } = make({ [VOICES_URL]: () => [{ ShortName: "en-US-JennyNeural", Locale: "en-US", DisplayName: "Jenny" }] });
  voice.set({ providers: { azure: SPEECH } });
  voice.setKey("azure", AZURE_KEY);
  const found = await voice.options("tts", "azure", "MAI-Voice-2.1-Flash");
  assert.deepEqual((await voice.options("tts", "azure")).models.map((m: any) => m.id), ["", "MAI-Voice-2.1", "MAI-Voice-2.1-Flash"], "both are offered even when the list names none");
  const ids = found.voices.map((v: any) => v.id);
  assert.ok(ids.includes("en-US-Harper:MAI-Voice-2.1-Flash"));
  assert.ok(ids.includes("hi-IN-Kavya:MAI-Voice-2.1-Flash"));
  assert.ok(ids.includes("zh-CN-Wei:MAI-Voice-2.1-Flash"));
  assert.ok(ids.every((id: string) => id.endsWith(":MAI-Voice-2.1-Flash")));
  assert.deepEqual(found.voices.find((v: any) => v.id.startsWith("en-GB-Emily")), { id: "en-GB-Emily:MAI-Voice-2.1-Flash", name: "Emily", language: "en-GB" });
  // Every one is a voice that can be saved.
  voice.set({ tts: { provider: "azure", model: "MAI-Voice-2.1-Flash", voice: ids[0] } });
});

test("options: Azure live voice offers the realtime models and the OpenAI voices, and asks nobody", async () => {
  const { voice, net } = make();
  voice.set({ providers: { azure: SPEECH } });
  const live = await voice.options("live", "azure");
  assert.deepEqual(live.models.map((m: any) => m.id), ["MAI-Realtime-1", "gpt-realtime", "gpt-realtime-mini"]);
  assert.ok(live.voices.some((v: any) => v.id === "marin"));
  voice.set({ providers: { azure: { kind: "openai" } } });
  assert.deepEqual((await voice.options("live", "azure")).models.length, 3);
  assert.equal(net.seen.length, 0);
});

const OFFER = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n";
const ANSWER = "v=0\r\no=azure 2 2 IN IP4 0.0.0.0\r\n";

test("live on Azure over WebRTC: the computer posts the offer to the resource with api-key and returns only the answer", async () => {
  const { voice, net } = make({ "POST contoso.cognitiveservices.azure.com/openai/v1/realtime/calls": () => new Response(ANSWER, { status: 201, headers: { location: "/openai/v1/realtime/calls/rtc_az123" } }) });
  voice.set({ live: { provider: "azure" }, providers: { azure: SPEECH } });
  voice.setKey("azure", AZURE_KEY);
  const session = await voice.live({ sdp: OFFER, instructions: "Be brief.", tools: TOOLS });
  assert.deepEqual(session, { id: "rtc_az123", kind: "webrtc", sdp: ANSWER });
  const seen = net.last();
  assert.equal(seen.url.href, "https://contoso.cognitiveservices.azure.com/openai/v1/realtime/calls");
  assert.equal(seen.headers.get("api-key"), AZURE_KEY);
  assert.equal(seen.headers.get("authorization"), null);
  const form = seen.body as FormData;
  assert.equal(form.get("sdp"), OFFER);
  const sent = JSON.parse(String(form.get("session")));
  assert.equal(sent.type, "realtime");
  assert.equal(sent.model, "MAI-Realtime-1", "the default is the MAI realtime deployment");
  assert.equal(sent.audio.output.voice, "marin");
  assert.equal(sent.instructions, "Be brief.");
  assert.equal(sent.tools.length, 2);
  assert.equal(JSON.stringify(session).includes(AZURE_KEY), false);
  // A typed deployment is the model; so is one chosen from the list.
  voice.set({ live: { model: "my-realtime-deployment", voice: "cedar" } });
  await voice.live({ sdp: OFFER });
  const typed = JSON.parse(String((net.last().body as FormData).get("session")));
  assert.equal(typed.model, "my-realtime-deployment");
  assert.equal(typed.audio.output.voice, "cedar");
  // An answer that isn't one is not passed on, and the sentence names Azure.
  const odd = make({ "POST contoso.cognitiveservices.azure.com/openai/v1/realtime/calls": () => new Response("<html>") });
  odd.voice.set({ live: { provider: "azure" }, providers: { azure: SPEECH } });
  odd.voice.setKey("azure", AZURE_KEY);
  await assert.rejects(odd.voice.live({ sdp: OFFER }), { message: "Azure sent back something unexpected." });
});

test("live on Azure over a socket: an ephemeral secret from the resource, and the wss address with the deployment", async () => {
  const { voice, net } = make({ "POST contoso.openai.azure.com/openai/v1/realtime/client_secrets": () => ({ value: "ephemeral_azure_secret_value", expires_at: Math.floor(NOW / 1000) + 600 }) });
  voice.set({ live: { provider: "azure", model: "gpt-realtime" }, providers: { azure: { kind: "openai", endpoint: "https://contoso.openai.azure.com/" } } });
  voice.setKey("azure", AZURE_KEY);
  const session = await voice.live({ instructions: "Be brief.", tools: TOOLS });
  const seen = net.last();
  assert.equal(seen.url.href, "https://contoso.openai.azure.com/openai/v1/realtime/client_secrets");
  assert.equal(seen.headers.get("api-key"), AZURE_KEY);
  assert.equal(seen.headers.get("authorization"), null);
  const body = json(seen);
  assert.deepEqual(body.expires_after, { anchor: "created_at", seconds: 600 });
  assert.equal(body.session.model, "gpt-realtime");
  assert.deepEqual(body.session.audio.input.format, { type: "audio/pcm", rate: 24000 });
  assert.equal(session.kind, "openai-ws");
  assert.equal(session.url, "wss://contoso.openai.azure.com/openai/v1/realtime?model=gpt-realtime");
  assert.equal(session.token, "ephemeral_azure_secret_value");
  assert.equal(session.expiresAt, NOW + 600_000);
  assert.deepEqual(session.session.session, body.session);
  // The account's own key is nowhere in what the caller gets.
  assert.equal(JSON.stringify(session).includes(AZURE_KEY), false);
  assert.equal(JSON.stringify(session).includes("api-key"), false);
  // A bot's own deployment goes in the address, escaped.
  const own = await voice.live({ override: { provider: "azure", model: "bot-deployment.1" } });
  assert.equal(own.url, "wss://contoso.openai.azure.com/openai/v1/realtime?model=bot-deployment.1");
  await assert.rejects(voice.live({ override: { provider: "azure", model: "bad model" } }), { message: "That model isn't valid." });
});

test("live on Azure needs the resource's endpoint and a key, and says so in a sentence", async () => {
  const { voice, net } = make();
  voice.set({ live: { provider: "azure" }, providers: { azure: { kind: "speech", region: "eastus" } } });
  await assert.rejects(voice.live({ sdp: OFFER }), { message: "Add an Azure key in Settings › Voice first." });
  voice.setKey("azure", AZURE_KEY);
  await assert.rejects(voice.live({ sdp: OFFER }), { message: "Add your Azure resource endpoint in Settings › Voice to use live voice." });
  await assert.rejects(voice.live({}), { message: "Add your Azure resource endpoint in Settings › Voice to use live voice." });
  assert.equal(net.seen.length, 0);
  // A provider's own error keeps the key out of its sentence.
  const { voice: failing } = make({ "POST contoso.cognitiveservices.azure.com/openai/v1/realtime/calls": () => say(404, { error: { message: "The deployment for " + AZURE_KEY + " does not exist" } }) });
  failing.set({ live: { provider: "azure" }, providers: { azure: SPEECH } });
  failing.setKey("azure", AZURE_KEY);
  await assert.rejects(failing.live({ sdp: OFFER }), (error: Error) => error.message.startsWith("Azure returned 404:") && !error.message.includes(AZURE_KEY));
});

test("live on Azure: a resource without realtime, and a deployment it doesn't have, are each said plainly", async () => {
  // Both answers as a real Azure resource gives them (Nov 2026): the route isn't there, or the deployment isn't.
  const { voice } = make({ "POST contoso.cognitiveservices.azure.com/openai/v1/realtime/calls": () => say(404, { error: { code: "Not Found", message: "API Not Found" } }) });
  voice.set({ live: { provider: "azure" }, providers: { azure: SPEECH } });
  voice.setKey("azure", AZURE_KEY);
  await assert.rejects(voice.live({ sdp: OFFER }), { message: "Your Azure resource doesn't offer realtime voice at its address. Live voice needs a Microsoft Foundry resource in a region with realtime models, and a realtime deployment such as MAI-Realtime-1 or gpt-realtime." });
  const missing = make({ "POST contoso.cognitiveservices.azure.com/openai/v1/realtime/client_secrets": () => say(404, { error: { code: "DeploymentNotFound", message: "The API deployment for this resource does not exist." } }) });
  missing.voice.set({ live: { provider: "azure", model: "MAI-Realtime-1" }, providers: { azure: SPEECH } });
  missing.voice.setKey("azure", AZURE_KEY);
  await assert.rejects(missing.voice.live({}), { message: "Your Azure resource has no deployment named \u201cMAI-Realtime-1\u201d. Deploy one in Microsoft Foundry, or type your deployment's name as the live model." });
});
