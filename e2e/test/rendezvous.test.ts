// OPS-CI-7: the invite hand-over between the two runners fails closed.
import { describe, expect, it } from 'vitest';
import { open, seal } from '../src/rendezvous.mjs';

const text = Buffer.from('https://agentlink.4thtech.io/i#abc');

describe('rendezvous seal', () => {
  it('round-trips', () => {
    expect(open(seal(text, 'key', '1:1'), 'key', '1:1').equals(text)).toBe(true);
  });
  it('uses a fresh nonce each time', () => {
    expect(seal(text, 'key', '1:1').equals(seal(text, 'key', '1:1'))).toBe(false);
  });
  it('fails closed on a wrong key, a wrong salt, a changed byte and a short file', () => {
    const sealed = seal(text, 'key', '1:1');
    expect(() => open(sealed, 'other', '1:1')).toThrow();
    expect(() => open(sealed, 'key', '1:2')).toThrow();
    const bent = Buffer.from(sealed);
    bent[14] = (bent[14] ?? 0) ^ 1;
    expect(() => open(bent, 'key', '1:1')).toThrow();
    expect(() => open(sealed.subarray(0, 20), 'key', '1:1')).toThrow();
  });
});
