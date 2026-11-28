// Only descriptions and random handles cross the provider boundary. Values belong to one
// live tool invocation's turn and have no representation in the workspace or its snapshots.
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { Worker } from "node:worker_threads";
import { defineTool } from "./providers/provider.mjs";
import { scrub } from "./link/credentials.mjs";
import { pinOrigin, parseWebUrl } from "./link/domain-match.mjs";
import { generateTotp } from "./link/totp.mjs";
import { normalizeDestination, OPERATION_LABELS } from "./credential-grants.mjs";
import { runAppFill, isAppFillEnabled } from "./secure-app-fill.mjs";
import { BLOCKED_SHELLS, resolveTrustedExecutable } from "./trusted-executable.mjs";

export { BLOCKED_SHELLS, resolveTrustedExecutable };

const ttl = 5 * 60_000;
const operations = {
  https_form: "POST these fields as a form to",
  bearer_get: "Send this value as an Authorization bearer token in a GET request to",
  https_header: "Send this value in an HTTPS request header to",
  page_fill: "Fill the named inputs on the open browser page at",
  page_fill_submit: "Fill and submit the named inputs on the open browser page at",
  native_fill: "Fill the secure field in the native desktop app",
  git_read: "Check read access to this Git repository using its HTTPS refs endpoint and a bearer token at",
};

const CREDENTIAL_OPS = [
  "page_fill",
  "page_fill_submit",
  "extension_fill",
  "https_form",
  "bearer_get",
  "https_header",
  "env_exec",
  "app_fill",
];

export const FIELD_KEY_RE = /^[A-Za-z](?:[A-Za-z0-9_-]|\.(?=[A-Za-z0-9_-])){0,127}$/;

const SUBMIT_REFUSED_MESSAGES = {
  cross_site_action: "The form was filled but not submitted: its action posts to a different site than the approved page. Submit it yourself only if you trust that destination.",
  origin_changed: "The form was filled but not submitted: the tab left the approved page before submit.",
};

const SAFE_CHILD_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
  "TMPDIR", "TEMP", "TMP",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "SYSTEMROOT",
];

export const BLOCKED_ENV_VARS = new Set([
  "PATH", "IFS", "SHELL", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP",
  "EDITOR", "VISUAL", "PAGER", "ENV", "BASH_ENV", "ZDOTDIR", "CDPATH", "GLOBIGNORE",
  "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_PATH",
  "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "PYTHONUSERBASE",
  "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "PERLLIB",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "CLASSPATH",
  "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_CONFIG_PARAMETERS",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "LD_DEBUG",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
]);

const FORBIDDEN_HTTP_HEADERS = new Set([
  "host", "content-length", "transfer-encoding", "connection", "upgrade",
  "cookie", "origin", "referer", "proxy-authorization",
]);

const text = { type: "string" };
const fieldSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "label", "kind"],
  properties: {
    key: text,
    label: text,
    kind: { enum: ["password", "code", "secret", "text"], type: "string" },
    hint: text,
    optional: { type: "boolean" },
  },
};

const submitSchema = {
  anyOf: [
    { type: "boolean" },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ref: text,
        selector: text,
        buttonText: text,
        pressEnter: { type: "boolean" },
      },
    },
  ],
};

const targetSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    browser: text,
    tabId: { type: "integer", minimum: 1 },
    pid: { type: "integer", minimum: 1 },
    window_id: text,
    element_token: text,
    app: text,
    window_title: text,
  },
};

function label(s, limit) {
  if (typeof s !== "string" || !s.trim() || s.length > limit || /[\p{Cc}\p{Cf}]/u.test(s))
    throw new Error("Use a short, single-line label.");
  return s.trim();
}

function cleanSubmit(submit) {
  if (submit === undefined || submit === null || submit === false) return null;
  if (submit === true) return {};
  if (typeof submit !== "object" || Array.isArray(submit)) throw new Error("Invalid submit configuration.");
  const out = {};
  if (submit.ref !== undefined) out.ref = label(submit.ref, 64);
  if (submit.selector !== undefined) out.selector = label(submit.selector, 200);
  if (submit.buttonText !== undefined) out.buttonText = label(submit.buttonText, 100);
  if (submit.pressEnter === true) out.pressEnter = true;
  return out;
}

function cleanLine(s, limit = 140) {
  if (typeof s !== "string") return "";
  return s.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, limit);
}
function urlOrigin(url) {
  if (typeof url !== "string" || !url) return "";
  try { return new URL(url).origin; } catch { return ""; }
}
function browserLabel(device) {
  const name = cleanLine(device?.name, 80);
  if (name) return name;
  const parts = [cleanLine(device?.browser, 40), cleanLine(device?.profile, 60)].filter(Boolean);
  return parts.join(" ") || cleanLine(device?.id, 40) || "Connected browser";
}
function pickBrowser(browsers, selector) {
  const query = cleanLine(selector, 120);
  if (!query) return null;
  const byId = browsers.find((d) => d.id === query);
  if (byId) return byId;
  const lower = query.toLowerCase();
  const exact = browsers.filter((d) => (d.name || "").toLowerCase() === lower || (d.profile || "").toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const partial = browsers.filter((d) => (d.name || "").toLowerCase().includes(lower) || (d.profile || "").toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  return null;
}
function parseTarget(target, operation) {
  if (operation === "native_fill") {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error("native_fill requires target: { pid, element_token, window_id?, app?, window_title? }.");
    }
    if (!Number.isInteger(target.pid) || target.pid < 1) {
      throw new Error("target.pid must be a positive integer for native_fill.");
    }
    const elementToken = label(target.element_token, 120);
    const out = { pid: target.pid, element_token: elementToken };
    if (target.window_id !== undefined) out.window_id = label(String(target.window_id), 120);
    if (target.app !== undefined) out.app = label(target.app, 120);
    if (target.window_title !== undefined) out.window_title = label(target.window_title, 160);
    return out;
  }
  if (target === undefined) return null;
  if (operation !== "page_fill") throw new Error("target is only supported for page_fill and native_fill.");
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("target must be an object with browser and/or tabId.");
  const out = {};
  if (target.browser !== undefined) {
    const b = label(target.browser, 120);
    out.browser = b;
  }
  if (target.tabId !== undefined) {
    if (!Number.isInteger(target.tabId) || target.tabId < 1) throw new Error("target.tabId must be a positive integer.");
    out.tabId = target.tabId;
  }
  return Object.keys(out).length ? out : null;
}

export function validateEnvExec({ command, args = [], envVar, cwd, timeoutMs, resolvedPath, exeSha256 } = {}, { trustedDirs } = {}) {
  const cmd = typeof command === "string" ? command.trim() : "";
  if (!cmd || cmd.length > 512 || /[\s\0\p{Cc}]/u.test(cmd)) {
    throw new Error("Provide a single absolute path to a trusted executable without spaces or shell operators.");
  }
  const resolved = resolveTrustedExecutable(cmd, { trustedDirs });
  if (resolvedPath && resolvedPath !== resolved.resolvedPath) {
    throw new Error("Executable canonical path does not match the approved executable.");
  }
  if (exeSha256 && String(exeSha256).toLowerCase() !== resolved.exeSha256.toLowerCase()) {
    throw new Error("Executable identity changed since approval; re-approval required.");
  }
  const reqBase = basename(cmd).toLowerCase().replace(/\.exe$/i, "");
  const realBase = basename(resolved.resolvedPath).toLowerCase().replace(/\.exe$/i, "");
  if (!Array.isArray(args) || args.length > 64) {
    throw new Error("env_exec args must be an array of up to 64 strings.");
  }
  const cleanArgs = args.map((arg) => {
    if (typeof arg !== "string" || arg.length > 4096 || arg.includes("\0")) {
      throw new Error("Each env_exec argument must be a string without null bytes.");
    }
    return arg;
  });
  if (reqBase === "git" || realBase === "git") {
    for (const arg of cleanArgs) {
      if (
        arg === "-c" ||
        arg === "--config-env" ||
        arg.startsWith("--config-env=") ||
        arg.startsWith("--upload-pack") ||
        arg.startsWith("--receive-pack") ||
        arg.startsWith("--exec-path")
      ) {
        throw new Error(`Refused to pass arbitrary-execution git flag "${arg}" in env_exec.`);
      }
    }
  }
  const envName = typeof envVar === "string" ? envVar.trim() : "";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(envName)) {
    throw new Error("Provide a valid environment variable name (letters, digits, underscores).");
  }
  const upper = envName.toUpperCase();
  if (BLOCKED_ENV_VARS.has(upper) || upper.startsWith("LD_") || upper.startsWith("DYLD_")) {
    throw new Error(`Environment variable "${envName}" cannot be used for secret injection.`);
  }
  const cleanCwd = typeof cwd === "string" && cwd.trim() ? cwd.trim() : undefined;
  if (cleanCwd && (/[\0\r\n]/.test(cleanCwd) || cleanCwd.length > 1024)) {
    throw new Error("Invalid working directory.");
  }
  const cleanTimeout = timeoutMs === undefined ? 30_000 : Math.min(Math.max(Number(timeoutMs) || 30_000, 1000), 120_000);
  return {
    command: resolved.resolvedPath,
    resolvedPath: resolved.resolvedPath,
    exeSha256: resolved.exeSha256,
    args: cleanArgs,
    envVar: envName,
    cwd: cleanCwd,
    timeoutMs: cleanTimeout,
  };
}

export function validateHttpsHeader({ header = "Authorization", prefix = "", method = "GET", body, extraHeaders } = {}) {
  const hdr = typeof header === "string" ? header.trim() : "";
  if (!/^[A-Za-z0-9-]{1,64}$/.test(hdr) || FORBIDDEN_HTTP_HEADERS.has(hdr.toLowerCase())) {
    throw new Error("Choose a valid HTTP header name for secret injection.");
  }
  const pre = typeof prefix === "string" ? prefix : "";
  if (pre.length > 64 || /[\r\n\0\p{Cc}]/u.test(pre)) {
    throw new Error("Invalid header value prefix.");
  }
  const upperMethod = String(method || "GET").trim().toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(upperMethod)) {
    throw new Error("HTTP method must be GET, POST, PUT, PATCH, or DELETE.");
  }
  let cleanBody;
  let contentType;
  if (body !== undefined && body !== null) {
    if (upperMethod === "GET") throw new Error("GET requests cannot include a request body.");
    if (typeof body === "string") {
      if (body.length > 65_536) throw new Error("Request body is too large.");
      cleanBody = body;
    } else if (typeof body === "object" && !Array.isArray(body)) {
      const json = JSON.stringify(body);
      if (json.length > 65_536) throw new Error("Request body is too large.");
      cleanBody = json;
      contentType = "application/json";
    } else {
      throw new Error("Request body must be a string or JSON object.");
    }
  }
  const cleanExtra = {};
  if (extraHeaders && typeof extraHeaders === "object" && !Array.isArray(extraHeaders)) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(k)) throw new Error("Invalid extra header name.");
      const low = k.toLowerCase();
      if (FORBIDDEN_HTTP_HEADERS.has(low) || low === hdr.toLowerCase()) continue;
      if (typeof v !== "string" || v.length > 1024 || /[\r\n\0\p{Cc}]/u.test(v)) {
        throw new Error("Invalid extra header value.");
      }
      cleanExtra[k] = v;
    }
  }
  if (contentType && !Object.keys(cleanExtra).some((k) => k.toLowerCase() === "content-type")) {
    cleanExtra["Content-Type"] = contentType;
  }
  return { header: hdr, prefix: pre, method: upperMethod, body: cleanBody, extraHeaders: cleanExtra };
}

function describe({ operation, url, title, fields, submit, header, prefix, method, body, extraHeaders }, { allowLocalHttp = false } = {}) {
  if (!Object.hasOwn(operations, operation)) throw new Error("Choose a supported secure operation.");
  let address = null;
  const checkAddress = () => {
    const localHttpOk = allowLocalHttp && address.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(address.hostname);
    if ((address.protocol !== "https:" && !localHttpOk) || address.username || address.password || address.search || address.hash || address.href.length > 2048)
      throw new Error("Use an HTTPS address without credentials, a query or a fragment.");
  };
  if (operation === "native_fill") {
    if (url !== undefined && url !== "") {
      try { address = new URL(url); } catch { throw new Error("Provide a valid HTTPS destination or omit url for native_fill."); }
      checkAddress();
    }
  } else {
    try {
      address = new URL(url);
    } catch {
      throw new Error("Provide the full HTTPS destination.");
    }
    checkAddress();
  }
  if (
    !Array.isArray(fields) ||
    !fields.length ||
    fields.length > 8 ||
    (["bearer_get", "git_read", "https_header", "native_fill"].includes(operation) && fields.length !== 1)
  )
    throw new Error("Request one token or field for this operation, or one to eight fields for a form.");
  const keys = new Set();
  const clean = fields.map((f) => {
    if (
      !f ||
      typeof f.key !== "string" ||
      !FIELD_KEY_RE.test(f.key) ||
      f.key in Object.prototype ||
      keys.has(f.key) ||
      !fieldSchema.properties.kind.enum.includes(f.kind)
    )
      throw new Error("Use distinct field keys and supported field types.");
    keys.add(f.key);
    return {
      key: f.key,
      label: label(f.label, 100),
      kind: f.kind,
      ...(f.hint && { hint: label(f.hint, 200) }),
      ...(f.optional === true && { optional: true }),
    };
  });
  const plan = {
    title: label(title, 150),
    operation,
    ...(address ? { url: address.href, origin: address.origin } : {}),
    fields: clean,
  };
  if (address?.protocol === "http:") plan.allowLocalHttp = true;
  if (operation === "page_fill_submit") {
    plan.submit = cleanSubmit(submit ?? true);
  } else if (operation === "https_header") {
    plan.http = validateHttpsHeader({ header, prefix, method, body, extraHeaders });
  }
  return plan;
}

export function secureAnswer(view, answer) {
  if (answer?.action === "cancel") return { action: "cancel" };
  const values = answer?.content;
  if (
    answer?.action !== "accept" ||
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.keys(values).some((key) => !view.fields.some((f) => f.key === key))
  )
    throw new Error("Check the secure fields and try again.");
  const entries = [];
  for (const { key, optional } of view.fields) {
    const v = Object.hasOwn(values, key) ? values[key] : undefined;
    if (optional && (v === undefined || v === "")) continue;
    if (typeof v !== "string" || !v.length || v.length > 32000 || v.includes("\0"))
      throw new Error("Fill in the required secure fields.");
    entries.push([key, v]);
  }
  return { action: "accept", content: Object.fromEntries(entries) };
}

// Run a bundled command with its own private copy of process.env. The parent process and
// OS process list never acquire the token. Only a success bit comes back from the command.
async function gitRead(url, token, signal) {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./secure-git-read.mjs", import.meta.url), {
    workerData: url,
    env: { BOTKINS_GIT_BEARER: token },
    execArgv: [],
    stdout: true,
    stderr: true,
  });
  const stop = () => {
    void worker.terminate();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const ok = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", () => resolve(false));
    });
    if (ok !== true || signal.aborted) throw new Error("Repository access failed.");
  } finally {
    signal.removeEventListener("abort", stop);
    await worker.terminate();
  }
}

/**
 * Run a verified trusted executable in a worker thread with the secret placed ONLY in the
 * child's environment (never argv, never shell). Re-verifies canonical path + SHA-256 identity
 * right before spawn, and discards child stdout/stderr (`stdio: "ignore"`) so credential-bearing
 * output never enters model context.
 */
export async function envExec(plan, values, signal = AbortSignal.timeout(30_000), { trustedDirs } = {}) {
  signal.throwIfAborted();
  const rawExec = plan.exec ?? plan;
  const effectiveTrustedDirs = trustedDirs ?? plan.trustedExecDirs ?? null;
  const { resolvedPath, exeSha256, args, envVar, cwd, timeoutMs } = validateEnvExec(rawExec, {
    trustedDirs: effectiveTrustedDirs,
  });
  const secretEntries = Object.entries(values ?? {}).filter(([, v]) => typeof v === "string" && v.length > 0);
  if (!secretEntries.length) throw new Error("No secret value provided for env_exec.");
  const secretValues = secretEntries.map(([, v]) => v);
  // Defense-in-depth: never allow a secret value to appear in argv.
  for (const arg of args) {
    for (const secret of secretValues) {
      if (secret.length >= 4 && arg.includes(secret)) {
        throw new Error("Secret values cannot be passed in command arguments.");
      }
    }
  }
  const childEnv = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    if (typeof process.env[key] === "string") childEnv[key] = process.env[key];
  }
  const secretKeys = [];
  if (secretEntries.length === 1 && envVar) {
    childEnv[envVar] = secretEntries[0][1];
    secretKeys.push(envVar);
  } else {
    for (const [k, v] of secretEntries) {
      const targetVar = k === "value" || k === "secret" || k === "token" ? envVar : k;
      validateEnvExec({ command: resolvedPath, args: [], envVar: targetVar }, { trustedDirs: effectiveTrustedDirs });
      childEnv[targetVar] = v;
      secretKeys.push(targetVar);
    }
  }

  const worker = new Worker(new URL("./secure-env-exec.mjs", import.meta.url), {
    workerData: {
      resolvedPath,
      expectedSha256: exeSha256,
      args,
      cwd,
      timeoutMs,
      secretKeys,
      trustedDirs: effectiveTrustedDirs,
    },
    env: childEnv,
    execArgv: [],
    stdout: true,
    stderr: true,
  });
  // Wipe secret references from local copy immediately.
  for (const key of secretKeys) delete childEnv[key];

  const stop = () => {
    try {
      worker.postMessage("abort");
    } catch {}
    setTimeout(() => {
      void worker.terminate();
    }, 150).unref();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const res = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) =>
        resolve({ ok: false, exitCode: code || 1, timedOut: false, outputSuppressed: true, error: "Worker exited unexpectedly." }),
      );
    });
    if (signal.aborted) throw new Error("Command cancelled.");
    const summary = {
      ok: Boolean(res?.ok),
      exitCode: Number(res?.exitCode ?? (res?.ok ? 0 : 1)),
      timedOut: Boolean(res?.timedOut),
      outputSuppressed: true,
      exeSha256,
    };
    if (!summary.ok) {
      const errMsg = String(res?.error || `Command exited with code ${summary.exitCode}.`);
      const err = new Error(errMsg);
      err.execResult = summary;
      throw err;
    }
    return summary;
  } finally {
    signal.removeEventListener("abort", stop);
    await worker.terminate();
  }
}

function wipeValues(values) {
  if (!values || typeof values !== "object") return;
  for (const key of Object.keys(values)) {
    const v = values[key];
    if (Buffer.isBuffer(v)) v.fill(0);
    values[key] = "";
    delete values[key];
  }
}

export async function performSecureUse(plan, values, adapters = {}) {
  const signal = adapters.signal ?? AbortSignal.timeout(30_000);
  const secrets = Object.values(values ?? {}).filter((v) => typeof v === "string" && v.length > 0);

  if (plan.operation === "native_fill") {
    if (!adapters.fillNative) throw new Error("Native computer use is not enabled on this computer.");
    return adapters.fillNative(plan, values, signal);
  }

  if (plan.operation === "extension_fill") {
    if (!plan.extension || !adapters.fillExtension) throw new Error("No connected browser extension tab is available for this fill.");
    return adapters.fillExtension(plan, values, signal);
  }

  if (plan.operation === "page_fill" || plan.operation === "page_fill_submit") {
    if (plan.extension && adapters.fillExtension) {
      return adapters.fillExtension(plan, values, signal);
    }
    if (plan.extension) throw new Error("The approved browser extension is no longer available.");
    if (!adapters.fillPage) throw new Error("Open the target page in a connected browser extension tab or the desktop chat's side pane first.");
    const pagePlan = plan.operation === "page_fill_submit" ? { ...plan, submit: plan.submit ?? {} } : plan;
    return adapters.fillPage(pagePlan, values);
  }

  if (plan.operation === "env_exec") {
    return envExec(plan, values, signal, { trustedDirs: adapters.trustedExecDirs ?? plan.trustedExecDirs ?? null });
  }

  if (plan.operation === "app_fill") {
    return runAppFill({
      app: plan.app ?? plan.destination,
      values,
      env: adapters.env ?? process.env,
      settings: adapters.settings ?? {},
      platform: adapters.platform ?? process.platform,
      checkPermission: adapters.checkAppFillPermission,
      adapter: adapters.appFill,
    });
  }

  if (plan.operation === "https_header") {
    const http = validateHttpsHeader(plan.http ?? plan);
    const token = Object.values(values)[0];
    if (typeof token !== "string" || !token || /[\r\n\0]/.test(token)) {
      throw new Error("Invalid header secret value.");
    }
    const headers = { ...http.extraHeaders, [http.header]: http.prefix + token };
    const response = await (adapters.fetch ?? fetch)(plan.url, {
      method: http.method,
      headers,
      ...(http.body !== undefined && { body: http.body }),
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    const rawText = await response.text().catch(() => "");
    const safeBody = scrub(rawText.slice(0, 16_000), secrets);
    if (!response.ok) {
      const err = new Error(`The destination declined the request (HTTP ${response.status}).`);
      err.status = response.status;
      err.body = safeBody;
      throw err;
    }
    return { status: response.status, ok: true, body: safeBody };
  }

  const token = Object.values(values)[0];
  if (plan.operation !== "https_form" && !/^[\x21-\x7e]+$/.test(token)) throw new Error("Invalid bearer token.");
  if (plan.operation === "git_read") return gitRead(plan.url, token, signal);
  if (!["https_form", "bearer_get"].includes(plan.operation)) throw new Error("Unknown secure operation.");
  const options =
    plan.operation === "https_form"
      ? { method: "POST", body: new URLSearchParams(values) }
      : { method: "GET", headers: { Authorization: "Bearer " + token } };
  const response = await (adapters.fetch ?? fetch)(plan.url, {
    ...options,
    signal,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("The destination declined the request.");
}

// Only allowed keys and known outcome codes cross back to the model, never values.
function extensionOutcome(outcome, keys, submitRequested) {
  const allowed = new Set(keys);
  const filled = Array.isArray(outcome?.filled) ? outcome.filled.filter((k) => typeof k === "string" && allowed.has(k)) : [];
  const missing = Array.isArray(outcome?.missing) ? outcome.missing.filter((k) => typeof k === "string" && allowed.has(k)) : [];
  const out = { applied: true, filled, missing };
  if (submitRequested) {
    out.submitted = outcome?.submitted === true;
    const reason = Object.hasOwn(SUBMIT_REFUSED_MESSAGES, outcome?.submitRefused) ? outcome.submitRefused : null;
    if (reason) {
      out.submitRefused = reason;
      out.message = SUBMIT_REFUSED_MESSAGES[reason];
    }
  }
  return out;
}

function secureRefusal(err) {
  switch (err?.secureCode) {
    case "origin_mismatch": return "Refused secure fill: the tab navigated to a different origin after approval. Nothing was filled.";
    case "password_type_mismatch": return "Refused secure fill: a password value can only be filled into a password input. Nothing was filled.";
    case "type_mismatch": return "Refused secure fill: the target input type does not match the requested field kind. Nothing was filled.";
    case "native_target_mismatch": return "Refused secure fill: the native target field is no longer a secure/password field in the approved window. Nothing was filled.";
    default: return null;
  }
}

function sanitizeCredentialHit(entry) {
  if (!entry || typeof entry !== "object") return null;
  const out = {};
  for (const key of [
    "id", "name", "kind", "source", "website", "username", "aliases",
    "hasTotp", "copied", "linked", "manager", "vaultId", "itemId", "fieldId",
  ]) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  return out;
}

export class SecureInputs {
  #grants = new Map();
  #inFlight = new Map();
  #recentSecrets = new Map(); // secret -> expiresAt (TTL 10 min) for host-side browser tool scrubbing

  constructor(
    ws,
    use,
    {
      formBrowser,
      savedLogins,
      pageUnavailable,
      credentials,
      credentialGrants,
      browserTools,
      appFill,
      allowLocalHttp = false,
      trustedExecDirs = null,
      settings,
    } = {},
  ) {
    Object.assign(this, {
      formBrowser,
      savedLogins,
      pageUnavailable,
      credentials,
      credentialGrants,
      browserTools,
      appFill,
      allowLocalHttp,
      trustedExecDirs,
      settings,
    });
    this.ws = ws;
    this.use = use ?? performSecureUse;
  }

  getCredentials() {
    return typeof this.credentials === "function" ? this.credentials() : this.credentials ?? null;
  }

  getStandingGrants() {
    return typeof this.credentialGrants === "function" ? this.credentialGrants() : this.credentialGrants ?? null;
  }

  #browserBridge() {
    return typeof this.browserTools === "function" ? this.browserTools() : this.browserTools ?? null;
  }
  async #liveBrowsers(bridge) {
    if (!bridge) return [];
    if (typeof bridge.devices === "function") {
      const list = bridge.devices() || [];
      return list.filter((d) => d && d.connected && d.enabled !== false);
    }
    if (typeof bridge.tools === "function" && bridge.tools().length > 0 && typeof bridge.call === "function") {
      try {
        const res = await bridge.call("browser_list", {});
        return (res?.browsers || []).filter((d) => d && d.connected && d.enabled !== false);
      } catch {
        return [];
      }
    }
    return [];
  }
  async #resolveExtensionTarget(plan, target, { botId, chatId }) {
    const bridge = this.#browserBridge();
    const live = await this.#liveBrowsers(bridge);
    if (!live.length) {
      if (target) {
        throw new Error("No connected Botkins Chromium extension is enabled on this host. Connect the extension and try again.");
      }
      return null;
    }
    let browsers = live;
    if (target?.browser) {
      const picked = pickBrowser(live, target.browser);
      if (!picked) {
        const available = live.map((d) => `${browserLabel(d)} (${d.id})`).join(", ");
        throw new Error(`Could not match browser "${target.browser}". Connected browsers: ${available}.`);
      }
      browsers = [picked];
    }

    const tabsByBrowser = [];
    for (const b of browsers) {
      try {
        const res = await bridge.call("browser_tabs", { browser: b.id }, { botId, chatId });
        const tabs = Array.isArray(res?.tabs) ? res.tabs : [];
        tabsByBrowser.push({ browser: b, tabs });
      } catch {
        if (target?.browser) {
          throw new Error(`Could not list tabs in browser "${browserLabel(b)}". Check that the extension is connected.`);
        }
      }
    }

    if (target?.tabId != null) {
      const hits = [];
      for (const { browser, tabs } of tabsByBrowser) {
        for (const tab of tabs) {
          if (tab.id === target.tabId) hits.push({ browser, tab });
        }
      }
      if (hits.length === 0) {
        throw new Error(`Tab ${target.tabId} is not open or not eligible in the connected browser.`);
      }
      if (hits.length > 1) {
        const choices = hits.map(({ browser }) => `${browserLabel(browser)} (${browser.id})`).join(", ");
        throw new Error(`Tab ${target.tabId} matches more than one browser (${choices}). Specify target.browser as well.`);
      }
      const { browser, tab } = hits[0];
      const tabOrigin = urlOrigin(tab.url);
      if (tabOrigin !== plan.origin) {
        throw new Error(`Tab ${tab.id} is on ${tabOrigin || "another page"}, not ${plan.origin}.`);
      }
      return {
        deviceId: browser.id,
        browserLabel: browserLabel(browser),
        tabId: tab.id,
        tabTitle: cleanLine(tab.title, 140),
        origin: plan.origin,
      };
    }

    const matches = [];
    for (const { browser, tabs } of tabsByBrowser) {
      for (const tab of tabs) {
        if (urlOrigin(tab.url) === plan.origin) matches.push({ browser, tab });
      }
    }
    if (matches.length === 1) {
      const { browser, tab } = matches[0];
      return {
        deviceId: browser.id,
        browserLabel: browserLabel(browser),
        tabId: tab.id,
        tabTitle: cleanLine(tab.title, 140),
        origin: plan.origin,
      };
    }
    if (matches.length > 1) {
      const choices = matches
        .slice(0, 6)
        .map(({ browser, tab }) => `browser: "${browserLabel(browser)}", tabId: ${tab.id}${tab.title ? ` (${cleanLine(tab.title, 60)})` : ""}`)
        .join("; ");
      throw new Error(`Multiple open browser tabs match ${plan.origin}. Pass target: { browser, tabId } to choose one: ${choices}.`);
    }
    if (target?.browser) {
      throw new Error(`No open tab on ${plan.origin} in ${browserLabel(browsers[0])}.`);
    }
    return null;
  }

  // The one browser-extension fill path: main's sealed `secure.fill` ask to an enabled, live
  // device. Values go only to the tab and origin pinned at approval time.
  #extensionFiller() {
    const bridge = this.#browserBridge();
    if (typeof bridge?.secureFill !== "function") return undefined;
    return (p, vals, signal) => {
      const fields = p.fields
        .filter((f) => Object.hasOwn(vals, f.key))
        .map((f) => ({ key: f.name || f.key, kind: f.kind, value: vals[f.key] }));
      return bridge.secureFill(p.extension.deviceId, {
        tabId: p.extension.tabId,
        origin: p.extension.origin,
        fields,
        submit: Boolean(p.submit),
        ...(p.allowLocalHttp === true && { allowLocalHttp: true }),
      }, { signal });
    };
  }

  #nativeFiller(bot) {
    if (typeof this.ws.computerUse?.secureSetValue !== "function") return undefined;
    return (p, vals, signal) => {
      const value = Object.values(vals)[0];
      return this.ws.computerUse.secureSetValue(
        { ...p.native, value },
        { botId: bot.id, botName: bot.name, signal },
      );
    };
  }

  cancel(chatId) {
    for (const grant of this.#grants.values()) if (!chatId || grant.chatId === chatId) this.#forget(grant);
    for (const [controller, id] of this.#inFlight) if (!chatId || chatId === id) controller.abort();
    if (!chatId) this.#recentSecrets.clear();
  }

  rememberSecrets(list, ttlMs = 10 * 60_000) {
    const now = Date.now();
    for (const [k, exp] of this.#recentSecrets) {
      if (exp <= now) this.#recentSecrets.delete(k);
    }
    for (const value of list ?? []) {
      if (typeof value !== "string" || value.length < 4) continue;
      this.#recentSecrets.set(value, now + ttlMs);
    }
    while (this.#recentSecrets.size > 64) {
      const oldest = this.#recentSecrets.keys().next().value;
      if (oldest === undefined) break;
      this.#recentSecrets.delete(oldest);
    }
  }

  scrubRecent(text) {
    if (typeof text !== "string" || !text || !this.#recentSecrets.size) return text;
    const now = Date.now();
    const active = [];
    for (const [secret, exp] of this.#recentSecrets) {
      if (exp <= now) this.#recentSecrets.delete(secret);
      else active.push(secret);
    }
    return active.length ? scrub(text, active) : text;
  }

  #forget(grant) {
    clearTimeout(grant.timer);
    wipeValues(grant.values);
    for (const handle of Object.values(grant.handles)) this.#grants.delete(handle);
  }

  tools(bot, chat, run, task) {
    if (!task || !run || chat.helper || run.panelId || run.scheduleId != null || run.taskId || run.workflowRunId) return [];
    const active = () => {
      if (task.stopped || task.ended || this.ws.closing || this.ws.active.get(chat.id) !== task) throw new Error("This turn has ended.");
    };
    const privateChat = () => {
      if (this.ws.accessForTurn(chat, task).member) return false;
      if (!this.ws.peopleOf) return true;
      // The split workspace relies on the link host for invites. An expired team snapshot
      // cannot establish that an owner chat is private.
      try {
        return this.ws.peopleOf(chat.id)?.invited?.length === 0;
      } catch {
        return false;
      }
    };
    const checkPrivate = () => {
      active();
      if (!privateChat()) throw new Error("Use a private owner chat for this operation.");
    };

    const request = defineTool("request_secure_input", {
      description:
        "Ask the person to pick a saved credential from the Botkins vault or enter a private value for this HTTPS destination or native desktop field; returns one-time handles for use_secure_input. For credentials already in the Botkins vault or a linked password manager, prefer find_saved_credentials + use_credential. For page_fill, targets an open tab in a connected Botkins browser extension (pass optional target: { browser, tabId }, or omit target when no screen browser is open and exactly one connected extension tab matches the origin), a screen browser opened with browser_form, or the desktop chat’s side_pane_web viewer. For native_fill, pass target: { pid, element_token, window_id?, app?, window_title? } from computer_observe (url optional) to fill one native secure/password field through the vault without exposing the secret. https_form posts keyed fields. bearer_get and git_read take one bearer token. Never request secrets in chat.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "operation", "fields"],
        properties: {
          title: text,
          operation: { type: "string", enum: Object.keys(operations) },
          url: text,
          fields: { type: "array", minItems: 1, maxItems: 8, items: fieldSchema },
          target: targetSchema,
          submit: submitSchema,
          header: text,
          prefix: text,
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          body: {},
        },
      },
      handler: async (args) => {
        active();
        const plan = describe(args, { allowLocalHttp: this.allowLocalHttp });
        const target = parseTarget(args.target, plan.operation);
        if (plan.operation === "native_fill") {
          checkPrivate();
          if (typeof this.ws.computerUse?.resolveCachedSecureTarget !== "function") {
            throw new Error("Native secure fill is unavailable on this computer.");
          }
          plan.native = this.ws.computerUse.resolveCachedSecureTarget(target);
        }
        if (plan.operation === "page_fill") {
          if (target) {
            checkPrivate();
            plan.extension = await this.#resolveExtensionTarget(plan, target, { botId: bot.id, chatId: chat.id });
            checkPrivate();
          } else {
            const screenOpen = Boolean(
              this.formBrowser &&
                (typeof this.formBrowser.hasOpenPage === "function" ? this.formBrowser.hasOpenPage(chat.id) : true),
            );
            if (screenOpen) {
              checkPrivate();
              plan.document = await this.formBrowser.bind(chat.id, plan.url);
              checkPrivate();
            } else {
              const extTarget = privateChat()
                ? await this.#resolveExtensionTarget(plan, null, { botId: bot.id, chatId: chat.id })
                : null;
              if (extTarget) {
                checkPrivate();
                plan.extension = extTarget;
              } else if (this.formBrowser) {
                checkPrivate();
                plan.document = await this.formBrowser.bind(chat.id, plan.url);
                checkPrivate();
              } else if (this.pageUnavailable) {
                throw new Error(this.pageUnavailable);
              }
            }
          }
        }
        if (plan.operation === "page_fill_submit") {
          if (this.pageUnavailable) throw new Error(this.pageUnavailable);
          if (this.formBrowser) {
            checkPrivate();
            plan.document = await this.formBrowser.bind(chat.id, plan.url);
            checkPrivate();
          }
        }
        const detail = plan.native
          ? [
              `${operations.native_fill}${cleanLine(plan.native.app, 120) ? ` (${cleanLine(plan.native.app, 120)})` : ""}`,
              ...(cleanLine(plan.native.window_title, 160) ? [`Window: ${cleanLine(plan.native.window_title, 160)}`] : []),
              `PID: ${plan.native.pid} · Element: ${plan.native.element_token}`,
              ...plan.fields.map(f => `${f.label} → ${f.key}`),
            ].join("\n")
          : plan.extension
          ? [
              `${operations.page_fill} ${plan.origin}`,
              `Browser: ${plan.extension.browserLabel}`,
              ...(plan.extension.tabTitle ? [`Tab: ${plan.extension.tabTitle}`] : []),
              `URL: ${plan.url}`,
              ...plan.fields.map(f => `${f.label} → ${f.key}`),
            ].join("\n")
          : operations[plan.operation] + " " + plan.url + "\n" + plan.fields.map((f) => f.label + " → " + f.key).join("\n");
        const answer = await this.ws.interactions.request(
          chat,
          task,
          {
            kind: "secure",
            title: plan.title,
            fields: plan.fields,
            botId: bot.id,
            detail,
          },
          ttl,
        );
        if (answer.action !== "accept")
          return JSON.stringify({ cancelled: true, message: "Request closed. Use an updated Botkins window or phone to answer a new secure request." });
        active();
        const handles = Object.fromEntries(Object.keys(answer.content).map((key) => [key, randomUUID()]));
        if (!Object.keys(handles).length) {
          return JSON.stringify({ handles });
        }
        const grant = { task, botId: bot.id, chatId: chat.id, plan, handles, values: answer.content, expires: Date.now() + ttl };
        grant.timer = setTimeout(() => this.#forget(grant), ttl).unref();
        for (const handle of Object.values(handles)) this.#grants.set(handle, grant);
        return JSON.stringify({ handles });
      },
    });

    const use = defineTool("use_secure_input", {
      description:
        "Pass the handles object from request_secure_input unchanged to apply the operation the person approved. Optional submit: true (for page_fill on a browser extension tab) submits the form after filling; a form whose action posts to a different site than the approved page is filled but not submitted, and the result says why. Consumes the handles once and returns completion only (never values).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["handles"],
        properties: {
          handles: {
            anyOf: [
              { type: "object", additionalProperties: text, minProperties: 1, maxProperties: 8 },
              { type: "array", items: text, minItems: 1, maxItems: 8 },
            ],
          },
          submit: { type: "boolean" },
        },
      },
      handler: async ({ handles, submit }) => {
        active();
        if (submit !== undefined && typeof submit !== "boolean") throw new Error("submit must be a boolean.");
        const list = Array.isArray(handles);
        const ids = handles && typeof handles === "object" ? Object.values(handles) : [];
        const grant = this.#grants.get(ids[0]);
        if (
          !grant ||
          grant.task !== task ||
          grant.botId !== bot.id ||
          grant.expires <= Date.now() ||
          ids.length !== Object.keys(grant.handles).length ||
          !Object.entries(grant.handles).every(([key, id]) => (list ? ids.includes(id) : Object.hasOwn(handles, key) && handles[key] === id))
        )
          throw new Error("These handles are incomplete, expired or unavailable for this turn.");
        if (grant.plan.document && !privateChat()) throw new Error("Open the screen browser in a private owner chat.");
        if (grant.plan.extension && !privateChat()) throw new Error("Use a private owner chat to fill a connected browser tab.");
        if (grant.plan.native && !privateChat()) throw new Error("Use a private owner chat to fill a native desktop field.");
        const values = { ...grant.values };
        const secrets = Object.values(values).filter((v) => typeof v === "string" && v.length > 0);
        if (grant.plan.operation === "page_fill" || grant.plan.operation === "page_fill_submit") {
          this.rememberSecrets(secrets);
        }
        this.#forget(grant); // Reserve before awaiting. An ambiguous network failure must never replay a submission.
        const controller = new AbortController();
        this.#inFlight.set(controller, chat.id);
        const execPlan = { ...grant.plan, chatId: chat.id, botId: bot.id, ...(submit === true && { submit: true }) };
        const fillExtension = grant.plan.extension ? this.#extensionFiller() : undefined;
        const fillNative = grant.plan.native ? this.#nativeFiller(bot) : undefined;
        try {
          const result = await this.use(execPlan, values, {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
            ...(fillExtension && { fillExtension }),
            ...(fillNative && { fillNative }),
            appFill: this.appFill,
            settings: typeof this.settings === "function" ? this.settings() : this.settings,
          });
          if (grant.plan.native) {
            return JSON.stringify({ applied: true, ...(result?.effect !== undefined && { effect: result.effect }) });
          }
          if (grant.plan.extension) {
            return JSON.stringify(extensionOutcome(result, Object.keys(grant.handles), submit === true));
          }
          if (result && typeof result === "object") {
            const safe = JSON.parse(scrub(JSON.stringify(result), secrets));
            return JSON.stringify({ applied: true, ...safe });
          }
          return JSON.stringify({ applied: true });
        } catch (err) {
          const refusal = secureRefusal(err);
          if (refusal) throw new Error(refusal);
          throw new Error("Botkins could not apply the secure input. Check the destination and request fresh input to retry.");
        } finally {
          wipeValues(values);
          this.#inFlight.delete(controller);
        }
      },
    });

    const tools = [request, use];
    const hasCredentialStore = Boolean(this.getCredentials());
    if ((this.formBrowser || this.savedLogins || hasCredentialStore) && privateChat()) {
      if (this.formBrowser) {
        tools.push(
          defineTool("browser_form", {
            description:
              "Open an HTTPS sign-in page in this chat’s host screen browser, inspect visible input names and submit buttons, or close it. Never returns field values; fill credentials with use_credential (page_fill / page_fill_submit) or request_secure_input.",
            parameters: {
              type: "object",
              required: ["action"],
              additionalProperties: false,
              properties: { action: { type: "string", enum: ["open", "inspect", "close"] }, url: text },
            },
            skipPermission: false,
            handler: async ({ action, url }) => {
              checkPrivate();
              if (action === "open" || action === "inspect") {
                const page = action === "open" ? await this.formBrowser.open(chat.id, url) : await this.formBrowser.inspect(chat.id);
                checkPrivate();
                return JSON.stringify(page);
              }
              if (action !== "close") throw new Error("Choose open, inspect or close.");
              await this.formBrowser.close(chat.id);
              return JSON.stringify({ closed: true });
            },
          }),
        );
      }

      if (this.savedLogins || hasCredentialStore) {
        tools.push(
          defineTool("find_saved_credentials", {
            description:
              "Find saved credential metadata (IDs, names, kinds, sites, and source vault) matching a site (registrable domain/aliases) or query across the Botkins vault and ready password managers (1Password, Bitwarden, Proton Pass). Never returns secret values; pass a returned id to use_credential.",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                url: text,
                query: text,
                includeManagers: { type: "boolean" },
              },
            },
            handler: async ({ url, query, includeManagers = true } = {}) => {
              checkPrivate();
              let normalizedOrigin = null;
              if (url !== undefined) {
                const parsed = parseWebUrl(url, { allowLocalHttp: this.allowLocalHttp });
                if (!parsed) throw new Error("Give the HTTPS site address.");
                normalizedOrigin = parsed.origin;
              } else if (!query || !String(query).trim()) {
                throw new Error("Provide a site url or search query.");
              }

              let entries;
              if (this.savedLogins) {
                entries = await this.savedLogins(chat.id, normalizedOrigin ?? "", {
                  url: url ?? undefined,
                  query: query ?? undefined,
                  includeManagers: includeManagers !== false,
                });
              } else {
                const store = this.getCredentials();
                entries = await store.findForSite({
                  url: url ?? undefined,
                  query: query ?? undefined,
                  includeManagers: includeManagers !== false,
                });
              }
              checkPrivate();
              return JSON.stringify((Array.isArray(entries) ? entries : []).map(sanitizeCredentialHit).filter(Boolean));
            },
          }),
        );
      }

      if (hasCredentialStore) {
        tools.push(
          defineTool("use_credential", {
            description:
              "Use a saved credential by ID for an origin-pinned browser fill (page_fill, page_fill_submit with browser-boundary origin enforcement, or extension_fill into a connected browser extension tab matched by input name; submit: true submits it, but a form whose action posts to a different site is filled and not submitted), HTTPS request (https_form, bearer_get, https_header), verified trusted-executable CLI env_exec (absolute path, output suppressed), or TOTP code without exposing values. Runs immediately under an owner standing grant; otherwise raises an owner approval card first.",
            parameters: {
              type: "object",
              additionalProperties: false,
              required: ["credentialId", "operation", "destination"],
              properties: {
                credentialId: text,
                operation: { type: "string", enum: CREDENTIAL_OPS },
                destination: text,
                fields: {
                  type: "array",
                  minItems: 1,
                  maxItems: 8,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      key: text,
                      name: text,
                      selector: text,
                      ref: text,
                      source: { type: "string", enum: ["value", "username", "totp"] },
                    },
                  },
                },
                submit: submitSchema,
                browser: text,
                tabId: { type: "number" },
                header: text,
                prefix: text,
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
                body: {},
                extraHeaders: { type: "object", additionalProperties: text },
                args: { type: "array", items: text, maxItems: 64 },
                envVar: text,
                cwd: text,
                timeoutMs: { type: "number" },
                totp: { type: "boolean" },
              },
            },
            handler: async (rawArgs) => {
              checkPrivate();
              const isOwnerPrivateChat = privateChat();
              const store = this.getCredentials();
              if (!store) throw new Error("Saved credentials are not ready yet.");
              const grants = this.getStandingGrants();

              const credentialId = String(rawArgs.credentialId ?? "").trim();
              const operation = String(rawArgs.operation ?? "").trim();
              const destination = String(rawArgs.destination ?? "").trim();
              if (!credentialId) throw new Error("Provide a credentialId from find_saved_credentials.");
              if (!CREDENTIAL_OPS.includes(operation)) throw new Error("Choose a supported credential operation.");
              if (!destination) throw new Error("Provide the pinned destination.");

              const botName = bot.name || bot.id;

              // 1. Refuse immediately when the vault is locked (clear message + audit).
              if (store.locked) {
                grants?.recordRateFailure(bot.id);
                grants?.recordAudit({
                  botId: bot.id,
                  botName,
                  credentialId,
                  destination,
                  operation,
                  outcome: "locked",
                  reason: "Vault is locked.",
                });
                throw new Error(
                  "The Botkins credential vault is locked. Unlock it in Settings › Credentials before using saved credentials.",
                );
              }

              // 2. Per-bot rate limiting.
              if (grants) {
                const limit = grants.checkRateLimit(bot.id);
                if (!limit.allowed) {
                  grants.recordAudit({
                    botId: bot.id,
                    botName,
                    credentialId,
                    destination,
                    operation,
                    outcome: "rate_limited",
                    reason: `Rate limit exceeded; retry in ${Math.ceil(limit.retryAfterMs / 1000)}s.`,
                  });
                  throw new Error(
                    `Credential use rate limit reached for this bot. Try again in ${Math.ceil(limit.retryAfterMs / 1000)} seconds.`,
                  );
                }
              }

              // 3. Look up metadata (never reading secret value yet).
              const entry = store.list().find((item) => item.id === credentialId);
              if (!entry) {
                throw new Error("Saved credential not found. Call find_saved_credentials first to find an available credentialId.");
              }

              // 4. Validate and pin destination + operation-specific parameters before prompting.
              const webOps = ["page_fill", "page_fill_submit", "extension_fill", "https_form", "bearer_get", "https_header"];
              let pinnedDest = "";
              let pinnedDestLabel = "";
              let targetUrl = "";
              let execSpec = null;
              let httpSpec = null;
              let boundDoc = null;
              let submitSpec = null;
              let extensionTarget = null;

              if (webOps.includes(operation)) {
                const parsed = parseWebUrl(destination, { allowLocalHttp: this.allowLocalHttp });
                if (!parsed) throw new Error("Provide a full HTTPS destination URL without credentials.");
                pinnedDest = pinOrigin(parsed.href, { allowLocalHttp: this.allowLocalHttp });
                pinnedDestLabel = pinnedDest;
                targetUrl = parsed.href;
                if (operation === "page_fill" || operation === "page_fill_submit") {
                  if (this.pageUnavailable) throw new Error(this.pageUnavailable);
                  if (this.formBrowser) {
                    const baseUrl = parsed.origin + parsed.pathname;
                    boundDoc = await this.formBrowser.bind(chat.id, baseUrl);
                    const boundOrigin = pinOrigin(boundDoc?.url ?? "", { allowLocalHttp: this.allowLocalHttp });
                    if (boundOrigin !== pinnedDest) {
                      grants?.recordRateFailure(bot.id);
                      grants?.recordAudit({
                        botId: bot.id,
                        botName,
                        credentialId: entry.id,
                        credentialName: entry.name,
                        source: entry.source,
                        destination: pinnedDest,
                        operation,
                        outcome: "origin_mismatch",
                        reason: `Open page origin ${boundOrigin || "unknown"} does not match ${pinnedDest}.`,
                      });
                      throw new Error("Origin mismatch: the open browser page is on a different origin.");
                    }
                  }
                  if (operation === "page_fill_submit") submitSpec = cleanSubmit(rawArgs.submit ?? true);
                } else if (operation === "extension_fill") {
                  // Same path as request_secure_input page_fill + target: resolve one live tab on the pinned origin.
                  const target = parseTarget(
                    rawArgs.browser !== undefined || rawArgs.tabId !== undefined
                      ? { ...(rawArgs.browser !== undefined && { browser: rawArgs.browser }), ...(rawArgs.tabId !== undefined && { tabId: rawArgs.tabId }) }
                      : undefined,
                    "page_fill",
                  );
                  extensionTarget = await this.#resolveExtensionTarget({ origin: pinnedDest }, target, { botId: bot.id, chatId: chat.id });
                  checkPrivate();
                  if (!extensionTarget) throw new Error(`No connected browser extension tab is open on ${pinnedDest}.`);
                  submitSpec = cleanSubmit(rawArgs.submit) ? true : null;
                } else if (operation === "https_header") {
                  httpSpec = validateHttpsHeader({
                    header: rawArgs.header,
                    prefix: rawArgs.prefix,
                    method: rawArgs.method,
                    body: rawArgs.body,
                    extraHeaders: rawArgs.extraHeaders,
                  });
                }
              } else if (operation === "env_exec") {
                execSpec = validateEnvExec(
                  {
                    command: destination,
                    args: rawArgs.args ?? [],
                    envVar: rawArgs.envVar,
                    cwd: rawArgs.cwd,
                    timeoutMs: rawArgs.timeoutMs,
                  },
                  { trustedDirs: this.trustedExecDirs },
                );
                const destNorm = normalizeDestination("env_exec", execSpec);
                pinnedDest = destNorm.key;
                pinnedDestLabel = destNorm.label;
              } else if (operation === "app_fill") {
                const settingsObj = typeof this.settings === "function" ? this.settings() : this.settings;
                if (!isAppFillEnabled({ settings: settingsObj })) {
                  throw new Error(
                    "Native app credential fill (app_fill) is experimental and disabled by default. Set BOTKINS_ENABLE_APP_FILL=1 (or enable it in Settings) to opt in.",
                  );
                }
                const destNorm = normalizeDestination("app_fill", destination);
                pinnedDest = destNorm.key;
                pinnedDestLabel = destNorm.label;
              }

              // Normalize field mappings & determine which credential parts are needed.
              const rawFields = Array.isArray(rawArgs.fields) && rawArgs.fields.length ? rawArgs.fields : null;
              const defaultSource = rawArgs.totp || entry.kind === "totp" ? "totp" : "value";
              const fieldPlan = rawFields
                ? rawFields.map((f, idx) => {
                    const key = f.key || f.name || f.selector || f.ref || `field_${idx}`;
                    const src = f.source || (rawArgs.totp ? "totp" : "value");
                    return {
                      key,
                      ...(f.name && { name: f.name }),
                      ...(f.selector && { selector: f.selector }),
                      ...(f.ref && { ref: f.ref }),
                      source: src,
                    };
                  })
                : [{ key: operation === "env_exec" ? execSpec.envVar : "value", source: defaultSource }];

              if (operation === "extension_fill" && fieldPlan.some((f) => !f.name && (f.selector || f.ref))) {
                throw new Error("Browser extension tabs match fields by input name or id; pass fields[].name instead of a selector or ref.");
              }

              const usesTotp = Boolean(rawArgs.totp) || fieldPlan.some((f) => f.source === "totp");
              const needsSecret = fieldPlan.some((f) => f.source === "value");
              const needsUsername = fieldPlan.some((f) => f.source === "username");
              if (needsUsername && !entry.username) {
                throw new Error(`Saved credential "${entry.name}" does not have a username saved.`);
              }

              // 5. Check standing grant or raise owner approval card.
              const decision = grants
                ? grants.check({
                    botId: bot.id,
                    credentialId: entry.id,
                    destination: pinnedDest,
                    operation,
                    isOwnerPrivateChat,
                  })
                : { allowed: false, level: "ask", grant: null };

              let activeGrant = decision.grant;
              let grantLevel = decision.level;

              if (decision.level === "deny") {
                grants?.recordRateFailure(bot.id);
                grants?.recordAudit({
                  botId: bot.id,
                  botName,
                  credentialId: entry.id,
                  credentialName: entry.name,
                  source: entry.source,
                  destination: pinnedDest,
                  operation,
                  outcome: "denied",
                  grantLevel: "deny",
                  reason: "Blocked by owner standing deny rule.",
                });
                throw new Error(
                  `Blocked: "${botName}" is denied from using "${entry.name}" for ${pinnedDestLabel || pinnedDest} (${operation}).`,
                );
              }

              if (!decision.allowed) {
                const opLabel = OPERATION_LABELS[operation] || operation;
                const sourceLabel =
                  entry.source === "onepassword"
                    ? "1Password"
                    : entry.source === "bitwarden"
                      ? "Bitwarden"
                      : entry.source === "protonpass"
                        ? "Proton Pass"
                        : "Botkins vault";
                const detailLines = [
                  `Bot: ${botName}`,
                  `Credential: ${entry.name} (${sourceLabel})`,
                  `Operation: ${opLabel}${usesTotp ? " + 2FA code" : ""}`,
                  `Destination: ${pinnedDestLabel || pinnedDest}`,
                ];
                if (operation === "env_exec" && execSpec) {
                  detailLines.push(`Executable: ${execSpec.resolvedPath}`);
                  detailLines.push(`SHA-256: ${execSpec.exeSha256}`);
                  detailLines.push(`Arguments: ${execSpec.args.length ? JSON.stringify(execSpec.args) : "(none)"}`);
                  detailLines.push(`Env var: ${execSpec.envVar}`);
                  if (execSpec.cwd) detailLines.push(`Working dir: ${execSpec.cwd}`);
                  detailLines.push("Output: suppressed (child stdout/stderr are not returned to the model)");
                  if (
                    grants?.hasPriorExecGrantWithDifferentHash?.({
                      botId: bot.id,
                      credentialId: entry.id,
                      resolvedPath: execSpec.resolvedPath,
                      exeSha256: execSpec.exeSha256,
                    })
                  ) {
                    detailLines.push("Warning: executable changed on disk since a previous approval — re-approval is required.");
                  }
                }
                const answer = await this.ws.interactions.request(chat, task, {
                  kind: "permission",
                  dispatch: true,
                  remember: isOwnerPrivateChat,
                  ...(operation === "env_exec" && { review: true }),
                  botId: bot.id,
                  sourceBotName: botName,
                  title: `Use "${entry.name}" on ${pinnedDestLabel || pinnedDest}`,
                  detail: detailLines.join("\n"),
                  credentialGrant: true,
                  credentialName: entry.name,
                  credentialSource: sourceLabel,
                  destination: pinnedDestLabel || pinnedDest,
                  operation: opLabel,
                });
                active();

                if (answer.action === "approve") {
                  grantLevel = "once";
                } else if (answer.action === "today") {
                  activeGrant = grants?.set({
                    botId: bot.id,
                    botName,
                    credentialId: entry.id,
                    credentialName: entry.name,
                    source: entry.source,
                    destination: pinnedDest,
                    destinationLabel: pinnedDestLabel,
                    operation,
                    level: "today",
                    isOwnerPrivateChat,
                  });
                  grantLevel = "today";
                } else if (answer.action === "remember") {
                  activeGrant = grants?.set({
                    botId: bot.id,
                    botName,
                    credentialId: entry.id,
                    credentialName: entry.name,
                    source: entry.source,
                    destination: pinnedDest,
                    destinationLabel: pinnedDestLabel,
                    operation,
                    level: "always",
                    isOwnerPrivateChat,
                  });
                  grantLevel = "always";
                } else if (answer.action === "deny_always") {
                  grants?.recordRateFailure(bot.id);
                  grants?.set({
                    botId: bot.id,
                    botName,
                    credentialId: entry.id,
                    credentialName: entry.name,
                    source: entry.source,
                    destination: pinnedDest,
                    destinationLabel: pinnedDestLabel,
                    operation,
                    level: "deny",
                    isOwnerPrivateChat,
                  });
                  grants?.recordAudit({
                    botId: bot.id,
                    botName,
                    credentialId: entry.id,
                    credentialName: entry.name,
                    source: entry.source,
                    destination: pinnedDest,
                    operation,
                    outcome: "denied",
                    grantLevel: "deny",
                    reason: "Owner chose Deny always.",
                  });
                  return JSON.stringify({ applied: false, denied: true, standingDeny: true });
                } else if (answer.action === "deny") {
                  grants?.recordRateFailure(bot.id);
                  grants?.recordAudit({
                    botId: bot.id,
                    botName,
                    credentialId: entry.id,
                    credentialName: entry.name,
                    source: entry.source,
                    destination: pinnedDest,
                    operation,
                    outcome: "denied",
                    grantLevel: "ask",
                    reason: "Owner denied request.",
                  });
                  return JSON.stringify({ applied: false, denied: true });
                } else {
                  grants?.recordRateFailure(bot.id);
                  grants?.recordAudit({
                    botId: bot.id,
                    botName,
                    credentialId: entry.id,
                    credentialName: entry.name,
                    source: entry.source,
                    destination: pinnedDest,
                    operation,
                    outcome: "cancelled",
                    grantLevel: "ask",
                  });
                  return JSON.stringify({ applied: false, cancelled: true });
                }
              }

              // 6. Only after approval/grant passes, read secrets on demand.
              const secrets = [];
              const values = {};
              const controller = new AbortController();
              this.#inFlight.set(controller, chat.id);
              try {
                let mainSecret = null;
                let totpCode = null;
                if (needsSecret) {
                  mainSecret = await store.read(entry.id);
                  if (mainSecret) secrets.push(mainSecret);
                }
                if (usesTotp) {
                  const totpResult = await store.readTotp(entry.id);
                  totpCode = typeof totpResult === "string" ? totpResult : totpResult?.code ?? null;
                  if (totpCode) secrets.push(totpCode);
                }
                for (const f of fieldPlan) {
                  if (f.source === "username") values[f.key] = entry.username;
                  else if (f.source === "totp") values[f.key] = totpCode;
                  else values[f.key] = mainSecret;
                }
                if (operation === "extension_fill" || operation === "page_fill" || operation === "page_fill_submit") {
                  this.rememberSecrets(secrets);
                }

                const plan = {
                  operation,
                  credentialKind: entry.kind,
                  url: targetUrl || undefined,
                  origin: webOps.includes(operation) ? pinnedDest : undefined,
                  destination: pinnedDest,
                  app: operation === "app_fill" ? destination : undefined,
                  fields: fieldPlan,
                  document: boundDoc ?? undefined,
                  submit: submitSpec ?? undefined,
                  http: httpSpec ?? undefined,
                  exec: execSpec ?? undefined,
                  extension: extensionTarget ?? undefined,
                  allowLocalHttp: this.allowLocalHttp,
                  chatId: chat.id,
                  botId: bot.id,
                };
                if (extensionTarget) {
                  // Main's driver matches inputs by name or id and checks each value's kind.
                  plan.fields = fieldPlan.map((f) => {
                    const kind = f.source === "username" ? "text"
                      : f.source === "totp" ? "code"
                      : entry.kind === "login" || entry.kind === "password" ? "password" : "secret";
                    return { key: f.key, ...(f.name && { name: f.name }), kind };
                  });
                }
                const fillExtension = extensionTarget ? this.#extensionFiller() : undefined;
                if (extensionTarget && !fillExtension) throw new Error("The browser extension bridge is not ready.");

                let result = await this.use(plan, values, {
                  signal: AbortSignal.any([controller.signal, AbortSignal.timeout(execSpec?.timeoutMs ?? 30_000)]),
                  ...(fillExtension && { fillExtension }),
                  appFill: this.appFill,
                  trustedExecDirs: this.trustedExecDirs,
                  settings: typeof this.settings === "function" ? this.settings() : this.settings,
                });
                if (extensionTarget) {
                  const { applied: _applied, ...outcome } = extensionOutcome(result, plan.fields.map((f) => f.name || f.key), Boolean(submitSpec));
                  result = outcome;
                }

                if (activeGrant) grants?.recordUse(activeGrant.id);
                grants?.recordAudit({
                  botId: bot.id,
                  botName,
                  credentialId: entry.id,
                  credentialName: entry.name,
                  source: entry.source,
                  destination: pinnedDest,
                  operation,
                  outcome: "allowed",
                  grantLevel,
                });

                const responsePayload = {
                  applied: true,
                  operation,
                  destination: pinnedDestLabel || pinnedDest,
                  grantLevel,
                  ...(result && typeof result === "object" ? result : {}),
                };
                return scrub(JSON.stringify(responsePayload), secrets);
              } catch (error) {
                grants?.recordRateFailure(bot.id);
                const safeErr = scrub(error?.message || "Botkins could not use the credential.", secrets);
                const isOriginErr = /origin mismatch/i.test(safeErr);
                grants?.recordAudit({
                  botId: bot.id,
                  botName,
                  credentialId: entry.id,
                  credentialName: entry.name,
                  source: entry.source,
                  destination: pinnedDest,
                  operation,
                  outcome: isOriginErr ? "origin_mismatch" : "error",
                  grantLevel,
                  reason: safeErr.slice(0, 200),
                });
                throw new Error(safeErr);
              } finally {
                wipeValues(values);
                secrets.length = 0;
                this.#inFlight.delete(controller);
              }
            },
          }),
        );
      }
    }
    return tools;
  }
}
