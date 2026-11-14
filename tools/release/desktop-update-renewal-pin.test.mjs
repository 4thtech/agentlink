import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAsar, main, pinOf } from './desktop-update-renewal-pin.mjs';

const pin = '7'.repeat(64);
const other = 'a'.repeat(64);

describe('renewal pin check', () => {
  it('accepts an asar that carries the pin', () => {
    expect(() => checkAsar(Buffer.from(`xx${pin}yy`), pin, 'z.zip')).not.toThrow();
  });
  it('fails closed for another key, updates-off, or the placeholder', () => {
    expect(() => checkAsar(Buffer.from(`xx${other}`), pin, 'z.zip')).toThrow(/does not carry/);
    expect(() =>
      checkAsar(Buffer.from(`${pin} AGENTLINK-DESKTOP-UPDATES-OFF`), pin, 'z.zip'),
    ).toThrow(/updates-off/);
    expect(() =>
      checkAsar(Buffer.from(`${pin} PLACEHOLDER-AGENTLINK-DESKTOP-ROOT-KEY`), pin, 'z.zip'),
    ).toThrow(/placeholder/);
  });
  it('pinOf refuses a bad root-key.json', () => {
    expect(pinOf(JSON.stringify({ rootPublicKey: pin }))).toBe(pin);
    expect(() => pinOf('{"rootPublicKey":"PLACEHOLDER"}')).toThrow();
    expect(() => pinOf('nope')).toThrow();
  });
  it('main checks both zips and exits 1 on any failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pin-'));
    const rk = join(dir, 'root-key.json');
    writeFileSync(rk, JSON.stringify({ rootPublicKey: pin, minimumStatementSequence: 0 }));
    const lines = [];
    const out = (l) => lines.push(l);
    const args = ['--root-key', rk, '--zip', 'a-arm64.zip', '--zip', 'a-x64.zip'];
    expect(main(args, { out, readAsar: () => Buffer.from(pin) })).toBe(0);
    expect(main(args, { out, readAsar: (z) => Buffer.from(z.includes('x64') ? other : pin) })).toBe(
      1,
    );
    expect(lines.at(-1)).toMatch(/^::error::a-x64\.zip does not carry/);
    expect(
      main(['--root-key', rk, '--zip', 'one.zip'], { out, readAsar: () => Buffer.from(pin) }),
    ).toBe(1);
  });
});
