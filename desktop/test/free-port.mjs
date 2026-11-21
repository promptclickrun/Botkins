// A port for a smoke's own copy of the app, asked of the system. A smoke never uses a port the
// installed app has (47610 for the phone link, 47823 for a tool's sign-in), and never a fixed one.
import { createServer } from "node:net";

/** A port that was free a moment ago on this computer. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject).listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
