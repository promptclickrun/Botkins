// The link keeps the JSON of the steps and messages of a chat that did not change (desktop/link/json-cache.mjs),
// because this app changes its runs in place. A page written through that cache must be the bytes of a fresh
// write after any such change. The phone repo's tests/json-cache.test.ts runs the same checks on its copy of the link.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { jsonOf } from "../desktop/link/json-cache.mjs";
import { chatPart, runPart } from "../desktop/link/parts.mjs";

function random(seed) {
  let n = seed;
  return () => (n = (n * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

test("a page and a run written through the cache are what a fresh write is, after changes in place", () => {
  const next = random(11);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const text = () => Array.from({ length: Math.floor(next() * 10) }, () => pick(["alpha", "é", "😀", '"q"', "line\n", "x".repeat(400)])).join(" ");
  const state = { chats: [{ id: "c", botId: "b", title: "t", time: 1, messages: [] }], runs: [] };
  const chat = state.chats[0];
  let n = 0;
  for (let round = 0; round < 200; round++) {
    const op = Math.floor(next() * 7);
    if (op === 0 || chat.messages.length < 3) chat.messages.push({ role: pick(["user", "assistant"]), text: text(), time: ++n, ...(next() < 0.3 && { runId: "r1" }), ...(next() < 0.2 && { attachments: [{ name: text(), path: "/x" }] }) });
    else if (op === 1) pick(chat.messages).text = text();
    else if (op === 2 && state.runs.length < 2) state.runs.unshift({ id: "r" + (state.runs.length + 1), chatId: "c", status: pick(["Working", "Done"]), steps: [] });
    else if (op === 3 && state.runs.length) pick(state.runs).steps.push({ id: "s" + ++n, name: "bash", label: text(), status: "Running", input: text(), output: text() + "o".repeat(next() < 0.3 ? 5000 : 0), started: n });
    else if (op === 4 && state.runs.some((r) => r.steps.length)) {
      const step = pick(pick(state.runs.filter((r) => r.steps.length)).steps);
      step.status = pick(["Running", "Done", "Failed"]);
      step.output = (step.output ?? "") + text();
      if (next() < 0.3) step.finished = n;
    } else if (op === 5 && state.runs.length) pick(state.runs).status = pick(["Working", "Done"]);
    else if (op === 6 && chat.messages.length) chat.messages.splice(Math.floor(next() * chat.messages.length), 1);
    const fresh = structuredClone(state);
    assert.equal(jsonOf(chatPart(state, "c")), JSON.stringify(chatPart(fresh, "c")), "page, round " + round);
    assert.equal(jsonOf(runPart(state, "c")), JSON.stringify(runPart(fresh, "c")), "run, round " + round);
  }
});

test("the link's files here are the phone repo's, where that repo is next to this one", () => {
  const phone = new URL("../../mobile/link-host/", import.meta.url);
  if (!existsSync(new URL("parts.mjs", phone))) return;
  for (const file of ["parts.mjs", "json-cache.mjs"]) {
    assert.equal(readFileSync(new URL("../desktop/link/" + file, import.meta.url), "utf8"), readFileSync(new URL(file, phone), "utf8"), file + " differs from mobile/link-host");
  }
});
