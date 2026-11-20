#!/bin/sh
# Installs the Botkins terminal host: Botkins as a service on a computer with no screen,
# set up and run from a terminal. The guide is desktop/docs/terminal.md.
#
#   curl -fsSL https://github.com/promptclickrun/Botkins/releases/latest/download/install.sh | sudo sh
#
# As root it installs for the whole computer: the program in /opt/botkins, the command
# /usr/local/bin/botkins, a user `botkins` that the service runs as, its data in /var/lib/botkins,
# and a systemd unit (Linux) or launchd job (macOS) that starts it with the computer.
# Without root, or with --user, it installs for you alone, under your home folder.
#
# What it downloads is checked before any of it is used: the tarball's SHA-256 must be the one
# in the release's SHA256SUMS, and SHA256SUMS must carry a good signature from the Botkins
# release key, whose fingerprint is written below. Nothing is installed when a check fails.
#
# Options (after `sh -s --` when piped):
#   --user                 install for this user only, without root
#   --version <x.y.z>      install this release instead of the latest
#   --no-service           install the program, and leave the service to `botkins service install`
#   --no-start             install the service without starting it
#   --run-as <user>        macOS, whole computer: the user the service runs as (default: who ran sudo)
#   --bundle-node          download Node.js for Botkins alone even when the computer has a new enough one
#   --checksum-only        skip the signature check when GnuPG is not installed (the checksum is still checked)
#   --release-url <url>    take the release from a mirror: <url>/v<version>/<file>
#   --release-fingerprint <fpr>   trust this release key instead of Botkins' own (for a mirror you sign yourself)
set -eu

REPO="promptclickrun/Botkins"
FINGERPRINT="366DD24D230E9F6BAE3EDE0AEB0AB1B21A7BAA7E"
NODE_MAJOR=24

scope=""
version=""
service=1
start=1
run_as=""
bundle_node=0
checksum_only=0
release_url=""
fingerprint=$FINGERPRINT

say() { printf '%s\n' "$*"; }
fail() { printf 'install: %s\n' "$*" >&2; exit 1; }
need_value() { [ $# -ge 2 ] || fail "$1 needs a value."; }

while [ $# -gt 0 ]; do
  case $1 in
    --user) scope=user ;;
    --system) scope=system ;;
    --version) need_value "$@"; version=${2#v}; shift ;;
    --no-service) service=0 ;;
    --no-start) start=0 ;;
    --run-as) need_value "$@"; run_as=$2; shift ;;
    --bundle-node) bundle_node=1 ;;
    --checksum-only) checksum_only=1 ;;
    --release-url) need_value "$@"; release_url=${2%/}; shift ;;
    --release-fingerprint) need_value "$@"; fingerprint=$(printf '%s' "$2" | tr -d ' ' | tr 'abcdef' 'ABCDEF'); shift ;;
    -h|--help) sed -n '2,27p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "Unknown option $1. See --help." ;;
  esac
  shift
done

# ── This computer ──────────────────────────────────────────────────────────────────────────────

case $(uname -s) in
  Linux) system=linux ;;
  Darwin) system=macos ;;
  *) fail "Botkins runs as a service on Linux and macOS. This is $(uname -s)." ;;
esac
case $(uname -m) in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail "There is no Botkins build for $(uname -m)." ;;
esac
uid=$(id -u)
if [ -z "$scope" ]; then
  if [ "$uid" -eq 0 ]; then scope=system; else scope=user; fi
fi
[ "$scope" = user ] || [ "$uid" -eq 0 ] || fail "Installing for the whole computer needs root: run it with sudo, or add --user to install for yourself."
if [ "$scope" = system ]; then
  prefix=/opt/botkins
  bin_dir=/usr/local/bin
else
  prefix=${XDG_DATA_HOME:-$HOME/.local/share}/botkins-terminal
  bin_dir=$HOME/.local/bin
fi

# The first folder, from the one given upwards, that is not root's own or that somebody other
# than root can write to; nothing when every one of them is root's alone. The updater asks the
# same before it installs a new version (desktop/terminal/update-install.mjs, notRootOwned),
# and refuses: whoever can write to one of these folders can put their own program where root is
# about to run it. So an install into such a folder would be one that can never be updated.
not_roots_own() {
  dir=$1
  # The folder may not be there yet: the look starts at the nearest one that is.
  while [ ! -d "$dir" ]; do dir=$(dirname "$dir"); done
  # A folder that can't be entered can't be looked at: it is the one named.
  dir=$(cd "$dir" 2>/dev/null && pwd -P) || { printf '%s\n' "$1"; return 0; }
  while :; do
    line=$(ls -ldn "$dir" 2>/dev/null) || { printf '%s\n' "$dir"; return 0; }
    case ${line%% *} in
      ?????w*|????????w*) printf '%s\n' "$dir"; return 0 ;;
    esac
    if [ "$(printf '%s\n' "$line" | awk '{ print $3 }')" != 0 ]; then printf '%s\n' "$dir"; return 0; fi
    if [ "$dir" = / ]; then return 0; fi
    dir=$(dirname "$dir")
  done
}
if [ "$scope" = system ]; then
  unsafe=$(not_roots_own "$prefix")
  [ -z "$unsafe" ] || fail "The folder $unsafe does not belong to root alone ($(ls -ldn "$unsafe" 2>/dev/null | awk '{ print $1 ", owner " $3 }')). Botkins for the whole computer is installed into $prefix, and it is updated only where that folder and every folder above it are root's own. Nothing was installed. Put it right, then run this again:
  sudo chown root '$unsafe' && sudo chmod go-w '$unsafe'"
fi

# latest_from_page <url> prints where the page sends its reader on, without going there.
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --proto '=https,http' --retry 3 -o "$2" "$1"; }
  latest_from_page() { curl -sI --proto '=https' --retry 3 -o /dev/null -w '%{redirect_url}\n' "$1" 2>/dev/null || true; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
  latest_from_page() { wget --max-redirect=0 --spider -S "$1" 2>&1 | sed -n 's/^[[:space:]]*[Ll]ocation:[[:space:]]*//p' | tr -d '\r' | head -n 1; }
else
  fail "curl or wget is needed to download Botkins."
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum or shasum is needed to check the download."
fi
command -v tar >/dev/null 2>&1 || fail "tar is needed to unpack Botkins."

work=$(mktemp -d "${TMPDIR:-/tmp}/botkins-install.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM
chmod 700 "$work"

# ── Which release ──────────────────────────────────────────────────────────────────────────────

if [ -z "$version" ]; then
  [ -z "$release_url" ] || fail "With --release-url, say which release to install with --version."
  # The release page leads to the latest release. GitHub's API would say it too, but it answers
  # an address that is not signed in only 60 times an hour, counted for everyone behind that
  # address, so a server in a cloud can be refused through no fault of its own. It is the second try.
  version=$(latest_from_page "https://github.com/$REPO/releases/latest" | sed -n 's|.*/releases/tag/v\([0-9][0-9.]*\)[[:space:]]*$|\1|p' | head -n 1)
  if [ -z "$version" ]; then
    fetch "https://api.github.com/repos/$REPO/releases/latest" "$work/latest.json" || fail "GitHub didn't say which Botkins release is the latest. Try again later, or name one: --version <version>."
    version=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([0-9][0-9.]*\)".*/\1/p' "$work/latest.json" | head -n 1)
  fi
  [ -n "$version" ] || fail "GitHub didn't name the latest Botkins release. Try again later, or name one: --version <version>."
fi
printf '%s' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || fail "$version is not a release version (such as 0.17.0)."
base=${release_url:-https://github.com/$REPO/releases/download}/v$version
name=botkins-terminal-$version-$system-$arch
archive=$name.tar.gz

say "Installing Botkins $version for $system/$arch ($scope install, into $prefix)."

# ── Download and check ─────────────────────────────────────────────────────────────────────────

for file in "$archive" SHA256SUMS; do
  fetch "$base/$file" "$work/$file" || fail "$file couldn't be downloaded from $base. Does this release have a terminal host build for $system/$arch?"
done

if [ "$checksum_only" -eq 1 ]; then
  say "Skipping the signature check, as asked. The checksum is still checked."
else
  command -v gpg >/dev/null 2>&1 && command -v gpgv >/dev/null 2>&1 || fail "GnuPG is needed to check the release's signature. Install it (Debian and Ubuntu: apt-get install -y gnupg; macOS: brew install gnupg) and run this again, or pass --checksum-only to rely on the checksum alone."
  for file in SHA256SUMS.asc botkins-release.asc; do
    fetch "$base/$file" "$work/$file" || fail "$file couldn't be downloaded from $base."
  done
  [ "$fingerprint" = "$FINGERPRINT" ] || say "Note: trusting the release key $fingerprint, not Botkins' own, because --release-fingerprint asked for it."
  mkdir -m 700 "$work/gnupg"
  # The key that came with the release only counts when it is the one whose fingerprint is known beforehand.
  found=$(gpg --batch --homedir "$work/gnupg" --show-keys --with-colons "$work/botkins-release.asc" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
  [ "$found" = "$fingerprint" ] || fail "The release key is not the expected one (its fingerprint is ${found:-unreadable}, not $fingerprint). Nothing was installed."
  gpg --batch --yes --homedir "$work/gnupg" --dearmor --output "$work/release.gpg" "$work/botkins-release.asc" 2>/dev/null || fail "The release key couldn't be read."
  gpgv --homedir "$work/gnupg" --status-fd 1 --keyring "$work/release.gpg" "$work/SHA256SUMS.asc" "$work/SHA256SUMS" > "$work/gpgv.out" 2>/dev/null || fail "SHA256SUMS does not carry a good signature from the release key. Nothing was installed."
  grep -q "^\[GNUPG:\] VALIDSIG $fingerprint " "$work/gpgv.out" || fail "SHA256SUMS was not signed by the release key. Nothing was installed."
  say "The release's signature is good."
fi
wanted=$(awk -v file="$archive" '$2 == file { print $1 }' "$work/SHA256SUMS")
[ -n "$wanted" ] && [ "$(printf '%s\n' "$wanted" | wc -l | tr -d ' ')" = 1 ] || fail "SHA256SUMS doesn't list $archive exactly once. Nothing was installed."
[ "$(sha256 "$work/$archive")" = "$wanted" ] || fail "$archive doesn't match its checksum. Nothing was installed."
say "The download matches its checksum."

# Everything in the tarball is inside its one folder.
if tar -tzf "$work/$archive" | awk -F/ -v top="$name" '$1 != top { bad = 1 } /(^|\/)\.\.(\/|$)/ { bad = 1 } END { exit bad ? 0 : 1 }'; then
  fail "$archive holds files outside its own folder. Nothing was installed."
fi

# ── Node.js ────────────────────────────────────────────────────────────────────────────────────

node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]; }
mkdir -p "$prefix"
if [ "$bundle_node" -eq 0 ] && node_ok; then
  say "Using this computer's Node.js $(node -p process.versions.node)."
elif [ "$bundle_node" -eq 0 ] && [ -x "$prefix/node/bin/node" ] && [ "$("$prefix/node/bin/node" -p 'Number(process.versions.node.split(".")[0])')" -ge "$NODE_MAJOR" ]; then
  say "Using the Node.js already installed for Botkins ($("$prefix/node/bin/node" -p process.versions.node))."
else
  # Node.js $NODE_MAJOR for Botkins alone, from nodejs.org, checked against the checksums published there.
  node_system=$system
  [ "$system" = macos ] && node_system=darwin
  node_base=https://nodejs.org/dist/latest-v$NODE_MAJOR.x
  fetch "$node_base/SHASUMS256.txt" "$work/node-sums" || fail "Node.js couldn't be found at nodejs.org. Install Node.js $NODE_MAJOR yourself and run this again."
  node_file=$(awk -v suffix="-$node_system-$arch.tar.gz" 'index($2, suffix) == length($2) - length(suffix) + 1 { print $2; exit }' "$work/node-sums")
  [ -n "$node_file" ] || fail "nodejs.org has no Node.js $NODE_MAJOR for $node_system/$arch."
  say "Downloading ${node_file%.tar.gz} for Botkins alone (this computer has no Node.js $NODE_MAJOR)."
  fetch "$node_base/$node_file" "$work/$node_file" || fail "Node.js couldn't be downloaded."
  [ "$(sha256 "$work/$node_file")" = "$(awk -v file="$node_file" '$2 == file { print $1 }' "$work/node-sums")" ] || fail "The Node.js download doesn't match its checksum."
  rm -rf "$prefix/node.new"
  mkdir -p "$prefix/node.new"
  tar -xzf "$work/$node_file" -C "$prefix/node.new" --strip-components 1 --no-same-owner
  rm -rf "$prefix/node"
  mv "$prefix/node.new" "$prefix/node"
fi

# ── Install ────────────────────────────────────────────────────────────────────────────────────

if [ -e "$prefix/$name" ]; then
  say "Botkins $version is already unpacked in $prefix/$name: using it."
else
  rm -rf "$prefix/.install"
  mkdir -p "$prefix/.install"
  tar -xzf "$work/$archive" -C "$prefix/.install" --no-same-owner
  mv "$prefix/.install/$name" "$prefix/$name"
  rm -rf "$prefix/.install"
fi
[ -x "$prefix/$name/bin/botkins" ] || fail "The release is missing its launcher. Nothing was changed."
# `current` names the version in use. (-n: replace the link itself, never write inside what it points at.)
ln -sfn "$name" "$prefix/current"
if [ "$scope" = system ]; then
  # Root's own, and nobody else's to change: the service runs this code, and the updater checks it.
  chown -R 0:0 "$prefix/$name" 2>/dev/null || true
  chmod -R go-w "$prefix" 2>/dev/null || true
fi
mkdir -p "$bin_dir"
ln -sf "$prefix/current/bin/botkins" "$bin_dir/botkins"
say "Installed $("$bin_dir/botkins" --version 2>/dev/null || echo "$version") as $bin_dir/botkins."

# ── The service ────────────────────────────────────────────────────────────────────────────────

if [ "$service" -eq 1 ]; then
  set -- service install "--$scope"
  [ "$start" -eq 1 ] || set -- "$@" --no-start
  if [ "$scope" = system ] && [ "$system" = macos ]; then
    set -- "$@" --run-as "${run_as:-${SUDO_USER:-}}"
  elif [ -n "$run_as" ]; then
    set -- "$@" --run-as "$run_as"
  fi
  BOTKINS_INSTALLER=1 "$bin_dir/botkins" "$@" || fail "Botkins is installed, and its service couldn't be set up. Run \`botkins service install\` to try again, or \`botkins serve\` to run it in this terminal."
else
  say "The service was not set up. Run \`botkins service install\` when you want it to start with the computer."
fi

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) say "Note: $bin_dir is not on your PATH. Add it, or call $bin_dir/botkins by its whole name." ;;
esac
if [ "$scope" = system ]; then run="sudo botkins"; else run="botkins"; fi
say ""
say "Next:"
say "  $run doctor                       check this computer"
say "  $run providers login <provider>   sign a model provider in (see: $run providers list)"
say "  $run bots add \"My bot\"            make a bot"
say "  $run pair                         show the code a phone pairs with"
