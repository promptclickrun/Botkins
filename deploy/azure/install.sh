#!/bin/bash
# Installs Botkins with its own relay on a fresh Ubuntu 24.04 VM, then prints one line: the
# pairing link. By default it installs the terminal host (one small service, no display). With
# Screen access it installs Botkins on a virtual display instead. The Azure template runs this
# through the Custom Script extension and returns that line as the deployment's output. It is
# safe to run again: it updates and restarts.
#
# Settings come from the environment, base64-encoded so no value needs quoting:
#   BK_FQDN          the VM's public DNS name (required)
#   BK_EMAIL         optional: a certificate contact address (also enables ZeroSSL as a fallback CA)
#   BK_NAME          the name phones show for this server
#   BK_SCREEN        "true" for Screen access: Botkins on a virtual display the phone can see and
#                    control. Anything else installs the terminal host, which has no screen.
#   BK_REPO, BK_REF  where the Botkins sources come from
#   BK_CLAUDE_TOKEN  optional: a Claude Code token (`claude setup-token`)
#   BK_GITHUB_TOKEN  optional: a GitHub token for Copilot
#   BK_PUSH          https://relay.botkins.app (forward notifications) or "off"
set -euo pipefail

decode() { if [ -n "${1:-}" ]; then printf '%s' "$1" | base64 -d; fi; }
FQDN=$(decode "${BK_FQDN:-}")
EMAIL=$(decode "${BK_EMAIL:-}")
NAME=$(decode "${BK_NAME:-}")
REPO=$(decode "${BK_REPO:-}")
REF=$(decode "${BK_REF:-}")
CLAUDE_TOKEN=$(decode "${BK_CLAUDE_TOKEN:-}")
GITHUB_TOKEN=$(decode "${BK_GITHUB_TOKEN:-}")
PUSH=$(decode "${BK_PUSH:-}")
SCREEN=$(decode "${BK_SCREEN:-}")
# The tokens stay in this shell: nothing this script starts inherits them.
unset BK_CLAUDE_TOKEN BK_GITHUB_TOKEN
if [ "$SCREEN" = true ]; then MODE=screen; else MODE=terminal; fi
: "${NAME:=Botkins server}" "${REPO:=https://github.com/promptclickrun/Botkins}" "${REF:=main}" "${PUSH:=https://relay.botkins.app}"
if [ -z "$FQDN" ]; then echo "BK_FQDN is required." >&2; exit 64; fi

LOG=/var/log/botkins-install.log
exec 3>&1 >>"$LOG" 2>&1
say() { echo "[$(date -u +%H:%M:%S)] $*"; }
fail() { say "FAILED: $*"; echo "Botkins setup failed: $*. See $LOG on the VM." >&3; exit 1; }
trap 'fail "line $LINENO"' ERR

say "Installing Docker"
export DEBIAN_FRONTEND=noninteractive
if command -v docker >/dev/null && ! docker compose version >/dev/null 2>&1 && dpkg -s docker.io >/dev/null 2>&1; then
  # A machine that already runs Ubuntu's own Docker keeps it, and whatever it runs: only Compose
  # and Buildx are added. Docker's packages would replace the engine and restart its containers.
  for i in $(seq 1 30); do fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break; sleep 5; done
  apt-get update -q
  apt-get install -yq ca-certificates curl git docker-compose-v2 docker-buildx
elif ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  for i in $(seq 1 30); do fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break; sleep 5; done
  apt-get update -q
  apt-get install -yq ca-certificates curl git
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
command -v git >/dev/null || { apt-get update -q; apt-get install -yq git; }

say "Fetching Botkins ($REF)"
SRC=/opt/botkins/src
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch -q --depth 1 origin "$REF"
  git -C "$SRC" checkout -q --force FETCH_HEAD
else
  rm -rf "$SRC"
  install -d -m 0755 /opt/botkins
  git init -q "$SRC"
  git -C "$SRC" remote add origin "$REPO"
  git -C "$SRC" fetch -q --depth 1 origin "$REF"
  git -C "$SRC" checkout -q FETCH_HEAD
fi
say "At $(git -C "$SRC" rev-parse --short HEAD)"

# A server that ran the other setup stops it first. The two keep separate data, and both stay on disk.
if [ -f /etc/botkins/botkins.env ]; then
  WAS=$(sed -n 's/^BOTKINS_MODE=//p' /etc/botkins/botkins.env | head -n 1)
  if [ "${WAS:-screen}" != "$MODE" ]; then
    say "Stopping the earlier setup (${WAS:-screen})"
    # By the project's name, so it does not depend on which files started it. Volumes are kept.
    docker compose -p botkins down --remove-orphans || true
  fi
fi

say "Writing settings ($MODE)"
install -d -m 0700 /etc/botkins
umask 077
{
  printf 'BOTKINS_FQDN=%s\n' "$FQDN"
  printf 'BOTKINS_HOST_NAME=%s\n' "$NAME"
  printf 'BOTKINS_PUSH_UPSTREAM=%s\n' "$PUSH"
  printf 'BOTKINS_MODE=%s\n' "$MODE"
} >/etc/botkins/botkins.env
{
  if [ -n "$EMAIL" ]; then printf '{\n\temail %s\n}\n\n' "$EMAIL"; fi
  cat "$SRC/deploy/azure/Caddyfile"
} >/etc/botkins/Caddyfile
chmod 0644 /etc/botkins/Caddyfile
# With Screen access, only the workspace container reads these. An empty file is fine: sign in
# later. The terminal host keeps a sign-in in its own vault instead (below), so the file stays empty.
{
  if [ "$MODE" = screen ]; then
    [ -n "$CLAUDE_TOKEN" ] && printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_TOKEN"
    [ -n "$GITHUB_TOKEN" ] && printf 'BOTKINS_COPILOT_TOKEN=%s\n' "$GITHUB_TOKEN"
  fi
  true
} >/etc/botkins/providers.env
umask 022
install -m 0755 "$SRC/deploy/azure/botkins" /usr/local/bin/botkins

say "Building and starting (this takes several minutes the first time)"
botkins compose build
botkins compose up -d --remove-orphans

if [ "$MODE" = terminal ]; then
  say "Waiting for the certificate, then configuring the terminal host"
  # The host starts once its relay answers over HTTPS (wait-for-relay.sh), so this covers the
  # time Caddy needs to get its certificate.
  ready=
  for i in $(seq 1 450); do
    if botkins host status --json >/dev/null 2>&1; then ready=1; break; fi
    sleep 2
  done
  [ -n "$ready" ] || fail "the Botkins host did not start. Check: botkins logs caddy relay botkins"
  # The host's own settings, through its own command: its name, and this server's relay.
  botkins host config set name "$NAME"
  botkins host config set relay.url "https://$FQDN"
  botkins host relay on

  # A sign-in given at deployment goes to the host on standard input, never on a command line,
  # and the host keeps it sealed in its vault. A token the provider turns down is not kept: the
  # server still works, and `botkins host providers login <provider>` signs in later.
  signin() { # <provider> <token>
    if printf '%s' "$2" | botkins host providers login "$1" --token; then say "Signed in: $1"; else say "The $1 token was not accepted. Sign in later: botkins host providers login $1"; fi
  }
  if [ -n "$GITHUB_TOKEN" ]; then signin copilot "$GITHUB_TOKEN"; fi
  if [ -n "$CLAUDE_TOKEN" ]; then
    # The terminal host's image has no Claude Code. It goes in the data volume, once.
    say "Installing Claude Code"
    if botkins install-claude; then signin claude "$CLAUDE_TOKEN"; else say "Claude Code did not install. Later: botkins install-claude, then botkins host providers login claude"; fi
  fi
fi

say "Waiting for the certificate and the relay, then opening a pairing code"
# A fresh code every run, so a rerun of the deployment hands out a new link with its full lifetime.
link=$(botkins pair --wait 900) || fail "the server did not reach its relay at https://$FQDN"
say "Ready"
echo "$link" >&3
