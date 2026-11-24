import assert from "node:assert/strict";
import { test } from "node:test";
import { initialServerLinkPhase, nextServerLinkPhase } from "../src/features/home/linkStatus";

test("initialServerLinkPhase reflects initial link state without flashing connected when already online", () => {
  assert.equal(initialServerLinkPhase("connecting"), "connecting");
  assert.equal(initialServerLinkPhase("offline"), "failed");
  assert.equal(initialServerLinkPhase("online"), "hidden");
  assert.equal(initialServerLinkPhase("revoked"), "hidden");
});

test("nextServerLinkPhase covers connecting, connected, failed, and revoked transitions", () => {
  assert.equal(nextServerLinkPhase("connecting", "online"), "connected");
  assert.equal(nextServerLinkPhase("failed", "online"), "connected");
  assert.equal(nextServerLinkPhase("hidden", "online"), "hidden");
  assert.equal(nextServerLinkPhase("connecting", "offline"), "failed");
  assert.equal(nextServerLinkPhase("failed", "connecting"), "connecting");
  assert.equal(nextServerLinkPhase("connected", "connecting"), "connecting");
  assert.equal(nextServerLinkPhase("connecting", "revoked"), "hidden");
  assert.equal(nextServerLinkPhase("failed", "revoked"), "hidden");
});

test("minSpinActive keeps manual retry spinning on instant failure, but allows instant success", () => {
  assert.equal(nextServerLinkPhase("connecting", "offline", true), "connecting");
  assert.equal(nextServerLinkPhase("connecting", "offline", false), "failed");
  assert.equal(nextServerLinkPhase("connecting", "online", true), "connected");
});
