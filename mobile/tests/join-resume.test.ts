// Join a team must never trap a person (issue #22): a saved join request is picked up at launch only
// while it is fresh, an old or unreadable one is dropped, and a computer's pairing code or link typed
// in the invite field is recognised and sent to pairing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { JOIN_RESUME_MS, pairingParams, parseInviteInput, readJoinResume, resumeDecision, savedJoin } from "../src/features/pair/joinLogic";
import type { JoinAttempt } from "../src/link/client";

const attempt: JoinAttempt = {
  target: { code: "1234567890", serverKey: "A".repeat(43), serverId: "server", hosts: ["localhost:1"], name: "Studio" },
  device: { name: "Pixel 9", platform: "android", kind: "phone" },
  keys: { publicKey: "public", secretKey: "secret" },
};
const now = Date.UTC(2026, 10, 20, 12);

test("a fresh saved request is picked up, and comes back without its time", () => {
  assert.deepEqual(resumeDecision(savedJoin(attempt, now - 60_000), now), { kind: "resume", attempt });
  assert.deepEqual(resumeDecision(savedJoin(attempt, now - JOIN_RESUME_MS + 1000), now), { kind: "resume", attempt });
});

test("nothing saved opens nothing", () => {
  assert.deepEqual(resumeDecision(null, now), { kind: "none" });
  assert.deepEqual(resumeDecision(undefined, now), { kind: "none" });
  assert.deepEqual(resumeDecision("", now), { kind: "none" });
});

test("a stale, unreadable or older version's request is dropped, not reopened", () => {
  // Older than the limit: the owner never answered.
  assert.deepEqual(resumeDecision(savedJoin(attempt, now - JOIN_RESUME_MS - 1), now), { kind: "drop" });
  // Saved by build 11, which kept no time: its age can't be known, and it is what trapped the tester.
  assert.deepEqual(resumeDecision(JSON.stringify(attempt), now), { kind: "drop" });
  // A time from the future (a clock that was wrong).
  assert.deepEqual(resumeDecision(savedJoin(attempt, now + 10 * 60_000), now), { kind: "drop" });
  for (const bad of ["{", "null", "42", JSON.stringify({ savedAt: now }), JSON.stringify({ ...attempt, keys: undefined, savedAt: now })]) {
    assert.deepEqual(resumeDecision(bad, now), { kind: "drop" }, bad);
  }
});

test("a dropped request is never sent to the computer", async () => {
  let asked = 0;
  const check = async () => {
    asked++;
    return { status: "denied" } as const;
  };
  assert.equal(await readJoinResume(async () => JSON.stringify(attempt), check, now), null);
  assert.equal(await readJoinResume(async () => savedJoin(attempt, now - JOIN_RESUME_MS - 1), check, now), null);
  assert.equal(await readJoinResume(async () => {
    throw new Error("keychain locked");
  }, check, now), null);
  assert.equal(asked, 0);
  assert.equal((await readJoinResume(async () => savedJoin(attempt, now), check, now))?.state.phase, "denied");
  assert.equal(asked, 1);
});

test("a computer's pairing code in the invite field is recognised, with its own letters", () => {
  // Twelve characters from the pairing alphabet, which has L (an invite reads L as 1).
  assert.deepEqual(parseInviteInput("ABCD-EFGH-JKLM"), { code: "ABCD-EFGH-JKLM", serverKey: undefined, pairing: { kind: "code", code: "ABCDEFGHJKLM" } });
  assert.deepEqual(parseInviteInput("abcdefghjklm"), { code: "ABCD-EFGH-JKLM", serverKey: undefined, pairing: { kind: "code", code: "ABCDEFGHJKLM" } });
  // On the way there it shows in groups of four, and isn't a team invite or a pairing code yet.
  assert.deepEqual(parseInviteInput("ABCDEFGHJKL"), { code: "ABCD-EFGH-JKL", serverKey: undefined });
  // A team invite is read as before.
  assert.deepEqual(parseInviteInput("ABCDE-FGHJK"), { code: "ABCDE-FGHJK", serverKey: undefined });
  assert.deepEqual(parseInviteInput(" il-o1234567 "), { code: "11012-34567", serverKey: undefined });
});

test("a pairing link in the invite field goes to pairing with its values", () => {
  const url = "botkins://pair?v=1&s=server&k=" + "K".repeat(43) + "&c=ABCDEFGHJKLM&h=192.168.1.20%3A47610&n=Studio%20Mac";
  assert.deepEqual(parseInviteInput(" " + url + " "), { code: "", serverKey: undefined, pairing: { kind: "link", url } });
  assert.deepEqual(pairingParams(url), { v: "1", s: "server", k: "K".repeat(43), c: "ABCDEFGHJKLM", h: "192.168.1.20:47610", n: "Studio Mac" });
  // A team invite link is still a team invite.
  assert.equal(parseInviteInput("botkins://join?c=12345-67890&k=" + "A".repeat(43)).pairing, undefined);
});

test("the root layout names where each guard leads, and opens a picked-up request on top", () => {
  // Without redirectTo, a phone with no computer fell back to the first open route by file name: /join.
  const layout = readFileSync(join(import.meta.dirname, "../src/app/_layout.tsx"), "utf8");
  assert.match(layout, /<Stack\.Protected guard=\{!paired\} redirectTo="\/">/);
  assert.match(layout, /<Stack\.Protected guard=\{paired\} redirectTo="\/welcome">/);
  assert.match(layout, /router\.push\(\{ pathname: "\/join", params: \{ resume: "1" \} \}\)/);
  assert.doesNotMatch(layout, /router\.replace\(\{ pathname: "\/join"/);
});
