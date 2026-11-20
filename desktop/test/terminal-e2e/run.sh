#!/usr/bin/env bash
# The terminal host, end to end, on a clean Linux container with systemd.
#
# It builds the release tarball for the container's architecture, signs its checksums with a key
# made for this run, and serves that "release" from this computer. In the container it runs the
# real installer, which checks the signature and the checksum, adds Node.js, makes the `botkins`
# user and installs the systemd unit. Then it does what a person would: signs a provider in,
# makes a bot, pairs a phone and chats, on the local network and (unless --no-relay) through the
# Botkins relay, and restarts the service and the whole container in between.
#
# The provider is a stand-in agent and the phone a stand-in client (test/fixtures), each a real
# process: no account is used. The relay is the real one (relay.botkins.app), reached as any host
# reaches it; what goes through it is sealed, and is this run's own test chat.
#
#   test/terminal-e2e/run.sh [--no-relay] [--keep]
#
# Needs Docker, Node.js 24, GnuPG and python3 on this computer. Everything it makes is in a
# temporary folder and one container, both removed at the end (--keep leaves them to look at).
set -euo pipefail

relay=1
keep=0
for arg in "$@"; do
  case $arg in
    --no-relay) relay=0 ;;
    --keep) keep=1 ;;
    *) echo "Unknown option $arg" >&2; exit 2 ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)
desktop=$(cd "$here/../.." && pwd)
version=$(node -p 'require(process.argv[1]).version' "$desktop/package.json")
work=$(mktemp -d "${TMPDIR:-/tmp}/bk-e2e.XXXXXX")
name=bk-e2e-$$
port_release=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
port_link=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
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
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval("v"+process.argv[1]))})' "$1"; }
fail() { echo "FAILED: $*" >&2; exit 1; }
phone() { node "$desktop/test/fixtures/phone.mjs" "$@"; }

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
ls -l "$release" | awk 'NR > 1 { print $5, $9 }'
(cd "$work/release" && exec python3 -m http.server "$port_release" --bind 0.0.0.0) >"$work/http.log" 2>&1 &
server_pid=$!
base=http://host.docker.internal:$port_release

step "A clean Debian container with systemd: no Node.js, no X libraries"
docker build -q -t botkins-e2e-debian "$here" >/dev/null
docker run -d --name "$name" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock --tmpfs /tmp --add-host host.docker.internal:host-gateway -p "127.0.0.1:$port_link:$port_link" botkins-e2e-debian >/dev/null
for _ in $(seq 1 30); do [ "$(in_box systemctl is-system-running 2>/dev/null || true)" = running ] && break; sleep 1; done
box 'grep PRETTY_NAME /etc/os-release; uname -m; systemctl --version | head -n 1; command -v node || echo "node: not installed"; echo "X and GTK packages: $(dpkg -l | grep -ciE "libx11|xserver|libgtk|xvfb" || true)"'

step "The installer refuses a release that isn't signed by the key it expects"
if box "curl -fsSL $base/v$version/install.sh | sh -s -- --release-url $base --version $version" 2>&1 | tail -n 2; then :; fi
in_box test ! -e /opt/botkins || fail "Something was installed from a release with the wrong key."

step "Install (the test key is named on purpose, as a mirror's own key would be)"
box "curl -fsSL $base/v$version/install.sh | sh -s -- --release-url $base --version $version --release-fingerprint $fingerprint"

step "The service: installed, running as its own user, its files closed to everyone else"
sleep 3
box 'botkins status'
box 'botkins service status'
box 'systemctl show botkins -p User -p MainPID -p NRestarts -p UnitFileState'
box 'stat -c "%A %U:%G %n" /var/lib/botkins /var/lib/botkins/run /var/lib/botkins/run/botkins.sock /var/lib/botkins/config.json /var/lib/botkins/data/workspace.json /var/lib/botkins/data/vault.json /var/lib/botkins/data/link/link.json /var/lib/botkins/logs/botkins.log /etc/botkins/host.key /opt/botkins 2>/dev/null || true'
[ "$(in_box stat -c %a /var/lib/botkins/run/botkins.sock)" = 600 ] || fail "The control socket is not owner-only."
[ "$(in_box stat -c %a /var/lib/botkins)" = 700 ] || fail "The data folder is not owner-only."
in_box test ! -e /var/lib/botkins/data/host.key || fail "The host key is in the data folder."
box 'useradd -m other 2>/dev/null; su other -s /bin/sh -c "botkins status"; echo "exit=$?"' 2>&1 | tee "$work/other.txt"
grep -q "exit=4" "$work/other.txt" || fail "Another user could talk to the service."
box 'su other -s /bin/sh -c "cat /var/lib/botkins/data/vault.json /etc/botkins/host.key" 2>&1 | sed "s/^/  /"; true'
box 'systemd-analyze security botkins.service 2>/dev/null | tail -n 1'

step "Idle memory, a minute after a fresh install with every setting at its default"
sleep 60
box 'pid=$(systemctl show botkins -p MainPID --value); echo "RSS $(( $(ps -o rss= -p $pid) / 1024 )) MB (pid $pid); cgroup $(( $(systemctl show botkins -p MemoryCurrent --value) / 1048576 )) MB; processes in the service: $(systemctl show botkins -p TasksCurrent --value) tasks"' | tee "$work/idle.txt"

step "A model provider signs in from the terminal (the stand-in agent, by its own sign-in), and a bot is made"
docker cp "$desktop/test/fixtures/standin-agent.mjs" "$name:/opt/standin-agent.mjs" >/dev/null
in_box sh -c 'printf "#!/bin/sh\nexec /opt/botkins/node/bin/node /opt/standin-agent.mjs \"\$@\"\n" > /usr/local/bin/grok && chmod 755 /usr/local/bin/grok /opt/standin-agent.mjs'
box 'botkins providers enable grok && echo "confirmation-from-another-device" | botkins providers login grok'
box 'botkins providers list'
box 'botkins bots add Nova --role "Editor" --instructions "Be brief." --model grok/standin-1 && botkins bots list'
box 'botkins chat Nova -m "Say hello from the terminal"'

step "The address a phone can reach (this computer, through the container's published port), then a restart to take it up"
box "botkins config set link.port $port_link && botkins config set link.addresses 127.0.0.1 && botkins service restart && sleep 4 && botkins status --json | grep -o '\"uptimeSeconds\":[0-9]*'"

step "Pair a phone on the local network: the terminal shows a QR code, the code and the link"
box 'botkins pair --no-wait' | sed -n '1,4p;/^Pair a phone/,$p' | sed 's/\(Code  *\).*/\1[shown at the terminal]/; s/\(Link  *\).*/\1[shown at the terminal]/'
url=$(in_box botkins pair --json | json .url)
phone --link "$url" --via lan --save "$work/pairing-lan.json" --name "Fixture phone (LAN)" --bot Nova --message "Hello over the local network" | tee "$work/lan.json"
[ "$(json .chat.pieces < "$work/lan.json")" -gt 1 ] || fail "The reply did not stream to the phone."
[ "$(json .route < "$work/lan.json")" = direct ] || fail "The phone did not connect directly."

if [ "$relay" -eq 1 ]; then
  step "Away from home: the relay is switched on, and a second phone pairs and chats through it only"
  box 'botkins relay on'
  for _ in $(seq 1 30); do in_box botkins relay status --json | grep -q '"connected":true' && break; sleep 1; done
  box 'botkins relay status'
  url=$(in_box botkins pair --json | json .url)
  phone --link "$url" --via relay --save "$work/pairing-relay.json" --name "Fixture phone (relay)" --bot Nova --message "Hello through the relay" | tee "$work/relay.json"
  [ "$(json .chat.pieces < "$work/relay.json")" -gt 1 ] || fail "The reply did not stream through the relay."
  [ "$(json .route < "$work/relay.json")" = relay ] || fail "The phone did not go through the relay."
fi

step "What the service says of it: status and devices, as JSON"
box 'botkins status --json'
box 'botkins devices list --json'
box 'botkins devices list'
[ "$(in_box botkins devices list --json | json .length)" -ge 1 ] || fail "No device is listed."
box 'botkins devices set-person "Fixture phone (LAN)" "Sam" && botkins devices rename "Fixture phone (LAN)" "Kitchen phone" && botkins devices list'

step "The service is restarted, and the paired phone finds everything as it was"
box 'systemctl restart botkins && sleep 4 && systemctl is-active botkins && botkins status --json | grep -o "\"chats\":[0-9]*"'
phone --pairing "$work/pairing-lan.json" --via lan --bot Nova --message "Still there after a restart?" | tee "$work/after-restart.json"
[ "$(json .chat.status < "$work/after-restart.json")" = Completed ] || fail "The phone could not chat after the restart."

step "The whole host is restarted (the container, as a reboot), and the service comes back by itself"
docker restart "$name" >/dev/null
for _ in $(seq 1 60); do [ "$(in_box systemctl is-active botkins 2>/dev/null || true)" = active ] && break; sleep 1; done
sleep 4
box 'systemctl is-active botkins; systemctl show botkins -p NRestarts; botkins status'
phone --pairing "$work/pairing-lan.json" --via lan --bot Nova --message "And after a reboot?" | tee "$work/after-reboot.json"
[ "$(json .chat.status < "$work/after-reboot.json")" = Completed ] || fail "The phone could not chat after the reboot."
if [ "$relay" -eq 1 ]; then
  for _ in $(seq 1 30); do in_box botkins relay status --json | grep -q '"connected":true' && break; sleep 1; done
  phone --pairing "$work/pairing-relay.json" --via relay --bot Nova --message "And through the relay after a reboot?" | tee "$work/relay-after-reboot.json"
  [ "$(json .route < "$work/relay-after-reboot.json")" = relay ] || fail "The phone did not come back through the relay."
fi

step "A process that dies is started again by systemd"
box 'kill -9 $(systemctl show botkins -p MainPID --value); sleep 6; systemctl is-active botkins; systemctl show botkins -p NRestarts'
[ "$(in_box systemctl is-active botkins)" = active ] || fail "The service did not come back after being killed."

step "Stopping is clean: the service saves its work and leaves, and systemd calls that a success"
box 'systemctl stop botkins; systemctl show botkins -p ActiveState -p Result -p ExecMainStatus; systemctl start botkins; sleep 4; systemctl is-active botkins' | tee "$work/stop.txt"
grep -q "^Result=success" "$work/stop.txt" && grep -q "^ExecMainStatus=0" "$work/stop.txt" || fail "The service did not stop cleanly."

step "Secrets: wrapped at rest, and none in the log"
box 'grep -o "\"by\":\"[a-z]*\"" /var/lib/botkins/data/vault.json; grep -o "\"wrapped\": *[a-z]*" /var/lib/botkins/data/link/link.json; grep -o "\"source\":\"[a-z]*\"" /var/lib/botkins/data/keystore.json'
box 'botkins logs -n 400 > /tmp/log.txt; wc -l < /tmp/log.txt; grep -c "botkins://\|STAND-1234\|confirmation-from-another-device\|sk-\|Bearer " /tmp/log.txt || true'
[ "$(in_box sh -c 'journalctl -u botkins --no-pager | grep -c "botkins://pair\|STAND-1234\|confirmation-from-another-device" || true')" = 0 ] || fail "A secret is in the journal."

step "Idle memory after all of that, a minute later"
sleep 60
box 'pid=$(systemctl show botkins -p MainPID --value); echo "RSS $(( $(ps -o rss= -p $pid) / 1024 )) MB (pid $pid); cgroup $(( $(systemctl show botkins -p MemoryCurrent --value) / 1048576 )) MB; tasks $(systemctl show botkins -p TasksCurrent --value)"'

step "Doctor, logs, and updates (the real release list: this run's version has no published terminal build)"
box 'botkins doctor || true'
box 'botkins logs -n 6'
box 'botkins update --check || true'

step "Uninstall: the service goes, the data stays"
box 'botkins service uninstall --yes; systemctl is-enabled botkins 2>&1 || true; pgrep -u botkins -c node || true; ls /var/lib/botkins | tr "\n" " "; echo; ls /etc/botkins'

echo
echo "END TO END: PASSED"
