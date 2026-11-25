// Relay-cost-conscious Botkins Link bridge for the Chromium MV3 extension.
//
// Wraps the existing bundled Botkins LinkClient (desktop/desktop/remote/link-client.mjs) — zero
// duplicated crypto or protocol code — with settings tuned for a Chromium browser extension:
//
// - Direct LAN/Tailscale is always preferred when reachable (zero relay traffic).
// - Over relay, uses `relayFetch` with `pingMs: 24_000` (under Chrome's 30s MV3 service worker
//   idle timer; answered by Cloudflare Durable Object auto-response `"ping"`/`"pong"` without
//   waking the DO).
// - On the host side (`mobile/link-host/server.mjs`), `kind: "browser"` receives ONLY `meta` and
//   its own `asks` — never chats, runs, spaces, or streaming text — and follows over the relay
//   without idle binary heartbeats for 10 minutes at a time (or 25s long-poll on LAN).
import {
  PROTOCOL,
  LinkClient,
  LinkError,
  findHost,
  isRelayHost,
  pair,
  parsePairingUrl,
  profileApi,
  profileConnect,
  relayFetch,
} from "../../desktop/desktop/remote/link-client.mjs";

export { PROTOCOL, LinkClient, LinkError, findHost, isRelayHost, pair, parsePairingUrl, profileApi, profileConnect, relayFetch };

const RELAY_PING_MS = 24_000; // < 30s MV3 SW idle timer; handled by DO auto-response
const UPLOAD_CHUNK = 512 * 1024; // 512 KiB per link.upload chunk

function randomUploadId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export class BrowserHostClient {
  /**
   * @param pairing  Saved Link Pairing for one Botkins host.
   * @param options  { onState, onRoute, onHosts, onAsks, getBrowserState, fetch?, WebSocket? }
   */
  constructor(pairing, options = {}) {
    this.pairing = pairing;
    this.options = options;
    this.baseFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.fetcher = relayFetch(this.baseFetch, {
      WebSocket: options.WebSocket ?? globalThis.WebSocket,
      pingMs: RELAY_PING_MS,
      deadMs: 12_000,
      idleMs: 30_000,
    });
    this.state = "offline";
    this.route = null;
    this.lastError = "";
    this.announced = false;

    this.client = new LinkClient(pairing, {
      fetch: this.fetcher,
      probeMs: 60_000,
      probeMaxMs: 10 * 60_000,
      textStreaming: () => "off",
      onState: (state) => {
        this.state = state;
        if (state === "online" && !this.announced) {
          this.announced = true;
          void this.syncBrowserState();
        } else if (state !== "online") {
          this.announced = false;
        }
        this.options.onState?.(state, state === "revoked" ? "Removed on host." : "");
      },
      onRoute: (route) => {
        this.route = route;
        this.options.onRoute?.(route);
      },
      onHosts: (hosts) => {
        this.pairing = { ...this.pairing, hosts };
        this.options.onHosts?.(hosts);
      },
      onParts: (parts) => {
        if (Array.isArray(parts?.asks) && parts.asks.length > 0) {
          this.options.onAsks?.(parts.asks);
        }
      },
    });
  }

  start() {
    this.client.start();
  }

  stop() {
    this.announced = false;
    this.client.stop();
    this.fetcher.rest?.();
  }

  wake() {
    this.fetcher.check?.(3000);
    this.client.wake();
  }

  async syncBrowserState() {
    const bState = await this.options.getBrowserState?.();
    if (!bState) return;
    await this.reportBrowserState(bState);
  }

  async reportBrowserState(state) {
    try {
      await this.client.call("link.browser.state", state);
    } catch {}
  }

  async answerAsk(askId, answer) {
    return await this.client.call("link.browser.answer", askId, answer);
  }

  async unpair() {
    await this.client.call("link.unpair").catch(() => {});
  }

  async uploadBase64(base64Data, name) {
    const bin = atob(base64Data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let id = null;
    let path = "";
    let offset = 0;
    while (offset < bytes.length || offset === 0) {
      const slice = bytes.subarray(offset, offset + UPLOAD_CHUNK);
      let chunkStr = "";
      for (let i = 0; i < slice.length; i++) chunkStr += String.fromCharCode(slice[i]);
      const data = btoa(chunkStr);
      const last = offset + slice.length >= bytes.length;
      const payload = id == null ? { name, data, last } : { id, data, last };
      const res = await this.client.call("link.upload", payload);
      id = res?.id ?? id;
      path = res?.path ?? path;
      if (last) break;
      offset += slice.length;
    }
    return path;
  }
}
