// Setting a gadget up over its USB port (gadget/docs/contract.md, "Setup over USB"): read its key,
// name it to this computer, and hand it the answer with the Wi-Fi network. This is the introducer's
// half, for the computer's own app (its Gadgets page, `botkins gadgets add`) and the demo computer.
//
// The gadget's lines are found among its boot log by their mark. Nothing here keeps or prints a
// Wi-Fi password: it goes to the gadget and nowhere else.
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { Failure } from "./tools.mjs";

const MARK = "@botkins ";

/**
 * Talks the setup protocol over any pair of line streams. `io` is `{ write(line), onLine(fn) }`;
 * `onLine` returns a function that stops listening.
 */
export function setupChannel(io) {
  const waiting = [];
  const stop = io.onLine((line) => {
    const at = line.indexOf(MARK);
    if (at < 0) return;
    let answer;
    try {
      answer = JSON.parse(line.slice(at + MARK.length));
    } catch {
      return;
    }
    // A gadget prints only answers. An object with "do" is this side's own line coming back from a port that echoes.
    if (!answer || typeof answer !== "object" || "do" in answer) return;
    // An answer goes to the question it fits: a question is asked again while it waits, so a late second
    // answer to an earlier one may still arrive, and must not be taken for this one's.
    waiting.find((waiter) => waiter.fits(answer))?.done(answer);
  });
  const FITS = { hello: (a) => "hello" in a, status: (a) => "status" in a, view: (a) => "view" in a };
  return {
    /** One line of the protocol and its answer. Asked again every `every` ms: a gadget that just restarted misses the first. */
    ask(object, { timeout = 8000, every = 1500 } = {}) {
      return new Promise((resolve, reject) => {
        const send = () => io.write(MARK + JSON.stringify(object));
        // Only a question that changes nothing is asked twice: "setup" is sent once.
        const repeat = FITS[object.do] ? setInterval(send, every) : undefined;
        const waiter = {
          fits: (answer) => "error" in answer || (FITS[object.do] ?? ((a) => "ok" in a))(answer),
          done(answer) {
            clearInterval(repeat);
            clearTimeout(timer);
            const at = waiting.indexOf(waiter);
            if (at >= 0) waiting.splice(at, 1);
            if (answer) resolve(answer);
            else reject(new Failure("The gadget didn't answer. Check the cable, and that it runs the Botkins firmware."));
          },
        };
        const timer = setTimeout(() => waiter.done(null), timeout);
        waiting.push(waiter);
        send();
      });
    },
    close: stop,
  };
}

/**
 * The whole of setup. `add` names the gadget to the computer (`link.addGadget`, or the call
 * "link.gadgets.add" from an owner device) and answers the introduction. `wifi` is `{ ssid, password }`,
 * or nothing for a gadget that has a network already. `onStatus` hears each status on the way.
 * Resolves with `{ deviceId, board, firmware, mac, status }` once the gadget is online, and rejects
 * with a sentence when it isn't after `wait` ms.
 */
export async function introduce({ io, add, wifi, name, botId, onStatus, wait = 45000 }) {
  const channel = setupChannel(io);
  try {
    const hello = await channel.ask({ do: "hello" });
    if (hello.error) throw new Failure("That isn't a Botkins gadget.");
    if (hello.hello !== 1 || typeof hello.publicKey !== "string") throw new Failure("That isn't a Botkins gadget.");
    if (!wifi && !hello.wifi) throw new Failure("This gadget has no Wi-Fi network yet. Give it one.");
    const introduction = await add({ publicKey: hello.publicKey, board: hello.board, ...(name && { name }), ...(botId && { botId }) });
    const set = await channel.ask({ do: "setup", ...(wifi && { wifi: { ssid: String(wifi.ssid), password: String(wifi.password ?? "") } }), link: introduction });
    if (set.error) throw new Failure(String(set.error).slice(0, 200));
    const end = Date.now() + wait;
    let status = {};
    for (;;) {
      ({ status = {} } = await channel.ask({ do: "status" }));
      onStatus?.(status);
      if (status.link === "online") break;
      if (status.wifi === "failed") throw new Failure("The gadget couldn't join that Wi-Fi network. Check the name and the password.");
      if (Date.now() > end) throw new Failure(status.wifi === "on" ? "The gadget joined the Wi-Fi network but can't reach this computer. They need to be on the same network." : "The gadget is still joining the Wi-Fi network. Check that it is in range.");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return { deviceId: introduction.deviceId, board: hello.board, firmware: hello.firmware, mac: hello.mac, status };
  } finally {
    channel.close();
  }
}

/**
 * A serial port as lines, with what Node has (macOS and Linux): `stty` sets the port raw, then it is
 * read and written as a file. `close()` ends it. The app's own window uses its serial API instead.
 */
export function serialLines(path) {
  if (process.platform === "win32") throw new Failure("Setting up a gadget from here isn't built for Windows yet.");
  try {
    execFileSync("stty", [process.platform === "darwin" ? "-f" : "-F", path, "115200", "raw", "-echo", "-hupcl"], { stdio: "ignore", timeout: 5000 });
  } catch {
    throw new Failure("That serial port can't be opened. Check the cable, and that nothing else is using the port.");
  }
  const input = createReadStream(path, { encoding: "utf8" });
  const output = createWriteStream(path);
  const listeners = new Set();
  let held = "";
  input.on("data", (chunk) => {
    held += chunk;
    for (let at = held.indexOf("\n"); at >= 0; at = held.indexOf("\n")) {
      const line = held.slice(0, at).replace(/\r$/, "");
      held = held.slice(at + 1);
      for (const listener of listeners) listener(line);
    }
    if (held.length > 8192) held = held.slice(-4096);
  });
  input.on("error", () => {});
  output.on("error", () => {});
  return {
    write: (line) => void output.write(line + "\n"),
    onLine(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      input.destroy();
      output.destroy();
    },
  };
}
