// "@Name" tags in a chat's messages (mentionTags.ts): which words become a tag, drawn at display
// time from the chat's people and bots. Longest name first, any case, whole words only, never in code,
// and a name nobody in the chat has stays plain.
import assert from "node:assert/strict";
import { test } from "node:test";
import { codeRanges, type MentionTarget, mentionMatcher, mentionPieces } from "../src/features/chat/mentionTags";

const people: MentionTarget[] = [
  { kind: "person", id: "owner", name: "Alex" },
  { kind: "person", id: "m_ana", name: "Ana" },
  { kind: "person", id: "m_analee", name: "Ana Lee" },
  { kind: "bot", id: "bot-mira", name: "Mira" },
];
const matcher = mentionMatcher(people);
const tagged = (text: string) => matcher.find(text).map((span) => text.slice(span.start, span.end) + "=" + span.target.id);

test("the longest name wins, so @Ana Lee is not @Ana", () => {
  assert.deepEqual(tagged("Thanks @Ana Lee and @Ana!"), ["@Ana Lee=m_analee", "@Ana=m_ana"]);
  // Two people with names that start alike, in either order.
  assert.deepEqual(mentionMatcher([...people].reverse()).find("@Ana Lee").map((span) => span.target.id), ["m_analee"]);
});

test("names match in any case, and the text keeps its own case", () => {
  assert.deepEqual(tagged("hey @ana and @MIRA"), ["@ana=m_ana", "@MIRA=bot-mira"]);
});

test("only whole words: a longer word, an email address or a name inside a word stays plain", () => {
  assert.deepEqual(tagged("@Anabel wrote to alex@Ana.com about @Alexander"), []);
  // Punctuation and possessives end a name.
  assert.deepEqual(tagged("(@Alex), @Mira's draft, @Ana."), ["@Alex=owner", "@Mira=bot-mira", "@Ana=m_ana"]);
});

test("a name nobody in the chat has stays plain, and so does a bare @", () => {
  assert.deepEqual(tagged("@Sam and @ and @everyone"), []);
  assert.deepEqual(mentionMatcher([]).find("@Ana"), []);
});

test("code spans and fenced blocks are left alone", () => {
  assert.deepEqual(tagged("Run `@Ana` then ask @Ana"), ["@Ana=m_ana"]);
  assert.deepEqual(tagged("``@Mira `x` ``, @Mira"), ["@Mira=bot-mira"]);
  assert.deepEqual(tagged("Before @Alex\n```\nping @Ana\n```\nafter @Mira"), ["@Alex=owner", "@Mira=bot-mira"]);
  // A fence still open (a reply being written) holds code to the end.
  assert.deepEqual(tagged("@Alex\n~~~\n@Ana"), ["@Alex=owner"]);
  // An unmatched backtick is not code.
  assert.deepEqual(tagged("a ` then @Ana"), ["@Ana=m_ana"]);
  assert.deepEqual(codeRanges("no code here"), []);
});

test("pieces cut a text into plain parts and tags, in order, losing nothing", () => {
  const text = "Hi @ana, meet @Mira.";
  const pieces = mentionPieces(text, matcher);
  assert.equal(pieces.map((piece) => piece.text).join(""), text);
  assert.deepEqual(pieces.map((piece) => piece.target?.id ?? null), [null, "m_ana", null, "bot-mira", null]);
  assert.deepEqual(mentionPieces("plain", matcher), [{ text: "plain" }]);
  assert.deepEqual(mentionPieces("@Ana", undefined), [{ text: "@Ana" }]);
});

test("each text is tokenized once; the same people give the same key; duplicate or empty names are dropped", () => {
  const text = "@Ana and @Mira";
  assert.equal(matcher.find(text), matcher.find(text));
  assert.equal(mentionMatcher(people).key, matcher.key);
  assert.notEqual(mentionMatcher(people.slice(1)).key, matcher.key);
  const doubled = mentionMatcher([{ kind: "person", id: "a", name: "Sam" }, { kind: "bot", id: "b", name: "sam" }, { kind: "person", id: "c", name: "  " }]);
  assert.deepEqual(doubled.find("@SAM").map((span) => span.target.id), ["a"]);
});
