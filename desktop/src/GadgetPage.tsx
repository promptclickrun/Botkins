import { useEffect, useState } from "react";
import { Check, ChevronLeft } from "lucide-react";
import type { GadgetSettings, PhoneLink, State } from "./types";
import { BotAvatar } from "./Avatar";
import { useAsk } from "./Pages";
import { Choices } from "./Preferences";
import { Group, Row, Sheet, SwitchRow, ValueRow, errorText } from "./SettingsRows";
import { when } from "./wikiModel";
import { BRIGHTNESS, DIM_CHOICES, MIC_CHOICES, OFF_CHOICES, VOLUME, firmwareLabel, headerLine, lookAgainMs, networkProblem, passwordProblem, shownSettings, talksWith, timerOptions, wifiRows } from "./gadgetSettings";

const api = window.botkins;

type Device = PhoneLink["devices"][number];

/**
 * A gadget's page in Settings › Phone ("gadget-settings-v1"): the bot it talks with, its sound and
 * screen, its Wi-Fi networks, rename, restart and remove. The same groups, words and calls as the
 * phone's page (mobile/src/features/settings/GadgetPage.tsx); the plain logic is gadgetSettings.ts.
 *
 * Every change answers what Settings › Phone shows, and that is what the page shows. A slider sends
 * once, when it is let go. A Wi-Fi password lives only in its field and leaves it as it is sent.
 */
export default function GadgetSettingsPage({ device, state, back, onStatus }: { device: Device; state: State; back: () => void; onStatus: (status: PhoneLink) => void }) {
  const gadget = device.gadget;
  const [held, setHeld] = useState<Partial<GadgetSettings>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const dialogs = useAsk();
  const settings = shownSettings(gadget, held);
  const saved = shownSettings(gadget);
  const bots = state.bots;
  const bot = talksWith(bots, gadget?.botId);
  const wait = lookAgainMs(gadget);

  // The gadget changes its own settings and takes Wi-Fi changes by itself: look again while the page is open.
  useEffect(() => {
    const timer = setInterval(() => void api.phoneLink().then(onStatus, () => {}), wait);
    return () => clearInterval(timer);
  }, [wait]);

  async function run(fn: () => Promise<PhoneLink>) {
    setError("");
    setBusy(true);
    try {
      onStatus(await fn());
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function configure(patch: Partial<GadgetSettings> & { botId?: string }) {
    const { botId: _botId, ...shown } = patch;
    setHeld((was) => ({ ...was, ...shown }));
    await run(() => api.configureGadget(device.id, patch));
    setHeld((was) => {
      const rest = { ...was };
      for (const key of Object.keys(shown) as (keyof GadgetSettings)[]) delete rest[key];
      return rest;
    });
  }
  /** A slider's value on show while it moves; sent once when it is let go (the pointer is up, or a key). */
  const slide = (key: "volume" | "brightness") => {
    const send = () => {
      const value = settings[key];
      if (held[key] === undefined) return;
      if (value !== saved[key]) void configure({ [key]: value });
      else
        setHeld((was) => {
          const { [key]: _gone, ...rest } = was;
          return rest;
        });
    };
    return {
      onChange: (e: { target: { value: string } }) => setHeld((was) => ({ ...was, [key]: Number(e.target.value) })),
      onPointerUp: send,
      onKeyUp: send,
    };
  };
  async function forget(ssid: string) {
    const ok = await dialogs.ask({ title: "Forget " + ssid + "?", body: "The gadget won't join it again.", confirm: "Forget", danger: true });
    if (ok) await run(() => api.gadgetWifi(device.id, { forget: ssid }));
  }
  async function rename() {
    const name = renaming?.trim();
    if (!name) return;
    if (name !== device.name && !(await run(async () => (await api.renamePhone(device.id, name), api.phoneLink())))) return;
    setRenaming(null);
  }
  async function remove() {
    const ok = await dialogs.ask({ title: "Remove " + device.name + "?", body: "It can't reach your computer until it is set up again.", confirm: "Remove", danger: true });
    if (ok && (await run(async () => (await api.removePhone(device.id), api.phoneLink())))) back();
  }

  return (
    <div className="gadget-page">
      <nav className="gadget-crumbs">
        <button type="button" className="set-link" onClick={back}>
          <ChevronLeft size={14} aria-hidden="true" />
          Devices
        </button>
      </nav>
      <div className="gadget-head">
        <h2>{device.name}</h2>
        <p>
          <span className={"gadget-dot" + (device.connected ? " on" : "")} aria-hidden="true" />
          {headerLine(device, device.lastSeenAt ? when(device.lastSeenAt) : "")}
        </p>
      </div>
      {error && (
        <p className="set-status error-text" role="alert">
          {error}
        </p>
      )}

      <Group title="Talks with">
        <Row
          label={
            <span className="gadget-bot">
              {bot && <BotAvatar bot={bot} size={32} badge={false} />}
              <span>{bot?.name ?? "No bot"}</span>
            </span>
          }
          help={bot?.role}
        >
          {(id) => (
            <select id={id} aria-label="Talks with" value={bot?.id ?? ""} disabled={busy || !bots.length} onChange={(e) => void configure({ botId: e.target.value })}>
              {bots
                .filter((b) => !b.hidden || b.id === bot?.id)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.role ? " · " + b.role : ""}
                  </option>
                ))}
            </select>
          )}
        </Row>
      </Group>

      <Group title="Sound">
        <Row label="Volume">
          {(id) => (
            <span className="gadget-slider">
              <input id={id} type="range" className="set-range" min={VOLUME.min} max={VOLUME.max} value={settings.volume} disabled={busy && held.volume === undefined} {...slide("volume")} />
              <output htmlFor={id}>{settings.volume}</output>
            </span>
          )}
        </Row>
        <Row label="Microphone">{() => <Choices label="Microphone" value={settings.mic} options={MIC_CHOICES.map((c) => ({ id: c.value, name: c.label }))} onChange={(mic) => mic !== settings.mic && void configure({ mic })} />}</Row>
        <SwitchRow label="Microphone off" checked={settings.mute} disabled={busy} onChange={(mute) => void configure({ mute })} />
      </Group>

      <Group title="Screen">
        <Row label="Brightness">
          {(id) => (
            <span className="gadget-slider">
              <input id={id} type="range" className="set-range" min={BRIGHTNESS.min} max={BRIGHTNESS.max} value={settings.brightness} disabled={busy && held.brightness === undefined} {...slide("brightness")} />
              <output htmlFor={id}>{settings.brightness}%</output>
            </span>
          )}
        </Row>
        <Row label="Dim after">
          {(id) => (
            <select id={id} value={String(settings.dimAfter)} disabled={busy} onChange={(e) => void configure({ dimAfter: Number(e.target.value) })}>
              {timerOptions(DIM_CHOICES, settings.dimAfter).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </Row>
        <Row label="Turn off after">
          {(id) => (
            <select id={id} value={String(settings.offAfter)} disabled={busy} onChange={(e) => void configure({ offAfter: Number(e.target.value) })}>
              {timerOptions(OFF_CHOICES, settings.offAfter).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </Row>
      </Group>

      <Group title="Wi-Fi">
        {wifiRows(gadget).map((row) => (
          <div className="set-row" key={row.ssid}>
            <div className="set-label">
              <span className="set-name">{row.ssid}</span>
              <small>{row.status}</small>
            </div>
            <div className="set-control">
              {row.inUse && !row.waiting && <Check size={15} aria-label="In use" />}
              {row.canForget && (
                <button type="button" className="set-button" disabled={busy} aria-label={"Forget " + row.ssid} onClick={() => void forget(row.ssid)}>
                  Forget…
                </button>
              )}
            </div>
          </div>
        ))}
        <div className="set-row">
          <div className="set-label">
            <button type="button" className="set-link gadget-add" disabled={busy} onClick={() => setAdding(true)}>
              Add a network…
            </button>
          </div>
        </div>
      </Group>

      <Group title="Gadget">
        <div className="set-row">
          <div className="set-label">
            {renaming !== null ? (
              <form
                className="host-rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  void rename();
                }}
              >
                <input aria-label="Gadget's name" value={renaming} maxLength={60} autoFocus onChange={(e) => setRenaming(e.target.value)} />
                <button type="submit" className="set-button" disabled={busy || !renaming.trim()}>
                  Save
                </button>
                <button type="button" className="set-button" onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <span className="set-name">Rename</span>
            )}
          </div>
          {renaming === null && (
            <div className="set-control">
              <button type="button" className="set-button" disabled={busy} onClick={() => setRenaming(device.name)}>
                Rename…
              </button>
            </div>
          )}
        </div>
        <div className="set-row">
          <div className="set-label">
            <span className="set-name">Restart</span>
          </div>
          <div className="set-control">
            <button type="button" className="set-button" disabled={busy || !!gadget?.restarting} onClick={() => void run(() => api.restartGadget(device.id))}>
              {gadget?.restarting ? "Restarting…" : "Restart"}
            </button>
          </div>
        </div>
        <ValueRow label="Firmware" value={firmwareLabel(gadget)} />
      </Group>

      <Group>
        <div className="set-row">
          <div className="set-label">
            <button type="button" className="set-link gadget-remove" disabled={busy} onClick={() => void remove()}>
              Remove gadget…
            </button>
          </div>
        </div>
      </Group>

      {adding && <AddNetwork deviceId={device.id} close={() => setAdding(false)} onStatus={onStatus} />}
      {dialogs.node}
    </div>
  );
}

/** "Add a network…": its name and password. The password is held only in its field and cleared as it is sent. */
function AddNetwork({ deviceId, close, onStatus }: { deviceId: string; close: () => void; onStatus: (status: PhoneLink) => void }) {
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameProblem = ssid ? networkProblem(ssid) : null;
  const keyProblem = passwordProblem(password);
  const ready = !!ssid && !nameProblem && !keyProblem;
  async function send() {
    if (!ready || busy) return;
    const change = { add: { ssid, password } };
    // The typed password leaves the field as it is sent.
    setPassword("");
    setBusy(true);
    setError("");
    try {
      onStatus(await api.gadgetWifi(deviceId, change));
      close();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Add a network"
      close={close}
      submit={() => void send()}
      footer={
        <>
          {error && (
            <span className="int-sheet-error" role="alert">
              {error}
            </span>
          )}
          <button type="button" className="set-button" onClick={close}>
            Cancel
          </button>
          <button className="set-button primary" disabled={busy || !ready}>
            {busy ? "Adding…" : "Add"}
          </button>
        </>
      }
    >
      <label>
        Network
        <input value={ssid} placeholder="Name" autoFocus autoComplete="off" spellCheck={false} onChange={(e) => setSsid(e.target.value)} aria-invalid={!!nameProblem} />
        {nameProblem && <small className="int-sheet-error">{nameProblem}</small>}
      </label>
      <label>
        Password
        <input type="password" value={password} placeholder="None for an open network" autoComplete="off" spellCheck={false} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!(password && keyProblem)} />
        {password && keyProblem ? <small className="int-sheet-error">{keyProblem}</small> : <small className="int-hint">The gadget joins it within 10 minutes.</small>}
      </label>
    </Sheet>
  );
}
