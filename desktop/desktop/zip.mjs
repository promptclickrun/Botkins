// A small ZIP writer, for exports. Files are deflated when that makes them smaller. Names are
// UTF-8. No ZIP64: up to 65,535 files and 4 GB, far beyond what a wiki export holds.
import { crc32, deflateRawSync } from "node:zlib";

const dosTime = (date) => ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
const dosDate = (date) => (((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;

/** A ZIP archive of `files`: [{ path, data: string | Buffer, time?: Date }]. Paths use "/". */
export function zip(files) {
  if (files.length > 65535) throw new Error("Too many files for one archive.");
  const parts = [];
  const central = [];
  let offset = 0;
  const seen = new Set();
  for (const file of files) {
    const path = String(file.path).replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path || path.split("/").includes("..") || seen.has(path)) throw new Error("Invalid archive path: " + file.path);
    seen.add(path);
    const name = Buffer.from(path, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length < data.length ? deflated : data;
    const method = stored === deflated ? 8 : 0;
    const time = file.time instanceof Date && !Number.isNaN(file.time.getTime()) ? file.time : new Date();
    const sum = crc32(data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(dosTime(time), 10);
    head.writeUInt16LE(dosDate(time), 12);
    head.writeUInt32LE(sum, 14);
    head.writeUInt32LE(stored.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    parts.push(head, name, stored);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4); // made by: Unix, version 2.0
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(dosTime(time), 12);
    entry.writeUInt16LE(dosDate(time), 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(stored.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // an ordinary file
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += head.length + name.length + stored.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
