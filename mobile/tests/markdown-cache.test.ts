import assert from "node:assert/strict";
import { test } from "node:test";
import { Marked, type Token } from "marked";
import { parseStreamingMarkdown } from "../src/ui/markdownCache";

const marked = new Marked({ gfm: true, breaks: true });

test("streaming Markdown lexes only the uncertain tail and retains sealed token identity", () => {
  const sealed = Array.from({ length: 40 }, (_, index) => `Paragraph ${index}.`).join("\n\n");
  const firstText = sealed + "\n\nTail";
  const calls: string[] = [];
  const lex = (source: string) => {
    calls.push(source);
    return marked.lexer(source) as Token[];
  };
  const first = parseStreamingMarkdown(firstText, lex);
  const before = calls.length;
  const nextText = firstText + " grows";
  const next = parseStreamingMarkdown(nextText, lex, first.cache);
  const tailInput = calls[calls.length - 1]!;
  assert.equal(before, 1);
  assert.ok(tailInput.length < nextText.length / 4, `tail lexer input ${tailInput.length} of ${nextText.length}`);
  assert.equal(next.tokens[0], first.tokens[0], "sealed marked token is retained");
  assert.deepEqual(next.tokens, marked.lexer(nextText) as Token[]);
});

test("reference definitions use an exact full parse because they can change earlier links", () => {
  const calls: string[] = [];
  const lex = (source: string) => {
    calls.push(source);
    return marked.lexer(source) as Token[];
  };
  const text = "[label][id]\n\n[id]: https://example.com\n\nTail";
  const parsed = parseStreamingMarkdown(text, lex);
  assert.equal(calls.at(-1), text);
  assert.deepEqual(parsed.tokens, marked.lexer(text) as Token[]);
});

test("delayed footnotes, lists, and fences match marked's exact tokenization", () => {
  const cases = [
    "A[^one]\n\n[^one]: note text\n\nTail",
    "- one\n- two\n\nnext",
    "```js\nconst value = 1\n```\n\nnext",
  ];
  for (const text of cases) {
    const parsed = parseStreamingMarkdown(text, (source) => marked.lexer(source) as Token[], undefined, text.includes("[^"));
    assert.deepEqual(parsed.tokens, marked.lexer(text) as Token[], text);
  }
});

test("a list or fence that grows in the tail is replaced by marked's exact result", () => {
  for (const [firstText, nextText] of [
    ["Intro\n\n- one", "Intro\n\n- one\n- two\n\nNext"],
    ["Intro\n\n```js\nconst value = 1", "Intro\n\n```js\nconst value = 1\n```\n\nNext"],
  ]) {
    const first = parseStreamingMarkdown(firstText, (source) => marked.lexer(source) as Token[]);
    const next = parseStreamingMarkdown(nextText, (source) => marked.lexer(source) as Token[], first.cache);
    assert.deepEqual(next.tokens, marked.lexer(nextText) as Token[], nextText);
  }
});

test("a trailing blank line does not seal a loose list, and CRLF uses the exact path", () => {
  const lex = (source: string) => marked.lexer(source) as Token[];
  const first = parseStreamingMarkdown("Intro\n\n1. a\n\n", lex);
  const nextText = "Intro\n\n1. a\n\n   continuation\n2. b";
  const next = parseStreamingMarkdown(nextText, lex, first.cache);
  assert.deepEqual(next.tokens, marked.lexer(nextText) as Token[]);

  const crlf = "First\r\n\r\nSecond\r\n\r\nTail";
  const parsed = parseStreamingMarkdown(crlf, lex);
  assert.deepEqual(parsed.tokens, marked.lexer(crlf) as Token[]);
});

test("ordinary links and code may be cached without rereading completed tokens on an append", () => {
  const lex = (source: string) => marked.lexer(source) as Token[];
  const firstText = "See [docs](/guide) and use array[0].\n\n" + "Complete.\n\n".repeat(40) + "Last";
  const first = parseStreamingMarkdown(firstText, lex);
  const block = first.tokens[0]!;
  const raw = block.raw;
  let reads = 0;
  Object.defineProperty(block, "raw", { enumerable: true, get() { reads++; return raw; } });
  const next = parseStreamingMarkdown(firstText + " grows", lex, first.cache);
  assert.equal(next.tokens[0], block);
  assert.equal(reads, 0, "only the unsealed tail needs its boundaries checked again");

  const withDefinition = "See [docs].\n\nComplete.\n\nLast";
  const before = parseStreamingMarkdown(withDefinition, lex);
  const replaced = withDefinition + "\n\n[docs]: /new";
  const after = parseStreamingMarkdown(replaced, lex, before.cache);
  assert.notEqual(after.tokens[0], before.tokens[0]);
  assert.deepEqual(after.tokens, lex(replaced));
});

test("inline ]: in TypeScript or code snippets does not defeat streaming cache", () => {
  const calls: string[] = [];
  const lex = (source: string) => {
    calls.push(source);
    return marked.lexer(source) as Token[];
  };
  const body = "```ts\ntype Dict = { [k: string]: number };\n```\n\n" + "Paragraph.\n\n".repeat(20) + "Tail";
  const first = parseStreamingMarkdown(body, lex);
  const nextText = body + " grows";
  const next = parseStreamingMarkdown(nextText, lex, first.cache);
  assert.equal(next.tokens[0], first.tokens[0], "sealed code block containing ]: is retained");
  assert.ok(calls.at(-1)!.length < nextText.length / 2, "only tail is re-lexed");
  assert.deepEqual(next.tokens, marked.lexer(nextText) as Token[]);
});

test("a reference definition inside a quote or a list forces a full lex, so earlier [a] becomes a link", () => {
  const lex = (source: string) => marked.lexer(source) as Token[];
  const body = "See [a] here.\n\nSecond paragraph.\n\nThird paragraph.\n\n";
  for (const tail of ["> [a]: http://x", "- [a]: http://x", "  > [a]: http://x"]) {
    const first = parseStreamingMarkdown(body + "Fourth", lex);
    const next = parseStreamingMarkdown(body + tail, lex, first.cache);
    assert.deepEqual(next.tokens, lex(body + tail), `cached parse should match a full lex for ${JSON.stringify(tail)}`);
  }
});
