#!/usr/bin/env bash
# The terminal host on macOS, end to end, as a launchd job in your own session.
#
# It installs this checkout as a LaunchAgent on a data folder of its own, with the host key in
# your login keychain, and then does what test/terminal-e2e/run.sh does on Linux: signs a
# stand-in provider in, makes a bot, pairs a stand-in phone on the local network and (unless
# --no-relay) through the Botkins relay, and restarts, kills and stops the service.
#
# WARNING: this changes two things of yours for the length of the run, and puts both back:
#   ~/Library/LaunchAgents/app.botkins.terminal.plist   the launchd job
#   the keychain item "Botkins Terminal Host"           this run's host key
# It refuses to start when a terminal host is already installed for you.
#
#   test/terminal-e2e/macos.sh [--no-relay]
set -euo pipefail

relay=1
[ "${1:-}" != "--no-relay" ] || relay=0
[ "$(uname -s)" = Darwin ] || { echo "This is the macOS check. On Linux, run test/terminal-e2e/run.sh." >&2; exit 2; }
plist=$HOME/Library/LaunchAgents/app.botkins.terminal.plist
[ ! -e "$plist" ] || { echo "A Botkins terminal host is already installed for you ($plist). This check would replace it, so it stops here." >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
desktop=$(cd "$here/../.." && pwd)
# A short folder: the control socket's path has to fit in a socket address.
work=$(mktemp -d /tmp/bk-mac.XXXXXX)
export BOTKINS_DATA_DIR=$work/root
port=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
bk() { node "$desktop/cli/botkins.mjs" "$@"; }
step() { printf '\n## %s\n' "$*"; }
run() { printf '$ botkins %s\n' "$*"; bk "$@"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval("v"+process.argv[1]))})' "$1"; }
fail() { echo "FAILED: $*" >&2; exit 1; }
phone() { node "$desktop/test/fixtures/phone.mjs" "$@"; }
# The service's process id, or nothing while it isn't running.
pid_of() { bk status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);if(v.running)console.log(v.pid)}catch{}})' || true; }
cleanup() {
  bk service uninstall --yes >/dev/null 2>&1 || true
  account=$(node -e 'import(process.argv[1]).then(m=>console.log(m.keychainAccount(process.argv[2])))' "$desktop/desktop/host/keystore.mjs" "$BOTKINS_DATA_DIR/data" 2>/dev/null || true)
  [ -z "$account" ] || security delete-generic-password -s "Botkins Terminal Host" -a "$account" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

step "A data folder of its own, a stand-in provider on the PATH, and settings that keep it off the local network's list"
mkdir -p "$work/bin" "$BOTKINS_DATA_DIR"
printf '#!/bin/sh\nSTANDIN_AGENT_HOME=%s exec %s %s "$@"\n' "$work/agent" "$(command -v node)" "$desktop/test/fixtures/standin-agent.mjs" > "$work/bin/grok"
chmod 755 "$work/bin/grok"
printf '{"providers":{"only":["grok"]},"link":{"port":%s,"announce":false}}\n' "$port" > "$BOTKINS_DATA_DIR/config.json"
sw_vers | tr '\n' ' '; echo; node --version

step "Install as a launchd job (a LaunchAgent in this session)"
PATH=$work/bin:$PATH run service install --user
grep -q "<string>$BOTKINS_DATA_DIR</string>" "$plist" || fail "The service was not installed on this run's data folder."
for _ in $(seq 1 30); do bk status >/dev/null 2>&1 && break; sleep 1; done
run status
run service status
launchctl print "gui/$(id -u)/app.botkins.terminal" | grep -E "^\s*(state|pid|program|runs) =" | sed 's/^[[:space:]]*/  /'
bk status --json | grep -q '"source":"keychain"' || fail "The host key is not in the keychain."
stat -f "%Sp %N" "$BOTKINS_DATA_DIR" "$BOTKINS_DATA_DIR/run/botkins.sock" "$BOTKINS_DATA_DIR/data/vault.json" "$BOTKINS_DATA_DIR/data/link/link.json"
[ ! -e "$BOTKINS_DATA_DIR/data/host.key" ] || fail "The host key is in the data folder."

step "A provider signs in, a bot is made, and it answers at the terminal"
run providers enable grok
printf 'confirmation-from-another-device\n' | bk providers login grok
run bots add Nova --role Editor --instructions "Be brief." --model grok/standin-1
run chat Nova -m "Say hello from the terminal"

step "Pair a phone on the local network"
bk pair --no-wait | sed -n '/^Pair a phone/,$p' | sed 's/\(Code  *\).*/\1[shown at the terminal]/; s/\(Link  *\).*/\1[shown at the terminal]/'
url=$(bk pair --json | json .url)
phone --link "$url" --via lan --save "$work/pairing-lan.json" --name "Fixture phone (LAN)" --bot Nova --message "Hello over the local network" | tee "$work/lan.json"
[ "$(json .chat.pieces < "$work/lan.json")" -gt 1 ] || fail "The reply did not stream to the phone."

if [ "$relay" -eq 1 ]; then
  step "Pair a second phone through the relay only"
  run relay on
  for _ in $(seq 1 30); do bk relay status --json | grep -q '"connected":true' && break; sleep 1; done
  run relay status
  url=$(bk pair --json | json .url)
  phone --link "$url" --via relay --save "$work/pairing-relay.json" --name "Fixture phone (relay)" --bot Nova --message "Hello through the relay" | tee "$work/relay.json"
  [ "$(json .route < "$work/relay.json")" = relay ] || fail "The phone did not go through the relay."
fi

step "Status and devices, as JSON"
run status --json
run devices list --json

step "Restart: launchd starts it again, and the paired phone finds everything as it was"
before=$(pid_of)
run service restart
for _ in $(seq 1 30); do now=$(pid_of); [ -n "$now" ] && [ "$now" != "$before" ] && break; sleep 1; done
echo "pid $before → $(pid_of)"
phone --pairing "$work/pairing-lan.json" --via lan --bot Nova --message "Still there after a restart?" | tee "$work/after-restart.json"
[ "$(json .chat.status < "$work/after-restart.json")" = Completed ] || fail "The phone could not chat after the restart."

step "A process that dies is started again by launchd"
before=$(pid_of)
kill -9 "$before"
for _ in $(seq 1 40); do now=$(pid_of); [ -n "$now" ] && [ "$now" != "$before" ] && break; sleep 1; done
echo "pid $before (killed) → ${now:-not running}"
[ -n "$now" ] && [ "$now" != "$before" ] || fail "launchd did not start the service again."

step "Stopped on purpose, it leaves at once and stays stopped; started, it comes back"
before=$(pid_of)
run service stop
for _ in $(seq 1 10); do kill -0 "$before" 2>/dev/null || break; sleep 1; done
if kill -0 "$before" 2>/dev/null; then fail "The service's process was still there 10 seconds after it was stopped."; fi
echo "pid $before is gone"
sleep 8
if bk status >/dev/null 2>&1; then fail "The service came back after it was stopped on purpose."; fi
bk status || true
run service start
for _ in $(seq 1 30); do bk status >/dev/null 2>&1 && break; sleep 1; done
bk status --json | grep -o '"running":true'

step "Idle memory, a minute later"
sleep 60
pid=$(pid_of)
echo "RSS $(( $(ps -o rss= -p "$pid") / 1024 )) MB (pid $pid)"

step "Doctor"
run doctor || true

step "Uninstall"
run service uninstall --yes
sleep 2
if bk status >/dev/null 2>&1; then fail "The service still runs after it was uninstalled."; fi
[ ! -e "$plist" ] || fail "The launchd job is still there."
echo
echo "MACOS END TO END: PASSED"
