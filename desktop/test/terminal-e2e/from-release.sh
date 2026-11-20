#!/bin/sh
# The terminal host, installed and updated from published releases, on this machine.
#
#   sudo sh desktop/test/terminal-e2e/from-release.sh --from <N-1> --to <N> [--require-credential]
#
# It installs release <from> with that release's own install.sh from GitHub, checks that the
# service runs on <from>, asks for the update the way a paired phone does, and ends well only
# when the service is running on <to> and says its last install went well. Nothing here stands
# in for a download or a signature: the installer and the updater check the release's signed
# checksums against the Botkins release key, as they do for anyone.
#
# The program that installs <to> is always <from>'s own updater: the old version installs the
# new one. So what the update leaves behind is what <from> leaves, and this asks for no more
# than that. A <from> up to 0.16.5 leaves no record of the install for the service to show, so
# for those the record is not asked for, and one line says so. Every other check stays.
#
# The update goes the whole way a phone's request goes: the service's own user asks the service,
# the service leaves its request, systemd's watch starts the root job, and the root job installs
# the latest signed release and restarts the service. `botkins update` typed by root would skip
# the first three, so it is not what this runs.
#
# When <from> has no terminal host build for this system (GitHub answers 404 for it: true of every
# release before the first one that has them), or --from is left out or empty, it installs <to>
# fresh, checks that it runs, says that the update leg was skipped, and ends well. Any other
# answer for <from> (no network, a server error) fails the run: a check that could not look is
# not a check that passed.
#
# It is for a machine that is thrown away afterwards (a CI runner, a fresh virtual machine): it
# installs Botkins for the whole computer and leaves it there. It needs root, systemd as the
# first process, and curl or wget; it installs GnuPG with apt-get when that is missing. It uses
# no provider sign-in and no phone, and nothing outside this checkout and the releases.
#
# `botkins update` installs the latest release, whatever it is. So run this after <to> has been
# marked as the latest: the update leg fails, and says so, when the latest release is another one.
#
# --require-credential   fail unless the host key reached the service as a systemd credential
#                        (LoadCredential=). Without it the script only says where the key came
#                        from: in some containers systemd can't hand one over, and the installer
#                        then lets the service's group read the key file.
#
# For trying this script itself before a release exists: BOTKINS_E2E_RELEASE_URL names a mirror
# (<url>/v<version>/<file>) and BOTKINS_E2E_RELEASE_FINGERPRINT the key that signed it. They
# change where an install comes from, never an update: `botkins update` takes the project's own
# releases and nothing else, so only the fresh-install leg can be tried this way.
set -eu

REPO="promptclickrun/Botkins"
# The last release whose updater leaves no record of an install (<install folder>/last-update.json).
NO_RECORD_UNTIL="0.16.5"
from=""
to=""
require_credential=0

say() { printf '%s\n' "$*"; }
step() { printf '\n## %s\n' "$*"; }
fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }
# A command, shown and then run.
run() { printf '$ %s\n' "$*"; "$@"; }

while [ $# -gt 0 ]; do
  case $1 in
    --from) [ $# -ge 2 ] || fail "--from needs a version (or an empty one)."; from=${2#v}; shift ;;
    --to) [ $# -ge 2 ] || fail "--to needs a version."; to=${2#v}; shift ;;
    --require-credential) require_credential=1 ;;
    -h|--help) sed -n '2,44p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Unknown option $1." ;;
  esac
  shift
done
# newer_than <a> <b>: release a is newer than release b.
newer_than() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$1" ]; }
version_like() { printf '%s' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; }
[ -n "$to" ] || fail "Say which release must be running at the end: --to <version>."
version_like "$to" || fail "$to is not a release version."
[ -z "$from" ] || version_like "$from" || fail "$from is not a release version."
[ "$(id -u)" -eq 0 ] || fail "This installs Botkins for the whole computer: run it as root (with sudo)."
[ "$(uname -s)" = Linux ] || fail "This is the Linux check. On macOS, run test/terminal-e2e/macos.sh."
[ -d /run/systemd/system ] || fail "This machine doesn't run systemd as its first process."
case $(uname -m) in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail "There is no Botkins build for $(uname -m)." ;;
esac
# http_status <url> prints the status of the last answer (after redirects), or 000 when there was none.
if command -v curl >/dev/null 2>&1; then
  http_status() { curl -sIL -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true; }
  fetch_to() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  http_status() { code=$(wget --spider -S "$1" 2>&1 | awk '/^  HTTP\// { code = $2 } END { print code }'); printf '%s' "${code:-000}"; }
  fetch_to() { wget -q -O "$2" "$1"; }
else
  fail "curl or wget is needed."
fi
# there <url>: 0 when the file is there, 1 when the server says it is not (404). Anything else ends the run.
there() {
  status=$(http_status "$1")
  case $status in
    200) return 0 ;;
    404) return 1 ;;
    *) fail "Could not tell whether $1 is there (HTTP ${status:-000}). This run proves nothing; try it again." ;;
  esac
}
if ! command -v gpgv >/dev/null 2>&1 || ! command -v gpg >/dev/null 2>&1; then
  step "GnuPG, which the installer and the updater check signatures with"
  run apt-get update -qq
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gnupg
fi

download=${BOTKINS_E2E_RELEASE_URL:-https://github.com/$REPO/releases/download}
download=${download%/}
install_args=""
if [ -n "${BOTKINS_E2E_RELEASE_URL:-}" ]; then
  [ -n "${BOTKINS_E2E_RELEASE_FINGERPRINT:-}" ] || fail "With BOTKINS_E2E_RELEASE_URL, name the key that signed the mirror: BOTKINS_E2E_RELEASE_FINGERPRINT."
  install_args="--release-url $download --release-fingerprint $BOTKINS_E2E_RELEASE_FINGERPRINT"
  say "NOTE: installing from the mirror $download, not from GitHub. This tries the script; it proves nothing about a release."
fi
tarball() { printf '%s/v%s/botkins-terminal-%s-linux-%s.tar.gz' "$download" "$1" "$1" "$arch"; }
# One value out of the JSON on standard input: `botkins status --json | pick .version`. It uses
# the Node.js the installer chose: the computer's own, or the one it put beside the versions.
pick() {
  if [ -x /opt/botkins/node/bin/node ]; then node=/opt/botkins/node/bin/node; else node=$(command -v node); fi
  "$node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);const x=eval("v"+process.argv[1]);console.log(x===undefined||x===null?"":x)}catch{console.log("")}})' "$1"
}
status_field() { botkins status --json 2>/dev/null | pick "$1"; }

install_release() {
  step "Install Botkins $1 with that release's own installer"
  say "\$ curl -fsSL $download/v$1/install.sh | sh -s -- --version $1 $install_args"
  # Downloaded whole first: a download that fails is said here, not found out later as a service that never came.
  installer=$(mktemp)
  fetch_to "$download/v$1/install.sh" "$installer" || fail "The installer of Botkins $1 could not be downloaded ($download/v$1/install.sh)."
  [ -s "$installer" ] || fail "The installer of Botkins $1 came back empty."
  # shellcheck disable=SC2086
  sh "$installer" --version "$1" $install_args || fail "Botkins $1 could not be installed."
  rm -f "$installer"
}

# Waits until the service runs on the version, then shows it. Fails when it doesn't within the time.
running_on() {
  wanted=$1
  seconds=${2:-60}
  elapsed=0
  while :; do
    if [ "$(systemctl is-active botkins 2>/dev/null || true)" = active ] && [ "$(status_field .version)" = "$wanted" ]; then break; fi
    elapsed=$((elapsed + 2))
    if [ "$elapsed" -ge "$seconds" ]; then
      run systemctl status botkins --no-pager -l || true
      run journalctl -u botkins --no-pager -n 40 || true
      fail "The service is not running on Botkins $wanted (it says: '$(status_field .version)', systemd says: $(systemctl is-active botkins 2>/dev/null || true))."
    fi
    sleep 2
  done
  run botkins status
  run systemctl show botkins -p ActiveState -p SubState -p User -p NRestarts -p UnitFileState
  # The installer makes this link relative and the updater makes it whole: where it leads is what counts.
  [ "$(readlink -f /opt/botkins/current)" = "/opt/botkins/botkins-terminal-$wanted-linux-$arch" ] || fail "/opt/botkins/current does not lead to Botkins $wanted (it leads to $(readlink -f /opt/botkins/current))."
}

key_source() {
  source=$(status_field .secrets.source)
  say "Host key: $(status_field .secrets.where) (source: ${source:-unknown})"
  [ ! -e /var/lib/botkins/data/host.key ] || fail "The host key is in the data folder."
  if [ "$require_credential" -eq 1 ] && [ "$source" != systemd ]; then fail "The host key did not reach the service as a systemd credential (LoadCredential=)."; fi
}

step "This machine"
say "$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-Linux}"), $(uname -m), $(systemctl --version | head -n 1)"

fresh=""
if [ -z "$from" ]; then
  fresh="no earlier release was named"
elif [ "$from" = "$to" ]; then
  fresh="--from and --to are the same release"
elif ! there "$(tarball "$from")"; then
  fresh="Botkins $from has no terminal host build for linux-$arch"
fi
there "$(tarball "$to")" || fail "Botkins $to has no terminal host build for linux-$arch ($(tarball "$to"))."

if [ -n "$fresh" ]; then
  install_release "$to"
  step "The service runs on Botkins $to"
  running_on "$to"
  key_source
  step "Doctor"
  run botkins doctor || true
  say ""
  say "The update leg was skipped: $fresh. Botkins $to was installed fresh and is running."
  say "FROM RELEASE: PASSED (fresh install of $to)"
  exit 0
fi

install_release "$from"
step "The service runs on Botkins $from"
running_on "$from"
key_source

# asking_github <command…> runs a command that asks GitHub which release is the latest, and
# tries again when GitHub refuses the question. Releases up to 0.16.6 ask GitHub's API, which
# answers an address that is not signed in only 60 times an hour and counts every machine behind
# that address together, so a test machine in a cloud is refused now and then. That is GitHub's
# limit and not a failure of Botkins: the run waits and asks again, and when it gives up it says
# which of the two it was. What the command printed is left in $asked, and what it said beside
# that (warnings, the reason for a failure) in $asked.err, so an answer that is JSON stays JSON.
asked=$(mktemp)
asking_github() {
  tries=0
  while :; do
    tries=$((tries + 1))
    if "$@" > "$asked" 2> "$asked.err"; then return 0; fi
    grep -Eq "GitHub could not provide a release|limits how often one address may ask|HTTP 403|HTTP 429" "$asked" "$asked.err" || return 1
    [ "$tries" -lt 6 ] || fail "GitHub refused the question about the latest release $tries times. That is GitHub's limit on requests from one address that is not signed in (60 an hour, counted for every machine behind the address), not a failure of Botkins. Run this again later."
    say "GitHub refused the question (its limit on requests from one address). Trying again in 30 seconds ($tries of 6)."
    sleep 30
  done
}

step "Is there a newer release, as this copy sees it?"
printf '$ botkins update --check --json\n'
asking_github botkins update --check --json || { cat "$asked" "$asked.err"; fail "Botkins $from could not look for a newer release."; }
latest=$(pick .latest < "$asked")
say "Botkins $from sees Botkins ${latest:-(nothing)} as the latest release."
[ "$latest" = "$to" ] || fail "The latest release is ${latest:-unknown}, not $to. Run this after Botkins $to is marked as the latest release."

step "Update, asked for the way a phone asks: the service's own user asks the service, and the root job does the install"
user=$(systemctl show botkins -p User --value)
[ -n "$user" ] && [ "$user" != root ] || fail "The service does not run as a user of its own."
[ "$(systemctl is-active botkins-update.path 2>/dev/null || true)" = active ] || fail "The watch that starts the update job (botkins-update.path) is not running."
if command -v runuser >/dev/null 2>&1; then as_service() { runuser -u "$user" -- "$@"; }; else as_service() { sudo -u "$user" "$@"; }; fi
printf '$ (as %s) botkins update\n' "$user"
asking_github as_service botkins update || { cat "$asked" "$asked.err"; fail "The service did not take the request for an update."; }
cat "$asked" "$asked.err"

step "The root job installs Botkins $to and restarts the service on it"
elapsed=0
while :; do
  # Done when the job has ended and the service is on the new version, or when the job has ended badly.
  job=$(systemctl show botkins-update.service -p ActiveState --value 2>/dev/null || true)
  result=$(systemctl show botkins-update.service -p Result --value 2>/dev/null || true)
  ran=$(systemctl show botkins-update.service -p ExecMainExitTimestampMonotonic --value 2>/dev/null || echo 0)
  if [ "$job" != activating ] && [ "$job" != active ] && [ "${ran:-0}" != 0 ]; then
    [ "$result" = success ] || { run journalctl -u botkins-update.service --no-pager -n 40 || true; fail "The update job ended badly (systemd says: $result)."; }
    break
  fi
  elapsed=$((elapsed + 3))
  if [ "$elapsed" -ge 1200 ]; then
    run journalctl -u botkins-update.service --no-pager -n 40 || true
    fail "The update job did not end in 20 minutes (systemd says: ${job:-unknown})."
  fi
  sleep 3
done
run journalctl -u botkins-update.service --no-pager -n 12 || true
[ ! -e "/var/lib/botkins/run/update-requested" ] || fail "The service's request is still there after the job ran."

step "The service runs on Botkins $to"
running_on "$to" 90
key_source
[ -d "/opt/botkins/botkins-terminal-$from-linux-$arch" ] || fail "The old version was not kept on disk."
last_ok=$(status_field '.update.last?.ok')
if newer_than "$from" "$NO_RECORD_UNTIL"; then
  say "The last install, as the service tells a phone: from $(status_field '.update.last?.from') to $(status_field '.update.last?.to'), ok: ${last_ok:-not recorded}"
  [ "$last_ok" = true ] || fail "The service does not say that its last install went well (ok: ${last_ok:-not recorded}). A phone that asked for this update would not learn how it ended."
  [ "$(status_field '.update.last?.to')" = "$to" ] || fail "The service's record of its last install is not about Botkins $to."
  [ "$(stat -c '%U %a' /opt/botkins/last-update.json 2>/dev/null)" = "root 644" ] || fail "The record of the install is not root's own file beside the versions."
else
  # Botkins <from>'s updater did the install, and it is from before the record. No record is the
  # right answer here; a record that says the install failed is still a failure.
  say "The record of the install was not asked for: Botkins $from's own updater did this install, and releases up to $NO_RECORD_UNTIL leave no record. (The service says: ok: ${last_ok:-not recorded}.)"
  [ "$last_ok" != false ] || fail "The service says that its last install failed."
fi

step "Doctor"
run botkins doctor || true

say ""
say "FROM RELEASE: PASSED (installed $from, updated to $to)"
