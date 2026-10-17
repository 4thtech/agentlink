// Guard for the secret-scan stub on the orphan `sync` branch (OPS-CI-4).
//
// The stub calls the reusable workflow on main at a pinned commit SHA. The reusable workflow loads
// .gitleaks.toml from main at run time, so a pin that predates the last change to
// `.github/workflows/secret-scan.yml` or `.gitleaks.toml` runs the OLD workflow against the
// CURRENT config, and every sync push can fail (or be scanned by outdated logic). This check fails
// when the pinned SHA is not equal to, or a descendant of, the last main commit that changed
// either file. Pure functions plus thin git wrappers; no network access beyond what the caller
// fetched, no secrets.

import { execFileSync } from 'node:child_process';

export const WATCHED_PATHS = ['.github/workflows/secret-scan.yml', '.gitleaks.toml'];

const USES_RE =
  /^\s*uses:\s*4thtech\/agentlink\/\.github\/workflows\/secret-scan\.yml@([0-9a-f]{40})(?=\s|$)/m;

/** The 40-char SHA the stub pins, or null. Comment lines never match (the regex is anchored on `uses:`). */
export function parsePin(text) {
  const match = USES_RE.exec(text);
  return match ? match[1] : null;
}

const short = (sha) => sha.slice(0, 12);

export function evaluatePin({ pin, required, isAncestor }) {
  if (!pin) {
    return {
      ok: false,
      message:
        'The sync stub does not call secret-scan.yml at a full 40-character commit SHA (@<sha>).',
    };
  }
  if (pin === required || isAncestor(required, pin)) {
    return {
      ok: true,
      message: `The sync stub pin ${short(pin)} is current (needs ${short(required)} or later).`,
    };
  }
  return {
    ok: false,
    message: `The sync stub pins ${short(pin)}, which predates ${short(required)}, the last main commit that changed ${WATCHED_PATHS.join(' or ')}. Re-pin the stub on sync (docs/process/sync-protocol.md, "Re-pinning the secret-scan stub").`,
  };
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** `ancestor` is an ancestor of `descendant`. Exit 1 means no; an unknown object also counts as no. */
function isAncestorIn(cwd) {
  return (ancestor, descendant) => {
    try {
      git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * runCheck({ cwd, mainRef, readStub }) -> { ok, message, notice? }
 * readStub() returns the stub text, or null when the sync branch or file does not exist.
 */
export function runCheck({ cwd, mainRef = 'origin/main', readStub }) {
  const text = readStub();
  if (text === null || text === undefined) {
    return {
      ok: true,
      message: 'No sync stub to check.',
      notice:
        'The sync branch or its .github/workflows/secret-scan.yml does not exist; nothing to check.',
    };
  }
  // `:(top)` makes the pathspecs repository-relative, whatever directory the script runs from.
  const required = git(cwd, [
    'log',
    '-1',
    '--format=%H',
    mainRef,
    '--',
    ...WATCHED_PATHS.map((p) => `:(top)${p}`),
  ]);
  if (!required) {
    return {
      ok: true,
      message: 'No watched file has history on main.',
      notice: 'No history for the watched files.',
    };
  }
  return evaluatePin({ pin: parsePin(text), required, isAncestor: isAncestorIn(cwd) });
}

/** Read the stub from a fetched remote ref; null when the branch or file is absent. */
export function readStubFromRef(cwd, ref = 'origin/sync') {
  try {
    return git(cwd, ['show', `${ref}:.github/workflows/secret-scan.yml`]);
  } catch {
    return null;
  }
}
