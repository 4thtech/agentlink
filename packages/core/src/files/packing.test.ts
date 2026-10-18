// M1-7f: inline packing under the payload cap (04 §3.4, G-27, D-85) and the "cannot fit" check
// before any upload (IR-M1-6c-1 L2).
import { canonicalize, encodeUtf8, type JsonValue } from '@4thtech-io/crypto';
import { PAYLOAD_MAX_BYTES, alf1CiphertextSize } from '@4thtech-io/storage';
import { describe, expect, it } from 'vitest';
import { measurePayload, planPacking, type PackingFile } from './packing.js';

const base = { type: 'text', body: 'here you go', replyTo: null } as const;
const DROP_URL = 120;
const file = (size: number, name = 'f.bin'): PackingFile => ({
  name,
  mime: 'application/octet-stream',
  size,
  storedUrlLength: DROP_URL,
  expiresAt: 1_800_604_800,
});

/** The bytes the core would encrypt for that plan, built the long way. */
function serialized(files: readonly PackingFile[], inline: readonly boolean[]): number {
  const entries = files.map((f, i) => {
    const ct = alf1CiphertextSize(f.size);
    return {
      name: f.name,
      size: f.size,
      mime: f.mime,
      plaintextSha256: 'a'.repeat(64),
      ciphertextSha256: 'b'.repeat(64),
      inline: inline[i] === true ? 'A'.repeat(Math.ceil((ct * 4) / 3)) : null,
      url: inline[i] === true ? null : 'h'.repeat(f.storedUrlLength),
      fileKey: 'k'.repeat(43),
      expiresAt: f.expiresAt,
    };
  });
  const payload = { ...base, files: entries } as unknown as JsonValue;
  return encodeUtf8(canonicalize(payload)).length;
}

describe('measurePayload (04 §3.4: the exact bytes encrypted into aead.ct)', () => {
  it('counts inline ciphertext as base64url and a stored file at its backend URL length', () => {
    const files = [file(100), file(5_000, 'Poročilo "č".pdf'), file(40_000)];
    for (const inline of [
      [true, true, false],
      [false, true, false],
      [false, false, false],
    ]) {
      expect(measurePayload(base, files, inline)).toBe(serialized(files, inline));
    }
  });
});

describe('planPacking (G-27, D-85)', () => {
  it('keeps every eligible file inline when the payload fits', () => {
    const plan = planPacking(base, [file(1_000), file(2_000), file(20_000)]);
    expect(plan).toEqual({ fits: true, inline: [true, true, false] });
  });

  it('moves the largest inline file first, and on a tie the highest index', () => {
    // Three files of 6 000 bytes (about 8 KiB of base64url each): only one fits next to the others
    // stored. The tie moves index 2, then index 1.
    const plan = planPacking(base, [file(6_000), file(6_000), file(6_000)]);
    expect(plan).toEqual({ fits: true, inline: [true, false, false] });

    // Distinct sizes: the larger one moves even though it comes first.
    const sized = planPacking(base, [file(12_000), file(6_000), file(4_000)]);
    expect(sized.fits).toBe(true);
    if (sized.fits) {
      expect(sized.inline).toEqual([false, true, true]);
      expect(
        measurePayload(base, [file(12_000), file(6_000), file(4_000)], sized.inline),
      ).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
    }
  });

  it('refuses before any upload when even the all-stored plan is over the cap (IR-M1-6c-1 L2)', () => {
    // 16 stored files with long names and the longest URLs: the all-stored payload is over 17 136.
    const long = 'n'.repeat(250);
    const files = Array.from({ length: 16 }, () => ({
      ...file(50_000, long),
      storedUrlLength: 2_048,
    }));
    expect(
      measurePayload(
        base,
        files,
        files.map(() => false),
      ),
    ).toBeGreaterThan(PAYLOAD_MAX_BYTES);
    expect(planPacking(base, files)).toEqual({ fits: false });
  });

  it('refuses when the message body leaves no room for even the stored entries', () => {
    const big = { ...base, body: 'x'.repeat(16_900) };
    expect(planPacking(big, [file(100)])).toEqual({ fits: false });
  });

  it('refuses more than 16 files', () => {
    expect(() =>
      planPacking(
        base,
        Array.from({ length: 17 }, () => file(10)),
      ),
    ).toThrow();
  });
});
