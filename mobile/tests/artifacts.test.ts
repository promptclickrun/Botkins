// Artifacts ("artifacts-v1"): what a bot made or was given, read from the computer's own index.
// This checks what the link lets a phone ask (link-host/methods.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MAX_ARTIFACT_CHUNK, MAX_RESOLVE_PATHS, REMOTE_METHODS, remoteArgs } from "../link-host/methods.mjs";
import { detectPaths, isLinkablePath } from "../src/features/chat/paths";
import { MockBackend } from "../link-host/mock-backend.mjs";
import type { Artifact, ArtifactChunk, ArtifactPage } from "../src/link/types";
import { batches, canSaveToPhotos, extOf, FILTERS, inFilter, isBig, isMedia, isTextPreview, kindOf, type Known, linkedSpans, linkKey, mediaOf, messageParts, PathResolver, type PreviewKind, previewKind, rowLine, sizeWords, sourceWord, TEXT_LIMIT, uniquePaths } from "../src/features/artifacts/logic";

const said = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return null;
};

test("a phone may make the four artifact calls, each cut to its shape", () => {
  for (const name of ["artifacts.list", "artifacts.read", "artifacts.thumbnail", "artifacts.resolve"]) assert.ok(REMOTE_METHODS.has(name), name);
  assert.equal(MAX_ARTIFACT_CHUNK, 512 * 1024);
  assert.equal(MAX_RESOLVE_PATHS, 20);

  assert.deepEqual(remoteArgs("artifacts.list", [{ botId: "b1", chatId: "c1", kind: "media", folder: "f1", cursor: "x", path: "/etc" }]), [{ botId: "b1", chatId: "c1", kind: "media", folder: "f1", cursor: "x" }]);
  assert.deepEqual(remoteArgs("artifacts.list", [{ botId: "b1" }]), [{ botId: "b1" }]);
  assert.equal(said(() => remoteArgs("artifacts.list", [{}])), "Choose a bot.");
  for (const bad of [{ botId: "b1", kind: "all" }, { botId: "b1", chatId: 7 }, { botId: "b1", cursor: "" }, { botId: "b1", folder: {} }]) assert.equal(said(() => remoteArgs("artifacts.list", [bad])), "That list can't be shown.", JSON.stringify(bad));

  assert.deepEqual(remoteArgs("artifacts.read", ["a1"]), ["a1", {}]);
  assert.deepEqual(remoteArgs("artifacts.read", ["a1", { offset: 524288, length: 1024, encoding: "utf8" }]), ["a1", { offset: 524288, length: 1024 }]);
  for (const bad of [["", {}], [7, {}], ["a\0b", {}], ["/Users/x/../../etc/passwd", {}], ["a1", { offset: -1 }], ["a1", { offset: 1.5 }], ["a1", { length: 0 }], ["a1", { length: MAX_ARTIFACT_CHUNK + 1 }]]) assert.equal(said(() => remoteArgs("artifacts.read", bad)), "That file can't be opened.", JSON.stringify(bad));

  assert.deepEqual(remoteArgs("artifacts.thumbnail", ["a1"]), ["a1", {}]);
  assert.deepEqual(remoteArgs("artifacts.thumbnail", ["a1", { size: 160, more: 1 }]), ["a1", { size: 160 }]);
  assert.equal(said(() => remoteArgs("artifacts.thumbnail", ["a1", { size: 4000 }])), "That picture can't be shown at that size.");
  assert.equal(said(() => remoteArgs("artifacts.thumbnail", [""])), "That file can't be opened.");

  assert.deepEqual(remoteArgs("artifacts.resolve", [{ chatId: "c1", paths: ["/Users/demo/a.png", "~/notes.md", "C:\\Users\\x\\a.txt"], botId: "b9" }]), [{ chatId: "c1", paths: ["/Users/demo/a.png", "~/notes.md", "C:\\Users\\x\\a.txt"] }]);
  for (const bad of [{ paths: ["/a"] }, { chatId: "c1", paths: [] }, { chatId: "c1", paths: "x" }, { chatId: "c1", paths: [7] }, { chatId: "c1", paths: ["/a/../b"] }, { chatId: "c1", paths: Array.from({ length: MAX_RESOLVE_PATHS + 1 }, (_, n) => "/f" + n) }])
    assert.equal(said(() => remoteArgs("artifacts.resolve", [bad])), "Those paths can't be looked up.", JSON.stringify(bad).slice(0, 60));
});

// ---- the paths written in a message (src/features/chat/paths.ts), against the cases both apps share

test("every shared case of path detection: what is linked, and what is not", () => {
  const shared = JSON.parse(readFileSync(new URL("../docs/path-detection.json", import.meta.url), "utf8")) as { cases: { name: string; text: string; links: { text: string; path: string; media?: true }[] }[] };
  assert.ok(shared.cases.length >= 35);
  for (const each of shared.cases) {
    const found = detectPaths(each.text).map((span) => ({ text: each.text.slice(span.start, span.end), path: span.path, ...(span.media && { media: true }) }));
    assert.deepEqual(found, each.links, each.name);
  }
  // Both kinds are well covered: cases that link something, and cases that must link nothing.
  assert.ok(shared.cases.filter((each) => each.links.length > 0).length >= 20);
  assert.ok(shared.cases.filter((each) => each.links.length === 0).length >= 12);
});

test("spans never overlap, are in order, and never hold a path the link refuses to ask about", () => {
  const text = "MEDIA:/Users/sam/a.png then \"/Users/sam/b c.txt\" and `/Users/sam/d.txt` and /Users/sam/e.txt.\n```\n/Users/sam/f.txt\n```";
  const spans = detectPaths(text);
  assert.equal(spans.length, 5);
  for (let index = 1; index < spans.length; index++) assert.ok(spans[index]!.start >= spans[index - 1]!.end);
  // Whatever is detected passes the link's own check for a path (no "..", no NUL, a sensible length).
  assert.deepEqual(remoteArgs("artifacts.resolve", [{ chatId: "c1", paths: spans.map((span) => span.path) }]), [{ chatId: "c1", paths: spans.map((span) => span.path) }]);
  assert.equal(isLinkablePath("/Users/sam/" + "x".repeat(2000)), false);
  assert.equal(isLinkablePath("/Users/sam/a\u0000b"), false);
  assert.deepEqual(detectPaths(""), []);
});

// ---- the phone's own logic for artifacts (src/features/artifacts/logic.ts)

const art = (over: Partial<Artifact> = {}): Artifact => ({ id: "a1", botId: "b1", path: "/Users/sam/a.txt", name: "a.txt", kind: "file", mime: "text/plain", size: 10, time: 0, source: "tool", ...over });

test("the filter: All asks for everything, Files for everything but pictures, video and sound, Media for those", () => {
  assert.deepEqual(FILTERS.map((each) => each.label), ["All", "Files", "Media"]);
  assert.equal(kindOf("all"), undefined);
  assert.equal(kindOf("files"), "files");
  assert.equal(kindOf("media"), "media");
  for (const kind of ["image", "video", "audio"] as const) {
    assert.equal(isMedia({ kind }), true, kind);
    assert.equal(inFilter("media", { kind }), true, kind);
    assert.equal(inFilter("files", { kind }), false, kind);
  }
  for (const kind of ["file", "folder"] as const) {
    assert.equal(isMedia({ kind }), false, kind);
    assert.equal(inFilter("files", { kind }), true, kind);
    assert.equal(inFilter("media", { kind }), false, kind);
  }
  for (const kind of ["file", "folder", "image", "video", "audio"] as const) assert.equal(inFilter("all", { kind }), true, kind);
});

test("a preview is chosen by kind, type and the name's ending", () => {
  const cases: [Partial<Artifact>, PreviewKind][] = [
    [{ kind: "image", mime: "image/webp", name: "beacon.webp" }, "image"],
    [{ kind: "file", mime: "application/octet-stream", name: "shot.PNG" }, "image"],
    [{ kind: "video", mime: "video/mp4", name: "clip.mp4" }, "video"],
    [{ kind: "file", mime: "video/quicktime", name: "clip" }, "video"],
    [{ kind: "audio", mime: "audio/wav", name: "standup tone.wav" }, "audio"],
    [{ kind: "file", mime: "", name: "song.m4a" }, "audio"],
    [{ kind: "file", mime: "text/markdown", name: "README.md" }, "markdown"],
    [{ kind: "file", mime: "text/plain", name: "notes.md" }, "markdown"],
    [{ kind: "file", mime: "text/javascript", name: "grant.mjs" }, "code"],
    [{ kind: "file", mime: "application/json", name: "package.json" }, "code"],
    [{ kind: "file", mime: "text/plain", name: "main.ts" }, "code"],
    [{ kind: "file", mime: "application/octet-stream", name: "tool.py" }, "code"],
    [{ kind: "file", mime: "text/html", name: "index.html" }, "code"],
    [{ kind: "file", mime: "image/svg+xml", name: "logo.svg" }, "code"],
    [{ kind: "file", mime: "text/csv", name: "prices.csv" }, "text"],
    [{ kind: "file", mime: "application/octet-stream", name: "run.log" }, "text"],
    [{ kind: "file", mime: "text/plain", name: "notes.txt" }, "text"],
    [{ kind: "file", mime: "text/plain", name: "NOTES" }, "text"],
    [{ kind: "file", mime: "application/pdf", name: "launch plan.pdf" }, "pdf"],
    [{ kind: "file", mime: "application/octet-stream", name: "scan.PDF" }, "pdf"],
    [{ kind: "folder", mime: "inode/directory", name: "out" }, "folder"],
    [{ kind: "file", mime: "application/octet-stream", name: "archive.bin" }, "other"],
    [{ kind: "file", mime: "application/zip", name: "site.zip" }, "other"],
    [{ kind: "file", mime: "", name: "noext" }, "other"],
    [{ kind: "file", mime: "", name: "" }, "other"],
  ];
  for (const [over, want] of cases) assert.equal(previewKind(art(over)), want, JSON.stringify(over));
  // Negative: a picture-looking type never wins over a folder; text never becomes a picture.
  assert.notEqual(previewKind(art({ kind: "folder", mime: "inode/directory", name: "pics.png" })), "image");
  assert.notEqual(previewKind(art({ kind: "file", mime: "text/plain", name: "image.txt" })), "image");
  assert.equal(extOf("a.tar.gz"), "gz");
  assert.equal(extOf(".env"), "");
  assert.equal(extOf("Dockerfile"), "dockerfile");
});

test("only pictures and video offer Save to Photos, and a big file waits to be asked for", () => {
  const kinds: PreviewKind[] = ["image", "video", "audio", "text", "markdown", "code", "pdf", "folder", "other"];
  assert.deepEqual(kinds.filter(canSaveToPhotos), ["image", "video"]);
  assert.deepEqual(kinds.filter(isTextPreview), ["text", "markdown", "code"]);
  assert.equal(isBig({ size: 25 * 1024 * 1024 }), false);
  assert.equal(isBig({ size: 25 * 1024 * 1024 + 1 }), true);
  assert.equal(isBig({ size: null }), false);
});

test("a row's second line: size in words, when, and the chat it came from", () => {
  assert.equal(sizeWords(0), "0 bytes");
  assert.equal(sizeWords(1), "1 byte");
  assert.equal(sizeWords(512), "512 bytes");
  assert.equal(sizeWords(12 * 1024), "12 KB");
  assert.equal(sizeWords(1536), "1.5 KB");
  assert.equal(sizeWords(3.4 * 1024 * 1024), "3.4 MB");
  assert.equal(sizeWords(3 * 1024 * 1024), "3 MB");
  assert.equal(sizeWords(1023.99 * 1024), "1 MB");
  assert.equal(sizeWords(2.5 * 1024 ** 3), "2.5 GB");
  assert.equal(sizeWords(null), "");
  assert.equal(sizeWords(-1), "");
  const now = new Date(2026, 10, 19, 12, 0).getTime();
  // How it came to be is first, so it stays in view on a narrow row, and tells apart two rows for one file.
  assert.equal(rowLine(art({ size: 12 * 1024, time: now - 2 * 3_600_000, chatTitle: "Launch plan" }), now), "Written · 12 KB · 2h · Launch plan");
  assert.equal(rowLine(art({ source: "media", size: 12 * 1024, time: now - 2 * 3_600_000, chatTitle: "Launch plan" }), now), "Sent · 12 KB · 2h · Launch plan");
  assert.equal(rowLine(art({ source: "upload", size: 512, time: now - 30_000 }), now), "Uploaded · 512 bytes · now");
  assert.equal(rowLine(art({ source: "export", size: 277, time: now - 30_000 }), now), "Exported · 277 bytes · now");
  assert.deepEqual(["tool", "media", "upload", "export"].map((source) => sourceWord(source as Artifact["source"])), ["Written", "Sent", "Uploaded", "Exported"]);
  // A source this app doesn't know (a newer computer) adds no word and breaks nothing.
  assert.equal(sourceWord("constructor" as never), "");
  assert.equal(rowLine({ kind: "file", size: 512, time: now - 30_000 }, now), "512 bytes · now");
  // A folder has no size.
  assert.equal(rowLine(art({ kind: "folder", size: null, time: now - 5 * 60_000, chatTitle: "Site" }), now), "Written · 5m · Site");
  assert.equal(rowLine(art({ size: 0, time: 0, chatTitle: "  " }), now), "Written · 0 bytes");
});

test("which spans in a message become links: only resolved ones, and MEDIA: ones as attachments", () => {
  const text = "Saved /Users/sam/a.txt and /Users/sam/missing.txt.\nMEDIA:/Users/sam/pic.png\nAgain MEDIA:/Users/sam/pic.png and `~/notes.md`";
  const spans = detectPaths(text);
  const picture = art({ id: "p1", path: "/Users/sam/pic.png", name: "pic.png", kind: "image", mime: "image/png" });
  const known = { "/Users/sam/a.txt": art(), "/Users/sam/missing.txt": null, "/Users/sam/pic.png": picture };
  const linked = linkedSpans(spans, known).map(({ span }) => text.slice(span.start, span.end));
  assert.deepEqual(linked, ["/Users/sam/a.txt", "MEDIA:/Users/sam/pic.png", "MEDIA:/Users/sam/pic.png"]);
  assert.deepEqual(linkedSpans(spans, undefined), []);
  assert.deepEqual(mediaOf(spans, known).map((each) => each.id), ["p1"]);
  assert.deepEqual(uniquePaths(spans), ["/Users/sam/a.txt", "/Users/sam/missing.txt", "/Users/sam/pic.png", "~/notes.md"]);
  // The key changes when what a link points at changes, and not otherwise.
  const before = linkKey(spans, known);
  assert.equal(linkKey(spans, { ...known }), before);
  assert.notEqual(linkKey(spans, { ...known, "~/notes.md": art({ id: "n1" }) }), before);
  assert.equal(linkKey([], known), "");
  assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("a message is cut at its MEDIA: attachments, so each picture is drawn where it was written", () => {
  const dir = "/opt/data/.local/share/botkins/data/copilot/session-state/54c0c38b-a7f1-4c01-8ded-5de1139a704f/files/duo/";
  // The owner's message of 2026-11-20: a heading, then the attachment on the next line.
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
  const spans = detectPaths(text);
  const one = art({ id: "a1", name: "01-anatomy.png", kind: "image" });
  const two = art({ id: "a2", name: "02-closedHome.png", kind: "image" });
  const known: Known = { [dir + "01-anatomy.png"]: one, [dir + "02-closedHome.png"]: two };
  assert.deepEqual(messageParts(text, spans, known), [
    { kind: "text", text: "Here are the mockups, one image each:\n\n**1. Side menu layout.** The numbers mark the order from top to bottom." },
    { kind: "media", artifact: one },
    { kind: "text", text: "**2. Closed, Home**" },
    { kind: "media", artifact: two },
    { kind: "text", text: "That is all." },
  ]);
  // Nothing of the raw line is left in the text.
  assert.ok(!messageParts(text, spans, known).some((part) => part.kind === "text" && part.text.includes("MEDIA:")));
  // An attachment the computer does not know stays as the text it is; with none known, the message is whole.
  assert.deepEqual(messageParts(text, spans, { [dir + "01-anatomy.png"]: one, [dir + "02-closedHome.png"]: null }).map((part) => part.kind), ["text", "media", "text"]);
  assert.ok((messageParts(text, spans, { [dir + "01-anatomy.png"]: one }).at(-1) as { text: string }).text.includes("MEDIA:" + dir + "02-closedHome.png"));
  assert.deepEqual(messageParts(text, spans, undefined), [{ kind: "text", text }]);
  assert.deepEqual(messageParts("No files here.", [], known), [{ kind: "text", text: "No files here." }]);

  // Words beside an attachment stay, and the picture follows that line. A list mark alone is not words.
  const beside = "Here it is: MEDIA:/tmp/a.png\n- MEDIA:/tmp/b.png\n- MEDIA:/tmp/a.png\nDone";
  const a = art({ id: "a", kind: "image" });
  const b = art({ id: "b", kind: "video" });
  assert.deepEqual(messageParts(beside, detectPaths(beside), { "/tmp/a.png": a, "/tmp/b.png": b }), [
    { kind: "text", text: "Here it is:" },
    { kind: "media", artifact: a },
    { kind: "media", artifact: b },
    // The same file a second time is not drawn again.
    { kind: "text", text: "Done" },
  ]);
  // Two on one line, and a message that is nothing but an attachment.
  const pair = "MEDIA:/tmp/a.png MEDIA:/tmp/b.png";
  assert.deepEqual(messageParts(pair, detectPaths(pair), { "/tmp/a.png": a, "/tmp/b.png": b }).map((part) => part.kind), ["media", "media"]);
  // A code block is never cut: MEDIA: is not read inside one.
  const fenced = "```\nMEDIA:/tmp/a.png\n```";
  assert.deepEqual(messageParts(fenced, detectPaths(fenced), { "/tmp/a.png": a }), [{ kind: "text", text: fenced }]);
});

test("paths are asked 20 at a time, once per chat and path, and a failed call can be asked again", async () => {
  const calls: { chatId: string; paths: string[] }[] = [];
  let fail = false;
  const found: Record<string, Known> = {};
  let run: (() => void) | undefined;
  const resolver = new PathResolver(
    async (chatId, paths) => {
      calls.push({ chatId, paths });
      if (fail) throw new Error("offline");
      return paths.map((path) => (path.endsWith("0.txt") ? art({ id: path, path }) : null));
    },
    (chatId, known) => void (found[chatId] = known),
    (next) => void (run = next),
  );
  const many = Array.from({ length: 45 }, (_, n) => "/Users/sam/f" + n + ".txt");
  resolver.want("c1", many.slice(0, 30));
  resolver.want("c1", many); // the first 30 again: not asked twice
  resolver.want("c2", many.slice(0, 3));
  assert.equal(calls.length, 0, "gathered, not sent at once");
  const send = run!;
  run = undefined;
  send();
  // While the answers are on their way, the same paths are not asked again.
  resolver.want("c1", many);
  assert.equal(run, undefined, "nothing new to ask while the first calls are out");
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(calls.map((call) => [call.chatId, call.paths.length]), [["c1", 20], ["c1", 20], ["c1", 5], ["c2", 3]]);
  assert.equal(new Set(calls.filter((call) => call.chatId === "c1").flatMap((call) => call.paths)).size, 45);
  assert.equal(found.c1?.["/Users/sam/f10.txt"]?.id, "/Users/sam/f10.txt");
  assert.equal(found.c1?.["/Users/sam/f1.txt"], null);

  // Known now: wanting them again asks nothing.
  calls.length = 0;
  run = undefined;
  resolver.want("c1", many);
  assert.equal(run, undefined);
  assert.equal(calls.length, 0);

  // The index changed: only the paths that had nothing are asked again, at once, without waiting for
  // a message to want them (a picture recorded just after its reply arrived shows without a restart).
  resolver.forgetMissing();
  assert.equal(found.c1?.["/Users/sam/f1.txt"], undefined);
  assert.equal(found.c1?.["/Users/sam/f10.txt"]?.id, "/Users/sam/f10.txt");
  assert.ok(run, "the missing paths are asked again on their own");
  resolver.want("c1", ["/Users/sam/f1.txt", "/Users/sam/f10.txt"]); // already waiting: not asked twice
  run!();
  await new Promise((done) => setImmediate(done));
  // Each chat asks again for its own missing paths, once each.
  const again = calls.filter((call) => call.chatId === "c1").flatMap((call) => call.paths);
  assert.ok(again.includes("/Users/sam/f1.txt"));
  assert.ok(!again.includes("/Users/sam/f10.txt"), "a path it knows is not asked again");
  assert.equal(again.length, new Set(again).size, "each missing path once");
  assert.deepEqual(calls.filter((call) => call.chatId === "c2").flatMap((call) => call.paths).sort(), ["/Users/sam/f1.txt", "/Users/sam/f2.txt"]);

  // A call that fails is forgotten, so the next want asks again.
  calls.length = 0;
  fail = true;
  resolver.want("c3", ["/Users/sam/x.txt"]);
  run!();
  await new Promise((done) => setImmediate(done));
  resolver.want("c3", ["/Users/sam/x.txt"]);
  run!();
  await new Promise((done) => setImmediate(done));
  assert.equal(calls.length, 2);
  assert.equal(resolver.known("c3")?.["/Users/sam/x.txt"], undefined);

  // Another computer: nothing is kept, and a late answer is dropped.
  fail = false;
  resolver.want("c4", ["/Users/sam/late0.txt"]);
  run!();
  resolver.reset();
  await new Promise((done) => setImmediate(done));
  assert.equal(resolver.known("c4"), undefined);
});

// ---- the calls as a phone's call would arrive at the demo computer

test("the demo computer lists, pages, filters, opens folders and reads in pieces, through the link's checks", async () => {
  const backend = new MockBackend({ speed: 0.05 });
  assert.ok(backend.capabilities.includes("artifacts-v1"));
  const call = (method: string, args: unknown[]) => backend.call(method, remoteArgs(method, args)) as Promise<any>;

  const first = (await call("artifacts.list", [{ botId: "bot-mira" }])) as ArtifactPage;
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  for (let n = 1; n < first.items.length; n++) assert.ok(first.items[n - 1]!.time >= first.items[n]!.time, "newest first");
  const second = (await call("artifacts.list", [{ botId: "bot-mira", cursor: first.nextCursor }])) as ArtifactPage;
  assert.ok(second.items.length > 0);
  assert.equal(second.nextCursor, null);
  const all = [...first.items, ...second.items];
  assert.equal(new Set(all.map((each) => each.id)).size, all.length, "no artifact on two pages");

  // Each kind of file the demo makes gets the preview it should.
  const byName = (name: string) => all.find((each) => each.name === name)!;
  assert.equal(previewKind(byName("README.md")), "markdown");
  assert.equal(previewKind(byName("grant.mjs")), "code");
  assert.equal(previewKind(byName("launch plan.pdf")), "pdf");
  assert.equal(previewKind(byName("prices.csv")), "text");
  assert.equal(previewKind(byName("standup tone.wav")), "audio");
  assert.equal(previewKind(byName("archive.bin")), "other");
  assert.equal(previewKind(byName("out")), "folder");
  assert.ok(all.some((each) => previewKind(each) === "image"));
  assert.equal(byName("launch plan.pdf").chatId, undefined);

  // The filters, as the phone sends them, match the phone's own predicate.
  for (const filter of ["files", "media"] as const) {
    const page = (await call("artifacts.list", [{ botId: "bot-mira", kind: kindOf(filter) }])) as ArtifactPage;
    assert.ok(page.items.length > 0, filter);
    assert.ok(page.items.every((each) => inFilter(filter, each)), filter);
  }

  // A folder lists what is directly in it.
  const inside = (await call("artifacts.list", [{ botId: "bot-mira", folder: byName("out").id }])) as ArtifactPage;
  assert.deepEqual(inside.items.map((each) => each.name).sort(), ["assets", "index.html", "notes.txt"]);

  // Read in pieces: the first small piece names the file; text shows from the first 512 KB.
  const readme = byName("README.md");
  const head = (await call("artifacts.read", [readme.id, { length: 1 }])) as ArtifactChunk;
  assert.equal(head.artifact.id, readme.id);
  assert.equal(head.offset, 0);
  const whole = (await call("artifacts.read", [readme.id, { offset: 0, length: TEXT_LIMIT }])) as ArtifactChunk;
  assert.equal(Buffer.from(whole.data, "base64").length, readme.size);
  // Piece by piece, the way a download appends them.
  const pieces: Buffer[] = [];
  for (let offset: number | null = 0; offset !== null; ) {
    const piece = (await call("artifacts.read", [readme.id, { offset, length: 1000 }])) as ArtifactChunk;
    pieces.push(Buffer.from(piece.data, "base64"));
    offset = piece.nextOffset;
  }
  assert.equal(Buffer.concat(pieces).length, readme.size);
  assert.equal(Buffer.concat(pieces).toString("base64"), whole.data);

  const thumb = await call("artifacts.thumbnail", [all.find((each) => each.kind === "image")!.id, { size: 160 }]);
  assert.ok(thumb?.data && thumb.mime.startsWith("image/"));
  assert.equal(await call("artifacts.thumbnail", [readme.id, { size: 160 }]), null);

  // A chat's paths resolve in the order asked; an unknown one is null.
  const pictured = all.find((each) => each.kind === "image" && each.chatId)!;
  const resolved = await call("artifacts.resolve", [{ chatId: pictured.chatId, paths: [pictured.path, "/Users/demo/nothing.txt"] }]);
  assert.equal(resolved.items[0]?.id, pictured.id);
  assert.equal(resolved.items[1], null);
});
