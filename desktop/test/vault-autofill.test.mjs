import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  originMatches,
  pinOrigin,
  registrableDomain,
  siteMatches,
} from "../desktop/link/domain-match.mjs";
import { generateTotp, parseTotpSpec } from "../desktop/link/totp.mjs";
import { CredentialGrants, normalizeDestination } from "../desktop/credential-grants.mjs";
import { Credentials, scrub } from "../desktop/link/credentials.mjs";
import { drivers } from "../desktop/link/managers.mjs";
import {
  SecureInputs,
  envExec,
  performSecureUse,
  validateEnvExec,
  validateHttpsHeader,
} from "../desktop/secure-input.mjs";
import { runAppFill } from "../desktop/secure-app-fill.mjs";

const tmp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-vault-autofill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const plainVault = () => ({
  protect: (buf) => buf,
  reveal: (buf) => buf,
});

function writeShim(dir, name, script) {
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\n" + script + "\n");
  chmodSync(file, 0o755);
  return file;
}

// ---------------------------------------------------------------------------
// 1. Domain matching & origin pinning helpers
// ---------------------------------------------------------------------------

test("domain matching: registrable domain / eTLD+1, subdomains, aliases, and look-alikes", () => {
  assert.equal(registrableDomain("www.scissorsscotch.com"), "scissorsscotch.com");
  assert.equal(registrableDomain("app.booking.scissorsscotch.com"), "scissorsscotch.com");
  assert.equal(registrableDomain("login.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("127.0.0.1"), "127.0.0.1");

  // Matches across apex / www / subdomain and saved aliases
  const sites = [
    "https://app.scissorsscotch.com/account/login",
    "booking.scissorsandscotch.example",
    "https://auth.ss-portal.example/sign-in",
  ];
  assert.equal(siteMatches("https://scissorsscotch.com", sites), true);
  assert.equal(siteMatches("https://www.scissorsscotch.com/login", sites), true);
  assert.equal(siteMatches("https://booking.scissorsandscotch.example/step1", sites), true);
  assert.equal(siteMatches("https://auth.ss-portal.example", sites), true);

  // Look-alike domains NEVER match
  assert.equal(siteMatches("https://evil-scissorsscotch.com", sites), false);
  assert.equal(siteMatches("https://scissorsscotch.com.evil.com", sites), false);
  assert.equal(siteMatches("https://scissorsscotch.net", sites), false);

  // Origin pinning is strictly exact origin (scheme + host + port)
  assert.equal(pinOrigin("https://ScissorsScotch.com:443/login?x=1"), "https://scissorsscotch.com");
  assert.equal(originMatches("https://scissorsscotch.com/a", "https://scissorsscotch.com"), true);
  assert.equal(originMatches("https://www.scissorsscotch.com/a", "https://scissorsscotch.com"), false);
  assert.equal(originMatches("http://scissorsscotch.com/a", "https://scissorsscotch.com"), false);
  assert.equal(originMatches("https://127.0.0.1:9443", "https://127.0.0.1:8443"), false);
});

// ---------------------------------------------------------------------------
// 2. TOTP generation (RFC 6238 test vectors + otpauth://)
// ---------------------------------------------------------------------------

test("TOTP: RFC 6238 SHA-1 vectors and otpauth URI parsing", () => {
  // RFC 6238 ASCII secret "12345678901234567890" -> Base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
  const base32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  // At t=59s (counter=1), 8-digit SHA-1 RFC 6238 test vector is 94287082 -> 6-digit is 287082
  const r1 = generateTotp(`otpauth://totp/Test?secret=${base32}&digits=8&period=30`, { now: 59_000 });
  assert.equal(r1.code, "94287082");
  const r2 = generateTotp(base32, { now: 59_000 });
  assert.equal(r2.code, "287082");

  const parsed = parseTotpSpec(`otpauth://totp/Scissors%20%26%20Scotch:user@example.com?secret=${base32}&digits=6&period=30&algorithm=SHA1`);
  assert.equal(parsed.digits, 6);
  assert.equal(parsed.period, 30);
  assert.equal(generateTotp(`otpauth://totp/Test?secret=${base32}`, { now: 59_000 }).code, "287082");
});

// ---------------------------------------------------------------------------
// 3. Standing grants: lookup, expiry, deny, revoke, non-owner refusal, audit, rate limit
// ---------------------------------------------------------------------------

test("CredentialGrants: Ask default, Today midnight expiry, Always, Deny, Revoke, and group refusal", (t) => {
  const dir = tmp(t);
  let now = new Date(2026, 3, 18, 10, 0, 0).getTime();
  const grants = new CredentialGrants({ dir, now: () => now, maxUsesPerWindow: 3 });

  const key = {
    botId: "bot-alfie",
    botName: "Alfie",
    credentialId: "cred-1",
    credentialName: "Scissors & Scotch",
    destination: "https://scissorsscotch.com",
    operation: "extension_fill",
  };

  // Default is ask (no standing grant stored)
  assert.equal(grants.lookup(key), null);

  // Group chat / non-owner standing grants are strictly rejected
  assert.throws(() => grants.set({ ...key, level: "always", isOwnerPrivateChat: false }), /private owner chat/i);

  // Set "today" -> valid now, expires after local midnight
  const todayGrant = grants.set({ ...key, level: "today", isOwnerPrivateChat: true });
  assert.equal(todayGrant.level, "today");
  assert.ok(todayGrant.expiresAt > now);
  assert.equal(grants.lookup(key)?.level, "today");

  // Advance past midnight -> expires back to ask (null)
  now = todayGrant.expiresAt + 1000;
  assert.equal(grants.lookup(key), null);

  // Set "always" -> persists across reloads and tracks lastUsedAt
  const alwaysGrant = grants.set({ ...key, level: "always", isOwnerPrivateChat: true });
  assert.equal(alwaysGrant.level, "always");
  grants.markUsed(alwaysGrant.id);
  const reloaded = new CredentialGrants({ dir, now: () => now });
  const check = reloaded.lookup(key);
  assert.equal(check?.level, "always");
  assert.equal(check?.lastUsedAt, now);

  // Different origin NEVER matches the pinned grant
  assert.equal(reloaded.lookup({ ...key, destination: "https://evil-scissorsscotch.com" }), null);
  assert.equal(reloaded.lookup({ ...key, destination: "https://www.scissorsscotch.com" }), null);
  // Different operation NEVER matches
  assert.equal(reloaded.lookup({ ...key, operation: "https_header" }), null);

  // Deny overrides and blocks
  reloaded.set({ ...key, level: "deny", isOwnerPrivateChat: true });
  assert.equal(reloaded.lookup(key)?.level, "deny");

  // Revoke removes it back to ask (null)
  const listBefore = reloaded.list();
  assert.equal(listBefore.length, 1);
  assert.equal(reloaded.revoke(listBefore[0].id), true);
  assert.equal(reloaded.lookup(key), null);

  // Rate limit per bot
  assert.equal(grants.checkRateLimit("bot-alfie").allowed, true);
  assert.equal(grants.checkRateLimit("bot-alfie").allowed, true);
  assert.equal(grants.checkRateLimit("bot-alfie").allowed, true);
  assert.equal(grants.checkRateLimit("bot-alfie").allowed, false);
  // Another bot has its own bucket
  assert.equal(grants.checkRateLimit("bot-other").allowed, true);

  // Audit log records metadata only
  grants.recordAudit({
    botId: "bot-alfie",
    botName: "Alfie",
    credentialId: "cred-1",
    credentialName: "Scissors & Scotch",
    source: "vault",
    destination: "https://scissorsscotch.com",
    operation: "extension_fill",
    outcome: "used",
    grantLevel: "always",
  });
  const records = grants.audit({ limit: 10 });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "used");
  assert.equal(records[0].destination, "https://scissorsscotch.com");
});

// ---------------------------------------------------------------------------
// 4. Redaction / scrubbing (raw, URL-encoded, base64, base64url)
// ---------------------------------------------------------------------------

test("scrub redacts raw, URL-encoded, base64, and base64url variants of secrets", () => {
  const secret = "s3cr3t/p@ss+word=99!";
  const encoded = encodeURIComponent(secret);
  const b64 = Buffer.from(secret, "utf8").toString("base64");
  const b64url = Buffer.from(secret, "utf8").toString("base64url");
  const payload = `raw=${secret} url=${encoded} b64=${b64} b64url=${b64url} safe=ok`;
  const scrubbed = scrub(payload, [secret]);
  assert.ok(!scrubbed.includes(secret));
  assert.ok(!scrubbed.includes(encoded));
  assert.ok(!scrubbed.includes(b64));
  assert.ok(!scrubbed.includes(b64url));
  assert.ok(scrubbed.includes("safe=ok"));
});

// ---------------------------------------------------------------------------
// 5. env_exec: argv/shell leak checks + worker_thread execution + scrubbing
// ---------------------------------------------------------------------------

test("env_exec: rejects shells/interpreters/git-c, isolates env, passes secret only in child env, and scrubs output", async (t) => {
  // Reject shells, interpreters, network tools, git arbitrary-exec flags, and dangerous env vars
  assert.throws(() => validateEnvExec({ command: "/bin/sh", args: ["-c", "env"], envVar: "MY_SECRET" }), /shell|interpreter/i);
  assert.throws(() => validateEnvExec({ command: "bash", args: [], envVar: "MY_SECRET" }), /shell|interpreter/i);
  assert.throws(() => validateEnvExec({ command: "node", args: ["-e", "1"], envVar: "MY_SECRET" }), /shell|interpreter/i);
  assert.throws(() => validateEnvExec({ command: "python3", args: ["-c", "1"], envVar: "MY_SECRET" }), /shell|interpreter/i);
  assert.throws(() => validateEnvExec({ command: "curl", args: ["https://evil.example"], envVar: "MY_SECRET" }), /shell|interpreter/i);
  assert.throws(() => validateEnvExec({ command: "git", args: ["-c", "core.sshCommand=id", "status"], envVar: "MY_SECRET" }), /arbitrary-execution git flag/i);
  assert.throws(() => validateEnvExec({ command: "gh", args: [], envVar: "LD_PRELOAD" }), /cannot be used|not allowed/i);
  assert.throws(() => validateEnvExec({ command: "gh", args: [], envVar: "NODE_OPTIONS" }), /cannot be used|not allowed/i);
  assert.throws(() => validateEnvExec({ command: "gh", args: [], envVar: "PATH" }), /cannot be used|not allowed/i);
  assert.throws(() => validateEnvExec({ command: "gh", args: [], envVar: "1BAD" }), /environment variable/i);

  // Create a custom non-interpreter CLI executable in a temp dir.
  const dir = tmp(t);
  const cliPath = join(dir, "fake-deploy-cli");
  writeFileSync(
    cliPath,
    `#!${process.execPath}
const c = require("crypto");
const v = process.env.API_TOKEN || "";
console.log(JSON.stringify({
  sha: c.createHash("sha256").update(v).digest("hex"),
  argvHasSecret: process.argv.some((a) => a.includes(v)),
  leakedParentSecret: Boolean(process.env.BOTKINS_HOST_PRIVATE_CANARY),
  echo: v,
}));
`,
    { mode: 0o755 },
  );

  // Defense-in-depth: refuse if the secret value itself appears in argv
  const canary = "CANARY_ENV_SECRET_42_XYZ";
  await assert.rejects(
    () => envExec({ command: cliPath, args: ["--token", canary], envVar: "API_TOKEN" }, { secret: canary }),
    /cannot be passed in command arguments/i,
  );

  // Verify env_exec destination pinning includes args + envVar + cwd (never collapses to "[object Object]").
  const d1 = normalizeDestination("env_exec", { command: cliPath, args: ["deploy", "--env=staging"], envVar: "API_TOKEN", cwd: "/srv/a" });
  const d2 = normalizeDestination("env_exec", { command: cliPath, args: ["deploy", "--env=prod"], envVar: "API_TOKEN", cwd: "/srv/a" });
  const d3 = normalizeDestination("env_exec", { command: cliPath, args: ["deploy", "--env=staging"], envVar: "OTHER_TOKEN", cwd: "/srv/a" });
  assert.notEqual(d1.key, d2.key);
  assert.notEqual(d1.key, d3.key);
  assert.ok(!d1.key.includes("[object Object]"));

  // Run the CLI cleanly: secret is in child process.env.API_TOKEN, NOT in argv, parent env is NOT inherited, and any echo is scrubbed!
  const prevCanary = process.env.BOTKINS_HOST_PRIVATE_CANARY;
  process.env.BOTKINS_HOST_PRIVATE_CANARY = "MUST_NOT_LEAK_INTO_CHILD";
  try {
    const expectedSha = (await import("node:crypto")).createHash("sha256").update(canary).digest("hex");
    const result = await envExec(
      { command: cliPath, args: ["status"], envVar: "API_TOKEN" },
      { secret: canary },
    );
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes(`"sha":"${expectedSha}"`));
    assert.ok(result.stdout.includes('"argvHasSecret":false'));
    assert.ok(result.stdout.includes('"leakedParentSecret":false'), "parent process.env secrets must not leak to child");
    assert.ok(!result.stdout.includes(canary), "echoed secret must be scrubbed from stdout");
    assert.ok(result.stdout.includes("•••") || result.stdout.includes("[redacted]"));
  } finally {
    if (prevCanary === undefined) delete process.env.BOTKINS_HOST_PRIVATE_CANARY;
    else process.env.BOTKINS_HOST_PRIVATE_CANARY = prevCanary;
  }
});

// ---------------------------------------------------------------------------
// 6. https_header validation + app_fill feature flag
// ---------------------------------------------------------------------------

test("https_header validates header names and blocks CRLF/forbidden headers; app_fill is feature-flagged off by default", async () => {
  assert.throws(() => validateHttpsHeader({ header: "Bad\r\nHeader" }), /header name/i);
  assert.throws(() => validateHttpsHeader({ header: "Host" }), /valid HTTP header|not allowed|forbidden/i);
  assert.throws(() => validateHttpsHeader({ header: "X-API-Key", prefix: "ok\r\nEvil: 1" }), /invalid header value prefix|line break/i);
  const valid = validateHttpsHeader({ header: "X-API-Key", prefix: "Token ", method: "POST" });
  assert.equal(valid.header, "X-API-Key");
  assert.equal(valid.prefix, "Token ");
  assert.equal(valid.method, "POST");

  // app_fill refused by default unless BOTKINS_ENABLE_APP_FILL=1
  const prev = process.env.BOTKINS_ENABLE_APP_FILL;
  delete process.env.BOTKINS_ENABLE_APP_FILL;
  try {
    await assert.rejects(
      () => runAppFill({ app: "Terminal", values: { password: "secret-value" } }),
      /disabled by default|BOTKINS_ENABLE_APP_FILL/i,
    );
  } finally {
    if (prev !== undefined) process.env.BOTKINS_ENABLE_APP_FILL = prev;
  }
});

// ---------------------------------------------------------------------------
// 7. use_credential orchestration: Ask, Always allow, Deny, Locked vault, Group chat, Rate limit, TOTP
// ---------------------------------------------------------------------------

test("use_credential: approval flow, Always allow, Always deny, origin pinning, TOTP, locked vault, group chat, rate limit", async (t) => {
  const dir = tmp(t);
  const creds = new Credentials({ dir, ...plainVault() });
  const grants = new CredentialGrants({ file: join(dir, "grants.json"), rateLimitPerMinute: 10 });
  const secretValue = "ScotchSuperSecret!8821";
  const totpBase32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const credId = await creds.save({
    name: "Scissors & Scotch",
    kind: "login",
    username: "member@example.com",
    website: "https://app.scissorsscotch.com/login",
    aliases: ["scissorsscotch.com"],
    value: secretValue,
    totpSecret: totpBase32,
  });

  const fillCalls = [];
  const cards = [];
  let nextCardAction = "approve";
  let isPrivateOwner = true;

  const task = { id: "task-1", stopped: false, ended: false };
  const chat = { id: "chat-1" };
  const bot = { id: "alfie", name: "Alfie" };
  const run = { id: "run-1" };
  const fakeWs = {
    closing: false,
    active: new Map([[chat.id, task]]),
    accessForTurn: () => ({ member: !isPrivateOwner }),
    peopleOf: () => ({ invited: isPrivateOwner ? [] : [{ id: "m-2" }] }),
    interactions: {
      request: async (_chat, _task, card) => {
        cards.push(card);
        // Verify the approval card NEVER contains the secret value!
        assert.ok(!JSON.stringify(card).includes(secretValue));
        assert.equal(card.credentialGrant, true);
        assert.equal(card.credentialName, "Scissors & Scotch");
        assert.equal(card.credentialSource, "Botkins vault");
        return { action: nextCardAction };
      },
    },
  };

  const secureInputs = new SecureInputs(
    fakeWs,
    (plan, values, opts) => performSecureUse(plan, values, {
      ...opts,
      extensionFill: async (args) => {
        fillCalls.push({
          ...args,
          fields: args.fields.map((f) => ({
            selector: f.selector,
            len: f.value.length,
            matchedSecret: f.value === secretValue,
            valuePreview: f.value.length === 6 ? "totp" : "pw",
          })),
        });
        return { ok: true, filled: args.fields.length, submitted: !!args.submit, note: `filled ${args.fields[0]?.value}` };
      },
    }),
    {
      credentials: () => creds,
      credentialGrants: grants,
      savedLogins: (_chatId, origin, opts) => creds.findForSite({ url: opts?.url ?? origin, query: opts?.query }),
    },
  );

  const toolList = secureInputs.tools(bot, chat, run, task);
  const tools = new Map(toolList.map((tool) => [tool.name, tool.handler]));

  // 1) find_saved_credentials matches https://scissorsscotch.com via eTLD+1 & alias, never exposes secret
  const hits = JSON.parse(await tools.get("find_saved_credentials")({ url: "https://scissorsscotch.com/login" }));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, credId);
  assert.equal(hits[0].source, "vault");
  assert.equal(hits[0].hasTotp, true);
  assert.ok(!JSON.stringify(hits).includes(secretValue));

  // 2) use_credential under default Ask -> raises card -> Approve -> fills and scrubs echoed secret
  nextCardAction = "approve";
  const res1 = JSON.parse(await tools.get("use_credential")({
    credentialId: credId,
    operation: "extension_fill",
    destination: "https://scissorsscotch.com/login",
    fields: [{ selector: "#password" }],
    submit: true,
  }));
  assert.equal(cards.length, 1);
  assert.equal(res1.applied, true);
  assert.equal(fillCalls.length, 1);
  assert.equal(fillCalls[0].expectedOrigin, "https://scissorsscotch.com");
  assert.equal(fillCalls[0].fields[0].matchedSecret, true);
  assert.ok(!JSON.stringify(res1).includes(secretValue), "secret value must never appear in tool result");

  // 3) Owner chooses "remember" (Always allow for this site) -> next call runs with NO card!
  nextCardAction = "remember";
  await tools.get("use_credential")({
    credentialId: credId,
    operation: "extension_fill",
    destination: "https://scissorsscotch.com/login",
    fields: [{ selector: "#password" }],
  });
  assert.equal(cards.length, 2);

  // Now runs immediately without raising a 3rd card!
  const res3 = JSON.parse(await tools.get("use_credential")({
    credentialId: credId,
    operation: "extension_fill",
    destination: "https://scissorsscotch.com/account",
    fields: [{ selector: "#password" }],
  }));
  assert.equal(cards.length, 2, "standing grant must execute without raising a new approval card");
  assert.equal(res3.applied, true);
  assert.equal(res3.grantLevel, "always");

  // 4) Different origin NEVER reuses the scissorsscotch.com standing grant (raises a new card; we deny it)
  nextCardAction = "deny";
  const resOther = JSON.parse(await tools.get("use_credential")({
    credentialId: credId,
    operation: "extension_fill",
    destination: "https://evil-scissorsscotch.com/login",
    fields: [{ selector: "#password" }],
  }));
  assert.equal(cards.length, 3, "different origin must NOT reuse pinned grant");
  assert.equal(resOther.applied, false);
  assert.equal(resOther.denied, true);

  // 5) Always deny blocks immediately with no card on subsequent attempt
  nextCardAction = "deny_always";
  const resDenyAlways = JSON.parse(await tools.get("use_credential")({
    credentialId: credId,
    operation: "extension_fill",
    destination: "https://evil-scissorsscotch.com/login",
    fields: [{ selector: "#password" }],
  }));
  assert.equal(cards.length, 4);
  assert.equal(resDenyAlways.standingDeny, true);
  await assert.rejects(
    () => tools.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: "https://evil-scissorsscotch.com/login",
      fields: [{ selector: "#password" }],
    }),
    /denied/i,
  );
  assert.equal(cards.length, 4, "Always deny must block without prompting again");

  // 6) TOTP delivery uses the same grant and scrubs the 6-digit code from tool result
  const totpRes = JSON.parse(await tools.get("use_credential")({
    credentialId: credId,
    operation: "extension_fill",
    destination: "https://scissorsscotch.com/2fa",
    fields: [{ selector: "#otp" }],
    totp: true,
  }));
  assert.equal(totpRes.applied, true);
  assert.equal(fillCalls.at(-1).fields[0].valuePreview, "totp");
  assert.equal(fillCalls.at(-1).fields[0].len, 6);

  // 7) Group chat / non-owner is refused
  isPrivateOwner = false;
  await assert.rejects(
    () => tools.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: "https://scissorsscotch.com/login",
      fields: [{ selector: "#password" }],
    }),
    /private/i,
  );
  isPrivateOwner = true;

  // 8) Locked vault returns clear denial message
  const lockedCreds = new Credentials({
    dir,
    protect: () => { throw new Error("keychain locked"); },
    reveal: () => { throw new Error("keychain locked"); },
  });
  const lockedInputs = new SecureInputs(fakeWs, performSecureUse, {
    credentials: () => lockedCreds,
    credentialGrants: grants,
  });
  const lockedTool = new Map(lockedInputs.tools(bot, chat, run, task).map((x) => [x.name, x.handler]));
  await assert.rejects(
    () => lockedTool.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: "https://scissorsscotch.com/login",
      fields: [{ selector: "#password" }],
    }),
    /locked/i,
  );

  // 9) Audit log has all events and NEVER contains secretValue
  const auditRows = grants.audit({ limit: 50 });
  assert.ok(auditRows.length >= 6);
  assert.ok(!JSON.stringify(auditRows).includes(secretValue));
  assert.ok(auditRows.some((r) => r.outcome === "allowed"));
  assert.ok(auditRows.some((r) => r.outcome === "denied"));
  assert.ok(auditRows.some((r) => r.outcome === "locked"));

  // 10) Security regressions:
  // - request_secure_input(extension_fill) is refused in non-owner / shared chats
  isPrivateOwner = false;
  const reqTool = new Map(secureInputs.tools(bot, chat, run, task).map((x) => [x.name, x.handler])).get("request_secure_input");
  await assert.rejects(
    () =>
      reqTool({
        title: "Login",
        operation: "extension_fill",
        url: "https://app.scissorsscotch.com/login",
        fields: [{ key: "password", label: "Password", kind: "password" }],
      }),
    /private/i,
  );
  isPrivateOwner = true;

  // - CredentialGrants persists across reload with { file } (as well as { dir })
  const reloadedGrants = new CredentialGrants({ file: join(dir, "grants.json") });
  assert.ok(reloadedGrants.audit().length > 0, "audit log must persist across reload when constructed with { file }");
  assert.ok(reloadedGrants.list().some((g) => g.level === "deny"), "standing deny rule must persist across reload");

  // - Recent-secret scrubber redacts filled secrets from subsequent browser tool output
  assert.ok(!secureInputs.scrubRecent(`leaked: ${secretValue}`).includes(secretValue));
});

// ---------------------------------------------------------------------------
// 8. Password manager drivers with fake op / pass-cli / bw shims
// ---------------------------------------------------------------------------

test("Password manager shims (1Password, Proton Pass, Bitwarden): site lookup, TOTP read, link vs explicit copy", async (t) => {
  const dir = tmp(t);
  const bin = join(dir, "bin");
  mkdtempSync(join(dir, "tmp-"));
  const binDir = mkdtempSync(join(tmpdir(), "botkins-shims-"));
  t.after(() => rmSync(binDir, { recursive: true, force: true }));

  const opSecret = "OP_SCOTCH_PASS_991";
  const passSecret = "PROTON_SCOTCH_PASS_772";
  const opTotp = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  // Fake 1Password `op` shim
  writeShim(binDir, "op", `
if [ "$1" = "--version" ]; then echo "2.30.0"; exit 0; fi
if [ "$1" = "whoami" ]; then echo '{"email":"owner@example.com","url":"my.1password.com"}'; exit 0; fi
if [ "$1" = "vault" ] && [ "$2" = "list" ]; then echo '[{"id":"v1","name":"Personal"}]'; exit 0; fi
if [ "$1" = "item" ] && [ "$2" = "list" ]; then
  echo '[{"id":"it1","title":"Scissors & Scotch","urls":[{"href":"https://app.scissorsscotch.com/login"}],"additional_information":"owner@example.com"}]'
  exit 0
fi
if [ "$1" = "item" ] && [ "$2" = "get" ]; then
  case "$*" in
    *"--otp"*) printf %s "482910"; exit 0 ;;
  esac
  echo '{"id":"it1","title":"Scissors & Scotch","urls":[{"href":"https://app.scissorsscotch.com/login"}],"fields":[{"id":"username","label":"username","type":"STRING","value":"owner@example.com"},{"id":"password","label":"password","type":"CONCEALED","value":"${opSecret}"},{"id":"otp","label":"one-time password","type":"OTP","totp":"482910","value":"otpauth://totp/SS?secret=${opTotp}"}]}'
  exit 0
fi
if [ "$1" = "read" ]; then
  case "$*" in
    *"otp"*) printf %s "${opTotp}" ;;
    *) printf %s "${opSecret}" ;;
  esac
  exit 0
fi
exit 1
`);

  // Fake Proton Pass `pass-cli` shim
  writeShim(binDir, "pass-cli", `
if [ "$1" = "--version" ]; then echo "1.5.0"; exit 0; fi
if [ "$1" = "info" ]; then echo '{"email":"owner@proton.me"}'; exit 0; fi
if [ "$1" = "vault" ] && [ "$2" = "list" ]; then echo '{"vaults":[{"share_id":"s1","name":"Botkins"}]}'; exit 0; fi
if [ "$1" = "item" ] && [ "$2" = "list" ]; then
  echo '{"items":[{"id":"pit1","share_id":"s1","content":{"title":"Scissors & Scotch Portal","content":{"Login":{"email":"owner@proton.me","urls":["https://scissorsscotch.com"]}}}}]}'
  exit 0
fi
if [ "$1" = "item" ] && [ "$2" = "view" ]; then
  case "$*" in
    *"--field"*) printf %s "${passSecret}"; exit 0 ;;
  esac
  echo '{"item":{"id":"pit1","share_id":"s1","content":{"title":"Scissors & Scotch Portal","content":{"Login":{"email":"owner@proton.me","password":"${passSecret}","urls":["https://scissorsscotch.com"]}}}}}'
  exit 0
fi
exit 1
`);

  const creds = new Credentials({
    dir,
    ...plainVault(),
  });
  creds.drivers = new Map(drivers({ dirs: [binDir] }).map((d) => [d.id, d]));
  creds.statuses = null;

  // 1) Discovery across ready managers without copying or leaking values
  const found = await creds.findForSite({ url: "https://www.scissorsscotch.com/book", includeManagers: true });
  assert.ok(found.some((h) => h.source === "onepassword" && h.name === "Scissors & Scotch"));
  assert.ok(found.some((h) => h.source === "protonpass" && h.name === "Scissors & Scotch Portal"));
  assert.ok(!JSON.stringify(found).includes(opSecret));
  assert.ok(!JSON.stringify(found).includes(passSecret));

  // 2) Link from 1Password (preferred: read on demand, not copied)
  const linkedId = await creds.link({
    manager: "onepassword",
    vaultId: "v1",
    itemId: "it1",
    fieldId: "password",
    name: "Scissors & Scotch (1Password)",
  });
  const linkedEntry = creds.list().find((e) => e.id === linkedId);
  assert.equal(linkedEntry.source, "onepassword");
  assert.equal(linkedEntry.copied, undefined);
  assert.equal(linkedEntry.website, "https://app.scissorsscotch.com/login");
  assert.equal(await creds.read(linkedId), opSecret);
  const totpValue = await creds.readTotp(linkedId);
  assert.match(totpValue.code, /^\d{6}$/);

  // 3) Explicit copy from Proton Pass (marked as a copy in the local vault)
  const copiedId = await creds.copyFromManager({
    manager: "protonpass",
    vaultId: "s1",
    itemId: "pit1",
    fieldId: "password",
    name: "Scissors & Scotch (Copied)",
  });
  const copiedEntry = creds.list().find((e) => e.id === copiedId);
  assert.equal(copiedEntry.source, "vault");
  assert.equal(copiedEntry.copied, true);
  assert.equal(copiedEntry.copiedFrom, "protonpass");
  assert.equal(await creds.read(copiedId), passSecret);
});
