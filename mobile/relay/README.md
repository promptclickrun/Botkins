# Botkins relay

A small Cloudflare Worker with one Durable Object per room. It lets a phone reach its computer when the two are not on the same network.

The computer keeps an active WebSocket and a standby open to the relay. Older computers use one connection. The phone opens one too. The relay passes messages between them. Every message is already sealed end to end by the link, so the relay can not read it.

The same Worker has two more jobs. It keeps short-lived, sealed team-invite cards in a Durable Object directory and serves the `/join` page (see "Team invites"). `POST /v1/push` sends Apple push notifications for the iPhone app (see "Push notifications"). The push route is a plain forward and stores nothing.

## Trust notes

Nothing secret is ever sent to the relay.

- The computer makes an Ed25519 key pair and keeps the private key. Its room is a hash of the public key. To take its seat, it signs the room and the time with the private key. The relay checks the signature. So the relay's operator, or anyone who reads the relay's data, can not take the seat later: there is no token to steal.
- A signature holds the time (the relay accepts 300 seconds either way). Someone who could read one offer inside the TLS connection could use it for up to 5 minutes to take the seat. Messages stay sealed, so they could only drop them. The real computer takes the seat back when it reconnects; if it is pushed out three times in a row it says so in its settings and tries again every 10 minutes.
- Anyone who knows a room's name can open a phone socket. The computer's own checks (pairing code, device keys, sessions) decide what gets in.

What the relay can see:

- Room names (a hash of the computer's public key).
- Invite lookups (a hash of an invite code), card ciphertext and the public key of the computer that published each card.
- Message sizes and timing.
- Network addresses of the sockets, as Cloudflare shows them to any Worker. It keeps only a per-room hash of the address (IPv6 by /64) as `from`.

What it can not see:

- Message contents. They are sealed by the link (see `link-host/server.mjs`).
- Invite contents. A card is encrypted with a key derived from the invite code.
- Any secret of the computer.

The room keeps opaque requests and recent answer IDs in instance memory. It can replay requests across a short transport gap while that memory survives. Hibernation or eviction discards the queue, and the phone retries unanswered requests. The room drops a phone’s entries when it leaves. Durable room records contain the v3 seat group and, during recovery, its deadline and phone routing IDs. Its invite directory stores only sealed cards it cannot read, together with an expiry and owner public key, in a Durable Object keyed by the hash of the invite code. The card is deleted at expiry. Logs hold counts, socket kinds, close codes and the relay's own fixed close reasons, and nothing else: no lookup, key, signature, room name, `from` tag, card or message content. Invocation logs are off in `wrangler.jsonc` because they record request URLs, which hold room names and invite lookups.

## Wire format

Phones continue to use the original frames. The legacy host protocol is also covered by [the in-memory relay](../tests/fake-relay.ts).

- Computer (v3): offers `botkins.host.v3` with `k.<public key>`, `t.<unix seconds>`, `g.<group>` and `s.<signature>`. The group is a fresh 32-byte random value, encoded as base64url and shared by the two connections of one host instance. Both sign the UTF-8 text `botkins-relay-host-v3:<room>:<group>:<unix seconds>`. A different proven group takes the seat. The phone continues to use `botkins.phone.v1`.
- Legacy computer (v2): `wss://<relay>/v1/host/<room>`, subprotocols `["botkins.host.v2", "k.<public key>", "t.<unix seconds>", "s.<signature>"]`. Keys and signatures are base64url. `<room>` is `base64url(SHA-256("botkins-relay-room-v1:" + <public key text>))`, 43 characters. The signature is Ed25519 over the UTF-8 text `botkins-relay-host-v2:<room>:<unix seconds>`. The relay needs exactly one `k.`, one `t.` and one `s.` entry, a key that gives this room, a time within 300 seconds of its own, and a good signature. Anything else is 401 with no upgrade. The answer selects `botkins.host.v2` and repeats nothing else.
- Phone: `wss://<relay>/v1/room/<room>`, subprotocol `["botkins.phone.v1"]`.
- A v2 computer uses one socket. A v3 computer can attach a second authenticated socket to the same seat. When a third socket from the same proven group arrives, the room evicts the least-recently-heard old socket with the same-group repair close (4001), makes the new socket active, demotes the survivor to standby and replays pending requests immediately. This is not a takeover: it sends no host-closed notice and does not clear the pending cache. A different computer taking the seat still closes the previous computer’s sockets with 4000.
- Up to 48 phone sockets, and up to 8 from one network address. A new phone socket is never turned away: when its address already has 8, that address's oldest socket is closed with 4008, then when the room has 48, the room's oldest is closed with 4008.
- Text `ping` gets `pong` on both kinds of socket. v3 liveness is hibernation-friendly: the room uses the Durable Object auto-response timestamp and recent binary host traffic, checked when a phone joins or sends a request. A bounded set of opening probes samples the heartbeat. After those probes, the room schedules no recurring liveness alarm while idle—even with phones connected—and only arms an alarm for pending request expiry, host liveness while requests are in flight, or a recovery window. v0.16.1 hosts ping every 25 seconds and receive a conservative 40-second silence deadline. Binary traffic refreshes the activity deadline. Closely observed pongs at most 12 seconds apart prove the fast heartbeat and shorten the deadline to 15 seconds. A silence timeout starts the 15-second recovery window at the missed deadline. An older socket attachment without a baseline is initialized on the first wake.
- Phone to computer: `[conn 8][from 8] + the phone's message`. Computer to phone: `[conn 8] + the answer`, sent to that phone with the 8 bytes removed. An answer for a phone that is gone is dropped.
- The v3 room keeps up to 48 outstanding requests and 16 MiB of request bodies across all phones. It holds them in arrival order, including requests sent while both sockets were down. A request that exceeds either limit gets the usual offline answer. The room checks the five-minute request lifetime on activity. A hostless room with held requests can stay resident until its 15-second reconnect window ends.
- A pushed part from the host is `[conn 8][0x07][request id u32][sealed part]`. The room strips the connection prefix and forwards the part. The request stays pending until the normal `0x02` answer, which the host sends within four minutes. Only the final answer gets an acknowledgement.
- The v3 host receives `[conn 8][from 8][0x06][request id u32]` after the room accepts an answer. It can then release the cached answer body. If room memory was lost, the open phone still receives the answer and the host receives the acknowledgement. The room suppresses duplicate answers while it remembers their IDs. If the phone has left and its routing prefix is gone, the host still receives the acknowledgement with eight zero bytes for `from`. The host releases its cache by connection and request ID. This acknowledgement stays between the room and the host.
- No computer connected and no v3 reconnect window: the phone gets `[0x03][id]` for each request.
- A phone socket closes (for any reason, also a 4008): the computer gets `[conn][from][0x04]`.
- A v2 computer disconnects, or a v3 computer exhausts its reconnect window: every phone in the room gets `[0x05]`, so it stops waiting for answers that will not come.
- A phone's message over 6 MiB + 64 KiB (6,356,992 bytes) closes that phone with 1009. The computer's limit is 8 MiB.

Other answers: `GET /` is a one-line text, `GET /v1/health` is `{"ok":true}`, `GET /join` serves the self-contained invite page, and `GET /mcp-auth` answers `302` to the fixed `botkins://mcp-auth` target with the original query string kept intact (no-store, no-referrer, nothing logged) for phone OAuth callbacks. A wrong room name or any other path is 404. A plain GET on a room path is 426. A phone without its subprotocol is 400. Other unsupported methods are 404 and are counted against the request limit like everything else.

`conn` is 8 random bytes made for each phone socket. `from` is the first 8 bytes of `SHA-256(room + ":" + network)`. The network is the address in `CF-Connecting-IP`, or `local` when Cloudflare gives none. An IPv6 address counts as its /64 (the first four groups), so one network can not look like many sources. An IPv4-mapped IPv6 address counts as the IPv4 address. The Worker makes the headers that carry the socket kind and `from` to the Durable Object. It never forwards the client's headers.

## Team invites

The host can publish an encrypted invite card for a code at `PUT /v1/invites/<lookup>`, where the 43-character lookup is `base64url(SHA-256("botkins-invite-v1:" + CODE))`. The body is `{ card, expiresAt }`. The host proves ownership with the same Ed25519 key that owns its relay room and signs the lookup, expiry, card hash and request time. Only that key may replace or delete the card. A card is at most 4096 decoded bytes and expires in at most 30 days.

`GET /v1/invites/<lookup>` returns `{ card }`, or 404 when the invite is missing or expired. `DELETE /v1/invites/<lookup>` removes it after the same ownership proof. The invite Durable Object sets an alarm for `expiresAt`, so expired cards are not kept.

Invite links use `https://relay.botkins.app/join#c=<CODE>&k=<serverKey>`. The code and key stay in the URL fragment, which the browser never sends to the Worker. The page validates the fragment, formats the code and offers the `botkins://join` deep link. It has no external assets, sends no referrer and is not cached.

## Spaces shared by link

A computer can put out a sealed copy of a space, and anyone with the link reads it in a browser. The whole contract is `mobile/docs/spaces.md`, "Share by link". The relay's part:

- **The relay cannot read a copy.** It is sealed (AES-256-GCM) with a key that is only in the link's fragment, `https://relay.botkins.app/s/<shareId>#k=<key>`, which a browser never sends. The relay keeps the bytes and gives them back.
- `PUT /v1/spaces/<shareId>` keeps a copy, at most 4 MiB, for at most 7 days. The computer signs it with its relay key, as for an invite, and sends a salt: `shareId` is 16 bytes of `SHA-256("botkins-space-id-v1:" + key + ":" + salt)`, so nobody else can ever put a copy under that id. This is checked before any of the body is read.
- `DELETE /v1/spaces/<shareId>` takes it back, with the same proof. The relay remembers the signed time of a DELETE for ten minutes: a PUT that was on its way when the DELETE arrived was signed earlier and is refused (409), so a link that was taken back stays taken back.
- `GET /v1/spaces/<shareId>` gives the bytes to anyone, `cache-control: no-store`, or 404.
- One computer key holds at most 100 live copies, 64 MiB in all, and puts at most 30 a minute (429 after that). The Worker counts these in a Durable Object named by the key (`SpaceOwner`); a copy is one named by its id (`Space`), kept in pieces of 256 KiB, with an alarm for when it ends.
- All copies together take at most 1 GiB (507 after that, until copies end or are taken back). Any key can sign a copy, so this is what keeps shared spaces from filling the storage that rooms and invites need. On Cloudflare one object for the whole relay keeps the count (`SpaceBudget`); it is asked when a copy is put or taken back, never when one is read. The Node relay takes `SPACE_BYTES_MAX` (bytes) to change it.
- `GET /s/<shareId>` is the page. It is the same for every id, so the relay never learns what a link opens: the page's script (`src/space-page.js.txt`) fetches the copy, opens it with the key and draws it. Every string of a copy is written as text. The page's policy lets it load only from the relay itself and run only its own script (a nonce).
- `GET /s/frame` is an empty document for a panel that is a page of its own (an app panel). It is served with `sandbox allow-scripts` and the phone's custom-view policy, so it has no origin and no network: it cannot read the link's key, the page that holds it or anything this address keeps. `src/space-frame.js.txt` takes the panel's page from the page that holds it, in one message. It also keeps every nested frame out of that page: a frame made there would have WebRTC again, and no browser policy forbids an empty or inline one (see "Share by link" in `mobile/docs/spaces.md` for what was checked and what was not).
- `GET /s/botkin/<head>-<palette>.webp` is a Botkin's picture for the page. On Cloudflare these are static assets (`assets` in `wrangler.jsonc`, the phone app's `assets/botkins`, without its `layers` folder); a request for one does not run the Worker.

`test/space-page.test.mjs` runs the page's script with a document of its own: it opens a sealed copy as a browser would, and shows that markup and `javascript:` links in a copy stay text. `mobile/tests/space-page.test.ts` keeps the frame's policy and the page's colors the same as the phone's.

## Run and test on this machine

```sh
npm install
npm run dev        # wrangler dev, local only: http://localhost:8787
npm test           # unit tests, then real `wrangler dev` runs on free ports (the relay, and push with a fake Apple), then they stop
npm run typecheck  # wrangler types, then tsc
```

The relay and push test files run side by side. The relay suite waits through real hibernation, liveness and recovery deadlines. Three tests wait about 10 seconds each, see "Known behavior".

Under `wrangler dev` a local client can set `CF-Connecting-IP` itself, and the Worker uses it. The tests use that to act as many addresses. On Cloudflare the header is set by Cloudflare and can not be set by a client.

None of this logs in to Cloudflare or changes anything in an account.

## Self-hosted relay on Node

`node/server.mjs` is the same relay on plain Node, for a server that should not depend on `relay.botkins.app`. The Azure one-click deployment runs it behind Caddy (`deploy/azure`).

```sh
npm run start:node   # PORT (8080), HOST, DATA_DIR, CLIENT_IP_HEADER, PUSH_UPSTREAM, RATE_LIMITS, BOTKINS_DIR
npm run test:node    # the relay tests above against it (RELAY_TARGET=node), and test/node.test.mjs
```

- It speaks `botkins.host.v3` and `botkins.host.v2` as the Worker does: the active and standby host sockets, the bounded request cache and its replay, the `0x06` acknowledgements, the silent-seat rules and the 4001 repair close. The checks and limits are the Worker's own code (`src/pure.ts`, `src/shared.ts`). The whole of `test/relay.test.mjs` passes against it. Assertions that count Durable Object wakes are skipped, because Node has nothing to hibernate.
- Rooms and held requests are in memory. A restart drops the sockets, and computers and phones connect again on their own. Invite cards are kept in `DATA_DIR/invites.json`, and the sealed copies of shared spaces in `DATA_DIR/spaces` with `DATA_DIR/spaces.json`.
- It serves the shared-space routes as the Worker does. The Botkin pictures come from `BOTKINS_DIR` (the phone app's `assets/botkins` by default; the Docker image has a copy).
- It runs behind a TLS proxy. `CLIENT_IP_HEADER` names the header in which that proxy gives the client's address. Without it the relay uses the address of the socket.
- It has no Apple key. It forwards `POST /v1/push` unchanged to `PUSH_UPSTREAM` (`https://relay.botkins.app` by default). The computer already signed the request, so the relay adds nothing. `PUSH_UPSTREAM=off` sends none.
- It serves `/pair`: a page that draws a QR code of the `botkins://pair` link in the URL fragment. The browser does not send the fragment to the relay.
- It keeps the logging rule above: event kinds, counts, close codes and fixed reasons only.

## Deploy

```sh
npx wrangler login   # once
npm run deploy
```

The Durable Object classes are SQLite-backed (`new_sqlite_classes`), the only kind the Free plan allows. The `v1` migration creates `Room`; `v2` adds `Invite`.

## Limits

- A phone's message: 6 MiB + 64 KiB. The computer's message: 8 MiB. (The platform's own limit is 32 MiB.) Anything bigger must be split.
- The room holds up to 48 pending requests totaling at most 16 MiB across all phones, plus the last 128 accepted or expired request IDs for up to five minutes.
- 1 computer and 48 phones per room, at most 8 phones from one network address.
- One Durable Object handles about 1,000 requests a second, a soft limit.
- Free plan: 100,000 Worker requests and 100,000 Durable Object requests a day, 13,000 GB-s of duration a day, 10 ms of CPU per request. Checking a signature and forwarding a message take little CPU.

## Rate limits

The Worker limits how often one network may knock, with the Workers Rate Limiting binding ([docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)), declared in `wrangler.jsonc`:

- `SOCKETS`: 30 new sockets a minute for each network.
- `REQUESTS`: 120 of everything else a minute for each network (pages, health checks, wrong paths, other methods, bad room names, and every call to `/v1/push`).
- `INVITES`: 20 GET lookups a minute for each network, in addition to `REQUESTS`.
- `SPACES`: 60 reads of a shared space's copy a minute for each network, in addition to `REQUESTS`.
- `PUSHES`: 240 push items a minute for each computer key (not each network). See "Push notifications".

A network is an IPv4 address or an IPv6 /64. Over the limit the answer is 429, before any other work. The counts are kept per Cloudflare location and are approximate: they stop a flood, they are not an exact gate, and a new deployment takes a few minutes to start enforcing them. The limits were seen working on this account's plan (a burst of 320 requests got 194 answers of 429).

Local tests pass `--var=RATE_LIMITS:off`, because every socket of a test run comes from one address. (`test/push.test.mjs` also runs one Worker with the limits on: locally the `PUSHES` and `REQUESTS` bindings do trip, 429 after 240 items and after 120 calls. They are still approximate on Cloudflare.) A phone and a computer that meet a 429 wait and try again by themselves (the phone backs off to 15 seconds, the computer to 60).

These rate-limit bindings apply to HTTP requests and socket upgrades. A zone-level rate limiting rule for this hostname can be added on top if the Worker's own limits ever prove too loose.

## Push notifications

`POST /v1/push` lets a paired computer send Apple push notifications to its phones. The Worker checks the computer's signature, signs for Apple with the team's APNs key, and forwards each item to Apple. It keeps nothing: no token, no payload, no log of either.

### Request

`content-type: application/json`, a body of at most 64 KiB:

```json
{ "v": 1, "key": "<Ed25519 public key, base64url, 43 chars>", "time": 1700000000,
  "sig": "<base64url Ed25519 signature, 86 chars>", "sends": "<a JSON string>" }
```

- `key` is the computer's relay key, the one its room comes from (`roomOf` in `src/pure.ts`). `time` is unix seconds as a JSON number, within 300 seconds of the Worker's clock.
- `sends` is a string that holds JSON, so the signature covers exact bytes. `sig` is Ed25519 over the UTF-8 bytes of `"botkins-push-v1:" + time + ":" + sends`. The Worker parses `sends` only after the signature is good.
- `sends` is an array of 1 to 8 items:

```json
{ "token": "<APNs token, lowercase hex, 64 to 200 chars>", "env": "production" | "sandbox",
  "type": "alert" | "background" | "liveactivity", "priority": 5 | 10,
  "expiration": 0-86400, "collapse": "<optional>", "payload": { "aps": { } } }
```

- `expiration` is seconds from now. `0` means Apple tries once. `collapse` is 1 to 64 visible ASCII characters (it travels as a header). Other keys in an item are ignored.
- `payload` goes to Apple as it is. The Worker only checks that it is an object with an `aps` object, and that its JSON is at most 4096 bytes (counted in UTF-8).
- The caller never chooses the topic. It is the var `APNS_TOPIC` (`app.botkins.mobile`), plus `.push-type.liveactivity` for `liveactivity`. A `background` push is always sent with priority 5, whatever `priority` says.

For each item the Worker calls `POST https://api.push.apple.com/3/device/<token>` (`https://api.sandbox.push.apple.com` for `sandbox`) with `authorization`, `apns-topic`, `apns-push-type`, `apns-priority`, `apns-expiration` (`0`, or now plus `expiration`) and, when given, `apns-collapse-id`. All items go at the same time.

### Answers

`200` and `{ "results": [ ... ] }`, one entry for each item, in order:

```json
{ "results": [ { "status": 200 }, { "status": 410, "reason": "Unregistered" }, { "status": 400, "reason": "BadDeviceToken" }, { "status": 502, "reason": "unreachable" } ] }
```

`status` is Apple's. `reason` is Apple's `reason` word when it sends one (anything that is not a short word of letters and digits is left out). A network failure or no answer from Apple within 10 seconds is `{ "status": 502, "reason": "unreachable" }`. A `410` means the token is dead: the computer should stop using it.

The whole request is refused, and nothing goes to Apple, with `{ "error": "<code>" }`:

| Status | Code | When |
| --- | --- | --- |
| 400 | `bad_request` | Not JSON, a missing or mistyped field, `v` not 1, a bad `key` or `sig` shape, `sends` that is not 1 to 8 good items, a bad item (token, env, type, priority, expiration, collapse, payload), a payload over 4096 bytes or without `aps`. |
| 401 | `unauthorized` | `time` more than 300 seconds off, or a signature that is not the key's signature of those bytes. |
| 405 | `method_not_allowed` | Not a POST. |
| 413 | `too_large` | A body over 64 KiB. |
| 429 | `rate_limited` | Over the network limit or the key's limit. |
| 503 | `push_off` | The APNs secrets are not set (or the key can not be read). |

An answer never holds a token, a key or a payload, and neither does a log line. Logs hold counts: how many items, how many Apple took.

### Limits

- `PUSHES`: 240 items a minute for each `key`, checked after the signature, so nobody can use up another computer's allowance. The binding's `delta` option weights one `limit()` call by the number of items, so a request costs its item count. The binding allows a call while the count is under the limit, so one request can end up to 7 items over. A request over the limit is refused whole.
- The `REQUESTS` limit for the network applies first, as on every other route, with one count for each call.
- `RATE_LIMITS=off` turns all of them off, for local tests.
- The Worker makes at most 8 calls to Apple for one request, which is far below the Worker's own subrequest limits.

### APNs token

The Worker signs an ES256 token (`kid` is `APNS_KEY_ID`, claims `iss` is `APNS_TEAM_ID` and `iat`) with the PKCS#8 key in `APNS_KEY_P8`. A push to Apple's test service (sandbox) is signed with the second key instead, when one is set (`APNS_SANDBOX_KEY_P8`, `APNS_SANDBOX_KEY_ID`). It keeps each key's token in memory and `iat` is always rounded down to a 30 minute step, so every instance signs the same `iat`. A token is used for its step only, which is at most 30 minutes, so it is also always under Apple's 40-minute rule for remaking, and its `iat` is never older than the hour Apple allows. Apple asks for a new token no more often than every 20 minutes and no less than every 60: a 30 minute step does both.

### Turn push on

The key and ids are Worker secrets. They are not in `wrangler.jsonc` or any file. The owner runs these once, and pastes each value when asked (the `.p8` file's whole text, with its `-----BEGIN PRIVATE KEY-----` lines, for the first):

```sh
cd relay
npx wrangler secret put APNS_KEY_P8     # the text of the AuthKey_XXXXXXXXXX.p8 file
npx wrangler secret put APNS_KEY_ID     # the 10 characters in the key's file name
npx wrangler secret put APNS_TEAM_ID    # the 10 characters of the Apple developer team id
```

The key has to be one Apple lets send to this app. In the developer account (Certificates, Identifiers & Profiles › Keys) a push key is made for an environment (Sandbox, Production, or both) and as "Team Scoped" or "Topic Specific" with a list of apps. Apple's rules ([Establishing a token-based connection to APNs](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)):

- A team has at most two Team Scoped keys for each environment. When they are used up, the form answers "You have already reached the maximum allowed number of team scoped Keys".
- A Topic Specific key is for one environment only (the form offers it for Sandbox or for Production, not for both). A team may have 200 of them for each environment.

So there are two ways to set this up:

- **One key for both**: a Team Scoped key made for Sandbox & Production, in `APNS_KEY_P8` and `APNS_KEY_ID`. It can send to every app of the team.
- **A key for each environment**: two Topic Specific keys with the app's bundle id (`app.botkins.mobile`) as their only topic. The Production one goes in `APNS_KEY_P8` and `APNS_KEY_ID`; the Sandbox one in `APNS_SANDBOX_KEY_P8` and `APNS_SANDBOX_KEY_ID`. TestFlight and App Store builds use production; a development build on a real phone uses the sandbox. Without the second key such a build gets no notifications.

```sh
npx wrangler secret put APNS_SANDBOX_KEY_P8 < /path/to/AuthKey_YYYYYYYYYY.p8   # only with a key for each environment
npx wrangler secret put APNS_SANDBOX_KEY_ID
```

With a key for another app Apple answers `TopicDisallowed`; with a key for one environment it answers `BadEnvironmentKeyInToken` on the other. A second key that can't be read stops only the sandbox: its items answer `503 KeyUnusable`. A made-up device address does not show a wrong topic: Apple answers `BadDeviceToken` first, so only a real phone's "Send a test" proves the key. (It does show that Apple knows the key: a key Apple does not know answers `InvalidProviderToken`.)

Or, to read the key from the file without printing it: `npx wrangler secret put APNS_KEY_P8 < /path/to/AuthKey_XXXXXXXXXX.p8`. Until the first three are set, the route answers `503 push_off`. `APNS_TOPIC` is a plain var in `wrangler.jsonc`. Deploy the Worker first (`npm run deploy`), then set the secrets: each `wrangler secret put` makes a new version live. The rate limits have `namespace_id` values starting at 47611: namespace ids are shared by every Worker on the account, so change them if another Worker already uses them.

### What the Worker can and can not see

It sees, while a push passes through: device tokens, payloads, the computer's public key and the times of pushes. It stores none of them and logs none of them. It holds Apple's signing key, so whoever can edit this Worker could send pushes to the app as the team: protect the Cloudflare account like the key. It can not read message text. The computer seals alert text with the link's keys and the phone opens it, so the payloads this route forwards carry no message text, only sealed data and routing.

A signed request can be sent again by anyone who sees it inside the TLS connection, for up to 5 minutes (the same as a seat offer, see "Trust notes"). The most that does is repeat pushes the computer already asked for, and the key's limit bounds it.

### Tests and what they can not show

`test/push.test.mjs` starts `wrangler dev --local` with a throwaway P-256 key and `--var=APNS_HOST:http://127.0.0.1:<port>`, a small local server that plays Apple. `APNS_HOST` is a test-only var: when it is set it replaces both of Apple's hosts (the path stays `/3/device/<token>`) and the Worker adds a header `x-botkins-apns-env: production|sandbox`, so a test can see which host was meant. It is unset in `wrangler.jsonc`. `test/push-pure.test.mjs` tests the helpers in `src/push.ts` alone.

Not verified on this machine: a real call to Apple. Apple's servers need HTTP/2 (the fake one speaks HTTP/1.1), and the Cloudflare docs do not say in so many words that Worker `fetch` uses HTTP/2 to an origin. Other projects send APNs pushes from Workers, but that is not checked here. The first real push (to a sandbox build, to one's own device) is the check: an answer of `502 unreachable` for every item means the Worker could not connect. A token or key problem shows as Apple's own `403` with `reason` (`InvalidProviderToken`, `ExpiredProviderToken`, `BadTopic`...).

## GitHub App ("Botkins Agent"): installation binding, webhooks & tokens

The relay integrates with the **Botkins Agent** GitHub App (`botkins-agent`, App ID `5896932`) so any Botkins user can install the App on their repositories, receive real-time events, and reply on GitHub as **Botkins Agent**—without sending personal GitHub tokens through the relay and without co-mingling across users.

### Installation binding (`GET /v1/github/setup`)

1. From **Settings › GitHub** (or `botkins github install`), the host builds a signed 10-minute `state` parameter (`botkins-github-setup-v1:<room>:<nonce>:<exp>` signed with the host's Ed25519 relay key) and opens `https://github.com/apps/<slug>/installations/new?state=<state>`.
2. GitHub installs the App with **"Request user authorization (OAuth) during installation"** enabled and redirects to `GET /v1/github/setup?installation_id=...&code=...&state=...`.
3. The relay verifies the `state` signature and expiry, consumes the one-time nonce, exchanges `code` for a one-time user token using `GITHUB_AGENT_CLIENT_ID` / `GITHUB_AGENT_CLIENT_SECRET`, confirms `installation_id` appears in `GET /user/installations` for that user, reads the installation's repository list and installer login, and **immediately discards the user token** (never stored or logged).
4. The binding (`installation_id` ↔ `room` + repository set) is stored in the `GitHubRouter` Durable Object (or `DATA_DIR/github-bindings.json` on the self-hosted Node relay). `installation` (`deleted` / `suspend` / `unsuspend` / `created`) and `installation_repositories` (`added` / `removed`) webhooks keep bindings and repo sets up to date automatically.

### Webhook ingress (`POST /v1/github/events`), fan-out, and team claim locks

- **Secret:** `GITHUB_WEBHOOK_SECRET` (Worker secret or Node env var). When unset, `POST /v1/github/events` answers `503 {"error":"github_off"}`.
- **Body cap & signature:** `512 KiB` (`413`), `content-type: application/json` (`415`), constant-time HMAC-SHA256 on `x-hub-signature-256` (`401` on invalid/missing).
- **Rate limits & dedupe:** Per-IP (`GITHUB_IP`, `namespace_id: 47617`, 120/min) and per `installation.id` (`GITHUB_INSTALL`, `namespace_id: 47618`, 240/min); `x-github-delivery` deduplicated for 10 minutes.
- **Strict deny-by-default routing:** Deliveries are routed ONLY to rooms bound to `payload.installation.id` AND actively subscribed to `repository.full_name`. Bound rooms subscribe with no personal token (`room_installation_repos` proves access). Unbound rooms receive zero frames unless the relay explicitly opts into legacy user-token mode (`GITHUB_ALLOW_USER_TOKEN_AUTH=1`, off by default and ignored whenever App credentials are configured) and the host explicitly opts into sending its local `gh` token when unbound (also off by default; public repositories need no token).
- **Team claim locks:** Multiple rooms bound to the same installation (a team) all receive event frames, and hosts send a signed `github-claim` message over their WebSocket so the relay grants an atomic per-delivery claim lock to exactly one room.

### Single-repository installation tokens (over host WebSocket)

- Over its authenticated WebSocket, a host sends a signed `github-token` request naming one `owner/repo` and minimal permissions (clamped to the App ceiling: `issues`, `pull_requests`, `contents` write; `checks`, `statuses`, `metadata` read).
- The relay checks that the room is bound to an active installation owning that repository, then mints a short-lived installation token scoped strictly to `repositories: [<repo>]`. Tokens are kept only in memory on the host until near expiry and are never logged.

### Self-hosting with your own GitHub App

Create a GitHub App under your user or organization with:
- **Webhook URL:** `https://<your-relay>/v1/github/events` (with a random webhook secret).
- **Setup URL:** `https://<your-relay>/v1/github/setup` (and check **"Redirect on update"**).
- **Callback URL:** `https://<your-relay>/v1/github/setup` and check **"Request user authorization (OAuth) during installation"**.
- **Repository permissions:** Issues (Read & write), Pull requests (Read & write), Contents (Read & write), Checks (Read-only), Commit statuses (Read-only), Metadata (Read-only).
- **Subscribe to events:** `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `check_suite`, `status`, `push`, `installation`, `installation_repositories`.

Set these environment variables on your Cloudflare Worker (`wrangler secret put`) or self-hosted Node relay (`mobile/relay/node/server.mjs`) — do **not** reuse `GITHUB_APP_*` (which belong to Botkins Intake feedback):
- `GITHUB_AGENT_APP_ID` — numeric GitHub App ID
- `GITHUB_AGENT_APP_SLUG` — App URL slug (e.g. `botkins-agent` or your own slug)
- `GITHUB_AGENT_APP_KEY` — PEM PKCS#8 private key for the App
- `GITHUB_AGENT_CLIENT_ID` — OAuth Client ID of the App
- `GITHUB_AGENT_CLIENT_SECRET` — OAuth Client Secret of the App
- `GITHUB_WEBHOOK_SECRET` — Webhook secret for `POST /v1/github/events`

## Pricing notes

- Hibernated sockets stay open without duration charges. A room with held requests during host recovery can incur duration for the remaining reconnect window (at most 15 seconds at 128 MB). Ordinary request and answer traffic schedules no timer and incurs zero storage reads or writes.
- Seat and recovery changes write or delete durable records. Host admission also checks for and removes old pending storage. Each alarm firing counts as a request and setting an alarm counts as a row written. The room schedules an alarm only for opening heartbeat probes (at most 4), pending request expiry and liveness while requests are in flight, or recovery expiry. After the opening probes, an idle room with connected hosts and phones generates no recurring alarms.
- Incoming WebSocket messages are billed 20 to 1: 100 messages from phones and computers count as 5 requests. Messages the relay sends are free. Opening a socket counts as one request. Protocol pings are free, and the `ping` text is answered by the runtime without waking the object.
- Workers Logs is on. It writes one line per open, close and wake. The Free plan allows 200,000 log lines a day.

## Known behavior

When the relay closes a socket from another socket's event (the old computer socket it replaces, or a phone it replaces with 4008), workerd sends the Close frame at once but keeps the TCP connection open until the client closes it. Clients get the close code right away. Node's WebSocket only reports the close after its own 10 second timeout, so the tests that check 4000 and 4008 wait that long.

In a local `wrangler dev` check, a replaced computer deliberately stopped reading its socket before the relay closed it. After 14 seconds of silence the next phone request woke the room with all three sockets still attached (old computer, new computer and phone).
