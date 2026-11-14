import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAsar, main, pinOf, readAsarFromZip } from './desktop-update-renewal-pin.mjs';

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

  describe('real unzip path', () => {
    const A = 'AgentLink.app/Contents/Resources/app.asar';
    const make = (entries) => {
      const dir = mkdtempSync(join(tmpdir(), 'zip-'));
      const zip = join(dir, 'x.zip');
      for (const [name, text] of entries) {
        const f = join(dir, 'stage', name);
        mkdirSync(join(f, '..'), { recursive: true });
        writeFileSync(f, text);
      }
      const names = entries.map(([n]) => n);
      execFileSync('zip', ['-q', '-X', zip, ...names], { cwd: join(dir, 'stage') });
      return zip;
    };
    it('passes with exactly one asar that carries the pin', () => {
      expect(readAsarFromZip(make([[A, `k${pin}`]])).toString()).toContain(pin);
    });
    it('ignores a nested asar: the main one is checked, so a pin only in the nested one fails', () => {
      const nested = 'AgentLink.app/Contents/Frameworks/X.app/Contents/Resources/app.asar';
      const asar = readAsarFromZip(
        make([
          [A, 'no pin'],
          [nested, pin],
        ]),
      );
      expect(() => checkAsar(asar, pin, 'x.zip')).toThrow(/does not carry/);
    });
    it('fails with no asar or a duplicate entry name', () => {
      expect(() => readAsarFromZip(make([['AgentLink.app/other', 'x']]))).toThrow(/exactly one/);
      const a = make([[A, 'one']]);
      const b = make([[A, `two${pin}`]]);
      const cat = join(mkdtempSync(join(tmpdir(), 'cat-')), 'c.zip');
      writeFileSync(cat, Buffer.concat([readFileSync(a), readFileSync(b)]));
      expect(() => readAsarFromZip(cat)).toThrow();
    });
  });
});
