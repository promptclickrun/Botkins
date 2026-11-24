# Optional Botkins profiles

A signed-in person should be able to open a configured host on a fresh installation with the same host-local identity. An installation that chooses local pairing can use Botkins without the service.

## Implementation and checks

- Exercise a browser passkey registration or assertion plus a second verification bound to one installation. Test both trusted-device approval and a verified-email code, expiry, retry and revocation.
- Bind the verified profile to the existing owner or member through the authenticated Link. Enroll a new, independently removable device against that binding over the local network or relay.
- Offer the same choice at first launch and once on upgrade. Migrate authorized pairings, link newly configured hosts automatically, and preserve the local-only flow on desktop, terminal and mobile.
- Deploy a dedicated Worker and indexed D1 database. Serve the browser UI as static assets. Bound email reservations, input size, enrollment volume and CPU. Verify the public service and its fail-closed responses before handoff.
