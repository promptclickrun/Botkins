// When the phone opens or closes the side pane a bot asked for (src/features/pane/pane.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { paneFront, paneMove, paneUrl } from "../src/features/pane/pane";
import type { ChatPane, PanePanel } from "../src/link/types";

const panel = (id: string, more: Partial<PanePanel> = {}): PanePanel => ({ id, kind: "table", title: id, botId: "bot", createdAt: 1, updatedAt: 1, ...more });
const pane = (seq: number | null, more: Partial<NonNullable<ChatPane["ask"]>> = {}, panels = [panel("p1"), panel("p2")]): ChatPane => ({
  panels,
  active: "p1",
  ...(seq !== null && { ask: { seq, panelId: "p2", runId: "r1", botId: "bot", at: 5, ...more } }),
});
const never = () => false;
const always = () => true;

test("the sheet opens only when a bot's ask rises", () => {
  assert.deepEqual(paneMove(pane(3), 2, never), { handled: 3, move: { open: "p2" } });
  // The same ask again, or an older one: nothing, so it can't reopen in a loop.
  assert.deepEqual(paneMove(pane(3), 3, always), { handled: 3, move: null });
  assert.deepEqual(paneMove(pane(2), 3, always), { handled: 3, move: null });
  // Tabs without an ask (the person opened it elsewhere): nothing.
  assert.deepEqual(paneMove(pane(null), 3, always), { handled: 3, move: null });
  assert.deepEqual(paneMove(undefined, undefined, always), { handled: 0, move: null });
});

test("a chat seen for the first time doesn't open an old ask, unless its turn is still running", () => {
  assert.deepEqual(paneMove(pane(7), undefined, never), { handled: 7, move: null });
  assert.deepEqual(paneMove(pane(7), undefined, (runId) => runId === "r1"), { handled: 7, move: { open: "p2" } });
  // After that first look, the next rise opens as usual.
  assert.deepEqual(paneMove(pane(8), 7, never), { handled: 8, move: { open: "p2" } });
});

test("an ask to close closes, and an ask for a panel that is gone or for the chat's details opens nothing", () => {
  assert.deepEqual(paneMove(pane(4, { close: true }), 3, always), { handled: 4, move: { close: true } });
  assert.deepEqual(paneMove(pane(4, { close: true }), undefined, always), { handled: 4, move: null });
  assert.deepEqual(paneMove(pane(4, { panelId: "gone" }), 3, always), { handled: 4, move: null });
  assert.deepEqual(paneMove(pane(4, { panelId: null }), 3, always), { handled: 4, move: null });
});

test("the tab in front, and which addresses a web panel may open", () => {
  assert.equal(paneFront(pane(1))?.id, "p1");
  assert.equal(paneFront({ panels: [panel("a"), panel("b")], active: null })?.id, "b");
  assert.equal(paneFront({ panels: [], active: null }), undefined);
  assert.equal(paneUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(paneUrl("http://localhost:3000/"), "http://localhost:3000/");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "botkins://pair", "https://user:pw@example.com/", "not a url", "", undefined]) assert.equal(paneUrl(bad), null, String(bad));
});
