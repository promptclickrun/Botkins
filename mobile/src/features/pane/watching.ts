// Who shows the computer's screen on this phone (the rule is screenWatchers in screenLive.ts): the
// chat's screen cards, the side pane's screen tab, and Settings › Screen. When the last card or tab
// lets go, the computer is told once that this phone stopped watching.
import { api } from "@/state/link";
import { screenWatchers, STOP_AFTER_MS } from "./screenLive";

export const screenWatch = screenWatchers(() => void api["link.screen.stop"]().catch(() => {}), STOP_AFTER_MS);
