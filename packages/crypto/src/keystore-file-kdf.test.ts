// IR-M1-1f-1 L-5: 04 §2.8 "refuse before the KDF runs". A spy on Argon2id proves that a planted
// header (KDF parameters out of bounds, unknown values, a wrong size, a foreign agent ID), a chosen
// owner passphrase on a file-KeyStore machine, and a secret that fails normalisation never reach the
// KDF. The vectors only show the outcome (reject); this shows the order.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoInputError, encodeUtf8, sha256 } from './index.js';
import { deriveAgentId, derivePublicKey, openKeystoreFile, openOwnerSeed } from './keystore.js';

// Each test here runs Argon2id (m = 19 MiB) several times. On a loaded CI runner that can exceed
// Vitest's default 5 s per test, so this file allows 60 s. Assertions are unchanged.
vi.setConfig({ testTimeout: 60_000 });

const spy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./argon2.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./argon2.js')>();
  return {
    ...original,
    argon2id: (...args: Parameters<typeof original.argon2id>) => {
      spy.calls += 1;
      return original.argon2id(...args);
    },
  };
});

const AGENT = deriveAgentId(sha256(encodeUtf8('keystore-file-kdf.test/agent')));
const OWNER_SEED = sha256(encodeUtf8('keystore-file-kdf.test/owner'));
const evm = derivePublicKey(OWNER_SEED, 'agentlink/v1/evm', 0);
const nostr = derivePublicKey(OWNER_SEED, 'agentlink/v1/nostr', 0);
if (evm.label !== 'agentlink/v1/evm' || nostr.label !== 'agentlink/v1/nostr') throw new Error();
const OWNER = { ownerEvm: evm.address, ownerNostr: nostr.publicKey };
const PHRASE = { secret: encodeUtf8('correct horse battery staple'), source: 'prompt' as const };

interface HeaderFields {
  magic?: string;
  version?: number;
  kind?: number;
  kdf?: number;
  m?: number;
  t?: number;
  p?: number;
  aead?: number;
}

/** A header with the given values followed by `body` bytes of (unauthenticated) ciphertext. */
function crafted(format: 'ALKS' | 'ALKO', f: HeaderFields, agentId = AGENT, body = 64): Uint8Array {
  const head = new Uint8Array(42);
  head.set(encodeUtf8(f.magic ?? format), 0);
  head[4] = f.version ?? 1;
  head[5] = f.kind ?? 2;
  head[6] = f.kdf ?? 1;
  new DataView(head.buffer).setUint32(7, f.m ?? 19456, false);
  head[11] = f.t ?? 2;
  head[12] = f.p ?? 1;
  head[29] = f.aead ?? 1;
  const id =
    format === 'ALKS' ? Uint8Array.of(agentId.length, ...encodeUtf8(agentId)) : new Uint8Array(0);
  const out = new Uint8Array(head.length + id.length + body);
  out.set(head, 0);
  out.set(id, head.length);
  return out;
}

async function refusedBeforeKdf(run: () => Promise<unknown>, code: string): Promise<void> {
  spy.calls = 0;
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoInputError);
    expect((error as CryptoInputError).code).toBe(code);
    expect(spy.calls, 'the KDF ran').toBe(0);
    return;
  }
  throw new Error('expected a refusal');
}

const OUT_OF_BOUNDS: HeaderFields[] = [
  { m: 0xffffffff },
  { m: 19455 },
  { m: 262145 },
  { t: 255 },
  { t: 1 },
  { t: 9 },
  { p: 255 },
  { p: 0 },
  { p: 5 },
  { m: 0xffffffff, t: 255, p: 255 },
  { version: 2 },
  { kdf: 2 },
  { aead: 2 },
  { kind: 0 },
  { kind: 3 },
];

describe('ALKS: refusals happen before the KDF', () => {
  beforeEach(() => {
    spy.calls = 0;
  });

  it('the spy sees the KDF when a header is valid', async () => {
    await expect(openKeystoreFile(crafted('ALKS', {}), PHRASE, AGENT)).rejects.toThrow(
      CryptoInputError,
    );
    expect(spy.calls).toBe(1);
  });

  it('out-of-bounds parameters and unknown header values', async () => {
    for (const fields of OUT_OF_BOUNDS) {
      await refusedBeforeKdf(
        () => openKeystoreFile(crafted('ALKS', fields), PHRASE, AGENT),
        'open_failed',
      );
    }
  });

  it('a foreign agent ID, a wrong magic, a short file and plaintext above 64 KiB', async () => {
    const other = deriveAgentId(sha256(encodeUtf8('keystore-file-kdf.test/other')));
    await refusedBeforeKdf(
      () => openKeystoreFile(crafted('ALKS', {}, other), PHRASE, AGENT),
      'open_failed',
    );
    await refusedBeforeKdf(
      () => openKeystoreFile(crafted('ALKS', { magic: 'ALKO' }), PHRASE, AGENT),
      'open_failed',
    );
    await refusedBeforeKdf(
      () => openKeystoreFile(crafted('ALKS', {}, AGENT, 15), PHRASE, AGENT),
      'open_failed',
    );
    await refusedBeforeKdf(
      () => openKeystoreFile(crafted('ALKS', {}, AGENT, 65536 + 17), PHRASE, AGENT),
      'open_failed',
    );
  });

  it('a secret that fails the kind 1 normalisation', async () => {
    await refusedBeforeKdf(
      () => openKeystoreFile(crafted('ALKS', { kind: 1 }), PHRASE, AGENT),
      'invalid_secret',
    );
  });
});

describe('ALKO: refusals happen before the KDF', () => {
  const options = { fileKeystoreMachine: false };

  it('out-of-bounds parameters and unknown header values', async () => {
    for (const fields of OUT_OF_BOUNDS) {
      await refusedBeforeKdf(
        () => openOwnerSeed(crafted('ALKO', fields, AGENT, 48), PHRASE, OWNER, options),
        'open_failed',
      );
    }
  });

  it('any size other than 90 bytes', async () => {
    for (const body of [47, 49]) {
      await refusedBeforeKdf(
        () => openOwnerSeed(crafted('ALKO', {}, AGENT, body), PHRASE, OWNER, options),
        'open_failed',
      );
    }
  });

  it('a chosen passphrase on a file-KeyStore machine', async () => {
    await refusedBeforeKdf(
      () =>
        openOwnerSeed(crafted('ALKO', { kind: 2 }, AGENT, 48), PHRASE, OWNER, {
          fileKeystoreMachine: true,
        }),
      'secret_kind_refused',
    );
  });
});
