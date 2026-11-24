import { useEffect, useState } from "react";
import type { ProfileState, State } from "./types";
import { Group, errorText } from "./SettingsRows";

const api = window.botkins;
const PROFILE_AVATARS = ["", "🌱", "🌊", "🌙", "☀️", "🦊", "🐈", "🌻", "🪐"];

function ProfileCard({ state, migration = false }: { state: State; migration?: boolean }) {
  const profile = state.profile;
  const [label, setLabel] = useState("This device");
  const [profileName, setProfileName] = useState(profile?.profile?.name ?? "");
  const [profileAvatar, setProfileAvatar] = useState(profile?.profile?.avatar ?? "");
  const [deleteEmail, setDeleteEmail] = useState("");
  const [code, setCode] = useState("");
  const [attempt, setAttempt] = useState<ProfileState["pending"]>(profile?.pending ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (profile?.signedIn && profile.profile) {
      setProfileName(profile.profile.name);
      setProfileAvatar(profile.profile.avatar ?? "");
    }
  }, [profile?.signedIn, profile?.profile?.profileId, profile?.profile?.name, profile?.profile?.avatar]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const start = () => void run(async () => {
    const next = await api.profileStart(label.trim() || "This device");
    setAttempt({ id: next.id, code: next.code, url: next.url, label: next.label });
    setNote("Complete the passkey step first, then the trusted-device or email step in your browser. Return here when both are done.");
  });
  const finish = () => void run(async () => {
    const next = await api.profileFinish();
    if (next) setNote("Profile connected.");
    else setNote("The browser step is not finished yet. Return here when it is ready and choose Finish again.");
  });
  if (profile?.signedIn && profile.profile) {
    return (
      <>
        <Group title="Your profile" footer="Your profile account is separate from each computer's local bots and chats.">
          <div className="set-row">
            <div className="set-label">
              <span className="set-name">{profile.profile.avatar ? profile.profile.avatar + " " : ""}{profile.profile.name}</span>
              <small>{profile.profile.email || "Signed in"}</small>
            </div>
            <div className="set-control"><button type="button" className="set-button" disabled={busy} onClick={() => void run(() => api.profileRefresh())}>Refresh</button></div>
          </div>
          <div className="set-row stacked">
            <label className="set-label" htmlFor="profile-name"><span className="set-name">Profile name</span><small>Shown to people approving or pairing this device.</small></label>
            <input id="profile-name" className="set-input" value={profileName} maxLength={60} onChange={(e) => setProfileName(e.target.value)} />
            <label className="set-label" htmlFor="profile-avatar"><span className="set-name">Avatar</span><small>Optional emoji shared with your profile devices.</small></label>
            <select id="profile-avatar" className="set-input" value={profileAvatar} onChange={(e) => setProfileAvatar(e.target.value)}>{PROFILE_AVATARS.map((avatar) => <option key={avatar || "none"} value={avatar}>{avatar || "No avatar"}</option>)}</select>
            <button type="button" className="set-button primary" disabled={busy || !profileName.trim()} onClick={() => void run(async () => { await api.profileUpdate(profileName.trim(), profileAvatar.trim()); setNote("Profile identity updated."); })}>Save profile</button>
          </div>
        </Group>
        <Group title="Computers" footer="Offline computers remain listed and will retry binding when they are reachable.">
          {(profile.hosts.length ? profile.hosts : [{ serverId: "empty", name: "No computers yet", hosts: [], serverKey: "" }]).map((host) => (
            <div className="set-row" key={host.serverId}>
              <div className="set-label"><span className="set-name">{host.name}</span><small>{host.hosts.length ? host.hosts.join(" · ") : host.serverId === "empty" ? "Connect another computer to add it" : "Offline or unavailable"}{host.member ? " · Team member" : ""}</small></div>
            </div>
          ))}
        </Group>
        <Group title="Trusted devices" footer="Approve a device only when you recognize its short code. Revoking removes its profile access without unpairing local computers.">
          {profile.devices.map((device) => (
            <div className="set-row" key={device.id}>
              <div className="set-label"><span className="set-name">{device.label}</span><small>{device.current ? "This device" : device.id}</small></div>
              <div className="set-control">{device.current ? <span className="set-status">Current</span> : <button type="button" className="set-button" disabled={busy} onClick={() => void run(() => api.profileRevoke(device.id))}>Revoke</button>}</div>
            </div>
          ))}
          {profile.pendingDevices.map((device) => (
            <div className="set-row" key={device.id}>
              <div className="set-label"><span className="set-name">{device.label}</span><small>Waiting for approval</small></div>
              <div className="set-control"><input className="set-input" aria-label={"Short code for " + device.label} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Short code" /><button type="button" className="set-button" disabled={busy || !code.trim()} onClick={() => void run(() => api.profileApprove(device.id, code.trim()))}>Approve</button></div>
            </div>
          ))}
          {!profile.devices.length && !profile.pendingDevices.length && <div className="set-row"><small className="set-status">No other devices.</small></div>}
        </Group>
        {error && <small className="host-error host-note" role="alert">{error}</small>}
        {note && <small className="host-note" role="status">{note}</small>}
        <Group title="This computer" footer="Disconnecting removes only this computer from the hosted directory. It does not sign out the account or delete local bots and chats.">
          <div className="set-actions">{profile.localDisconnected ? <button type="button" className="set-button primary" disabled={busy} onClick={() => void run(() => api.profileReconnect())}>Connect this host to profile</button> : <button type="button" className="set-button" disabled={busy} onClick={() => void run(() => api.profileDisconnect())}>Disconnect this host from profile</button>}</div>
        </Group>
        <Group title="Delete profile" footer="This permanently deletes the hosted profile. Local bots, chats, and unrelated manual pairings stay on this computer.">
          <div className="set-row stacked">
            <label className="set-label" htmlFor="profile-delete-email"><span className="set-name">Verified email</span><small>Type {profile.profile.email || "your signed-in email"} to confirm.</small></label>
            <input id="profile-delete-email" className="set-input" type="email" maxLength={254} value={deleteEmail} onChange={(e) => setDeleteEmail(e.target.value)} />
            <button type="button" className="set-button" disabled={busy || !deleteEmail.trim()} onClick={() => { if (window.confirm("Delete this hosted Botkins profile permanently?")) void run(() => api.profileDeleteAccount(deleteEmail.trim())); }}>Delete profile</button>
          </div>
        </Group>
        <div className="set-actions"><button type="button" className="set-button" disabled={busy} onClick={() => void run(() => api.profileSignOut())}>Sign out of profile</button></div>
      </>
    );
  }
  return (
    <>
      <Group title={migration ? "Link your existing computers" : "Optional profile"} footer="A profile lets you find and reconnect your computers. It does not move bots or chats off this computer.">
        {migration && <p className="set-copy">This installation has existing bots or chats. Set up a profile to link your existing computers, or continue without a profile. Without one, this workspace stays here and you’ll pair each device separately.</p>}
        {!migration && <p className="set-copy">Without a profile this computer stays local-only: each other device must be paired separately, and there is no shared computer directory or continuity.</p>}
        <div className="set-row stacked">
          <label className="set-label" htmlFor="profile-device-label"><span className="set-name">Device name</span><small>Shown when you approve this device.</small></label>
          <input id="profile-device-label" className="set-input" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
          <button type="button" className="set-button primary" disabled={busy} onClick={start}>{attempt ? "Open profile page again" : "Set up profile"}</button>
          {attempt && <div className="set-status">Enter code <strong>{attempt.code || "shown in the app"}</strong> at profile.botkins.app, then choose Finish here.</div>}
          {attempt && <div className="set-actions"><button type="button" className="set-button primary" disabled={busy} onClick={() => void run(() => api.profileOpen())}>Open browser</button><button type="button" className="set-button" disabled={busy} onClick={finish}>Finish</button></div>}
        </div>
      </Group>
      {error && <small className="host-error host-note" role="alert">{error}</small>}
      {note && <small className="host-note" role="status">{note}</small>}
      <div className="set-actions"><button type="button" className="set-button" disabled={busy} onClick={() => void run(() => api.profileOptOut())}>Continue without a profile</button></div>
    </>
  );
}

export default function ProfileSettings({ state }: { state: State }) {
  return <ProfileCard state={state} />;
}

export function ProfileSetupInline({ state, migration = false }: { state: State; migration?: boolean }) {
  if (state.profile?.signedIn) return <ProfileComputersInline state={state} />;
  if (state.profile?.optedOut) return null;
  return <ProfileCard state={state} migration={migration} />;
}

function ProfileComputersInline({ state }: { state: State }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const paired = new Set((state.remote?.hosts ?? []).map((host) => host.id));
  const hosts = state.profile?.hosts ?? [];
  const connect = async (host: ProfileState["hosts"][number]) => {
    setBusy(true);
    setError("");
    try {
      const result = paired.has(host.serverId) ? { id: host.serverId } : await api.profileConnect(host.serverId);
      await api.useRemoteHost(result.id);
      await api.setPreferences({ onboarded: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group title="Your Botkins profile" footer="Choose a listed computer to open its bots here. You can switch back later in Settings.">
      {hosts.length ? hosts.map((host) => (
        <div className="set-row" key={host.serverId}>
          <div className="set-label"><span className="set-name">{host.name}</span><small>{paired.has(host.serverId) ? "Paired on this device" : "Listed in profile · may be offline"}</small></div>
          <div className="set-control"><button type="button" className="set-button primary" disabled={busy} onClick={() => void connect(host)}>Open</button></div>
        </div>
      )) : <div className="set-row"><small className="set-status">No profile computers are listed yet.</small></div>}
      {error && <small className="host-error host-note" role="alert">{error}</small>}
    </Group>
  );
}

export function ProfileMigrationPrompt({ state }: { state: State }) {
  return <ProfileSetupInline state={state} migration />;
}
