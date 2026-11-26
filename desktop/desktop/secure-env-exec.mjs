// Worker-thread runner for `env_exec`: executes an approved executable directly (shell: false)
// with secret values injected ONLY into the child process environment — never in argv, never in
// a shell command string — and scrubs stdout, stderr, and error text before posting back.
import { execFile } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";
import { scrub } from "./link/credentials.mjs";

const MAX_BUFFER = 256 * 1024;
const MAX_RETURN = 16_000;

const { command, args = [], cwd, timeoutMs = 30_000, secretKeys = [] } = workerData;

const secretValues = [];
for (const key of secretKeys) {
  if (typeof process.env[key] === "string" && process.env[key]) {
    secretValues.push(process.env[key]);
  }
}

const clean = (text) => {
  const str = String(text ?? "");
  const scrubbed = secretValues.length ? scrub(str, secretValues) : str;
  return scrubbed.length > MAX_RETURN ? scrubbed.slice(0, MAX_RETURN) + "\n…(truncated)" : scrubbed;
};

let finished = false;
const child = execFile(
  command,
  args,
  {
    cwd: cwd || undefined,
    env: process.env,
    shell: false,
    timeout: Math.min(Math.max(Number(timeoutMs) || 30_000, 1000), 120_000),
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  },
  (error, stdout, stderr) => {
    finished = true;
    // Wipe secrets from worker env before returning.
    for (const key of secretKeys) delete process.env[key];
    const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
    parentPort.postMessage({
      ok: !error,
      exitCode,
      stdout: clean(stdout),
      stderr: clean(stderr),
      ...(error && { error: clean(error.killed ? "Command timed out." : error.message || "Command failed.") }),
    });
  },
);

parentPort.on("message", (msg) => {
  if (msg === "abort" && !finished) {
    try {
      child.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      if (!finished) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }, 100).unref();
  }
});
