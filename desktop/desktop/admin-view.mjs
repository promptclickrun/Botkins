// Admin mode for the owner's own window (desktop/link/CONTRACT.md, "Admin mode: what an owner
// device is shown"). With it off, the window is shown what the owner is part of, not every
// member's chats, spaces and bots. It changes what the owner is shown, never what the owner may
// do. A phone keeps its choice on its device record in the link. The window has no device, so the
// choice for this computer is kept here, in a small file of its own, and is off at first.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** This computer's own choice, kept in `file` ({ adminMode }). A file that can't be read is "off". */
export function adminModeStore(file) {
  let on = false;
  try {
    on = JSON.parse(readFileSync(file, "utf8"))?.adminMode === true;
  } catch {
    // No file yet, or not one of ours: off.
  }
  return {
    get: () => on,
    set(value) {
      on = value === true;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + ".tmp", JSON.stringify({ adminMode: on }) + "\n", { mode: 0o600 });
      renameSync(file + ".tmp", file);
      return on;
    },
  };
}

/** Whether the link copy has Admin mode at all. Without it the window shows everything, and no switch. */
export const hasAdminMode = (link) => typeof link?.ownerParts === "function";

const LIVE = ["streams", "intents", "thinking", "speakers", "queued", "steerable", "typing"];

/**
 * The app's own snapshot as the owner's window is shown it: `spaces` is the owner's view of them
 * (the app's own records are never the window's), and `adminMode` says which way the window looks.
 * With Admin mode off, the lists that name other people's things go through the link's own cut
 * (`link.ownerParts`), so the window and an owner's phone are shown the same. A chat with a request
 * that only the owner can answer stays listed while the request waits. The rule is the link's;
 * none of it is written here.
 */
export function ownerWindowView(state, link, admin) {
  const { mentions: _mentions, ...visible } = state;
  if (!hasAdminMode(link)) return { ...visible, spaces: link?.spacesFor?.("owner") };
  if (admin) return { ...visible, spaces: link.spacesFor("owner", { admin: true }), adminMode: true };
  // The link names the live lists as one part; the window's snapshot has them side by side.
  const live = { ...Object.fromEntries(LIVE.filter((name) => visible[name] && typeof visible[name] === "object").map((name) => [name, visible[name]])), requests: visible.requests ?? [], active: Object.keys(visible.streams ?? {}) };
  // What a bot told another person is that person's: the Proactive part goes through the same cut as a phone's.
  const cut = link.ownerParts({ chats: visible.chats ?? [], runs: visible.runs ?? [], bots: visible.bots ?? [], panels: visible.panels ?? [], board: visible.board ?? [], live, ...(visible.proactive && { proactive: visible.proactive }) });
  return {
    ...visible,
    chats: cut.chats,
    runs: cut.runs,
    bots: cut.bots,
    panels: cut.panels,
    board: cut.board,
    ...Object.fromEntries(LIVE.filter((name) => Object.hasOwn(live, name)).map((name) => [name, cut.live[name]])),
    requests: cut.live.requests,
    ...(visible.proactive && { proactive: cut.proactive }),
    // The reminders in the snapshot are for the link to pass on: the window is shown only the owner's own.
    ...(Array.isArray(visible.reminders) && { reminders: visible.reminders.filter((reminder) => reminder?.person === "owner") }),
    spaces: link.spacesFor("owner", { admin: false }),
    adminMode: false,
  };
}
