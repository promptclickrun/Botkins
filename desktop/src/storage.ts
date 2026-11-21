import brand from "../desktop/brand.json";

/** Move a saved UI preference to the current namespace before its first read or write. */
export function storageKey(suffix: string) {
  const key = brand.name.toLowerCase() + "." + suffix;
  const previous = brand.previousName.toLowerCase() + "." + suffix;
  try {
    const value = localStorage.getItem(previous);
    if (value === null) return key;
    if (localStorage.getItem(key) === null) {
      try {
        localStorage.setItem(key, value);
      } catch {
        return previous; // Keep an unsaved draft accessible if the store is full.
      }
    }
    localStorage.removeItem(previous);
  } catch {
    // Storage may be unavailable.
  }
  return key;
}
