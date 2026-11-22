// A routine's script: code the owner wrote, run on this computer with no model (desktop/routines.mjs).
// It runs with the person's shell as a login shell (so their PATH and profile apply), in the bot's
// own folder, and stops after SCRIPT_TIMEOUT_MS. Its output (standard output and error together) is
// kept, cut to its last SCRIPT_OUTPUT characters.
import { spawn } from "node:child_process";

export const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
export const SCRIPT_OUTPUT = 12000;
/** The longest script a routine keeps. */
export const SCRIPT_LENGTH = 20000;

/** The program and arguments that run `script`: PowerShell on Windows, else the person's shell. */
export function shellFor(script, platform = process.platform, env = process.env) {
  if (platform === "win32") return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  return { file: env.SHELL || "/bin/sh", args: ["-l", "-c", script] };
}

/**
 * Runs a script. Resolves (never rejects) with { exitCode, signal, output, timedOut, stopped, error }.
 * `exitCode` is null when the script was killed or could not start. `stop()` on the returned
 * handle ends it early.
 */
export function runScript(script, { cwd, timeoutMs = SCRIPT_TIMEOUT_MS, env = process.env, platform = process.platform } = {}) {
  const { file, args } = shellFor(script, platform, env);
  let output = "";
  let timedOut = false;
  let stopped = false;
  const add = (chunk) => {
    output = (output + chunk).slice(-SCRIPT_OUTPUT);
  };
  const child = spawn(file, args, {
    cwd,
    env: { ...env, BOTKINS_ROUTINE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so a timeout or Stop ends what the script started too.
    detached: platform !== "win32",
    windowsHide: true,
  });
  const kill = () => {
    try {
      if (platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // It has already ended.
    }
  };
  child.stdout.setEncoding("utf8").on("data", add);
  child.stderr.setEncoding("utf8").on("data", add);
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  timer.unref?.();
  const done = new Promise((resolve) => {
    let error = "";
    child.on("error", (e) => {
      error = e.message;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal: signal ?? null, output, timedOut, stopped, ...(error && { error }) });
    });
  });
  return {
    done,
    stop() {
      stopped = true;
      kill();
    },
  };
}

/** One line about how a script ended, such as "The script finished (exit code 0)." */
export function scriptEnding(result) {
  if (result.error) return "The script could not start: " + result.error;
  if (result.stopped) return "The script was stopped.";
  if (result.timedOut) return "The script stopped after " + Math.round(SCRIPT_TIMEOUT_MS / 60000) + " minutes.";
  if (result.exitCode === null) return "The script was ended" + (result.signal ? " (" + result.signal + ")." : ".");
  return result.exitCode === 0 ? "The script finished (exit code 0)." : "The script failed (exit code " + result.exitCode + ").";
}
