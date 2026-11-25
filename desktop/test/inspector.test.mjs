// The side pane's Activity and Crew tabs: their plain rules (src/inspector.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { clock, filterChips, filterOf, initial, laneTicks, linkWords, outputLinks, pickSelection, thoughtBefore, took } from "../src/inspector.ts";

const step = (id, status = "Done") => ({ id, name: "bash", label: "bash", status, started: 0 });
const chapter = (key, ids, { thought = true, failed = 0, counts = [] } = {}) => ({
  key,
  at: 0,
  heading: key,
  ...(thought && { thought: { ids: ["t-" + key], text: "", snippet: "" } }),
  items: ids.map((id) => ({ kind: "step", key: "step-" + id.replace("!", ""), at: 0, step: step(id.replace("!", ""), id.endsWith("!") ? "Failed" : "Done") })),
  steps: [],
  counts,
  failed,
  running: false,
});

test("times read as a clock from the turn's start, and steps as seconds", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(41_900), "0:41");
  assert.equal(clock(12 * 60_000 + 5000), "12:05");
  assert.equal(clock(3_725_000), "1:02:05");
  assert.equal(took(6200), "6.2s");
  assert.equal(took(10), "0.1s");
  assert.equal(took(64_000), "1m 4s");
});

test("kinds of steps fall under the chips people filter by", () => {
  assert.equal(filterOf("command"), "commands");
  assert.equal(filterOf("edit"), "edits");
  assert.equal(filterOf("write"), "edits");
  assert.equal(filterOf("read"), "reads");
  assert.equal(filterOf("search-files"), "reads");
  assert.equal(filterOf("web-page"), "web");
  assert.equal(filterOf("helper"), null);
  assert.equal(filterOf(null), null);
});

test("the chips are All, then only the kinds present, in a fixed order", () => {
  const chips = filterChips([
    chapter("a", [], { counts: [{ kind: "read", count: 3 }, { kind: "search-files", count: 2 }, { kind: "web", count: 1 }] }),
    chapter("b", [], { failed: 1, counts: [{ kind: "command", count: 1 }, { kind: "read", count: 1 }] }),
    chapter("c", [], { thought: false, counts: [{ kind: "edit", count: 2 }, { kind: "helper", count: 1 }] }),
  ]);
  assert.deepEqual(chips, [
    { filter: "all", count: 11 },
    { filter: "thinking", count: 2 },
    { filter: "commands", count: 1 },
    { filter: "edits", count: 2 },
    { filter: "reads", count: 6 },
    { filter: "web", count: 1 },
    { filter: "failed", count: 1 },
  ]);
  assert.deepEqual(filterChips([]), [{ filter: "all", count: 0 }]);
});

test("the first failed step is selected, else the newest, unless something was clicked", () => {
  const chapters = [chapter("chapter-1", ["a", "b!"]), chapter("chapter-2", ["c", "d!", "e"])];
  assert.equal(pickSelection(chapters), "step-b");
  assert.equal(pickSelection([chapter("x", ["a", "b"]), chapter("y", ["c"])]), "step-c");
  assert.equal(pickSelection(chapters, "step-e"), "step-e");
  assert.equal(pickSelection(chapters, "chapter-2"), "chapter-2");
  // A thought selects the chapter it opened.
  assert.equal(pickSelection(chapters, "thought-t-chapter-2"), "chapter-2");
  // Something no longer there falls back.
  assert.equal(pickSelection(chapters, "step-gone"), "step-b");
  assert.equal(pickSelection([chapter("only", [])]), "only");
  assert.equal(pickSelection([]), undefined);
});

test("why a command started: the thought that began last before it", () => {
  const reasoning = [
    { id: "1", text: "Look around", started: 10 },
    { id: "2", text: "Start the server", started: 40 },
    { id: "3", text: "  ", started: 45 },
    { id: "4", text: "Check the page", started: 90 },
  ];
  assert.equal(thoughtBefore(reasoning, 50)?.id, "2");
  assert.equal(thoughtBefore(reasoning, 40)?.id, "2");
  assert.equal(thoughtBefore(reasoning, 5), undefined);
  assert.equal(thoughtBefore(undefined, 5), undefined);
});

test("links a command printed become buttons, each once", () => {
  const out = "\x1b[32m  ➜  Local:\x1b[0m   http://localhost:3000/\n  ➜  Network: http://192.168.1.4:3000/.\nready on localhost:3000\nserver at 0.0.0.0:8080, docs https://vite.dev/guide).";
  assert.deepEqual(outputLinks(out), ["http://localhost:3000/", "http://192.168.1.4:3000/", "http://localhost:8080/", "https://vite.dev/guide"]);
  assert.deepEqual(outputLinks("no links here"), []);
  assert.deepEqual(outputLinks(undefined), []);
  assert.equal(outputLinks("http://a.dev http://b.dev http://c.dev", 2).length, 2);
  assert.equal(linkWords("http://localhost:3000/"), "localhost:3000");
  assert.equal(linkWords("https://vite.dev/guide"), "vite.dev/guide");
});

test("lane ticks span the turn and end at now while it runs", () => {
  assert.deepEqual(laneTicks(60_000, true), [
    { at: 0, label: "0:00" },
    { at: 1 / 3, label: "0:20" },
    { at: 2 / 3, label: "0:40" },
    { at: 1, label: "now" },
  ]);
  assert.equal(laneTicks(90_000, false).at(-1).label, "1:30");
});

test("a crew member's face is its first letter", () => {
  assert.equal(initial("code searcher"), "C");
  assert.equal(initial("  ✦ docs"), "D");
  assert.equal(initial("—"), "?");
});
