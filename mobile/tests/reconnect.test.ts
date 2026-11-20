import assert from "node:assert/strict";
import { test } from "node:test";
import { canBrowse, NearbyPace } from "../src/state/reconnect";

test("fruitless looks get farther apart, and resetting keeps the minimum gap", () => {
  const pace = new NearbyPace();
  let now = 0;
  assert.equal(pace.allowed(now), true);
  for (const gap of [20, 40, 80, 160, 300, 300]) {
    pace.started(now);
    pace.missed(now);
    now += gap * 1000;
    assert.equal(pace.allowed(now - 1), false);
    assert.equal(pace.allowed(now), true);
  }
  pace.started(now);
  pace.missed(now);
  pace.reset();
  assert.equal(pace.allowed(now + 19_999), false);
  assert.equal(pace.allowed(now + 20_000), true);
  pace.started(now + 20_000);
  pace.missed(now + 20_000);
  assert.equal(pace.allowed(now + 40_000), true);
});

test("only a known cellular, absent or disconnected network rules out Bonjour", () => {
  for (const network of [{ type: "CELLULAR" }, { type: "NONE" }, { type: "WIFI", isConnected: false }])
    assert.equal(canBrowse(network), false);
  for (const network of [{ type: "WIFI" }, { type: "UNKNOWN" }, {}, undefined])
    assert.equal(canBrowse(network), true);
});
