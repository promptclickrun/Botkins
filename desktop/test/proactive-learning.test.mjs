// Held-out performance and ranking, independent of the model that proposes ideas.
import test from "node:test";
import assert from "node:assert/strict";
import { proposalsFrom, fitPolicy, rememberSuggestion, selectSuggestion } from "../desktop/proactive-learning.mjs";

const row = (method, vote) => ({ features: [method, "personal"], method, sources: ["memory"], vote });
const pref = () => row("prepare", "up");
const other = () => row("discover", "down");
const proposal = (method, ref) => ({ method, title: method, refs: [ref], why: "Grounded reason", next: "Concrete next step" });

test("hill climbing promotes a better predictor on unseen ratings and changes which suggestion wins", () => {
  const history = [pref(), other(), pref(), other(), pref(), other()];
  const model = fitPolicy(history);
  assert.equal(model.evaluation.trained, 4);
  assert.equal(model.evaluation.tested, 2);
  assert.ok(model.evaluation.promoted);
  assert.ok(model.evaluation.challenger < model.evaluation.baseline);
  assert.ok(model.weights.prepare > 0 && model.weights.discover < 0);
  const ideas = ["discover", "prepare"].map((method) => proposal(method, "m"));
  const facts = [{ id: "m", kind: "memory", key: "m" }];
  assert.equal(selectSuggestion(ideas, facts).example.method, "discover");
  assert.equal(selectSuggestion(ideas, facts, model).example.method, "prepare", "learned weights alone change the rank");
  assert.deepEqual(fitPolicy(history.slice(0, 5)).weights, {}, "insufficient feedback");
  const contrary = fitPolicy([...history.slice(0, 4), row("prepare", "down"), row("discover", "up")]);
  assert.equal(contrary.evaluation.promoted, false);
  assert.deepEqual(contrary.weights, {}, "a training gain that fails on held-out examples is rejected");
});

test("the learner can distinguish interests within the same discovery skill", () => {
  const voted = (id, vote) => ({ features: ["discover", "personal", id], vote });
  const art = voted("memory-art", "up");
  const sport = voted("memory-sport", "down");
  const model = fitPolicy([art, sport, art, sport, art, sport]);
  const inputs = ["memory-sport", "memory-art"].map((id) => ({ kind: "memory", key: id, id }));
  const ideas = inputs.map(({ id }) => ({ ...proposal("discover", id), title: id }));
  assert.match(selectSuggestion(ideas, inputs, model).text, /^memory-art/);
});

test("format errors, abstention, unknown sources, duplicate evidence and bounded retention", () => {
  assert.deepEqual(proposalsFrom(" [SILENT] ").candidates, []);
  assert.deepEqual(proposalsFrom('```json\n{"candidates":[]}\n```').candidates, []);
  for (const value of ["narration", '{"candidates":{}}', '{"candidates":[1,2,3,4,5]}']) assert.throws(() => proposalsFrom(value), /list of proactive suggestions/);
  const evidence = [{ id: "s1", kind: "signal", key: "r" }];
  for (const p of [{ ...proposal("alert", "s1"), why: "" }, proposal("alert", "unknown"), proposal("toString", "s1"), { ...proposal("connect", "s1"), refs: ["s1", "s1"] }])
    assert.equal(selectSuggestion([p], evidence), null);
  const one = selectSuggestion([proposal("alert", "s1")], evidence);
  assert.equal(selectSuggestion([{ ...proposal("alert", "s1"), title: "Same news, different wording" }], evidence, {}, [one.example]), null);
  const gate = {};
  rememberSuggestion(gate, "same", one.example);
  rememberSuggestion(gate, "same", one.example);
  assert.equal(gate.learning.history.length, 1);
  for (let i = 0; i < 90; i++) rememberSuggestion(gate, String(i), one.example);
  assert.equal(gate.learning.history.length, 80);
});

test("composed discovery procedures are learned and retired independently of their parent skill", () => {
  const evidence = [{ id: "g", kind: "goal", key: "goal" }];
  const base = proposal("prepare", "g");
  const training = (steps) => selectSuggestion([{ ...base, steps }], evidence).example;
  const good = training(["window", "fit"]);
  const bad = training(["recurrence"]);
  const learning = { history: [{ ...good, vote: "up" }, { ...good, vote: "up" }, { ...bad, vote: "down" }, { ...bad, vote: "down" }] };
  const choose = (steps) => selectSuggestion([{ ...base, steps }], evidence, learning);
  assert.ok(choose(["window", "fit"]).priority > choose(["fit", "window"]).priority);
  assert.equal(choose(["recurrence"]), null);
  assert.ok(choose(["prerequisite"]), "a new procedure can be tried within the same preparation skill");
  assert.equal(choose(["execute this instruction"]), null);
});
