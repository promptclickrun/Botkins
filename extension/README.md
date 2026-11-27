# Botkins Browser Control (Chrome & Edge)

Manifest V3 Chromium extension that lets your Botkins bots control the browser profile you are signed into — even when you are away from the computer (over LAN/Tailscale or through the Botkins relay).

## How it works

- **DOM-first, password-manager safe:** drives tabs via `chrome.scripting.executeScript` and captures viewport screenshots with `chrome.tabs.captureVisibleTab` — no debugging banner and no failure on pages where Proton Pass, 1Password, Bitwarden, or Grammarly inject `chrome-extension://` iframes. Uses ephemeral `chrome.debugger` CDP sessions only as a fallback (full-page screenshots, CSP-blocked `eval`, file uploads / trusted input, or raw `browser_cdp`) and detaches immediately after each call.
- **Botkins Profile sign-in (or direct pairing):** sign in once via `profile.botkins.app` to see all of your Botkins hosts, then toggle which hosts can control this browser profile. Or paste a `botkins://pair?...` link from **Settings › Phone**.
- **Multi-browser support:** label each browser profile in Settings (e.g. `Work Chrome`, `Mac Studio Edge`). Bots can list connected browsers with `browser_list` and target a specific one with the `browser` argument.
- **OpenClaw / Claude tab model:** defaults to **All tabs** (every ordinary tab except incognito, internal `chrome://`/`edge://` pages, and per-tab paused tabs) with one-click switch to **Botkins group** (orange tab group).
- **Secure form fill (`page_fill`):** works with Botkins' `request_secure_input` (`operation: "page_fill"`) and `use_secure_input` so a bot can sign into a site using saved credentials or linked password-manager items (including shared vaults) without ever seeing the secret. After the person approves the destination origin, browser label, and tab title on desktop or phone, the host sends an internal end-to-end sealed `secure.fill` message directly to the extension (never through `browser_type`, `browser_eval`, or CDP). The extension re-checks the tab's origin, restricts filling to the top-level or same-origin frames, matches inputs by `name` (including dotted names) then `id`, refuses password values into non-password inputs, fills with native setters plus `input`/`change` events for React/Vue forms, and zeroes the values in memory. With `submit: true` it re-checks the origin and submits only when the form's action and every submitter's `formaction` stay on the same site (scheme plus registrable domain); a form that posts to a different site is filled but not submitted. It returns only `{ filled, missing }`, plus `submitted` and any `submitRefused` reason when a submit was asked for. After a fill, the tab is marked secret-bearing until the document navigates/reloads/closes (or an SPA clears/removes the filled secret inputs): `browser_eval`, `browser_cdp`, and typing/selecting into the filled secret inputs are refused, and `browser_snapshot` redacts values for all `password`/`secret`/`code` filled inputs.
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
