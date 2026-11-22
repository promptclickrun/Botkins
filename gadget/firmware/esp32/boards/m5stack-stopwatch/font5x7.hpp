// Copyright (c) 2026 Hermes Gadget SDK contributors
// SPDX-License-Identifier: MIT
// Adapted from Hermes Gadget firmware/core/include/hg/font.hpp (the glyph lookup only).
#pragma once

namespace stopwatch::font {

constexpr int kGlyphWidth = 5;
constexpr int kGlyphHeight = 7;
/** Row-major glyph pixels for printable ASCII and Latin-1: 35 chars, '#' = on. Anything else draws as '?'. */
const char* glyph(char32_t code_point);

}  // namespace stopwatch::font
