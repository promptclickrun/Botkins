#!/usr/bin/env bash
# An update that changes the service's files, end to end, on a clean Linux container with systemd.
#
# A release may change what the systemd unit says. The updater that runs is always the old
# version's, so it asks the new version, once that is in place, to write its own files
# (`botkins service refresh`), and it puts the earlier files back when it puts the old version
# back. This run does that with real systemd, as root, with three versions:
#
#   A   this checkout, installed with the real installer from a "release" signed for this run,
#       and then installed again with a project folder (`--allow-path`), so a choice has to be kept
#   B   A with a higher version and changed units: one more line in the service's unit, a changed
#       watch, and a changed update job
#   C   B with a higher version, changed units again and one more unit, and a service that dies
#
# A installs B: the units are B's, the service runs under them, and every choice is kept.
# B installs C: C doesn't stay up, so B is put back, with B's units, and C's extra unit is gone.
# Then a unit is made stale by hand: `botkins doctor` says so and `botkins service refresh` fixes it.
#
# What it does not do: download and verify B and C. `botkins update` takes only the project's own
# signed releases, on purpose, so here the step after that (desktop/terminal/update-install.mjs,
# switchTo) is run directly, by A's and then B's own code, in a root unit like the update job's.
#
#   test/terminal-e2e/units.sh [--keep]
#
# Needs Docker, Node.js 24, GnuPG and python3 on this computer. Everything it makes is in a
# temporary folder and one container, both removed at the end (--keep leaves them to look at).
set -euo pipefail

keep=0
for arg in "$@"; do
  case $arg in
    --keep) keep=1 ;;
    *) echo "Unknown option $arg" >&2; exit 2 ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)
desktop=$(cd "$here/../.." && pwd)
version=$(node -p 'require(process.argv[1]).version' "$desktop/package.json")
work=$(mktemp -d "${TMPDIR:-/tmp}/bk-units.XXXXXX")
name=bk-units-$$
port_release=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
server_pid=""
cleanup() {
  [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true
  GNUPGHOME=$work/gnupg gpgconf --kill gpg-agent 2>/dev/null || true
  if [ "$keep" -eq 0 ]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    rm -rf "$work"
  else
    echo "Kept: container $name, folder $work"
  fi
}
trap cleanup EXIT

step() { printf '\n## %s\n' "$*"; }
in_box() { docker exec "$name" "$@"; }
# A command as a person would type it in the container, shown and then run.
box() { printf '$ %s\n' "$*"; docker exec "$name" sh -c "$*"; }
fail() { echo "FAILED: $*" >&2; exit 1; }
# The lines of the unit that say what was chosen when the service was installed.
choices() { in_box grep -E '^(User|Group|WorkingDirectory|ReadWritePaths|LoadCredential|LoadCredentialEncrypted|ExecStart|Environment=(BOTKINS_DATA_DIR|HOME|BOTKINS_KEY_SOURCE|BOTKINS_KEY_FILE)=)' /etc/systemd/system/botkins.service; }
running_on() {
  for _ in $(seq 1 30); do
    if [ "$(in_box systemctl is-active botkins 2>/dev/null || true)" = active ] && [ "$(in_box sh -c 'botkins status --json 2>/dev/null' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("")}})')" = "$1" ]; then return 0; fi
    sleep 2
  done
  box 'systemctl status botkins --no-pager -l | tail -n 15' || true
  fail "The service is not running on Botkins $1."
}

step "Build the release tarball for the container's architecture, and sign it with a key made for this run"
case $(docker version --format '{{.Server.Arch}}') in
  arm64|aarch64) target=linux-arm64 ;;
  amd64|x86_64) target=linux-x64 ;;
  *) fail "Unknown Docker architecture." ;;
esac
release=$work/release/v$version
mkdir -p "$release"
(cd "$desktop" && node scripts/package-terminal.mjs --only "$target" --sums --out "$release" | tail -n 2)
mkdir -m 700 "$work/gnupg"
export GNUPGHOME=$work/gnupg
gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-generate-key "Botkins e2e test key <e2e@example.invalid>" ed25519 sign 1d 2>/dev/null
fingerprint=$(gpg --batch --with-colons --list-keys | awk -F: '$1 == "fpr" { print $10; exit }')
gpg --batch --yes --pinentry-mode loopback --passphrase '' --armor --detach-sign --output "$release/SHA256SUMS.asc" "$release/SHA256SUMS"
gpg --batch --yes --armor --output "$release/botkins-release.asc" --export "$fingerprint"
unset GNUPGHOME
(cd "$work/release" && exec python3 -m http.server "$port_release" --bind 0.0.0.0) >"$work/http.log" 2>&1 &
server_pid=$!
base=http://host.docker.internal:$port_release

step "A clean Debian container with systemd, and version A ($version) installed by the real installer"
docker build -q -t botkins-e2e-debian "$here" >/dev/null
docker run -d --name "$name" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock --tmpfs /tmp --add-host host.docker.internal:host-gateway botkins-e2e-debian >/dev/null
for _ in $(seq 1 30); do [ "$(in_box systemctl is-system-running 2>/dev/null || true)" = running ] && break; sleep 1; done
box "curl -fsSL $base/v$version/install.sh | sh -s -- --release-url $base --version $version --release-fingerprint $fingerprint" | tail -n 6
box 'mkdir -p /srv/projects && botkins service install --allow-path /srv/projects' | tail -n 6
running_on "$version"
choices | tee "$work/choices-a.txt"
grep -q '^ReadWritePaths=/var/lib/botkins /srv/projects$' "$work/choices-a.txt" || fail "The project folder is not in the unit."
box 'botkins doctor | grep "Service files"'

step "Versions B and C: A's own files with a higher version and changed units (C's service dies)"
docker cp "$here/units-versions.mjs" "$name:/root/units-versions.mjs" >/dev/null
docker cp "$here/units-update.mjs" "$name:/root/units-update.mjs" >/dev/null
box '/opt/botkins/node/bin/node /root/units-versions.mjs' | tee "$work/versions.txt"
b=$(awk '$1 == "B" { print $2 }' "$work/versions.txt")
c=$(awk '$1 == "C" { print $2 }' "$work/versions.txt")
[ -n "$b" ] && [ -n "$c" ] || fail "The versions were not made."
arch=${target#linux-}
# The step of the root update job that comes after the download and the check, in a unit like the job's own.
update_to() { printf '$ (root unit, the installed version'"'"'s own updater) install %s\n' "$1"; in_box systemd-run --quiet --wait --collect --pipe -p PrivateTmp=true -p UMask=0022 /opt/botkins/node/bin/node /root/units-update.mjs "/root/versions/botkins-terminal-$1-linux-$arch.tar.gz" "$1"; }

step "A installs B: B writes the units before the service restarts, and every choice is kept"
update_to "$b" || fail "The update to B failed."
running_on "$b"
choices > "$work/choices-b.txt"
diff "$work/choices-a.txt" "$work/choices-b.txt" || fail "What was chosen at install time changed."
box 'grep -n "LimitCORE" /etc/systemd/system/botkins.service; systemctl show botkins -p LimitCORE -p NRestarts -p ActiveState'
[ "$(in_box systemctl show botkins -p LimitCORE --value)" = 0 ] || fail "The service does not run under B's unit."
box 'grep -h "^Description=\|^TimeoutStartSec=" /etc/systemd/system/botkins-update.path /etc/systemd/system/botkins-update.service; systemctl is-active botkins-update.path; systemctl is-enabled botkins.service botkins-update.path'
in_box grep -q '^Description=.*(B)$' /etc/systemd/system/botkins-update.path || fail "The watch is not B's."
in_box grep -q '^TimeoutStartSec=1800$' /etc/systemd/system/botkins-update.service || fail "The update job is not B's."
[ "$(in_box systemctl is-active botkins-update.path)" = active ] || fail "The update watch is not running."
box 'stat -c "%U %a %n" /etc/systemd/system/botkins.service /etc/systemd/system/botkins-update.path /etc/systemd/system/botkins-update.service /etc/botkins/install.json'
box 'botkins doctor | grep "Service files"'
in_box sh -c 'botkins doctor | grep -q "^ok .*Service files"' || fail "Doctor does not say that the files are B's."
in_box sh -c 'cp /etc/systemd/system/botkins.service /root/unit-b; cp /etc/systemd/system/botkins-update.path /root/watch-b; cp /etc/systemd/system/botkins-update.service /root/job-b'

step "B installs C: C doesn't stay up, so B is put back, under B's units, and C's extra unit is gone"
if update_to "$c" 2>&1 | tee "$work/c.txt"; then fail "The update to C did not fail."; fi
grep -q "Botkins $b was put back" "$work/c.txt" || fail "The updater did not say that B was put back."
running_on "$b"
box 'cmp /etc/systemd/system/botkins.service /root/unit-b && cmp /etc/systemd/system/botkins-update.path /root/watch-b && cmp /etc/systemd/system/botkins-update.service /root/job-b && echo "the units are B'"'"'s again, byte for byte"' || fail "The units are not B's."
box 'ls /etc/systemd/system | grep botkins; systemctl show botkins -p LimitCORE -p LimitNOFILE -p ActiveState; systemctl is-active botkins-update.path; ls /opt/botkins'
in_box test ! -e /etc/systemd/system/botkins-tidy.timer || fail "C's extra unit is still there."
[ "$(in_box systemctl show botkins -p LimitNOFILE --value)" != 4096 ] || fail "The service still runs under C's unit."
in_box test ! -e "/opt/botkins/botkins-terminal-$c-linux-$arch" || fail "C is still on disk."
in_box sh -c 'botkins doctor | grep -q "^ok .*Service files"' || fail "Doctor does not say that the files are B's."

step "A unit from an earlier version: doctor says so, and refresh writes this version's, with the choices kept"
box "sed -i '/^LimitCORE=0\$/d' /etc/systemd/system/botkins.service && systemctl daemon-reload"
box 'botkins doctor | grep -A1 "Service files"; botkins service refresh --check; echo "exit=$?"' | tee "$work/stale.txt"
grep -q "^FAIL .*Service files" "$work/stale.txt" || fail "Doctor did not say that the unit is stale."
grep -q "exit=1" "$work/stale.txt" || fail "refresh --check did not say that the unit is stale."
box 'su -s /bin/sh botkins -c "botkins service refresh"; echo "exit=$?"' | tee "$work/denied.txt"
grep -q "exit=4" "$work/denied.txt" || fail "The service's own user could write the whole computer's unit."
box 'botkins service refresh'
running_on "$b"
in_box cmp /etc/systemd/system/botkins.service /root/unit-b || fail "refresh did not write B's unit."
[ "$(in_box systemctl show botkins -p LimitCORE --value)" = 0 ] || fail "The service was not restarted under the unit."
box 'botkins doctor | grep "Service files"; botkins service refresh'

echo
echo "UNITS END TO END: PASSED"
