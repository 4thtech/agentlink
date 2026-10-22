// M1-11s-b (D-118): the local UI's files, embedded in dist/agentlink.js at build time
// (bundle.config.mjs defines `__AGENTLINK_LOCAL_UI__` from scripts/local-ui-embed.mjs), handed to
// the approval server as an in-memory bundle. Nothing reads apps/local-ui or any path at run time.
// Unbundled (tsc output, tests) the constant does not exist, which is an empty bundle.
import { decodeBase64url } from '@4thtech-io/crypto';
import type { LocalUiAssets } from '@4thtech-io/node';

declare const __AGENTLINK_LOCAL_UI__: unknown;

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** The server's bundle from `[name, base64url]` entries; throws on a malformed entry. */
export function localUiAssets(entries: unknown): LocalUiAssets {
  if (!Array.isArray(entries)) throw new Error('local UI bundle: not a list');
  const files = new Map<string, Uint8Array>();
  for (const entry of entries as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('local UI bundle: bad entry');
    const [name, data] = entry as unknown[];
    if (typeof name !== 'string' || typeof data !== 'string' || !BASE64URL.test(data)) {
      throw new Error('local UI bundle: bad entry');
    }
    files.set(name, data === '' ? new Uint8Array(0) : decodeBase64url(data));
  }
  // The server checks every name and type again before it listens (approval-server.ts).
  return { files };
}

/** The bundle embedded in this build, or an empty one. */
export function embeddedLocalUiAssets(): LocalUiAssets {
  return localUiAssets(typeof __AGENTLINK_LOCAL_UI__ === 'undefined' ? [] : __AGENTLINK_LOCAL_UI__);
}
