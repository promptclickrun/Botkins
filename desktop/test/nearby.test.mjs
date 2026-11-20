// Announcing this computer on the local network, so a phone finds it by itself.
// No socket is opened and bonjour-service is never used: the responder is a stand-in that records
// what it is told, the network interfaces are our own, and the 3-second name check runs on mock timers.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SERVICE_TYPE, addressKey, computerName, hostLabel, nearby, serviceName } from "../desktop/nearby.mjs";

// ---- computerName --------------------------------------------------------------------------

test("on a Mac the computer's name comes from scutil, trimmed", () => {
  const calls = [];
  const run = (...args) => {
    calls.push(args);
    return "  Sam's MacBook Air\n";
  };
  const name = computerName({ platform: "darwin", run, host: () => "sams-mac.local" });
  assert.equal(name, "Sam's MacBook Air");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/sbin/scutil");
  assert.deepEqual(calls[0][1], ["--get", "ComputerName"]);
});

test("on a Mac, scutil failing falls back to the host name without its domain", () => {
  const run = () => {
    throw new Error("ComputerName: not set");
  };
  assert.equal(computerName({ platform: "darwin", run, host: () => "mac.tail1234.ts.net" }), "mac");
});

test("on a Mac, an empty answer from scutil falls back to the host name", () => {
  assert.equal(computerName({ platform: "darwin", run: () => "  \n", host: () => "studio.local" }), "studio");
});

test("on other platforms the host name without its domain is used and scutil is never run", () => {
  for (const platform of ["linux", "win32"]) {
    const run = () => assert.fail("scutil must not run on " + platform);
    assert.equal(computerName({ platform, run, host: () => "desk.example.com" }), "desk");
  }
});

test("a host name with no value gives an empty name", () => {
  assert.equal(computerName({ platform: "linux", host: () => null }), "");
});

test("a computer name is never longer than 60 characters", () => {
  const long = "x".repeat(100);
  assert.equal(computerName({ platform: "darwin", run: () => long, host: () => "h" }).length, 60);
  assert.equal(computerName({ platform: "linux", host: () => long }).length, 60);
  // The fallback after a failed scutil is cut the same way.
  const run = () => {
    throw new Error("no");
  };
  assert.equal(computerName({ platform: "darwin", run, host: () => long }).length, 60);
});

// ---- serviceName ---------------------------------------------------------------------------

test("a service name keeps an ordinary name as it is", () => {
  assert.equal(serviceName("Sam's MacBook Air"), "Sam's MacBook Air");
});

test("dots in a service name become spaces, because a dot would split the label", () => {
  assert.equal(serviceName("sams.mac.local"), "sams mac local");
  assert.equal(serviceName("a..b"), "a b");
});

test("control characters are dropped from a service name", () => {
  assert.equal(serviceName("a\u0000b\u007fc\u001bd"), "abcd");
  assert.equal(serviceName("Line\nBreak"), "LineBreak");
});

test("a service name is at most 63 bytes of UTF-8", () => {
  const text = serviceName("a".repeat(100));
  assert.equal(text, "a".repeat(63));
  assert.equal(Buffer.byteLength(text, "utf8"), 63);
});

test("a service name is cut between characters, never in the middle of one", () => {
  // 40 two-byte letters are 80 bytes: 31 of them fit (62 bytes), the 32nd would make 64.
  const accented = serviceName("é".repeat(40));
  assert.equal(accented, "é".repeat(31));
  // 4-byte emoji: 15 fit (60 bytes), 16 would make 64. No half of a surrogate pair is left.
  const emoji = serviceName("😀".repeat(20));
  assert.equal(emoji, "😀".repeat(15));
  assert.equal(Buffer.from(emoji, "utf8").toString("utf8"), emoji);
  // 62 ASCII letters then a 2-byte one is 64 bytes: the letter goes, the rest stays.
  assert.equal(serviceName("a".repeat(62) + "é"), "a".repeat(62));
});

test("an empty or useless service name becomes Botkins", () => {
  for (const name of ["", "   ", "...", "\u0000\u0001", null, undefined]) assert.equal(serviceName(name), "Botkins");
});

// ---- hostLabel -----------------------------------------------------------------------------

test("a host label is lower-case letters and digits from the id, then .local", () => {
  assert.equal(hostLabel("AB-cd_12 34"), "botkins-abcd1234.local");
});

test("a host label uses at most 16 characters of the id", () => {
  assert.equal(hostLabel("0123456789abcdefXYZ"), "botkins-0123456789abcdef.local");
});

test("a host label with no usable id says computer", () => {
  assert.equal(hostLabel(""), "botkins-computer.local");
  assert.equal(hostLabel("---"), "botkins-computer.local");
  assert.equal(hostLabel(null), "botkins-computer.local");
});

// ---- addressKey ----------------------------------------------------------------------------

const lan = (address, extra = {}) => ({ address, family: "IPv4", internal: false, ...extra });

test("the address key lists only external IPv4 addresses, sorted", () => {
  const key = addressKey({
    lo0: [lan("127.0.0.1", { internal: true })],
    en0: [lan("192.168.1.20"), { address: "fe80::1", family: "IPv6", internal: false }],
    en1: [lan("10.0.0.5")],
    old: [lan("172.16.0.9", { family: 4 })],
    gone: undefined,
  });
  assert.equal(key, "10.0.0.5,172.16.0.9,192.168.1.20");
});

test("the address key is empty when there is no external IPv4 address", () => {
  assert.equal(addressKey({}), "");
  assert.equal(addressKey({ lo0: [lan("127.0.0.1", { internal: true })] }), "");
});

test("the address key changes when an address changes, and not when the order of interfaces does", () => {
  const a = addressKey({ en0: [lan("192.168.1.20")], en1: [lan("10.0.0.5")] });
  const same = addressKey({ en1: [lan("10.0.0.5")], en0: [lan("192.168.1.20")] });
  const changed = addressKey({ en0: [lan("192.168.1.21")], en1: [lan("10.0.0.5")] });
  assert.equal(a, same);
  assert.notEqual(a, changed);
});

// ---- nearby() ------------------------------------------------------------------------------

/**
 * A stand-in responder. `events` is one list for everything it is told, in order. A service
 * never sets `published` by itself: a test sets it to say the name was accepted.
 */
function harness(t, addresses = ["192.168.1.20"]) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = [];
  const responders = [];
  const services = [];
  const logs = [];
  const state = { addresses };
  const interfaces = () => ({ en0: state.addresses.map((address) => lan(address)) });
  const create = (onError) => {
    const responder = {
      onError,
      destroyed: 0,
      publish(options) {
        const service = { ...options, published: false, stopped: 0 };
        service.stop = (done) => {
          service.stopped += 1;
          events.push(["stop", options.name]);
          done?.();
        };
        services.push(service);
        events.push(["publish", options.name]);
        return service;
      },
      destroy() {
        this.destroyed += 1;
        events.push(["destroy"]);
      },
    };
    responders.push(responder);
    return responder;
  };
  const announcer = nearby({ create, interfaces, log: (line) => logs.push(line) });
  t.after(() => announcer.stop());
  return { announcer, events, responders, services, logs, state };
}

const on = { on: true, name: "Sam's Mac", port: 4321, id: "AbCd-1234-efgh" };

test("it publishes a botkins service with the port, a host from the id and TXT as strings", (t) => {
  const { announcer, services } = harness(t);
  announcer.update(on);
  assert.equal(services.length, 1);
  const [service] = services;
  assert.equal(SERVICE_TYPE, "botkins");
  assert.equal(service.type, "botkins");
  assert.equal(service.name, "Sam's Mac");
  assert.equal(service.port, 4321);
  assert.equal(service.host, hostLabel(on.id));
  assert.deepEqual(service.txt, { v: "1", id: "AbCd-1234-efgh" });
  assert.equal(service.disableIPv6, true);
});

test("the link protocol goes into TXT as a string", (t) => {
  const { announcer, services } = harness(t);
  announcer.update({ ...on, protocol: 3 });
  assert.deepEqual(services[0].txt, { v: "3", id: on.id });
});

test("the name is made fit for mDNS before it is published", (t) => {
  const { announcer, services } = harness(t);
  announcer.update({ ...on, name: "sams.mac" });
  assert.equal(services[0].name, "sams mac");
});

test("announced shows what is announced now, and nothing once it stops", (t) => {
  const { announcer, services } = harness(t);
  assert.equal(announcer.announced, null);
  announcer.update(on);
  services[0].published = true;
  assert.deepEqual(announcer.announced, { name: "Sam's Mac", port: 4321, host: hostLabel(on.id), txt: { v: "1", id: on.id }, published: true });
  announcer.stop();
  assert.equal(announcer.announced, null);
});

test("update with the same values does nothing", (t) => {
  const { announcer, events, responders } = harness(t);
  announcer.update(on);
  announcer.update({ ...on });
  announcer.update({ ...on });
  assert.deepEqual(events, [["publish", "Sam's Mac"]]);
  assert.equal(responders.length, 1);
});

test("a changed name announces again and the old announcement is stopped", (t) => {
  const { announcer, events, responders, services } = harness(t);
  announcer.update(on);
  announcer.update({ ...on, name: "Studio" });
  assert.deepEqual(events, [["publish", "Sam's Mac"], ["stop", "Sam's Mac"], ["destroy"], ["publish", "Studio"]]);
  assert.equal(services[0].stopped, 1);
  assert.equal(responders[0].destroyed, 1);
  assert.equal(services[1].name, "Studio");
});

test("a changed port announces again", (t) => {
  const { announcer, services } = harness(t);
  announcer.update(on);
  announcer.update({ ...on, port: 5555 });
  assert.equal(services.length, 2);
  assert.equal(services[0].stopped, 1);
  assert.equal(services[1].port, 5555);
});

test("a changed id announces again", (t) => {
  const { announcer, services } = harness(t);
  announcer.update(on);
  announcer.update({ ...on, id: "other-id" });
  assert.equal(services.length, 2);
  assert.equal(services[1].txt.id, "other-id");
  assert.equal(services[1].host, hostLabel("other-id"));
});

test("a changed set of addresses announces again", (t) => {
  const { announcer, services, state } = harness(t);
  announcer.update(on);
  state.addresses = ["192.168.1.20", "10.0.0.7"];
  announcer.update(on);
  assert.equal(services.length, 2);
  assert.equal(services[0].stopped, 1);
});

test("on false ends the announcement", (t) => {
  const { announcer, events, responders, services } = harness(t);
  announcer.update(on);
  announcer.update({ ...on, on: false });
  assert.equal(services[0].stopped, 1);
  assert.equal(responders[0].destroyed, 1);
  assert.equal(announcer.announced, null);
  assert.deepEqual(events.filter(([what]) => what === "publish"), [["publish", "Sam's Mac"]]);
});

test("a missing port or id ends the announcement", (t) => {
  const { announcer, services } = harness(t);
  for (const missing of [{ port: undefined }, { port: 0 }, { id: undefined }, { id: "" }]) {
    announcer.update(on);
    const mine = services.at(-1);
    announcer.update({ ...on, ...missing });
    assert.equal(mine.stopped, 1, JSON.stringify(missing));
    assert.equal(announcer.announced, null, JSON.stringify(missing));
  }
});

test("update with nothing at all announces nothing", (t) => {
  const { announcer, events } = harness(t);
  announcer.update();
  assert.deepEqual(events, []);
});

test("stop ends the announcement, and a later refresh does not bring it back", (t) => {
  const { announcer, services, responders, state } = harness(t);
  announcer.update(on);
  announcer.stop();
  assert.equal(services[0].stopped, 1);
  assert.equal(responders[0].destroyed, 1);
  state.addresses = ["10.1.1.1"];
  announcer.refresh();
  assert.equal(services.length, 1);
  assert.equal(announcer.announced, null);
});

test("stop with nothing announced does nothing", (t) => {
  const { announcer, events } = harness(t);
  announcer.stop();
  assert.deepEqual(events, []);
});

test("the responder is let go a second time if it was slow to say goodbye", (t) => {
  // stop() destroys when the goodbye is done, and again after 1.5 seconds in case it never is.
  const { announcer, events, responders, services } = harness(t);
  announcer.update(on);
  services[0].stop = () => events.push(["stop-without-callback"]);
  announcer.stop();
  assert.equal(responders[0].destroyed, 0);
  t.mock.timers.tick(1500);
  assert.equal(responders[0].destroyed, 1);
});

test("refresh announces again only when the addresses changed", (t) => {
  const { announcer, services, state } = harness(t);
  announcer.refresh();
  assert.equal(services.length, 0, "nothing was asked for yet");
  announcer.update(on);
  announcer.refresh();
  announcer.refresh();
  assert.equal(services.length, 1);
  state.addresses = ["192.168.50.2"];
  announcer.refresh();
  assert.equal(services.length, 2);
  assert.equal(services[0].stopped, 1);
  assert.equal(services[1].name, "Sam's Mac");
  assert.equal(services[1].port, 4321);
  announcer.refresh();
  assert.equal(services.length, 2);
});

test("a name that is taken is retried with part of the id added, at most three times", (t) => {
  const { announcer, services } = harness(t);
  announcer.update(on);
  assert.deepEqual(services.map((s) => s.name), ["Sam's Mac"]);
  // The stand-in never sets `published`, which is what the package does for a name that is taken.
  t.mock.timers.tick(3000);
  assert.deepEqual(services.map((s) => s.name), ["Sam's Mac", "Sam's Mac AbCd-"]);
  t.mock.timers.tick(3000);
  assert.deepEqual(services.map((s) => s.name), ["Sam's Mac", "Sam's Mac AbCd-", "Sam's Mac AbCd-1"]);
  t.mock.timers.tick(3000);
  assert.deepEqual(services.map((s) => s.name), ["Sam's Mac", "Sam's Mac AbCd-", "Sam's Mac AbCd-1", "Sam's Mac AbCd-12"]);
  // A fourth try is never made.
  t.mock.timers.tick(30000);
  assert.equal(services.length, 4);
  // Each name that was tried before was stopped when the next one began.
  assert.deepEqual(services.map((s) => s.stopped), [1, 1, 1, 0]);
});

test("a retried name is still short enough for mDNS", (t) => {
  const { announcer, services } = harness(t);
  announcer.update({ ...on, name: "n".repeat(100) });
  t.mock.timers.tick(3000);
  assert.equal(services.length, 2);
  assert.equal(services[1].name, "n".repeat(40) + " AbCd-");
  assert.ok(Buffer.byteLength(services[1].name, "utf8") <= 63);
});

test("a name that was accepted is not retried", (t) => {
  const { announcer, services } = harness(t);
  announcer.update(on);
  services[0].published = true;
  t.mock.timers.tick(3000);
  t.mock.timers.tick(3000);
  assert.equal(services.length, 1);
  assert.equal(services[0].stopped, 0);
});

test("stopping before the 3-second check means no retry follows", (t) => {
  const { announcer, services } = harness(t);
  announcer.update(on);
  announcer.stop();
  t.mock.timers.tick(10000);
  assert.equal(services.length, 1);
});

test("a changed value after a clash starts again from the plain name", (t) => {
  const { announcer, services } = harness(t);
  announcer.update(on);
  t.mock.timers.tick(3000);
  assert.equal(services.at(-1).name, "Sam's Mac AbCd-");
  announcer.update({ ...on, name: "Studio" });
  assert.equal(services.at(-1).name, "Studio");
});

test("when the responder cannot be made, log is told and nothing is announced", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs = [];
  const announcer = nearby({
    create: () => {
      throw new Error("no multicast");
    },
    interfaces: () => ({}),
    log: (line) => logs.push(line),
  });
  t.after(() => announcer.stop());
  announcer.update(on);
  assert.deepEqual(logs, ["nearby: no multicast"]);
  assert.equal(announcer.announced, null);
});

test("an error the responder reports later goes to log", (t) => {
  const { announcer, responders, logs } = harness(t);
  announcer.update(on);
  responders[0].onError(new Error("socket closed"));
  assert.deepEqual(logs, ["nearby: socket closed"]);
});

// ---- macOS: the system's own Bonjour announces, through its dns-sd tool ----

/** A stand-in for the tool: records how it was started, and lets a test make it speak or end. */
function tool() {
  const started = [];
  const launch = (file, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { file, args, options, stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill: () => ((child.killed = true), true) });
    started.push(child);
    return child;
  };
  return { started, launch };
}
const asked = { on: true, name: "Sam's Mac.Studio", port: 51234, id: "AbC-123", protocol: 1 };

test("on macOS the system announces the computer, and says when it is announced", () => {
  const { started, launch } = tool();
  const changes = [];
  const ad = nearby({ platform: "darwin", launch, changed: () => changes.push(ad.state) });
  assert.equal(ad.state, "off");
  ad.update(asked);
  assert.equal(started.length, 1);
  // The system's tool, under a small shell that ends it when Botkins is gone.
  assert.equal(started[0].file, "/bin/sh");
  assert.deepEqual(started[0].args.slice(3), ["/usr/bin/dns-sd", "-R", "Sam's Mac Studio", "_botkins._tcp", "local.", "51234", "v=1", "id=AbC-123"]);
  assert.match(started[0].args[1], /kill -0 \$PPID/, "it watches for Botkins going away");
  assert.equal(ad.state, "starting");
  assert.equal(ad.announced, null, "not announced until the system says so");
  started[0].stdout.emit("data", "Registering Service Sam's Mac Studio._botkins._tcp.local. port 51234\n");
  assert.equal(ad.state, "starting");
  started[0].stdout.emit("data", " 5:23:53.000  Got a reply for service Sam's Mac Studio._botkins._tcp.local.: Name now registered and active\n");
  assert.equal(ad.state, "on");
  assert.deepEqual(ad.announced, { name: "Sam's Mac Studio", port: 51234, txt: { v: "1", id: "AbC-123" }, published: true });
  // Asked again with nothing changed, it leaves the announcement alone.
  ad.update(asked);
  ad.refresh();
  assert.equal(started.length, 1);
  // A new port is a new announcement, and the old tool is stopped.
  ad.update({ ...asked, port: 51999 });
  assert.equal(started.length, 2);
  assert.equal(started[0].killed, true);
  assert.equal(started[1].args.at(-3), "51999");
  // What the stopped tool says afterwards changes nothing.
  started[0].stdout.emit("data", "Name now registered and active\n");
  assert.equal(ad.state, "starting");
  // Phone access off: the tool is stopped.
  ad.update({ on: false });
  assert.equal(started[1].killed, true);
  assert.equal(ad.state, "off");
  assert.deepEqual(changes, ["starting", "on", "off", "starting", "off"]);
});

test("on macOS a refusal is known for what it is, and tried again now and then", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { started, launch } = tool();
  const ad = nearby({ platform: "darwin", launch });
  ad.update(asked);
  // macOS has not allowed Botkins to use the local network: the system's "policy denied".
  started[0].stdout.emit("data", "DNSService call failed -65570\n");
  assert.equal(ad.state, "blocked");
  assert.equal(ad.announced, null);
  // Asked again at once (every change in phone access asks), nothing new is started…
  ad.update(asked);
  assert.equal(started.length, 1);
  // …but after a while it is tried again, because allowing it in System Settings sends no word.
  t.mock.timers.tick(21_000);
  ad.update(asked);
  assert.equal(started.length, 2);
  started[1].stdout.emit("data", "Name now registered and active\n");
  assert.equal(ad.state, "on");
  // Right after the person was sent to System Settings, it is tried without waiting.
  const again = tool();
  const other = nearby({ platform: "darwin", launch: again.launch });
  other.update(asked);
  again.started[0].stderr.emit("data", "PolicyDenied\n");
  other.retry();
  assert.equal(again.started.length, 2);
  // A tool that ends by itself, or can't be started, is not an announcement.
  again.started[1].emit("exit", 1);
  assert.equal(other.state, "off");
  const broken = nearby({ platform: "darwin", launch: () => { throw new Error("no shell"); } });
  broken.update(asked);
  assert.equal(broken.state, "failed");
  // Elsewhere the JavaScript responder announces; a stand-in responder chooses it on macOS too.
  let made = 0;
  nearby({ platform: "darwin", create: () => (made++, { publish: () => ({ stop: (done) => done?.() }), destroy() {} }) }).update(asked);
  assert.equal(made, 1);
});
