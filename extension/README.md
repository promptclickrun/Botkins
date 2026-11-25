# Botkins Browser Control (Chrome & Edge)

Manifest V3 Chromium extension that lets your Botkins bots control the browser profile you are signed into — even when you are away from the computer (over LAN/Tailscale or through the Botkins relay).

## How it works

- **DOM-first, password-manager safe:** drives tabs via `chrome.scripting.executeScript` and captures viewport screenshots with `chrome.tabs.captureVisibleTab` — no debugging banner and no failure on pages where Proton Pass, 1Password, Bitwarden, or Grammarly inject `chrome-extension://` iframes. Uses ephemeral `chrome.debugger` CDP sessions only as a fallback (full-page screenshots, CSP-blocked `eval`, file uploads / trusted input, or raw `browser_cdp`) and detaches immediately after each call.
- **Botkins Profile sign-in (or direct pairing):** sign in once via `profile.botkins.app` to see all of your Botkins hosts, then toggle which hosts can control this browser profile. Or paste a `botkins://pair?...` link from **Settings › Phone**.
- **Multi-browser support:** label each browser profile in Settings (e.g. `Work Chrome`, `Mac Studio Edge`). Bots can list connected browsers with `browser_list` and target a specific one with the `browser` argument.
- **OpenClaw / Claude tab model:** defaults to **All tabs** (every ordinary tab except incognito, internal `chrome://`/`edge://` pages, and per-tab paused tabs) with one-click switch to **Botkins group** (orange tab group).
- **Relay-cost friendly at scale:**
  - Always prefers direct LAN/Tailscale connections when reachable.
  - Over the relay, the host sends only `meta` and that browser's own `asks` (never chats, runs, spaces, or text streams), uses a 10-minute `link.follow` with zero idle binary heartbeats, and relies on Cloudflare Durable Object WebSocket auto-response `"ping"`/`"pong"` so idle browser extensions do not wake Durable Objects or generate billable relay chatter.

## Build & load unpacked (Chrome or Edge)

```bash
cd extension
npm run build
```

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder.
4. Click the Botkins toolbar icon, sign in to your Botkins profile (or paste a pairing link), and toggle on the host(s) you want.

## Package zip for Chrome Web Store / Edge Add-ons

```bash
cd extension
npm run pack
```

Outputs `extension/release/botkins-browser-extension.zip`.

## Tests

```bash
cd extension
npm test
```
