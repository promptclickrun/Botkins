// A key that proves a person is holding this phone (iPhone). It is a P-256 key the phone makes and
// keeps; its private half never leaves the phone and can be used only after Face ID, Touch ID or the
// passcode, each time. A computer that has no window of its own asks for a signature made with it
// before a phone may turn on what phones can do with its screen ("screen-grant-v1").
//
// The native half is ios/BotkinsPresenceModule.swift; a build without it has `Presence === null`,
// and then the phone can't make that proof (it fails closed).
import { requireOptionalNativeModule } from "expo-modules-core";

type Native = {
  /** Whether a key can be made at all: the phone has a passcode. */
  available(): boolean;
  /** Makes a new key under `tag` (replacing one kept under it) and resolves with its public half: SPKI as base64url. */
  create(tag: string): Promise<string>;
  /** Whether a key is kept under `tag`. */
  has(tag: string): boolean;
  /**
   * Signs `message` (as UTF-8) with the key under `tag`: ECDSA with SHA-256, the signature as DER in
   * base64url. iOS asks for Face ID, Touch ID or the passcode first and shows `reason`. Rejects when
   * the person cancels, when there is no such key, or when the phone can't check who is holding it.
   */
  sign(tag: string, message: string, reason: string): Promise<string>;
  /** Removes the key under `tag`. */
  remove(tag: string): Promise<void>;
};

export const Presence = requireOptionalNativeModule<Native>("BotkinsPresence");
