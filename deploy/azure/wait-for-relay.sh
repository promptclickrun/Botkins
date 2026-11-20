#!/bin/sh
# Starts the Botkins host only when its relay answers over HTTPS.
#   wait-for-relay.sh <health url> <command> [arguments]
#
# A host offers the newest relay protocol (botkins.host.v3) on its first try. It takes a failure
# of that try to mean an older relay, and then stays on botkins.host.v2 for as long as that
# connection lives. On a new server the first try would come before Caddy has its certificate,
# and after a restart it could come before Caddy listens. So every start waits here for the
# relay. After 10 minutes it starts the host whatever happened, so its log and status can be read.
set -u
url=$1
shift
tries=0
until node -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$url" || [ "$tries" -ge 300 ]; do
  tries=$((tries + 1))
  sleep 2
done
[ "$tries" -lt 300 ] || echo "wait-for-relay: $url did not answer in 10 minutes. Starting without it." >&2
exec "$@"
