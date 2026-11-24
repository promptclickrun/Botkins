// A gadget's serial port must never become the host's controlling terminal. A service (systemd, launchd)
// runs in a session of its own with no terminal; on Linux, a terminal it opens without O_NOCTTY becomes
// its controlling terminal, and that terminal's hangup (the gadget unplugged after setup, a bridge closed)
// then sends the whole service SIGHUP, which ends it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const setup = fileURLToPath(new URL("../desktop/link/gadget-setup.mjs", import.meta.url));

const hasPython = (() => {
  try {
    execFileSync("python3", ["-c", "import pty"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Python makes the pty and a child in a new session (as a service runs), lets the child open the pty,
// trades a line each way when asked to ("talk"), then hangs the pty up by closing the other end, and
// says what it saw and whether the child lived.
const HARNESS = String.raw`
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
path = os.ttyname(slave)
os.close(slave)
child = subprocess.Popen([sys.argv[1], "--input-type=module", "-e", sys.argv[2], path], start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
seen = [child.stdout.readline().decode().strip()]
if sys.argv[3] == "talk":
    os.write(master, b"@botkins {\"hello\":1}\n")
    seen.append(child.stdout.readline().decode().strip())
    heard = b""
    end = time.time() + 5
    while b"\n" not in heard and time.time() < end:
        if select.select([master], [], [], 0.2)[0]:
            heard += os.read(master, 256)
    seen.append(heard.decode().strip())
os.close(master)
time.sleep(0.8)
code = child.poll()
if code is None:
    child.kill()
    child.wait()
seen.append("alive" if code is None else "ended %d" % code)
print(" | ".join(seen))
`;

test("a gadget's serial port opened by a service carries lines both ways and is not its terminal: the port's hangup doesn't end the service", { skip: process.platform !== "linux" || !hasPython }, () => {
  const child = `
    import { serialLines } from ${JSON.stringify(setup)};
    const port = serialLines(process.argv[1]);
    port.onLine((line) => {
      console.log("read " + line);
      port.write("@botkins {\\"do\\":\\"status\\"}");
    });
    // Once the port is open: the test talks, then hangs it up.
    setTimeout(() => console.log("open"), 300);
    setInterval(() => {}, 1000);
  `;
  const out = execFileSync("python3", ["-I", "-c", HARNESS, process.execPath, child, "talk"], { encoding: "utf8", timeout: 20000 }).trim();
  assert.equal(out, 'open | read @botkins {"hello":1} | @botkins {"do":"status"} | alive');
});

test("the harness sees a hangup end a process whose terminal it is", { skip: process.platform !== "linux" || !hasPython }, () => {
  // The same, with the port opened as a plain file: proof the test above can fail.
  const child = `
    import { openSync } from "node:fs";
    openSync(process.argv[1], "r+");
    setTimeout(() => console.log("open"), 300);
    setInterval(() => {}, 1000);
  `;
  const out = execFileSync("python3", ["-I", "-c", HARNESS, process.execPath, child, "plain"], { encoding: "utf8", timeout: 20000 }).trim();
  assert.equal(out, "open | ended -1");
});
