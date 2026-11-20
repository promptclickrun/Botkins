#!/usr/bin/env bash
# An update that changes the service's files, end to end, on a clean Linux container with systemd.
#
# A release may change what the systemd unit says. The updater that runs is always the old
# version's, so it asks the new version, once that is in place, to write its own files
# (`botkins service refresh`), and it puts the earlier files back when it puts the old version
# back. This run does whole updates, the way a paired phone starts one: the service's own user
# asks the service, the service leaves its request, systemd's watch starts the root job, and the
# root job downloads the latest release, checks its signature, installs it, has it write its
# service files, restarts the service and watches it. There are three versions
# (test/terminal-e2e/units-versions.mjs makes them):
#
#   A   this checkout, installed with the real installer, and then installed again with a
#       project folder (`--allow-path`), so a choice has to be kept
#   B   A with a higher version and changed units: one more line in the service's unit, a changed
#       watch, and a changed update job
#   C   B with a higher version, changed units again and one more unit, and a service that dies
#
# A installs B: the units are B's, the service runs under them, and every choice is kept.
# B installs C: C doesn't stay up, so B is put back, with B's units, and C's extra unit is gone.
# Then the unit is changed by hand, the ways a person might: `botkins doctor` says what it finds,
# and `botkins service refresh` keeps what it can carry and leaves alone what it can't.
#
# The releases are this run's own: a mirror on this computer, signed with a key made for this
# run. The three versions name that mirror and that key where the program names GitHub and the
# Botkins release key, and are otherwise the code as it is. So this proves the update, and
# proves nothing about a release of the project (test/terminal-e2e/from-release.sh does that).
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
unit=/etc/systemd/system/botkins.service
# The lines of the unit that say what was chosen when the service was installed.
choices() { in_box grep -E '^(User|Group|WorkingDirectory|ReadWritePaths|LoadCredential|LoadCredentialEncrypted|ExecStart|Environment=(BOTKINS_DATA_DIR|HOME|BOTKINS_KEY_SOURCE|BOTKINS_KEY_FILE)=)' "$unit"; }
# One value out of the service's status: `status_field .update.last?.ok`.
status_field() { in_box sh -c 'botkins status --json 2>/dev/null' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);const x=eval("v"+process.argv[1]);console.log(x===undefined||x===null?"":x)}catch{console.log("")}})' "$1"; }
running_on() {
  for _ in $(seq 1 45); do
    if [ "$(in_box systemctl is-active botkins 2>/dev/null || true)" = active ] && [ "$(status_field .version)" = "$1" ]; then return 0; fi
    sleep 2
  done
  box 'systemctl status botkins --no-pager -l | tail -n 15' || true
  fail "The service is not running on Botkins $1."
}
# Says which release is the latest, as GitHub's own list would.
latest() {
  node -e 'const [version, target] = process.argv.slice(1); const file = "botkins-terminal-" + version + "-" + target + ".tar.gz"; console.log(JSON.stringify({ tag_name: "v" + version, draft: false, prerelease: false, assets: [file, "SHA256SUMS", "SHA256SUMS.asc"].map((name) => ({ name })) }))' "$1" "$target" > "$work/release/latest.json"
}
# The update, asked for the way a phone asks: the service's own user asks the service, and the root job does the rest.
update_as_a_phone_would() {
  printf '$ (as botkins) botkins update\n'
  in_box runuser -u botkins -- botkins update || fail "The service did not take the request for an update."
  # The job: started by the watch, and ended. A minute for the watch to see the request, then the job's own time.
  for _ in $(seq 1 30); do [ "$(in_box systemctl show botkins-update.service -p ExecMainStartTimestampMonotonic --value)" != "$started_before" ] && break; sleep 2; done
  for _ in $(seq 1 200); do
    state=$(in_box systemctl show botkins-update.service -p ActiveState --value)
    [ "$state" = activating ] || [ "$state" = active ] || break
    sleep 3
  done
  box 'journalctl -u botkins-update.service --no-pager -o cat -n 9; systemctl show botkins-update.service -p Result'
  in_box test ! -e /var/lib/botkins/run/update-requested || fail "The service's request is still there after the job ran."
}

step "Build the release tarball for the container's architecture, make versions B and C from it, and sign all three with a key made for this run"
case $(docker version --format '{{.Server.Arch}}') in
  arm64|aarch64) target=linux-arm64 ;;
  amd64|x86_64) target=linux-x64 ;;
  *) fail "Unknown Docker architecture." ;;
esac
mkdir -p "$work/build" "$work/release"
(cd "$desktop" && node scripts/package-terminal.mjs --only "$target" --out "$work/build" | tail -n 1)
mkdir -m 700 "$work/gnupg"
export GNUPGHOME=$work/gnupg
gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-generate-key "Botkins e2e test key <e2e@example.invalid>" ed25519 sign 1d 2>/dev/null
fingerprint=$(gpg --batch --with-colons --list-keys | awk -F: '$1 == "fpr" { print $10; exit }')
gpg --batch --yes --armor --output "$work/key.asc" --export "$fingerprint"
base=http://host.docker.internal:$port_release
node "$here/units-versions.mjs" --tarball "$work"/build/botkins-terminal-*-"$target".tar.gz --out "$work/release" --mirror "$base" --key "$work/key.asc" --fingerprint "$fingerprint" | tee "$work/versions.txt"
a=$(awk '$1 == "A" { print $2 }' "$work/versions.txt")
b=$(awk '$1 == "B" { print $2 }' "$work/versions.txt")
c=$(awk '$1 == "C" { print $2 }' "$work/versions.txt")
[ -n "$a" ] && [ -n "$b" ] && [ -n "$c" ] || fail "The versions were not made."
for version in "$a" "$b" "$c"; do
  release=$work/release/v$version
  cp "$work/build/install.sh" "$work/key.asc" "$release/"
  mv "$release/key.asc" "$release/botkins-release.asc"
  (cd "$release" && shasum -a 256 botkins-terminal-*.tar.gz > SHA256SUMS)
  gpg --batch --yes --pinentry-mode loopback --passphrase '' --armor --detach-sign --output "$release/SHA256SUMS.asc" "$release/SHA256SUMS"
done
unset GNUPGHOME
latest "$a"
# HTTP/1.1, which keeps a connection open, as a release's own server does. With the default (1.0)
# the server closes the connection after each file, and Node's HTTP client can then end the whole
# updater with an assertion of its own in the middle of a download.
(cd "$work/release" && exec python3 -m http.server "$port_release" --bind 0.0.0.0 --protocol HTTP/1.1) >"$work/http.log" 2>&1 &
server_pid=$!

step "A clean Debian container with systemd, and version A ($a) installed by the real installer"
docker build -q -t botkins-e2e-debian "$here" >/dev/null
docker run -d --name "$name" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock --tmpfs /tmp --add-host host.docker.internal:host-gateway botkins-e2e-debian >/dev/null
for _ in $(seq 1 30); do [ "$(in_box systemctl is-system-running 2>/dev/null || true)" = running ] && break; sleep 1; done
box "curl -fsSL $base/v$a/install.sh | sh -s -- --release-url $base --version $a --release-fingerprint $fingerprint" | tail -n 6
box 'mkdir -p /srv/projects && botkins service install --allow-path /srv/projects' | tail -n 6
running_on "$a"
choices | tee "$work/choices-a.txt"
grep -q '^ReadWritePaths=/var/lib/botkins /srv/projects$' "$work/choices-a.txt" || fail "The project folder is not in the unit."
box 'botkins doctor | grep "Service files"; botkins update --check'
arch=${target#linux-}

step "A installs B, asked for as a phone asks: B writes the units before the service restarts, and every choice is kept"
latest "$b"
started_before=$(in_box systemctl show botkins-update.service -p ExecMainStartTimestampMonotonic --value)
update_as_a_phone_would
[ "$(in_box systemctl show botkins-update.service -p Result --value)" = success ] || fail "The update job ended badly."
running_on "$b"
echo "The last install, as the service tells a phone: from $(status_field '.update.last?.from') to $(status_field '.update.last?.to'), ok: $(status_field '.update.last?.ok') $(status_field '.update.last?.message')"
[ "$(status_field '.update.last?.ok')" = true ] && [ "$(status_field '.update.last?.to')" = "$b" ] || fail "The service does not say that the install of B went well."
[ -z "$(status_field '.update.last?.message')" ] || fail "The install of B had something to say, and should have had nothing."
choices > "$work/choices-b.txt"
diff "$work/choices-a.txt" "$work/choices-b.txt" || fail "What was chosen at install time changed."
box "grep -n LimitCORE $unit; systemctl show botkins -p LimitCORE -p NRestarts -p ActiveState"
[ "$(in_box systemctl show botkins -p LimitCORE --value)" = 0 ] || fail "The service does not run under B's unit."
box 'grep -h "^Description=\|^TimeoutStartSec=" /etc/systemd/system/botkins-update.path /etc/systemd/system/botkins-update.service; systemctl is-active botkins-update.path; systemctl is-enabled botkins.service botkins-update.path'
in_box grep -q '^Description=.*(B)$' /etc/systemd/system/botkins-update.path || fail "The watch is not B's."
in_box grep -q '^TimeoutStartSec=1800$' /etc/systemd/system/botkins-update.service || fail "The update job is not B's."
[ "$(in_box systemctl is-active botkins-update.path)" = active ] || fail "The update watch is not running."
box 'stat -c "%U %a %n" /etc/systemd/system/botkins* /etc/botkins/install.json'
in_box sh -c 'ls -a /etc/systemd/system | grep -q "^\.botkins"' && fail "Something is left of the writing."
in_box test -f "$unit.bak" || fail "No copy of the unit that was replaced was kept."
box 'botkins doctor | grep "Service file"'
in_box sh -c 'botkins doctor | grep -q "^ok .*Service files"' || fail "Doctor does not say that the files are B's."
in_box sh -c 'cp /etc/systemd/system/botkins.service /root/unit-b; cp /etc/systemd/system/botkins-update.path /root/watch-b; cp /etc/systemd/system/botkins-update.service /root/job-b'

step "B installs C: C doesn't stay up, so B is put back, under B's units, and C's extra unit is gone"
latest "$c"
started_before=$(in_box systemctl show botkins-update.service -p ExecMainStartTimestampMonotonic --value)
update_as_a_phone_would
[ "$(in_box systemctl show botkins-update.service -p Result --value)" != success ] || fail "The update to C did not fail."
running_on "$b"
echo "The last install, as the service tells a phone: ok: $(status_field '.update.last?.ok'). $(status_field '.update.last?.message')"
[ "$(status_field '.update.last?.ok')" = false ] || fail "The service does not say that the install of C failed."
status_field '.update.last?.message' | grep -q "Botkins $b was put back" || fail "The service does not say that B was put back."
box 'cmp /etc/systemd/system/botkins.service /root/unit-b && cmp /etc/systemd/system/botkins-update.path /root/watch-b && cmp /etc/systemd/system/botkins-update.service /root/job-b && echo "the units are B'"'"'s again, byte for byte"' || fail "The units are not B's."
box 'ls /etc/systemd/system | grep botkins; systemctl show botkins -p LimitCORE -p LimitNOFILE -p ActiveState; systemctl is-active botkins-update.path; systemctl is-enabled botkins.service botkins-update.path; ls /opt/botkins'
in_box test ! -e /etc/systemd/system/botkins-tidy.timer || fail "C's extra unit is still there."
[ "$(in_box systemctl show botkins -p LimitNOFILE --value)" != 4096 ] || fail "The service still runs under C's unit."
in_box test ! -e "/opt/botkins/botkins-terminal-$c-linux-$arch" || fail "C is still on disk."
in_box sh -c 'botkins doctor | grep -q "^ok .*Service files"' || fail "Doctor does not say that the files are B's."

step "A unit from an earlier version, with a variable the person added: doctor says so, and refresh writes this version's and keeps the variable"
box "sed -i -e '/^LimitCORE=0\$/d' -e 's|^ExecStart=|Environment=HTTPS_PROXY=http://proxy.example:3128\nExecStart=|' $unit && systemctl daemon-reload"
box 'botkins doctor | grep -A1 "Service files"; botkins service refresh --check; echo "exit=$?"' | tee "$work/stale.txt"
grep -q "^FAIL .*Service files" "$work/stale.txt" || fail "Doctor did not say that the unit is stale."
grep -q "exit=1" "$work/stale.txt" || fail "refresh --check did not say that the unit is stale."
box 'su -s /bin/sh botkins -c "botkins service refresh"; echo "exit=$?"' | tee "$work/denied.txt"
grep -q "exit=4" "$work/denied.txt" || fail "The service's own user could write the whole computer's unit."
box 'botkins service refresh'
running_on "$b"
box "grep -n 'LimitCORE\|HTTPS_PROXY' $unit; systemctl show botkins -p LimitCORE; grep -c HTTPS_PROXY $unit.bak"
in_box grep -q '^Environment=HTTPS_PROXY=http://proxy.example:3128$' "$unit" || fail "The person's variable was lost."
[ "$(in_box systemctl show botkins -p LimitCORE --value)" = 0 ] || fail "The service was not restarted under the unit."
in_box sh -c 'systemctl show botkins -p Environment | grep -q HTTPS_PROXY' || fail "The service does not run with the person's variable."
choices > "$work/choices-c.txt"
diff "$work/choices-a.txt" "$work/choices-c.txt" || fail "What was chosen at install time changed."
box 'botkins doctor | grep "Service file"; botkins service refresh'

step "A setting of the person's own that can't be carried: the file is left as it is, and doctor says where such a setting is kept"
box "sed -i -e '/^LimitCORE=0\$/d' -e 's|^RestartSec=3\$|RestartSec=30|' $unit && systemctl daemon-reload && cp $unit /root/unit-own"
box 'botkins service refresh; echo "exit=$?"; botkins doctor | grep -A1 "Service file"' | tee "$work/own.txt"
in_box cmp "$unit" /root/unit-own || fail "A file with a setting of the person's own was replaced."
grep -q "RestartSec=30" "$work/own.txt" || fail "Nothing said which setting keeps the file as it is."
grep -q "systemctl edit botkins.service" "$work/own.txt" || fail "Doctor did not say where such a setting is kept."

echo
echo "UNITS END TO END: PASSED"
