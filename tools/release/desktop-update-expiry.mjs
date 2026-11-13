#!/usr/bin/env node
// UPD-3 (D-151): the renewal warning for the signed desktop update manifest. Run daily by
// .github/workflows/desktop-update-expiry.yml with no secret and read-only permissions. A manifest is
// valid for at most 31 days; when the one on the latest Release expires within --warn-days (7), the
// run goes red, so the owner gets GitHub's failure notice in time to renew (RB-23 "Renew").
//
//   desktop-update-expiry.mjs --root-key <root-key.json> (--file <desktop-update.json> | --missing) [--warn-days 7]
//
// While root-key.json holds no real key (updates off), there is nothing to renew: it passes.
// It reads only `expires`; it checks no signature (the app does). No network, no crypto.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const DAY = 86_400_000;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const HEX32 = /^[0-9a-f]{64}$/;

export const RENEW =
  'Renew it: ship a release, or run Actions > "Desktop update renew" (desktop-update-renew.yml) on main and approve it (docs/runbooks/desktop-update-keys.md, "Renew").';

/** {level: 'ok'|'warn'|'expired'|'error', message} for the text of desktop-update.json. */
export function expiryStatus(text, now, warnDays) {
  let expires;
  try {
    const value = JSON.parse(text);
    const t = value?.expires;
    if (typeof t !== 'string' || !TIMESTAMP.test(t)) throw new Error('no expires');
    expires = Date.parse(t);
    if (!Number.isFinite(expires)) throw new Error('bad date');
  } catch {
    return {
      level: 'error',
      message: 'desktop-update.json on the latest release cannot be read.',
    };
  }
  const left = expires - now;
  const when = new Date(expires).toISOString().replace('.000Z', 'Z');
  if (left <= 0) {
    return {
      level: 'expired',
      message: `The desktop update manifest expired at ${when}; apps see no updates. ${RENEW}`,
    };
  }
  if (left <= warnDays * DAY) {
    return {
      level: 'warn',
      message: `The desktop update manifest expires at ${when} (in ${Math.ceil(left / DAY)} days). ${RENEW}`,
    };
  }
  return { level: 'ok', message: `The desktop update manifest is valid until ${when}.` };
}

export function main(argv, { now = Date.now(), out = (l) => console.log(l) } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'root-key': { type: 'string' },
      file: { type: 'string' },
      missing: { type: 'boolean' },
      'warn-days': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const warnDays = Number(values['warn-days'] ?? '7');
  if (!Number.isSafeInteger(warnDays) || warnDays < 1 || warnDays > 30) {
    out('::error::--warn-days must be 1 to 30.');
    return 1;
  }
  let pinned;
  try {
    pinned = HEX32.test(JSON.parse(readFileSync(values['root-key'], 'utf8'))?.rootPublicKey ?? '');
  } catch {
    pinned = false;
  }
  if (!pinned) {
    out(
      '::notice::No update key is pinned (updates are off): there is no update manifest to renew.',
    );
    return 0;
  }
  if (values.missing || typeof values.file !== 'string') {
    out(`::error::The latest release has no desktop-update.json; apps see no updates. ${RENEW}`);
    return 1;
  }
  const status = expiryStatus(readFileSync(values.file, 'utf8'), now, warnDays);
  if (status.level === 'ok') {
    out(status.message);
    return 0;
  }
  out(`::${status.level === 'warn' ? 'warning' : 'error'}::${status.message}`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch {
    console.log(
      '::error::Usage: desktop-update-expiry.mjs --root-key <file> (--file <file> | --missing) [--warn-days 7]',
    );
    process.exitCode = 1;
  }
}
