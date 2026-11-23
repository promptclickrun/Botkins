// Voice: the commands (cli/commands/index.mjs adds them).
// `voiceCommands` maps a top-level word to a group `{ summary, commands }`.
//
// Three rules of the command line hold here (desktop/AGENTS.md):
//  - A provider's key is never a word on the command line, and never printed. It comes from standard
//    input or a hidden question. `voice show` says whether a key is saved.
//  - `voice set` takes no address without its key. A saved key goes to the address that it was given
//    for, so the app drops the key whenever an address is set, changed or taken away. `voice set <provider>
//    --address` shows that first and asks (`--yes` with no terminal), sets the address, and then takes the
//    key for it from a hidden question or from standard input. With neither, the provider has no key.
//  - Removing or replacing a saved key asks first.
import { EXIT, usage } from "../output.mjs";
import { confirm, secret } from "./input.mjs";
import { safe } from "./tools.mjs";

const YES = { yes: { type: "boolean", about: "Do not ask first" } };
const list = (words) => words.join(", ");
const one = (context, what) => {
  if (context.args.length !== 1) throw usage(what);
  return context.args[0];
};

// (desktop/terminal/control-voice.mjs VOICE_PROVIDERS holds the lists that are checked; a test keeps them the same.)
export const VOICE_KINDS = { stt: ["device", "openai", "azure", "elevenlabs", "custom", "local"], tts: ["device", "openai", "azure", "elevenlabs", "gemini", "custom", "local"], live: ["codex", "openai", "azure", "gemini", "elevenlabs"], key: ["openai", "azure", "elevenlabs", "gemini", "custom"] };
const PROVIDER_NAMES = { openai: "OpenAI", azure: "Azure", elevenlabs: "ElevenLabs", gemini: "Gemini", custom: "Custom server", local: "Local", codex: "Codex", device: "This computer" };
const part = (label, value) => (value === undefined || value === null || value === "" ? null : label + " " + safe(String(value)));
const voiceText = (voice) => {
  const choice = (section, extra = []) => (section?.provider ? [PROVIDER_NAMES[section.provider] ?? safe(section.provider), part("model", section.model), ...extra].filter(Boolean).join(", ") : "not chosen");
  return [
    "Speech to text: " + choice(voice.stt, [part("language", voice.stt?.language)].filter(Boolean)),
    "Text to speech: " + choice(voice.tts, [part("voice", voice.tts?.voice), part("speed", voice.tts?.speed), "replies read aloud " + (voice.tts?.auto ? "on" : "off")]),
    "Live voice: " + choice(voice.live, [part("voice", voice.live?.voice)]),
    "",
    "Keys (a key is never shown):",
    ...VOICE_KINDS.key.map((name) => {
      const { hasKey, ...rest } = voice.providers?.[name] ?? {};
      const more = Object.entries(rest).map(([field, value]) => field + " " + safe(String(value)));
      return "  " + (PROVIDER_NAMES[name] ?? name).padEnd(14) + (hasKey ? "key set" : "no key") + (more.length ? "   " + more.join(", ") : "");
    }),
    ...(voice.ready === false ? ["", "Not ready: " + safe(voice.problem ?? "")] : []),
  ].join("\n");
};
/** The providers that have a web address, and what each calls it. */
const ADDRESS_PROVIDERS = { openai: "OpenAI", azure: "Azure endpoint", custom: "Custom server" };
const ADDRESS_FIELDS = { openai: "baseUrl", azure: "endpoint", custom: "baseUrl" };
const SECTION_OPTIONS = {
  stt: { type: "string", value: "provider", about: "Speech to text: " + list(VOICE_KINDS.stt) },
  "stt-model": { type: "string", value: "model", about: "The speech to text model. \"\" clears it" },
  "stt-language": { type: "string", value: "code", about: "The language, such as en or de. \"\" clears it" },
  tts: { type: "string", value: "provider", about: "Text to speech: " + list(VOICE_KINDS.tts) },
  "tts-model": { type: "string", value: "model", about: "The text to speech model. \"\" clears it" },
  "tts-voice": { type: "string", value: "voice", about: "The voice. \"\" clears it" },
  "tts-speed": { type: "string", value: "0.5-2", about: "How fast it speaks, from 0.5 to 2" },
  "tts-auto": { type: "string", value: "on|off", about: "Read every reply aloud" },
  live: { type: "string", value: "provider", about: "Live voice: " + list(VOICE_KINDS.live) + ", or none" },
  "live-model": { type: "string", value: "model", about: "The live voice model. \"\" clears it" },
  "live-voice": { type: "string", value: "voice", about: "The live voice. \"\" clears it" },
};
/** The choices that were given, in the form `voice.set` takes. */
function voicePatch(options) {
  const patch = {};
  const put = (section, field, value) => void ((patch[section] ??= {})[field] = value);
  for (const [option, value] of Object.entries(options)) {
    if (!Object.hasOwn(SECTION_OPTIONS, option)) continue;
    const [section, field = "provider"] = option.split("-");
    if (field === "speed") {
      const speed = Number(value);
      if (value.trim() === "" || !Number.isFinite(speed)) throw usage("--tts-speed is a number from 0.5 to 2.");
      put(section, field, speed);
    } else if (field === "auto") {
      const word = value.trim().toLowerCase();
      if (!["on", "off", "true", "false", "yes", "no"].includes(word)) throw usage("--tts-auto is on or off.");
      put(section, field, ["on", "true", "yes"].includes(word));
    } else if (field === "provider") {
      const word = value.trim().toLowerCase();
      if (section === "live" && word === "none") put(section, field, null);
      else if (!VOICE_KINDS[section].includes(word)) throw usage("--" + section + " is one of " + list(VOICE_KINDS[section]) + (section === "live" ? ", or none" : "") + ".");
      else put(section, field, word);
    } else put(section, field, value);
  }
  return patch;
}

/** `voice set <provider> --address <url>`: what happens is shown and asked first, then the address is set, then its key is taken. */
async function setAddress(context) {
  const { address, ...rest } = context.options;
  if (Object.keys(rest).some((name) => Object.hasOwn(SECTION_OPTIONS, name))) throw usage("Set an address on its own. Run `voice set` again for the other choices.");
  if (context.args.length !== 1) throw usage("Name the provider whose address it is: " + list(Object.keys(ADDRESS_PROVIDERS)) + ".");
  const word = context.args[0].trim().toLowerCase();
  if (!Object.hasOwn(ADDRESS_PROVIDERS, word)) throw usage("A provider that has an address is one of " + list(Object.keys(ADDRESS_PROVIDERS)) + ".");
  const name = PROVIDER_NAMES[word] ?? word;
  const has = (await context.client.call("voice.get")).providers?.[word]?.hasKey === true;
  // Shown with --yes and with --json too: it is in the caller's own record. (The address is not repeated: it can carry a token.)
  context.stderr.write((has ? "The key that is saved for " + name + " is removed." : "No key is saved for " + name + ".") + " A key is for the address that it was given for. The command asks for the key for the new address next.\n");
  if (!(await confirm(context, "Set the address of " + name + (address === "" ? " to none" : "") + "?"))) {
    context.note("The address is not set.");
    return EXIT.failed;
  }
  await context.client.call("voice.set", { providers: { [word]: { [ADDRESS_FIELDS[word]]: address === "" ? null : address } } }, { agreed: true });
  // The key for the new address: a hidden question or standard input. With neither, the provider is left with no key, and this says so.
  let key = null;
  if (address !== "") {
    try {
      key = await secret(context, "The " + name + " key for the new address (not shown): ");
    } catch (error) {
      if (error.code !== "USAGE") throw error;
    }
  }
  if (key !== null) await context.client.call("voice.key", word, key);  // (The address change dropped the old key: there is none to lose.)
  const hasKey = key !== null;
  context.print({ provider: word, addressChanged: true, hasKey }, () => "Set the address of " + name + "." + (hasKey ? " Saved the " + name + " key for it." : " " + name + " has no key now. Give one with `botkins voice key " + word + "`."));
}

const voiceGroup = {
  summary: "Choose the voices for speech to text, text to speech and live voice, and save a provider's key",
  commands: {
    show: {
      summary: "Show the voice choices, and which providers have a key",
      usage: "botkins voice show",
      details: "A key is never shown: only whether one is saved.",
      async run(context) {
        context.print(await context.client.call("voice.get"), voiceText);
      },
    },
    options: {
      summary: "List the models and voices that a provider offers",
      usage: "botkins voice options <kind> <provider>",
      arguments: [{ name: "kind", required: true }, { name: "provider", required: true }],
      details: [
        "The kind is stt (speech to text), tts (text to speech) or live (live voice). The providers: stt " + list(VOICE_KINDS.stt) + "; tts " + list(VOICE_KINDS.tts) + "; live " + list(VOICE_KINDS.live) + ".",
        "Some lists are built in and no request is made. For the others this computer asks the provider, with the key that is saved for it (save one with `botkins voice key`):",
        "  elevenlabs   its voices (and, for tts, its models), at api.elevenlabs.io",
        "  azure        its voices and models, for an Azure Speech setup: at the endpoint or region saved in the app's window",
        "  custom       its models and voices, at the server address saved in the app's window",
        "  live codex   the voices of the Codex program on this computer",
        "You cannot choose the address. It is the one saved in the app's window.",
      ].join("\n"),
      async run(context) {
        if (context.args.length !== 2) throw usage("Give the kind (stt, tts or live) and the provider.");
        const found = await context.client.call("voice.options", ...context.args);
        context.print(found, (options) =>
          [
            options.models?.length ? "Models:\n" + options.models.map((model) => "  " + safe(model.id) + (model.name && model.name !== model.id ? "   " + safe(model.name) : "")).join("\n") : "No models.",
            ...(options.voices?.length ? ["", "Voices:", ...options.voices.map((voice) => "  " + safe(voice.id) + (voice.name && voice.name !== voice.id ? "   " + safe(voice.name) : ""))] : []),
          ].join("\n"),
        );
      },
    },
    set: {
      summary: "Change the voice choices",
      usage: "botkins voice set [--stt <provider>] [--stt-model <model>] [--stt-language <code>] [--tts <provider>] [--tts-model <model>] [--tts-voice <voice>] [--tts-speed <0.5-2>] [--tts-auto <on|off>] [--live <provider>] [--live-model <model>] [--live-voice <voice>] [<provider> --address <url>] [--yes]",
      arguments: [{ name: "provider", required: false }],
      options: { ...SECTION_OPTIONS, address: { type: "string", value: "url", about: "Set the web address of openai, azure (its endpoint) or custom. \"\" takes it away" }, ...YES },
      details: [
        "Only what you name changes. Choosing another provider drops the old model and voice, which would not fit. `voice options` lists what a provider offers.",
        "",
        "A provider's address: `botkins voice set openai --address https://example.com/v1`. A key is for the address that it was given for, so the key that is saved for the provider is removed when its address is set, changed or taken away. The command shows that first and asks (--yes when there is no terminal; it is printed on standard error with --yes and --json too). It sets the address, and then asks for the key for the new address, typed without being shown, or read from standard input. With no terminal and no key on standard input, the address is set, the provider has no key, and `botkins voice key <provider>` gives one. An address is set on its own: not with the other options.",
      ].join("\n"),
      async run(context) {
        if (context.options.address !== undefined) return setAddress(context);
        if (context.args.length) throw usage("`voice set` takes options only. `botkins help voice set` lists them.");
        const patch = voicePatch(context.options);
        if (!Object.keys(patch).length) throw usage("Say what to change. `botkins help voice set` lists the options.");
        context.print(await context.client.call("voice.set", patch), (voice) => "Saved the " + list(voice.changed) + " choices.\n\n" + voiceText(voice));
      },
    },
    key: {
      summary: "Save, replace or remove a provider's key",
      usage: "botkins voice key <provider> [--remove] [--yes]",
      arguments: [{ name: "provider", required: true }],
      options: { remove: { type: "boolean", about: "Remove the saved key" }, ...YES },
      details: "The key is typed without being shown, or read from standard input (`echo \"$KEY\" | botkins voice key openai`). It is never a word on the command line, never printed and never in the log: the log names the provider only. The providers: " + list(VOICE_KINDS.key) + ". Replacing or removing a saved key needs your yes (--yes when there is no terminal).",
      async run(context) {
        const word = one(context, "Name the provider: " + list(VOICE_KINDS.key) + ".").trim().toLowerCase();
        if (!VOICE_KINDS.key.includes(word)) throw usage("A key is for one of " + list(VOICE_KINDS.key) + ".");
        const name = PROVIDER_NAMES[word] ?? word;
        const has = (await context.client.call("voice.get")).providers?.[word]?.hasKey === true;
        let key = null;
        if (context.options.remove) {
          if (!has) return void context.print({ provider: word, hasKey: false }, () => "There is no " + name + " key to remove.");
          if (!(await confirm(context, "Remove the " + name + " key?"))) return EXIT.failed;
        } else {
          if (has && !(await confirm(context, "Replace the " + name + " key?"))) return EXIT.failed;
          key = await secret(context, "The " + name + " key (not shown): ");
        }
        const done = await context.client.call("voice.key", word, key, ...(has ? [{ agreed: true }] : []));
        context.print(done, (now) => (now.hasKey ? "Saved the " + name + " key." : "Removed the " + name + " key."));
      },
    },
  },
};

export const voiceCommands = { voice: voiceGroup };
