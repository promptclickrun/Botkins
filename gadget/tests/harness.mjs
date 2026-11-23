// What the gadget's tests share: the compiled gadget as a process, a computer with the demo backend and
// a local speech provider, and the waiting in between.
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pcmFromWav } from "../../mobile/link-host/gadget.mjs";
import { LinkHost } from "../../mobile/link-host/index.mjs";
import { MockBackend } from "../../mobile/link-host/mock-backend.mjs";
import { wavFromPcm } from "../../mobile/link-host/voice.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const SIM = process.env.BOTKINS_GADGET_SIM ?? join(here, "../firmware/build/botkins-gadget-sim");
const folders = [];
const running = [];
/** Ends every process and removes every folder made here (for `after`). */
export function cleanup() {
  for (const child of running) child.kill();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
}
export const folder = (name) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), name)));
  folders.push(dir);
  return dir;
};
/** A child process to end with the others, also when a test fails. */
export const track = (child) => (running.push(child), child);
export function tone(seconds, rate) {
  const pcm = Buffer.alloc(Math.floor(seconds * rate) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  return pcm;
}
export async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
/** A port nobody is listening on now. */
export const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** The gadget as a process: lines in, lines out. `view` is what a board would draw now. `env` adds to its environment. */
export function gadget(dir, env = {}) {
  const child = track(spawn(SIM, [dir], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } }));
  const lines = [];
  // The core's own lines (Board::log, "core: …" on standard error), and the rest of standard error as it comes.
  const logs = [];
  const sim = { view: {}, views: [], spoken: [], answers: [], lines, logs };
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
    for (let at = errors.indexOf("\n"); at >= 0; at = errors.indexOf("\n")) {
      const line = errors.slice(0, at);
      errors = errors.slice(at + 1);
      if (line.startsWith("core: ")) logs.push(line.slice(6));
      else process.stderr.write(line + "\n");
    }
  });
  let held = "";
  child.stdout.on("data", (chunk) => {
    held += chunk;
    for (let at = held.indexOf("\n"); at >= 0; at = held.indexOf("\n")) {
      const line = held.slice(0, at);
      held = held.slice(at + 1);
      lines.push(line);
      if (line.startsWith("view ")) sim.views.push((sim.view = JSON.parse(line.slice(5))));
      else if (line.startsWith("@botkins ")) sim.answers.push(JSON.parse(line.slice(9)));
      else if (line.startsWith("spoken ")) sim.spoken.push(line.split(" ")[1]);
    }
  });
  sim.send = (line) => child.stdin.write(line + "\n");
  sim.ask = async (object) => {
    const before = sim.answers.length;
    sim.send("@botkins " + JSON.stringify(object));
    await until(() => sim.answers.length > before, "an answer to " + object.do);
    return sim.answers[before];
  };
  // The same pair of line streams as a serial port gives the introducer (gadget-setup.mjs).
  const listeners = new Set();
  child.stdout.on("data", () => {
    for (; sim.heardLines < lines.length; sim.heardLines++) for (const listener of listeners) listener(lines[sim.heardLines]);
  });
  sim.heardLines = 0;
  sim.io = { write: sim.send, onLine: (listener) => (listeners.add(listener), () => listeners.delete(listener)) };
  sim.quit = () => new Promise((resolve) => {
    child.once("exit", resolve);
    sim.send("quit");
  });
  return sim;
}

/** What the computer's speech provider heard (`bytes`, `rate`) and was asked to say. */
export const heard = [];
export const said = [];
/** The bytes of samples a gadget at 16 kHz plays for everything `said` so far: a second of tone for each 40 characters, made at 24 kHz. */
export const spokenBytes = () => said.reduce((sum, text) => sum + Math.floor((Math.floor((text.length / 40) * 24000) * 16000) / 24000) * 2, 0);

/** A computer with the demo backend, on a port of its own (kept when its link is turned off and on, as the app's is). `relay` is LinkHost's. */
export async function host({ relay = false } = {}) {
  const backend = new MockBackend({ speed: 0.05 });
  backend.voice = {
    local: {
      models: () => [{ id: "ears", name: "Ears", kind: "stt", installed: true }, { id: "mouth", name: "Mouth", kind: "tts", installed: true, voices: ["one"] }],
      transcribe: async (wav) => {
        const { pcm, rate } = pcmFromWav(wav);
        heard.push({ bytes: pcm.length, rate });
        return { text: "Plan the launch week" };
      },
      // A second of tone for each 40 characters, at 24 kHz: the gadget asks for 16 kHz.
      synthesize: async (text) => {
        said.push(text);
        return { audio: wavFromPcm(tone(text.length / 40, 24000), 24000) };
      },
    },
  };
  const link = new LinkHost({ relay, dir: folder("botkins-gadget-host-"), backend, port: await freePort(), extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  link.voice.set({ stt: { provider: "local" }, tts: { provider: "local" } });
  return { link, backend };
}
