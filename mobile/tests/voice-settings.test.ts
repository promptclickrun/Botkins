// Settings › Voice: the overview's one-line summaries, the live input choice and where a provider is set up.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VoiceSettings } from "../src/link/types";
import { effectiveLive, effectiveTts, tidyVoice, withProvider } from "../src/features/voice/botVoice";
import { effectiveLive as computersLive, effectiveTts as computersTts } from "../link-host/voice.mjs";
import { botVoiceSummary, dictationSummary, keysSummary, LIVE_INPUTS, liveInputLine, liveSummary, readingSummary, setupFor, UNBUILT } from "../src/features/voice/settings/summary";

const settings = (patch: Partial<VoiceSettings> = {}, providers: Partial<VoiceSettings["providers"]> = {}): VoiceSettings => ({
  stt: { provider: "device" },
  tts: { provider: "device" },
  live: { provider: null },
  ...patch,
  providers: {
    openai: { baseUrl: "https://api.openai.com/v1", hasKey: false },
    azure: { kind: "openai", hasKey: false },
    elevenlabs: { hasKey: false },
    gemini: { hasKey: false },
    custom: { hasKey: false },
    local: { available: false, models: [] },
    codex: { available: true, signedIn: false },
    ...providers,
  },
});

const built = () => true;

test("dictation says who takes it and in which language, or what it still needs", () => {
  assert.deepEqual(dictationSummary(undefined), { value: "This phone", subtitle: "Automatic", needs: false });
  assert.deepEqual(dictationSummary(settings({ stt: { provider: "device", language: "fr-FR" } })), { value: "This phone", subtitle: "French", needs: false });
  assert.deepEqual(dictationSummary(settings({ stt: { provider: "device", language: "xx-YY" } })), { value: "This phone", subtitle: "xx-YY", needs: false });
  assert.deepEqual(dictationSummary(settings({ stt: { provider: "openai" } })), { value: "OpenAI", subtitle: "Needs an OpenAI key", needs: true });
  assert.deepEqual(dictationSummary(settings({ stt: { provider: "openai" } }, { openai: { baseUrl: "x", hasKey: true } })), { value: "OpenAI", subtitle: "Automatic", needs: false });
});

test("reading aloud says who reads and whether replies are read by themselves", () => {
  assert.deepEqual(readingSummary(undefined, false), { value: "This phone", subtitle: undefined, needs: false });
  assert.deepEqual(readingSummary(settings(), true), { value: "This phone", subtitle: "Reads replies aloud", needs: false });
  assert.deepEqual(readingSummary(settings({ tts: { provider: "gemini" } }), true), { value: "Gemini", subtitle: "Needs a Gemini key", needs: true });
});

test("live voice says Off, what it needs, that this build can't, or how it listens", () => {
  assert.deepEqual(liveSummary(settings(), "conversation", built), { value: "Off", subtitle: undefined, needs: false });
  assert.deepEqual(liveSummary(settings({ live: { provider: "gemini" } }), "push", built), { value: "Gemini", subtitle: "Needs a Gemini key", needs: true });
  const keyed = settings({ live: { provider: "gemini" } }, { gemini: { hasKey: true } });
  assert.deepEqual(liveSummary(keyed, "push", built), { value: "Gemini", subtitle: "Push to talk", needs: false });
  assert.deepEqual(liveSummary(keyed, "conversation", built), { value: "Gemini", subtitle: "Live conversation", needs: false });
  assert.deepEqual(liveSummary(keyed, "conversation", () => false), { value: "Gemini", subtitle: UNBUILT, needs: true });
});

test("the two ways to talk, each with one line", () => {
  assert.deepEqual(
    LIVE_INPUTS.map((input) => input.value),
    ["conversation", "push"],
  );
  assert.deepEqual(
    LIVE_INPUTS.map((input) => input.label),
    ["Live conversation", "Push to talk"],
  );
  assert.match(liveInputLine("push"), /^Hold/);
  assert.notEqual(liveInputLine("conversation"), liveInputLine("push"));
});

test("keys are counted, never shown", () => {
  assert.equal(keysSummary(settings()), "No keys saved");
  assert.equal(keysSummary(settings({}, { gemini: { hasKey: true } })), "1 key saved");
  assert.equal(keysSummary(settings({}, { gemini: { hasKey: true }, custom: { hasKey: true, baseUrl: "http://x" } })), "2 keys saved");
});

test("a provider that needs something opens its own sheet; the phone and ChatGPT sign-in have none", () => {
  assert.equal(setupFor("openai"), "openai");
  assert.equal(setupFor("custom"), "custom");
  assert.equal(setupFor("local"), "local");
  assert.equal(setupFor("device"), null);
  assert.equal(setupFor("codex"), null);
  assert.equal(setupFor(null), null);
});

test("a bot's voice on its page: Same as Settings, or only what the bot changes", () => {
  const shared = settings({ tts: { provider: "openai", voice: "cedar", speed: 1.5 }, live: { provider: "openai" } });
  assert.equal(botVoiceSummary(undefined, shared), "Same as Settings");
  assert.equal(botVoiceSummary({}, shared), "Same as Settings");
  assert.equal(botVoiceSummary({ tts: { voice: "nova" } }, shared), "OpenAI \u00b7 Nova");
  assert.equal(botVoiceSummary({ tts: { provider: "openai", voice: "nova" }, live: { provider: "gemini", voice: "Puck" } }, shared), "OpenAI \u00b7 Nova \u00b7 Live: Gemini \u00b7 Puck");
  assert.equal(botVoiceSummary({ tts: { provider: "device" }, live: { model: "gpt-realtime-2" } }, shared), "This phone \u00b7 Live: OpenAI");
  // An opaque voice id (an ElevenLabs voice) is not shown as a name; Gemini has no speed.
  assert.equal(botVoiceSummary({ tts: { provider: "elevenlabs", voice: "21m00Tcm4TlvDq8ikWAM", speed: 1.25 } }, shared), "ElevenLabs \u00b7 1.25\u00d7");
  assert.equal(botVoiceSummary({ tts: { provider: "gemini", speed: 1.25 } }, shared), "Gemini");
});

test("the phone resolves a bot's voice as the computer does, and another provider drops the old model and voice", () => {
  const shared = settings({ tts: { provider: "openai", model: "tts-1-hd", voice: "cedar", speed: 1.5 }, live: { provider: "openai", voice: "marin" } });
  for (const own of [undefined, { voice: "sage" }, { provider: "openai", speed: 0.8 }, { provider: "gemini", voice: "Puck" }, { provider: "device" }] as const)
    assert.deepEqual(effectiveTts(shared.tts, own as any), computersTts(shared.tts, own), JSON.stringify(own));
  for (const own of [undefined, { voice: "Puck" }, { provider: "gemini", voice: "Puck" }, { provider: "openai", model: "gpt-realtime-2" }] as const)
    assert.deepEqual(effectiveLive(shared.live, own as any), computersLive(shared.live, own), JSON.stringify(own));
  assert.deepEqual(effectiveTts(shared.tts, { provider: "gemini" }), { provider: "gemini", model: undefined, voice: undefined, speed: 1.5 });
  // Choosing a provider keeps the speed and drops the model and voice; undoing every choice leaves no voice.
  const mine = { tts: { provider: "openai" as const, model: "tts-1", voice: "nova", speed: 1.25 }, live: { voice: "Puck" } };
  assert.deepEqual(withProvider(mine, "tts", "gemini"), { tts: { provider: "gemini", speed: 1.25 }, live: { voice: "Puck" } });
  assert.equal(tidyVoice({ tts: { provider: undefined, voice: "" } }), null);
});
