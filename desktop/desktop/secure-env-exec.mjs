// Worker-thread runner for `env_exec`:
// 1. Re-verifies the approved executable's canonical path, trust constraints, and SHA-256 digest
//    immediately before spawning (fails closed if the binary was replaced after approval).
// 2. Executes the verified canonical path directly (shell: false) with secret values injected ONLY
//    into the child process environment — never in argv, never in a shell command string.
// 3. Discards child stdout/stderr at the OS level (`stdio: "ignore"`) so credential-bearing output
//    (raw, transformed, or newly exchanged tokens) never enters model context or logs.
import { spawn } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";
import { resolveTrustedExecutable } from "./trusted-executable.mjs";

const {
  resolvedPath,
  expectedSha256,
  args = [],
  cwd,
  timeoutMs = 30_000,
  secretKeys = [],
  trustedDirs = null,
} = workerData;

function wipeSecrets() {
  for (const key of secretKeys) delete process.env[key];
}

let verified;
try {
  if (typeof resolvedPath !== "string" || !resolvedPath || typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error("Missing verified executable identity.");
  }
  verified = resolveTrustedExecutable(resolvedPath, { trustedDirs });
  if (verified.resolvedPath !== resolvedPath || verified.exeSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error("Executable identity changed before execution; re-approval required.");
  }
} catch (error) {
  wipeSecrets();
  parentPort.postMessage({
    ok: false,
    exitCode: 1,
    timedOut: false,
    replaced: /identity changed/i.test(String(error?.message ?? "")),
    outputSuppressed: true,
    error: error?.message || "Executable verification failed before execution.",
  });
  process.exit(0);
}

const clampedTimeout = Math.min(Math.max(Number(timeoutMs) || 30_000, 1000), 120_000);
let finished = false;
let timedOut = false;
let settled = false;

const child = spawn(verified.resolvedPath, args, {
  cwd: cwd || undefined,
  env: process.env,
  shell: false,
  // Discard child stdout/stderr directly to /dev/null so credential-bearing output never enters
  // worker memory, host logs, or model context.
  stdio: "ignore",
  windowsHide: true,
});

const finish = (payload) => {
  if (settled) return;
  settled = true;
  finished = true;
  clearTimeout(timer);
  wipeSecrets();
  parentPort.postMessage(payload);
};

const killChild = () => {
  if (finished) return;
  try {
    child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    if (!finished) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }, 150).unref();
};

const timer = setTimeout(() => {
  timedOut = true;
  killChild();
}, clampedTimeout);
timer.unref();

child.once("error", () => {
  finish({
    ok: false,
    exitCode: 1,
    timedOut: false,
    outputSuppressed: true,
    error: "Command could not be started.",
  });
});

child.once("close", (code, signal) => {
  const exitCode = typeof code === "number" ? code : 1;
  const ok = !timedOut && !signal && exitCode === 0;
  finish({
    ok,
    exitCode,
    timedOut,
    ...(signal && { signal }),
    outputSuppressed: true,
    ...(!ok && {
      error: timedOut
        ? "Command timed out."
        : signal
          ? `Command terminated by signal ${signal}.`
          : `Command exited with code ${exitCode}.`,
    }),
  });
});

parentPort.on("message", (msg) => {
  if (msg === "abort") killChild();
});
