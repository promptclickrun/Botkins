// Starts the Pi that ships with Botkins (launcher() in index.mjs): `node run-bundled.mjs <cli.js> …args`.
// Inside the app, Electron runs it as Node.js because of ELECTRON_RUN_AS_NODE. That must not reach
// what Pi starts in turn (a bot's shell commands): another Electron program would start as bare
// Node.js. So it goes here, and Pi sees its own command line as if it had been started directly.
import { pathToFileURL } from "node:url";

delete process.env.ELECTRON_RUN_AS_NODE;
const cli = process.argv[2];
process.argv.splice(1, 1);
await import(pathToFileURL(cli).href);
