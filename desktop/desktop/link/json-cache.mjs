// Keeps the JSON of records that did not change, so a following phone does not make the computer
// write a long turn's steps again every few tens of milliseconds while a reply streams.
//
// The app changes its state in place (`run.steps.push(...)`, `step.status = "Done"`), so a record's
// identity says nothing about whether it changed. A record is therefore remembered by what it
// held: the same keys in the same order with equal values, compared one by one. That is exact for
// a flat record (every value a string, number, boolean or null), which is what a step and a
// message nearly always are. A record with a nested object or array is never remembered: it is
// copied and written afresh each time, as before. Nothing here changes the bytes a phone gets.

/** A copy made by `interned`, to its JSON text; null until the text is first written. */
const texts = new WeakMap();
/** A source record, to the values it held and the copy made from them. */
const records = new WeakMap();

const primitive = (value) => value === null || (typeof value !== "object" && typeof value !== "function");

/** Whether `record` still holds exactly what was seen: the same keys in the same order, with equal values. */
function unchanged(seen, record) {
  const { keys, values } = seen;
  let at = 0;
  for (const key in record) {
    if (at >= keys.length || keys[at] !== key || record[key] !== values[at]) return false;
    at++;
  }
  return at === keys.length;
}

/**
 * `make(record)` for a plain record, and the very same copy again for as long as the record's own
 * values stay equal. The copy is never changed by anyone, and its JSON is written once (`jsonOf`).
 * `make` must build a new object from the record alone.
 */
export function interned(record, make) {
  if (record === null || typeof record !== "object" || Object.getPrototypeOf(record) !== Object.prototype) return make(record);
  const seen = records.get(record);
  if (seen && unchanged(seen, record)) return seen.copy;
  const copy = make(record);
  if (copy === record || copy === null || typeof copy !== "object") return copy;
  const keys = Object.keys(record);
  const values = keys.map((key) => record[key]);
  if (!values.every(primitive)) {
    records.delete(record);
    return copy;
  }
  records.set(record, { keys, values, copy });
  texts.set(copy, null);
  return copy;
}

/** Text being written as fragments: runs of small text, and between them each cached copy's text as the one string it is. */
class Fragments {
  out = [];
  pending = "";
  add(text) {
    this.pending += text;
  }
  cached(text) {
    if (this.pending) this.out.push(this.pending);
    this.pending = "";
    this.out.push(text);
  }
  done() {
    if (this.pending) this.out.push(this.pending);
    this.pending = "";
    return this.out;
  }
}

/** Whether `value` has no JSON of its own: `JSON.stringify` skips it in an object and writes null for it in an array. */
const nothing = (value) => value === undefined || typeof value === "function" || typeof value === "symbol";

function write(into, value) {
  if (value === null || typeof value !== "object") {
    into.add(JSON.stringify(value));
    return;
  }
  const known = texts.get(value);
  if (known) return into.cached(known);
  if (known === null) {
    const text = JSON.stringify(value);
    texts.set(value, text);
    return into.cached(text);
  }
  if (typeof value.toJSON === "function") return into.add(JSON.stringify(value));
  if (Array.isArray(value)) {
    into.add("[");
    for (let i = 0; i < value.length; i++) {
      if (i) into.add(",");
      if (nothing(value[i])) into.add("null");
      else write(into, value[i]);
    }
    return into.add("]");
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return into.add(JSON.stringify(value));
  into.add("{");
  let first = true;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (nothing(item)) continue;
    // An object whose own JSON may be nothing (a `toJSON` that answers undefined) is written by JSON.stringify, to know.
    if (item !== null && typeof item === "object" && typeof item.toJSON === "function") {
      const text = JSON.stringify(item);
      if (text === undefined) continue;
      into.add((first ? "" : ",") + JSON.stringify(key) + ":" + text);
    } else {
      into.add((first ? "" : ",") + JSON.stringify(key) + ":");
      write(into, item);
    }
    first = false;
  }
  into.add("}");
}

/**
 * `JSON.stringify(value)`, byte for byte, as fragments: a copy made by `interned` is one fragment
 * (written once, the same string every time), so two writes of the same part with nothing changed
 * have fragments that are equal one by one (`sameFragments`) and need never be joined to be compared.
 * Not for `undefined` or a function, which have no JSON.
 */
export function jsonFragments(value) {
  const into = new Fragments();
  write(into, value);
  return into.done();
}

/** Whether two writes came out as the same text, without joining them. */
export function sameFragments(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** `JSON.stringify(value)`, byte for byte, with each copy made by `interned` written once. */
export function jsonOf(value) {
  return nothing(value) ? undefined : jsonFragments(value).join("");
}
