// The terminal's profile calls.  Values returned here are the public profile identity and
// directory only; ProfileManager keeps the bearer token and browser verifier in its protected file.
import { ControlError } from "./socket.mjs";

const text = (value, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : "");
const bad = (message) => new ControlError(message, "BAD_ARGUMENT");

export function profileApi({ profile }) {
  if (!profile) return {};
  const requireId = (value, what) => {
    const id = text(value, 200);
    if (!id) throw bad("Give " + what + ".");
    return id;
  };
  return {
    "profile.status": ([options] = []) => profile.status(options && typeof options === "object" ? options : {}),
    "profile.start": async ([label] = []) => profile.start(text(label, 120) || "This device"),
    "profile.finish": () => profile.finish(),
    "profile.refresh": () => profile.refresh({ retry: true }),
    "profile.home": () => profile.home(),
    "profile.optOut": () => profile.optOut(),
    "profile.signOut": () => profile.signOut(),
    "profile.approve": ([id, code] = []) => {
      if (!text(code, 64)) throw bad("Give the short code from the device's profile page through standard input.");
      return profile.approve(requireId(id, "the device id"), code);
    },
    "profile.revoke": ([id] = []) => profile.revoke(requireId(id, "the device id")),
    "profile.connect": ([id] = []) => profile.connect(requireId(id, "the computer id")),
    "profile.markMigrationPrompted": () => profile.markMigrationPrompted(),
  };
}
