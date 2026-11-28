// MEDIA: attachments in a reply (src/mediaParts.ts): each one the computer knows is drawn where it
// was written, once, and its raw line is not shown. The phone has the same rules.
import test from "node:test";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { findPathSpans } from "../desktop/path-detector.mjs";
import { INLINE_PICTURE_MAX, isPicture, mediaPlaces, pathMarkup, readsWhole } from "../src/mediaParts.ts";

const artifact = (path, more = {}) => ({ id: "a:" + path, botId: "pip", path, name: path.split("/").at(-1), kind: "image", mime: "image/png", size: 1000, time: 1, source: "media", ...more });

/** The reply as the window draws it: its found paths, and the tree after the rule. `known` and `there` are paths. */
function drawn(text, known, there = known) {
  const spans = findPathSpans(text);
  const places = mediaPlaces(spans, new Map(known.map((path) => [path, artifact(path)])));
  const found = spans.flatMap((span, index) => {
    const { media: _sent, ...place } = span;
    return there.includes(span.path) || places[index] ? [{ ...place, item: artifact(span.path), ...places[index] }] : [];
  });
  const processor = unified().use(remarkParse).use(remarkGfm).use(pathMarkup(text, found));
  const tree = processor.runSync(processor.parse(text));
  const flat = [];
  const walk = (node) => {
    if (node.type === "chatMedia") flat.push({ media: found[node.data.hProperties["data-chat-media"]].media.path });
    else if (node.type === "chatFile") flat.push({ link: node.children[0].value });
    else if (node.type === "text" || node.type === "inlineCode") flat.push(node.value);
    else for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return flat;
}
const shownText = (flat) => flat.filter((part) => typeof part === "string").join("");
const media = (flat) => flat.filter((part) => typeof part === "object" && part.media).map((part) => part.media);
const links = (flat) => flat.filter((part) => typeof part === "object" && part.link);

test("a reply with MEDIA: lines draws each picture where it was written, and no raw line", () => {
  // The shape of the owner's report of 2026-11-20: pictures in the chat's own session folder, each
  // on the line after its heading.
  const dir = "/opt/data/.local/share/botkins/data/copilot/session-state/54c0c38b-a7f1-4c01-8ded-5de1139a704f/files/duo/";
  const text = [
    "Here are the mockups, one image each:",
    "",
    "**1. Side menu layout.** The numbers mark the order from top to bottom.",
    "MEDIA:" + dir + "01-anatomy.png",
    "",
    "**2. Closed, Home**",
    "MEDIA:" + dir + "02-closedHome.png",
    "",
    "That is all.",
  ].join("\n");
  const flat = drawn(text, [dir + "01-anatomy.png", dir + "02-closedHome.png"]);
  assert.deepEqual(flat, [
    "Here are the mockups, one image each:",
    "1. Side menu layout.",
    " The numbers mark the order from top to bottom.\n",
    { media: dir + "01-anatomy.png" },
    "2. Closed, Home",
    "\n",
    { media: dir + "02-closedHome.png" },
    "That is all.",
  ]);
  assert.ok(!shownText(flat).includes("MEDIA:"));
  // With only the first one known, the second stays as the text it is.
  assert.ok(shownText(drawn(text, [dir + "01-anatomy.png"])).includes("MEDIA:" + dir + "02-closedHome.png"));
});

test("an attachment the computer does not know stays as the text it is", () => {
  const text = "MEDIA:/tmp/known.png\n\nMEDIA:/tmp/unknown.png\n\nMEDIA:/tmp/there.png";
  // unknown.png: no such file. there.png: a file, but not one the computer knows as the chat's: a link, as before.
  const flat = drawn(text, ["/tmp/known.png"], ["/tmp/known.png", "/tmp/there.png"]);
  assert.deepEqual(flat, [{ media: "/tmp/known.png" }, "MEDIA:/tmp/unknown.png", { link: "MEDIA:/tmp/there.png" }]);
});

test("words beside an attachment stay, and the same file is drawn once, at its first place", () => {
  const text = "Here it is: MEDIA:/tmp/a.png\n\n- MEDIA:/tmp/b.png\n- again MEDIA:/tmp/a.png\n\nDone";
  const flat = drawn(text, ["/tmp/a.png", "/tmp/b.png"]);
  assert.deepEqual(media(flat), ["/tmp/a.png", "/tmp/b.png"]);
  assert.equal(shownText(flat), "Here it is: again Done");
  // Two on one line, and lines with no blank line between them.
  assert.deepEqual(media(drawn("MEDIA:/tmp/a.png MEDIA:/tmp/b.png\nMEDIA:/tmp/c.png", ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"])), ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]);
});

test("a quoted path and a path in code marks are attachments too", () => {
  const quoted = drawn('See MEDIA:"/tmp/my chart.png" here', ["/tmp/my chart.png"]);
  assert.deepEqual(quoted, ["See ", { media: "/tmp/my chart.png" }, " here"]);
  const coded = drawn("See MEDIA:`/tmp/my chart.png` here", ["/tmp/my chart.png"]);
  assert.deepEqual(coded, ["See ", { media: "/tmp/my chart.png" }, " here"]);
  // Written a second time in code marks: nothing is left of it.
  assert.deepEqual(drawn("MEDIA:/tmp/a.png\n\nSee MEDIA:`/tmp/a.png` here", ["/tmp/a.png"]), [{ media: "/tmp/a.png" }, "See ", " here"]);
});

test("MEDIA: in a code block is never an attachment, and other paths stay links", () => {
  const flat = drawn("Saved /tmp/notes.txt.\n\n```\nMEDIA:/tmp/a.png\n```", ["/tmp/a.png", "/tmp/notes.txt"]);
  assert.deepEqual(media(flat), []);
  assert.deepEqual(links(flat), [{ link: "/tmp/notes.txt" }]);
});

test("macOS Application Support and Windows bare MEDIA: lines with spaces render as media without raw text", () => {
  const mac = "/Users/gordieai/Library/Application Support/Botkins/data/files/04104688/botkins-a2ui-desktop.png";
  const win = "C:\\Users\\Alice Smith\\AppData\\Local\\Botkins\\shot 1.png";
  const text = `Done.\nMEDIA: ${mac}\nMEDIA: ${win}`;
  const flat = drawn(text, [mac, win]);
  assert.deepEqual(media(flat), [mac, win]);
  assert.ok(!shownText(flat).includes("MEDIA:"), "no raw MEDIA: lines remain: " + shownText(flat));
  assert.ok(!shownText(flat).includes("Application Support"), "path remainder must not leak into text");
  assert.ok(!shownText(flat).includes("Alice Smith"), "Windows path remainder must not leak into text");
});

test("mediaPlaces: only MEDIA: spans the computer knows, and `again` from the second place on", () => {
  const spans = [{ path: "/a.png", start: 30, end: 40, media: true }, { path: "/a.png", start: 0, end: 10, media: true }, { path: "/a.png", start: 50, end: 56 }, { path: "/b.png", start: 60, end: 70, media: true }];
  const places = mediaPlaces(spans, new Map([["/a.png", artifact("/a.png")]]));
  assert.deepEqual(places.map((place) => place && place.again), [true, false, undefined, undefined]);
});

test("a picture is shown itself up to 8 MB; other kinds are chips", () => {
  assert.equal(isPicture({ kind: "image" }), true);
  for (const kind of ["video", "audio", "file", "folder"]) assert.equal(isPicture({ kind }), false);
  assert.equal(readsWhole({ size: INLINE_PICTURE_MAX }), true);
  assert.equal(readsWhole({ size: INLINE_PICTURE_MAX + 1 }), false);
  assert.equal(readsWhole({ size: null }), false);
  assert.equal(INLINE_PICTURE_MAX, 8 * 1024 * 1024);
});
