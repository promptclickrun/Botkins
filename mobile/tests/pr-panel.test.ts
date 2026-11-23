import assert from "node:assert/strict";
import test from "node:test";
import { PullRequests } from "../link-host/prs.mjs";
import { pullRequestUrl } from "../link-host/pr-url.mjs";
import { draftPulls, pullReference } from "../src/link/pr-reference";
import { authorize, defaultTeam } from "../link-host/team.mjs";
import { demoGitHub } from "../link-host/mock-prs.mjs";

const url = "https://github.com/example/botkins/pull/42";
const pr = { url };
const file = { url, path: "README.md" };
const host = (runGitHub = demoGitHub) => new PullRequests({ backend: { runGitHub }, searchPath: [] });

test("only GitHub pull request permalinks resolve to a PR", () => {
  for (const suffix of ["", "/", "/files", "/commits/", "#issuecomment-2", "/files#diff-abc"])
    assert.deepEqual(pullRequestUrl(url + suffix), { url, repository: "example/botkins", number: 42 });
  for (const other of [url + "/merge", url.replace("pull", "issues"), url.replace("42", "0"), url.replace("42", "-1"),
    url.replace("github.com", "github.com.evil.test"), url.replace("https:", "http:"), url.replace("github.com", "me@github.com"), url.replace("botkins", "..")])
    assert.equal(pullRequestUrl(other), null, other);
});

test("picker Markdown and the draft chip retain titles with brackets and backslashes", () => {
  const title = String.raw`Fix [paths] on C:\work`;
  const token = pullReference({ number: 42, state: "open", draft: false, url, title });
  assert.deepEqual(draftPulls("Review " + token), [{ url, label: "#42 " + title }]);
  assert.deepEqual(draftPulls(token.replace("github.com/", "other.test/")), []);
});

test("the demo detail and patch travel through the gh parser, concurrent detail reads share a call", async () => {
  const calls: string[][] = [];
  const prs = host(async (args: string[]) => { calls.push(args); return demoGitHub(args); });
  const [a, b] = await Promise.all([prs.panel(pr), prs.panel({ url: url + "/files" })]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 6), ["pr", "view", "42", "--repo", "github.com/example/botkins", "--json"]);
  assert.deepEqual(a.pull, { number: 42, title: "Share one in-flight token renewal per server", draft: false, state: "open", url,
    author: "mira-bot", base: "main", head: "branch-42", repository: "example/botkins", body: "Ready for **review**.",
    createdAt: "2026-11-20T12:00:00Z", updatedAt: "2026-11-21T13:00:00Z", checks: [{ name: "Unit tests", result: "success" }],
    summary: "Passing", review: "approved", files: [{ path: "README.md", additions: 1, deletions: 0 }] });
  assert.match((await prs.panel(file, true)).text, /\+Ready for review/);
  assert.equal((await prs.panel({ url, path: "other" }, true)).available, false);
});

test("check runs and legacy contexts contribute to the overall result", async () => {
  const raw = JSON.parse(await demoGitHub(["pr", "view", "42"]));
  for (const [summary, contexts] of Object.entries({
    "No checks": [], Pending: [{ status: "IN_PROGRESS" }, { state: "SUCCESS" }],
    Failing: [{ status: "QUEUED" }, { context: "build", state: "ERROR" }],
    Neutral: [{ conclusion: "SKIPPED" }], Passing: [{ state: "SUCCESS" }],
  })) {
    const answer = await host(async () => JSON.stringify({ ...raw, statusCheckRollup: contexts })).panel(pr);
    assert.equal(answer.pull.summary, summary);
    if (summary === "Failing") assert.deepEqual(answer.pull.checks[1], { name: "build", result: "error" });
  }
});

test("oversize diffs and tool failures have bounded, actionable answers", async () => {
  for (const patch of ["+".repeat(128 * 1024 + 1), "+a\n".repeat(3000)])
    assert.match((await host(async () => JSON.stringify([[{ filename: file.path, patch }]])).panel(file, true)).reason, /too large/);
  for (const [kind, detail, reason] of [
    ["output", "", /too large/], ["missing", "", /Install/], ["timeout", "", /too long/],
    ["exit", "HTTP 403 private detail", /access/], ["exit", "HTTP 401 private detail", /Sign in/],
  ] as const) {
    const result = await host(async () => { throw { kind, detail }; }).panel(file, true);
    assert.match(result.reason, reason);
    assert.doesNotMatch(result.reason, /private detail/);
  }
});

test("PR panel reads require the same owner credential as PR search", () => {
  const team = defaultTeam();
  for (const method of ["link.pullRequest", "link.pullRequestDiff"]) {
    assert.equal(authorize({ kind: "owner" }, team, method), "");
    assert.equal(authorize({ kind: "member", groupId: team.groups[0].id }, team, method), "Only the owner can do that.");
  }
});
