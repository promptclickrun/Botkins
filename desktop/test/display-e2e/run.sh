#!/bin/sh
# The two-container host, end to end: `docker compose --profile display up -d host workspace`
# (desktop/desktop/README.md), with an owner's phone and a team member's phone.
#
# It builds and starts the `host` and `workspace` services under a Compose project and a port of
# its own, seeds the workspace with one space and two panels, and runs the cases in drive.mjs with
# the stand-in phone (test/fixtures/phone.mjs). No model is used and no display is needed beyond
# the workspace container's own Xvfb.
#
#   sh desktop/test/display-e2e/run.sh              build both images, then run
#   sh desktop/test/display-e2e/run.sh --no-build   the images are built already:
#                                                     docker compose -p botkins-display-e2e --profile display build host workspace
#   sh desktop/test/display-e2e/run.sh --keep       leave the containers and volumes for a look afterwards
#
# It exits 0 only when every case passed. The last line is "DISPLAY E2E: PASSED" or
# "DISPLAY E2E: FAILED (...)". Its containers and volumes are removed when it ends, also when it
# fails. The images stay (botkins-display-e2e-host, botkins-display-e2e-workspace), so the next
# run is quick. Needs: Docker with Compose, and Node 22 or newer for the stand-in phone (no
# `npm ci`). DISPLAY_E2E_PROJECT names another Compose project, for two runs on one machine.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
desktop=$(cd "$here/../.." && pwd)
build=1
keep=
for arg in "$@"; do
  case "$arg" in
    --no-build) build= ;;
    --keep) keep=1 ;;
    -h | --help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "display-e2e: unknown option $arg" >&2; exit 2 ;;
  esac
done
command -v docker >/dev/null 2>&1 || { echo "display-e2e: Docker is not installed." >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "display-e2e: Node.js is not installed." >&2; exit 2; }

# The project's name is also the name of its images, so it is the same each time: a build made
# before the run (a job's cached build) is the one that `--no-build` starts.
project="${DISPLAY_E2E_PROJECT:-botkins-display-e2e}"
# A port the system picks: never the terminal host's 47610 or an installed host's 59851.
port=$(node -e 'const s = require("node:net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });')
export BOTKINS_BIND_PORT="$port"
compose() { (cd "$desktop" && docker compose -p "$project" --profile display "$@"); }
# One step with a time limit, so a container that never comes up fails here and not at the job's limit.
limited() { seconds=$1; shift; perl -e 'alarm shift; exec @ARGV' "$seconds" "$@"; }

step="start"
result="FAILED"
finish() {
  status=$?
  trap - EXIT INT TERM
  if [ "$result" != "PASSED" ]; then
    echo
    echo "---- the last lines of both containers' logs (codes, links and keys left out) ----"
    compose logs --no-color --tail 40 host workspace 2>&1 |
      sed -E 's#botkins://[^[:space:]"]+#[link]#g; s#https?://[^[:space:]"]*(pair|join)[^[:space:]"]*#[link]#g; s#"(code|key|secret|token)"[[:space:]]*:[[:space:]]*"[^"]*"#"\1":"[left out]"#g; s#[A-Za-z0-9_-]{32,}#[left out]#g' || true
  fi
  if [ -z "$keep" ]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; else echo "Kept: docker compose -p $project --profile display … (port $port)."; fi
  if [ "$result" = "PASSED" ]; then echo "DISPLAY E2E: PASSED"; exit 0; fi
  echo "DISPLAY E2E: FAILED ($step)"
  [ "$status" -ne 0 ] || status=1
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT TERM

echo "Project $project, port $port."
# What an earlier run left behind, if it was stopped before it could clean up.
compose down -v --remove-orphans >/dev/null 2>&1 || true
if [ -n "$build" ]; then
  step="building the host and workspace images"
  compose build host workspace
else
  step="finding the images (build them first, or run without --no-build)"
  for service in host workspace; do docker image inspect "$project-$service" >/dev/null; done
fi

# The workspace starts from a file with one space and two panels by two bots: a new workspace has
# no bots, and no panel can be made without a model. Written by the service's own user into its volume.
step="seeding the workspace"
limited 120 sh -c 'cd "$1" && docker compose -p "$2" --profile display run --rm --no-deps -T --entrypoint sh workspace -c "mkdir -p /var/lib/botkins-workspace/data && cat > /var/lib/botkins-workspace/data/workspace.json" < "$3"' sh "$desktop" "$project" "$here/seed-workspace.json"

step="starting the two services"
limited 180 sh -c 'cd "$1" && docker compose -p "$2" --profile display up -d --no-build host workspace' sh "$desktop" "$project"

step="the cases"
if limited 600 node "$here/drive.mjs" "$desktop" "$project" "$port"; then result="PASSED"; else step="a case failed, see FAILED above"; fi
