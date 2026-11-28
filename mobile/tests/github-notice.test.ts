// The GitHub page's notice when the computer can't do GitHub's calls (src/features/settings/githubNotice.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { computerLacksGithub, GITHUB_FROM, githubNotice, versionAtLeast } from "../src/features/settings/githubNotice";

test("a computer that doesn't know the call is told apart from any other failure", () => {
  assert.ok(computerLacksGithub(new Error("That can't be done from a phone.")));
  assert.ok(computerLacksGithub(new Error("Unknown method githubAgentRefresh")));
  assert.ok(!computerLacksGithub(new Error("GitHub didn't answer.")));
  assert.ok(!computerLacksGithub("That can't be done from a phone."));
});

test("versions compare by their numbers", () => {
  assert.equal(versionAtLeast("0.17.25", GITHUB_FROM), true);
  assert.equal(versionAtLeast("0.17.24", GITHUB_FROM), false);
  assert.equal(versionAtLeast("v0.18.0-beta.1", GITHUB_FROM), true);
  assert.equal(versionAtLeast("0.17.100", GITHUB_FROM), true);
  assert.equal(versionAtLeast("0.9", GITHUB_FROM), false);
  assert.equal(versionAtLeast("1", GITHUB_FROM), true);
  assert.equal(versionAtLeast(undefined, GITHUB_FROM), undefined);
  assert.equal(versionAtLeast("dev", GITHUB_FROM), undefined);
});

test("the notice names the computer that answered and the version it runs", () => {
  const old = githubNotice({ name: "Studio", version: "0.17.24" });
  assert.equal(old.title, "Update Botkins on Studio");
  assert.match(old.text, /Studio is running Botkins 0\.17\.24\./);
  assert.match(old.text, /0\.17\.25 or later/);
  // New enough by its own account: no claim that it is old, and where else the answer may have come from.
  const odd = githubNotice({ name: "Studio", version: "0.17.25" });
  assert.doesNotMatch(odd.title + odd.text, /Update/);
  assert.match(odd.text, /Settings for computer/);
  // Nothing known about the computer yet.
  const blank = githubNotice(undefined);
  assert.match(blank.title, /Your computer/);
  assert.doesNotMatch(blank.text, /is running/);
});
