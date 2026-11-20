// Botkins-owned stdio boundary for a plugin-local MCP. The Copilot runtime may give this
// launcher the host process environment; only the reviewed host startup keys and the reviewed
// plugin env keys are forwarded to the untrusted MCP child.
import { spawn } from "node:child_process";

const HOST_ENV_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SYSTEMDRIVE",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROGRAMDATA",
]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const sameName = (left, right) => left.toLowerCase() === right.toLowerCase();
const valueFor = (name) => {
  if (typeof process.env[name] === "string") return process.env[name];
  const actual = Object.keys(process.env).find((key) => sameName(key, name));
  return actual === undefined ? undefined : process.env[actual];
};

let spec;
try {
  const encoded = process.argv[2];
  if (!encoded) throw new Error("missing launcher spec");
  spec = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
} catch {
  process.exit(64);
}

if (
  !spec ||
  typeof spec.command !== "string" ||
  !spec.command ||
  spec.command.includes("\0") ||
  !Array.isArray(spec.args) ||
  spec.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
  !Array.isArray(spec.envKeys) ||
  spec.envKeys.some((key) => typeof key !== "string" || !ENV_NAME.test(key))
) process.exit(64);

const environment = {};
for (const key of HOST_ENV_KEYS) {
  const value = valueFor(key);
  if (value !== undefined) environment[key] = value;
}
for (const key of spec.envKeys) {
  if (HOST_ENV_KEYS.has(key.toUpperCase())) continue;
  const value = valueFor(key);
  if (value !== undefined) environment[key] = value;
}

let child;
try {
  child = spawn(spec.command, spec.args, {
    cwd: process.cwd(),
    env: environment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch {
  process.exit(1);
}

process.stdin.on("error", () => {});
child.stdin.on("error", () => {});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
// Do not forward plugin stderr into the runtime log: it may contain a configured credential.
child.stderr.resume();

let stopping = false;
const stop = (signal) => {
  if (stopping || child.exitCode !== null || child.killed) return;
  stopping = true;
  try { child.kill(signal); } catch {}
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, () => stop(signal));
child.once("error", () => {
  stopping = true;
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  stopping = true;
  process.stdin.unpipe(child.stdin);
  process.stdin.destroy();
  process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
});
process.once("exit", () => stop("SIGTERM"));
