// REL051-SF1: the store of presence ceremonies (presence-ceremony.ts): bound to one page session and
// one request, single use, short-lived, wiped when gone.
import { encodeUtf8, equalBytes } from '@4thtech-io/crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_PRESENCE_CEREMONIES,
  PRESENCE_CEREMONY_TTL_MS,
  PresenceCeremonies,
  presenceBinding,
} from './presence-ceremony.js';

const A = encodeUtf8('session-a');
const B = encodeUtf8('session-b');
const bindingOf = (target: string, input?: string): Uint8Array =>
  presenceBinding({ method: 'POST', target, input, items: undefined, digest: undefined });

const clock = (): { now: () => number; advance: (ms: number) => void } => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => void (t += ms) };
};

describe('presenceBinding', () => {
  it('differs for another method, path, input, items or digest', () => {
    const base = { method: 'POST', target: '/a', input: 'x', items: 'i', digest: 'd' };
    const all = [
      base,
      { ...base, method: 'PUT' },
      { ...base, target: '/b' },
      { ...base, target: '/a?x=1' },
      { ...base, input: 'y' },
      { ...base, input: undefined },
      { ...base, items: undefined },
      { ...base, digest: 'e' },
    ].map((p) => presenceBinding(p));
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        expect(equalBytes(all[i] as Uint8Array, all[j] as Uint8Array)).toBe(false);
      }
    }
  });
});

describe('PresenceCeremonies', () => {
  it('issues a fresh 32-byte challenge per ceremony', () => {
    const c = new PresenceCeremonies(clock().now);
    const one = c.issue(A, bindingOf('/a'));
    const two = c.issue(A, bindingOf('/a'));
    expect(one.challenge).toHaveLength(32);
    expect(one.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(one.id).not.toBe(two.id);
    expect(equalBytes(one.challenge, two.challenge)).toBe(false);
  });

  it('is taken once', () => {
    const c = new PresenceCeremonies(clock().now);
    const one = c.issue(A, bindingOf('/a'));
    const taken = c.take(one.id, A, bindingOf('/a'));
    expect(typeof taken).toBe('object');
    expect(c.take(one.id, A, bindingOf('/a'))).toBe('unknown');
  });

  it('another binding is a mismatch and spends it', () => {
    const c = new PresenceCeremonies(clock().now);
    const one = c.issue(A, bindingOf('/a'));
    expect(c.take(one.id, A, bindingOf('/b'))).toBe('mismatch');
    expect(c.take(one.id, A, bindingOf('/a'))).toBe('unknown');
  });

  it("another session neither sees nor spends it", () => {
    const c = new PresenceCeremonies(clock().now);
    const one = c.issue(A, bindingOf('/a'));
    expect(c.take(one.id, B, bindingOf('/a'))).toBe('unknown');
    expect(typeof c.take(one.id, A, bindingOf('/a'))).toBe('object');
  });

  it('expires after the TTL', () => {
    const t = clock();
    const c = new PresenceCeremonies(t.now);
    const one = c.issue(A, bindingOf('/a'));
    t.advance(PRESENCE_CEREMONY_TTL_MS);
    expect(c.take(one.id, A, bindingOf('/a'))).toBe('expired');
    expect(c.size).toBe(0);
  });

  it('keeps at most MAX_PRESENCE_CEREMONIES; the oldest goes', () => {
    const c = new PresenceCeremonies(clock().now);
    const first = c.issue(A, bindingOf('/a'));
    for (let i = 0; i < MAX_PRESENCE_CEREMONIES; i += 1) c.issue(A, bindingOf('/a'));
    expect(c.size).toBe(MAX_PRESENCE_CEREMONIES);
    expect(c.take(first.id, A, bindingOf('/a'))).toBe('unknown');
  });

  it('sweeps closed sessions, clears and wipes', () => {
    const c = new PresenceCeremonies(clock().now);
    const one = c.issue(A, bindingOf('/a'));
    c.issue(B, bindingOf('/a'));
    c.sweep((s) => equalBytes(s, B));
    expect(c.size).toBe(1);
    expect(one.challenge.every((b) => b === 0)).toBe(true);
    c.clear();
    expect(c.size).toBe(0);
  });

  it('rejects malformed IDs', () => {
    const c = new PresenceCeremonies(clock().now);
    expect(c.take(undefined, A, bindingOf('/a'))).toBe('unknown');
    expect(c.take('../x', A, bindingOf('/a'))).toBe('unknown');
  });
});
