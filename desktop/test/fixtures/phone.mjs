#!/usr/bin/env node
// A stand-in for a phone: the link client the desktop app itself uses to reach another computer
// (desktop/remote/link-client.mjs, built from the phone app's own client), driven from a command
// line. It pairs with a host from a pairing link, on the local network or through the relay, and
// then does what a phone does: lists the bots, opens a chat, sends a message and watches the
// reply come in. The terminal host's tests and its end-to-end check use it.
//
//   phone.mjs --link 'botkins://pair?…' [--via lan|relay] [--save pairing.json]
//             [--bot <name>] [--message <text>] [--name <device name>]
//   phone.mjs --pairing pairing.json [--via lan|relay] --bot <name> --message <text>
//   phone.mjs --pairing pairing.json --space <name>
//
// It prints one JSON document: { device, route, bots, chat: { id, pieces, reply, status } }.
// `pieces` is how many times the reply grew while it was being written: more than one means the
// phone saw it stream. A pairing file holds this device's key: it is the test's own to keep safe.
// With --space it also makes a space of that name, renames it, reads it and deletes it, and
// prints `spaces`: what the host said of itself and of the space at each step.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { LinkClient, pair, parsePairingUrl, relayFetch } from "../../desktop/remote/link-client.mjs";

const { values } = parseArgs({
  options: { link: { type: "string" }, pairing: { type: "string" }, via: { type: "string" }, save: { type: "string" }, bot: { type: "string" }, message: { type: "string" }, name: { type: "string" }, timeout: { type: "string" }, space: { type: "string" } },
});
const fail = (message) => {
  process.stderr.write("phone: " + message + "\n");
  process.exit(1);
};
const limit = Number(values.timeout ?? 60) * 1000;
const transport = globalThis.WebSocket && relayFetch ? relayFetch(fetch, { WebSocket: globalThis.WebSocket }) : fetch;
/** The ways in a test asked for: only this network's addresses, or only the relay's. */
const chosen = (hosts) => {
  const picked = hosts.filter((host) => (values.via === "relay" ? host.startsWith("relay!") : values.via === "lan" ? !host.startsWith("relay!") : true));
  if (!picked.length) fail("The host offers no " + (values.via ?? "") + " address: " + hosts.join(", "));
  return picked;
};

let pairing;
if (values.pairing) pairing = JSON.parse(readFileSync(values.pairing, "utf8"));
else {
  const target = parsePairingUrl(values.link ?? "");
  if (!target) fail("Give a pairing link with --link, or a saved pairing with --pairing.");
  pairing = await pair(transport, { ...target, hosts: chosen(target.hosts) }, { name: values.name ?? "Fixture phone", platform: "ios" });
  if (values.save) writeFileSync(values.save, JSON.stringify(pairing), { mode: 0o600 });
}
const hosts = chosen(pairing.hosts ?? []);
const parts = {};
let route = null;
let state = "";
const waiting = new Set();
const client = new LinkClient({ ...pairing, hosts }, {
  fetch: transport,
  onParts(changed) {
    for (const [name, value] of Object.entries(changed)) value === null || value === undefined ? delete parts[name] : (parts[name] = value);
    for (const wake of [...waiting]) wake();
  },
  onState(next) {
    state = next;
    for (const wake of [...waiting]) wake();
  },
  onRoute(next) {
    route = next;
  },
  // A test that asked for one way in keeps to it, whatever else the host says it has.
  onHosts() {},
});
/** Waits until `check()` is true, looking again whenever the host says something changed. */
const until = (check, what) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(look);
      reject(new Error("Timed out waiting for " + what + " (state: " + state + ")."));
    }, limit);
    const look = () => {
      let value;
      try {
        value = check();
      } catch (error) {
        clearTimeout(timer);
        waiting.delete(look);
        return reject(error);
      }
      if (!value) return;
      clearTimeout(timer);
      waiting.delete(look);
      resolve(value);
    };
    waiting.add(look);
    look();
  });

const result = { device: { id: pairing.deviceId, server: pairing.serverId }, via: values.via ?? "any" };
try {
  client.start();
  await until(() => Array.isArray(parts.bots), "the host's bots");
  result.route = route;
  result.bots = parts.bots.map((bot) => bot.name);
  result.host = (await client.call("appInfo")).host ?? "desktop";
  if (values.message) {
    const bot = parts.bots.find((entry) => entry.name === (values.bot ?? entry.name));
    if (!bot) throw new Error("The host has no bot called " + values.bot + ".");
    const chatId = await client.call("createChat", bot.id);
    client.watch([chatId]);
    await client.call("send", chatId, values.message, {});
    // The reply as the phone sees it grow: every new length of the live text is one piece.
    const seen = new Set();
    const done = await until(() => {
      const live = parts.live?.streams?.[chatId];
      if (typeof live === "string" && live.length) seen.add(live.length);
      const chat = parts["chat:" + chatId];
      const reply = chat?.messages?.findLast((message) => message.role === "assistant" && !message.interim && message.text);
      const working = Object.hasOwn(parts.live?.streams ?? {}, chatId);
      const run = (chat?.runs ?? []).at(-1) ?? parts["run:" + chatId];
      if (!working && run && run.status && run.status !== "Working" && !reply) throw new Error("The turn ended without a reply: " + run.status + (run.detail ? " (" + run.detail + ")" : ""));
      return reply && !working ? { reply: reply.text, status: run?.status ?? "Completed" } : null;
    }, "the bot's reply");
    result.chat = { id: chatId, pieces: seen.size, ...done };
  }
  if (values.space) {
    const listed = () => (Array.isArray(parts.spaces) ? parts.spaces : []);
    const named = (name) => listed().find((space) => space.name === name);
    // The person's own built-in spaces are there before anything is made.
    await until(() => listed().some((space) => space.builtin === "today"), "the person's spaces");
    const spaces = { capability: (parts.meta?.capabilities ?? []).includes("spaces-v1"), builtin: listed().filter((space) => space.builtin).map((space) => space.name) };
    const id = await client.call("spaces.create", { name: values.space });
    const made = await until(() => named(values.space), "the new space in the list");
    spaces.made = { sameId: made.id === id, can: made.can, access: made.access, pinned: made.pinned };
    await client.call("spaces.rename", id, values.space + " 2");
    await until(() => named(values.space + " 2"), "the new name in the list");
    const read = await client.call("spaces.read", id);
    spaces.read = { sameId: read.id === id, panels: read.panels.length, cards: read.cards.length, seenAt: typeof read.seenAt };
    spaces.refused = await client.call("spaces.rename", listed().find((space) => space.builtin === "today").id, "Tomorrow").then(() => null, (error) => error.message);
    await client.call("spaces.remove", id);
    await until(() => !listed().some((space) => space.id === id), "the space gone from the list");
    spaces.left = listed().filter((space) => !space.builtin).length;
    result.spaces = spaces;
  }
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  fail(error.message);
} finally {
  client.stop();
}
process.exit(0);
