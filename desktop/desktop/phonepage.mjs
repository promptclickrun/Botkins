// Settings › Phone: what that page is shown, and the calls only that page makes.
//
// None of these calls is in REMOTE_METHODS (desktop/link/methods.mjs), so a phone can make none
// of them: it can't pair another phone, change what phones may do with this screen, or decide
// whether this computer can be reached from away. desktop/main.mjs gives each one a handler of
// the same name for the app's own window.
//
// "Away from home": with it on, the computer keeps one outgoing connection to the Botkins relay,
// and a phone that isn't on this network goes through it (desktop/link/relay.mjs). Messages are
// sealed between the phone and the computer, so the relay can't read them. It is off until the
// person turns it on, and it only runs while phone access is on.
import { screenStatus } from "./screenshare.mjs";

/**
 * @param options.link     () => the LinkHost (made after the handlers, so it is asked for each time).
 * @param options.qrPath   Turns a pairing link into the path of its QR code.
 * @param options.screens  The screen adapter (desktop/screenshare.mjs).
 * @param options.nearby   () => whether the computer is announced on the local network: "off",
 *                         "starting", "on", "blocked" (macOS has not allowed it) or "failed".
 * @param options.allowLocalNetwork  Opens the page of System Settings where macOS allows it.
 */
export function phonePage({ link, qrPath, screens, managed = false, nearby = () => "off", allowLocalNetwork = async () => {} }) {
  /**
   * What the page shows. The pairing's QR code is a path the page draws in an <svg>. Nothing here
   * is a key or names one: not the link's, and of the relay only whether it is on, whether the
   * connection is up, and a problem the person can act on.
   */
  const status = () => {
    const { serverId: _serverId, relay, ...rest } = link().status();
    return {
      ...rest,
      ...(managed && { managed: true }),
      screen: screenStatus(rest.screen, screens),
      nearby: nearby(),
      relay: { enabled: relay?.enabled === true, connected: relay?.connected === true, ...(relay?.problem === "taken" && { problem: "taken" }) },
      ...(rest.pairing && { pairing: { ...rest.pairing, qr: qrPath(rest.pairing.url) } }),
    };
  };
  const editable = () => {
    if (managed) throw new Error("Manage phone access on the headless host.");
    return link();
  };
  return {
    phoneLink: () => status(),
    setPhoneLink: async (enabled) => {
      await editable().setEnabled(enabled === true);
      return status();
    },
    startPhonePairing: () => {
      editable().startPairing();
      return status();
    },
    cancelPhonePairing: () => editable().cancelPairing(),
    removePhone: (id) => void editable().removeDevice(String(id)),
    // A paired phone or computer under another name, as this computer lists it.
    renamePhone: (id, name) => void editable().renameDevice(String(id), String(name ?? "")),
    renamePhoneLinkComputer: (name) => editable().setName(name),
    // What a paired phone may do with this screen: "off", "view" or "control".
    setPhoneScreen: (mode) => {
      editable().setScreenMode(String(mode));
      return status();
    },
    // Opens the page of System Settings where macOS lets Botkins use the local network, which is
    // what lets a phone find this computer by its name.
    allowLocalNetwork: async () => {
      await allowLocalNetwork();
      return status();
    },
    // Asks macOS for Screen Recording or Accessibility and opens the page where it is switched on.
    requestScreenPermission: async (kind) => {
      await screens.request(String(kind));
      return status();
    },
    // Away from home, on or off. It is saved and applies at once. Turning it on needs phone access
    // on, because the relay only runs then; turning it off is always allowed.
    setPhoneRelay: (enabled) => {
      if (enabled === true && !editable().status().enabled) throw new Error("Turn on phone access first.");
      editable().setRelay({ enabled: enabled === true });
      return status();
    },
    // A new place on the relay (a new key). Phones that are away find the computer again once they
    // have been home. The new place's name is not handed to the page.
    resetPhoneRelay: () => {
      editable().resetRelay();
      return status();
    },
  };
}
