// M1-6c: storage selection (07 §5.6, 06 §3 `files.storage`, D-48) and inline packing (G-27 option a,
// owner decision 2026-10-18; spec PR in flight): small files go inline first; while the serialized
// payload is above the receiver's 17 136-byte limit (04 §3.1.1), the largest inline file moves to
// storage; a payload still above it after that is refused.
import { describe, expect, it } from 'vitest';
import {
  DROP_MAX_CIPHERTEXT_BYTES,
  INLINE_MAX_CIPHERTEXT_BYTES,
  PAYLOAD_MAX_BYTES,
  StorageError,
  createDropAdapter,
  isInlineEligible,
  planInline,
  resolveStorage,
  selectStorage,
  selectionForError,
  type FilesStorage,
  type StorageAdapter,
  type StorageSelection,
} from './index.js';

const MiB = 1024 * 1024;

describe('selectStorage: the 07 §5.6 table', () => {
  const policies: FilesStorage[] = ['auto', 'own', 'drop'];
  const sizes = {
    within: 5 * MiB,
    above: DROP_MAX_CIPHERTEXT_BYTES + 1,
  } as const;

  const expected = (
    policy: FilesStorage,
    ownConfigured: boolean,
    fits: 'within' | 'above',
  ): StorageSelection => {
    if (policy === 'own')
      return ownConfigured ? { mode: 'own' } : { mode: 'needs_setup', reason: 'no_own_storage' };
    if (policy === 'auto' && ownConfigured) return { mode: 'own' };
    return fits === 'within' ? { mode: 'drop' } : { mode: 'needs_setup', reason: 'size' };
  };

  for (const policy of policies) {
    for (const ownConfigured of [true, false]) {
      for (const fits of ['within', 'above'] as const) {
        it(`${policy} × own ${ownConfigured ? 'configured' : 'none'} × ${fits} the drop limit`, () => {
          expect(selectStorage({ policy, ownConfigured, ciphertextSize: sizes[fits] })).toEqual(
            expected(policy, ownConfigured, fits),
          );
        });
      }
    }
  }

  it('the size limit is inclusive', () => {
    expect(
      selectStorage({
        policy: 'drop',
        ownConfigured: false,
        ciphertextSize: DROP_MAX_CIPHERTEXT_BYTES,
      }),
    ).toEqual({ mode: 'drop' });
  });

  it('a known remaining weekly quota below the size gives needs_setup quota', () => {
    expect(
      selectStorage({
        policy: 'auto',
        ownConfigured: false,
        ciphertextSize: 2 * MiB,
        dropQuotaRemaining: MiB,
      }),
    ).toEqual({ mode: 'needs_setup', reason: 'quota' });
  });

  it('honours a smaller configured drop limit (staging, self-hosting)', () => {
    expect(
      selectStorage({
        policy: 'auto',
        ownConfigured: false,
        ciphertextSize: 2 * MiB,
        dropMaxBytes: MiB,
      }),
    ).toEqual({ mode: 'needs_setup', reason: 'size' });
  });

  it('refuses an unknown policy or a bad size', () => {
    expect(() =>
      selectStorage({ policy: 'cloud' as FilesStorage, ownConfigured: false, ciphertextSize: 1 }),
    ).toThrow(StorageError);
    expect(() =>
      selectStorage({ policy: 'auto', ownConfigured: false, ciphertextSize: 0 }),
    ).toThrow(StorageError);
  });
});

describe('resolveStorage: no silent fallback, and never the drop under own', () => {
  function spyDrop() {
    const requests: string[] = [];
    let built = 0;
    const factory = () => {
      built += 1;
      return createDropAdapter({
        signer: {
          signDropRequest: async () => 'Nostr x',
          getPublicBundle: async () => ({ keyEpoch: 0 }),
        },
        fetch: async (req) => {
          requests.push(req.method);
          return new Response(null, { status: 500 });
        },
      });
    };
    return { factory, requests, built: () => built };
  }
  const own: StorageAdapter = {
    kind: 's3',
    put: async () => ({ kind: 's3', locator: 'x', size: 1, sha256: '0'.repeat(64) }),
    presignGet: async () => 'https://own.example.com/x',
    delete: async () => undefined,
  };

  it('under own the drop is never built or contacted, even when own storage fails', async () => {
    const spy = spyDrop();
    const failingOwn: StorageAdapter = {
      ...own,
      put: async () => {
        throw new StorageError('upload_failed', 'storage upload failed', 500);
      },
    };
    const choice = resolveStorage(
      { policy: 'own', ownConfigured: true, ciphertextSize: 5 * MiB },
      { own: failingOwn, drop: spy.factory },
    );
    expect(choice.adapter).toBe(failingOwn);
    await expect(
      choice.adapter!.put(new Uint8Array(1), { size: 1, expiresAt: new Date(Date.now() + 1e6) }),
    ).rejects.toMatchObject({ code: 'upload_failed' });
    expect(spy.built()).toBe(0);
    expect(spy.requests).toHaveLength(0);

    const none = resolveStorage(
      { policy: 'own', ownConfigured: false, ciphertextSize: 5 * MiB },
      { drop: spy.factory },
    );
    expect(none).toEqual({ selection: { mode: 'needs_setup', reason: 'no_own_storage' } });
    expect(spy.built()).toBe(0);
  });

  it('auto with own storage uses own; without it, the drop', () => {
    const spy = spyDrop();
    expect(
      resolveStorage(
        { policy: 'auto', ownConfigured: true, ciphertextSize: MiB },
        { own, drop: spy.factory },
      ).adapter,
    ).toBe(own);
    expect(spy.built()).toBe(0);
    const viaDrop = resolveStorage(
      { policy: 'auto', ownConfigured: false, ciphertextSize: MiB },
      { drop: spy.factory },
    );
    expect(viaDrop.selection).toEqual({ mode: 'drop' });
    expect(viaDrop.adapter?.kind).toBe('drop');
    expect(spy.built()).toBe(1);
  });

  it('refuses ownConfigured without an own adapter', () => {
    expect(() =>
      resolveStorage({ policy: 'auto', ownConfigured: true, ciphertextSize: MiB }, {}),
    ).toThrow(expect.objectContaining({ code: 'invalid_config' }) as Error);
  });
});

describe('selectionForError: drop refusals (IR-D48-1 F10)', () => {
  it('size and quota limits keep needs_setup', () => {
    expect(selectionForError(new StorageError('needs_setup', 'x', 413, { limit: 'size' }))).toEqual(
      { mode: 'needs_setup', reason: 'size' },
    );
    expect(
      selectionForError(new StorageError('needs_setup', 'x', 403, { limit: 'quota' })),
    ).toEqual({ mode: 'needs_setup', reason: 'quota' });
  });

  it('a busy or unavailable drop is retryable and never needs_setup', () => {
    expect(
      selectionForError(new StorageError('rate_limited', 'x', 429, { retryAfter: 30 })),
    ).toEqual({ mode: 'retry', code: 'rate_limited', retryAfter: 30 });
    expect(selectionForError(new StorageError('unavailable', 'x', 503))).toEqual({
      mode: 'retry',
      code: 'unavailable',
    });
  });

  it('anything else is not a selection outcome', () => {
    expect(selectionForError(new StorageError('upload_failed', 'x', 500))).toBeNull();
    expect(selectionForError(new Error('x'))).toBeNull();
  });
});

describe('planInline: G-27 option a', () => {
  // A payload model: fixed overhead + text + each inline file as base64url (4/3) + each stored file
  // as a fixed-size reference (its url counted at the backend's maximum URL length).
  const OVERHEAD = 400;
  const STORED_REF = 600;
  const model =
    (sizes: readonly number[], text = 0) =>
    (inline: readonly boolean[]): number =>
      OVERHEAD +
      text +
      sizes.reduce(
        (sum, size, i) => sum + (inline[i] ? Math.ceil((size * 4) / 3) + 100 : STORED_REF),
        0,
      );

  it('the limits are the spec values', () => {
    expect(PAYLOAD_MAX_BYTES).toBe(17_136);
    expect(INLINE_MAX_CIPHERTEXT_BYTES).toBe(12_288);
    expect(isInlineEligible(12_288)).toBe(true);
    expect(isInlineEligible(12_289)).toBe(false);
  });

  it('one small file with a short text goes inline', () => {
    const sizes = [12_288];
    expect(planInline(sizes, model(sizes, 100))).toEqual([true]);
  });

  it('a file above the per-file cap never goes inline', () => {
    const sizes = [12_289, 100];
    expect(planInline(sizes, model(sizes))).toEqual([false, true]);
  });

  it('moves the largest inline file to storage until the payload fits', () => {
    const sizes = [3_000, 9_000, 4_000, 1_000];
    const plan = planInline(sizes, model(sizes));
    expect(plan).toEqual([true, false, true, true]);
    expect(model(sizes)(plan)).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
  });

  it('on a tie, moves the file with the highest index first', () => {
    const sizes = [7_000, 7_000, 7_000];
    expect(planInline(sizes, model(sizes))).toEqual([true, false, false]);
  });

  it('keeps moving while the payload is over the limit, and stops as soon as it fits', () => {
    const sizes = [5_000, 5_000, 5_000, 5_000];
    const plan = planInline(sizes, model(sizes));
    expect(model(sizes)(plan)).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
    expect(plan.filter(Boolean)).toHaveLength(2);
    expect(plan).toEqual([true, true, false, false]);
  });

  it('a long text can push even the only small file to storage', () => {
    const sizes = [12_000];
    expect(planInline(sizes, model(sizes, 9_000))).toEqual([false]);
  });

  it('at the exact boundary the file stays inline; one byte over moves it', () => {
    const sizes = [6_000];
    const text = PAYLOAD_MAX_BYTES - model(sizes)([true]);
    expect(planInline(sizes, model(sizes, text))).toEqual([true]);
    expect(planInline(sizes, model(sizes, text + 1))).toEqual([false]);
  });

  it('returns all-stored when nothing fits; the caller then refuses after its final check', () => {
    const sizes = [1_000, 1_000];
    expect(planInline(sizes, model(sizes, 20_000))).toEqual([false, false]);
  });

  it('refuses more than 16 files and bad sizes', () => {
    expect(() => planInline(new Array<number>(17).fill(10), () => 0)).toThrow(StorageError);
    expect(() => planInline([0], () => 0)).toThrow(StorageError);
    expect(() => planInline([1.5], () => 0)).toThrow(StorageError);
  });

  it('refuses a measure that does not return a non-negative integer', () => {
    expect(() => planInline([10], () => Number.NaN)).toThrow(StorageError);
  });
});
