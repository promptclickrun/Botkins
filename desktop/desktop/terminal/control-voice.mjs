// Voice: the control socket's calls for the command line (desktop/terminal/control.mjs adds them).
// A call is `"voice.<verb>"([...args], context)`. `handlers` are the app's own calls.
//
// Each call wraps the app's own call, which checks what it is given. Three rules hold here:
//  - A provider's key goes in and never comes out: `voice.key` answers only whether a key is saved,
//    and its log line names the provider (desktop/terminal/coverage.mjs).
//  - `voice.set` takes the choices (provider, model, voice, language, speed), and the web address of
//    a provider only with the mark `{ agreed: true }`. The key of a provider goes to its address, so
//    the app drops a saved key whenever its address is set, changed or taken away, and a caller that
//    could choose the address with no mark could choose where a person's next key goes. The mark says
//    that the caller showed the person this and got a yes. The command line does that, and then takes
//    the key for the new address (cli/commands/voice.mjs). The log line names the provider, never the address.
//  - `voice.options` can make the service ask a provider for its lists, with the saved key. It asks
//    only the address that the app has saved for that provider. The call has no place to give one.
import { KEY_PROVIDERS, LIVE_PROVIDERS, STT_PROVIDERS, TTS_PROVIDERS } from "../link/voice.mjs";
import { ControlError } from "./socket.mjs";

const bad = (message, code = "BAD_ARGUMENT") => new ControlError(message, code);
/** What a refusal says when a caller sets an address with no mark. */
export const ADDRESS_NEEDS_A_YES = "Setting a voice provider's address removes the key that is saved for it: a key is for the address that it was given for. Show that to the person, and give `{ \"agreed\": true }` after the choices (on the command line, `botkins voice set <provider> --address <url>`, which asks for the key for the new address next).";
const ADDRESS_PLACE = "An address is set as { providers: { openai: { baseUrl }, azure: { endpoint }, custom: { baseUrl } } }. Nothing else of a provider is set here.";
/** The one field that is the address of each provider that has one. */
export const ADDRESS_FIELDS = { openai: "baseUrl", azure: "endpoint", custom: "baseUrl" };
/** A name that is, or could be, a place that a request goes to. */
const ADDRESSLIKE = /url|uri|address|endpoint|host|region|server|domain|origin/i;

/** The sections and fields of `voice.set`: the choices. (An address is `providers`, with the mark.) */
const VOICE_FIELDS = {
  stt: ["provider", "model", "language"],
  tts: ["provider", "model", "voice", "speed", "auto"],
  live: ["provider", "model", "voice"],
};
const KINDS = { stt: STT_PROVIDERS, tts: TTS_PROVIDERS, live: LIVE_PROVIDERS };

/**
 * @param workspace  The app's workspace.
 * @param handlers   `runtime.handlers`.
 */
export function voiceApi({ workspace, handlers }) {
  /** Whether a key is saved for a provider, from the app's own settings (which never hold a key). */
  const hasKey = async (provider) => (await handlers.voiceSettings()).providers?.[provider]?.hasKey === true;

  return {
    /** The choices, which providers have a key (never the key), and whether voice is ready. */
    "voice.get": () => handlers.voiceSettings(),
    /**
     * The models and voices a provider offers for speech to text (stt), text to speech (tts) or live voice (live).
     * Some providers answer from a built-in list. Others are asked, with the saved key, at the address that the app
     * saved for them (see the part "Voice" of docs/terminal.md). The caller cannot choose that address.
     */
    "voice.options": ([kind, provider]) => {
      if (typeof kind !== "string" || typeof provider !== "string") throw bad("Give the kind (stt, tts or live) and the provider.");
      return handlers.voiceOptions(kind.trim().toLowerCase(), provider.trim().toLowerCase());
    },
    /**
     * Changes the choices: { stt?: { provider, model, language }, tts?: { provider, model, voice, speed, auto },
     * live?: { provider, model, voice }, providers?: { openai?: { baseUrl }, azure?: { endpoint }, custom?: { baseUrl } } }.
     * A field that is not one of these is refused. `providers` is the address of a provider (a text, or null to take it away),
     * and it needs `options`: { agreed: true }. The app drops the key that is saved for a provider whose address is set,
     * changed or taken away, so the mark says that the caller showed the person that and got a yes. The caller then gives
     * the key for the new address (`voice.key`), or leaves the provider with no key.
     * The answer is the settings as they are now, `changed` (the sections that were in the change) and
     * `addressChanged` (the providers whose address was in it).
     */
    async "voice.set"([patch, options]) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) throw bad("Give what to change.");
      const agreed = options?.agreed === true;
      for (const [section, fields] of Object.entries(patch)) {
        if (section === "providers") {
          if (!agreed) throw bad(ADDRESS_NEEDS_A_YES, "NEEDS_YES");
          if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) throw bad(ADDRESS_PLACE);
          for (const [provider, given] of Object.entries(fields)) {
            const field = Object.hasOwn(ADDRESS_FIELDS, provider) ? ADDRESS_FIELDS[provider] : null;
            if (!field || !given || typeof given !== "object" || Array.isArray(given) || Object.keys(given).length !== 1 || !Object.hasOwn(given, field)) throw bad(ADDRESS_PLACE);
            if (given[field] !== null && typeof given[field] !== "string") throw bad("The address is a web address as text, or null to take it away.");
          }
          continue;
        }
        if (!Object.hasOwn(VOICE_FIELDS, section)) {
          if (ADDRESSLIKE.test(section)) throw bad(agreed ? ADDRESS_PLACE : ADDRESS_NEEDS_A_YES, agreed ? "BAD_ARGUMENT" : "NEEDS_YES");
          throw bad("The command line does not change " + (section.length <= 40 && /^[\w.-]+$/.test(section) ? section : "that") + ". It sets the choices of stt, tts and live.");
        }
        if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) throw bad("Give the choices of " + section + " as names with values.");
        for (const name of Object.keys(fields)) {
          if (VOICE_FIELDS[section].includes(name)) continue;
          if (ADDRESSLIKE.test(name)) throw bad(agreed ? ADDRESS_PLACE : ADDRESS_NEEDS_A_YES, agreed ? "BAD_ARGUMENT" : "NEEDS_YES");
          throw bad(section + " has no " + (name.length <= 40 && /^[\w.-]+$/.test(name) ? name : "field of that name") + " to change here. It has: " + VOICE_FIELDS[section].join(", ") + ".");
        }
      }
      const settings = await handlers.setVoice(patch);
      return { ...settings, changed: Object.keys(VOICE_FIELDS).filter((section) => Object.hasOwn(patch, section)), addressChanged: Object.keys(patch.providers ?? {}) };
    },
    /**
     * Saves a provider's key, or with `null` removes it. The key is never in an answer: the answer
     * is { provider, hasKey }. Only the provider's name reaches the log. A key that is saved already,
     * replaced or removed, is lost: that needs `options`: { agreed: true }, the mark of a caller that got a yes.
     */
    async "voice.key"([provider, key, options]) {
      const wanted = typeof provider === "string" ? provider.trim().toLowerCase() : "";
      if (!KEY_PROVIDERS.includes(wanted)) throw bad("A key is for one of " + KEY_PROVIDERS.join(", ") + ".");
      if (key !== null && (typeof key !== "string" || !key.trim())) throw bad("Give the key, or null to remove it.");
      if (options?.agreed !== true && (await hasKey(wanted))) throw bad("Replacing or removing the " + wanted + " key that is saved loses the old one. That needs a yes. Show it to the person, and give `{ \"agreed\": true }` as the last argument (on the command line, `botkins voice key " + wanted + " --yes`).", "NEEDS_YES");
      await handlers.setVoiceKey(wanted, key === null ? null : key);
      return { provider: wanted, hasKey: await hasKey(wanted) };
    },
  };
}

// What the command line shows, from the same lists as the calls above.
export const VOICE_PROVIDERS = { ...KINDS, key: KEY_PROVIDERS };
