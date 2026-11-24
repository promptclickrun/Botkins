// The rules for keeping the work moving (desktop/keep-moving.mjs): what ends a reply short of its
// next step, when a plan earns another turn, and which queued messages are read together.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CONTINUATIONS, STALL_NOTE, asksUser, mergeable, mergedPrompt, namesNextStep, nextMove, openSignature, openSteps, planNote, takeBatch,
} from "../desktop/keep-moving.mjs";

// Replies that named the next step (or asked whether to go on) and stopped.
const STALLS = [
  "Tests pass for the parser. Next I'll update the config loader.",
  "Let me now run the full test suite.",
  "Now let me check the logs:",
  "I'll run the build to confirm.",
  "Okay, I'll start with the failing test.",
  "I'm going to look at the migration next.",
  "The linter is clean, so next I'll write the docs.",
  "**Next, I'll update the changelog.**",
  "- Let me fix the import order",
  "Step one is done.\n\nLet's now verify the output.",
  "Shall I continue?",
  "Want me to proceed?",
  "Done with the first file. Should I go ahead with the next step?",
  "Do you want me to keep going?",
  "Shall I proceed with the rest of the plan?",
];
// Replies that must not be caught: goodbyes, offers, real questions, and finished work.
const NOT_STALLS = [
  "I'll be here if you need anything.",
  "Let me know if you want me to run the tests.",
  "I'll run the tests if you'd like.",
  "If you want, I'll update the config next.",
  "All done. The tests pass and the config is updated.",
  "Next I'll run the tests. Done: all 12 pass.",
  "Which one do you want, A or B?",
  "Do you want the long or the short version?",
  "Want me to proceed with deleting the production database?",
  "Should I use tabs or spaces?",
  "I'll let you know when it's finished.",
  "That's all for now; I'll check back later.",
  "Feel free to ask if anything is unclear.",
  "I'll leave it there.",
  "Thanks, happy to help with the next one whenever you are.",
  "",
];

test("a reply that names its next step, or asks whether to go on, is caught", () => {
  for (const text of STALLS) assert.equal(namesNextStep(text), true, text);
});

test("a goodbye, an offer, a real question and finished work are not caught", () => {
  for (const text of NOT_STALLS) assert.equal(namesNextStep(text), false, JSON.stringify(text));
});

test("a question to the person ends the chain, but asking whether to continue does not", () => {
  const questions = [
    "Which one do you want, A or B?",
    "I found two configs.\n\nWhich should I change?",
    "Want me to proceed with deleting the production database?",
    "Should I use tabs or spaces?",
    "Do you want the long or the short version? **Tell me.**",
  ];
  for (const text of questions) assert.equal(asksUser(text), true, text);
  const notQuestions = ["Shall I continue?", "Want me to proceed?", "Next I'll run the tests.", "All done.", "", "I ran it (twice?) and it passed."];
  for (const text of notQuestions.slice(0, 5)) assert.equal(asksUser(text), false, JSON.stringify(text));
});

// A question followed by a sign-off, and plain waiting-for-input language, are the person's turn too.
const WAITS = [
  "Which environment should I use?\n\nI will wait for your answer.",
  "Which environment should I use?\nI'll wait for your answer.",
  "Which environment should I use? I will wait for your answer.",
  "Which environment should I use?\n\n**Let me know which.**",
  "I found staging and production.\n\nWhich one is it?\n\nThanks!",
  "I'll wait for your answer.",
  "I'll hold off until you confirm.",
  "Waiting for your go-ahead on the migration.",
  "I'm waiting on your approval before I touch the database.",
  "Let me know which environment to use.",
  "Let me know what the token should be called.",
  "Once you confirm the region, I'll deploy.",
  "After you reply with the version, I'll pin it.",
  "Please confirm the target before I go on.",
  "I need your approval to continue.",
  "- Awaiting your decision.",
];
// Offers, goodbyes, a rhetorical question the reply goes on to answer, and the narrow "go on?" ask.
const NOT_WAITS = [
  "Shall I continue?",
  "Want me to proceed?",
  "Should I go ahead with the next step?\n\nShall I continue?",
  "Let me know if you need anything else.",
  "I'll be here if you need anything.",
  "Why did it fail?\n\nThe cache was stale.\n\nI cleared it and the tests pass now, and the build is green.",
  "I'll wait for the build to finish, then run the tests.",
  "Next I'll update the docs.",
];

test("a question followed by a sign-off, or waiting-for-input language, ends the chain", () => {
  for (const text of WAITS) assert.equal(asksUser(text), true, JSON.stringify(text));
  for (const text of NOT_WAITS) assert.equal(asksUser(text), false, JSON.stringify(text));
});

test("a question and a sign-off stop an open plan from continuing, and a stall from being caught", () => {
  const todos = [{ id: "a", title: "Deploy", status: "pending" }];
  const text = "Which environment should I use?\n\nI will wait for your answer.";
  const first = nextMove({ text, todos, chain: { count: 0, stalls: 0, signature: undefined } });
  assert.equal(first.move, "stop");
  assert.equal(first.stoppedOpen, true);
  assert.equal(nextMove({ text, todos: [], chain: { count: 0, stalls: 0, signature: undefined } }).move, "stop");
  // "Shall I continue?" alone is still caught as a stall.
  assert.equal(nextMove({ text: "Shall I continue?", todos: [], chain: { count: 0, stalls: 0, signature: undefined } }).reason, "next-step");
});

const step = (id, title, status = "pending") => ({ id, title, status });
const chain = (more = {}) => ({ count: 0, stalls: 0, signature: undefined, ...more });

test("open steps are the pending and in progress ones", () => {
  const todos = [step("a", "One", "done"), step("b", "Two", "in_progress"), step("c", "Three"), step("d", "Four", "blocked"), step("e", "Five", "cancelled")];
  assert.deepEqual(openSteps(todos).map((s) => s.id), ["b", "c"]);
  assert.deepEqual(openSteps(undefined), []);
});

test("the plan note says what is open, in Botkins' own words", () => {
  const note = planNote([step("b", "Write the tests", "in_progress"), step("c", "Update  the\ndocs")], 3);
  assert.equal(
    note,
    [
      "[Botkins] This is an automatic note from Botkins, not from the person. You ended your turn, but these plan steps are still open:",
      "- in progress: Write the tests",
      "- pending: Update the docs",
      "Pick up where you left off and work through them. The person can already read your previous reply, so don't restate it, and don't ask whether to keep going. This note gives no permission for anything risky. If a step needs the person's approval or input, or you're stuck, say that in one short sentence and stop.",
      "(Botkins kept going 3 of 8 times.)",
    ].join("\n"),
  );
  assert.equal(
    STALL_NOTE,
    "[Botkins] This is an automatic note from Botkins, not from the person. Your last reply said what you'd do next but stopped before doing it. Go ahead and do that step now. If it needs the person's approval or input, say so in one short sentence and stop.",
  );
});

test("a plan with open steps continues, and the same steps again stop it", () => {
  const todos = [step("a", "One", "done"), step("b", "Two", "in_progress"), step("c", "Three")];
  const first = nextMove({ text: "Finished the first part.", todos, chain: chain() });
  assert.equal(first.move, "continue");
  assert.equal(first.reason, "plan");
  assert.deepEqual(first.plan, { open: 2, total: 3 });
  assert.match(first.input, /Botkins kept going 1 of 8 times/);
  // The chain remembers the signature; a turn that leaves exactly these steps open is not given another.
  const again = nextMove({ text: "Still working.", todos, chain: chain({ count: 1, signature: first.signature }) });
  assert.equal(again.move, "stop");
  assert.equal(again.stoppedOpen, true);
  // One step moved on: different open steps, so it goes on.
  const moved = [step("a", "One", "done"), step("b", "Two", "done"), step("c", "Three")];
  assert.equal(nextMove({ text: "ok", todos: moved, chain: chain({ count: 1, signature: first.signature }) }).move, "continue");
  // A step with the same id but new words is a new step.
  assert.notEqual(openSignature([step("c", "Three")]), openSignature([step("c", "Three, again")]));
  assert.equal(openSignature([step("b", "Two"), step("c", "Three")]), openSignature([step("c", "Three"), step("b", "Two")]));
});

test("a chain goes on at most eight times", () => {
  let signature;
  let count = 0;
  for (; count < 20; count++) {
    // Each turn finishes one step and adds another, so the open steps always differ.
    const todos = [step("x" + count, "Step " + count)];
    const move = nextMove({ text: "ok", todos, chain: chain({ count, signature }) });
    if (move.move === "stop") {
      assert.equal(move.stoppedOpen, true);
      break;
    }
    signature = move.signature;
  }
  assert.equal(count, MAX_CONTINUATIONS);
});

test("nothing continues past a question, a guard, or a finished plan", () => {
  const todos = [step("a", "One")];
  assert.equal(nextMove({ text: "Which file do you mean?", todos, chain: chain() }).move, "stop");
  assert.equal(nextMove({ text: "ok", todos, chain: chain(), blocked: true }).move, "stop");
  assert.equal(nextMove({ text: "Next I'll run the tests.", todos: [], chain: chain(), blocked: true }).move, "stop");
  const done = nextMove({ text: "All finished.", todos: [step("a", "One", "done")], chain: chain() });
  assert.equal(done.move, "stop");
  assert.equal(done.stoppedOpen, false);
  assert.deepEqual(done.plan, { open: 0, total: 1 });
  // "Shall I continue?" is not a question to the person: with open steps it continues.
  assert.equal(nextMove({ text: "Shall I continue?", todos, chain: chain() }).reason, "plan");
});

test("the next-step catch goes at most twice, and only when no plan has open steps", () => {
  const first = nextMove({ text: "Tests pass. Next I'll update the docs.", todos: undefined, chain: chain() });
  assert.equal(first.move, "continue");
  assert.equal(first.reason, "next-step");
  assert.equal(first.input, STALL_NOTE);
  assert.equal(nextMove({ text: "Next I'll update the docs.", chain: chain({ count: 2, stalls: 2 }) }).move, "stop");
  assert.equal(nextMove({ text: "Let me run it now.", chain: chain({ count: 1, stalls: 1 }) }).move, "continue");
  // With open steps the plan decides, and a repeat of them is not turned into a next-step catch.
  const todos = [step("a", "One")];
  const repeat = nextMove({ text: "Next I'll update the docs.", todos, chain: chain({ count: 1, signature: openSignature(todos) }) });
  assert.equal(repeat.move, "stop");
});

test("queued messages from one person are taken together; another person's, a command and a voice line are not", () => {
  const owner = (text, more = {}) => ({ id: text, text, ...more });
  const ann = (text) => ({ id: text, text, author: { memberId: "m1", name: "Ann" } });
  const queue = [owner("a"), owner("b", { attachments: [{ path: "/x" }] }), ann("c"), ann("d"), owner("/compact"), owner("e")];
  let batch = takeBatch(queue);
  assert.deepEqual([batch.first.text, ...batch.rest.map((m) => m.text)], ["a", "b"]);
  assert.deepEqual(batch.rest[0].attachments, [{ path: "/x" }], "each message keeps its own attachments");
  batch = takeBatch(queue);
  assert.deepEqual([batch.first.text, ...batch.rest.map((m) => m.text)], ["c", "d"], "a member's messages go together");
  batch = takeBatch(queue);
  assert.deepEqual([batch.first.text, batch.rest.length], ["/compact", 0], "a command is a turn of its own");
  batch = takeBatch(queue);
  assert.deepEqual([batch.first.text, batch.rest.length], ["e", 0]);
  assert.deepEqual(takeBatch(queue), { first: undefined, rest: [] });
  assert.equal(mergeable(owner("hi", { voiceId: "v1" })), false);
  // A quiet message is not read with a loud one, and a message that can't be sent stays for its own turn.
  assert.deepEqual(takeBatch([owner("a"), owner("b", { notify: false }), owner("c")]).rest, []);
  assert.deepEqual(takeBatch([owner("a"), owner("c"), owner("d")], (item) => item.text !== "d").rest.map((m) => m.text), ["c"]);
});

test("a turn that starts with several messages says so", () => {
  assert.equal(
    mergedPrompt(["first", "second"]),
    "[Botkins] The person sent 2 messages while you were busy. Here they are in order; read them all before you reply.\n\nMessage 1:\nfirst\n\nMessage 2:\nsecond",
  );
});
