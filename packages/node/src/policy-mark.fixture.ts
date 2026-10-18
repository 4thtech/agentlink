// M1-8g: the PolicyVersionMark contract (04 §2.5.1; 07 §3.4; 06 §3 G-6), run against every Node
// backend of the mark. M1-8g runs it against the keychain item; M1-8f runs it against the `ALKS`
// entry `policy-version` of the file KeyStore. Not part of the build (tsconfig.json excludes
// *.fixture.ts).
import type { PolicyVersionMark } from '@4thtech-io/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** The value spellings the mark item refuses (04 §2.2, §2.8: canonical ASCII decimal). */
export const MALFORMED_MARK_VALUES: readonly (readonly [string, Uint8Array])[] = [
  ['empty', new Uint8Array(0)],
  ['leading zero', ascii('05')],
  ['double zero', ascii('00')],
  ['sign', ascii('+5')],
  ['negative', ascii('-1')],
  ['space before', ascii(' 5')],
  ['newline after', ascii('5\n')],
  ['fraction', ascii('5.0')],
  ['exponent', ascii('5e0')],
  ['hex', ascii('0x5')],
  ['2^53', ascii('9007199254740992')],
  ['17 digits', ascii('10000000000000000')],
  ['non-ASCII digit', Uint8Array.from([0xd9, 0xa5])],
  ['NUL', Uint8Array.from([0x35, 0x00])],
  ['binary', Uint8Array.from([0xff, 0xfe, 0x01])],
];

export function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/** One backend of the mark, as the contract drives it. */
export interface MarkHarness {
  /** A new mark over the same item and lock, as another process would open it. */
  open(): PolicyVersionMark;
  /** The stored item's bytes, or null when there is none (what a same-user script reads). */
  raw(): Promise<Uint8Array | null>;
  /** Writes or deletes the item directly, outside the lock (a same-user script). */
  plant(value: Uint8Array | null): Promise<void>;
  /**
   * Makes the backend fail: `read` rejects every item read, `write` rejects every write, `lost-write`
   * accepts writes that do not stick. `none` restores it.
   */
  fault(kind: 'none' | 'read' | 'write' | 'lost-write'): void;
  /** Delays the item write of a given value by the returned milliseconds (to interleave racers). */
  delayWrites(delay: (value: Uint8Array) => number): void;
  /** How many item writes reached the backend so far. */
  writes(): number;
  /** Holds the inter-process lock until the returned release is called. */
  holdLock(): Promise<() => void>;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

/** The contract every Node mark backend passes. */
export function describePolicyMarkContract(name: string, make: () => Promise<MarkHarness>): void {
  describe(`PolicyVersionMark contract: ${name}`, () => {
    let h: MarkHarness;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.close();
    });

    it('reads 0 when no version was ever applied, and writes nothing to read it', async () => {
      expect(await h.open().read()).toBe(0);
      expect(await h.raw()).toBeNull();
      expect(h.writes()).toBe(0);
    });

    it('raises to the version, stores it as canonical ASCII decimal and returns the new mark', async () => {
      const mark = h.open();
      expect(await mark.raise(5)).toBe(5);
      expect(await h.raw()).toEqual(ascii('5'));
      expect(await mark.read()).toBe(5);
      expect(await mark.raise(9_007_199_254_740_991)).toBe(9_007_199_254_740_991);
      expect(await h.raw()).toEqual(ascii('9007199254740991'));
    });

    it('is monotonic: a lower or equal version changes nothing and writes nothing', async () => {
      const mark = h.open();
      await mark.raise(7);
      const before = h.writes();
      expect(await mark.raise(3)).toBe(7);
      expect(await mark.raise(7)).toBe(7);
      expect(await mark.raise(0)).toBe(7);
      expect(h.writes()).toBe(before);
      expect(await mark.read()).toBe(7);
      expect(await h.raw()).toEqual(ascii('7'));
    });

    it('survives a restart: a mark opened later reads the raised version', async () => {
      await h.open().raise(12);
      const later = h.open();
      expect(await later.read()).toBe(12);
      expect(await later.raise(4)).toBe(12);
    });

    it('refuses a version that is not an integer in [0, 2^53 - 1], writing nothing', async () => {
      const mark = h.open();
      await mark.raise(2);
      const before = h.writes();
      for (const bad of [-1, 1.5, Number.NaN, Infinity, 2 ** 53, '3', null, undefined, 3n]) {
        const error = await rejection(mark.raise(bad as unknown as number));
        expect(codeOf(error), String(bad)).toBe('policy_version_invalid');
      }
      expect(h.writes()).toBe(before);
      expect(await mark.read()).toBe(2);
    });

    it('never reads a malformed item as 0 or as a number, and never overwrites it', async () => {
      for (const [label, value] of MALFORMED_MARK_VALUES) {
        await h.plant(value);
        const mark = h.open();
        expect(codeOf(await rejection(mark.read())), label).toBe('policy_mark_invalid');
        expect(codeOf(await rejection(mark.raise(50))), label).toBe('policy_mark_invalid');
        expect(await h.raw(), label).toEqual(value);
      }
    });

    it('a malformed item error names no value (I-7)', async () => {
      await h.plant(ascii('31337x'));
      const error = await rejection(h.open().read());
      expect(String((error as Error).message)).not.toContain('31337');
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    });

    it('an unreadable item rejects read and raise (fail closed), never 0', async () => {
      const mark = h.open();
      await mark.raise(4);
      h.fault('read');
      await expect(mark.read()).rejects.toThrow();
      await expect(mark.raise(9)).rejects.toThrow();
      h.fault('none');
      expect(await mark.read()).toBe(4);
    });

    it('a failed write rejects raise and leaves the earlier mark', async () => {
      const mark = h.open();
      await mark.raise(4);
      h.fault('write');
      await expect(mark.raise(9)).rejects.toThrow();
      h.fault('none');
      expect(await mark.read()).toBe(4);
    });

    it('a write that does not stick is caught by the read-back: raise rejects', async () => {
      const mark = h.open();
      await mark.raise(4);
      h.fault('lost-write');
      const error = await rejection(mark.raise(9));
      expect(codeOf(error)).toBe('policy_mark_not_raised');
      h.fault('none');
      expect(await mark.read()).toBe(4);
    });

    it('two processes raising concurrently end at the larger version (the lower write lands last without the lock)', async () => {
      // The lower version's write is slow, so without the lock both read 0 and the 3 lands after the 7.
      h.delayWrites((value) => (value.length === 1 && value[0] === 0x33 ? 60 : 0));
      const a = h.open();
      const b = h.open();
      const first = a.raise(3);
      await sleep(5);
      const results = await Promise.all([first, b.raise(7)]);
      expect(results[1]).toBe(7);
      expect(await h.open().read()).toBe(7);
      expect(await h.raw()).toEqual(ascii('7'));
    });

    it('many concurrent raises from separate marks end at the maximum', async () => {
      h.delayWrites(() => Math.floor(Math.random() * 8));
      const versions = Array.from({ length: 12 }, () => 1 + Math.floor(Math.random() * 1000));
      await Promise.all(versions.map((v) => h.open().raise(v)));
      expect(await h.open().read()).toBe(Math.max(...versions));
    });

    it('raise waits for the inter-process lock; a holder never sees a half-done raise', async () => {
      const release = await h.holdLock();
      let settled = false;
      const raising = h
        .open()
        .raise(6)
        .finally(() => {
          settled = true;
        });
      await sleep(80);
      expect(settled).toBe(false);
      expect(await h.raw()).toBeNull();
      release();
      expect(await raising).toBe(6);
    });

    it('a mark deleted by a same-user script reads 0 (the core then fails closed when a row exists)', async () => {
      await h.open().raise(8);
      await h.plant(null);
      expect(await h.open().read()).toBe(0);
    });

    it('offers no way to lower the mark: only read and raise', async () => {
      const mark = h.open();
      await mark.raise(5);
      const loose = mark as unknown as Record<string, unknown>;
      for (const method of ['set', 'write', 'lower', 'reset', 'delete', 'clear']) {
        expect(loose[method], method).toBeUndefined();
      }
      expect(await mark.read()).toBe(5);
    });
  });
}
