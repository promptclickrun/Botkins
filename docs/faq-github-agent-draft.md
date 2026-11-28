# FAQ Draft: Use Botkins from GitHub

**Question:** How do I use Botkins from GitHub (`@botkins-agent`)?
**Suggested section:** Tools / Automations (`tools` or `unattended`)
**Suggested id:** `use-botkins-from-github`

## Answer

You can summon your own Botkins bots right inside GitHub issues and pull requests—the way you would `@mention` a teammate—using the **Botkins Agent** GitHub App (`@botkins-agent`).

### 1. Install Botkins Agent

1. Open **Settings › GitHub** in Botkins (desktop or phone, owner only), or run `botkins github install` on a terminal host.
2. Click **Install Botkins Agent**. Botkins opens GitHub with a short-lived signed install link (valid for 10 minutes) tied to your computer's relay room key.
3. Choose the GitHub account or organization and repositories you want to connect, then approve the installation.
4. GitHub confirms your access to that installation with the relay once, binds that installation to your host, and discards the one-time authorization token immediately.

### 2. Mention your bots

In **Settings › GitHub**, turn on **Answer `@botkins-agent` mentions** for any connected repository and pick a default bot.

- Write `@botkins-agent glory please investigate this failing test` to address the bot named **Glory** on your host (matched by name, case-insensitive).
- Write `@botkins-agent summarize this PR` (with no bot name) to send it to that repository's default bot.
- Botkins reacts immediately with 👀 on your comment, runs the turn on your computer, and replies as **Botkins Agent** starting with the answering bot's name (for example, `**Glory** · Botkins`).
- You can also build custom multi-step workflows in **Routines › Workflows** using the **GitHub** trigger (`@botkins-agent` mention or any of the 12 GitHub events) and native GitHub output steps.

### 3. Who can summon your bots

By default, only:
- The person who installed Botkins Agent on that account/organization, and
- Repository collaborators with **write**, **maintain**, or **admin** permission (checked against GitHub using the installation token).

You can optionally add extra GitHub usernames to a per-repository **allowlist** in **Settings › GitHub** (or `botkins github repo <owner/repo> --allowlist user1,user2`). Anyone else who mentions `@botkins-agent` is ignored silently (no reaction, no reply) and logged in your local delivery ledger as `unauthorized`.

All GitHub-triggered turns run under Botkins' **unattended** safety gates: comment text is framed as untrusted external data, memory and wiki are read-only, phone/Mac native tools and vault prompts are disabled, and raw event text is never echoed back to GitHub.

### 4. Privacy & isolation

- **No personal tokens on the relay.** You never send your personal `gh` token to the Botkins relay. Your host requests short-lived installation tokens scoped to a single repository over its authenticated WebSocket, keeps them only in memory until expiry, and never logs them.
- **No co-mingling across users.** The relay routes webhook events and mints tokens strictly for rooms bound to that `installation_id`. Two different installations never see each other's events or tokens. Uninstalling or suspending the App on GitHub removes the binding automatically.
- **Teams sharing one installation.** If multiple hosts on a team are bound to the same installation, the relay grants an atomic claim lock per delivery so exactly one host answers a mention.
- **Self-hosting.** If you run your own Node or Cloudflare relay, you can create your own GitHub App and configure `GITHUB_AGENT_APP_ID`, `GITHUB_AGENT_APP_SLUG`, `GITHUB_AGENT_APP_KEY`, `GITHUB_AGENT_CLIENT_ID`, `GITHUB_AGENT_CLIENT_SECRET`, and `GITHUB_WEBHOOK_SECRET` (see `mobile/relay/README.md`).
