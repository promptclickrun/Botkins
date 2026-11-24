// A handoff on one computer cancels its pending stop. A delayed cleanup can never stop another computer.
import { api } from "@/state/link";
import { useApp } from "@/state/store";
import { screenWatchers, STOP_AFTER_MS } from "./screenLive";

/** Closing access or switching hosts discards local pictures and any viewer authorization. */
export const useScreenKey = () => useApp(state => state.parts.host && state.parts.host.screen !== "off" ? state.pairing?.serverId : undefined);

let current: { computer: string; watch: ReturnType<typeof screenWatchers> } | undefined;
export function holdScreen(computer: string) {
  if (current?.computer !== computer) {
    const watch = screenWatchers(() => {
      const state = useApp.getState();
      if (current?.watch === watch && state.pairing?.serverId === computer && state.link === "online") void api["link.screen.stop"]().catch(() => {});
    }, STOP_AFTER_MS);
    current = { computer, watch };
  }
  return current.watch.hold();
}
