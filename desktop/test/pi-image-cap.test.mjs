// Model requests from Pi and OMP carry only the newest images (desktop/providers/pi/extension-shared.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capImages, IMAGE_LEFT_OUT, makeBotkinsExtension, MAX_IMAGES } from "../desktop/providers/pi/extension-shared.mjs";

const image = (n) => ({ type: "image", data: "img" + n, mimeType: "image/png" });
const read = (n) => ({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "Read image file" }, image(n)] });
const images = (messages) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "image").map((p) => p.data);

test("a conversation under the limit is sent as it is", () => {
  const messages = [{ role: "user", content: "look" }, ...Array.from({ length: MAX_IMAGES }, (_, i) => read(i))];
  assert.equal(capImages(messages), null);
});

test("only the newest images are sent, the older ones say they were left out, and nothing is changed in place", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "check these" }, image("u1"), image("u2")] }, ...Array.from({ length: 12 }, (_, i) => read(i))];
  const before = structuredClone(messages);
  const out = capImages(messages, 10);
  assert.deepEqual(images(out), ["img2", "img3", "img4", "img5", "img6", "img7", "img8", "img9", "img10", "img11"]);
  assert.equal(out.length, messages.length);
  assert.equal(out.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.text === IMAGE_LEFT_OUT).length, 4);
  assert.deepEqual(out[0].content[0], { type: "text", text: "check these" });
  assert.deepEqual(messages, before);
});

test("the extension trims every request it is asked about", () => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-pi-images-"));
  try {
    const file = join(dir, "session.json");
    writeFileSync(file, JSON.stringify({ prompt: "" }));
    const handlers = new Map();
    const pi = { on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]), registerMcpServer: () => {}, registerProvider: () => {} };
    makeBotkinsExtension(file)(pi);
    const [context] = handlers.get("context") ?? [];
    assert.ok(context, "a context handler is registered");
    const many = Array.from({ length: 14 }, (_, i) => read(i));
    assert.equal(images(context({ messages: many }).messages).length, MAX_IMAGES);
    assert.equal(context({ messages: many.slice(0, 3) }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
