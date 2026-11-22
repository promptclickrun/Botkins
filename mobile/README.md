<img src="assets/icon.svg" width="64" height="64" alt="">

# Botkins

Botkins is the phone app for the Botkins app on your computer. Pair your phone with your computer, then chat with your bots and manage everything about them from anywhere on your network.

## What you can do

- **Pair in seconds.** Turn on phone access in the Botkins app on your computer (Settings › Phone), then choose "Connect to my computer" on your phone and scan the code. Or choose "Enter a code instead" under the camera: the phone finds your computer on the network by itself and you type only the code. Typing an address and port is there as a last resort. A paired phone can do what you can do in the app on your computer, so pair only your own phone. You can remove it there at any time. No Botkins yet? "Set up a new Botkins" links to the download for a Mac, Windows or Linux computer, and to "Deploy to Azure" for a server of your own. Settings › Computers and teams lists every computer and team the phone knows, with "Connect a computer", "Join a team" and "Set up a new Botkins".
- **Chat with your bots.** Replies stream in as they are written. You see what a bot is doing, approve what it asks for, answer its questions, stop it, and queue the next message. A command that looks risky needs a press and hold to allow. Tables in a reply fit your screen.
- **Mention and attach.** Type `/` for commands and skills. Type `#` for projects, wiki pages, files and artifacts, then the pull requests of the chat's project (your computer reads them with the GitHub CLI). Type `@` for bots (a group chat's members, or the teammates a bot may ask) and the same records. Attach photos, camera pictures and files; the phone sends them to your computer. Use Discuss on a card in Today to start a chat about it.
- **See the context window.** A ring in a chat's header shows how full the model's context is. Tap it to see what fills it and to compact the chat.
- **See what a bot built.** A chart, a dashboard or any small page a bot shows in a chat or in Today is drawn on the phone (a custom view). It has no network and cannot leave its page; a button in it can put text in your message box, and a link asks before it opens.
- **Select part of a message.** Double tap a message, or hold it and choose "Select text", then drag the handles and copy.
- **Talk.** One voice button sits where Send is when the field is empty. With a live voice provider chosen in Settings › Voice it opens a live call with the bot. Without one it talks by turns: the phone listens, sends what you said, reads the reply aloud and listens again. A bot can also read any reply aloud.
- **Answer a bot's form.** When a bot asks for a password or key, the field is masked and is cleared when you send. You can answer with a saved credential instead.
- **Create and manage bots.** Each bot is a Botkin: pick one of 20 characters, its eyes, and a palette or four colors of your own, give it a name, a role and instructions, choose its model, its skills and tools, and read or edit its memory.
- **Run routines and tasks.** Schedule a bot (once, daily, weekdays, weekly or custom), pause and run routines, choose where a routine's result lands (its own chat, your chat with the bot, or Today) and whether it notifies you, add tasks to the board and approve finished work.
- **Get told.** Settings › Notifications turns on notifications for replies, requests and routines, and Live Activities that show a chat's running turn on the Lock Screen and in the Dynamic Island. What a notification says is sealed between your phone and your computer: Apple and the relay carry only "New message". When a turn ends, its card says "Done" with how long it took and stays; a new turn in that chat takes the same card over.
- **Let bots use your phone.** Tools › Device access lets bots read your calendar, contacts, Health data, location and photos, and add or change some of them. You switch each source off, to read, or to read and interact, and you see what bots used. A bot can also write an email on your phone for you to read and send.
- **Manage tools and skills.** Add MCP servers, sign them in, test them, write skills, and switch each on or off.
- **Keep credentials.** Save an API key, a login or a note in Settings › Credentials. It is stored encrypted on your computer. You can also link a field from 1Password, Bitwarden or Proton Pass. The phone never receives a value. It sends a reference, and your computer fills the value in. Face ID, Touch ID or your passcode opens this page.
- **See your computer's screen.** Settings › Screen shows your screen and, when your computer allows it, lets you use its pointer and keyboard. You choose what phones may do on your computer, and the phone asks for Face ID, Touch ID or your passcode each time.
- **Read the wiki.** Settings › Wiki lists the wiki's pages. You can search and edit them.
- **Choose models.** See every model provider set up on your computer with its mark, switch providers on or off, and pick a model and thinking level for the app, a bot or one chat. Fold a provider in the picker to get its models out of the way. A model's page shows what its provider says about it, such as its context window, and leaves out what isn't known. Under each provider you see what is left of its plan ("62% of weekly left · resets Mon"), and Settings › Usage shows each plan and limit as the provider reports it. Settings › Harness chooses what runs your bots: the Copilot SDK for every plan, each provider's own tool, Pi or OMP.
- **See every paired device.** The computer's page in Settings lists the phones and computers paired with it. You can rename one or remove one.
- **Make it yours.** Settings › Appearance has eight themes, each for day and night, seven fonts (San Francisco to begin with), a text size and a control size. The app starts in Ink (black on white, white on black) until you pick another. Home shows Today open under your bots; tap its row to fold it.
- **Connect apps in the Marketplace.** Sign in with your own Composio account, browse more than 1,000 apps with their logos, connect the ones you use, and turn them on for your bots.

### iPhone Shortcuts

In Shortcuts, search for **Botkins**. **Send a Botkins Chat** takes text from a previous action or asks for a prompt. It starts a new chat with your primary bot by default. You can choose another agent, a model and a thinking level. Leave **Wait for Result** on to pass the reply to the next action. Turn **Notify Me** off to silence the reply alert for that turn. Quiet replies need a paired computer running a version with this feature.

**Start a Voice Chat** opens a new chat with the selected agent and starts the same voice mode as the microphone button. The two actions are available together on iOS 17 and later.

## Development

Use Node.js 22 or newer and Xcode (for iOS) or Android Studio.

```sh
npm install
npm run dev-host        # a demo computer to pair with; it prints a pairing code
npx expo run:ios        # build and run on a simulator
npx tsc --noEmit        # typecheck
npm test                # 243 tests: the link, your computer's end of it, the relay path, push, device tools, voice, chat logic, looks, tables, themes
(cd relay && npm test)  # the relay's own tests: 94 (they start wrangler dev)
```

Three scripts rebuild pictures from the design kit and need macOS: `node scripts/build-botkins.mjs` (the Botkins), `node scripts/check-botkins-layers.mjs` (checks the layers used for custom colors; it also needs Python with Pillow and numpy) and `node scripts/build-widget-assets.mjs` (the Live Activity's pictures).

In the simulator, choose **Connect to my computer**, then **Enter a code instead**, then **Type an address instead**, and type `127.0.0.1:47620` and the code that `npm run dev-host` printed. (The demo computer does not announce itself on the network; the desktop app does.)

`AGENTS.md` describes the code layout, how screens read and change the computer's state, and the design rules.

The demo computer reads these environment variables:

| Variable | What it does |
| --- | --- |
| `PORT` | The port it listens on (default 47620, never the real app's 47610). |
| `BOTKINS_DEV_DIR` | The folder it keeps its files in (default: `botkins-dev-host` in the temp folder). |
| `BOTKINS_DEV_NAME` | The computer's name (default: `Demo Mac`). |
| `BOTKINS_DEV_SCREEN` | `off`, `view` or `control`: what phones may do with the screen (default: `control`). |
| `BOTKINS_DEV_PICTURE` | A JPEG file to show as the screen. Clicks and typing are only logged. |
| `BOTKINS_DEV_PRS` | `1` answers pull request lookups with made-up ones. |
| `BOTKINS_DEV_RELAY` | A relay's address to reach the demo computer through. Without it the demo opens no relay socket. |
| `BOTKINS_DEV_AWAY` | `1`, with a relay: phones are told only the relay's address, as if they were away from home. |

In a chat with the demo bot, a message with `approve` asks for approval, `which` asks a question, and `sign in`, `password` or `api key` asks for a sign-in form with a secret field. A message with `calendar`, `contact`, `where am I`, `photo`, `steps` or `email` (and a few related words) makes the bot use the matching tool on your phone, when that source is on in Tools › Device access.

The demo computer opens no outside connection by itself, with one exception: when a phone paired with it has turned notifications on, it sends them through the relay's push route (the relay in `BOTKINS_DEV_RELAY`, else `relay.botkins.app`).

### Shipping

Set `TEAM_ID`, `ASC_KEY_ID`, and `ASC_ISSUER_ID` in your shell. Set `BOTKINS_BUILD` to the next build number. Install the Apple Distribution certificate and the three provisioning profiles in `scripts/ExportOptions.plist`. Run `sh scripts/testflight.sh` to build the app and upload it to TestFlight. The script includes the Live Activity images and selects the production push service.

- **The relay:** `cd relay && npm test && npm run deploy` (Cloudflare, through Wrangler). It serves `https://relay.botkins.app`. Notifications also need the Worker's Apple push key and ids, set once as Worker secrets (`relay/README.md`, "Push notifications").

## How it works

**The link.** The phone talks to the computer over plain HTTP on the local network or a tailnet, and the link encrypts every message itself, so it needs no certificate. Both sides hold an X25519 key. The pairing code, shown as a QR code together with the computer's key, salts the first shared key, so only a phone that saw the code can pair. Every session mixes a fresh key exchange into that, and each message is sealed with ChaCha20-Poly1305 under a number that is accepted once. The computer's end is in `link-host/` (dependency-free Node modules that the Botkins app on your computer keeps in `desktop/link/`), and the phone's end is in `src/link/`. `tests/link.test.ts` runs one against the other. `link-host/README.md` has the limits and the trust model.

**Away from home.** When the phone can't reach your computer directly, it goes through the Botkins relay (`relay/`, a small Cloudflare Worker). Your computer keeps outgoing connections to the relay, so nothing has to be opened on your network, and there is no account to sign in to. The relay only passes messages that are already encrypted between your phone and your computer; it can see how big they are and when they pass, not what they say. At home the phone talks to your computer directly. The relay is off until you turn it on in the Botkins app on your computer (Settings › Phone).

**Capabilities.** Your computer tells the phone what it can do. The link adds `credentials-v1`, `screen-v1`, `prs-v1`, `uploads-v1`, `relay-v1`, `push-v1`, `device-v1` and `voice-v1`. The Botkins app on your computer adds what it supports itself: `looks-v2` (eyes and custom colors for a Botkin), `routine-delivery-v1`, `models-v2` (details about a model) and `board-mentions-v1` (a Today card pinned to a chat). The phone shows a feature only when your computer has it, so an older Botkins app on your computer still works.

**Secrets.** Pairing is a full-trust step. Secrets stay on your computer: the phone never reads a saved credential or a speech provider's key.

**Notifications.** Your computer watches for a finished reply, a bot that needs you and a running turn, and sends what you asked for through the relay (`POST /v1/push`, signed with the key your computer already uses for the relay), which forwards it to Apple. A notification's title and text are sealed with a key only your computer and your phone have, and a notification extension on the phone opens them. The relay and Apple see that something arrived, not what it says. A Live Activity can't be sealed, because Apple hands its state straight to the Lock Screen, so its state is small and plain (a phase, a step count and a short label that names the step only when you have previews on). The key lives in the iPhone's keychain, where the extension can read it, and your computer derives it again when it needs it. `link-host/README.md` ("Push notifications") has the details.

**Device access.** A bot's tool call for your phone waits on your computer until your phone answers it. The phone runs the tool only for a source you switched on, at the level you chose, and checks that again before it acts. What a tool reads goes back to the bot in its answer and nowhere else: not into a log, a toast or the phone's list of what bots used. `link-host/README.md` ("Tools that run on a phone") has the details.

**Voice.** Speech providers (OpenAI, Azure, ElevenLabs, Gemini, your own server, and models your computer runs) are called from your computer, and their keys stay there. The phone dictates with its own recognizer or sends a recording to your computer, plays replies through the computer or its own voice, and for live voice gets at most a short-lived secret for one session. `link-host/VOICE.md` has each provider's routes.

**Coming back to the app.** When the app comes to the front or the network changes, the phone doesn't trust the connection it had: iOS may have closed it. The connection has to answer within a few seconds, or the phone looks for your computer again on every address.

**State.** The computer sends its state as named parts (bots, chats, live activity, tasks and so on), and a phone asks only for the parts it doesn't have. A streaming reply resends only the small "live" part. A chat's messages travel when the chat is open.

**Bots as Botkins.** The characters, palettes, fonts, colors and motion come from the design kit in `design/botkins-kit`. `node scripts/build-botkins.mjs` turns the kit's characters into the pictures in `assets/botkins/`; the app draws eyes, expressions, badges and motion itself from the kit's motion spec. A look in four colors of the person's own is drawn from layers of the same head (`assets/botkins/layers`) that the app tints. The Botkin chosen for a bot is kept on the computer, so every paired phone shows the same one.

**Marketplace.** Botkins signs you in to Composio Connect with OAuth (PKCE, a public client), and manages your connections through Composio's own MCP endpoint. The app list and logos come from a public catalog of Composio's toolkits. Your bots reach the same apps through a Composio entry among your computer's MCP servers, which Botkins sets up and signs in for you.

## Limits today

- Pairing by typing an address and a code works on the same network or a tailnet only; a scanned code also works through the relay.
- Screen over the relay sends pictures a few times a second; it is for checking on things, not for smooth video.
- Notifications and Live Activities need the relay's Apple push key, and the relay's route to Apple has been tried only against a stand-in for Apple (`relay/README.md`). The first check with a real phone is still to do: the simulator can't get a real notification address or run the notification extension for a locally delivered notification.
- Requests are marked time sensitive, but they break through a Focus only after Time Sensitive Notifications is turned on for the app in the Apple developer account (`app.config.ts` says how). Until then they arrive as ordinary notifications.
- Your computer can start a Live Activity from afar only on iOS 17.2 or later. Before that, an activity starts only from a chat that is on screen. A bot with custom colors shows in its character's own colors in a Live Activity.
- No speech provider has been tried with a real key yet. `link-host/VOICE.md` lists what was only read in documentation.
- An iPhone does not let apps read mail, so a bot can write an email for you to send but not read your inbox.
- To open a custom HTML view on the phone, connect to a computer that supports `frames-v1`.
- Screen shows your own computer's screen, not a separate screen for a bot.
- Password manager support needs their command-line tools (`op`, `bw`, `pass-cli`) to be installed and signed in on your computer.
- Screen input for Windows and Linux is written but has not run on real machines yet.

## License

Botkins uses the MIT License. See [LICENSE](../LICENSE). The fonts and other third-party files have separate notices. See [third-party notices](THIRD-PARTY-NOTICES.txt).
