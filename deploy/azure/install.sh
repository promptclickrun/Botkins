#!/bin/bash
# Installs Botkins with its own relay on a fresh Ubuntu 24.04 VM, then prints one line: the
# pairing link. The Azure template runs this through the Custom Script extension and returns that
# line as the deployment's output. It is safe to run again: it updates and restarts.
#
# Settings come from the environment, base64-encoded so no value needs quoting:
#   BK_FQDN          the VM's public DNS name (required)
#   BK_EMAIL         optional: a certificate contact address (also enables ZeroSSL as a fallback CA)
#   BK_NAME          the name phones show for this server
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
: "${NAME:=Botkins server}" "${REPO:=https://github.com/promptclickrun/Botkins}" "${REF:=main}" "${PUSH:=https://relay.botkins.app}"
if [ -z "$FQDN" ]; then echo "BK_FQDN is required." >&2; exit 64; fi

LOG=/var/log/botkins-install.log
exec 3>&1 >>"$LOG" 2>&1
say() { echo "[$(date -u +%H:%M:%S)] $*"; }
fail() { say "FAILED: $*"; echo "Botkins setup failed: $*. See $LOG on the VM." >&3; exit 1; }
trap 'fail "line $LINENO"' ERR

say "Installing Docker"
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
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

say "Writing settings"
install -d -m 0700 /etc/botkins
umask 077
{
  printf 'BOTKINS_FQDN=%s\n' "$FQDN"
  printf 'BOTKINS_HOST_NAME=%s\n' "$NAME"
  printf 'BOTKINS_PUSH_UPSTREAM=%s\n' "$PUSH"
} >/etc/botkins/botkins.env
{
  if [ -n "$EMAIL" ]; then printf '{\n\temail %s\n}\n\n' "$EMAIL"; fi
  cat "$SRC/deploy/azure/Caddyfile"
} >/etc/botkins/Caddyfile
chmod 0644 /etc/botkins/Caddyfile
# Only the workspace container reads these. An empty file is fine: sign in later.
{
  [ -n "$CLAUDE_TOKEN" ] && printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_TOKEN"
  [ -n "$GITHUB_TOKEN" ] && printf 'BOTKINS_COPILOT_TOKEN=%s\n' "$GITHUB_TOKEN"
  true
} >/etc/botkins/providers.env
umask 022
install -m 0755 "$SRC/deploy/azure/botkins" /usr/local/bin/botkins

say "Building and starting (this takes several minutes the first time)"
botkins compose build
botkins compose up -d --remove-orphans

say "Waiting for the certificate and the relay, then opening a pairing code"
# A fresh code every run, so a rerun of the deployment hands out a new link with its full lifetime.
link=$(botkins pair --wait 900) || fail "the server did not reach its relay at https://$FQDN"
say "Ready"
echo "$link" >&3
