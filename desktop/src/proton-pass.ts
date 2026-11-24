import { useEffect, useRef, useState } from "react";
import type { PasswordManagerStatus } from "./types";

export const PROTON_CAPABILITY = "proton-pass-setup-v1";
export const supportsProtonSetup = (capabilities?: readonly string[]) => capabilities?.includes(PROTON_CAPABILITY) === true;
export const isUnsharedProtonVault = (message?: string) => message?.startsWith("Not shared with Botkins") === true;
export const PROTON_DISCONNECT = "Disconnect removes Botkins' access on Proton. Your Proton session and linked credentials stay.";
export const PROTON_GUIDE = "https://protonpass.github.io/pass-cli/get-started/installation/";
export type ProtonStep = "page" | "extra-password" | "choose-vaults" | "setting-up";
export type ProtonStatusFields = {
  setup?: boolean;
  source?: "managed" | "path";
  expiresAt?: number;
  sharedVaults?: string[];
  step?: ProtonStep;
  code?: "plan" | "offline" | "install-failed" | "needs-update" | "keyring" | "unknown";
  unsupported?: boolean;
};
export type ProtonPlan = { version: string; url: string; sha256: string; destination: string; sizeBytes?: number };
export type ProtonSession = { session: string };
export type ProtonVault = { id: string; name: string; suggested?: boolean };
export type ProtonInput = { extraPassword: string } | { vaultIds: string[]; createDedicated?: boolean };
export type ProtonEvent =
  | { type: "open"; url: string }
  | { type: "extra-password"; attempt: number }
  | { type: "choose-vaults"; vaults: ProtonVault[] }
  | { type: "step"; name: ProtonStep };
export type ProtonRead = { done: boolean; next: number; events: ProtonEvent[]; error?: string; result?: PasswordManagerStatus };

export const protonConsent = (plan: ProtonPlan) =>
  `Botkins will download Proton's pass-cli ${plan.version} from ${plan.url}, check it matches SHA-256 ${plan.sha256}, and keep it at ${plan.destination}. Botkins runs it only to read fields you link.`;

export function protonBadge(status: PasswordManagerStatus) {
  switch (status.state) {
    case "missing": return status.unsupported ? "Not supported" : "Not installed";
    case "installing": return "Installing";
    case "signed-out": return "Signed out";
    case "signing-in": return "Signing in";
    case "ready": return "Ready";
    case "expiring": return "Expiring soon";
    case "expired": return "Expired";
    case "error": return "Problem";
    default: return "Locked";
  }
}

export function protonAction(status: PasswordManagerStatus) {
  if (status.unsupported || status.state === "installing" || status.state === "signing-in") return undefined;
  if (status.state === "missing" || status.code === "install-failed" || status.code === "needs-update") return "Set up";
  if (status.state === "ready") return "Browse";
  if (status.state === "expiring") return "Renew";
  return status.state === "expired" ? "Sign in again" : "Sign in with Proton";
}

export function protonDate(time: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(time);
}

function safeProtonPage(url: string) {
  if (!/^https:\/\/(?:[a-z0-9-]+\.)*account\.proton\.me(?:[/?#]|$)/i.test(url) || /[\\\s]/.test(url)) return undefined;
  return url;
}

export async function sendProtonPassword(read: () => string, clear: () => void, send: (password: string) => Promise<void>) {
  let value = read();
  clear();
  if (!value) throw new Error("Enter your Proton Pass extra password.");
  try {
    await send(value);
  } finally {
    value = "";
  }
}

export type ProtonCalls = {
  plan: () => Promise<ProtonPlan>;
  install: (input: { sha256: string }) => Promise<ProtonSession>;
  start: (input: { renew?: boolean }) => Promise<ProtonSession>;
  read: (input: ProtonSession & { after?: number }) => Promise<ProtonRead>;
  input: (input: ProtonSession & ProtonInput) => Promise<object>;
  cancel: (input: ProtonSession) => Promise<object>;
  disconnect: (input: { deleteAgent: true }) => Promise<PasswordManagerStatus & Partial<ProtonSession>>;
};

export type ProtonMode = "install" | "sign-in" | "disconnect";
export type ProtonView = {
  mode: ProtonMode;
  phase?: ProtonStep;
  plan?: ProtonPlan;
  url?: string;
  attempt?: number;
  vaults?: ProtonVault[];
  error?: string;
  result?: PasswordManagerStatus;
  started?: boolean;
  finished?: boolean;
};
type Task = { session?: ProtonSession; closed?: boolean };
const message = (error: unknown) => error instanceof Error ? error.message : "Something went wrong with Proton Pass. Try again.";
const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 400));

export function useProtonSetup(calls: ProtonCalls, update: (status: PasswordManagerStatus) => void) {
  const [view, setView] = useState<ProtonView>();
  const [sending, setSending] = useState(false);
  const task = useRef<Task>(undefined);
  const updateRef = useRef(update);
  updateRef.current = update;

  useEffect(() => () => {
    const active = task.current;
    if (active) {
      active.closed = true;
      if (active.session) void calls.cancel(active.session).catch(() => {});
    }
  }, [calls]);

  const patch = (active: Task, fields: Partial<ProtonView>) => {
    if (!active.closed && task.current === active) setView((current) => current && { ...current, ...fields });
  };

  async function follow(active: Task, starting: Promise<ProtonSession>) {
    try {
      active.session = await starting;
      if (active.closed) {
        await calls.cancel(active.session);
        return;
      }
      for (let after = 0; !active.closed; ) {
        const read = await calls.read({ ...active.session, after });
        if (active.closed) return;
        const fields: Partial<ProtonView> = {};
        for (const event of read.events) {
          switch (event.type) {
            case "step": fields.phase = event.name; break;
            case "open": fields.url = safeProtonPage(event.url); break;
            case "extra-password": fields.attempt = event.attempt; break;
            case "choose-vaults": fields.vaults = event.vaults; break;
          }
        }
        if (read.done) {
          active.session = undefined;
          if (read.result) updateRef.current(read.result);
          patch(active, { ...fields, result: read.error ? undefined : read.result, error: read.error, finished: true });
          return;
        }
        patch(active, fields);
        after = read.next;
        await wait();
      }
    } catch (error) {
      patch(active, { error: message(error) });
    }
  }

  function begin(mode: ProtonMode, renew = false) {
    if (task.current && !task.current.closed) return;
    const active: Task = {};
    task.current = active;
    setView({ mode, started: mode === "sign-in", ...(mode === "sign-in" && { phase: "page" }) });
    if (mode === "install") void calls.plan().then((plan) => patch(active, { plan }), (error) => patch(active, { error: message(error) }));
    if (mode === "sign-in") void follow(active, calls.start({ renew }));
  }

  function confirm() {
    const active = task.current;
    if (!active || !view || view.started) return;
    if (view.mode === "install" && view.plan) {
      patch(active, { started: true });
      void follow(active, calls.install({ sha256: view.plan.sha256 }));
    } else if (view.mode === "disconnect") {
      patch(active, { started: true, phase: "page" });
      void calls.disconnect({ deleteAgent: true }).then((status) => {
        if (status.session) void follow(active, Promise.resolve({ session: status.session }));
        else if (!active.closed) {
          updateRef.current(status);
          patch(active, { result: status });
        }
      }, (error) => patch(active, { error: message(error) }));
    }
  }

  async function answer(input: ProtonInput) {
    const active = task.current;
    if (!active?.session || sending || !view) return;
    const phase = view.phase;
    const sentAttempt = view.attempt;
    setSending(true);
    const request = { ...active.session, ...input };
    try {
      patch(active, { error: undefined });
      await calls.input(request);
      if (!active.closed) {
        setView((latest) => latest?.phase === phase && latest?.attempt === sentAttempt
          ? { ...latest!, phase: "setting-up" } : latest);
      }
    } finally {
      if ("extraPassword" in request) request.extraPassword = "";
      if (!active.closed) setSending(false);
    }
  }

  async function close() {
    const active = task.current;
    if (active) {
      try {
        if (active.session) await calls.cancel(active.session);
      } catch (error) {
        patch(active, { error: message(error) });
        return;
      }
      active.closed = true;
    }
    setSending(false);
    setView(undefined);
  }

  return { view, sending, begin, confirm, answer, close, fail: (error: unknown) => {
    if (task.current) patch(task.current, { error: message(error) });
  } };
}
