// What this phone keeps for its own voice: the phone's voice and speed when "This phone" reads
// aloud. The other choices are the computer's (`usePart("voice")`), shared by every phone.
import { keep, readKept } from "@/state/keep";
import { create } from "zustand";

const KEY = "botkins.voicePrefs.v1";

export type PhoneVoicePrefs = {
  /** An `identifier` from expo-speech's voices, or undefined for the phone's default. */
  voice?: string;
  /** 0.5 to 2. */
  speed: number;
};

export const usePhoneVoice = create<PhoneVoicePrefs>(() => ({ speed: 1 }));

let loading: Promise<void> | null = null;
export function loadPhoneVoice(): Promise<void> {
  loading ??= (async () => {
    try {
      const saved = await readKept(KEY);
      if (saved) usePhoneVoice.setState({ speed: 1, ...(JSON.parse(saved) as Partial<PhoneVoicePrefs>) });
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

void loadPhoneVoice();
