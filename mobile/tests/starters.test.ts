// The three starter bots (link-host/starters.mjs, a copy of the computer's desktop/starters.mjs; the
// desktop app's test/starters.test.mjs checks that the two files match).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { STARTERS, starterById } from "../link-host/starters.mjs";
import { headIds, originalHeadIds } from "../link-host/botkin-heads.mjs";

test("the phone offers Chief of Staff, Coding partner and Money manager, in that order", () => {
  assert.deepEqual(STARTERS.map((s) => s.name), ["Chief of Staff", "Coding partner", "Money manager"]);
  assert.deepEqual(STARTERS.map((s) => s.look.head), ["drip", "mallow", "pebble"]);
  const newer = headIds.filter((id) => !originalHeadIds.includes(id));
  for (const s of STARTERS) assert.ok(newer.includes(s.look.head), s.look.head + " is one of the ten newer characters");
  assert.deepEqual(STARTERS.filter((s) => s.suggestProactive).map((s) => s.id), ["chief-of-staff", "money-manager"]);
});

test("Home's first run and New bot's templates both list the starters", () => {
  const home = readFileSync(new URL("../src/features/home/Home.tsx", import.meta.url), "utf8");
  assert.match(home, /if \(!found\) return <Starters \/>;/);
  assert.match(home, /pathname: "\/bot\/new", params: \{ starter: starter\.id \}/);
  const newBot = readFileSync(new URL("../src/features/bots/NewBot.tsx", import.meta.url), "utf8");
  assert.match(newBot, /<Label>Starters<\/Label>/);
  assert.match(newBot, /starter: start\.starter/, "Create tells the computer which starter it came from");
});

test("the demo computer keeps the starter and its Proactive suggestion on the bot", async () => {
  const backend = new MockBackend({ speed: 0.05 });
  const chief = starterById("chief-of-staff")!;
  const id = (await backend.call("addBot", [{ name: "Ada", role: chief.role, instructions: chief.instructions, face: "idle", starter: chief.id }])) as string;
  const made = backend.state.bots.find((bot: { id: string }) => bot.id === id);
  assert.equal(made.name, "Ada");
  assert.equal(made.starter, "chief-of-staff");
  assert.equal(made.suggestProactive, true);
  const coder = (await backend.call("addBot", [{ name: "Coding partner", role: "Coding partner", instructions: "x", face: "idle", starter: "coding-partner" }])) as string;
  assert.equal(backend.state.bots.find((bot: { id: string }) => bot.id === coder).suggestProactive, undefined);
  const other = (await backend.call("addBot", [{ name: "Mine", role: "", instructions: "", face: "idle", starter: "made-up" }])) as string;
  assert.equal(backend.state.bots.find((bot: { id: string }) => bot.id === other).starter, undefined);
});
