// What one ESP32 board gives the shared port (main/). A board folder, boards/<name>/, is one
// ESP-IDF component that defines these functions; main/ does the rest (random, NVS, Wi-Fi, the
// USB console, threads) the same way for every board.
//
//   board::begin()           power, display, audio, buttons; before Wi-Fi starts
//   board::describe(board)   fills in the name, the rates, the screen and the speaker
//   board::run(gadget)       starts the board's own tasks: microphone, buttons, screen
#pragma once
#include "botkins/gadget.hpp"

namespace board {

/** Brings the board's hardware up. False when something the gadget can't do without failed. */
bool begin();
/** Fills in the board's part of `botkins::Board`: name, rates, screen, speaker. */
void describe(botkins::Board& out);
/** Starts the board's tasks once the gadget has begun. Draws whenever the view changes. */
void run(botkins::Gadget& gadget);
/** Asks for a redraw (cheap; safe from any task). `run` sets this as the gadget's on_change. */
void redraw();

}  // namespace board
