#!/bin/sh
# Checks a built terminal host image: it reports the version it should, and its service runs.
#
#   sh .github/scripts/check-image.sh <image> <version>
#
# The service is started as Compose starts it (desktop/docker-compose.yml): a read-only file
# system, no capabilities, and a volume for its data.
set -eu

image=$1
version=$2

reported=$(docker run --rm "$image" --version)
if [ "$reported" != "$version" ]; then
  echo "The image reports version $reported, not $version." >&2
  exit 1
fi

name=botkins-check-$$
status=$(mktemp)
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$name" >/dev/null 2>&1 || true
  rm -f "$status"
}
trap cleanup EXIT

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
echo "The image reports $version, and its service runs."
