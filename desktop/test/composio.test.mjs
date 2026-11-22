// Marketplace › Apps on the computer (desktop/composio.mjs): the MCP client against a fake Composio,
// the sign-in it needs, and the app list kept on disk with its ETag.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composioHandlers, connectionResults, createComposio, MCP_URL, payloadOf } from "../desktop/composio.mjs";

const SERVER = { id: "composio", name: "composio", type: "http", url: MCP_URL, enabled: true, oauth: {} };

/** A fake Composio: one MCP endpoint that keeps accounts, answering by SSE. */
function fakeComposio() {
  const accounts = { gmail: [{ id: "ca_1", status: "ACTIVE", user_info: { email: "me@example.com" } }], github: [] };
  const seen = { urls: [], auth: [], sessions: [], refuseNext: 0 };
  const sse = (body) => new Response("event: message\ndata: " + JSON.stringify(body) + "\n\n", { headers: { "content-type": "text/event-stream", "mcp-session-id": "s-1" } });
  const fetch = async (url, init) => {
    seen.urls.push(String(url));
    seen.auth.push(init.headers.Authorization);
    seen.sessions.push(init.headers["Mcp-Session-Id"] ?? null);
    if (seen.refuseNext > 0) {
      seen.refuseNext--;
      return new Response("", { status: 401 });
    }
    const message = JSON.parse(init.body);
    if (message.method === "initialize") return sse({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } });
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/list") return sse({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "COMPOSIO_SEARCH_TOOLS", description: "Finds tools. User has manually connected the apps: gmail, Bad Slug!, github." }] } });
    const { toolkits } = message.params.arguments;
    const results = {};
    for (const kit of toolkits) {
      if (kit.action === "list") results[kit.name] = { accounts: accounts[kit.name] ?? [] };
      if (kit.action === "add") {
        const pending = { id: "ca_new", status: "INITIATED" };
        (accounts[kit.name] ??= []).push(pending);
        results[kit.name] = { redirect_url: "https://connect.composio.dev/link/abc", accounts: accounts[kit.name] };
      }
      if (kit.action === "remove") accounts[kit.name] = (accounts[kit.name] ?? []).filter((entry) => entry.id !== kit.account_id);
    }
    return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results } }) }] } });
  };
  return { fetch, seen, accounts };
}

function workspaceWith(fetch, { servers = [SERVER], tokens = ["old", "new"] } = {}) {
  const asked = [];
  const integrations = {
    servers,
    client: () => undefined,
    oauth: {
      token: async (server, { reason }) => {
        asked.push(reason);
        const token = reason === "reauth" ? tokens[1] : tokens[0];
        return token ? { accessToken: token, tokenType: "Bearer" } : null;
      },
    },
  };
  return { workspace: { fetch, integrations }, asked };
}

test("accounts are listed, added and removed through Composio's tool, and a refused token is renewed once", async () => {
  const fake = fakeComposio();
  const { workspace, asked } = workspaceWith(fake.fetch);
  const apps = composioHandlers(workspace);

  assert.deepEqual(await apps["composio.connected"](), ["gmail", "github"]);
  // One session: initialize, initialized, then the call, all with it once Composio named it.
  assert.deepEqual(fake.seen.sessions, [null, "s-1", "s-1"]);
  assert.ok(fake.seen.urls.every((url) => url === MCP_URL), "requests go only to Composio's address");

  assert.deepEqual(await apps["composio.accounts"](["gmail", "github", "NOT OK"]), { gmail: [{ id: "ca_1", status: "active", label: "me@example.com" }], github: [] });
  const started = await apps["composio.connect"]("github");
  assert.deepEqual(started, { redirectUrl: "https://connect.composio.dev/link/abc", pendingId: "ca_new", accounts: [{ id: "ca_new", status: "pending" }] });
  await apps["composio.removeAccount"]("github", "ca_new");
  assert.deepEqual(fake.accounts.github, []);

  // Composio turns the token down once: the sign-in is asked to renew it, and the call goes through.
  fake.seen.refuseNext = 1;
  asked.length = 0;
  fake.seen.auth.length = 0;
  assert.deepEqual((await apps["composio.accounts"](["gmail"])).gmail.length, 1);
  assert.deepEqual(asked, ["initial", "reauth"]);
  assert.deepEqual(fake.seen.auth, ["Bearer old", "Bearer new"]);

  // Refused again after the renewal: a sentence, never the token.
  fake.seen.refuseNext = 2;
  await assert.rejects(apps["composio.accounts"](["gmail"]), (error) => error.message === "Composio refused the request." && !/old|new/.test(error.message));
});

test("with no Composio tool, or no sign-in, every call says to sign in first", async () => {
  const fake = fakeComposio();
  for (const setup of [{ servers: [] }, { servers: [{ ...SERVER, oauth: undefined }] }, { tokens: [null, null] }]) {
    const { workspace } = workspaceWith(fake.fetch, setup);
    const apps = composioHandlers(workspace);
    await assert.rejects(apps["composio.accounts"](["gmail"]), { message: "Sign in with Composio first." });
    await assert.rejects(apps["composio.connected"](), { message: "Sign in with Composio first." });
  }
  assert.equal(fake.seen.urls.length, 0, "nothing was sent without a token");
});

test("the app list is served from disk at once, and checked again with its ETag after an hour", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-composio-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalog = {
    schemaVersion: 1,
    revision: "r1",
    categories: [{ id: "mail", name: "Email" }, { id: "dev", name: "Developer tools" }, { id: "none", name: "Empty" }],
    toolkits: [
      { slug: "gmail", name: "Gmail", description: "Mail", logo: "https://logos.composio.dev/api/gmail", categories: ["mail"] },
      { slug: "github", name: "GitHub", logo: "http://not-https", categories: ["dev", "unknown"] },
      { slug: "Bad Slug", name: "Dropped" },
      { slug: "gmail", name: "Twice" },
    ],
  };
  let clock = 1_000_000;
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(init.headers["If-None-Match"] ?? null);
    if (init.headers["If-None-Match"] === '"v1"') return new Response(null, { status: 304 });
    return new Response(JSON.stringify(catalog), { headers: { etag: '"v1"' } });
  };
  const first = createComposio({ fetch, dir }, { now: () => clock, catalogUrl: "https://catalog.example/c.json" });
  const shaped = await first.catalog();
  assert.deepEqual(shaped.toolkits.map((kit) => [kit.slug, kit.logo, kit.categories]), [["gmail", "https://logos.composio.dev/api/gmail", ["mail"]], ["github", null, ["dev"]]]);
  assert.deepEqual(shaped.categories, [{ id: "dev", name: "Developer tools", count: 1 }, { id: "mail", name: "Email", count: 1 }]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "composio-catalog.meta.json"), "utf8")), { etag: '"v1"', checkedAt: clock });

  // A new start reads the copy on disk and asks nobody while it is fresh.
  const second = createComposio({ fetch, dir }, { now: () => clock, catalogUrl: "https://catalog.example/c.json" });
  assert.equal((await second.catalog()).revision, "r1");
  assert.deepEqual(calls, [null]);

  // An hour on: the saved copy still comes at once, and the check behind it sends the ETag and gets 304.
  clock += 60 * 60 * 1000;
  assert.equal((await second.catalog()).revision, "r1");
  await second.settled();
  assert.deepEqual(calls, [null, '"v1"']);
  assert.equal(JSON.parse(readFileSync(join(dir, "composio-catalog.meta.json"), "utf8")).checkedAt, clock);

  // Asked for fresh (the Marketplace's refresh): the server is asked now, with the ETag, though the copy is new.
  assert.equal((await second.catalog({ fresh: true })).revision, "r1");
  assert.deepEqual(calls, [null, '"v1"', '"v1"']);
  const moved = createComposio({ fetch: async () => new Response(JSON.stringify({ ...catalog, revision: "r2" }), { headers: { etag: '"v2"' } }), dir }, { now: () => clock, catalogUrl: "https://catalog.example/c.json" });
  assert.equal((await moved.catalog()).revision, "r1", "the saved copy first");
  assert.equal((await moved.catalog({ fresh: true })).revision, "r2", "a fresh read brings what changed");
  const down = createComposio({ fetch: async () => new Response("nope", { status: 500 }), dir }, { now: () => clock, catalogUrl: "https://catalog.example/c.json" });
  await assert.rejects(down.catalog({ fresh: true }), { message: "The app list didn't load." }, "a fresh read that fails says so");

  // A copy on disk that is broken is not served: the list is asked for again.
  writeFileSync(join(dir, "composio-catalog.json"), "{");
  const third = createComposio({ fetch: async () => new Response("nope", { status: 500 }), dir }, { now: () => clock });
  await assert.rejects(third.catalog(), { message: "The app list didn't load." });
});

test("Composio's connection replies are read by app: structured or as text, with status-only entries kept apart", () => {
  const reply = { successful: true, data: { results: { github: { toolkit: "github", status: "initiated", redirect_url: "https://connect.composio.dev/link/ln_1", connected_account_id: "ca_named", accounts: [{ id: "ca_other", status: "INITIATED" }] } } } };
  // Valid structured output is read before the text beside it.
  const both = { structuredContent: reply, content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: {} } }) }] };
  const fromStructured = connectionResults(payloadOf(both));
  assert.deepEqual(fromStructured.github, { status: "pending", redirectUrl: "https://connect.composio.dev/link/ln_1", accountId: "ca_named", accounts: [{ id: "ca_other", status: "pending" }] });
  // Text only, as Composio sends today.
  assert.deepEqual(connectionResults(payloadOf({ content: [{ type: "text", text: JSON.stringify(reply) }] })), fromStructured);

  const results = connectionResults({
    results: [
      { toolkit: "gmail", status: "active" },
      { toolkit: "slack", status: "failed", error_message: "  The workspace refused the app. " },
      { toolkit: "notion", status: "initiated", redirect_url: "http://not-https.example/link" },
      { toolkit: "Bad Slug!", status: "active" },
      { name: "linear", accounts: [{ id: "ca_9", status: "ACTIVE" }] },
    ],
  });
  assert.deepEqual(results.gmail, { status: "active", redirectUrl: null, accounts: [] });
  assert.deepEqual(results.slack, { status: "failed", redirectUrl: null, accounts: [], error: "The workspace refused the app." });
  assert.equal(results.notion.redirectUrl, null, "only an https page is kept");
  assert.equal(results.linear.status, null, "a reply that only lists accounts names no status of its own");
  assert.deepEqual(Object.keys(results).sort(), ["gmail", "linear", "notion", "slack"]);
  assert.throws(() => payloadOf({ isError: true, content: [{ type: "text", text: JSON.stringify({ successful: false, error: "Nope" }) }] }), { message: "Nope" });
});
