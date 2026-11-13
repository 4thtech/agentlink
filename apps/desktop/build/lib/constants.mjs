// Loads the one constants file (../constants.json). No other module hard-codes a version or hash.
import { readFileSync } from 'node:fs';

export const constants = JSON.parse(
  readFileSync(new URL('../constants.json', import.meta.url), 'utf8'),
);

/** The pinned asset of `kind` ('node' | 'electron') for `platform` ('darwin-arm64' | 'darwin-x64' | 'win32-x64'). */
export function assetFor(kind, platform) {
  const a = constants[kind]?.assets?.[platform];
  if (!a) throw new Error(`No pinned ${kind} asset for ${platform}.`);
  return a;
}
