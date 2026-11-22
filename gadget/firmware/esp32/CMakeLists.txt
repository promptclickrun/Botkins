# The Botkins gadget for ESP32 boards. One project for every board: `main/` and
# `components/` are what every ESP32 board shares, `boards/<name>/` is one board
# (its pins, power chips, codec, display, buttons and screen).
#
#   . ~/esp/esp-idf/export.sh
#   idf.py set-target esp32s3            # once
#   idf.py build                         # BOARD defaults to m5stack-stopwatch
#   idf.py -DBOARD=<name> build          # another board (a fresh build folder: -B build-<name>)
#   idf.py -p /dev/cu.usbmodemXXXX flash monitor
cmake_minimum_required(VERSION 3.22)

if(NOT DEFINED BOARD)
  set(BOARD "m5stack-stopwatch")
endif()
set(BOARD "${BOARD}" CACHE STRING "The board folder under boards/")
if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/boards/${BOARD}/CMakeLists.txt")
  message(FATAL_ERROR "No board named '${BOARD}' (boards/${BOARD}/CMakeLists.txt is missing)")
endif()

# Shared defaults first, then the board's own.
set(SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults;${CMAKE_CURRENT_LIST_DIR}/boards/${BOARD}/sdkconfig.defaults")
# The board is one component, linked whole: main calls into it through components/gadget_port.
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/boards/${BOARD}")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(botkins_gadget)
