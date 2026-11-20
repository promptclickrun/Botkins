#!/bin/sh
set -eu

# The volume is initialized from the image as uid 10001. Keep the private pairing
# material and its upload staging area separate from the Electron workspace volume.
umask 077
mkdir -p "${BOTKINS_DATA_DIR:-/var/lib/botkins-link}" \
  "${BOTKINS_DATA_DIR:-/var/lib/botkins-link}/uploads" \
  "$(dirname "${BOTKINS_OWNER_PAIRING_FILE:-/run/botkins-owner/pairing.json}")"

if [ "${BOTKINS_HEADLESS:-}" != "1" ]; then
  echo "BOTKINS_HEADLESS=1 is required for the headless host" >&2
  exit 64
fi

exec node desktop/headless/host.mjs
