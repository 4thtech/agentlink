// M1-9f (D-91): a reproducible zip writer for the extension bundle (an MCPB file is a zip with
// manifest.json at its root). Same directory contents and mtime -> same bytes: entries sorted by
// path, one fixed timestamp, fixed permissions (0644, or 0755 when executable), raw deflate from
// node:zlib, no extra fields, no directory entries (the reference packer writes none either).
// Built-ins only (no new dependency). Fails on more than 65 535 entries or 4 GiB (no ZIP64).

import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/** Every regular file under `dir`, as sorted forward-slash paths. Symlinks are refused. */
export function listFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = lstatSync(join(dir, rel));
    if (st.isSymbolicLink()) throw new Error(`symbolic link in the bundle: ${rel}`);
    if (st.isDirectory()) out.push(...listFiles(dir, rel));
    else if (st.isFile()) out.push(rel);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function dosDateTime(epochSeconds) {
  const d = new Date(Math.max(epochSeconds, 315_532_800) * 1000); // not before 1980-01-01 UTC
  const time =
    (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

/** Writes the zip of `dir` to `outFile` with every entry stamped `mtime` (Unix seconds). */
export function writeDeterministicZip(dir, outFile, { mtime }) {
  if (!Number.isInteger(mtime) || mtime < 0) throw new Error('mtime must be Unix seconds');
  const { time, date } = dosDateTime(mtime);
  const files = listFiles(dir);
  if (files.length > 0xffff) throw new Error('too many files for a zip without ZIP64');
  const local = [];
  const central = [];
  let offset = 0;
  for (const rel of files) {
    const data = readFileSync(join(dir, rel));
    const executable = (lstatSync(join(dir, rel)).mode & 0o111) !== 0;
    const packed = deflateRawSync(data, { level: 9 });
    const name = Buffer.from(rel, 'utf8');
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, packed);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, 2.0
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(((executable ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += head.length + name.length + packed.length;
    if (offset > 0xffffffff) throw new Error('bundle too large for a zip without ZIP64');
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(outFile, Buffer.concat([...local, cd, end]));
  return files.length;
}
