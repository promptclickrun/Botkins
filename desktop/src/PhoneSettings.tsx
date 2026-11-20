import { useEffect, useState } from "react";
import { Monitor, Smartphone, Trash2, TriangleAlert } from "lucide-react";
import type { PhoneLink, State } from "./types";
import { plural, when } from "./wikiModel";
import { useAsk } from "./Pages";
import { Group, SwitchRow, errorText } from "./SettingsRows";
import { stopCancel } from "./SkillsSettings";
import { Permission, ScreenRows, screenWaiting } from "./ScreenSettings";
import "./integrations.css";
import "./remotehosts.css";

const api = window.botkins;

/** "ABCD1234EFGH" as "ABCD-1234-EFGH". */
const grouped = (code: string) => (code.replace(/[^0-9A-Za-z]/g, "").match(/.{1,4}/g) ?? []).join("-").toUpperCase();

/** "5 minutes", "1 minute", or "40 seconds" in the last minute. */
function remaining(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return seconds > 60 ? plural(Math.ceil(seconds / 60), "minute") : plural(seconds, "second");
}

/** Settings › Phone: turn phone access on, pair a phone with a QR code, let phones reach this computer from away, choose what a phone may do with this screen, and see or remove paired phones. */
const SOURCE_NAMES: Record<string, string> = { calendar: "Calendar", contacts: "Contacts", health: "Health", location: "Location", photos: "Photos", mail: "Mail" };
const list = (items: string[]) => (items.length < 2 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items.at(-1));
/** What a phone is notified about, as it chose on the phone. */
export function notified(status: Pick<PhoneLink, "push">, deviceId: string) {
  const prefs = status.push?.find((p) => p.deviceId === deviceId)?.prefs;
  if (!prefs) return "No notifications are sent to this phone.";
  const kinds = [prefs.replies !== false && "replies", prefs.requests !== false && "questions and approvals", prefs.routines !== false && "routines"].filter(Boolean) as string[];
  return kinds.length ? "Notified about " + list(kinds) + (prefs.previews === false ? ", without the text" : "") + "." : "Notifications are switched off on this phone.";
}
/** What a phone lets bots use on it, as it chose on the phone. */
export function shared(status: Pick<PhoneLink, "sources">, deviceId: string) {
  const sources = Object.entries(status.sources?.[deviceId] ?? {}).filter(([, level]) => level === "read" || level === "interact");
  if (!sources.length) return "Bots may use nothing on this phone.";
  return "Bots may " + list(sources.map(([source, level]) => (level === "interact" ? "read and change " : "read ") + (SOURCE_NAMES[source] ?? source))) + ".";
}

export default function PhoneSettings({ state }: { state: State }) {
  const [status, setStatus] = useState<PhoneLink>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const dialogs = useAsk();
  const revision = state.phones?.revision ?? 0;
  const load = () =>
    api
      .phoneLink()
      .then((s) => {
        setStatus(s);
        setError("");
      })
      .catch((e) => setError(errorText(e)));
  // A phone that pairs, connects or leaves changes the revision: ask again.
  useEffect(() => {
    void load();
  }, [revision]);
  const pairing = status?.pairing ?? null;
  // The countdown. The link also drops an expired code itself; this hides it at the same moment.
  useEffect(() => {
    if (!pairing) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing?.code]);
  const expired = !!pairing && pairing.expiresAt <= now;
  useEffect(() => {
    if (expired) void load();
  }, [expired]);
  // A permission is switched on in System Settings, outside this window: while one is still
  // missing, look again every few seconds and whenever the window comes back to the front.
  const screen = status?.screen;
  const waiting = status?.nearby === "blocked" || screenWaiting(screen);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void load(), 2500);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [waiting]);
  async function run(fn: () => Promise<PhoneLink | void>) {
    setError("");
    setBusy(true);
    try {
      const next = await fn();
      if (next) setStatus(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  /** Another name for a paired phone or computer, as this computer lists it. */
  async function rename() {
    if (!renaming) return;
    const { id, name } = renaming;
    setRenaming(null);
    if (name.trim()) await run(async () => (await api.renamePhone(id, name.trim()), api.phoneLink()));
  }
  async function remove(device: PhoneLink["devices"][number]) {
    const ok = await dialogs.ask({
      title: "Remove " + device.name + "?",
      body: "This phone can't reach this computer any more. You can pair it again later.",
      confirm: "Remove",
      danger: true,
    });
    if (ok)
      await run(async () => {
        await api.removePhone(device.id);
        return api.phoneLink();
      });
  }
  /** A new place on the relay, after asking: phones that are away lose their way to this computer until they have been home. */
  async function resetAway() {
    const ok = await dialogs.ask({
      title: "Reset away from home?",
      body: "Phones that are away will need to come home once to find this computer again.",
      confirm: "Reset",
    });
    if (ok) await run(() => api.resetPhoneRelay());
  }
  if (!status)
    return error ? (
      <p className="set-status error-text" role="alert">
        Couldn't check phone access. {error}{" "}
        <button type="button" className="set-link" onClick={() => void load()}>
          Try again
        </button>
      </p>
    ) : (
      <p className="set-status" role="status">
        Checking phone access…
      </p>
    );
  if (status.managed)
    return <p className="set-status">Manage screen access on your paired phone. To pair another phone, open a pairing code on the server.</p>;
  if (status.locked)
    return (
      <div className="cred-lost" role="alert">
        <TriangleAlert size={15} aria-hidden="true" />
        <span>Phone access was set up by the installed Botkins app. Pair phones there.</span>
      </div>
    );
  const open = pairing && !expired ? pairing : null;
  const [first, ...others] = status.addresses;
  return (
    <div className="int-section" {...stopCancel}>
      <Group>
        <SwitchRow
          label="Let a phone connect"
          help="A paired phone can do what you can do here."
          checked={status.enabled}
          disabled={busy}
          onChange={(on) => void run(() => api.setPhoneLink(on))}
        />
      </Group>
      {error && (
        <p className="set-status error-text" role="alert">
          {error}
        </p>
      )}
      {status.enabled && !status.listening && (
        <p className="set-status error-text" role="alert">
          Phone access is on, but this computer couldn't open its port. Turn it off and on to try again.
        </p>
      )}
      {status.enabled && status.listening && (
        <>
          <Group>
            {/* macOS lets an app use the local network only once the person allows it. Without that a phone can't find this computer by its name. */}
            {(status.nearby === "blocked" || (status.nearby === "on" && status.screen.permissions.system)) && (
              <Permission
                name="Local Network"
                help={status.nearby === "on" ? "Your phone can find this computer by its name." : "Lets your phone find this computer by its name. Switch Botkins on in System Settings. The QR code works without it."}
                granted={status.nearby === "on"}
                busy={busy}
                grant={() => void run(() => api.allowLocalNetwork())}
              />
            )}
            {open ? (
              <div className="set-row stacked phone-pair">
                <div className="phone-qr" role="img" aria-label="Pairing QR code">
                  <svg viewBox={`0 0 ${open.qr.size} ${open.qr.size}`} shapeRendering="crispEdges" aria-hidden="true">
                    <rect width={open.qr.size} height={open.qr.size} fill="#fff" />
                    <path d={open.qr.d} fill="#1a1420" />
                  </svg>
                </div>
                <code className="phone-code int-mono">{grouped(open.code)}</code>
                {/* Three ways, easiest first: the camera, this computer found by name, or its address typed in. */}
                {first ? (
                  <ol className="phone-ways" aria-label="Ways to pair">
                    <li>Scan the code with your phone's camera.</li>
                    <li>
                      Or choose <strong>{status.name}</strong> in Botkins on your phone and type the code.
                    </li>
                    <li>
                      Or type the code with this address:{" "}
                      <code className="int-mono">
                        {first.address}:{status.port}
                      </code>
                      {others.map((a) => (
                        <span key={a.address}>
                          {" or "}
                          <code className="int-mono">
                            {a.address}:{status.port}
                          </code>
                        </span>
                      ))}
                    </li>
                  </ol>
                ) : (
                  <p className="phone-note">This computer has no network address. Join Wi-Fi or a tailnet, then try again.</p>
                )}
                <p className="phone-note" role="status">
                  The code works once and expires in {remaining(open.expiresAt - now)}.
                  {!status.relay.enabled && " Your phone has to be on this network to pair."}
                </p>
                <button
                  type="button"
                  className="set-button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.cancelPhonePairing();
                      return api.phoneLink();
                    })
                  }
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="set-row">
                <div className="set-label">
                  <span className="set-name">New phone</span>
                  <small>Shows a code to scan with Botkins on your phone.</small>
                </div>
                <div className="set-control">
                  <button type="button" className="set-button primary" disabled={busy} onClick={() => void run(() => api.startPhonePairing())}>
                    Pair a phone
                  </button>
                </div>
              </div>
            )}
          </Group>
        </>
      )}
      <Group>
        <SwitchRow
          label="Use away from home"
          help="Your phone reaches this computer through the Botkins relay when it is not on your network. Messages stay sealed between the two."
          checked={status.relay.enabled}
          disabled={busy || !status.enabled}
          onChange={(on) => void run(() => api.setPhoneRelay(on))}
        />
        {/* How it is going, while it is on. A new place on the relay is one quiet step away, and the way out when another computer has this one's place. */}
        {status.enabled &&
          status.relay.enabled &&
          (status.relay.problem === "taken" ? (
            <p className="set-status error-text phone-screen-note phone-away-taken" role="alert">
              <span>Another computer is using this computer's place. Botkins keeps trying; Reset takes it back now.</span>
              <button type="button" className="set-button" disabled={busy} onClick={() => void resetAway()}>
                Reset
              </button>
            </p>
          ) : (
            <div className="set-row int-item compact phone-away-state">
              <div className="set-label">
                <small role="status">{status.relay.connected ? "On" : "Connecting…"}</small>
              </div>
              <div className="set-control">
                <button type="button" className="set-link" disabled={busy} onClick={() => void resetAway()}>
                  Reset…
                </button>
              </div>
            </div>
          ))}
        {status.enabled && <ScreenRows status={status} busy={busy} run={(fn) => void run(fn)} />}
      </Group>
      {status.enabled && status.listening && (
        <>
          <Group title="Devices">
            {status.devices.length === 0 ? (
              <div className="set-row">
                <div className="set-label">
                  <small>Nothing is paired yet.</small>
                </div>
              </div>
            ) : (
              status.devices.map((d) => (
                <div className="set-row int-item compact" key={d.id}>
                  <span className="int-glyph" aria-hidden="true">
                    {d.kind === "desktop" ? <Monitor size={14} /> : <Smartphone size={14} />}
                  </span>
                  <div className="set-label">
                    {renaming?.id === d.id ? (
                      <form
                        className="host-rename"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void rename();
                        }}
                      >
                        <input aria-label={"Name for " + d.name} value={renaming.name} maxLength={60} autoFocus onChange={(e) => setRenaming({ id: d.id, name: e.target.value })} />
                        <button type="submit" className="set-button" disabled={busy || !renaming.name.trim()}>
                          Save
                        </button>
                        <button type="button" className="set-button" onClick={() => setRenaming(null)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <span className="set-name">{d.name}</span>
                    )}
                    <small className="int-line">
                      {d.kind === "desktop" ? "Computer" : "Phone"} · {d.connected ? "Connected" : "Last seen " + when(d.lastSeenAt)}
                    </small>
                    {/* What the person chose on that phone, shown here so it can be seen from the computer. */}
                    {d.kind !== "desktop" && <small className="int-line">{notified(status, d.id)}</small>}
                    {d.kind !== "desktop" && <small className="int-line">{shared(status, d.id)}</small>}
                  </div>
                  <div className="set-control">
                    <button type="button" className="set-button" disabled={busy} aria-label={"Rename " + d.name} onClick={() => setRenaming({ id: d.id, name: d.name })}>
                      Rename
                    </button>
                    <button type="button" className="set-button danger" disabled={busy} aria-label={"Remove " + d.name} onClick={() => void remove(d)}>
                      <Trash2 size={13} aria-hidden="true" />
                      Remove
                    </button>
                  </div>
                </div>
              ))
            )}
          </Group>
        </>
      )}
      {dialogs.node}
    </div>
  );
}
