# Voice: speech to text, text to speech and live voice

`voice.mjs` is the one place that talks to speech providers, for the desktop app and for paired phones. It does three things:

- **Speech to text (STT)**: a recording in, text out.
- **Text to speech (TTS)**: text in, audio out (MP3 when the provider offers it, else WAV).
- **Live voice**: it sets up one realtime, full-duplex session and hands the caller what it needs to connect. The audio then goes between the caller and the provider, not through this module.

Keys stay on this computer. A phone never gets a long-lived key. For a live session it gets at most a short-lived secret that works for one session.

The module needs only Node's standard library and the global `fetch`, `FormData` and `Blob` (Node 22). It never logs a key, puts one in an error, or sends anything about this computer or its owner to a provider.

Read this next to `voice.mjs`. The tests are in `tests/voice.test.ts`. They use a fake `fetch` and a few servers on `127.0.0.1`, never a real provider.

## Using it

```js
import { Voice } from "./voice.mjs";

const voice = new Voice({
  dir: join(dataDir, "link"),    // voice.json is kept here
  protect, reveal,               // optional: the system keychain, as for credentials
  adapter: () => ({ local, codex }), // optional: see "What the desktop app provides"
  onChange: () => link.emit("voice"), // after settings change
  log: (line) => console.log(line),   // short notes, never a key
});

voice.settings();                        // what the person chose. Never holds a key.
voice.set({ stt: { provider: "openai" } });
voice.setKey("openai", "sk-…");          // a string saves it, null removes it
await voice.options("tts", "elevenlabs"); // { models, voices }
await voice.transcribe({ audio, format: "m4a", language: "en" }); // { text }
await voice.speak({ text, voice, speed });                         // { audio, format }
await voice.live({ provider, sdp, instructions, voice, tools });   // a LiveSession
voice.endLive(id);
voice.close();                           // stops every request that is waiting
```

Every failure is a `Failure` (from `tools.mjs`), so `LinkHost` passes its sentence to a phone as it is. Sentences name where to fix things: "Add an OpenAI key in Settings › Voice first."

Extra things beyond the agreed interface (all optional): the `timeouts` and `now` constructor options (tests shorten them), `voice.close()`, and `firstMessage` on `live()` (ElevenLabs only).

## What is saved

`<dir>/voice.json` holds the settings and the keys. It is written whole through a temp file and renamed, and is readable only by the person (mode 0600). With `protect`, each key is wrapped one by one and the file says `"wrapped": true`. Without `protect` the keys are kept as they are (development only, like `credentials.mjs`).

If the file can't be read, or a wrapped key can't be opened in this run, the module is locked: reading settings still works, every save throws a plain sentence, and the file is left exactly as it is. A file that is not there yet is a fresh start. A hand-edited file goes through the same checks as `set()`: a part that fails is dropped.

The file also keeps the ElevenLabs client-tool ids it made (`tools`, a hash of each tool's description to its id). They are not secret.

## Settings

```ts
type SttProvider = "device" | "openai" | "azure" | "elevenlabs" | "custom" | "local";
type TtsProvider = "device" | "openai" | "azure" | "elevenlabs" | "gemini" | "custom" | "local";
type LiveProvider = "codex" | "openai" | "gemini" | "elevenlabs";
type VoiceSettings = {
  stt: { provider: SttProvider; model?: string; language?: string };           // default { provider: "device" }
  tts: { provider: TtsProvider; model?: string; voice?: string; speed?: number; auto?: boolean }; // speed 0.5 to 2, default 1; auto default false
  live: { provider: LiveProvider | null; model?: string; voice?: string };      // null until the person picks one
  providers: {
    openai:     { baseUrl: string; hasKey: boolean };                          // default "https://api.openai.com/v1"
    azure:      { kind: "openai" | "speech"; endpoint?: string; region?: string; sttDeployment?: string; ttsDeployment?: string; apiVersion?: string; hasKey: boolean };
    elevenlabs: { hasKey: boolean; agentId?: string };
    gemini:     { hasKey: boolean };
    custom:     { baseUrl?: string; hasKey: boolean };
    local:      { available: boolean; models: LocalModel[] };                  // from adapter().local
    codex:      { available: boolean; signedIn: boolean };                     // from adapter().codex
  };
};
```

Rules for `set(patch)`:

- A section (`stt`, `tts`, `live`, one provider) is merged into what is saved. `null` or `""` clears an optional value.
- Choosing another provider drops the old `model` and `voice`, which would not fit the new one. The language, speed and `auto` stay.
- `hasKey`, `local` and `codex` are read only and ignored, so `set(settings())` is fine.
- Addresses must be `https:`. Plain `http:` is allowed for `localhost`, `127.0.0.1` and `[::1]`, and for the `custom` server (a person's own server on their network). No login, query or fragment may be in an address. A trailing `/` is dropped.
- A bad value throws a plain sentence and nothing is saved.
- `apiVersion` is not filled in. When it is empty, Azure OpenAI uses `2025-04-01-preview`.

## Providers

"Checked" means read in the provider's own documentation on 2026-11-19. Nothing was called for real.

### Speech to text

| Provider | Route and auth | Model and fields | Formats and limits |
| --- | --- | --- | --- |
| `openai` | `POST {baseUrl}/audio/transcriptions`, `Authorization: Bearer` | multipart: `file`, `model` (default `gpt-transcribe`), and `languages[]` (for `gpt-transcribe`) or `language` (older models). Answer `{ text }`. | The page lists flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm. 25 MB. |
| `custom` | the same route under the person's `baseUrl`. `Authorization: Bearer` only if a key is saved. | `file`, `model` (the chosen one, else `whisper-1`), `language` | whatever the server takes |
| `azure`, kind `openai` | `POST {endpoint}/openai/deployments/{sttDeployment}/audio/transcriptions?api-version=…`, header `api-key` | multipart: `file`, `model` (the chosen one, else the deployment name), `language` | the OpenAI list; 25 MB |
| `azure`, kind `speech` | fast transcription: `POST {endpoint or https://{region}.api.cognitive.microsoft.com}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`, header `Ocp-Apim-Subscription-Key` | multipart: `audio`, and `definition` = `{"locales":[language]}` (or `[]` for any). Answer: the `combinedPhrases[].text` joined with spaces. | WAV, MP3, OGG, FLAC, AAC, WebM and more; under 500 MB and 5 hours |
| `elevenlabs` | `POST https://api.elevenlabs.io/v1/speech-to-text`, header `xi-api-key` | multipart: `model_id` (default `scribe_v2`), `file`, `language_code`. Answer `{ text }`. | the page says under 5.0 GB; this module stops at 25 MB |
| `local` | `adapter().local.transcribe(wav, { model, language })` | the chosen model, else the first installed STT model | WAV only |
| `device` | not done here. Throws "This device does its own speech." | | |

The module reads `format` (`wav`, `m4a`, `mp3`, `webm`) only to name the file and set its type. OpenAI's `languages[]` and `language` get the primary subtag (`en-US` becomes `en`, but `zh-CN` stays `zh-cn`). Azure Speech and `custom` get the language as it was given.

### Text to speech

| Provider | Route and auth | Request | Answer |
| --- | --- | --- | --- |
| `openai` | `POST {baseUrl}/audio/speech`, Bearer | JSON `{ model (default gpt-4o-mini-tts), input, voice (default marin), response_format: "mp3", speed }` (`speed` only when not 1) | MP3 |
| `custom` | the same route under the person's `baseUrl` | the same JSON; defaults `tts-1` and `alloy` | MP3 or WAV, found by the file's first bytes. Anything else is refused. |
| `azure`, kind `openai` | `POST {endpoint}/openai/deployments/{ttsDeployment}/audio/speech?api-version=…`, `api-key` | JSON `{ model (the chosen one, else the deployment), input, voice (default alloy), response_format: "mp3", speed }` | MP3 |
| `azure`, kind `speech` | `POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`, or `{endpoint}/tts/cognitiveservices/v1`. Headers `Ocp-Apim-Subscription-Key`, `Content-Type: application/ssml+xml`, `X-Microsoft-OutputFormat: audio-24khz-96kbitrate-mono-mp3`, `User-Agent: Botkins`. | SSML. The language is the first two parts of the voice name. Voice default `en-US-JennyNeural`. A speed other than 1 is `<prosody rate="1.25">`. | MP3 |
| `elevenlabs` | `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128`, `xi-api-key` | JSON `{ text, model_id (default eleven_multilingual_v2), voice_settings: { speed } }` (`voice_settings` only when speed is not 1). With no voice chosen the first of the person's voices is used. | MP3 |
| `gemini` | `POST https://generativelanguage.googleapis.com/v1beta/interactions`, `x-goog-api-key` | JSON `{ model (default gemini-3.8-flash-tts), input: [{ type: "user_input", content: [{ type: "text", text }] }], response_format: { type: "audio" }, generation_config: { speech_config: [{ voice (default Kore) }] } }`. No speed (Gemini has none). | base64 audio from the last `model_output` step's `audio` content. WAV; raw 24 kHz 16-bit samples are wrapped in a WAV header. |
| `local` | `adapter().local.synthesize(text, { model, voice, speed })` | | WAV |
| `device` | throws "This device does its own speech." | | |

`speak` takes at most 4,000 characters. A voice id is checked before it goes into a path (`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` for ElevenLabs).

### Models and voices (`options(kind, provider)`)

Where a provider has a list route, it is called (15 s limit) and the answer is kept for 5 minutes. Any change to the settings or a key clears the kept lists. Otherwise the documented list is returned.

| Provider | Models | Voices |
| --- | --- | --- |
| `openai` | STT: `gpt-transcribe`, and the three older ids marked "retires Feb 2027". TTS: `gpt-4o-mini-tts`, `tts-1-hd`, `tts-1` (marked "retires Jan 2027"). Live: `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gpt-realtime-2`, `gpt-realtime`. | TTS: the 13 on the page. Live: the 10 on the realtime page. |
| `azure` openai | the deployment names in the settings | TTS: `alloy echo fable onyx nova shimmer` |
| `azure` speech | none | `GET …/cognitiveservices/voices/list` (or `{endpoint}/tts/cognitiveservices/voices/list`): `ShortName`, `DisplayName`, `Gender`, `Locale` |
| `elevenlabs` | STT: `scribe_v2`, `scribe_v3`, `scribe_v2_medical`. TTS: `GET /v1/models` filtered on `can_do_text_to_speech`. | `GET /v2/voices?page_size=100`, up to 3 pages |
| `gemini` | TTS: `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`, `gemini-3.1-flash-tts-preview`, `gemini-2.5-pro-preview-tts`. Live: `gemini-3.8-live`, `gemini-3.8-live-extended-thinking`, `gemini-3.1-flash-live-preview`, `gemini-2.5-flash-native-audio-preview-12-2025`. | the 30 prebuilt voices |
| `custom` | `GET {baseUrl}/models` (`data[].id`) | `GET {baseUrl}/audio/voices` when it answers (a list, or `voices` or `data`), else 11 standard OpenAI voice names |
| `local` | the installed models of that kind | the voices of the installed TTS models |
| `codex`, `device` | none | none |

### Live sessions

`live({ provider, sdp, instructions, voice, tools })`. The provider defaults to `settings().live.provider`. The saved model and voice are used only when that is the provider being started. `instructions` is up to 20,000 characters. `tools` is `[{ name, description, parameters }]` (at most 64; the name is up to 64 letters, digits, `-` or `_`). The caller runs a tool itself and answers on its socket or data channel.

`expiresAt` is always **milliseconds since 1970**. For a secret it is when the secret stops being valid for **starting** a session, not when the session ends.

| Provider | What `live` does | What it returns |
| --- | --- | --- |
| `codex` | `adapter().codex.live({ sdp, voice, instructions, tools, chatId, botId, botName })`. Needs the offer `sdp`. The chat, the bot and its name come from `live({ about })`: the voice's tool call arrives at the app, not at the caller, so the helper answers it itself and needs to know the chat to run the request in. | `{ id, kind: "webrtc", sdp }` |
| `openai` with `sdp` | `POST {baseUrl}/realtime/calls`, Bearer real key, multipart `sdp` (the offer) and `session` (JSON). The answer body is the SDP answer. | `{ id, kind: "webrtc", sdp }`. `id` is the last part of the `Location` header, else `live-…`. |
| `openai` without `sdp` | `POST {baseUrl}/realtime/client_secrets`, JSON `{ expires_after: { anchor: "created_at", seconds: 600 }, session }` | `{ id, kind: "openai-ws", url, token, expiresAt, session }`. `url` is `wss://api.openai.com/v1/realtime?model=…` (from `baseUrl`). `token` is the `ek_…` value. `session` is the **whole event** to send first: `{ type: "session.update", session: { type: "realtime", model, instructions, output_modalities: ["audio"], audio: { input: { format: audio/pcm 24000, turn_detection: { type: "semantic_vad" } }, output: { format: audio/pcm 24000, voice } }, tools, tool_choice } }`. |
| `gemini` | `POST /v1beta/auth_tokens` with `{ uses: 1, expireTime: +30 min, newSessionExpireTime: +2 min }` and `x-goog-api-key` | `{ id, kind: "gemini-ws", url, expiresAt, setup, input: { sampleRate: 16000 }, output: { sampleRate: 24000 } }`. `url` is the `BidiGenerateContentConstrained` socket with `?access_token=`. `setup` is the **whole first message**: `{ setup: { model: "models/…", generationConfig: { responseModalities: ["AUDIO"], speechConfig: … }, systemInstruction, tools: [{ functionDeclarations }], inputAudioTranscription: {}, outputAudioTranscription: {} } }`. `expiresAt` is `newSessionExpireTime`. |
| `elevenlabs` | makes the client tools and the agent when needed (below), then `GET /v1/convai/conversation/get-signed-url?agent_id=…` | `{ id, kind: "elevenlabs-ws", url, init, input: { sampleRate: 16000 }, output: { sampleRate: 16000 } }`. `url` is the signed socket. `init` is `{ type: "conversation_initiation_client_data", conversation_config_override: { agent: { prompt: { prompt, tool_ids }, first_message }, tts: { voice_id } } }`. |

How the caller connects (from the same documentation):

- **OpenAI socket.** In a browser the subprotocols are `["realtime", "openai-insecure-api-key." + token]`. Tool results go back as `conversation.item.create` with a `function_call_output` item, then `response.create`. (**Not checked:** none of the realtime pages read today show those two events. They are from earlier knowledge of the Realtime API, so check them against the event reference.)
- **OpenAI WebRTC.** The caller creates the data channel `oai-events` before it makes its offer.
- **Gemini.** Audio goes in as `{ realtimeInput: { audio: { data, mimeType: "audio/pcm;rate=16000" } } }`. Audio comes out in `serverContent.modelTurn.parts[].inlineData`. A tool call is `toolCall.functionCalls[]` (`id`, `name`, `args`) and the answer is `{ toolResponse: { functionResponses: [{ id, name, response }] } }`.
- **ElevenLabs.** Audio goes in as `{ user_audio_chunk: <base64> }`. Reply to `ping` with `pong`. A tool call is `client_tool_call` (`tool_name`, `tool_call_id`, `parameters`); the answer is `{ type: "client_tool_result", tool_call_id, result, is_error }`. The server's first message, `conversation_initiation_metadata`, names the real audio formats; this module assumes the agent's default, `pcm_16000` both ways.

**ElevenLabs agent.** ElevenLabs live needs an agent. If `providers.elevenlabs.agentId` is empty, `live` creates one named "Botkins" (`POST /v1/convai/agents/create`) with its prompt, first message, language and tool list open to override, saves its id and reuses it. Each tool is made once as a client tool (`POST /v1/convai/tools`, `expects_response: true`) and its id is kept. The session lists the ids it needs in `init`. If the key can't make an agent, the error ends with "You can also paste an agent id in Settings › Voice.", and `set({ providers: { elevenlabs: { agentId } } })` takes the pasted id. An agent the person made themselves must allow overrides, or ElevenLabs will ignore them.

A session is kept by id until `endLive(id)` (the 32 newest are kept). `endLive` calls `adapter().codex.end(id)` for a Codex session, and for the others only forgets the id: the caller closes its own socket or peer connection. Unknown ids are ignored.

### Spoken messages in chat history

A computer with `voice-history-v1` accepts `recordVoiceLine(chatId, voiceId, text, final)`. Send the current text of one user utterance on each update, using the same session-scoped ID through the final correction. The watched chat publishes the partial text, and the computer saves the final as a user message. For Codex, the computer receives and records the transcript directly. A matching `ask_bot` request can pass the same `voiceId` to `send` to run the request on that message.

With `voice-turns-v1`, the phone ties the tool request to the input utterance by ID even when their words differ or the transcript arrives late. The same call accepts a fifth argument for assistant speech, `{ role: "assistant", sessionId, afterVoiceId? }`. The link checks the session, device and chat. A spoken reply streams into one assistant row. When the bot has already written its answer for that turn, its spoken caption uses that answer's row until speech finishes, then the full written answer is shown. Codex records both speakers on the computer. ElevenLabs agents created by Botkins request `agent_chat_response_part` for partials. Existing agents can enable that client event in ElevenLabs. [ElevenLabs client events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events)

## A voice of a bot's own (`bot-voice-v1`)

A bot may keep a voice of its own, saved with the bot by the app (`bot.voice`, sent to phones in the `bots` part; `updateBot(id, { voice })` sets it and `voice: null` clears it):

```ts
type BotVoice = {
  tts?: { provider?: TtsProvider; model?: string; voice?: string; speed?: number };
  live?: { provider?: LiveProvider; model?: string; voice?: string };
};
```

Every field is optional, and an absent one means the same as the shared settings above. No key is ever in it: keys stay per provider, shared. `botVoiceField(value)` is the check (known providers only, `model` and `voice` as in `set()`, `speed` 0.5 to 2): it throws a plain sentence for anything else, and `cleanBotVoice` gives a saved voice back or null. `remoteArgs` (`methods.mjs`) cuts a phone's `updateBot` and `addBot` to that shape.

- **Reading aloud.** `link.voice.speak` takes an optional `botId`. The provider, model, voice and speed are the bot's own where it set them, else the shared ones (`effectiveTts`). The shared model and voice belong to the shared provider, so a bot that names another provider gets none of them. A `voice` or `speed` named in the call still wins.
- **Live voice.** `link.voice.live` already takes `botId`; the bot's `live` part is applied over the shared `live` settings (`effectiveLive`). A provider named in the call comes first, and the bot's model and voice count only for the provider they were chosen for. A bot whose provider has no key fails with the sentence the shared setting gives ("Add a Gemini key in Settings › Voice first.").
- **"This phone" and "This computer" (`device`).** A system voice isn't portable between a phone and a computer. When a bot's reading provider is `device`, nothing is asked of this module: each device keeps its own voice and speed for that bot (the phone in its own saved prefs, the desktop window in its local settings).
- **A team member.** A role that manages bots (`agents.manage`) sets `bot.voice` on the bots it can see, with `updateBot` like any other change to the bot: reading and live voice, every field above, and `null` for "Same as Settings". Another bot is refused. To choose, such a role is sent the `voice` part cut by `memberVoice` (`team.mjs`): the shared choices and whether each provider has a key, sign-in or model, never a key, and never an address, region, deployment or agent id (an address that is set is sent as the mark `(set)`). It may call `link.voice.options` and `link.voice.speak` (a sample). `link.voice.set` and `link.voice.key` stay the owner's, so a member never sets Settings › Voice or a key. A role that doesn't manage bots is sent no `voice` part. The desktop window used as a client reads the same part for its card (`voiceSettings`, `voiceOptions` and `speak` go to the host in `remotehosts.mjs`).
- **The capability** `bot-voice-v1` is named by the app (`backend.capabilities`) and by the demo computer (`BOTKINS_DEV_BOT_VOICE=off` leaves it out). A phone shows the controls only with it.

## Errors and limits

- Every request has a time limit: 60 s, and 15 s for lists and tokens. Each carries an `AbortSignal`. `close()` aborts what is waiting.
- A provider's error is one sentence: `"{Provider} returned {status}: {its own short message}."` For example "OpenAI returned 401: Incorrect API key provided." The message is taken from `error.message`, `detail.message`, `detail` or a short plain-text body. A page of markup is dropped.
- Known keys and tokens, anything shaped like a key (`sk-…`, `ek_…`, `xi-…`) and any 40-character run of key-like characters are replaced by `•••` in the whole message, and only then is it cut to 200 characters.
- A network failure is "Couldn't reach {Provider}." (the cause is dropped). A time-out is "{Provider} took too long to answer."
- `transcribe` takes at most 25 MB. `speak` takes at most 4,000 characters. An answer over 40 MB is refused.

## What the desktop app provides

`adapter` is a function so the app can supply its helpers late. Both parts are optional.

```ts
local?: {
  models(): LocalModel[];   // sync. LocalModel = { id, name, kind: "stt" | "tts", installed, sizeMB?, voices? }
  transcribe(wav: Buffer, { model, language }): Promise<{ text: string }>;
  synthesize(text: string, { model, voice, speed }): Promise<{ audio: Buffer /* a WAV file */ }>;
};
codex?: {
  signedIn(): boolean;
  live({ sdp, voice, instructions, tools }): Promise<{ sdp: string; id: string }>; // the SDP answer, from the person's Codex subscription
  end(id: string): void;
};
```

- `models()` is read every time `settings()` runs, so keep it cheap. Only installed models are offered by `options` and used for a run.
- A failure in a helper may throw anything. The person sees "The local speech model couldn't read that." or "Codex couldn't start a live voice session." and the detail goes to `log`. Throw a `Failure` from `tools.mjs` to show your own sentence.
- `tools` reaches `codex.live` as given after checks: `[{ name, description, parameters }]` with `parameters` a JSON schema (`{ type: "object", properties: {} }` when none was given). Mapping it for Codex is the helper's job.

The link is wired (`server.mjs`): the calls `link.voice.set`, `link.voice.key`, `link.voice.options`, `link.voice.transcribe`, `link.voice.speak`, `link.voice.live` and `link.voice.endLive`, the part `voice` (the settings), and the capability `voice-v1`. One call carries at most 5 MB of audio. A key never travels back to a phone. `link.voice.key` takes a typed key or a saved credential as `{ $credential: id }` (`credentials.mjs` has that place).

**A key stays with its address.** When the OpenAI address, the Azure endpoint or region, or the custom server's address is set, changed to another one or taken away, that provider's saved key is dropped, so a key is never sent to an address it was not given for. A first address drops the key too (fixed 2026-11-21: before, a key saved with no address was sent to whatever address was set next, and a call that only sets an address needs no key). The same address again changes nothing. Order for a provider: the address, then the key. `link.voice.set` and `link.voice.key` are the owner's alone (`team.mjs`); the app's own `setVoice` reaches the same code.

**`voice.locked`** is a sentence when the saved settings could not be opened (a keychain that did not answer), else null. Nothing is saved while it is set.

**Codex's voices** come from `adapter().codex.voices?.()` (`[{ id, name? }]`) through `options("live", "codex")`. Without it the list is empty and Codex chooses.

## What was read, and what stayed unclear

Read on 2026-11-19. Where a page was unclear, the choice made is stated. These are the places to test first with real keys.

### OpenAI

Read: <https://developers.openai.com/api/docs/guides/speech-to-text>, `…/text-to-speech`, `…/realtime-webrtc`, `…/realtime-websocket`, `…/realtime-conversations`, and the API reference pages for `realtime/client_secrets` and `realtime/calls`.

- `gpt-transcribe` is the recommended STT model. The page says to send `languages[]` and not `language` for it. `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and `gpt-4o-transcribe-diarize` are marked as shutting down on 2027-02-26.
- **TTS is on its way out.** The text-to-speech page says `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` shut down on 2027-01-06, and that `gpt-realtime-2.1-mini` (a Realtime model) is not supported on `/v1/audio/speech`. It names no replacement on that route. After that date `openai` TTS stops working. This module still uses `/audio/speech`.
- **Unclear:** `speed` is not on the TTS page (it names speed only as something `gpt-4o-mini-tts` can be told in its instructions). It is sent only when the speed is not 1, and a model that doesn't take it will answer 400.
- **Unclear:** the page says "11 built-in voices" and lists 13. The 13 are used. `tts-1` and `tts-1-hd` support only 9 of them.
- **Unclear:** the `Location` header of `POST /realtime/calls` is forwarded in the docs' example, but no page says what it holds. The last path part is used as the id when it looks like an id. No page documents a hang-up route, so `endLive` does not call the provider; a closed peer connection ends the call.
- The realtime pages list `gpt-realtime-2.1`, `gpt-realtime-2` and `gpt-realtime`. `gpt-realtime-2.1-mini` appears on the TTS page as "through the Realtime API". The `session` for a WebRTC call leaves the audio formats out on purpose (WebRTC sets its own); the socket version sends `audio/pcm` at 24000.
- `POST /realtime/client_secrets` returns `{ value, expires_at (seconds), session }`. `expires_at` is turned into milliseconds. The socket URL and the `["realtime", "openai-insecure-api-key." + token]` subprotocols are from the WebSocket page. The `openai-beta.realtime-v1` subprotocol is not on it.
- **Not implemented:** the audio guide says a new conversational voice app should "start with GPT-Live" (`POST /v1/live/sessions`, model `gpt-live-1`, a separate API from Realtime). The owner asked for the Realtime API, so GPT-Live is left for later.

### Azure

Read: <https://learn.microsoft.com/en-us/azure/ai-services/openai/reference> (2024-10-21) and `…/reference-preview` (2025-04-01-preview), `…/openai/text-to-speech-quickstart`, <https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short>, `…/rest-text-to-speech`, `…/fast-transcription-create`, `…/speech-synthesis-markup-voice`.

- Azure OpenAI transcription is `…/openai/deployments/{deployment}/audio/transcriptions?api-version=2024-10-21` (GA) or `2025-04-01-preview`. Azure OpenAI speech exists only in the preview: `…/audio/speech?api-version=2025-04-01-preview`. The default `apiVersion` is the preview one, since one value serves both.
- **Unclear:** the preview reference says the speech body is `multipart/form-data`, but its example and the quickstart's curl send JSON. JSON is used. The six voices are `alloy echo fable onyx nova shimmer`. The preview transcription table lists `model` as required, so `model` is sent (the deployment name when none is chosen).
- **Azure Speech STT uses fast transcription** (`transcriptions:transcribe`, `2025-10-15`), because the short-audio REST route takes only 16 kHz WAV or Ogg Opus and at most 60 seconds, and phones send m4a. **Unclear:** the page shows only the custom-subdomain host. The regional host `https://{region}.api.cognitive.microsoft.com` is a guess from how the speech token route is documented.
- **Unclear:** for text to speech the docs show the regional host `https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`. For a custom subdomain the voices route is `/tts/cognitiveservices/voices/list`, but the page's sample for converting text shows `/cognitiveservices/v1` on that same host. `{endpoint}/tts/cognitiveservices/v1` is used, matching the voices route. If it fails, try `{endpoint}/cognitiveservices/v1`.
- The page says `User-Agent` is required, so `Botkins` is sent. `rate` takes a multiplier from 0.5 to 2, which is the same range as `speed`. Azure Speech needs a locale (`sv-SE`), not just `sv`.
- A person on Azure Speech who sets `region` and `endpoint` both gets the `endpoint`.

### ElevenLabs

Read: <https://elevenlabs.io/docs/api-reference/speech-to-text/convert>, `…/text-to-speech/convert`, `…/voices/search`, `…/models/list`, `…/conversations/get-signed-url`, `…/agents/create`, `…/tools/create`, `https://elevenlabs.io/docs/agents-platform/libraries/web-sockets`, `…/eleven-agents/api-reference/eleven-agents/websocket`, `…/eleven-agents/customization/tools/client-tools`, `…/customization/personalization/overrides`.

- STT models on the page: `scribe_v2`, `scribe_v3`, `scribe_v2_medical`. **Unclear:** which is the default or newest. `scribe_v2` (listed first) is used.
- TTS: the page's default model is `eleven_multilingual_v2`, and it points to `GET /v1/models` (`can_do_text_to_speech`) for the rest. **Unclear:** the speed range (the page gives none), whether `voice_settings` may hold only `speed`, and any text length limit. Voices come from `GET /v2/voices` (`voice_id`, `name`, `labels`, `preview_url`, `verified_languages`, `has_more`, `next_page_token`).
- **Unclear:** the signed URL, tools and agent pages do not say which auth header they use. `xi-api-key`, as on the STT page, is used for all.
- **Unclear (a guess):** the agent is made with `first_message: ""` so it waits for the person to speak. No page says an empty first message is allowed. `llm` and the agent's voice are not set (the account's defaults apply). If creation fails the sentence tells the person to paste an agent id.
- Tools: the inline `prompt.tools` is marked deprecated on the agents page, so each client tool is made with `POST /v1/convai/tools` (`tool_config: { type: "client", name, description, expects_response: true, parameters }`) and attached by `tool_ids`. The tool's `parameters` go through as the caller gave them, minus `$schema` and `additionalProperties`. A tool deleted on ElevenLabs is not noticed: the agent will fail until `voice.json`'s `tools` entry is removed.
- Overrides: the agent allows `agent.prompt.prompt`, `agent.prompt.tool_ids`, `agent.first_message`, `agent.language` and `tts.voice_id`, and `init` carries them as `conversation_initiation_client_data`. The overrides page shows `tool_ids` being sent at the start of a conversation, but not the wrapper; the wrapper is from the WebSocket schema.
- Audio: the agent's input and output defaults are `pcm_16000` (from the workflow override schema on the agents page). Not set explicitly.

### Gemini

Read: <https://aistudio.google.com/docs/speech-generation>, `…/docs/live-api/get-started-websocket`, `…/docs/live-api/ephemeral-tokens`, `…/docs/live-api/capabilities`, `…/docs/live-api/tools`, `…/api-reference/live/bidi-generate-content`, `…/api-reference/generate-content/create-token`, `…/api-reference/voices`.

- TTS now uses `POST /v1beta/interactions`, not `generateContent`. The request and the place of the audio in the answer are as the page's REST example. Whole answers are WAV (24 kHz, mono, 16-bit); headerless streams are `audio/l16`. `speed` has no place in this request, so it is ignored for Gemini.
- There is a `GET /v1beta/voices` route, but the page does not say an API key may call it, so the 30 voices from the speech page are listed instead.
- **The docs disagree on the token request.** The ephemeral-token guide shows `liveConnectConstraints: { model, config }`. The API reference shows `bidiGenerateContentSetup` plus `fieldMask`. Neither is used: the module asks for the guide's unconstrained token (`uses: 1`, `expireTime`, `newSessionExpireTime`). It is short-lived and single-use but not tied to a model or tools, so the caller could send any setup with it. The token is `name` in the answer. Tokens work only on `v1beta`.
- **Unclear:** no page prints the whole constrained socket URL. It is put together from the get-started page ("the `BidiGenerateContentConstrained` path on `v1beta` with an `access_token` parameter") and the plain socket URL: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=…`.
- **Unclear:** the setup shape. The reference puts `responseModalities` and `speechConfig` inside `generationConfig`; the get-started page's example puts `responseModalities` straight in `setup`. The reference's shape is used, with the voice at `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` (from the capabilities page). `inputAudioTranscription` and `outputAudioTranscription` are from the capabilities page (the camelCase forms). The page for tools shows `tools: [{ functionDeclarations: [...] }]` but not a `parameters` schema, nor the keys Gemini rejects. `$schema` and `additionalProperties` are removed, and an empty schema is left out. This is a judgement, not from a page.
- Models: `gemini-3.8-live` is the live model the pages use ("the page doesn't say whether that's current"). Input audio is 16 kHz; output is 24 kHz.

### Codex

Nothing to read: it is the app's own helper. The module only checks `signedIn()`, passes the offer, and wraps the answer.

## What could not be checked

- No real call to any provider was made. Every route, field and header above is checked against documentation only, and against a fake provider in the tests.
- Every place marked "Unclear" or "a guess" above is untested against the real service.
- The Codex helper is the desktop app's (`desktop/codexvoice.mjs` there). The desktop thread ran it with real speech on a Mac on Codex 0.169.0; the tests here use a stand-in. It rests on Codex's experimental app-server calls, which OpenAI does not document.
- `expiresAt` in milliseconds is a choice of this module. The interface only said `number`.
