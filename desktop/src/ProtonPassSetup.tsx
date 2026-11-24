import { useRef, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { Sheet } from "./SettingsRows";
import type { PasswordManagerStatus } from "./types";
import { PROTON_DISCONNECT, PROTON_GUIDE, protonAction, protonBadge, protonConsent, protonDate, sendProtonPassword, useProtonSetup, type ProtonCalls } from "./proton-pass";

const api = window.botkins;
export const protonCalls: ProtonCalls = {
  plan: () => api.protonPassInstallPlan(),
  install: (input) => api.protonPassInstall(input),
  start: (input) => api.protonPassSignInStart(input),
  read: (input) => api.protonPassSignInRead(input),
  input: (input) => api.protonPassSignInInput(input),
  cancel: (input) => api.protonPassSignInCancel(input),
  disconnect: (input) => api.protonPassDisconnect(input),
};

type Setup = ReturnType<typeof useProtonSetup>;

export function ProtonManagerRow({ status, setup, browse, locked }: { status: PasswordManagerStatus; setup: Setup; browse: () => void; locked: boolean }) {
  const action = protonAction(status);
  const connected = status.expiresAt !== undefined;
  const guide = () => void api.openLink(PROTON_GUIDE);
  return (
    <div className="set-row scred-manager" role="group" aria-label="Proton Pass">
      <span className="scred-mark" aria-hidden="true"><LockKeyhole size={17} /></span>
      <div className="set-label">
        <span className="int-title">
          <span className="set-name">Proton Pass</span>
          <span className={"set-pill " + (status.state === "ready" ? "good" : status.state === "expired" || status.state === "error" ? "bad" : "quiet")}>{protonBadge(status)}</span>
        </span>
        {!!status.message && <small>{status.message}</small>}
        {status.account && <small>{status.account}</small>}
        {(status.state === "installing" || status.state === "signing-in") && <small>Setup is in progress on another screen.</small>}
        {status.unsupported && <button className="set-link" type="button" onClick={guide}>Install guide</button>}
        {connected && (
          <>
            <small>Shared vaults: {status.sharedVaults?.join(", ")}{" "}
              <button className="set-link" type="button" disabled={locked} onClick={() => setup.begin("sign-in", true)}>Change</button>
            </small>
            <small>Access ends {protonDate(status.expiresAt!)}</small>
            <small>
              {status.state === "expiring" && <button className="set-link" type="button" disabled={locked} onClick={browse}>Browse</button>}{" "}
              <button className="set-link" type="button" disabled={locked} onClick={() => setup.begin("disconnect")}>Disconnect</button>
            </small>
          </>
        )}
      </div>
      {!!action && <div className="set-control"><button type="button" className="set-button primary" disabled={locked} onClick={
        action === "Browse" ? browse : () => setup.begin(action === "Set up" ? "install" : "sign-in", action === "Renew")
      }>{action}</button></div>}
    </div>
  );
}

export function ProtonPassSheet({ setup }: { setup: Setup }) {
  const { view, sending, confirm, answer, close, fail } = setup;
  const secret = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [dedicated, setDedicated] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!view) return null;
  const ids = view.vaults?.filter((v) => picked[v.id] ?? v.suggested).map((v) => v.id) ?? [];
  const submitPassword = () => void sendProtonPassword(
    () => secret.current?.value ?? "",
    () => { if (secret.current) secret.current.value = ""; },
    (extraPassword) => answer({ extraPassword }),
  ).catch(fail);
  const closeSheet = () => {
    if (secret.current) secret.current.value = "";
    void close();
  };
  const ask = view.finished ? undefined : view.phase === "extra-password" ? submitPassword : view.phase === "choose-vaults"
    ? () => { if (ids.length || dedicated) void answer({ vaultIds: ids, createDedicated: dedicated }).catch(fail); }
    : view.started ? undefined : confirm;
  const label = view.phase === "extra-password" ? "Continue" : view.phase === "choose-vaults" ? "Share vaults"
    : view.mode === "install" ? "Install" : "Disconnect";
  const title = view.mode === "install" ? "Set up Proton Pass" : view.mode === "disconnect" ? "Disconnect Proton Pass" : "Sign in with Proton";
  return (
    <Sheet title={title} close={closeSheet} submit={() => { if (!sending && !view.result) ask?.(); }} footer={
      <>
        {!!view.error && <span className="int-sheet-error" role="alert">{view.error}</span>}
        <button type="button" className="set-button" onClick={closeSheet}>{view.result ? "Done" : view.finished ? "Close" : "Cancel"}</button>
        {!view.result && !!ask && <button className="set-button primary" disabled={sending || (view.mode === "install" && !view.plan) ||
          (view.phase === "choose-vaults" && !ids.length && !dedicated)}>{label}</button>}
      </>
    }>
      {view.result ? (
        <>
          <p role="status">{view.mode === "install" ? "Proton Pass is installed." : view.mode === "disconnect" ? "Proton Pass is disconnected." : "Proton Pass is connected."}</p>
          {view.result.account && <p>{view.result.account}</p>}
          {!!view.result.sharedVaults?.length && <p>Shared vaults: {view.result.sharedVaults.join(", ")}</p>}
          {view.result.expiresAt !== undefined && <p>Access ends {protonDate(view.result.expiresAt)}</p>}
        </>
      ) : view.finished ? null : view.mode === "install" ? (
        <>
          <p style={{ overflowWrap: "anywhere" }}>{view.started ? "Installing Proton Pass…" : view.plan ? protonConsent(view.plan) : "Checking the install plan…"}</p>
          {!view.started && <button type="button" className="set-link" onClick={() => void api.openLink(PROTON_GUIDE).catch(fail)}>I'll install it myself</button>}
        </>
      ) : !view.started ? <p>{PROTON_DISCONNECT}</p>
        : view.phase === "extra-password" ? (
          <>
            {(view.attempt ?? 0) > 1 && <p>Proton didn't accept that extra password. Try again.</p>}
            <label>Proton Pass extra password <input key={view.attempt} ref={secret} type="password" autoComplete="off" autoFocus disabled={sending} /></label>
          </>
        ) : view.phase === "choose-vaults" ? (
          <fieldset>
            <legend>Choose vaults to share with Botkins</legend>
            {(view.vaults ?? []).map((vault) => <label key={vault.id} style={{ display: "block" }}>
              <input type="checkbox" checked={picked[vault.id] ?? vault.suggested ?? false} onChange={(event) => setPicked({ ...picked, [vault.id]: event.target.checked })} /> {vault.name}
            </label>)}
            <label style={{ display: "block" }}><input type="checkbox" checked={dedicated} onChange={(event) => setDedicated(event.target.checked)} /> Create a vault for Botkins</label>
          </fieldset>
        ) : view.phase === "setting-up" ? <p role="status">Setting up Proton Pass…</p> : (
          <>
            <p>Open Proton's page</p>
            <p role="status">Waiting for you to finish signing in on Proton's page.</p>
            {!!view.url && <div className="set-control">
              <button type="button" className="set-button primary" onClick={() => void api.openLink(view.url!).catch(fail)}>Open</button>
              <button type="button" className="set-button" onClick={() => void api.copyText(view.url!).then(() => setCopied(true), fail)}>{copied ? "Copied" : "Copy link"}</button>
            </div>}
          </>
        )}
    </Sheet>
  );
}
