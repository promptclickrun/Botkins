#!/bin/sh
# Waits until this server's relay answers over HTTPS, at the name in /etc/botkins-server/server.env.
# The Botkins service runs it before each start. systemd/botkins.service.d/50-azure.conf says why.
# After 10 minutes it stops waiting and lets the service start, so its log and status can be read.
set -u
fqdn=$(sed -n 's/^FQDN=//p' /etc/botkins-server/server.env 2>/dev/null | head -n 1)
[ -n "$fqdn" ] || exit 0
tries=0
until curl -fsS -o /dev/null --max-time 5 "https://$fqdn/v1/health"; do
  tries=$((tries + 1))
  if [ "$tries" -ge 120 ]; then
    echo "wait-for-relay: https://$fqdn/v1/health did not answer in 10 minutes. Starting without it." >&2
    exit 0
  fi
  sleep 5
done
