// When a space stops looking changed (desktop/link/SPACES.md, "seen"): opening the whole space,
// opening one panel of it, and a person's own answers on a card. A space must never stay marked
// changed because of something the person did or already opened.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { Board } from "../desktop/board.mjs";
import { Spaces } from "../desktop/link/spaces.mjs";
import { seenItemsOf, spacesViewOf, spaceView } from "../desktop/link/team.mjs";
import { changedPanels, panelChanged } from "../src/spaces.ts";

const T0 = 1_000_000;

/** The link's Spaces over one owner's space with three panels that changed at T0 + 10. */
function host() {
  let team = { views: { owner: { spaces: { seen: { s_1: T0 } } } } };
  const records = [{ id: "s_1", name: "Launch", rev: 3, items: ["p_a", "p_b", "p_c"].map((id) => ({ id, botId: "pip", updatedAt: T0 + 10 })) }];
  const spaces = new Spaces({ records: () => records, team: () => team, setTeam: (next) => (team = next), names: () => new Map(), relay: () => ({}), changed: () => {}, app: {} });
  const changed = () => spaceView(team, records, "owner")[0].changed;
  return { spaces, changed, view: () => spacesViewOf(team, "owner") };
}

test("opening one panel takes only that panel out of the space's changed count", () => {
  const { spaces, changed, view } = host();
  assert.equal(changed(), 3);
  spaces.seen("owner", "s_1", "p_a");
  assert.equal(changed(), 2);
  spaces.seen("owner", "s_1", "p_b");
  spaces.seen("owner", "s_1", "p_c");
  assert.equal(changed(), 0, "every changed panel opened: the space no longer looks changed");
  // An id that is not in the space is not kept.
  spaces.seen("owner", "s_1", "p_elsewhere");
  assert.equal(view().seenItems.p_elsewhere, undefined);
});

test("opening the whole space covers its panels' own marks, and the read says which were opened", () => {
  const { spaces, changed, view } = host();
  spaces.seen("owner", "s_1", "p_a");
  const answer = { id: "s_1", panels: [{ id: "p_a" }, { id: "p_b" }], cards: [] };
  assert.deepEqual(Object.keys(seenItemsOf(view(), answer)), ["p_a"]);
  spaces.seen("owner", "s_1");
  assert.equal(changed(), 0);
  assert.deepEqual(view().seenItems, {}, "the space's own mark covers them");
  assert.deepEqual(seenItemsOf(view(), answer), {});
});

test("a card marked read is no change, and a person's own answer is not news to them", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-seen-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(dir, async () => ({}), () => {});
  const board = new Board(ws);
  const card = board.post(ws.state.bots[0].id, { kind: "feed", title: "News" });
  const posted = card.updatedAt;
  const item = () => ws.spaces.part().find((space) => space.id === card.spaceId).items.find((one) => one.id === card.id);
  board.act(card.id, "read", undefined, "owner");
  assert.equal(card.read, true);
  assert.equal(card.updatedAt, posted, "reading it does not make it look new to anyone");
  assert.equal(item().by, undefined);
  board.act(card.id, "up", undefined, "m_avery");
  assert.equal(item().by, "m_avery", "Avery's rating is not news to Avery");
  board.update(card.botId, card.id, { title: "News, updated" });
  assert.equal(item().by, undefined, "the bot's change is news to everyone");
});

test("the window's dots: a panel opened on its own has no dot until it changes again", () => {
  const panels = [{ id: "p_a", updatedAt: T0 + 10 }, { id: "p_b", updatedAt: T0 + 10 }];
  assert.equal(changedPanels(panels, T0), 2);
  const opened = { p_a: T0 + 10 };
  assert.equal(panelChanged(panels[0], T0, undefined, opened), false);
  assert.equal(changedPanels(panels, T0, undefined, opened), 1);
  assert.equal(panelChanged({ id: "p_a", updatedAt: T0 + 20 }, T0, undefined, opened), true, "a newer change brings it back");
});
