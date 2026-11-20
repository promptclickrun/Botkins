#!/usr/bin/env bash
# An update that changes the launchd job, end to end, on macOS, started from the running service.
#
# For one person's service the updater is a process the service itself starts, outside its own
# group of processes. When the new version's job file differs, that updater has launchd take the
# job out and load it again (`botkins service refresh`), which ends the service that started it.
# This run shows that the updater lives through that and finishes: the new version runs under
# its own job file, the 30 second watch is done, and how it ended is written down.
#
# It does whole updates, asked of the running service the way a paired phone asks (the service's
# own `update.install`), with the three versions test/terminal-e2e/units-versions.mjs makes:
#
#   A   this checkout, installed from its tarball as a LaunchAgent in your session
#   B   A with a higher version and a changed job file
#   C   B with a higher version, a job file changed again, and a service that dies
#
# A installs B: the job file is B's, the service runs on B, and the PATH it was installed with
# is kept. B installs C: C doesn't stay up, so B is put back, under B's job file.
#
# The releases are this run's own: a mirror on this computer (test/terminal-e2e/mirror.mjs, which
# answers as GitHub's release pages do), signed with a key made for this run. The three versions name that mirror and that key where the program names GitHub and the
# Botkins release key, and are otherwise the code as it is.
#
# WARNING: this changes two things of yours for the length of the run, and puts both back:
#   ~/Library/LaunchAgents/app.botkins.terminal.plist   the launchd job
#   the keychain item "Botkins Terminal Host"           this run's host key
# It refuses to start when a terminal host is already installed for you.
#
#   test/terminal-e2e/macos-update.sh
#
# Needs Node.js 24 and GnuPG. A computer under heavy load can fail this for no reason
# of the code's: launchd starts a background job late, and the watch on a new version is 30 seconds.
set -euo pipefail

[ "$(uname -s)" = Darwin ] || { echo "This is the macOS check. On Linux, run test/terminal-e2e/units.sh." >&2; exit 2; }
plist=$HOME/Library/LaunchAgents/app.botkins.terminal.plist
[ ! -e "$plist" ] || { echo "A Botkins terminal host is already installed for you ($plist). This check would replace it, so it stops here." >&2; exit 2; }
case $(uname -m) in
  arm64) target=macos-arm64 ;;
  x86_64) target=macos-x64 ;;
  *) echo "There is no Botkins build for $(uname -m)." >&2; exit 2 ;;
esac

here=$(cd "$(dirname "$0")" && pwd)
desktop=$(cd "$here/../.." && pwd)
# A short folder: the control socket's path has to fit in a socket address.
# Its real name (/tmp is a link on a Mac): the service's own files name the folder that way.
work=$(cd "$(mktemp -d /tmp/bk-up.XXXXXX)" && pwd -P)
export BOTKINS_DATA_DIR=$work/root
opt=$work/opt
job=gui/$(id -u)/app.botkins.terminal
port=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
port_release=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
server_pid=""
bk() { "$opt/current/bin/botkins" "$@"; }
step() { printf '\n## %s\n' "$*"; }
fail() { echo "FAILED: $*" >&2; exit 1; }
# What doctor says of the service's files. Doctor's own exit status is about the whole computer
# (no provider signed in is a failure there), so it is not this check's.
service_files() { bk doctor > "$work/doctor.txt" 2>&1 || true; grep "Service file" "$work/doctor.txt" || true; }
# One value out of the service's status: `status_field .update.last?.ok`. Nothing while the service is down.
status_field() { bk status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);const x=eval("v"+process.argv[1]);console.log(x===undefined||x===null?"":x)}catch{console.log("")}})' "$1" || true; }
cleanup() {
  [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true
  GNUPGHOME=$work/gnupg gpgconf --kill gpg-agent 2>/dev/null || true
  # Only this run's own job: its file names this run's folder.
  if [ -e "$plist" ] && grep -q "$work" "$plist"; then
    bk service uninstall --yes >/dev/null 2>&1 || { launchctl bootout "$job" >/dev/null 2>&1 || true; rm -f "$plist"; }
  fi
  if [ -e "$plist.bak" ] && grep -q "$work" "$plist.bak"; then rm -f "$plist.bak"; fi
  # launchd lets go of a job only when its process has ended; until then the service still writes into its folder.
  for _ in $(seq 1 30); do launchctl print "$job" >/dev/null 2>&1 || break; sleep 1; done
  account=$(node -e 'import(process.argv[1]).then(m=>console.log(m.keychainAccount(process.argv[2])))' "$desktop/desktop/host/keystore.mjs" "$BOTKINS_DATA_DIR/data" 2>/dev/null || true)
  [ -z "$account" ] || security delete-generic-password -s "Botkins Terminal Host" -a "$account" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
# Says which release is the latest: the mirror's /releases/latest then leads to it, as GitHub's does.
latest() { printf '%s\n' "$1" > "$work/release/latest"; }
# Asks the running service to install the latest release: what a paired phone's request comes to.
ask_the_service() {
  printf '$ (the service'"'"'s own call, as a phone makes it) update.install\n'
  curl -sS --max-time 60 --unix-socket "$BOTKINS_DATA_DIR/run/botkins.sock" -H 'Content-Type: application/json' -d '{"method":"update.install","args":[]}' http://localhost/v1/call | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);if(!v.ok){console.error(s);process.exit(1)}console.log("  the service says: "+v.value.status+", latest "+v.value.latest)})' || fail "The service did not take the request for an update."
}
# Waits for the record of an install to <version> that ended <ok>, as the service tells a phone.
record_of() {
  for _ in $(seq 1 "${3:-120}"); do
    if [ "$(status_field '.update.last?.to')" = "$1" ] && [ "$(status_field '.update.last?.ok')" = "$2" ]; then return 0; fi
    sleep 2
  done
  bk status 2>&1 | head -n 3 || true
  launchctl print "$job" 2>&1 | grep -E "^\s*(state|pid|last exit code|runs) =" || true
  tail -n 12 "$BOTKINS_DATA_DIR/logs/botkins.log" 2>/dev/null || true
  fail "The service has no record of an install to Botkins $1 that ended ok: $2 (it says: to '$(status_field '.update.last?.to')', ok '$(status_field '.update.last?.ok')'). $(status_field '.update.message')"
}

step "Build the tarball for this Mac, make versions B and C from it, and sign all three with a key made for this run"
sw_vers | tr '\n' ' '; echo; node --version; uptime | sed 's/.*load/load/'
mkdir -p "$work/build" "$work/release" "$BOTKINS_DATA_DIR"
(cd "$desktop" && node scripts/package-terminal.mjs --only "$target" --out "$work/build" | tail -n 1)
mkdir -m 700 "$work/gnupg"
export GNUPGHOME=$work/gnupg
gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-generate-key "Botkins e2e test key <e2e@example.invalid>" ed25519 sign 1d 2>/dev/null
fingerprint=$(gpg --batch --with-colons --list-keys | awk -F: '$1 == "fpr" { print $10; exit }')
gpg --batch --yes --armor --output "$work/key.asc" --export "$fingerprint"
base=http://127.0.0.1:$port_release
node "$here/units-versions.mjs" --tarball "$work"/build/botkins-terminal-*-"$target".tar.gz --out "$work/release" --mirror "$base" --key "$work/key.asc" --fingerprint "$fingerprint" | tee "$work/versions.txt"
a=$(awk '$1 == "A" { print $2 }' "$work/versions.txt")
b=$(awk '$1 == "B" { print $2 }' "$work/versions.txt")
c=$(awk '$1 == "C" { print $2 }' "$work/versions.txt")
[ -n "$a" ] && [ -n "$b" ] && [ -n "$c" ] || fail "The versions were not made."
for version in "$a" "$b" "$c"; do
  release=$work/release/v$version
  (cd "$release" && shasum -a 256 botkins-terminal-*.tar.gz > SHA256SUMS)
  gpg --batch --yes --pinentry-mode loopback --passphrase '' --armor --detach-sign --output "$release/SHA256SUMS.asc" "$release/SHA256SUMS"
done
unset GNUPGHOME
latest "$a"
node "$here/mirror.mjs" "$work/release" "$port_release" 127.0.0.1 >"$work/http.log" 2>&1 &
server_pid=$!

step "Version A ($a), unpacked as an install has it and installed as a LaunchAgent in this session"
mkdir "$opt"
tar -xzf "$work/release/v$a/botkins-terminal-$a-$target.tar.gz" -C "$opt"
ln -s "botkins-terminal-$a-$target" "$opt/current"
printf '{"link":{"port":%s,"announce":false}}\n' "$port" > "$BOTKINS_DATA_DIR/config.json"
bk service install --user | sed -n '1p;3,6p'
grep -q "<string>$BOTKINS_DATA_DIR</string>" "$plist" || fail "The service was not installed on this run's data folder."
grep -q "<string>$opt/current/bin/botkins</string>" "$plist" || fail "The service is not started through \`current\`."
for _ in $(seq 1 60); do [ "$(status_field .version)" = "$a" ] && break; sleep 1; done
[ "$(status_field .version)" = "$a" ] || { launchctl print "$job" 2>&1 | grep -E "^\s*(state|pid|runs) =" || true; fail "The service did not start on Botkins $a (under heavy load launchd starts a background job late)."; }
bk status | head -n 1
cp "$plist" "$work/job-a.plist"
grep -A1 "<key>ThrottleInterval</key>" "$plist" | tr -d '\n'; echo
service_files
first=$(status_field .pid)

step "A installs B, asked of the running service: the updater it starts has launchd load B's job file, and lives to finish"
latest "$b"
ask_the_service
record_of "$b" true
[ "$(status_field .version)" = "$b" ] || fail "The service is not running on Botkins $b."
echo "The last install, as the service tells a phone: from $(status_field '.update.last?.from') to $(status_field '.update.last?.to'), ok: $(status_field '.update.last?.ok') $(status_field '.update.last?.message')"
[ -z "$(status_field '.update.last?.message')" ] || fail "The install of B had something to say, and should have had nothing."
echo "pid $first → $(status_field .pid)"
launchctl print "$job" | grep -E "^\s*(state|pid) =" | sed 's/^[[:space:]]*/  /'
grep -A1 "<key>ThrottleInterval</key>" "$plist" | tr -d '\n'; echo
# B's job file is A's with the one setting B changed: the folder, the command and the PATH it was installed with are kept.
sed 's#<integer>5</integer>#<integer>7</integer>#' "$work/job-a.plist" | cmp - "$plist" || fail "The job file is not B's, with what was chosen at install time kept."
cmp "$plist.bak" "$work/job-a.plist" || fail "No copy of the job file that was replaced was kept."
service_files
grep -q "^ok .*Service files" "$work/doctor.txt" || fail "Doctor does not say that the job file is B's."
cp "$plist" "$work/job-b.plist"

step "B installs C: C doesn't stay up, so B is put back, under B's job file"
latest "$c"
ask_the_service
record_of "$c" false 150
for _ in $(seq 1 30); do [ "$(status_field .version)" = "$b" ] && break; sleep 2; done
[ "$(status_field .version)" = "$b" ] || fail "The service is not back on Botkins $b."
echo "The last install, as the service tells a phone: ok: $(status_field '.update.last?.ok'). $(status_field '.update.last?.message')"
status_field '.update.last?.message' | grep -q "Botkins $b was put back" || fail "The service does not say that B was put back."
cmp "$plist" "$work/job-b.plist" && echo "the job file is B's again, byte for byte" || fail "The job file is not B's."
launchctl print "$job" | grep -E "^\s*(state|pid) =" | sed 's/^[[:space:]]*/  /'
[ ! -e "$opt/botkins-terminal-$c-$target" ] || fail "C is still on disk."
ls "$opt"
service_files
grep -q "^ok .*Service files" "$work/doctor.txt" || fail "Doctor does not say that the job file is B's."

step "Uninstall"
bk service uninstall --yes
sleep 2
if bk status >/dev/null 2>&1; then fail "The service still runs after it was uninstalled."; fi
[ ! -e "$plist" ] || fail "The launchd job is still there."
echo
echo "MACOS UPDATE END TO END: PASSED"
