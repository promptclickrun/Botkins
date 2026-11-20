// Model ids as names people read (desktop/modelnames.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { friendlyModel, friendlyName } from "../desktop/modelnames.mjs";

test("a GPT id keeps its version with GPT and turns the rest into words", () => {
  assert.equal(friendlyModel("gpt-6.2-sol"), "GPT-6.2 Sol");
  assert.equal(friendlyModel("gpt-6-astra"), "GPT-6 Astra");
  assert.equal(friendlyModel("GPT-6-Luna"), "GPT-6 Luna", "capitals in the id make no difference");
  assert.equal(friendlyModel("gpt-4o-mini"), "GPT-4o Mini", "a version with a letter in it is still a version");
});

test("the Copilot runtime's plan prefix is not part of the name", () => {
  assert.equal(friendlyModel("chatgpt/gpt-6-astra"), "GPT-6 Astra");
  assert.equal(friendlyModel("claude/opus"), "Claude Opus");
});

test("a Claude id becomes family and version, whichever way round the id puts them", () => {
  assert.equal(friendlyModel("opus"), "Claude Opus", "a bare family is a name already");
  assert.equal(friendlyModel("claude-opus-5-5"), "Claude Opus 5.5");
  assert.equal(friendlyModel("claude-3-5-sonnet"), "Claude Sonnet 3.5", "the older order, version before family");
});

test("a context mark and a date stamp are dropped", () => {
  assert.equal(friendlyModel("claude-haiku-5-5[1m]"), "Claude Haiku 5.5");
  assert.equal(friendlyModel("claude-haiku-4-5-20251001"), "Claude Haiku 4.5");
});

test("other ids are split into words, and \"auto\" is Auto", () => {
  assert.equal(friendlyModel("gemini-2.5-pro"), "Gemini 2.5 Pro");
  assert.equal(friendlyModel("auto"), "Auto");
  assert.equal(friendlyModel("AUTO"), "Auto");
});

test("nothing in, nothing out", () => {
  assert.equal(friendlyModel(""), "");
  assert.equal(friendlyModel("   "), "");
  assert.equal(friendlyModel(undefined), "");
  assert.equal(friendlyModel(null), "");
});

test("a catalog's real name is kept as it is", () => {
  assert.equal(friendlyName("Claude Opus 5.5", "claude-opus-5-5"), "Claude Opus 5.5");
  assert.equal(friendlyName("Auto", "auto"), "Auto", "one word without dashes is a name, not an id");
});

test("a name that is missing, equal to the id, or id-like is made readable", () => {
  assert.equal(friendlyName(undefined, "claude-opus-5-5"), "Claude Opus 5.5");
  assert.equal(friendlyName(null, "gpt-6-astra"), "GPT-6 Astra");
  assert.equal(friendlyName("   ", "gpt-6-astra"), "GPT-6 Astra", "blank counts as missing");
  assert.equal(friendlyName("gpt-6-astra", "gpt-6-astra"), "GPT-6 Astra", "the id itself is no name");
  assert.equal(friendlyName("GPT-6-Luna", "luna-id"), "GPT-6 Luna", "an id dressed as a name");
  assert.equal(friendlyName("chatgpt/gpt-6-astra", "x"), "GPT-6 Astra");
});
