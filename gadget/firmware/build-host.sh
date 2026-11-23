#!/bin/sh
# Builds the gadget for this computer (firmware/host): build/botkins-gadget-sim, and
# build/botkins-gadget-screens, which draws every screen to PNG files.
# CXX and CC name the compilers ("c++" and "cc" without them; `zig c++` and `zig cc` work too).
set -e
cd "$(dirname "$0")"
mkdir -p build
${CC:-cc} -c -O2 -std=c99 core/third_party/monocypher/monocypher.c -o build/monocypher.o
${CXX:-c++} -std=c++17 -O2 -Wall -Wextra -pthread -Icore/include -Icore/third_party/monocypher \
  core/src/crypto.cpp core/src/json.cpp core/src/link.cpp core/src/relay.cpp core/src/gadget.cpp core/src/sockets.cpp \
  host/main.cpp host/websocket.cpp build/monocypher.o \
  -o build/botkins-gadget-sim
echo build/botkins-gadget-sim

# The screen. The fonts reach it as a board's build embeds files: byte arrays in a generated source.
${CC:-cc} -O2 -std=c99 -Wall -Wextra host/embed.c -o build/embed
build/embed build/fonts.cpp botkins_serif core/fonts/DejaVuSerif-Bold.ttf botkins_sans core/fonts/OpenSans-Regular.ttf
${CXX:-c++} -std=c++17 -O2 -Wall -Wextra -Icore/include \
  core/src/draw.cpp core/src/faces.cpp core/src/home.cpp host/screens.cpp build/fonts.cpp \
  -o build/botkins-gadget-screens
echo build/botkins-gadget-screens
