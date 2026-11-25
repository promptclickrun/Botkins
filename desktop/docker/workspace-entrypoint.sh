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

# The display must be this container's own: if something already answers on $DISPLAY, stop
# rather than draw on (or brand) a display Botkins did not start.
if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  echo "Display $DISPLAY is already in use. The workspace starts its own; set DISPLAY to a free one." >&2
  exit 70
fi

# TCP is disabled and the display is confined to this container. The host sees the
# workspace only through BOTKINS_WORKSPACE_SOCKET on the shared runtime volume.
Xvfb "$DISPLAY" \
  -screen 0 "${BOTKINS_DISPLAY_GEOMETRY:-1920x1080x24}" \
  -nolisten tcp -ac -noreset >/tmp/botkins-xvfb.log 2>&1 &
xvfb_pid=$!

# Ready means this Xvfb is still running and answering: another server that came up on the
# same display would answer too, so a dead Xvfb is a failure even if the display answers.
i=0
while ! { kill -0 "$xvfb_pid" 2>/dev/null && xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; }; do
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    echo "Xvfb stopped before the display was ready" >&2
    exit 70
  fi
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "Xvfb did not become ready" >&2
    exit 70
  fi
  sleep 0.1
done

if ! kill -0 "$xvfb_pid" 2>/dev/null; then
  echo "Xvfb stopped before the desktop could start" >&2
  exit 70
fi

# This container started the display above, so it gets the Botkins desktop: the kit's background,
# and Openbox with the Botkins theme and menu (restarted if it stops). See docker/desktop.
export BOTKINS_WORKSPACE_APP_DIR="$(pwd -P)"
BOTKINS_DESKTOP_MANAGED=1 /usr/local/share/botkins-desktop/botkins-desktop >/tmp/botkins-openbox.log 2>&1 &
wm_pid=$!

# Keep the workspace running behind its desktop. Open Botkins in the menu shows its window.
unset ELECTRON_RUN_AS_NODE
node scripts/start.cjs --hidden >/tmp/botkins-electron.log 2>&1 &
app_pid=$!
wait "$app_pid"
