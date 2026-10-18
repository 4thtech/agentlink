// TTY and harness-marker guards (04 §2.5, §2.8; 06 §8). UX guards, not a boundary.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HARNESS_MARKERS, checkOwnerTerminal, harnessMarkerSet, isInteractive } from './guards.js';

const tty = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };

describe('terminal guards', () => {
  it('an interactive terminal has both stdin and stdout on a TTY', () => {
    expect(isInteractive(tty)).toBe(true);
    expect(isInteractive({ ...tty, stdinIsTTY: false })).toBe(false);
    expect(isInteractive({ ...tty, stdoutIsTTY: false })).toBe(false);
  });

  it('every harness marker, set to a non-empty value, is detected', () => {
    for (const marker of HARNESS_MARKERS) {
      expect(harnessMarkerSet({ [marker]: '1' })).toBe(true);
      expect(harnessMarkerSet({ [marker]: '' })).toBe(false);
    }
    expect(harnessMarkerSet({ PATH: '/usr/bin' })).toBe(false);
  });

  it('owner commands need an interactive terminal and no harness marker', () => {
    expect(checkOwnerTerminal(tty)).toEqual({ ok: true });
    expect(checkOwnerTerminal({ ...tty, stdinIsTTY: false })).toEqual({
      ok: false,
      reason: 'not_interactive',
    });
    expect(checkOwnerTerminal({ ...tty, env: { CLAUDECODE: '1' } })).toEqual({
      ok: false,
      reason: 'harness_detected',
    });
  });

  it('the marker list matches the one @4thtech-io/node uses for the owner prompt', () => {
    // The node package does not export its list; this keeps the two in step by reading its source.
    const source = readFileSync(
      fileURLToPath(new URL('../../../../packages/node/src/owner-terminal.ts', import.meta.url)),
      'utf8',
    );
    const block = /HARNESS_MARKERS[^=]*=\s*Object\.freeze\(\[([^\]]*)\]/.exec(source)?.[1] ?? '';
    const names = [...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect([...HARNESS_MARKERS]).toEqual(names);
  });
});
