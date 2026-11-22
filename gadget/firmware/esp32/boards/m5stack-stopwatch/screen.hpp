#pragma once
#include <cstdint>

#include "botkins/gadget.hpp"
#include "display.hpp"

namespace stopwatch {

/** Draws the whole view into a Display frame (466x466, byte-swapped RGB565). */
void draw_view(uint16_t* frame, const botkins::View& view);
/** "Botkins / Starting", before the gadget has a view. */
void draw_boot(uint16_t* frame);

}  // namespace stopwatch
