// Runs the window's smokes (test/*-smoke.mjs), each in a process of its own, and says in one line
// how each ended. It goes on after a failure and ends with 0 only when every smoke that ran passed.
//
//   node test/run-smokes.mjs                  all of them
//   node test/run-smokes.mjs plugins spaces   only these (names without "-smoke.mjs")
//   node test/run-smokes.mjs --part=2/3       the second of three parts, to run parts side by side
//   node test/run-smokes.mjs --list           the names, and what is left out where
//   node test/run-smokes.mjs --live controls  as this computer is signed in, for a smoke that runs real model turns
//
// Before it: `npm ci` and `npm run build` in desktop/ (a smoke starts the built window with Electron).
// Options: --logs=<folder> keeps each smoke's whole output there (else a folder in the system's
// temporary place, named at the end when something failed); --minutes=<n> is the time limit for
// one smoke (5). A smoke gets no sign-in, no keychain and no real model turn: the switches for
// those are taken out of its environment here, and the app under it runs signed out
// (BOTKINS_SIGNED_OUT=1), also on a computer whose owner is signed in.
//
// Each smoke keeps its files in a temporary folder of its own (the app's data folder and Electron's
// own files are both there). One exception: teams-smoke makes desktop/.teams-smoke-<pid> and
// removes it. Pictures are written only when a smoke's own *_SHOTS or BOTKINS_QA_DIR is set.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");

/**
 * Smokes that are not run in some place, each with the reason. `where` is "signed-out" (the smoke
 * runs real model turns, so it runs only with --live, by hand), "ci" (a runner: the environment
 * has CI set), or a platform ("linux", "win32", "darwin"). A smoke is left out only with a line
 * that says so; nothing is left out without a word.
 */
export const LEFT_OUT = [
  // { name: "phone", where: "linux", why: "it looks for the computer with macOS's own Bonjour tool" },
  { name: "approvals", where: "signed-out", why: "it sends a message to a bot and waits for the real model to call a tool, which needs a signed-in account and uses it" },
  { name: "controls", where: "signed-out", why: "it picks a real Copilot model and runs real turns on it for the /usage checks, which needs a signed-in account and uses it" },
];

/**
 * Smokes that can fail by chance, each with the reason. Such a smoke gets one more try, and its
 * line says that it needed one.
 */
export const BY_CHANCE = {
  agents: "it asks a random look to differ from the one before, and a random pick can be the same",
};

/** Switches that would make a smoke sign in, use a keychain or run a real model turn. */
const NOT_FOR_A_SMOKE = ["BOTKINS_KEYCHAIN", "BOTKINS_COPILOT_SIGNIN", "BOTKINS_COPILOT_RUNTIME", "BOTKINS_LIVE", "COMMANDER_LIVE"];

export const allSmokes = () =>
  readdirSync(here)
    .filter((file) => file.endsWith("-smoke.mjs"))
    .map((file) => file.slice(0, -"-smoke.mjs".length))
    .sort();

/** Why a smoke is left out here, or nothing. */
export function leftOut(name, { ci = !!process.env.CI, platform = process.platform, live = false } = {}, list = LEFT_OUT) {
  return list.find((one) => one.name === name && (one.where === "signed-out" ? !live : one.where === "ci" ? ci : one.where === platform))?.why;
}

/** Part `index` of `count` (1-based), by turns, so each part gets long and short smokes alike. */
export const partOf = (names, index, count) => names.filter((_, at) => at % count === index - 1);

/**
 * Where a smoke failed, from its output: the first error's own sentence, and the line of the
 * smoke's file that it came from. "it ended with code 1" when the output names neither.
 */
export function failedStep(name, output, code) {
  const lines = String(output).split("\n");
  const said = lines.find((line) => /^(\w*Error(?: \[[A-Z_]+\])?|ExpectError|Timed out|page\.\w+|locator\.\w+|expect\()[:( ]/.test(line.trim()))?.trim();
  const at = lines.map((line) => line.match(new RegExp(name + "-smoke\\.mjs:(\\d+)"))).find(Boolean);
  const where = at ? name + "-smoke.mjs:" + at[1] : "";
  const sentence = said ? said.replace(/\s+/g, " ").slice(0, 200) : "";
  return [where, sentence].filter(Boolean).join(": ") || "it ended with code " + code;
}

/** Runs one smoke. Answers { outcome: "pass" | "fail" | "time", seconds, output, step? }. */
function runOne(name, env, limitMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    // Its own process group, so a smoke that runs out of time takes its copy of the app with it.
    const child = spawn(process.execPath, [join("test", name + "-smoke.mjs")], { cwd: desktop, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let output = "";
    let late = false;
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    const stop = (signal) => {
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        // It ended by itself in that moment.
      }
    };
    const timer = setTimeout(() => {
      late = true;
      stop("SIGTERM");
      setTimeout(() => stop("SIGKILL"), 5000).unref();
    }, limitMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const seconds = Math.round((Date.now() - started) / 1000);
      if (late) resolve({ outcome: "time", seconds, output });
      else if (code === 0) resolve({ outcome: "pass", seconds, output });
      else resolve({ outcome: "fail", seconds, output, step: failedStep(name, output, code) });
    });
  });
}

async function main(argv) {
  const options = Object.fromEntries(argv.filter((arg) => arg.startsWith("--")).map((arg) => arg.slice(2).split("=")).map(([key, value = "1"]) => [key, value]));
  const asked = argv.filter((arg) => !arg.startsWith("--"));
  const every = allSmokes();
  const unknown = asked.filter((name) => !every.includes(name));
  if (unknown.length) {
    console.error("No such smoke: " + unknown.join(", ") + ". The names: " + every.join(" "));
    return 2;
  }
  let names = asked.length ? asked : every;
  if (options.part) {
    const [index, count] = options.part.split("/").map(Number);
    if (!(Number.isInteger(index) && Number.isInteger(count) && index >= 1 && index <= count)) {
      console.error("--part is written as 2/3: the second of three parts.");
      return 2;
    }
    names = partOf(names, index, count);
  }
  if (options.list) {
    for (const name of names) console.log(name + (leftOut(name) ? "   left out here: " + leftOut(name) : "") + (BY_CHANCE[name] ? "   one more try: " + BY_CHANCE[name] : ""));
    console.log("\nWith --live, the smokes that are left out for running real model turns run too, signed in as this computer is.");
    return 0;
  }
  const live = options.live === "1";
  const minutes = Number(options.minutes ?? 5);
  const logs = options.logs ?? mkdtempSync(join(tmpdir(), "botkins-smokes-"));
  mkdirSync(logs, { recursive: true });
  const env = { ...process.env };
  for (const key of NOT_FOR_A_SMOKE) delete env[key];
  // Signed out, whatever this computer is signed in to: a smoke never uses a person's own token,
  // and it gives the same result here and on a runner. A smoke that needs a signed-in window uses
  // a stand-in (test/welcome-helper.mjs, `home`).
  // With --live a smoke runs as this computer is signed in. That is for the smokes that run real
  // model turns (LEFT_OUT, where "signed-out"), by hand, on a computer whose owner agrees to it.
  if (!live) {
    env.BOTKINS_SIGNED_OUT = "1";
    delete env.BOTKINS_COPILOT_TOKEN;
    // Only the provider that comes with the app starts, unless a smoke names others itself: the
    // other providers are tools of this computer with sign-ins of their own, and a runner has none.
    env.BOTKINS_PROVIDERS = "copilot";
    delete env.COMMANDER_PROVIDERS;
  }

  const started = Date.now();
  const tally = { pass: 0, fail: 0, time: 0, skip: 0 };
  for (const name of names) {
    const why = leftOut(name, { live });
    if (why) {
      tally.skip++;
      console.log("skip  " + name + ": left out here, because " + why);
      continue;
    }
    let result = await runOne(name, env, minutes * 60_000);
    let again = "";
    if (result.outcome !== "pass" && BY_CHANCE[name]) {
      writeFileSync(join(logs, name + ".first-try.log"), result.output);
      again = " (second try; the first " + (result.outcome === "time" ? "ran out of time" : "failed: " + result.step) + "; this smoke can fail by chance: " + BY_CHANCE[name] + ")";
      result = await runOne(name, env, minutes * 60_000);
    }
    writeFileSync(join(logs, name + ".log"), result.output);
    tally[result.outcome]++;
    if (result.outcome === "pass") console.log("pass  " + name + " (" + result.seconds + "s)" + again);
    else if (result.outcome === "time") console.log("TIME  " + name + ": not done after " + minutes + " minutes" + again);
    else console.log("FAIL  " + name + " (" + result.seconds + "s): " + result.step + again);
  }
  const ran = tally.pass + tally.fail + tally.time;
  const bad = tally.fail + tally.time;
  console.log(
    "\n" + tally.pass + " of " + ran + " passed" + (tally.fail ? ", " + tally.fail + " failed" : "") + (tally.time ? ", " + tally.time + " out of time" : "") + (tally.skip ? ", " + tally.skip + " left out" : "") + ", in " + Math.round((Date.now() - started) / 1000) + "s." + (bad ? " Each smoke's whole output is in " + logs : ""),
  );
  return bad ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main(process.argv.slice(2)));
