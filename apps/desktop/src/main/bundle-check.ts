// Startup tripwire for the bundled files outside app.asar (D15-07, DESK051-C5).
//
// ASAR integrity covers app.asar only. Resources/node (the official Node.js binary), the core's
// desktop host (Resources/core/…/dist/desktop-host.js) and the owner-presence helper
// (Contents/Helpers/AgentLink.app/…/agentlink-presence) sit outside it. The macOS build records their
// SHA-256 in app.asar (`bundle-hashes.json`, build/lib/bundle-hashes.mjs), where ASAR integrity and the
// bundle signature cover the record; before every core start the shell hashes the files and refuses
// to start the core when one differs ('changed_files' page).
//
// What this is NOT: a security boundary against a same-user process. Such a process can replace the
// whole app, or run its own code, which no check inside the app can stop (04 §2.5; the unsigned phase
// residual in 04 §2.3.4). It catches a file changed or swapped after the build (a broken copy, a
// careless edit, a simple swap of one binary) and fails closed with a fixed page. Phase 3 replaces it
// with the OS signature and caller checks. Not checked: the core's node_modules (they carry native
// modules that signing rewrites; the bundle signature seals them on macOS). WIN-DESK-2: Windows builds
// carry the record too (resources\node\node.exe, the host, resources\native\agentlink-presence.exe;
// build-win.mjs). Unsigned there, so the record is covered by ASAR integrity only.
//
// Hashing goes through @4thtech-io/crypto (AGENTS.md). Nothing is logged.
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createSha256, encodeHex } from '@4thtech-io/crypto';
import RESOURCE_LAYOUT from '../shared/resource-layout.json' with { type: 'json' };

/** The record's name at the root of app.asar. */
export const BUNDLE_HASHES_FILE = 'bundle-hashes.json';

export const BUNDLE_FILE_KEYS = ['node', 'host', 'helper'] as const;
export type BundleFileKey = (typeof BUNDLE_FILE_KEYS)[number];

export type BundleHashes = Partial<Record<BundleFileKey, string>>;
export type BundlePaths = Readonly<Record<BundleFileKey, string | null>>;

const HEX64 = /^[0-9a-f]{64}$/;

/** The files under `resourcesPath` (macOS `AgentLink.app/Contents/Resources`, Windows `…\resources`). */
export function bundleFilePaths(resourcesPath: string, platform: string): BundlePaths {
  return {
    node: join(
      resourcesPath,
      ...(platform === 'win32' ? RESOURCE_LAYOUT.node.win32 : RESOURCE_LAYOUT.node.posix),
    ),
    host: join(resourcesPath, ...RESOURCE_LAYOUT.hostScript),
    helper:
      platform === 'darwin'
        ? join(
            resourcesPath,
            '..',
            'Helpers',
            'AgentLink.app',
            'Contents',
            'MacOS',
            'agentlink-presence',
          )
        : platform === 'win32'
          ? join(resourcesPath, 'native', 'agentlink-presence.exe')
          : null,
  };
}

/** `{ v: 1, files: { node?, host?, helper? } }` with lowercase hex; anything else → null. */
export function parseBundleHashes(text: string): BundleHashes | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { v?: unknown; files?: unknown };
  if (record.v !== 1 || typeof record.files !== 'object' || record.files === null) return null;
  const out: BundleHashes = {};
  const entries = Object.entries(record.files as Record<string, unknown>);
  if (entries.length === 0) return null;
  for (const [key, hash] of entries) {
    if (!(BUNDLE_FILE_KEYS as readonly string[]).includes(key)) return null;
    if (typeof hash !== 'string' || !HEX64.test(hash)) return null;
    out[key as BundleFileKey] = hash;
  }
  return out;
}

/** SHA-256 of a file (streamed) as lowercase hex. */
export async function sha256File(path: string): Promise<string> {
  const hasher = createSha256();
  for await (const chunk of createReadStream(path)) hasher.update(chunk as Uint8Array);
  return encodeHex(hasher.digest());
}

/**
 * 'ok' when every recorded file matches; 'changed' when one differs, is missing or unreadable, or
 * the record is broken; 'unchecked' when there is no record (a development run).
 */
export async function verifyBundle(
  recordText: string | null,
  paths: BundlePaths,
): Promise<'ok' | 'changed' | 'unchecked'> {
  if (recordText === null) return 'unchecked';
  const hashes = parseBundleHashes(recordText);
  if (hashes === null) return 'changed';
  for (const key of BUNDLE_FILE_KEYS) {
    const expected = hashes[key];
    if (expected === undefined) continue;
    const path = paths[key];
    if (path === null) return 'changed';
    try {
      if ((await sha256File(path)) !== expected) return 'changed';
    } catch {
      return 'changed';
    }
  }
  return 'ok';
}
