// A small JSON value: enough to read what the computer sends a gadget and to write its calls.
// Text is UTF-8 throughout. A missing field reads as null, so lookups chain without checks:
// `part["bot"]["name"].str()` is "" when there is no bot.
#pragma once
#include <cstddef>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace botkins {

class Json {
 public:
  enum class Type { Null, Bool, Number, String, Array, Object };

  Json() = default;
  Json(bool value) : type_(Type::Bool), flag_(value) {}
  Json(double value) : type_(Type::Number), number_(value) {}
  Json(int value) : type_(Type::Number), number_(value) {}
  Json(long long value) : type_(Type::Number), number_((double)value) {}
  Json(size_t value) : type_(Type::Number), number_((double)value) {}
  Json(const char* value) : type_(Type::String), text_(value) {}
  Json(std::string value) : type_(Type::String), text_(std::move(value)) {}
  Json(std::string_view value) : type_(Type::String), text_(value) {}

  static Json object() { Json j; j.type_ = Type::Object; return j; }
  static Json array() { Json j; j.type_ = Type::Array; return j; }
  /** Adds or replaces a field of an object. Returns this, so calls chain. */
  Json& set(std::string_view key, Json value);
  Json& push(Json value);

  /** False when the text isn't one JSON value (nesting deeper than 32 is refused too). */
  static bool parse(std::string_view text, Json& out);
  std::string dump() const;

  Type type() const { return type_; }
  bool is_null() const { return type_ == Type::Null; }
  bool is_object() const { return type_ == Type::Object; }
  bool is_array() const { return type_ == Type::Array; }
  bool is_string() const { return type_ == Type::String; }
  /** A value of another type reads as false, 0 and "". */
  bool truthy() const { return type_ == Type::Bool ? flag_ : type_ == Type::Number ? number_ != 0 : type_ == Type::String ? !text_.empty() : type_ != Type::Null; }
  double num() const { return type_ == Type::Number ? number_ : 0; }
  const std::string& str() const;
  /** Takes the text out of a string value, leaving it empty: for a long one (a second of samples) that is read once. */
  std::string take_str();

  size_t size() const { return type_ == Type::Array ? items_.size() : type_ == Type::Object ? fields_.size() : 0; }
  const Json& operator[](size_t index) const;
  const Json& operator[](std::string_view key) const;
  bool has(std::string_view key) const;
  /** Moves a field's value out of an object (null when it has none): for an answer that is read once. */
  Json take(std::string_view key);
  const std::vector<std::pair<std::string, Json>>& fields() const { return fields_; }
  const std::vector<Json>& items() const { return items_; }

 private:
  Type type_ = Type::Null;
  bool flag_ = false;
  double number_ = 0;
  std::string text_;
  std::vector<Json> items_;
  std::vector<std::pair<std::string, Json>> fields_;
  friend struct JsonReader;
};

/** How many UTF-16 code units a UTF-8 text is: the link counts a reply's text that way. */
size_t utf16_units(std::string_view utf8);

}  // namespace botkins
