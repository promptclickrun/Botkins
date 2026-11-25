import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareDesktopUpdate, waitForDesktopProvision } from "../desktop/terminal/desktop-provision.mjs";

function fixture({ effective = "", installed = false, active = false } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes("show-environment")) return { code: 0, stdout: "" };
    if (args.includes("--property=Environment")) return { code: 0, stdout: effective };
    if (args.includes("--property=ActiveState")) return { code: 0, stdout: active ? "active" : "inactive" };
    if (args.includes("--check")) return { code: installed ? 0 : 1, stdout: "" };
    return { code: 0, stdout: "" };
  };
  return { calls, run };
}
const layout = { folder: "/opt/botkins/botkins-terminal-1.2.3-linux-x64" };
const userService = { scope: "user", kind: "systemd" };
const helper = layout.folder + "/docker/desktop/install-tools";

test("refresh from an older updater provisions missing packages from the incoming version in the service's scope", async () => {
  const { calls, run } = fixture();
  await prepareDesktopUpdate(userService, { layout, run, uid: 1000 });
  const start = calls.find(([file]) => file === "/usr/bin/systemd-run");
  assert.ok(start.includes("--user"));
  assert.ok(start.includes("--unit=botkins-desktop-provision.service"));
  assert.deepEqual(start.slice(-2), ["/bin/sh", helper]);
  assert.ok(!start.includes("--wait"), "the outgoing 0.17.15 refresh has a two-minute deadline");
});

test("repeat refresh, a pending provision, an explicit opt-out and a personal desktop start no package job", async () => {
  for (const options of [{ installed: true }, { active: true }, { effective: "FOO=1 BOTKINS_DESKTOP=off" }, { effective: 'DISPLAY=:0 "XAUTHORITY=/home/me/My Desktop/Xauthority"' }]) {
    const { calls, run } = fixture(options);
    await prepareDesktopUpdate(userService, { layout, run, uid: 1000 });
    assert.equal(calls.some(([file]) => file === "/usr/bin/systemd-run"), false);
  }
});

test("the new service waits for a slow install already running outside the old updater", async () => {
  const states = ["active", "active", "inactive"];
  let pauses = 0;
  await waitForDesktopProvision({ scope: "user", run: async (_file, args) => {
    assert.ok(args.includes("--user"));
    return { code: 0, stdout: states.shift() };
  }, pause: async () => { pauses++; } });
  assert.equal(pauses, 2);
});

test("a host with only NetSurf and Epiphany still needs a full browser; native Firefox satisfies the repeat check", { skip: process.platform !== "linux" }, () => {
  const script = fileURLToPath(new URL("../docker/desktop/install-tools", import.meta.url));
  // Exercise the real read-only check. Model the executables on the two fresh Ubuntu hosts
  // without letting unrelated software installed on this test machine change the outcome.
  const check = `
    command() {
      if [ "$1" != -v ]; then builtin command "$@"; return; fi
      case "$2" in
        Xvfb|xvfb-run|xauth|xdpyinfo|xprop|hsetroot|openbox|dbus-run-session|xdotool|ffmpeg|xterm|pcmanfm|epiphany|netsurf-gtk) echo "/usr/bin/$2";;
        firefox-esr) [ "$modern" = yes ] && echo /usr/bin/firefox-esr;;
        *) return 1;;
      esac
    }
    modern=$2
    . "$1" --check
  `;
  const probe = modern => spawnSync("/bin/bash", ["-c", check, "probe", script, modern], { encoding: "utf8" });
  assert.equal(probe("no").status, 1);
  assert.equal(probe("yes").status, 0);
});
