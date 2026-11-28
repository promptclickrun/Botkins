// Connected computers and unified multi-host view for the control socket (`botkins hosts`).
import { ControlError } from "./socket.mjs";

const hostRef = (remote, ref) => {
  const wanted = String(ref ?? "").trim();
  if (!wanted) throw new ControlError("Give a computer's name or id. Run `botkins hosts list` to see them.", "BAD_ARGUMENT");
  const hosts = remote.list();
  const byId = hosts.find((h) => h.id === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const byName = hosts.filter((h) => h.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new ControlError("More than one computer is called " + JSON.stringify(wanted) + ". Give its id from `botkins hosts list`.", "AMBIGUOUS");
  throw new ControlError("No paired computer matches " + JSON.stringify(wanted) + ". Run `botkins hosts list` to see them.", "NOT_FOUND");
};

const statusView = (service) => {
  const remote = service.remote;
  const localName = service.runtime?.link?.status?.()?.name || "This computer";
  if (!remote) {
    return { localName, unified: false, unifiedEnabled: false, using: null, hosts: [] };
  }
  const unifiedStats = new Map(remote.unifiedHostsStatus().map((entry) => [entry.id, entry]));
  return {
    localName,
    unified: remote.isUnified(),
    unifiedEnabled: remote.unifiedEnabled(),
    using: remote.inUse(),
    hosts: remote.list().map((host) => {
      const live = unifiedStats.get(host.id);
      return {
        ...host,
        ...(live && { bots: live.bots, requests: live.requests }),
      };
    }),
  };
};

export function hostsApi(service) {
  const needRemote = () => {
    if (!service.remote) throw new ControlError("Paired computers are not available on this host.", "UNAVAILABLE");
    return service.remote;
  };
  return {
    "hosts.status": () => statusView(service),
    "hosts.unified": ([enabled]) => {
      const remote = needRemote();
      if (typeof enabled !== "boolean") throw new ControlError("Give true or false to turn unified view on or off.", "BAD_ARGUMENT");
      remote.setUnified(enabled);
      service.changed?.();
      return statusView(service);
    },
    "hosts.include": ([ref, included]) => {
      const remote = needRemote();
      if (typeof included !== "boolean") throw new ControlError("Give true or false to include or exclude a computer.", "BAD_ARGUMENT");
      const host = hostRef(remote, ref);
      remote.setHostIncluded(host.id, included);
      service.changed?.();
      return statusView(service);
    },
    "hosts.focus": ([ref]) => {
      const remote = needRemote();
      const wanted = String(ref ?? "").trim();
      if (!wanted || wanted.toLowerCase() === "local") {
        remote.use(null);
      } else {
        const host = hostRef(remote, wanted);
        remote.use(host.id);
      }
      service.changed?.();
      return statusView(service);
    },
  };
}
