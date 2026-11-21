#!/bin/sh
# Checks a built terminal host image: it reports the version it should, its command list names
# each area, and its service runs.
#
#   sh .github/scripts/check-image.sh <image> <version>
#
# The service is started as Compose starts it (desktop/docker-compose.yml): a read-only file
# system, no capabilities, and a volume for its data.
#
# The command list is what an agent reads to find a command (`botkins help --json`,
# desktop/docs/terminal.md, "For agents"). The test in desktop/test/terminal-coverage.test.mjs
# proves it from the source. This proves that the image holds a list that works. An image from
# before that command (0.16.6 and older) does not pass.
set -eu

image=$1
version=$2

# One word for each area the image's command line must have. A pull request that adds an area
# to the command line adds its word here.
areas="artifacts bots chat chats config devices folders models pair plugins projects providers relay routines service skills status tasks templates todos tools update wiki"

name=botkins-check-$$
status=$(mktemp)
list=$(mktemp)
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$name" >/dev/null 2>&1 || true
  rm -f "$status" "$list"
}
trap cleanup EXIT

reported=$(docker run --rm "$image" --version)
if [ "$reported" != "$version" ]; then
  echo "The image reports version $reported, not $version." >&2
  exit 1
fi

# (The service's own answer goes to "$status" later; until then that file holds what this command says on standard error.)
if ! docker run --rm "$image" help --json >"$list" 2>"$status" || ! jq -e '.areas | type == "array" and length > 0' "$list" >/dev/null 2>&1; then
  echo "The image's \`botkins help --json\` did not print the command list. It printed:" >&2
  cat "$list" "$status" | head -c 2000 >&2 || true
  echo >&2
  exit 1
fi
listed=$(jq -r '.areas[].name' "$list")
missing=
for area in $areas; do
  printf '%s\n' "$listed" | grep -qx "$area" || missing="$missing $area"
done
if [ -n "$missing" ]; then
  echo "The image's command list (\`botkins help --json\`) does not name:$missing. It names: $(printf '%s' "$listed" | tr '\n' ' ')" >&2
  exit 1
fi

docker run -d --name "$name" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -v "$name:/var/lib/botkins" "$image" >/dev/null

tries=0
until docker exec "$name" botkins status --json >"$status" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    echo "The service did not start in the image. Its output:" >&2
    docker logs "$name" >&2 || true
    exit 1
  fi
  sleep 1
done

if ! grep -q '"running":true' "$status" || ! grep -q "\"version\":\"$version\"" "$status"; then
  echo "The service in the image did not report that it runs version $version:" >&2
  cat "$status" >&2
  exit 1
fi
echo "The image reports $version, its command list names each area, and its service runs."
