#!/bin/bash
# Sets up Botkins with its own relay on an Ubuntu 24.04 VM, without Docker, and prints one line:
# the pairing link. The Azure template runs it with the Custom Script extension and returns that
# line as the deployment's output. It is safe to run again: it updates and restarts.
#
# What it sets up, all as systemd services:
#   botkins          Botkins, from its signed release (desktop/install/install.sh)
#   botkins-relay    the self-hosted relay (mobile/relay/node), on the loopback only
#   caddy            HTTPS on the VM's DNS name, in front of the relay
#   botkins-display  with Screen access only: a virtual display a paired phone can see and control
#
# A deployment gives its settings in the environment, base64-encoded so no value needs quoting:
#   BK_FQDN          the VM's public DNS name (required)
#   BK_EMAIL         optional: a certificate contact address (also enables ZeroSSL as a fallback CA)
#   BK_NAME          the name phones show for this server
#   BK_SCREEN        "true" for Screen access
#   BK_REPO, BK_REF  where this setup's sources come from
#   BK_CLAUDE_TOKEN  optional: a Claude Code token (`claude setup-token`)
#   BK_GITHUB_TOKEN  optional: a GitHub token for Copilot
#   BK_PUSH          https://relay.botkins.app (forward iPhone notifications) or "off"
# Without BK_FQDN it uses the settings this server already has (/etc/botkins-server/server.env).
# `botkins-server` runs it that way, with these options:
#   --no-pair        do not open a pairing code at the end
#   --screen on|off  turn Screen access on or off
#   --update         also install the latest Botkins release and Node.js 24
#   --ref <ref>      the branch or tag the sources are now at, to keep in the settings
# -E: the ERR trap below also fires inside functions.
set -Eeuo pipefail

pair=1 screen_set= update=0 ref_set=
while [ $# -gt 0 ]; do
  case "$1" in
    --no-pair) pair=0 ;;
    --screen) screen_set=${2:-}; shift ;;
    --update) update=1 ;;
    --ref) ref_set=${2:-}; shift ;;
    *) echo "install.sh: unknown option $1" >&2; exit 64 ;;
  esac
  shift
done

SERVER=/opt/botkins-server
SRC=$SERVER/src
ETC=/etc/botkins-server
decode() { if [ -n "${1:-}" ]; then printf '%s' "$1" | base64 -d; fi; }
setting() { if [ -r "$ETC/server.env" ]; then sed -n "s/^$1=//p" "$ETC/server.env" | head -n 1; fi; }

CLAUDE_TOKEN= GITHUB_TOKEN=
if [ -n "${BK_FQDN:-}" ]; then
  deployment=1
  FQDN=$(decode "$BK_FQDN")
  EMAIL=$(decode "${BK_EMAIL:-}")
  NAME=$(decode "${BK_NAME:-}")
  REPO=$(decode "${BK_REPO:-}")
  REF=$(decode "${BK_REF:-}")
  CLAUDE_TOKEN=$(decode "${BK_CLAUDE_TOKEN:-}")
  GITHUB_TOKEN=$(decode "${BK_GITHUB_TOKEN:-}")
  PUSH=$(decode "${BK_PUSH:-}")
  if [ "$(decode "${BK_SCREEN:-}")" = true ]; then MODE=screen; else MODE=terminal; fi
else
  deployment=0
  FQDN=$(setting FQDN) EMAIL=$(setting EMAIL) NAME=$(setting NAME) REPO=$(setting REPO) REF=$(setting REF) PUSH=$(setting PUSH) MODE=$(setting MODE)
fi
# The tokens stay in this shell: nothing this script starts inherits them.
unset BK_CLAUDE_TOKEN BK_GITHUB_TOKEN
case "$screen_set" in on) MODE=screen ;; off) MODE=terminal ;; "") ;; *) echo "install.sh: --screen on or off" >&2; exit 64 ;; esac
[ "$MODE" = screen ] || MODE=terminal
if [ -n "$ref_set" ]; then REF=$ref_set; fi
: "${NAME:=Botkins server}" "${REPO:=https://github.com/promptclickrun/Botkins}" "${REF:=main}" "${PUSH:=https://relay.botkins.app}"
if [ -z "$FQDN" ]; then echo "install.sh: BK_FQDN is required for a new server." >&2; exit 64; fi
[ "$(id -u)" -eq 0 ] || { echo "install.sh: run this as root." >&2; exit 77; }

LOG=/var/log/botkins-install.log
exec 3>&1 >>"$LOG" 2>&1
# Progress goes to the log. From `botkins-server` it also goes to the terminal; a deployment's
# output is the pairing link alone.
say() {
  echo "[$(date -u +%H:%M:%S)] $*"
  if [ "$pair" -eq 0 ]; then echo "$*" >&3; fi
}
fail() { say "FAILED: $*"; echo "Botkins setup failed: $*. See $LOG on the VM." >&3; exit 1; }
trap 'fail "line $LINENO"' ERR
export DEBIAN_FRONTEND=noninteractive
# The Custom Script extension may run this without HOME. git and npm want one.
export HOME=${HOME:-/root}
apt() { apt-get -o DPkg::Lock::Timeout=600 -yq "$@"; }
# On first boot, apt-daily can hold the package lists' lock, which the timeout above doesn't cover.
apt_update() {
  for i in $(seq 1 60); do
    if apt-get -o DPkg::Lock::Timeout=600 update -q; then return 0; fi
    sleep 10
  done
  fail "apt-get update kept failing"
}
ARCH=$(dpkg --print-architecture)

# The Botkins service runs as a system user named botkins. An earlier deployment could name the
# VM's administrator that, and Botkins must not run as an administrator.
if id -u botkins >/dev/null 2>&1 && [ "$(id -u botkins)" -ge 1000 ]; then
  fail "this VM's administrator is named botkins, which is the name of the account the Botkins service needs. Make a new deployment"
fi

# ── A server from the earlier, Docker-based deployment ─────────────────────────────────────────
if [ -f /etc/botkins/botkins.env ]; then
  say "Stopping the earlier Docker setup (its volumes stay on disk)"
  if command -v docker >/dev/null; then docker compose -p botkins down --remove-orphans || true; fi
  # Its settings, its copy of the sources and its `botkins` wrapper. The release puts Botkins'
  # own `botkins` command in its place.
  rm -rf /etc/botkins /opt/botkins/src
  rm -f /usr/local/bin/botkins
fi

say "Installing packages"
apt_update
apt install ca-certificates curl git gnupg python3

# Node.js 24 for the relay and Claude Code. Botkins uses it too. It comes from nodejs.org and is
# checked against the checksums published there.
node_major() { node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 24 ] || [ "$update" -eq 1 ]; then
  case "$ARCH" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) fail "no Node.js for $ARCH" ;; esac
  base=https://nodejs.org/dist/latest-v24.x
  work=$(mktemp -d)
  curl -fsSL "$base/SHASUMS256.txt" -o "$work/sums"
  file=$(awk -v want="-linux-$node_arch.tar.gz" 'index($2, want) && index($2, want) == length($2) - length(want) + 1 { print $2; exit }' "$work/sums")
  [ -n "$file" ] || fail "nodejs.org has no Node.js 24 for linux-$node_arch"
  if [ "$(node -p '"node-v" + process.versions.node' 2>/dev/null || true)-linux-$node_arch.tar.gz" != "$file" ]; then
    say "Installing ${file%.tar.gz}"
    curl -fsSL "$base/$file" -o "$work/$file"
    [ "$(sha256sum "$work/$file" | cut -d' ' -f1)" = "$(awk -v f="$file" '$2 == f { print $1 }' "$work/sums")" ] || fail "the Node.js download doesn't match its checksum"
    rm -rf /usr/local/lib/nodejs.new
    mkdir -p /usr/local/lib/nodejs.new
    tar -xzf "$work/$file" -C /usr/local/lib/nodejs.new --strip-components 1 --no-same-owner
    rm -rf /usr/local/lib/nodejs
    mv /usr/local/lib/nodejs.new /usr/local/lib/nodejs
    for tool in node npm npx; do ln -sf "/usr/local/lib/nodejs/bin/$tool" "/usr/local/bin/$tool"; done
  fi
  rm -rf "$work"
fi

# ── This setup's sources ─────────────────────────────────────────────────────────────────────
# A deployment fetches them. `botkins-server update` fetches them itself, before it runs this.
if [ "$deployment" -eq 1 ] || [ ! -d "$SRC/.git" ]; then
  say "Fetching the setup's sources ($REF)"
  if [ -d "$SRC/.git" ]; then
    git -C "$SRC" remote set-url origin "$REPO"
  else
    rm -rf "$SRC"
    install -d -m 0755 "$SERVER"
    git init -q "$SRC"
    git -C "$SRC" remote add origin "$REPO"
  fi
  git -C "$SRC" fetch -q --depth 1 origin "$REF"
  git -C "$SRC" checkout -q --force FETCH_HEAD
fi
say "Sources at $(git -C "$SRC" rev-parse --short HEAD)"
install -m 0755 "$SRC/deploy/azure/botkins-server" /usr/local/sbin/botkins-server

say "Writing settings (Screen access: $([ "$MODE" = screen ] && echo on || echo off))"
install -d -m 0755 "$ETC"
# Not secret: the wait before each start of Botkins reads FQDN from here as the `botkins` user.
{
  printf 'FQDN=%s\n' "$FQDN"
  printf 'NAME=%s\n' "$NAME"
  printf 'MODE=%s\n' "$MODE"
  printf 'PUSH=%s\n' "$PUSH"
  printf 'EMAIL=%s\n' "$EMAIL"
  printf 'REPO=%s\n' "$REPO"
  printf 'REF=%s\n' "$REF"
} >"$ETC/server.env"
printf 'PUSH_UPSTREAM=%s\n' "$PUSH" >"$ETC/relay.env"
chmod 0644 "$ETC/server.env" "$ETC/relay.env"
# Botkins reaches its relay by the public name, through Caddy on this machine.
sed -i '/# botkins-server$/d' /etc/hosts
printf '127.0.0.1 %s # botkins-server\n' "$FQDN" >>/etc/hosts

# ── The relay and HTTPS ──────────────────────────────────────────────────────────────────────
say "Installing the relay"
(cd "$SRC/mobile/relay" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
install -m 0644 "$SRC/deploy/azure/systemd/botkins-relay.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable botkins-relay.service
systemctl restart botkins-relay.service

if ! command -v caddy >/dev/null; then
  say "Installing Caddy"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" >/etc/apt/sources.list.d/caddy-stable.list
  apt_update
  apt install caddy
fi
{
  if [ -n "$EMAIL" ]; then printf '{\n\temail %s\n}\n\n' "$EMAIL"; fi
  sed "s/@FQDN@/$FQDN/" "$SRC/deploy/azure/Caddyfile"
} >/etc/caddy/Caddyfile
chmod 0644 /etc/caddy/Caddyfile
systemctl enable caddy.service
systemctl restart caddy.service

say "Waiting for the certificate and the relay"
answered=
for i in $(seq 1 180); do
  if curl -fsS -o /dev/null --max-time 5 "https://$FQDN/v1/health"; then answered=1; break; fi
  sleep 5
done
[ -n "$answered" ] || fail "the relay did not answer at https://$FQDN. Check: botkins-server logs caddy"

# ── Botkins ──────────────────────────────────────────────────────────────────────────────────
if ! command -v botkins >/dev/null || [ "$deployment" -eq 1 ] || [ "$update" -eq 1 ]; then
  say "Installing the latest Botkins release"
  sh "$SRC/desktop/install/install.sh" --no-start
fi
say "Configuring Botkins"
# Stopped, the command writes the settings itself, with the release just installed. A running older
# release would check them instead, and it doesn't know the newer settings. The restart below starts it.
systemctl stop botkins.service 2>/dev/null || true
botkins config set name "$NAME"
botkins config set link.announce false
botkins config set relay.url "https://$FQDN"
botkins config set relay.enabled true
# Phones reach this server only through this relay, so a phone may turn on Screen access through it.
# A release older than this setting refuses it. Everything else still works, and
# `botkins-server update` sets it once the release has it.
if ! out=$(botkins config set relay.own true 2>&1); then
  case "$out" in
    *"is not a setting"*) say "This Botkins release has no relay.own yet, so a phone can't turn the screen on through the relay. Later: botkins-server update" ;;
    *) fail "botkins config set relay.own: $out" ;;
  esac
fi

install -d -m 0755 /etc/systemd/system/botkins.service.d
install -m 0644 "$SRC/deploy/azure/systemd/botkins.service.d/50-azure.conf" /etc/systemd/system/botkins.service.d/
if [ "$MODE" = screen ]; then
  say "Installing the virtual display and Google Chrome"
  apt install xvfb xauth xdotool ffmpeg
  if [ "$ARCH" = amd64 ] && [ ! -x /usr/bin/google-chrome ]; then
    # Chrome's package also adds Google's repository, so it gets updates.
    curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/google-chrome.deb
    apt install /tmp/google-chrome.deb
    rm -f /tmp/google-chrome.deb
  fi
  install -d -o botkins -g botkins -m 0700 /var/lib/botkins/display
  install -m 0644 "$SRC/deploy/azure/systemd/botkins-display.service" /etc/systemd/system/
  install -m 0644 "$SRC/deploy/azure/systemd/botkins.service.d/60-screen.conf" /etc/systemd/system/botkins.service.d/
  systemctl daemon-reload
  systemctl enable botkins-display.service
  systemctl restart botkins-display.service
else
  rm -f /etc/systemd/system/botkins.service.d/60-screen.conf
  if [ -f /etc/systemd/system/botkins-display.service ]; then systemctl disable --now botkins-display.service || true; fi
  systemctl daemon-reload
fi
systemctl enable botkins.service
systemctl restart botkins.service

say "Waiting for Botkins to start"
ready=
for i in $(seq 1 300); do
  if botkins status --json >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ -n "$ready" ] || fail "Botkins did not start. Check: botkins-server logs"

# A sign-in given at deployment goes to Botkins on standard input, never on a command line, and
# Botkins keeps it sealed in its vault. A token the provider refuses is not kept: the server still
# works, and `botkins providers login <provider>` signs in later.
signin() { # <provider> <token>
  if printf '%s' "$2" | botkins providers login "$1" --token --yes; then say "Signed in: $1"; else say "The $1 token was not accepted. Sign in later: botkins providers login $1"; fi
}
if [ -n "$GITHUB_TOKEN" ]; then signin copilot "$GITHUB_TOKEN"; fi
if [ -n "$CLAUDE_TOKEN" ]; then
  say "Installing Claude Code"
  if npm install -g --prefix /usr/local --no-audit --no-fund --loglevel=error @anthropic-ai/claude-code; then signin claude "$CLAUDE_TOKEN"; else say "Claude Code did not install. Later: npm install -g --prefix /usr/local @anthropic-ai/claude-code, then botkins providers login claude"; fi
fi

# Password sign-in stays off. A VM made without an SSH key has a random password that nobody
# was given, and this keeps SSH from ever taking it.
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' >/etc/ssh/sshd_config.d/00-botkins.conf
systemctl reload ssh.service || true

if [ "$pair" -eq 1 ]; then
  say "Opening a pairing code"
  # A new code each run, so a rerun of the deployment hands out a new link with its full lifetime.
  link=$(botkins-server pair --wait 900) || fail "Botkins did not reach its relay at https://$FQDN"
  say "Ready"
  echo "$link" >&3
else
  say "Done."
fi
