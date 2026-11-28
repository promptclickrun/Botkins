// Plain logic for the native iOS Share Extension handoff (src/features/open/share.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSharedMessage, parseSharedPayload } from "../src/features/open/share";

test("parseSharedPayload parses links, text, context note, and attachments safely", () => {
  assert.equal(parseSharedPayload(null), null);
  assert.equal(parseSharedPayload("not json"), null);
  assert.equal(parseSharedPayload("{}"), null);

  const parsed = parseSharedPayload(
    JSON.stringify({
      id: "share-1",
      createdAt: 1700000000,
      hostId: "host-a",
      botId: "bot-alfie",
      note: "  Summarize this for me  ",
      text: "Selected quote",
      urls: ["https://example.com/article", "  "],
      attachments: [
        { id: "a1", name: "photo.jpg", uri: "file:///group/shares/share-1/files/1-photo.jpg", size: 4200, kind: "image" },
        { id: "a2", name: "clip.mov", uri: "file:///group/shares/share-1/files/2-clip.mov", size: 99000, kind: "video" },
        { id: "a3", name: "doc.pdf", uri: "file:///group/shares/share-1/files/3-doc.pdf", size: 1200, kind: "pdf" },
        { name: "missing-uri.txt" },
      ],
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.id, "share-1");
  assert.equal(parsed.hostId, "host-a");
  assert.equal(parsed.botId, "bot-alfie");
  assert.equal(parsed.note, "Summarize this for me");
  assert.equal(parsed.text, "Selected quote");
  assert.deepEqual(parsed.urls, ["https://example.com/article"]);
  assert.equal(parsed.attachments.length, 3);
  assert.deepEqual(
    parsed.attachments.map((a) => [a.name, a.kind]),
    [
      ["photo.jpg", "image"],
      ["clip.mov", "video"],
      ["doc.pdf", "file"],
    ],
  );
});

test("formatSharedMessage combines context note, deduplicated URLs, text, and file fallbacks", () => {
  assert.equal(
    formatSharedMessage({ note: "Check this out", text: "Hello", urls: ["https://botkins.app", "https://botkins.app"], attachments: [] }, 0),
    "Check this out\n\nhttps://botkins.app\n\nHello",
  );
  // Avoid duplicating a URL when iOS shares it as both URL and plain text.
  assert.equal(
    formatSharedMessage({ note: "", text: "https://botkins.app", urls: ["https://botkins.app"], attachments: [] }, 0),
    "https://botkins.app",
  );
  // Files shared alone get a clean fallback line.
  assert.equal(formatSharedMessage({ note: "", text: null, urls: [], attachments: [] }, 1), "See the shared file.");
  assert.equal(formatSharedMessage({ note: "", text: null, urls: [], attachments: [] }, 3), "See the shared files.");
});
