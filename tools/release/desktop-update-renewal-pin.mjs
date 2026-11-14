#!/usr/bin/env node
// P2-RENEW-PIN (IR-UPD-8-1 R2-1): a renewal has no build records, so before the key signs anything it
// looks INSIDE each Mac zip on the Release: the app.asar must be an updates-ON build that carries
// exactly the key pinned in root-key.json (main's), no updates-off mark and no placeholder. Fails
// closed with fixed sentences. No network, no secrets.
//
//   desktop-update-renewal-pin.mjs --root-key <root-key.json> --zip <mac.zip> [--zip <mac.zip> ...]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export class RenewalPinError extends Error {}

const HEX32 = /^[0-9a-f]{64}$/;
const UPDATES_OFF_MARK = 'AGENTLINK-DESKTOP-UPDATES-OFF';
const PLACEHOLDER_MARK = 'PLACEHOLDER-AGENTLINK-DESKTOP-ROOT-KEY';
const ASAR_IN_ZIP = 'AgentLink.app/Contents/Resources/app.asar';

const fail = (why) => {
  throw new RenewalPinError(`${why}. Nothing is signed; ship a release instead of renewing.`);
};

/** The pinned key from root-key.json text. */
export function pinOf(rootKeyText) {
  let key;
  try {
    key = JSON.parse(rootKeyText)?.rootPublicKey;
  } catch {
    fail('root-key.json is not JSON');
  }
  if (typeof key !== 'string' || !HEX32.test(key))
    fail('root-key.json has no real update key pinned');
  return key;
}

/** `asar`: Buffer of one app.asar; `label`: the zip name for messages. */
export function checkAsar(asar, pin, label) {
  if (asar.includes(Buffer.from(PLACEHOLDER_MARK)))
    fail(`${label} carries the root key placeholder`);
  if (asar.includes(Buffer.from(UPDATES_OFF_MARK))) fail(`${label} is an updates-off build`);
  if (!asar.includes(Buffer.from(pin))) {
    fail(`${label} does not carry the update key pinned in root-key.json`);
  }
}

function asarOf(zip) {
  try {
    const names = execFileSync('unzip', ['-Z1', zip], { maxBuffer: 64 * 1024 * 1024 })
      .toString('utf8')
      .split('\n')
      .filter((n) => n === ASAR_IN_ZIP);
    if (names.length !== 1)
      return fail(`${zip.split('/').pop()} must hold exactly one ${ASAR_IN_ZIP}`);
    return execFileSync('unzip', ['-p', zip, ASAR_IN_ZIP], { maxBuffer: 1024 * 1024 * 1024 });
  } catch (error) {
    if (error instanceof RenewalPinError) throw error;
    return fail(`Cannot read app.asar from ${zip.split('/').pop()}`);
  }
}

export const readAsarFromZip = asarOf;

export function main(argv, { out = (l) => console.log(l), readAsar = asarOf } = {}) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { 'root-key': { type: 'string' }, zip: { type: 'string', multiple: true } },
      strict: true,
      allowPositionals: false,
    });
    const zips = values.zip ?? [];
    if (typeof values['root-key'] !== 'string' || zips.length !== 2) {
      return fail('Usage: --root-key <file> and exactly two --zip (arm64 and x64)');
    }
    const pin = pinOf(readFileSync(values['root-key'], 'utf8'));
    for (const zip of zips) checkAsar(readAsar(zip), pin, zip.split('/').pop());
  } catch (error) {
    out(`::error::${error instanceof RenewalPinError ? error.message : 'Unexpected error.'}`);
    return 1;
  }
  out('Both Mac apps are updates-on builds that carry the update key pinned in root-key.json.');
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
