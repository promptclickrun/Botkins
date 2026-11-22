#!/bin/sh
# Builds the gadget for this computer (firmware/host): build/botkins-gadget-sim.
# CXX and CC name the compilers ("c++" and "cc" without them; `zig c++` and `zig cc` work too).
set -e
cd "$(dirname "$0")"
mkdir -p build
${CC:-cc} -c -O2 -std=c99 core/third_party/monocypher/monocypher.c -o build/monocypher.o
${CXX:-c++} -std=c++17 -O2 -Wall -Wextra -pthread -Icore/include -Icore/third_party/monocypher \
  core/src/crypto.cpp core/src/json.cpp core/src/link.cpp core/src/gadget.cpp core/src/sockets.cpp host/main.cpp build/monocypher.o \
  -o build/botkins-gadget-sim
echo build/botkins-gadget-sim
