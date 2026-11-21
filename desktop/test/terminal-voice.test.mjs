// Voice from the command line (cli/commands/voice.mjs), against a real service. What it holds to: a
// provider's key is never a word on the command line and is never printed, saved in the workspace or
// logged; `voice set` takes an address only with its key and a yes; `voice options` asks a provider only
// at the address that the app saved; with no terminal a question fails and names its flag; a change is in
// the log with its name and never its value.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { main } from "../cli/main.mjs";
import { voiceCommands, VOICE_KINDS } from "../cli/commands/voice.mjs";
import { ADDRESS_NEEDS_A_YES, VOICE_PROVIDERS } from "../desktop/terminal/control-voice.mjs";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { startService } from "../desktop/terminal/serve.mjs";
import { controlClient } from "../desktop/terminal/socket.mjs";

const skip = process.platform === "win32" && "The terminal host runs on Linux and macOS.";
const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
/** A real service, and `botkins(argv, { input, tty })` to run a command against it. */
async function service(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-voice-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const client = controlClient(paths.socket, { timeout: 40_000 });
  const botkins = async (argv, { input = "", tty = false } = {}) => {
    let out = "";
    let err = "";
    const stdin = Readable.from(input ? [input] : []);
    stdin.isTTY = tty;
    const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
    const exit = await main(argv, { stdout: sink((text) => void (out += text)), stderr: sink((text) => void (err += text)), stdin, env: {}, client });
    return { exit, out, err, json: () => JSON.parse(out) };
  };
  const lines = async (first) => (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => text.startsWith(first)).map((text) => text.slice(first.length));
  const changes = () => lines("Changed from the command line: ");
  const tried = () => lines("Tried from the command line: ");
  const everything = () => [readFileSync(join(paths.dataDir, "workspace.json"), "utf8"), readFileSync(paths.logFile, "utf8")].join("\n");
  return { dir, paths, running, client, botkins, changes, tried, everything };
}
const SECRET = "sk-VOICE-key-that-must-not-show";
const KEY_ARGUMENT = "sk-ON-THE-COMMAND-LINE-0123456789";

test("voice: the choices, and a key that goes in from standard input or a hidden question and never comes out", { skip }, async (t) => {
  const { botkins, client, changes, tried, everything } = await service(t);
  const shown = await botkins(["voice", "show"]);
  assert.equal(shown.exit, 0, shown.err);
  assert.match(shown.out, /^Speech to text: This computer\nText to speech: This computer, speed 1, replies read aloud off\nLive voice: not chosen\n/);
  assert.match(shown.out, /OpenAI +no key +baseUrl https:\/\/api\.openai\.com\/v1/);
  assert.equal((await botkins(["voice", "show", "--json"])).json().providers.openai.hasKey, false);
  // The lists a provider offers.
  const options = await botkins(["voice", "options", "tts", "openai"]);
  assert.equal(options.exit, 0, options.err);
  assert.match(options.out, /^Models:\n {2}\S+/);
  assert.match(options.out, /\nVoices:\n {2}\S+/);
  assert.ok((await botkins(["voice", "options", "stt", "openai", "--json"])).json().models.length > 0);
  assert.equal((await botkins(["voice", "options", "stt", "nowhere"])).exit, 1);
  assert.equal((await botkins(["voice", "options", "stt"])).exit, 2);

  // The choices.
  const set = await botkins(["voice", "set", "--tts", "openai", "--tts-voice", "alloy", "--tts-speed", "1.25", "--tts-auto", "on", "--stt", "openai", "--stt-language", "en"]);
  assert.equal(set.exit, 0, set.err);
  assert.match(set.out, /^Saved the stt, tts choices\.\n/);
  const voice = (await botkins(["voice", "show", "--json"])).json();
  assert.deepEqual([voice.tts.provider, voice.tts.voice, voice.tts.speed, voice.tts.auto, voice.stt.provider, voice.stt.language], ["openai", "alloy", 1.25, true, "openai", "en"]);
  assert.equal((await botkins(["voice", "set", "--live", "openai"])).exit, 0);
  assert.equal((await botkins(["voice", "set", "--live", "none"])).exit, 0);
  assert.equal((await botkins(["voice", "show", "--json"])).json().live.provider, null);
  // What does not fit is refused: a provider, a speed, a switch, nothing at all, a word that is no option.
  assert.equal((await botkins(["voice", "set", "--tts", "nowhere"])).exit, 2);
  assert.equal((await botkins(["voice", "set", "--tts-speed", "fast"])).exit, 2);
  assert.equal((await botkins(["voice", "set", "--tts-speed", "9"])).exit, 1);
  assert.equal((await botkins(["voice", "set", "--tts-auto", "sometimes"])).exit, 2);
  assert.equal((await botkins(["voice", "set"])).exit, 2);
  assert.equal((await botkins(["voice", "set", "--base-url", "https://example.com"])).exit, 2);
  assert.match((await botkins(["voice", "set", "--help"])).out, /A key is for the address that it was given for, so the key that is saved for the provider is removed when its address is set, changed or taken away\./);

  // A key from standard input.
  const saved = await botkins(["voice", "key", "openai"], { input: SECRET + "\n" });
  assert.equal(saved.exit, 0, saved.err);
  assert.equal(saved.out, "Saved the OpenAI key.\n");
  assert.deepEqual((await client.call("voice.get")).providers.openai.hasKey, true);
  const after = await botkins(["voice", "show"]);
  assert.match(after.out, /OpenAI +key set/);
  // The key is nowhere: not in an answer, not in the workspace file, not in the log.
  for (const text of [saved.out, saved.err, after.out, JSON.stringify((await botkins(["voice", "show", "--json"])).json()), JSON.stringify(await client.call("voice.get")), everything()]) assert.equal(text.includes(SECRET), false);
  // The key is never a word on the command line. A word after the provider is refused, and not repeated.
  const word = await botkins(["voice", "key", "openai", KEY_ARGUMENT, "--yes"], { input: SECRET + "2\n" });
  assert.equal(word.exit, 2);
  assert.equal((word.out + word.err).includes(KEY_ARGUMENT), false);
  assert.equal((await botkins(["voice", "key", "--key", KEY_ARGUMENT])).exit, 2);
  // Replacing a saved key needs a yes. With no terminal that is --yes, and the refusal says so.
  const replace = await botkins(["voice", "key", "openai"], { input: SECRET + "2\n" });
  assert.equal(replace.exit, 2);
  assert.match(replace.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal((await botkins(["voice", "key", "openai", "--yes"], { input: SECRET + "2\n" })).exit, 0);
  // Typed at a terminal, not shown.
  const typed = await botkins(["voice", "key", "elevenlabs"], { input: SECRET + "3\n", tty: true });
  assert.equal(typed.exit, 0, typed.err);
  assert.equal((typed.out + typed.err).includes(SECRET), false);
  assert.match(typed.err, /The ElevenLabs key \(not shown\): /);
  assert.equal((await client.call("voice.get")).providers.elevenlabs.hasKey, true);
  // Nothing typed, no such provider, a provider that takes no key, a key the app turns down (and does not repeat).
  assert.equal((await botkins(["voice", "key", "gemini"], { input: "\n" })).exit, 2);
  assert.equal((await botkins(["voice", "key", "nowhere"], { input: SECRET })).exit, 2);
  assert.equal((await botkins(["voice", "key", "local"], { input: SECRET })).exit, 2);
  assert.equal((await botkins(["voice", "key"], { input: SECRET })).exit, 2);
  const invalid = await botkins(["voice", "key", "gemini"], { input: "ab\n" });
  assert.equal(invalid.exit, 1);
  assert.equal((invalid.out + invalid.err).includes("ab\n"), false);
  // Removing a key needs a yes too, and removing what is not there says so.
  const remove = await botkins(["voice", "key", "openai", "--remove"]);
  assert.equal(remove.exit, 2);
  assert.equal((await client.call("voice.get")).providers.openai.hasKey, true);
  const removed = await botkins(["voice", "key", "openai", "--remove", "--yes", "--json"]);
  assert.deepEqual(removed.json(), { provider: "openai", hasKey: false });
  assert.match((await botkins(["voice", "key", "openai", "--remove"])).out, /^There is no OpenAI key to remove\.\n$/);

  // The log: the call and the provider (or the sections), never a key and never a choice.
  const log = await changes();
  assert.deepEqual(log.filter((line) => line.startsWith("voice.key")), ["voice.key openai", "voice.key openai", "voice.key elevenlabs", "voice.key openai"]);
  assert.ok(log.includes("voice.set stt, tts"));
  assert.ok(log.every((line) => !line.includes(SECRET) && !/alloy|1\.25/.test(line)), log.join("\n"));
  assert.ok((await tried()).every((line) => !line.includes(SECRET) && !line.includes(KEY_ARGUMENT)));
});

test("voice: the socket's own call takes no address without the mark, whatever the field is called", { skip }, async (t) => {
  const { client, changes, tried } = await service(t);
  const EVIL = "https://evil.example";
  for (const patch of [
    { providers: { custom: { baseUrl: EVIL } } },
    { providers: { openai: { baseUrl: EVIL } } },
    { providers: { azure: { endpoint: EVIL } } },
    { baseUrl: EVIL },
    { tts: { baseUrl: EVIL } },
    { tts: { provider: "openai", endpoint: EVIL } },
    { live: { provider: "openai", host: "evil.example" } },
    { stt: { provider: "azure", region: "evil" } },
  ]) {
    await assert.rejects(client.call("voice.set", patch), (error) => error.message === ADDRESS_NEEDS_A_YES, JSON.stringify(patch));
  }
  // A field that is not an address is refused with the fields that there are, and says nothing of an address.
  await assert.rejects(client.call("voice.set", { tts: { colour: "red" } }), /tts has no colour to change here\. It has: provider, model, voice, speed, auto\./);
  await assert.rejects(client.call("voice.set", { sound: { provider: "openai" } }), /does not change sound\. It sets the choices of stt, tts and live\./);
  await assert.rejects(client.call("voice.set", {}), /Give what to change\./);
  const now = await client.call("voice.get");
  assert.equal(now.providers.custom.baseUrl, undefined);
  assert.equal(now.providers.openai.baseUrl, "https://api.openai.com/v1");
  assert.deepEqual(await changes(), []);
  // Each refusal is a try in the log, with the section names that were allowed and no address.
  const log = await tried();
  assert.ok(log.every((line) => !line.includes("evil") && !line.includes("colour")), log.join("\n"));
});

test("voice options: which requests a call can start, to which host, and that the caller does not choose it", { skip }, async (t) => {
  const { botkins, client, running, changes } = await service(t);
  const voice = running.runtime.link.voice;
  const sent = [];
  // The provider's server is replaced by one that records each request; no test reaches a real provider.
  voice.fetchImpl = async (url, init) => {
    sent.push({ url: String(url), auth: init?.headers?.Authorization ?? init?.headers?.["xi-api-key"] ?? init?.headers?.["Ocp-Apim-Subscription-Key"] ?? null });
    if (String(url).includes("/v2/voices")) return Response.json({ voices: [{ voice_id: "v1", name: "Rachel" }] });
    if (String(url).endsWith("/v1/models")) return Response.json([{ model_id: "m1", name: "Flash", can_do_text_to_speech: true }]);
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "custom-model" }] });
    return Response.json([]);
  };
  const KEY = "the-saved-key-1234";

  // A list that is built in: no request at all, with or without a key.
  await client.call("voice.key", "openai", KEY);
  await client.call("voice.key", "gemini", KEY);
  // A key that is saved is lost when it is replaced or removed: the call needs the mark of a caller that got a yes.
  await assert.rejects(client.call("voice.key", "gemini", KEY), { code: "NEEDS_YES" });
  await assert.rejects(client.call("voice.key", "gemini", null), { code: "NEEDS_YES" });
  assert.equal((await client.call("voice.get")).providers.gemini.hasKey, true);
  for (const [kind, provider] of [["tts", "openai"], ["stt", "openai"], ["live", "openai"], ["tts", "gemini"], ["live", "gemini"], ["stt", "device"], ["tts", "device"], ["stt", "elevenlabs"]]) {
    assert.equal((await botkins(["voice", "options", kind, provider])).exit, 0, kind + " " + provider);
  }
  assert.deepEqual(sent, []);

  // ElevenLabs: its own fixed host, with the saved key. Without a key, a refusal and no request.
  assert.equal((await botkins(["voice", "options", "tts", "elevenlabs"])).exit, 1);
  assert.deepEqual(sent, []);
  await client.call("voice.key", "elevenlabs", KEY);
  const eleven = await botkins(["voice", "options", "tts", "elevenlabs", "--json"]);
  assert.equal(eleven.exit, 0, eleven.err);
  assert.deepEqual(eleven.json().voices.map((entry) => entry.id), ["v1"]);
  assert.deepEqual(sent.map((request) => new URL(request.url).host), ["api.elevenlabs.io", "api.elevenlabs.io"]);
  assert.ok(sent.every((request) => request.auth === KEY));
  assert.equal(eleven.out.includes(KEY) || eleven.err.includes(KEY), false);

  // A custom server: only the address that the app saved. The caller has no call that sets it.
  sent.length = 0;
  assert.equal((await botkins(["voice", "options", "tts", "custom"])).exit, 1, "no address saved yet");
  assert.deepEqual(sent, []);
  await running.runtime.handlers.setVoice({ providers: { custom: { baseUrl: "https://speech.example.test/v1" } } }); // the window's own call (it drops a key, so the key comes after)
  await client.call("voice.key", "custom", KEY);
  assert.equal((await botkins(["voice", "options", "stt", "custom"])).exit, 0);
  assert.ok(sent.length >= 1 && sent.every((request) => request.url.startsWith("https://speech.example.test/v1/")), JSON.stringify(sent));
  assert.ok(sent.every((request) => request.auth === "Bearer " + KEY));
  // The call cannot move it, and the options call takes no address.
  await assert.rejects(client.call("voice.set", { providers: { custom: { baseUrl: "https://evil.example" } } }), (error) => error.message === ADDRESS_NEEDS_A_YES);
  sent.length = 0;
  await client.call("voice.options", "stt", "custom", "https://evil.example");
  assert.ok(sent.every((request) => request.url.startsWith("https://speech.example.test/v1/")), JSON.stringify(sent));
  assert.equal(JSON.stringify(await client.call("voice.get")).includes(KEY), false);
  // Asking for a list is not a change: no line in the log, and the key is in none.
  assert.ok((await changes()).every((line) => !line.includes(KEY) && /^voice\.key /.test(line)));
});

test("voice set: an address shows that its key goes, asks, and then takes the key for the new address", { skip }, async (t) => {
  const { botkins, client, changes, everything } = await service(t);
  const ADDRESS = "https://speech.example.test/v1/MADE-UP-TOKEN-4711";
  const NEW_KEY = "sk-NEW-key-for-the-new-address";
  await client.call("voice.key", "custom", SECRET);
  const hasKey = async () => (await client.call("voice.get")).providers.custom.hasKey;
  // With no terminal and no --yes: it is shown, the question needs --yes, and nothing changes.
  const asked = await botkins(["voice", "set", "custom", "--address", ADDRESS]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /The key that is saved for Custom server is removed\. A key is for the address that it was given for\. The command asks for the key for the new address next\./);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal(await hasKey(), true);
  // Not with the other options, and not for a provider that has no address.
  assert.equal((await botkins(["voice", "set", "custom", "--address", ADDRESS, "--tts", "openai", "--yes"])).exit, 2);
  assert.equal((await botkins(["voice", "set", "gemini", "--address", ADDRESS, "--yes"])).exit, 2);
  // With --yes and the key on standard input: the old key is gone, the new one is saved, and no line has the address or a key.
  const done = await botkins(["voice", "set", "custom", "--address", ADDRESS, "--yes", "--json"], { input: NEW_KEY + "\n" });
  assert.equal(done.exit, 0, done.err);
  assert.match(done.err, /The key that is saved for Custom server is removed\./, "shown with --yes and --json too");
  assert.deepEqual(done.json(), { provider: "custom", addressChanged: true, hasKey: true });
  assert.equal(await hasKey(), true);
  assert.equal((await client.call("voice.get")).providers.custom.baseUrl, ADDRESS);
  // With no key on standard input: the address is set, the provider has no key, and the answer says how to give one.
  const bare = await botkins(["voice", "set", "custom", "--address", ADDRESS + "/b", "--yes"]);
  assert.equal(bare.exit, 0, bare.err);
  assert.match(bare.out, /Custom server has no key now\. Give one with `botkins voice key custom`\./);
  assert.equal(await hasKey(), false);
  // The socket's call takes the address only with the mark.
  await assert.rejects(client.call("voice.set", { providers: { custom: { baseUrl: ADDRESS } } }), (error) => error.code === "NEEDS_YES");
  await assert.rejects(client.call("voice.set", { providers: { azure: { region: "x" } } }, { agreed: true }), /address is set as/);
  // The log names the provider and that its address changed. It never has an address or a key.
  const log = await changes();
  assert.ok(log.some((line) => line === "voice.set custom address"), log.join("\n"));
  assert.ok(log.every((line) => !line.includes("speech.example") && !line.includes("MADE-UP-TOKEN") && !line.includes(NEW_KEY) && !line.includes(SECRET)), log.join("\n"));
  assert.equal(everything().includes(NEW_KEY) || everything().includes(SECRET), false);
});

test("the commands are in `botkins help --json`, and the lists of the command line are the service's", { skip }, async (t) => {
  const { botkins } = await service(t);
  const help = (await botkins(["help", "--json"])).json();
  const area = help.areas.find((entry) => entry.name === "voice");
  assert.deepEqual(area.commands.map((command) => command.path[1]), ["show", "options", "set", "key"]);
  for (const command of area.commands) assert.match(command.usage, /^botkins /);
  // The key's own command takes no key as an option, and asks (a replacement or a removal) with --yes.
  const key = area.commands.find((command) => command.path[1] === "key");
  assert.deepEqual(key.options.map((option) => option.name), ["--remove", "--yes"]);
  assert.equal(key.asks, "--yes");
  assert.deepEqual(area.commands.filter((command) => command.asks).map((command) => command.path[1]), ["set", "key"], "only the address and the key ask");
  assert.ok(area.commands.every((command) => command.options.every((option) => !/key|secret|token/i.test(option.name) || option.name === "--remove")));
  // `voice set` has one option that names an address, `--address`, and it asks with --yes (the address takes the key away).
  const set = area.commands.find((command) => command.path[1] === "set");
  assert.deepEqual(set.options.filter((option) => /url|address|endpoint|host|region|server/i.test(option.name)).map((option) => option.name), ["--address"]);
  // The voice lists are the service's.
  assert.deepEqual(VOICE_KINDS, VOICE_PROVIDERS);
  assert.deepEqual(Object.keys(voiceCommands), ["voice"]);
});
