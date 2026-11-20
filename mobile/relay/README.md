# Botkins relay

A small Cloudflare Worker with one Durable Object per room. It lets a phone reach its computer when the two are not on the same network.

The computer keeps one outgoing WebSocket open to the relay. The phone opens one too. The relay passes messages between them. Every message is already sealed end to end by the link, so the relay can not read it.

The same Worker has one more job: `POST /v1/push` sends Apple push notifications for the iPhone app (see "Push notifications"). It is a plain forward. It stores nothing.

## Trust notes

Nothing secret is ever sent to the relay.

- The computer makes an Ed25519 key pair and keeps the private key. Its room is a hash of the public key. To take its seat, it signs the room and the time with the private key. The relay checks the signature. So the relay's operator, or anyone who reads the relay's data, can not take the seat later: there is no token to steal.
- A signature holds the time (the relay accepts 300 seconds either way). Someone who could read one offer inside the TLS connection could use it for up to 5 minutes to take the seat. Messages stay sealed, so they could only drop them. The real computer takes the seat back when it reconnects; if it is pushed out three times in a row it says so in its settings and tries again every 10 minutes.
- Anyone who knows a room's name can open a phone socket. The computer's own checks (pairing code, device keys, sessions) decide what gets in.

What the relay can see:

- Room names (a hash of the computer's public key).
- Message sizes and timing.
- Network addresses of the sockets, as Cloudflare shows them to any Worker. It keeps only a per-room hash of the address (IPv6 by /64) as `from`.

What it can not see:

- Message contents. They are sealed by the link (see `link-host/server.mjs`).
- Any secret of the computer.

The relay keeps no message and no storage. It never uses the storage API. Logs hold counts, socket kinds, close codes and the relay's own fixed close reasons, and nothing else: no key, signature, room name, `from` tag or message content. Invocation logs are off in `wrangler.jsonc` because they record the request URL, which holds the room name.

## Wire format

The wire format is the header of [`../tests/fake-relay.ts`](../tests/fake-relay.ts). That file is also an in-memory copy of the relay's behavior. In short:

- Computer: `wss://<relay>/v1/host/<room>`, subprotocols `["botkins.host.v2", "k.<public key>", "t.<unix seconds>", "s.<signature>"]`. Keys and signatures are base64url. `<room>` is `base64url(SHA-256("botkins-relay-room-v1:" + <public key text>))`, 43 characters. The signature is Ed25519 over the UTF-8 text `botkins-relay-host-v2:<room>:<unix seconds>`. The relay needs exactly one `k.`, one `t.` and one `s.` entry, a key that gives this room, a time within 300 seconds of its own, and a good signature. Anything else is 401 with no upgrade. The answer selects `botkins.host.v2` and repeats nothing else.
- Phone: `wss://<relay>/v1/room/<room>`, subprotocol `["botkins.phone.v1"]`.
- One computer socket per room. A new one closes the old with 4000.
- Up to 16 phone sockets, and up to 8 from one network address. A new phone socket is never turned away: when its address already has 8, that address's oldest socket is closed with 4008, then when the room has 16, the room's oldest is closed with 4008.
- Text `ping` gets `pong` on both kinds of socket.
- Phone to computer: `[conn 8][from 8] + the phone's message`. Computer to phone: `[conn 8] + the answer`, sent to that phone with the 8 bytes removed. An answer for a phone that is gone is dropped.
- No computer connected: the phone gets `[0x03][id]` for each request.
- A phone socket closes (for any reason, also a 4008): the computer gets `[conn][from][0x04]`.
- The computer's socket closes: every phone in the room gets `[0x05]`, so it stops waiting for answers that will not come.
- A phone's message over 6 MiB + 64 KiB (6,356,992 bytes) closes that phone with 1009. The computer's limit is 8 MiB.

Other answers: `GET /` is a one-line text, `GET /v1/health` is `{"ok":true}`. A wrong room name or any other path is 404. A plain GET on a room path is 426. A phone without its subprotocol is 400. Only GET is served; any other method is 404, and it is counted against the request limit like everything else.

`conn` is 8 random bytes made for each phone socket. `from` is the first 8 bytes of `SHA-256(room + ":" + network)`. The network is the address in `CF-Connecting-IP`, or `local` when Cloudflare gives none. An IPv6 address counts as its /64 (the first four groups), so one network can not look like many sources. An IPv4-mapped IPv6 address counts as the IPv4 address. The Worker makes the headers that carry the socket kind and `from` to the Durable Object. It never forwards the client's headers.

## Run and test on this machine

```sh
npm install
npm run dev        # wrangler dev, local only: http://localhost:8787
npm test           # unit tests, then real `wrangler dev` runs on free ports (the relay, and push with a fake Apple), then they stop
npm run typecheck  # wrangler types, then tsc
```

`npm test` takes about 40 seconds (the relay and push test files run side by side). One test waits 15 seconds to let the object hibernate. Three tests wait about 10 seconds each, see "Known behavior".

Under `wrangler dev` a local client can set `CF-Connecting-IP` itself, and the Worker uses it. The tests use that to act as many addresses. On Cloudflare the header is set by Cloudflare and can not be set by a client.

None of this logs in to Cloudflare or changes anything in an account.

## Deploy

```sh
npx wrangler login   # once
npm run deploy
```

The Durable Object class is SQLite-backed (`new_sqlite_classes`), the only kind the Free plan allows. The first deploy creates the class from the `v1` migration.

## Limits

- A phone's message: 6 MiB + 64 KiB. The computer's message: 8 MiB. (The platform's own limit is 32 MiB.) Anything bigger must be split.
- 1 computer and 16 phones per room, at most 4 phones from one network address.
- One Durable Object handles about 1,000 requests a second, a soft limit.
- Free plan: 100,000 Worker requests and 100,000 Durable Object requests a day, 13,000 GB-s of duration a day, 10 ms of CPU per request. Checking a signature and forwarding a message take little CPU.

## Rate limits

The Worker limits how often one network may knock, with the Workers Rate Limiting binding ([docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)), declared in `wrangler.jsonc`:

- `SOCKETS`: 30 new sockets a minute for each network.
- `REQUESTS`: 120 of everything else a minute for each network (pages, health checks, wrong paths, other methods, bad room names, and every call to `/v1/push`).
- `PUSHES`: 240 push items a minute for each computer key (not each network). See "Push notifications".

A network is an IPv4 address or an IPv6 /64. Over the limit the answer is 429, before any other work. The counts are kept per Cloudflare location and are approximate: they stop a flood, they are not an exact gate, and a new deployment takes a few minutes to start enforcing them. Both were seen working on this account's plan (a burst of 320 requests got 194 answers of 429).

Local tests pass `--var=RATE_LIMITS:off`, because every socket of a test run comes from one address. (`test/push.test.mjs` also runs one Worker with the limits on: locally the `PUSHES` and `REQUESTS` bindings do trip, 429 after 240 items and after 120 calls. They are still approximate on Cloudflare.) A phone and a computer that meet a 429 wait and try again by themselves (the phone backs off to 15 seconds, the computer to 60).

Messages on an open socket are not metered. A zone-level rate limiting rule for this hostname can be added on top if the Worker's own limits ever prove too loose.

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
- `RATE_LIMITS=off` turns both off, for local tests.
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

Or, to read the key from the file without printing it: `npx wrangler secret put APNS_KEY_P8 < /path/to/AuthKey_XXXXXXXXXX.p8`. Until the first three are set, the route answers `503 push_off`. `APNS_TOPIC` is a plain var in `wrangler.jsonc`. Deploy the Worker first (`npm run deploy`), then set the secrets: each `wrangler secret put` makes a new version live. The `PUSHES` rate limit has `namespace_id` 47613: namespace ids are shared by every Worker on the account, so change it if another Worker already uses it.

### What the Worker can and can not see

It sees, while a push passes through: device tokens, payloads, the computer's public key and the times of pushes. It stores none of them and logs none of them. It holds Apple's signing key, so whoever can edit this Worker could send pushes to the app as the team: protect the Cloudflare account like the key. It can not read message text. The computer seals alert text with the link's keys and the phone opens it, so the payloads this route forwards carry no message text, only sealed data and routing.

A signed request can be sent again by anyone who sees it inside the TLS connection, for up to 5 minutes (the same as a seat offer, see "Trust notes"). The most that does is repeat pushes the computer already asked for, and the key's limit bounds it.

### Tests and what they can not show

`test/push.test.mjs` starts `wrangler dev --local` with a throwaway P-256 key and `--var=APNS_HOST:http://127.0.0.1:<port>`, a small local server that plays Apple. `APNS_HOST` is a test-only var: when it is set it replaces both of Apple's hosts (the path stays `/3/device/<token>`) and the Worker adds a header `x-botkins-apns-env: production|sandbox`, so a test can see which host was meant. It is unset in `wrangler.jsonc`. `test/push-pure.test.mjs` tests the helpers in `src/push.ts` alone.

Not verified on this machine: a real call to Apple. Apple's servers need HTTP/2 (the fake one speaks HTTP/1.1), and the Cloudflare docs do not say in so many words that Worker `fetch` uses HTTP/2 to an origin. Other projects send APNs pushes from Workers, but that is not checked here. The first real push (to a sandbox build, to one's own device) is the check: an answer of `502 unreachable` for every item means the Worker could not connect. A token or key problem shows as Apple's own `403` with `reason` (`InvalidProviderToken`, `ExpiredProviderToken`, `BadTopic`...).

## Pricing notes

- Idle rooms cost nothing. The object uses the WebSocket Hibernation API, so it is not billed for duration while no message is being handled, and the sockets stay open.
- Incoming WebSocket messages are billed 20 to 1: 100 messages from phones and computers count as 5 requests. Messages the relay sends are free. Opening a socket counts as one request. Protocol pings are free, and the `ping` text is answered by the runtime without waking the object.
- Workers Logs is on. It writes one line per open, close and wake. The Free plan allows 200,000 log lines a day.

## Known behavior

When the relay closes a socket from another socket's event (the old computer socket it replaces, or a phone it replaces with 4008), workerd sends the Close frame at once but keeps the TCP connection open until the client closes it. Clients get the close code right away. Node's WebSocket only reports the close after its own 10 second timeout, so the tests that check 4000 and 4008 wait that long.
