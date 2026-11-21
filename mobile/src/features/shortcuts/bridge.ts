import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";
import { AppState } from "react-native";

type Fields = {
  id: string;
  action: "catalog" | "send" | "voice";
  host?: string;
  bot?: string;
  modelHost?: string;
  model?: string;
  effort?: string;
  prompt?: string;
  wait?: string;
  notify?: string;
  models?: string;
};
type Native = {
  take(voice: boolean): Promise<Fields[]>;
  isPending(id: string): Promise<boolean>;
  finish(id: string, result: string, error: string | null): Promise<void>;
  addListener(name: "changed", fn: (event: { finished: string }) => void): EventSubscription;
};
const native = requireOptionalNativeModule<Native>("BotkinsShortcuts");

async function run(fields: Fields, signal: AbortSignal): Promise<string> {
  if (fields.action === "voice") {
    const { startVoiceShortcut } = await import("./voice");
    await startVoiceShortcut(fields.host, fields.bot, signal);
    return "";
  }
  const { shortcutLink } = await import("@/state/link");
  const { sendShortcut, shortcutCatalog } = await import("./chat");
  const { host, name, link } = await shortcutLink(fields.host);
  try {
    signal.throwIfAborted();
    if (fields.action === "catalog") return JSON.stringify({ host, name, ...(await shortcutCatalog(link, fields.models === "yes")) });
    if (fields.modelHost && fields.modelHost !== host) throw new Error("Choose a model from the agent’s computer.");
    return await sendShortcut(link, { ...fields, prompt: fields.prompt ?? "", wait: fields.wait === "yes", notify: fields.notify !== "no" }, signal);
  } finally {
    link.stop();
  }
}

/** Voice is claimed only by a mounted scene. Text and picker queries can run in the background. */
export function listenForShortcuts(voice: boolean) {
  if (!native) return;
  const bridge = native;
  const active = new Map<string, AbortController>();
  async function drain() {
    if (voice && AppState.currentState !== "active") return;
    for (const request of await bridge.take(voice)) {
      const controller = new AbortController();
      active.set(request.id, controller);
      // A cancellation can arrive between the native claim and its delivery to JS.
      void (async () => {
        try {
          if (await bridge.isPending(request.id)) {
            const value = await run(request, controller.signal);
            await bridge.finish(request.id, value, null);
          }
        } catch (error) {
          await bridge.finish(request.id, "", error instanceof Error ? error.message : "The shortcut could not finish.");
        } finally {
          active.delete(request.id);
        }
      })();
    }
  }
  const sub = bridge.addListener("changed", event => {
    if (event.finished) active.get(event.finished)?.abort();
    else void drain();
  });
  const foreground = voice ? AppState.addEventListener("change", state => { if (state === "active") void drain(); }) : undefined;
  void drain();
  return () => {
    foreground?.remove();
    sub.remove();
  };
}
