#!/bin/sh
set -eu

umask 077
export DISPLAY="${DISPLAY:-:99}"
export HOME="${BOTKINS_WORKSPACE_HOME:-/var/lib/botkins-workspace/home}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/botkins-runtime}"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" \
  "$XDG_RUNTIME_DIR" "${BOTKINS_DATA_DIR:-/var/lib/botkins-workspace}" /run/botkins-workspace
chmod 0700 "$XDG_RUNTIME_DIR"
chmod 0770 /run/botkins-workspace

cleanup() {
  for pid in "$app_pid" "$wm_pid" "$xvfb_pid"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
}
xvfb_pid=
wm_pid=
app_pid=
trap cleanup INT TERM EXIT

# TCP is disabled and the display is confined to this container. The host sees the
# workspace only through BOTKINS_WORKSPACE_SOCKET on the shared runtime volume.
Xvfb "$DISPLAY" \
  -screen 0 "${BOTKINS_DISPLAY_GEOMETRY:-1920x1080x24}" \
  -nolisten tcp -ac -noreset >/tmp/botkins-xvfb.log 2>&1 &
xvfb_pid=$!

i=0
while ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "Xvfb did not become ready" >&2
    exit 70
  fi
  sleep 0.1
done

openbox --sm-disable >/tmp/botkins-openbox.log 2>&1 &
wm_pid=$!

# Use the normal Electron entry point with a virtual display. This intentionally does
# not use the host's process or filesystem and does not enable Electron's Node mode.
unset ELECTRON_RUN_AS_NODE
node scripts/start.cjs >/tmp/botkins-electron.log 2>&1 &
app_pid=$!
wait "$app_pid"
