// ASAR integrity (fuse EnableEmbeddedAsarIntegrityValidation + OnlyLoadAppFromAsar).
// Written the way @electron/packager does it, in first-party code so no packager is needed:
//  - header hash = SHA-256 of the ASAR header JSON string;
//  - macOS (Electron >= 41): Info.plist ElectronAsarIntegrity AND a digest patched into the Electron
//    Framework binary at a sentinel. An unpatched slot FAILS OPEN, so patching is mandatory here:
//    zero sentinels found is an error, not a warning;
//  - Windows: an INTEGRITY/ELECTRONASAR resource in the exe (PE resource edit via `resedit`).
import { open, readFile, writeFile } from 'node:fs/promises';
import { sha256Hex, sha256Stream } from './hash.mjs';

const SENTINEL = Buffer.from('AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A');
const PAYLOAD_LEN = 34; // used(1) + version(1) + SHA-256(32)

export async function asarIntegrity(asarPath) {
  // A literal specifier resolves from this file, so from the build package's own node_modules.
  const asar = await import('@electron/asar');
  const { headerString } = asar.getRawHeader(asarPath);
  return { algorithm: 'SHA256', hash: sha256Hex(headerString) };
}

/** SHA-256 over the sorted (key, algorithm, hash) tuples, as Electron's integrity_digest.mm. */
export function integrityDigest(integrity) {
  const h = sha256Stream();
  for (const key of Object.keys(integrity).sort()) {
    h.update(key);
    h.update(integrity[key].algorithm);
    h.update(integrity[key].hash);
  }
  return Buffer.from(h.digest());
}

/** Patches every sentinel slot in the Electron Framework binary. Returns the number of slots written. */
export async function writeMacDigest(frameworkBinary, integrity) {
  const digest = integrityDigest(integrity);
  const buf = await readFile(frameworkBinary);
  const positions = [];
  for (let i = buf.indexOf(SENTINEL); i !== -1; i = buf.indexOf(SENTINEL, i + 1)) positions.push(i);
  if (positions.length === 0) {
    throw new Error(
      'No ASAR integrity sentinel in the Electron Framework binary (the digest would not be enforced).',
    );
  }
  const payload = Buffer.alloc(PAYLOAD_LEN);
  payload.writeUInt8(1, 0);
  payload.writeUInt8(1, 1);
  digest.copy(payload, 2);
  for (const p of positions) {
    if (p + SENTINEL.length + PAYLOAD_LEN > buf.length)
      throw new Error('Integrity slot is truncated.');
  }
  const fh = await open(frameworkBinary, 'r+');
  try {
    for (const p of positions) await fh.write(payload, 0, PAYLOAD_LEN, p + SENTINEL.length);
  } finally {
    await fh.close();
  }
  return positions.length;
}

/** Adds the INTEGRITY/ELECTRONASAR resource to a Windows exe. key is e.g. 'resources\\app.asar'. */
export async function writeWinIntegrity(exePath, key, integrity) {
  const { NtExecutable, NtExecutableResource, Resource } = await import('resedit');
  const exe = NtExecutable.from(await readFile(exePath));
  const res = NtExecutableResource.from(exe);
  const versions = Resource.VersionInfo.fromEntries(res.entries);
  const lang = versions[0]?.getAllLanguagesForStringValues()[0] ?? { lang: 1033, codepage: 1200 };
  const list = [{ file: key, alg: integrity.algorithm, value: integrity.hash }];
  const bin = Buffer.from(JSON.stringify(list), 'utf8');
  res.entries.push({
    type: 'INTEGRITY',
    id: 'ELECTRONASAR',
    bin: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length),
    lang: lang.lang,
    codepage: lang.codepage,
  });
  res.outputResource(exe);
  await writeFile(exePath, Buffer.from(exe.generate()));
}

/** Embeds the app icon (.ico) into a Windows exe as its icon group (resedit). */
export async function writeWinIcon(exePath, icoPath) {
  const { NtExecutable, NtExecutableResource, Resource, Data } = await import('resedit');
  const exe = NtExecutable.from(await readFile(exePath));
  const res = NtExecutableResource.from(exe);
  const iconFile = Data.IconFile.from(await readFile(icoPath));
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  const id = groups[0]?.id ?? 1;
  const lang = groups[0]?.lang ?? 1033;
  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    id,
    lang,
    iconFile.icons.map((i) => i.data),
  );
  res.outputResource(exe);
  await writeFile(exePath, Buffer.from(exe.generate()));
}
