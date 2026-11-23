#include "botkins/json.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>

namespace botkins {

static const Json kNull;
static const std::string kEmpty;

const std::string& Json::str() const { return type_ == Type::String ? text_ : kEmpty; }
std::string Json::take_str() {
  if (type_ != Type::String) return {};
  std::string out = std::move(text_);
  text_.clear();
  return out;
}
const Json& Json::operator[](size_t index) const { return type_ == Type::Array && index < items_.size() ? items_[index] : kNull; }
const Json& Json::operator[](std::string_view key) const {
  if (type_ == Type::Object)
    for (const auto& field : fields_)
      if (field.first == key) return field.second;
  return kNull;
}
bool Json::has(std::string_view key) const {
  if (type_ == Type::Object)
    for (const auto& field : fields_)
      if (field.first == key) return true;
  return false;
}
Json Json::take(std::string_view key) {
  if (type_ == Type::Object)
    for (auto& field : fields_)
      if (field.first == key) return std::move(field.second);
  return Json();
}
Json& Json::set(std::string_view key, Json value) {
  type_ = Type::Object;
  for (auto& field : fields_)
    if (field.first == key) {
      field.second = std::move(value);
      return *this;
    }
  fields_.emplace_back(std::string(key), std::move(value));
  return *this;
}
Json& Json::push(Json value) {
  type_ = Type::Array;
  items_.push_back(std::move(value));
  return *this;
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

static void put_utf8(std::string& out, uint32_t code) {
  if (code < 0x80) out += (char)code;
  else if (code < 0x800) { out += (char)(0xC0 | code >> 6); out += (char)(0x80 | (code & 0x3F)); }
  else if (code < 0x10000) { out += (char)(0xE0 | code >> 12); out += (char)(0x80 | ((code >> 6) & 0x3F)); out += (char)(0x80 | (code & 0x3F)); }
  else { out += (char)(0xF0 | code >> 18); out += (char)(0x80 | ((code >> 12) & 0x3F)); out += (char)(0x80 | ((code >> 6) & 0x3F)); out += (char)(0x80 | (code & 0x3F)); }
}

struct JsonReader {
  const char* at;
  const char* end;

  void space() { while (at < end && (*at == ' ' || *at == '\n' || *at == '\r' || *at == '\t')) at++; }
  bool word(const char* text) {
    const char* p = at;
    for (; *text; text++, p++) if (p >= end || *p != *text) return false;
    at = p;
    return true;
  }
  bool hex4(uint32_t& out) {
    if (end - at < 4) return false;
    out = 0;
    for (int i = 0; i < 4; i++) {
      char c = *at++;
      uint32_t v = c >= '0' && c <= '9' ? c - '0' : (c | 32) >= 'a' && (c | 32) <= 'f' ? (c | 32) - 'a' + 10 : 99;
      if (v == 99) return false;
      out = out << 4 | v;
    }
    return true;
  }
  bool string(std::string& out) {
    if (at >= end || *at != '"') return false;
    at++;
    // Most strings have no escapes: find the end first and copy once (a second of samples is 43,000 characters).
    const char* plain = at;
    while (plain < end && *plain != '"' && *plain != '\\') plain++;
    out.assign(at, plain);
    at = plain;
    while (at < end) {
      char c = *at++;
      if (c == '"') return true;
      if (c != '\\') { out += c; continue; }
      if (at >= end) return false;
      char e = *at++;
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          uint32_t code;
          if (!hex4(code)) return false;
          if (code >= 0xD800 && code <= 0xDBFF && end - at >= 6 && at[0] == '\\' && at[1] == 'u') {
            const char* back = at;
            at += 2;
            uint32_t low;
            if (hex4(low) && low >= 0xDC00 && low <= 0xDFFF) code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
            else at = back;
          }
          // Half of a pair on its own (a text cut between the two) shows as the replacement mark. It still counts as one unit.
          if (code >= 0xD800 && code <= 0xDFFF) code = 0xFFFD;
          put_utf8(out, code);
          break;
        }
        default: return false;
      }
    }
    return false;
  }
  bool value(Json& out, int depth) {
    if (depth > 32) return false;
    space();
    if (at >= end) return false;
    char c = *at;
    if (c == '{') {
      at++;
      out = Json::object();
      space();
      if (at < end && *at == '}') { at++; return true; }
      for (;;) {
        space();
        std::string key;
        if (!string(key)) return false;
        space();
        if (at >= end || *at++ != ':') return false;
        Json item;
        if (!value(item, depth + 1)) return false;
        out.fields_.emplace_back(std::move(key), std::move(item));
        space();
        if (at >= end) return false;
        if (*at == ',') { at++; continue; }
        if (*at == '}') { at++; return true; }
        return false;
      }
    }
    if (c == '[') {
      at++;
      out = Json::array();
      space();
      if (at < end && *at == ']') { at++; return true; }
      for (;;) {
        Json item;
        if (!value(item, depth + 1)) return false;
        out.items_.push_back(std::move(item));
        space();
        if (at >= end) return false;
        if (*at == ',') { at++; continue; }
        if (*at == ']') { at++; return true; }
        return false;
      }
    }
    if (c == '"') {
      out.type_ = Json::Type::String;
      return string(out.text_);
    }
    if (word("true")) { out = Json(true); return true; }
    if (word("false")) { out = Json(false); return true; }
    if (word("null")) { out = Json(); return true; }
    const char* start = at;
    if (at < end && *at == '-') at++;
    while (at < end && ((*at >= '0' && *at <= '9') || *at == '.' || *at == 'e' || *at == 'E' || *at == '+' || *at == '-')) at++;
    if (at == start) return false;
    std::string number(start, at);
    char* stop = nullptr;
    double parsed = strtod(number.c_str(), &stop);
    if (!stop || *stop) return false;
    out = Json(parsed);
    return true;
  }
};

bool Json::parse(std::string_view text, Json& out) {
  JsonReader reader{text.data(), text.data() + text.size()};
  Json parsed;
  if (!reader.value(parsed, 0)) return false;
  reader.space();
  if (reader.at != reader.end) return false;
  out = std::move(parsed);
  return true;
}

// ── Writing ─────────────────────────────────────────────────────────────────────────────────────

static void write_string(std::string& out, const std::string& text) {
  out += '"';
  for (unsigned char c : text) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char escape[8];
          snprintf(escape, sizeof escape, "\\u%04x", c);
          out += escape;
        } else out += (char)c;
    }
  }
  out += '"';
}

static void write(std::string& out, const Json& value) {
  switch (value.type()) {
    case Json::Type::Null: out += "null"; break;
    case Json::Type::Bool: out += value.truthy() ? "true" : "false"; break;
    case Json::Type::Number: {
      double n = value.num();
      char text[32];
      // Whole numbers (versions, offsets, sizes) are written without a point or an exponent.
      if (std::isfinite(n) && n == std::floor(n) && std::fabs(n) < 9.0e15) snprintf(text, sizeof text, "%lld", (long long)n);
      else if (std::isfinite(n)) snprintf(text, sizeof text, "%.17g", n);
      else snprintf(text, sizeof text, "null");
      out += text;
      break;
    }
    case Json::Type::String: write_string(out, value.str()); break;
    case Json::Type::Array: {
      out += '[';
      bool first = true;
      for (const Json& item : value.items()) {
        if (!first) out += ',';
        first = false;
        write(out, item);
      }
      out += ']';
      break;
    }
    case Json::Type::Object: {
      out += '{';
      bool first = true;
      for (const auto& field : value.fields()) {
        if (!first) out += ',';
        first = false;
        write_string(out, field.first);
        out += ':';
        write(out, field.second);
      }
      out += '}';
      break;
    }
  }
}

std::string Json::dump() const {
  std::string out;
  write(out, *this);
  return out;
}

size_t utf16_units(std::string_view utf8) {
  size_t units = 0;
  for (unsigned char c : utf8) {
    if ((c & 0xC0) == 0x80) continue;  // a continuation byte
    units += c >= 0xF0 ? 2 : 1;        // a four-byte character is a pair
  }
  return units;
}

}  // namespace botkins
