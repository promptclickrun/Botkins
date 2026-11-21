// What this phone keeps for its own voice: the phone's voice and speed when "This phone" reads
// aloud, and how live voice listens on this phone. The other choices are the computer's (`usePart("voice")`), shared by every phone.
import { keep, readKept } from "@/state/keep";
import { create } from "zustand";

const KEY = "botkins.voicePrefs.v1";

export type PhoneVoicePrefs = {
  /** An `identifier` from expo-speech's voices, or undefined for the phone's default. */
  voice?: string;
  /** 0.5 to 2. */
  speed: number;
  /**
   * How live voice listens on this phone. "conversation": hands-free, it listens while you talk.
   * "push": it listens only while you hold the talk button.
   */
  liveInput: "conversation" | "push";
  /** A bot's own system voice and speed on this phone, by bot id. A system voice is not portable, so each phone keeps its own choice for a bot that reads with "This phone". */
  bots?: Record<string, BotDeviceVoice>;
};
export type BotDeviceVoice = { voice?: string; speed?: number };

const DEFAULTS: PhoneVoicePrefs = { speed: 1, liveInput: "conversation" };
export const usePhoneVoice = create<PhoneVoicePrefs>(() => DEFAULTS);

let loading: Promise<void> | null = null;
export function loadPhoneVoice(): Promise<void> {
  loading ??= (async () => {
    try {
      const saved = await readKept(KEY);
      if (saved) usePhoneVoice.setState({ ...DEFAULTS, ...(JSON.parse(saved) as Partial<PhoneVoicePrefs>) });
    } catch {
      // The defaults stand.
    }
  })();
  return loading;
}

export function setPhoneVoice(patch: Partial<PhoneVoicePrefs>) {
  usePhoneVoice.setState(patch);
  void loadPhoneVoice().then(() => {
    usePhoneVoice.setState(patch);
    return keep(KEY, JSON.stringify(usePhoneVoice.getState())).catch(() => {});
  });
}

/** This phone's own voice for one bot. A field set to undefined goes back to the phone's voice from Settings; nothing left forgets the bot. */
export function setBotDeviceVoice(botId: string, patch: BotDeviceVoice) {
  const bots = { ...usePhoneVoice.getState().bots };
  const next = Object.fromEntries(Object.entries({ ...bots[botId], ...patch }).filter(([, value]) => value !== undefined));
  if (Object.keys(next).length) bots[botId] = next;
  else delete bots[botId];
  setPhoneVoice({ bots });
}

void loadPhoneVoice();
