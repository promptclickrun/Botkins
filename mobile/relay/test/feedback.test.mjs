// The feedback route (src/feedback.ts) with a fake GitHub and a fake Turnstile. Node reads the TypeScript directly.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { corsFor, feedbackChallenge, handleFeedback, issueFor, parseReport, repoOf } from "../src/feedback.ts";

const allow = { limit: async () => ({ success: true }) };
const deny = { limit: async () => ({ success: false }) };
const env = (change = {}) => ({ GITHUB_ISSUES_TOKEN: "t", TURNSTILE_SECRET: "s", FEEDBACK_REPO: "promptclickrun/Botkins", REQUESTS: allow, FEEDBACK: allow, ...change });

function computer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ format: "jwk" }).x;
  return {
    key,
    body(report, time = Math.floor(Date.now() / 1000), signer = privateKey) {
      const sig = sign(null, Buffer.from(feedbackChallenge(time, report), "utf8"), signer).toString("base64url");
      return JSON.stringify({ v: 1, key, time, sig, report });
    },
  };
}

function fakeFetch({ turnstile = true, github = 201 } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("turnstile")) return Response.json({ success: turnstile });
    if (github !== 201) return new Response("no", { status: github });
    return Response.json({ number: 42, html_url: "https://github.com/promptclickrun/Botkins/issues/42" }, { status: 201 });
  };
  return { calls, fetcher };
}

const post = (body, headers = {}) => new Request("https://relay.test/v1/feedback", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
const report = (change = {}) => JSON.stringify({ kind: "bug", title: "Chat list jumps", body: "Opening a chat scrolls the list to the top.", app: "Botkins iOS", version: "0.17.16", platform: "iOS 26.1", ...change });

describe("reports", () => {
  it("accepts a good one and cleans it", () => {
    const parsed = parseReport(report({ title: "  Chat\nlist   jumps ", platform: "<script>" }));
    assert.equal(parsed.title, "Chat list jumps");
    assert.equal(parsed.platform, undefined, "a label with odd characters is dropped");
  });
  it("refuses bad ones", () => {
    for (const bad of ["nope", "[]", report({ kind: "rant" }), report({ title: "ok" }), report({ body: "" }), report({ body: "x".repeat(9000) })]) {
      assert.equal(parseReport(bad), null, bad.slice(0, 40));
    }
  });
  it("makes an issue that pings nobody and is labeled by kind and source", () => {
    const issue = issueFor(parseReport(report({ body: "cc @octocat please" })), "app");
    assert.deepEqual(issue.labels, ["bug", "from-app"]);
    assert.ok(!issue.body.includes("@octocat"));
    assert.match(issue.body, /Version: 0\.17\.16/);
    assert.deepEqual(issueFor(parseReport(report({ kind: "feature" })), "website").labels, ["enhancement", "from-website"]);
  });
  it("only the site's own origins get CORS, and the repo must look like one", () => {
    assert.equal(corsFor("https://botkins.app")["access-control-allow-origin"], "https://botkins.app");
    assert.deepEqual(corsFor("https://evil.example"), {});
    assert.equal(repoOf({ FEEDBACK_REPO: "a/b; rm" }), null);
  });
});

describe("POST /v1/feedback", () => {
  it("a computer's signed report opens an issue", async () => {
    const pc = computer();
    const { calls, fetcher } = fakeFetch();
    const answer = await handleFeedback(post(pc.body(report())), env(), true, "1.2.3.4", fetcher);
    assert.equal(answer.status, 201);
    assert.deepEqual(await answer.json(), { number: 42, url: "https://github.com/promptclickrun/Botkins/issues/42" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.github.com/repos/promptclickrun/Botkins/issues");
    assert.equal(calls[0].init.headers.authorization, "Bearer t");
    assert.deepEqual(JSON.parse(calls[0].init.body).labels, ["bug", "from-app"]);
  });
  it("a bad or stale signature is refused before GitHub is called", async () => {
    const pc = computer();
    const other = generateKeyPairSync("ed25519").privateKey;
    const { calls, fetcher } = fakeFetch();
    assert.equal((await handleFeedback(post(pc.body(report(), undefined, other)), env(), true, "n", fetcher)).status, 401);
    assert.equal((await handleFeedback(post(pc.body(report(), Math.floor(Date.now() / 1000) - 3600)), env(), true, "n", fetcher)).status, 401);
    assert.equal(calls.length, 0);
  });
  it("a website report needs a Turnstile pass", async () => {
    const body = JSON.stringify({ v: 1, turnstile: "tok", report: report() });
    const ok = fakeFetch();
    const answer = await handleFeedback(post(body, { origin: "https://botkins.app" }), env(), true, "n", ok.fetcher);
    assert.equal(answer.status, 201);
    assert.equal(answer.headers.get("access-control-allow-origin"), "https://botkins.app");
    assert.deepEqual(JSON.parse(ok.calls[1].init.body).labels, ["bug", "from-website"]);
    const no = fakeFetch({ turnstile: false });
    assert.equal((await handleFeedback(post(body), env(), true, "n", no.fetcher)).status, 401);
    assert.equal(no.calls.length, 1, "GitHub is not called");
  });
  it("is off without the token, limited, and reports GitHub failures plainly", async () => {
    const pc = computer();
    assert.equal((await handleFeedback(post(pc.body(report())), env({ GITHUB_ISSUES_TOKEN: undefined }), true, "n", fakeFetch().fetcher)).status, 503);
    assert.equal((await handleFeedback(post(pc.body(report())), env({ FEEDBACK: deny }), true, "n", fakeFetch().fetcher)).status, 429);
    assert.equal((await handleFeedback(post(pc.body(report())), env(), true, "n", fakeFetch({ github: 403 }).fetcher)).status, 502);
    assert.equal((await handleFeedback(post(pc.body(report({ kind: "x" }))), env(), true, "n", fakeFetch().fetcher)).status, 400);
    const preflight = await handleFeedback(new Request("https://relay.test/v1/feedback", { method: "OPTIONS", headers: { origin: "https://botkins.app" } }), env(), true, "n");
    assert.equal(preflight.status, 204);
  });
});
