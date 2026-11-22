#!/bin/sh
# Waits until this server's relay answers over HTTPS, at the name in /etc/botkins-server/server.env.
# The Botkins service runs it before each start. systemd/botkins.service.d/50-azure.conf says why.
# After 9 minutes it stops waiting and lets the service start, so its log and status can be read.
# That is less than the unit's start timeout (11 minutes), so a slow wait never fails the start.
set -u
fqdn=$(sed -n 's/^FQDN=//p' /etc/botkins-server/server.env 2>/dev/null | head -n 1)
[ -n "$fqdn" ] || exit 0
end=$(($(date +%s) + 540))
until curl -fsS -o /dev/null --connect-timeout 3 --max-time 5 "https://$fqdn/v1/health"; do
  if [ "$(date +%s)" -ge "$end" ]; then
    echo "wait-for-relay: https://$fqdn/v1/health did not answer in 9 minutes. Starting without it." >&2
    exit 0
  fi
  sleep 3
done
