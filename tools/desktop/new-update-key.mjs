#!/usr/bin/env node
// UPD-KEYTOOL (D-151, owner decision 2026-11-13): creates the ONE desktop update key. Owner guide:
// docs/runbooks/desktop-update-keys.md (RB-23).
//
//   node tools/desktop/new-update-key.mjs --out <file>
//
// - Run by the owner on his own computer. It refuses to run when CI or GITHUB_ACTIONS is set.
// - All crypto is @4thtech-io/crypto (random bytes, BIP-340 public key). No network module.
// - Writes ONLY the private key (64 lowercase hex and a newline) to a NEW file with mode 0600; it never
//   overwrites. Prints only the public key, its key id and the exact next steps. The private key is
//   never printed, logged or put in an error.
import { chmodSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { encodeHex, randomBytes, wipe } from '@4thtech-io/crypto';
import { bip340PublicKey } from '@4thtech-io/crypto/keystore';

export class ToolError extends Error {}

/** The key id in the update document name (release.yml, the app's documentUrl): first 16 hex. */
export const KEY_ID_LENGTH = 16;

const USAGE = 'Usage: node tools/desktop/new-update-key.mjs --out <new file>';

/** What the owner does next; `{file}`, `{publicKey}` and `{keyId}` are filled in. */
export const NEXT_STEPS = Object.freeze([
  'Next steps:',
  '1. GitHub: Settings > Environments > desktop-update > Environment secrets > Add secret. Name: DESKTOP_UPDATE_KEY. Value: the one line in {file} (open it in a text editor and copy it; do not paste it anywhere else).',
  '2. Check the environment desktop-update: Required reviewers = you, Deployment branches = main only.',
  '3. Pin the public key with a pull request: set "rootPublicKey" in apps/desktop/src/main/updater/root-key.json to {publicKey} (ask the orchestrator; you compare the 64 characters before you say "merge").',
  '4. Then delete {file} (rm -P {file}), or move it to an offline USB stick if you want a copy. Nothing else needs it.',
  'The update document of this key is named desktop-update-{keyId}.json.',
]);

/** This tool never runs on a CI runner: any non-empty CI or GITHUB_ACTIONS stops it. */
export function refuseInCi(env = process.env) {
  if ((env.CI ?? '') !== '' || (env.GITHUB_ACTIONS ?? '') !== '') {
    throw new ToolError(
      'This tool is for the owner computer only. It does not run in CI (CI or GITHUB_ACTIONS is set).',
    );
  }
}

/**
 * Draws a new key, writes its private half to `out` (new file, 0600) and returns only
 * `{publicKey, keyId}`. The secret bytes are wiped before returning.
 */
export async function createUpdateKey({ out }) {
  let secret;
  let publicKey;
  for (;;) {
    secret = randomBytes(32);
    try {
      publicKey = encodeHex(bip340PublicKey(secret));
      break;
    } catch {
      wipe(secret); // 0 or >= n: astronomically rare, draw again
    }
  }
  try {
    try {
      writeFileSync(out, `${encodeHex(secret)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new ToolError(`${out} already exists; choose a new file name (nothing was written)`);
      }
      throw new ToolError(`cannot write ${out} (nothing was written)`);
    }
    // The umask can only remove bits; set 0600 exactly anyway.
    chmodSync(out, 0o600);
  } finally {
    wipe(secret);
  }
  return Object.freeze({ publicKey, keyId: publicKey.slice(0, KEY_ID_LENGTH) });
}

export async function main(argv, { env = process.env, out = (line) => console.log(line) } = {}) {
  refuseInCi(env);
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { out: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new ToolError(USAGE);
  }
  if (typeof values.out !== 'string' || values.out === '') throw new ToolError(USAGE);
  const file = values.out;
  const { publicKey, keyId } = await createUpdateKey({ out: file });
  out(`Wrote the private update key to ${file} (only you can read it).`);
  out(`Public key (pin this one): ${publicKey}`);
  out('');
  for (const line of NEXT_STEPS) {
    out(
      line
        .replaceAll('{file}', file)
        .replaceAll('{publicKey}', publicKey)
        .replaceAll('{keyId}', keyId),
    );
  }
}

// Run only as a script, never on import (the tests import the functions).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof ToolError ? error.message : 'Unexpected error; nothing was written.'}\n`,
    );
    process.exitCode = 1;
  });
}
