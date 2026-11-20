<p align="center">
  <a href="https://promptclickrun.github.io/Botkins/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.png">
      <img src="docs/assets/wordmark.png" alt="Botkins" width="360">
    </picture>
  </a>
</p>

<p align="center"><strong>Your own team of AI bots. On your computer. On your plans. Under your control.</strong></p>

<p align="center">
  <a href="https://github.com/promptclickrun/Botkins/releases/latest">Download for desktop</a> ·
  <a href="https://botkins.app/downloads">Join the phone beta</a> ·
  <a href="https://promptclickrun.github.io/Botkins/">Website</a> ·
  <a href="LICENSE">MIT License</a>
</p>

---

Botkins is a home for your AI bots. You make a team. Each bot has a name, a job and a face. They chat with you, work on tasks, run on a schedule and keep notes with you.

The bots run on your computer. They use the AI plans you already pay for: **ChatGPT**, **Claude**, **GitHub Copilot**, **OpenCode** and more. You do not need a new account. You do not need a new subscription.

Pair the phone app, and your team goes with you.

## Why Botkins

- **Your computer does the work.** Chats, files, memory and the wiki stay on your disk as plain files.
- **Your plans do the thinking.** Sign in with the providers you have. Botkins never sees your passwords.
- **Your rules apply.** You choose what each bot can see, touch and send. Risky steps ask you first.
- **Your team has character.** Every bot is a Botkin: 20 characters, 8 themes, live animations that show what the bot is doing.

## Features

### Bots that feel like a team

- **Create a bot in seconds.** Start from a template, from your GitHub Copilot agents, or from scratch. Give it a name, a role and instructions.
- **Make it yours in Bot Studio.** Pick 1 of 20 characters, 7 palettes, 6 eye styles, or 4 colors of your own. The Botkin acts out the work: it thinks, plans, codes, browses, waits and celebrates.
- **Give every bot a memory.** Each bot keeps a `MEMORY.md` of facts and preferences. It reads the file at the start of every chat. You can read, edit or clear it.
- **Shape how a bot works.** Each bot can keep its own `AGENTS.md`, `USER.md` and `IDENTITY.md`.
- **Save and share templates.** Export a bot as a `.json` file. Templates never include chats, folders or credentials.

### Chats that do real work

- **Chat live.** Replies stream in. You see the bot think, see each step, and approve each risky action.
- **Steer or queue.** Type while a bot works. Guide the reply now, or queue the next message.
- **Chat in groups.** Put two to six bots in one chat. Use `@` to ask one bot.
- **Let bots help each other.** With **Teamwork**, a bot can ask a teammate for help. The helper sees only what it needs.
- **Mention anything.** Type `#` to add a project, a wiki page or a file. Type `/` for commands and skills.
- **Get rich answers.** Bots reply with Markdown, tables, charts, cards and small interactive apps.
- **Work in a project folder.** Pick a folder and a mode: **Default**, **Plan** or **YOLO**. See every change as a diff. Commit with one click. Botkins never pushes for you.
- **Switch models at any time.** The conversation goes with you. See each plan's limits, such as "62% of weekly left · resets Mon".

### Work that runs while you sleep

- **Today.** Bots post to **Feed**, **Ideas** and **Goals**, and keep live **panels** up to date.
- **Routines.** Schedule a bot once, daily, on weekdays, weekly, or with cron. Choose where the result goes.
- **Tasks.** A task board with Later, Ready, Working, Needs you and Done. Ready tasks start on their own. You approve the result.
- **Usage.** See turns, tokens and cost by day, model and bot. Export to CSV.
- **Background mode.** Close the window. Botkins keeps running, so routines and your phone keep working.

### Shared knowledge

- **Wiki.** You and your bots keep one notebook about goals, projects, people, meetings and playbooks. Pages are plain `.md` files. Export as Markdown, web page or PDF.
- **Projects.** Each project has chats, panels, a to-do list, access rules and git changes.

### Tools and connections

- **Skills.** Teach every bot a task once with a `SKILL.md` folder.
- **MCP servers.** Add local or remote servers. Sign in with a key, a header or OAuth.
- **Plugins.** Browse GitHub plugin catalogs. Review what a plugin declares before you install it.
- **Marketplace.** Connect more than 1,000 apps through your own Composio account.
- **Mac tools.** Let bots read or send iMessage and Mail. Each send asks you first.
- **Voice.** Dictate, hear replies read aloud, or talk live with a bot. Use OpenAI, Azure, ElevenLabs, Gemini or your own server.

### Botkins on your phone

- **Pair in seconds.** Scan a QR code. Your phone can do what your computer can do.
- **Chat, approve and steer** from anywhere. Get notifications and Live Activities.
- **Let bots use your phone, if you allow it.** Calendar, contacts, Health, location and photos. You choose Off, Read, or Read and interact for each one.
- **See your computer's screen.** View only, or view and control. Face ID checks it is you.
- **Use it away from home.** Turn on the relay, and your phone reaches your computer from any network.

### Use Botkins anywhere

- **macOS, Windows and Linux.** Signed and notarized on Mac. Updates check GitHub Releases.
- **Headless servers.** Run Botkins as a service on a computer with no screen, and use it from your phone. One command installs it, and `botkins` operates it from a terminal. See [Run Botkins from a terminal](desktop/docs/terminal.md).
- **One-click Azure.** Deploy a VM that runs Botkins with its own relay, then open the pairing link it returns on your phone. See [Botkins on Azure](deploy/azure/README.md).

  [![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fpromptclickrun%2FBotkins%2Fmain%2Fdeploy%2Fazure%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Fpromptclickrun%2FBotkins%2Fmain%2Fdeploy%2Fazure%2FcreateUiDefinition.json)
- **Other computers.** Pair one Botkins with another, and switch between them from the side menu.

## Privacy and security

Botkins is built to keep your work yours. This is how.

| Promise | How Botkins keeps it |
| --- | --- |
| **No Botkins account. No Botkins cloud.** | Your bots, chats, memory and wiki live in a folder on your computer. |
| **No telemetry.** | The app sends no analytics or usage data to us. |
| **We never see your passwords.** | Each provider's own tool keeps its own sign-in. |
| **Secrets stay locked.** | Keys and tokens live in an encrypted vault. The system keychain guards the vault key. Values are never shown again after you save them. |
| **Bots never see your passwords either.** | A bot asks for a secret with a **secure input**. It gets a one-time handle that works only for the destination you approved, and expires in five minutes. |
| **Your password manager works.** | Link fields from 1Password, Bitwarden or Proton Pass. The value is read only when needed. |
| **Phone links are end-to-end encrypted.** | X25519 key exchange and ChaCha20-Poly1305 seal every message. Each message number is accepted once. |
| **The relay is blind.** | The relay is off by default. When on, it passes sealed messages only. It stores nothing and logs no content. |
| **Notifications are sealed.** | Apple and the relay see only "New message". Your phone opens the text. |
| **You set the limits.** | Per-chat approvals, per-bot project access, and per-source phone permissions. Unwatched runs (routines, tasks, refreshes) can only read. |
| **Bot apps are sandboxed.** | Pages that bots make have no network and no file access. Botkins asks before one opens a link. |
| **No remote content in chats.** | HTML shows as text. Images show as links. Link previews are off by default and never contact private networks. |
| **Releases are verifiable.** | Each release ships with `SHA256SUMS` and a signature. |
| **The code is open.** | Read every line. MIT licensed. |

For the full trust model, read the [link host notes](mobile/link-host/README.md) and the [relay notes](mobile/relay/README.md).

## Get started

1. Download the app for your computer from [GitHub Releases](https://github.com/promptclickrun/Botkins/releases/latest).
2. Open Botkins. Sign in to ChatGPT, Claude or GitHub Copilot. One is enough.
3. Add your Copilot agents as bots, or create a new bot.
4. Say hello.

For your phone, join the [iOS or Android beta](https://botkins.app/downloads). Then open **Settings → Phone** on your computer and scan the code.

## Build from source

| Component | Getting started |
| --- | --- |
| [Desktop](desktop/README.md) · Electron | In `desktop/`, run `npm ci`, then `npm start`. |
| [Mobile](mobile/README.md) · Expo and React Native | In `mobile/`, run `npm ci`. Run `npm start` for Metro, or `npm run ios` to build for an iOS simulator. |
| [Relay](mobile/relay/README.md) · Cloudflare Worker | In `mobile/relay/`, run `npm ci` and `npm test`. |

Each component has its own package manifest and lockfile. Run `npm test` in the component you change. For changes to the desktop–phone link, run both app suites and read the [link contract](mobile/docs/link-contract.md).

To refresh the desktop copy of the mobile link client, install the dependencies of both apps. Then run `node scripts/build-link-client.mjs` from `desktop/`. The desktop tests compare the generated client and the appearance catalog with the mobile sources.

The project website is in [`docs/`](docs/). GitHub Pages serves it from the `main` branch.

## Contributions

Open a pull request to change the default branch. A reviewer must approve the latest changes. The repository owner can merge a pull request without an approval.

## License

Botkins uses the [MIT License](LICENSE). The fonts, provider marks, and third-party code have separate notices. See the notices for the [desktop app](desktop/desktop/THIRD-PARTY-NOTICES.txt) and the [mobile app](mobile/THIRD-PARTY-NOTICES.txt).
