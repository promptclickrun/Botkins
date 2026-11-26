import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  resolveTrustedExecutable,
  validateEnvExec,
  validateHttpsHeader,
} from "../desktop/secure-input.mjs";
import { fillPageFields } from "../desktop/webviewer.mjs";
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
// ---------------------------------------------------------------------------
// 5. env_exec: verified trusted executable identity, replacement reapproval, zero output leakage
// ---------------------------------------------------------------------------

test("env_exec: binds to verified trusted executable identity, blocks PATH/untrusted/symlinks/replacement, and suppresses all child output", async (t) => {
  const dir = tmp(t);
  const trustedBin = join(dir, "trusted-bin");
  const untrustedBin = join(dir, "untrusted-bin");
  mkdirSync(trustedBin, { mode: 0o755 });
  mkdirSync(untrustedBin, { mode: 0o755 });
  chmodSync(trustedBin, 0o755);
  chmodSync(untrustedBin, 0o755);

  const receiptPath = join(dir, "receipt.json");
  const cliPath = join(trustedBin, "fake-deploy-cli");
  const cliScriptV1 = `#!${process.execPath}
const fs = require("fs");
const c = require("crypto");
const v = process.env.API_TOKEN || "";
const reversed = v.split("").reverse().join("");
const hex = Buffer.from(v, "utf8").toString("hex");
const outPath = process.argv[2];
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify({
    version: 1,
    sha: c.createHash("sha256").update(v).digest("hex"),
    argvHasSecret: process.argv.some((a) => a.includes(v)),
    leakedParentSecret: Boolean(process.env.BOTKINS_HOST_PRIVATE_CANARY),
  }));
}
// Intentionally emit raw and transformed dummy values on stdout & stderr to verify output suppression.
process.stdout.write("RAW=" + v + " REV=" + reversed + " HEX=" + hex + "\\n");
process.stderr.write("ERR_REV=" + reversed + " ERR_HEX=" + hex + "\\n");
if (process.argv.includes("--fail")) process.exit(7);
`;
  writeFileSync(cliPath, cliScriptV1, { mode: 0o755 });
  chmodSync(cliPath, 0o755);

  // Reject bare names (PATH lookup), relative paths, shells, interpreters, untrusted dirs, symlinks escaping trusted roots
  assert.throws(() => validateEnvExec({ command: "bash", args: [], envVar: "MY_SECRET" }), /absolute path|shell|interpreter/i);
  assert.throws(() => validateEnvExec({ command: "gh", args: [], envVar: "MY_SECRET" }), /absolute path/i);
  assert.throws(() => validateEnvExec({ command: "./fake-deploy-cli", args: [], envVar: "MY_SECRET" }), /absolute path/i);
  assert.throws(() => validateEnvExec({ command: "/bin/sh", args: ["-c", "env"], envVar: "MY_SECRET" }), /shell|interpreter/i);
  assert.throws(() => validateEnvExec({ command: cliPath, args: [], envVar: "MY_SECRET" }), /outside trusted executable directories/i);

  // Reject untrusted sibling dir even when trustedBin is allowed
  const untrustedCli = join(untrustedBin, "other-cli");
  writeFileSync(untrustedCli, cliScriptV1, { mode: 0o755 });
  chmodSync(untrustedCli, 0o755);
  assert.throws(
    () => validateEnvExec({ command: untrustedCli, args: [], envVar: "API_TOKEN" }, { trustedDirs: [trustedBin] }),
    /outside trusted executable directories/i,
  );

  // Reject symlink inside trustedBin that points outside trustedBin
  const escapeLink = join(trustedBin, "escape-link");
  symlinkSync(untrustedCli, escapeLink);
  assert.throws(
    () => validateEnvExec({ command: escapeLink, args: [], envVar: "API_TOKEN" }, { trustedDirs: [trustedBin] }),
    /outside trusted executable directories/i,
  );

  // Reject symlink inside trustedBin pointing to a blocked shell
  const shellLink = join(trustedBin, "innocent-name");
  symlinkSync("/bin/sh", shellLink);
  assert.throws(
    () => validateEnvExec({ command: shellLink, args: [], envVar: "API_TOKEN" }, { trustedDirs: [trustedBin] }),
    /shell|interpreter/i,
  );

  // Reject group/world-writable executable inside trustedBin
  const writableCli = join(trustedBin, "writable-cli");
  writeFileSync(writableCli, cliScriptV1, { mode: 0o777 });
  chmodSync(writableCli, 0o777);
  assert.throws(
    () => validateEnvExec({ command: writableCli, args: [], envVar: "API_TOKEN" }, { trustedDirs: [trustedBin] }),
    /writable/i,
  );

  // Reject git arbitrary-execution flags & dangerous env vars against trusted executable
  const fakeGit = join(trustedBin, "git");
  writeFileSync(fakeGit, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(fakeGit, 0o755);
  assert.throws(
    () => validateEnvExec({ command: fakeGit, args: ["-c", "core.sshCommand=id", "status"], envVar: "API_TOKEN" }, { trustedDirs: [trustedBin] }),
    /arbitrary-execution git flag/i,
  );
  assert.throws(
    () => validateEnvExec({ command: cliPath, args: [], envVar: "LD_PRELOAD" }, { trustedDirs: [trustedBin] }),
    /cannot be used/i,
  );
  assert.throws(
    () => validateEnvExec({ command: cliPath, args: [], envVar: "NODE_OPTIONS" }, { trustedDirs: [trustedBin] }),
    /cannot be used/i,
  );
  assert.throws(
    () => validateEnvExec({ command: cliPath, args: [], envVar: "PATH" }, { trustedDirs: [trustedBin] }),
    /cannot be used/i,
  );
  assert.throws(
    () => validateEnvExec({ command: cliPath, args: [], envVar: "1BAD" }, { trustedDirs: [trustedBin] }),
    /environment variable/i,
  );

  // Valid trusted executable resolves canonical path and SHA-256 digest
  const verifiedV1 = resolveTrustedExecutable(cliPath, { trustedDirs: [trustedBin] });
  const expectedFileSha = createHash("sha256").update(cliScriptV1).digest("hex");
  assert.equal(verifiedV1.exeSha256, expectedFileSha);

  // normalizeDestination requires verified executable identity (rejects bare lookup text)
  assert.throws(() => normalizeDestination("env_exec", "gh"), /verified executable identity/i);
  assert.throws(() => normalizeDestination("env_exec", { command: "gh", args: ["status"] }), /canonical absolute executable path/i);
  const d1 = normalizeDestination("env_exec", { resolvedPath: verifiedV1.resolvedPath, exeSha256: verifiedV1.exeSha256, args: ["deploy", "--env=staging"], envVar: "API_TOKEN", cwd: "/srv/a" });
  const d2 = normalizeDestination("env_exec", { resolvedPath: verifiedV1.resolvedPath, exeSha256: verifiedV1.exeSha256, args: ["deploy", "--env=prod"], envVar: "API_TOKEN", cwd: "/srv/a" });
  const d3 = normalizeDestination("env_exec", { resolvedPath: verifiedV1.resolvedPath, exeSha256: "b".repeat(64), args: ["deploy", "--env=staging"], envVar: "API_TOKEN", cwd: "/srv/a" });
  assert.notEqual(d1.key, d2.key);
  assert.notEqual(d1.key, d3.key);
  assert.match(d1.key, /@sha256:[a-f0-9]{16}:[a-f0-9]{16}$/);

  // CredentialGrants refuses unverified env_exec grants
  const grantsCheck = new CredentialGrants({ file: join(dir, "grants-check.json") });
  assert.throws(
    () => grantsCheck.set({ botId: "alfie", credentialId: "c1", destination: "exec:gh:0123456789abcdef", operation: "env_exec", level: "always" }),
    /verified executable path and SHA-256/i,
  );

  // Defense-in-depth: refuse if the dummy secret value itself appears in argv
  const dummySecret = "DUMMY_ENV_SECRET_42_XYZ";
  const dummyReversed = dummySecret.split("").reverse().join("");
  const dummyHex = Buffer.from(dummySecret, "utf8").toString("hex");
  await assert.rejects(
    () => envExec({ command: cliPath, args: ["--token", dummySecret], envVar: "API_TOKEN" }, { secret: dummySecret }, undefined, { trustedDirs: [trustedBin] }),
    /cannot be passed in command arguments/i,
  );

  // Run the CLI cleanly: secret is ONLY in child env, parent env is NOT inherited, and ALL stdout/stderr are suppressed
  const prevCanary = process.env.BOTKINS_HOST_PRIVATE_CANARY;
  process.env.BOTKINS_HOST_PRIVATE_CANARY = "DUMMY_PARENT_ENV_VALUE";
  try {
    const result = await envExec(
      { command: cliPath, args: [receiptPath], envVar: "API_TOKEN" },
      { secret: dummySecret },
      undefined,
      { trustedDirs: [trustedBin] },
    );
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputSuppressed, true);
    assert.equal(result.exeSha256, expectedFileSha);
    assert.equal("stdout" in result, false, "env_exec must never return child stdout to model context");
    assert.equal("stderr" in result, false, "env_exec must never return child stderr to model context");
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(dummySecret));
    assert.ok(!serialized.includes(dummyReversed));
    assert.ok(!serialized.includes(dummyHex));

    // Side-effect receipt confirms child received dummy secret in env only and did not inherit parent env
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.sha, createHash("sha256").update(dummySecret).digest("hex"));
    assert.equal(receipt.argvHasSecret, false);
    assert.equal(receipt.leakedParentSecret, false);

    // Non-zero exit also leaks zero stdout/stderr into thrown error
    await assert.rejects(
      () => envExec({ command: cliPath, args: [receiptPath, "--fail"], envVar: "API_TOKEN" }, { secret: dummySecret }, undefined, { trustedDirs: [trustedBin] }),
      (err) => {
        const msg = String(err?.message ?? "");
        assert.match(msg, /exited with code 7/i);
        assert.ok(!msg.includes(dummySecret));
        assert.ok(!msg.includes(dummyReversed));
        assert.ok(!msg.includes(dummyHex));
        assert.equal("stdout" in (err.execResult || {}), false);
        assert.equal("stderr" in (err.execResult || {}), false);
        return true;
      },
    );

    // Pre-exec binary replacement (TOCTOU): replace file at cliPath while supplying v1's exeSha256 -> fails closed without running!
    const receiptV2Path = join(dir, "receipt-v2.json");
    writeFileSync(cliPath, cliScriptV1.replace("version: 1", "version: 2"), { mode: 0o755 });
    chmodSync(cliPath, 0o755);
    await assert.rejects(
      () => envExec(
        { command: cliPath, resolvedPath: verifiedV1.resolvedPath, exeSha256: verifiedV1.exeSha256, args: [receiptV2Path], envVar: "API_TOKEN" },
        { secret: dummySecret },
        undefined,
        { trustedDirs: [trustedBin] },
      ),
      /identity changed|re-approval required/i,
    );
    assert.throws(() => readFileSync(receiptV2Path, "utf8"), "Replaced executable must not run under stale SHA-256");
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

  // 1b) extension_fill auto-submit fails closed (Chrome MV3 cannot enforce submit destinations at browser network boundary)
  await assert.rejects(
    () => tools.get("use_credential")({
      credentialId: credId,
      operation: "extension_fill",
      destination: "https://scissorsscotch.com/login",
      fields: [{ selector: "#password" }],
      submit: true,
    }),
    /auto-submit is disabled/i,
  );
  assert.equal(cards.length, 0, "auto-submit rejection must fail closed before prompting");
  assert.equal(fillCalls.length, 0);

  // 2) use_credential under default Ask -> raises card -> Approve -> fill-only and scrubs echoed secret
  nextCardAction = "approve";
  const res1 = JSON.parse(await tools.get("use_credential")({
    credentialId: credId,
    operation: "extension_fill",
    destination: "https://scissorsscotch.com/login",
    fields: [{ selector: "#password" }],
  }));
  assert.equal(cards.length, 1);
  assert.equal(res1.applied, true);
  assert.equal(res1.submitted, false);
  assert.equal(fillCalls.length, 1);
  assert.equal(fillCalls[0].submit, false);
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

// ---------------------------------------------------------------------------
// 9. use_credential (env_exec): standing grant pinned to SHA-256 + replacement reapproval + zero output
// ---------------------------------------------------------------------------

test("use_credential (env_exec): standing grant requires reapproval after binary replacement and suppresses output", async (t) => {
  const dir = tmp(t);
  const trustedBin = join(dir, "trusted-bin");
  mkdirSync(trustedBin, { mode: 0o755 });
  chmodSync(trustedBin, 0o755);

  const cliPath = join(trustedBin, "deploy-tool");
  const receiptPath = join(dir, "exec-receipt.json");
  const writeTool = (version) => {
    writeFileSync(
      cliPath,
      `#!${process.execPath}
const fs = require("fs");
const v = process.env.DEPLOY_TOKEN || "";
fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ version: ${version}, len: v.length }));
process.stdout.write("LEAK_V${version}=" + v + " HEX=" + Buffer.from(v).toString("hex") + "\\n");
process.stderr.write("ERR_V${version}=" + v.split("").reverse().join("") + "\\n");
`,
      { mode: 0o755 },
    );
    chmodSync(cliPath, 0o755);
  };
  writeTool(1);

  const creds = new Credentials({ dir: join(dir, "vault"), ...plainVault() });
  const grants = new CredentialGrants({ file: join(dir, "grants.json") });
  const dummyToken = "DUMMY_DEPLOY_KEY_9090";
  const credId = await creds.save({
    name: "Dummy Deploy Key",
    kind: "api-key",
    value: dummyToken,
  });

  const cards = [];
  let nextAction = "remember";
  const chat = { id: "chat-exec" };
  const bot = { id: "alfie", name: "Alfie" };
  const run = { id: "run-exec" };
  const task = { id: "task-exec", stopped: false, ended: false };
  const fakeWs = {
    closing: false,
    active: new Map([[chat.id, task]]),
    accessForTurn: () => ({ member: false }),
    peopleOf: () => ({ invited: [] }),
    interactions: {
      request: async (_chat, _task, card) => {
        cards.push(card);
        assert.ok(!JSON.stringify(card).includes(dummyToken));
        return { action: nextAction };
      },
    },
  };

  const secureInputs = new SecureInputs(fakeWs, performSecureUse, {
    credentials: () => creds,
    credentialGrants: grants,
    trustedExecDirs: [trustedBin],
  });
  const useCredential = new Map(secureInputs.tools(bot, chat, run, task).map((x) => [x.name, x.handler])).get("use_credential");

  // 1) First call -> prompts with executable path + SHA-256 -> owner clicks Remember
  const r1 = JSON.parse(await useCredential({
    credentialId: credId,
    operation: "env_exec",
    destination: cliPath,
    args: ["push"],
    envVar: "DEPLOY_TOKEN",
  }));
  assert.equal(cards.length, 1);
  assert.match(cards[0].detail, /SHA-256:/);
  assert.match(cards[0].detail, /Output: suppressed/i);
  assert.equal(r1.applied, true);
  assert.equal(r1.outputSuppressed, true);
  assert.equal("stdout" in r1, false);
  assert.equal("stderr" in r1, false);
  assert.ok(!JSON.stringify(r1).includes("LEAK_V1"));
  assert.ok(!JSON.stringify(r1).includes(dummyToken));
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).version, 1);

  // 2) Second call with unchanged binary -> standing grant executes with ZERO new approval card
  const r2 = JSON.parse(await useCredential({
    credentialId: credId,
    operation: "env_exec",
    destination: cliPath,
    args: ["push"],
    envVar: "DEPLOY_TOKEN",
  }));
  assert.equal(cards.length, 1, "Unchanged executable reuses SHA-256-bound standing grant");
  assert.equal(r2.applied, true);
  assert.equal(r2.grantLevel, "always");

  // 3) Replace binary at the SAME path -> standing grant MUST NOT apply; re-approval card raised with warning!
  writeTool(2);
  nextAction = "deny";
  const r3 = JSON.parse(await useCredential({
    credentialId: credId,
    operation: "env_exec",
    destination: cliPath,
    args: ["push"],
    envVar: "DEPLOY_TOKEN",
  }));
  assert.equal(cards.length, 2, "Replaced executable MUST require re-approval");
  assert.match(cards[1].detail, /executable changed on disk.*re-approval is required/i);
  assert.equal(r3.applied, false);
  assert.equal(r3.denied, true);
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).version, 1, "Denied replacement must NOT execute");

  // 4) Re-approving the replaced binary runs v2 and still suppresses all stdout/stderr
  nextAction = "approve";
  const r4 = JSON.parse(await useCredential({
    credentialId: credId,
    operation: "env_exec",
    destination: cliPath,
    args: ["push"],
    envVar: "DEPLOY_TOKEN",
  }));
  assert.equal(cards.length, 3);
  assert.equal(r4.applied, true);
  assert.equal(r4.outputSuppressed, true);
  assert.equal("stdout" in r4, false);
  assert.equal("stderr" in r4, false);
  assert.ok(!JSON.stringify(r4).includes("LEAK_V2"));
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).version, 2);
});

// ---------------------------------------------------------------------------
// 10. fillPageFields: auto-submit fails closed if browser-boundary enforcement is absent
// ---------------------------------------------------------------------------

test("fillPageFields: fails closed on auto-submit when CDP browser-boundary enforcement (subscribe) is unavailable", async () => {
  let cdpCalls = 0;
  await assert.rejects(
    () =>
      fillPageFields(
        async () => {
          cdpCalls++;
          return {};
        },
        {
          url: "https://example.test/login",
          origin: "https://example.test",
          fields: [{ key: "password", kind: "password" }],
          submit: {},
        },
        { password: "dummy-pw-value" },
      ),
    /browser-boundary destination enforcement is unavailable/i,
  );
  assert.equal(cdpCalls, 0, "Must fail closed before issuing any CDP command when boundary guard is absent");
});
