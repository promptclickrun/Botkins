// For test/terminal-e2e/units.sh, run in its container as root: what the root update job does
// once it has downloaded and checked a release, with the installed version's own code.
//
//   node units-update.mjs <tarball> <version>
//
// `botkins update` itself takes only the latest signed release from the project's own address,
// so a test can't hand it a tarball. This calls the step after that directly: the same function,
// from the same files, with the same service manager.
import { realpathSync } from "node:fs";

const [archive, version] = process.argv.slice(2);
const current = realpathSync("/opt/botkins/current");
const { switchTo } = await import(current + "/desktop/terminal/update-install.mjs");
const { serviceManager } = await import(current + "/desktop/terminal/manager.mjs");
try {
  const done = await switchTo({ archive, installRoot: "/opt/botkins", version, manager: serviceManager({ command: ["/opt/botkins/current/bin/botkins"] }) });
  console.log("Installed Botkins " + done.version + " (it was " + done.previous + ")." + (done.note ? " " + done.note : ""));
} catch (error) {
  console.error("The update failed: " + error.message);
  process.exit(1);
}
