import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findPathCandidates } from "../desktop/path-detector.mjs";
import { findPathSpans } from "../desktop/path-detector.mjs";

const fixtures = JSON.parse(readFileSync(new URL("../docs/path-detection.json", import.meta.url), "utf8"));

test("desktop detector matches the shared phone fixtures", () => {
  for (const fixture of fixtures.cases) {
    const actual = findPathSpans(fixture.text).map((span) => ({ text: fixture.text.slice(span.start, span.end), path: span.path, ...(span.media && { media: true }) }));
    assert.deepEqual(actual, fixture.links, fixture.name);
  }
});

test("chat path candidates include supported absolute and media forms", () => {
  assert.deepEqual(findPathCandidates("See /tmp/report.pdf and ~/Pictures/photo.png and MEDIA: /tmp/movie.mp4."), ["/tmp/report.pdf", "~/Pictures/photo.png", "/tmp/movie.mp4"]);
  assert.deepEqual(findPathCandidates("`/tmp/with space/report.pdf`"), ["/tmp/with space/report.pdf"]);
  assert.deepEqual(findPathCandidates("C:\\Users\\demo\\file.txt"), ["C:\\Users\\demo\\file.txt"]);
});

test("path candidates exclude URLs, ratios, relative and network paths, with whole-line code exceptions", () => {
  assert.deepEqual(findPathCandidates("https://example.com/a /tmp/a/b a/b 16/9 file:///tmp/a \\\\server\\share"), ["/tmp/a/b"]);
  assert.deepEqual(findPathCandidates("```\n/tmp/whole-line.txt\nsee /tmp/inside.txt\n```"), ["/tmp/whole-line.txt"]);
});
