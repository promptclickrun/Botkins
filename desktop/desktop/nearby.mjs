// Lets Botkins on a phone find this computer by itself on the local network, so nobody has to
// type an address or a port. While phone access is on, the computer announces a Bonjour service
// (mDNS and DNS-SD, the way printers and AirPlay are found):
//
//   type   _botkins._tcp
//   name   the computer's name, as Settings › Phone shows it
//   port   the phone link's port
//   TXT    v=<link protocol>  id=<this computer's link id>
//
// The announcement says nothing a phone on the network couldn't already ask the link's own
// "hello" for, and it is not what lets a phone in: that is still the pairing code. A phone that
// can't hear it (another network, a tailnet, a network that blocks multicast) pairs with the QR
// code, or with the address and the code typed in.
//
// Who does the announcing:
//   macOS            the system's own Bonjour, asked through its dns-sd tool. macOS lets an app
//                    use the local network only once the person has allowed it (System Settings ›
//                    Privacy & Security › Local Network), and it only asks, and only says "no",
//                    to an app that goes through the system. Packets an app sends by itself are
//                    dropped without a word, so the app could never tell the person why a phone
//                    can't find the computer.
//   Windows, Linux   a responder written in JavaScript (bonjour-service), which needs nothing installed.
import { execFileSync, spawn } from "node:child_process";
import { hostname, networkInterfaces } from "node:os";
import Bonjour from "bonjour-service";

export const SERVICE_TYPE = "botkins";

/**
 * The system's own name for this computer: on a Mac the one in Sharing ("Sam's MacBook Air"),
 * elsewhere the host name without its domain. A network's name for the computer (a tailnet's
 * "mac.tail1234.ts.net") is not what a person calls it.
 */
export function computerName({ platform = process.platform, run = execFileSync, host = hostname } = {}) {
  if (platform === "darwin") {
    try {
      const name = String(run("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 3000 })).trim();
      if (name) return name.slice(0, 60);
    } catch {
      // No such name: the host name below.
    }
  }
  return String(host() ?? "").replace(/\..*$/, "").trim().slice(0, 60);
}

/** A name mDNS can carry as one label: no dots (they split labels), no control characters, at most 63 bytes. */
export function serviceName(name) {
  let text = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\./g, " ")
    .replace(/\s+/g, " ")
    .trim();
  while (Buffer.byteLength(text, "utf8") > 63) text = Array.from(text).slice(0, -1).join("");
  return text.trim() || "Botkins";
}

/** This computer's own .local name for the announcement, from its link id: letters, digits and dashes only. */
export const hostLabel = (id) => "botkins-" + (String(id ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "computer") + ".local";

/** The IPv4 addresses a phone could be given, as one string: when it changes, the announcement is made again. */
export function addressKey(interfaces = networkInterfaces()) {
  return Object.values(interfaces)
    .flatMap((list) => list ?? [])
    .filter((entry) => !entry.internal && (entry.family === "IPv4" || entry.family === 4))
    .map((entry) => entry.address)
    .sort()
    .join();
}

/**
 * macOS: the system announces, through /usr/bin/dns-sd, which runs for as long as the service is
 * announced. `state` is "off", "starting", "on", "blocked" (macOS has not allowed Botkins to use
 * the local network) or "failed".
 */
function systemAnnouncer({ launch = spawn, log = () => {}, changed = () => {} } = {}) {
  let child = null;
  let state = "off";
  const set = (next) => {
    if (state === next) return;
    state = next;
    changed();
  };
  return {
    get state() {
      return state;
    },
    publish({ name, port, txt }) {
      this.stop();
      set("starting");
      // A small shell around the tool ends it when Botkins is gone, however Botkins went, so a
      // computer that no longer answers is never left announced.
      const watch = '"$@" & tool=$!; trap "kill $tool 2>/dev/null; exit 0" TERM INT; while kill -0 $PPID 2>/dev/null && kill -0 $tool 2>/dev/null; do sleep 2; done; kill $tool 2>/dev/null';
      let mine;
      try {
        mine = child = launch("/bin/sh", ["-c", watch, "sh", "/usr/bin/dns-sd", "-R", name, "_" + SERVICE_TYPE + "._tcp", "local.", String(port), ...Object.entries(txt).map(([key, value]) => key + "=" + value)], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        log("nearby: " + (error?.message ?? error));
        return set("failed");
      }
      const read = (chunk) => {
        if (child !== mine) return;
        const text = String(chunk);
        // -65570 is the system's "policy denied": the person has not allowed the local network.
        if (/-65570|PolicyDenied/i.test(text)) set("blocked");
        else if (/registered and active/i.test(text)) set("on");
        else if (/failed|error/i.test(text) && state !== "on") set("failed");
      };
      mine.stdout?.on("data", read);
      mine.stderr?.on("data", read);
      mine.on("error", (error) => {
        log("nearby: " + (error?.message ?? error));
        if (child === mine) set("failed");
      });
      mine.on("exit", () => {
        if (child !== mine) return;
        child = null;
        // A tool that ends without having said why did not announce anything.
        if (state === "on" || state === "starting") set("off");
      });
    },
    stop() {
      const old = child;
      child = null;
      try {
        old?.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      set("off");
    },
  };
}

/**
 * @param options.create      Makes the JavaScript responder (tests pass a stand-in; passing one also
 *                            chooses the responder on macOS).
 * @param options.interfaces  () => the network interfaces (tests pass their own).
 * @param options.log         Told when announcing can't start. The app works without it.
 * @param options.platform, options.launch  For tests of the macOS way.
 * @param options.changed     Called when `state` changes, so a page that shows it can look again.
 */
export function nearby({ create, interfaces = networkInterfaces, log = () => {}, platform = process.platform, launch, changed = () => {} } = {}) {
  if (platform === "darwin" && !create) return throughSystem(systemAnnouncer({ launch, log, changed }));
  create ??= (onError) => new Bonjour({}, onError);
  let responder = null;
  let service = null;
  let told = "";
  let wanted = null;
  let attempt = 0;
  let check = null;

  const stop = () => {
    clearTimeout(check);
    check = null;
    const [oldService, old] = [service, responder];
    service = null;
    responder = null;
    told = "";
    if (!old) return;
    // Says goodbye, so phones drop this computer from their list at once, then lets go of the socket.
    try {
      const done = () => {
        try {
          old.destroy();
        } catch {
          // Already gone.
        }
      };
      if (oldService?.stop) oldService.stop(done);
      else done();
      setTimeout(done, 1500).unref?.();
    } catch {
      // Nothing was announced.
    }
  };

  const start = () => {
    const { name, port, id, protocol } = wanted;
    // A second computer with the same name would silence one of them, so a clash gets the id added.
    const shown = attempt === 0 ? serviceName(name) : serviceName(serviceName(name).slice(0, 40) + " " + String(id).slice(0, 4 + attempt));
    try {
      responder = create((error) => log("nearby: " + (error?.message ?? error)));
      service = responder.publish({ name: shown, type: SERVICE_TYPE, port, host: hostLabel(id), txt: { v: String(protocol), id: String(id) }, disableIPv6: true });
      told = JSON.stringify([name, port, id, protocol, addressKey(interfaces())]);
      // The package drops a name that is taken without saying so: look once it has had time to ask around.
      const mine = service;
      check = setTimeout(() => {
        if (service !== mine || mine.published || attempt >= 3) return;
        attempt += 1;
        stop();
        start();
      }, 3000);
      check.unref?.();
    } catch (error) {
      log("nearby: " + (error?.message ?? error));
      stop();
    }
  };

  return {
    /**
     * Announces this computer, or stops when `on` is false. Call it as often as you like: it only
     * announces again when the name, the port, the id or this computer's addresses changed.
     */
    update({ on, name, port, id, protocol = 1 } = {}) {
      if (!on || !port || !id) {
        wanted = null;
        stop();
        return;
      }
      wanted = { name, port, id, protocol };
      if (responder && told === JSON.stringify([name, port, id, protocol, addressKey(interfaces())])) return;
      attempt = 0;
      stop();
      start();
    },
    /** Announces again when this computer's addresses changed (a new network, waking from sleep). */
    refresh() {
      if (wanted) this.update({ on: true, ...wanted });
    },
    stop() {
      wanted = null;
      stop();
    },
    /** "on" once the announcement is out, "starting" until then, "off" when nothing is announced. */
    get state() {
      return !service ? "off" : service.published ? "on" : "starting";
    },
    /** What is announced now, for the tests: { name, port, host, txt } or null. */
    get announced() {
      return service ? { name: service.name, port: service.port, host: service.host, txt: service.txt, published: !!service.published } : null;
    },
  };
}

// How often a refused or failed announcement is tried again: allowing the local network in System
// Settings takes effect without the app hearing of it.
const RETRY = 20_000;

/** The same update / refresh / stop as the responder's, for the system's announcer. */
function throughSystem(system) {
  let wanted = null;
  let told = "";
  let tried = 0;
  const key = (w) => JSON.stringify([w.name, w.port, w.id, w.protocol]);
  const publish = () => {
    told = key(wanted);
    tried = Date.now();
    system.publish({ name: serviceName(wanted.name), port: wanted.port, txt: { v: String(wanted.protocol), id: String(wanted.id) } });
  };
  return {
    update({ on, name, port, id, protocol = 1 } = {}) {
      if (!on || !port || !id) {
        wanted = null;
        told = "";
        system.stop();
        return;
      }
      wanted = { name, port, id, protocol };
      const state = system.state;
      // Announced, or on its way: nothing to do. Refused or failed: tried again now and then.
      if (told === key(wanted) && (state === "on" || state === "starting" || Date.now() - tried < RETRY)) return;
      publish();
    },
    refresh() {
      if (wanted) this.update({ on: true, ...wanted });
    },
    /** Tries again at once, after the person was sent to System Settings. */
    retry() {
      if (wanted && system.state !== "on") publish();
    },
    stop() {
      wanted = null;
      told = "";
      system.stop();
    },
    get state() {
      return system.state;
    },
    get announced() {
      return wanted && system.state === "on" ? { name: serviceName(wanted.name), port: wanted.port, txt: { v: String(wanted.protocol), id: String(wanted.id) }, published: true } : null;
    },
  };
}
