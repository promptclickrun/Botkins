// What the phone keeps for itself between launches: the pairing, and the person's choices.
//
// It is kept in the keychain so that it can be read after the phone has been unlocked once since
// it was turned on, also while it is locked again. The app is started in the background for a
// notification, a Live Activity or a bot's question to the phone, and the phone is usually locked
// then: with the keychain's default ("only while unlocked") the pairing could not be read, the
// computer could not be reached, and nothing that needs it worked until the app was opened.
// "This device only" keeps it out of a backup that is put on another phone: a pairing is this phone's.
import * as SecureStore from "expo-secure-store";

const OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/**
 * Reads a kept value: null when there is none. It throws when the keychain can't be read now (the
 * phone has not been unlocked since it was turned on), which is not the same as "nothing saved".
 * A value saved by an earlier version is saved again, so it can be read while the phone is locked.
 */
export async function readKept(key: string): Promise<string | null> {
  const value = await SecureStore.getItemAsync(key, OPTIONS);
  if (value != null && !moved.has(key)) {
    moved.add(key);
    void SecureStore.setItemAsync(key, value, OPTIONS).catch(() => {});
  }
  return value;
}
const moved = new Set<string>();

export const keep = (key: string, value: string): Promise<void> => {
  moved.add(key);
  return SecureStore.setItemAsync(key, value, OPTIONS);
};

export const forget = (key: string): Promise<void> => SecureStore.deleteItemAsync(key, OPTIONS);
