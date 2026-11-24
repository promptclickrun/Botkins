import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProtonInstaller, unsupportedProton, unzipPassCli } from "../desktop/link/proton-install.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const binary = Buffer.from("fake Proton CLI");
const pin = { asset: "fake-pass-cli", sizeBytes: binary.length, sha256: sha(binary) };

async function fixture(t, fetcher) {
  const dir = await mkdtemp(join(tmpdir(), "botkins-proton-install-test-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  return { dir, installer: new ProtonInstaller({ dir, pin, fetcher }) };
}

test("Proton install plan runs nothing; stale consent is rejected before fetching", async (t) => {
  let downloads = 0;
  const { installer } = await fixture(t, async () => { downloads++; return new Response(binary); });
  const plan = installer.plan();
  assert.equal(plan.sha256, pin.sha256);
  assert.equal(downloads, 0);
  await assert.rejects(installer.install("wrong"), /review the install/i);
  assert.equal(downloads, 0);
});

test("unverified downloads and interrupted transfers leave no installed or staging files", async (t) => {
  let interrupt;
  const { dir, installer } = await fixture(t, async (_url, { signal }) => {
    if (!interrupt) return new Response(Buffer.alloc(binary.length));
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(binary.subarray(0, 4));
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        interrupt.abort();
      },
    }));
  });
  await assert.rejects(installer.install(pin.sha256), /verify/i);
  assert.equal(await installer.installed(), null);
  interrupt = new AbortController();
  await assert.rejects(installer.install(pin.sha256, interrupt.signal));
  assert.deepEqual(await readdir(dir), []);
});

test("tampering forces a reinstall; a fresh host also verifies each installed file", async (t) => {
  const { dir, installer } = await fixture(t, async () => new Response(binary));
  const plan = installer.plan();
  await installer.install(plan.sha256);
  const file = join(plan.destination, "pass-cli");
  assert.equal(await installer.installed(), file);
  await writeFile(file, Buffer.alloc(binary.length));
  assert.equal(await installer.installed(), null);
  assert.equal(await new ProtonInstaller({ dir, pin }).installed(), null);
  await installer.install(plan.sha256);
  assert.equal(await installer.installed(), file);
  await writeFile(join(plan.destination, "unexpected.dll"), binary);
  assert.equal(await installer.installed(), null, "unverified sidecar files make the installation unsafe");
  await installer.install(plan.sha256);
  assert.deepEqual(await readdir(plan.destination), ["pass-cli"]);
});

test("managed installation rejects Alpine, Windows on Arm and other unsupported CPUs", () => {
  assert.match(unsupportedProton("linux", "arm64", false), /Alpine/);
  assert.match(unsupportedProton("win32", "arm64", true), /Windows on Arm/);
  assert.match(unsupportedProton("linux", "ia32", true), /isn't supported/);
  assert.equal(unsupportedProton("linux", "arm64", true), null);
  assert.equal(unsupportedProton("win32", "x64", true), null);
});

function zip(entries) {
  const blocks = [], directory = [];
  let offset = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    const path = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE(offset, 42);
    blocks.push(local, path, bytes);
    directory.push(central, path);
    offset += local.length + path.length + bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...blocks, ...directory, end]);
}

test("Windows archive permits only the pinned regular files, never extra or traversal entries", () => {
  const files = { "pass-cli.exe": binary, "libcrypto-3-x64.dll": Buffer.from("dll") };
  const hashes = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)]));
  assert.deepEqual(Object.fromEntries(unzipPassCli(zip(files), hashes)), files);
  for (const name of ["extra.txt", "../pass-cli.exe", "other\\pass-cli.exe"]) {
    assert.throws(() => unzipPassCli(zip({ ...files, [name]: binary }), hashes), /verify/i);
  }
  assert.throws(() => unzipPassCli(zip({ "../pass-cli.exe": binary, "libcrypto-3-x64.dll": files["libcrypto-3-x64.dll"] }), hashes), /verify/i);
  assert.throws(() => unzipPassCli(zip({ ...files, "pass-cli.exe": Buffer.from("bad") }), hashes), /verify/i);
});
