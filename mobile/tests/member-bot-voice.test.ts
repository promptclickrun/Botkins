// A team member whose role manages a bot sets that bot's own voice ("bot-voice-v1") through the link,
// and gets no more of Settings › Voice than what choosing needs: never a key, never another bot.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { type FetchLike, LinkClient, checkJoin, pair, startJoin } from "../src/link/client";

test("a member who manages a bot sets its voice; another bot, the shared voice and the keys stay out of reach", async () => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-member-voice-"));
  const backend = new MockBackend({ speed: 0.01 });
  const link = new LinkHost({ dir, backend, relay: false, port: 0, extraHosts: ["127.0.0.1"] });
  const clients: LinkClient[] = [];
  try {
    await link.setEnabled(true);
    const fetcher = fetch as unknown as FetchLike;
    const ownerPairing = await pair(fetcher, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Owner phone", platform: "ios" });
    const owner = new LinkClient(ownerPairing, { fetch: fetcher, onParts() {}, onState() {} });
    clients.push(owner);
    // The owner has a key saved, which no member is ever sent.
    await owner.call("link.voice.key", "openai", "sk-owner-private-key");
    // Everyone joins as a guest who manages one bot: Mira.
    const guest = structuredClone(link.store.data.team.roles.find((role: any) => role.id === "r_guest"));
    guest.perms.agents = ["view", "chat", "manage"];
    guest.bots = ["bot-mira"];
    await owner.call("link.team.saveRole", guest);
    const invite = await owner.call<any>("link.team.createInvite", { groupId: "g_everyone", days: 7, maxUses: 1 });
    const target = { hosts: ["127.0.0.1:" + link.port], code: invite.code, serverId: link.status().serverId, serverKey: Buffer.from(link.store.data.keys.publicKey).toString("base64url"), name: link.status().name };
    const started = await startJoin(fetcher, target, { name: "Sam's phone", platform: "ios", kind: "phone" });
    if (started.result.status !== "pending") throw new Error("not pending");
    await owner.call("link.team.approve", started.result.requestId);
    const checked = await checkJoin(fetcher, started.attempt);
    if (checked.status !== "approved") throw new Error("not approved");

    const parts: Record<string, any> = {};
    const client = new LinkClient(checked.pairing, { fetch: fetcher, onParts: (next) => Object.assign(parts, next), onState() {} });
    clients.push(client);
    client.start();
    const until = async (test: () => boolean, label: string) => {
      const end = Date.now() + 6000;
      while (!test()) {
        if (Date.now() > end) throw new Error("Timed out waiting for " + label);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await until(() => Array.isArray(parts.bots) && !!parts.voice, "member parts with the voice choices");
    assert.deepEqual(parts.bots.map((bot: any) => bot.id), ["bot-mira"]);
    assert.equal(parts.voice.providers.openai.hasKey, true, "what is ready is sent");
    assert.equal(JSON.stringify(parts).includes("sk-owner-private-key"), false, "a key is never sent");

    // The member's own bot takes a voice, and it is kept with the bot.
    await client.call("updateBot", "bot-mira", { voice: { tts: { provider: "openai", voice: "nova", speed: 1.25 }, live: { provider: "gemini", model: "m-1", voice: "puck" } } });
    assert.deepEqual(backend.state.bots.find((bot: any) => bot.id === "bot-mira").voice, { tts: { provider: "openai", voice: "nova", speed: 1.25 }, live: { provider: "gemini", model: "m-1", voice: "puck" } });
    await until(() => parts.bots[0].voice?.tts?.voice === "nova", "the saved voice in the member's parts");
    // Its voices can be listed to choose from, and "Same as Settings" (null) clears the choice.
    assert.deepEqual(await client.call("link.voice.options", "tts", "device"), { models: [], voices: [] });
    await client.call("updateBot", "bot-mira", { voice: null });
    assert.equal("voice" in backend.state.bots.find((bot: any) => bot.id === "bot-mira"), false);

    // Another bot, the shared voice and the keys are not the member's.
    await assert.rejects(client.call("updateBot", "bot-patch", { voice: { tts: { speed: 1.5 } } }), /isn't available to your team role/);
    assert.equal(backend.state.bots.find((bot: any) => bot.id === "bot-patch").voice, undefined);
    await assert.rejects(client.call("link.voice.set", { tts: { provider: "device" } }), /Only the owner/);
    await assert.rejects(client.call("link.voice.key", "openai", "sk-member-key"), /Only the owner/);
  } finally {
    for (const client of clients) client.stop();
    await link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
