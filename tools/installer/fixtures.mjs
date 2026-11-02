// Shared by the installer tests (INSTALLER-1).
import { existsSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** The Node.js version both installers pin. */
export const NODE_VERSION = '22.23.4';

/**
 * Lines of https://nodejs.org/dist/v22.23.4/SHASUMS256.txt for the archives the installers use. The
 * file's clear-signed copy (SHASUMS256.txt.asc) was verified with gpg against the Node.js release
 * keys (github.com/nodejs/release-keys) when the version was pinned: a good signature by Antoine du
 * Hamel, key 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356. A version bump repeats that check.
 */
export const SIGNED_SHASUMS = Object.freeze({
  'node-v22.23.4-darwin-arm64.tar.gz':
    'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428',
  'node-v22.23.4-darwin-x64.tar.gz':
    'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819',
  'node-v22.23.4-linux-arm64.tar.gz':
    'f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9',
  'node-v22.23.4-linux-x64.tar.gz':
    'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406',
  'node-v22.23.4-win-arm64.zip': 'a8b8cd79cbbb3062435f449591d98dd63730bbbf30ce2d7cc3a6376c236cb111',
  'node-v22.23.4-win-x64.zip': 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20',
});

/** The absolute path of a program on PATH or in the usual folders, or null. */
export function findTool(name) {
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter),
    '/usr/bin',
    '/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export function removeAll(dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
