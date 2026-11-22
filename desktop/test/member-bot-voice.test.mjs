// A team member who may manage bots sets the voice of a bot they control ("bot-voice-v1"), and
// nothing more: not the shared Settings › Voice, not a provider's key or address, not another bot.
import test from "node:test";
import assert from "node:assert/strict";
import { authorize, filterParts } from "../desktop/link/index.mjs";
import { remoteArgs } from "../desktop/link/methods.mjs";

const role = (id, agents, bots) => ({ id, name: id, perms: { agents, today: [], skills: [], mcp: [], plugins: [], settings: [] }, bots });
const team = {
  roles: [role("r_maker", ["view", "chat", "manage"], ["pip"]), role("r_guest", ["view", "chat"], ["pip"])],
  groups: [{ id: "g_makers", name: "Makers", roleId: "r_maker" }, { id: "g_guests", name: "Guests", roleId: "r_guest" }],
  members: [{ id: "m_maker", name: "Max", groupId: "g_makers" }, { id: "m_guest", name: "Gia", groupId: "g_guests" }],
};
const maker = { kind: "member", memberId: "m_maker", groupId: "g_makers" };
const guest = { kind: "member", memberId: "m_guest", groupId: "g_guests" };
const lookups = { bot: (id) => [{ id: "pip" }, { id: "scout" }].find((bot) => bot.id === id) };
const voice = { tts: { provider: "openai", voice: "nova", speed: 1.1, auto: true }, live: { provider: "gemini" }, stt: { provider: "device", language: "en-US" } };

test("a member who manages a bot sets its voice, and is refused for a bot their role can't see", () => {
  assert.equal(authorize(maker, team, "updateBot", ["pip", { voice: { tts: { provider: "openai", speed: 1.25 } } }], lookups), "");
  assert.equal(authorize(maker, team, "updateBot", ["pip", { voice: null }], lookups), "");
  assert.equal(authorize(maker, team, "updateBot", ["scout", { voice: { tts: { speed: 1.25 } } }], lookups), "That bot isn't available to your team role.");
  assert.equal(authorize(guest, team, "updateBot", ["pip", { voice: { tts: { speed: 1.25 } } }], lookups), "Your team role can't do that.");
});

test("every field of a bot's voice, reading and live, is the member's to set on a bot they manage, and only in its own shape", () => {
  const live = { live: { provider: "gemini", model: "m-1", voice: "puck" } };
  const reading = { tts: { provider: "openai", model: "tts-1", voice: "nova", speed: 1.25 } };
  for (const voice of [reading, live, { ...reading, ...live }, null]) {
    assert.equal(authorize(maker, team, "updateBot", ["pip", { voice }], lookups), "", JSON.stringify(voice));
    assert.equal(authorize(maker, team, "updateBot", ["scout", { voice }], lookups), "That bot isn't available to your team role.", JSON.stringify(voice));
    assert.deepEqual(remoteArgs("updateBot", ["pip", { voice }])[1].voice, voice);
  }
  // A provider the computer doesn't have is refused, and a key put beside the choices is not kept.
  assert.throws(() => remoteArgs("updateBot", ["pip", { voice: { live: { provider: "nowhere" } } }]), /isn't supported|can't be saved/);
  assert.throws(() => remoteArgs("updateBot", ["pip", { voice: { live: { provider: "openai", apiKey: "sk-member-key" } } }]), /can't be saved|isn't supported/);
});

test("a member who manages bots may list a provider's voices, but never set the shared voice or a key", () => {
  assert.equal(authorize(maker, team, "link.voice.options", ["tts", "openai"], lookups), "");
  assert.equal(authorize(guest, team, "link.voice.options", ["tts", "openai"], lookups), "Your team role can't do that.");
  for (const method of ["link.voice.set", "link.voice.key"]) assert.equal(authorize(maker, team, method, [{}], lookups), "Only the owner can do that.", method);
});

test("a member who manages bots is sent the shared choices and what is ready, never a key or an address", () => {
  const providers = {
    openai: { baseUrl: "https://internal.example/v1", hasKey: true },
    azure: { kind: "openai", endpoint: "https://secret.openai.azure.com", region: "westus", ttsDeployment: "tts-private", sttDeployment: "stt-private", apiVersion: "2025-01-01", hasKey: true },
    elevenlabs: { agentId: "agent_private", hasKey: false },
    gemini: { hasKey: true },
    custom: { baseUrl: "http://10.0.0.5:8000", hasKey: false },
    local: { available: true, models: [{ id: "kokoro", name: "Kokoro", kind: "tts", installed: true, sizeMB: 80 }] },
    codex: { available: true, signedIn: false },
  };
  const parts = { bots: [{ id: "pip", name: "Pip" }], chats: [], voice: { ...voice, providers } };
  const cut = filterParts(parts, maker, team).voice;
  assert.deepEqual([cut.tts, cut.live, cut.stt], [voice.tts, voice.live, voice.stt]);
  assert.deepEqual([cut.providers.openai.hasKey, cut.providers.gemini.hasKey, cut.providers.elevenlabs.hasKey, cut.providers.codex, cut.providers.local.models.length], [true, true, false, { available: true, signedIn: false }, 1]);
  // What a phone checks is that an address or deployment is set, so those stay as a mark that it is.
  assert.ok(cut.providers.azure.endpoint && cut.providers.azure.ttsDeployment && cut.providers.custom.baseUrl);
  const sent = JSON.stringify(cut);
  for (const private_ of ["internal.example", "secret.openai.azure.com", "westus", "tts-private", "stt-private", "agent_private", "10.0.0.5"]) assert.equal(sent.includes(private_), false, private_);
  // A role that doesn't manage bots has no use for it, and the owner's cut is whole.
  assert.equal("voice" in filterParts(parts, guest, team), false);
  assert.equal(filterParts(parts, { kind: "owner" }, team), parts);
});
