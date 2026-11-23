// UTF-8 for the screen: one character at a time, with what can't be drawn left out.
#pragma once
#include <cstdint>

namespace botkins {
namespace utf8 {

constexpr uint32_t kSkip = 0xFFFFFFFFu;

/**
 * The character at `p`, moving `p` past it. Returns kSkip for a broken sequence, a control
 * character or an invisible one. Tabs, line breaks and the narrow and no-break spaces read as a space.
 */
inline uint32_t next(const char*& p, const char* end) {
  const unsigned char c = (unsigned char)*p;
  const int len = c < 0x80 ? 1 : c >= 0xF8 ? 0 : c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC2 ? 2 : 0;
  if (len == 0 || end - p < len) {
    p++;
    return kSkip;
  }
  uint32_t cp = len == 1 ? c : len == 2 ? c & 0x1Fu : len == 3 ? c & 0x0Fu : c & 0x07u;
  for (int k = 1; k < len; k++) {
    const unsigned char cc = (unsigned char)p[k];
    if ((cc & 0xC0) != 0x80) {
      p++;
      return kSkip;
    }
    cp = (cp << 6) | (cc & 0x3Fu);
  }
  p += len;
  switch (cp) {
    case '\t': case '\n': case 0xA0: case 0x2007: case 0x2009: case 0x200A: case 0x202F: return ' ';
    case 0x200B: case 0x200C: case 0x200D: case 0x2060: case 0xFEFF: case 0xAD: return kSkip;
    default: break;
  }
  if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0) || (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xD800 && cp <= 0xDFFF)) return kSkip;
  return cp;
}

}  // namespace utf8
}  // namespace botkins
