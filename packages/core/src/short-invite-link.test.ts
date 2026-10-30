// W4-SHORT-INVITE (04 §3.6.2, D-139): link format 2 in the one invite codec. The `2.` prefix tells
// the formats apart; a format 2 link is bounded and parsed strictly (43 characters of strict
// base64url, zero trailing bits), resolved by fetching the `ALI1` object under the derived lookup ID
// only (never the secret), decrypted, and then decoded by the D-69 steps exactly as a format 1 link.
// One link is fetched at most once per process (the page's check, accept and the approval action
// share the resolved invite), and every failure is a fixed core error with no inbound text.
import {
  decodeBase64url,
  encodeBase64url,
  sealShortInvite,
  shortInviteLookupId,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import type { Invite } from '@4thtech-io/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreError } from './errors.js';
import {
  INVITE_LINK_PREFIX,
  clearShortInviteCache,
  decodeInviteLink,
  encodeInviteLink,
  encodeInvitePayload,
  encodeShortInviteLink,
  resolveInviteLink,
  shortInviteSecretOf,
} from './invite-link.js';
import { makeAgent } from './testing/envelopes.js';
import { FakeClock, RELAYS, passphrase, seed } from './testing/fixtures.js';

const K = new Uint8Array(32).map((_, i) => 255 - i);

async function anInvite(): Promise<Invite> {
  const clock = new FakeClock();
  const owner = new MemoryOwnerKeyStore(seed(211), passphrase());
  const agent = await makeAgent(clock, new MemoryKeyStore(seed(11)), owner, 'Ana');
  const signed = await agent.client.identity.signedCard();
  return {
    v: 1,
    inviteId: encodeBase64url(new Uint8Array(16).fill(1)),
    secret: encodeBase64url(new Uint8Array(32).fill(2)),
    card: signed.card as unknown as Invite['card'],
    cardSig: signed.cardSig,
    cardAgentSig: signed.cardAgentSig,
    codeCommit: encodeBase64url(new Uint8Array(32).fill(3)),
    name: signed.name,
    relays: [...RELAYS],
    expiresAt: 1_800_000_000,
  };
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    return (error as CoreError).code;
  }
  return 'resolved';
};

beforeEach(() => clearShortInviteCache());

describe('link format 2: form and parse (04 §3.6.2 step 1)', () => {
  it('is `https://agentlink.4thtech.io/i#2.<43>`, under 80 characters', () => {
    const link = encodeShortInviteLink(K);
    expect(link).toBe(`${INVITE_LINK_PREFIX}2.${encodeBase64url(K)}`);
    expect(link.length).toBe(INVITE_LINK_PREFIX.length + 45);
    expect(link.length).toBeLessThan(80);
    expect(shortInviteSecretOf(link)).toEqual(K);
    expect(shortInviteSecretOf(`2.${encodeBase64url(K)}`)).toEqual(K);
  });

  it('a format 1 link or payload is not format 2 (undefined, no throw)', async () => {
    const long = await encodeInviteLink(await anInvite());
    expect(shortInviteSecretOf(long)).toBeUndefined();
    expect(shortInviteSecretOf(long.slice(INVITE_LINK_PREFIX.length))).toBeUndefined();
  });

  it('refuses every malformed format 2 input with invite_invalid', () => {
    const s = encodeBase64url(K);
    const bad = [
      `2.${s.slice(1)}`, // 42 characters
      `2.${s}A`, // 44
      `2.${s.slice(0, 42)}B`, // non-zero trailing bits
      `2.${s.slice(0, 42)}=`,
      `2.${s.slice(0, 41)}+A`,
      `2.${s.slice(0, 41)}/A`,
      `2.${s.slice(0, 40)}%41A`,
      ` 2.${s}`,
      `2.${s} `,
      `${INVITE_LINK_PREFIX}2.${s}#x`,
      `http://agentlink.4thtech.io/i#2.${s}`,
      `https://evil.example/i#2.${s}`,
      `https://agentlink.4thtech.io/j#2.${s}`,
      `${INVITE_LINK_PREFIX}2.${s}`.toUpperCase(),
    ];
    for (const input of bad) {
      expect(() => shortInviteSecretOf(input), input).toThrow(CoreError);
    }
    expect(() => shortInviteSecretOf(42)).toThrow(CoreError);
  });

  it('decodeInviteLink without a fetcher refuses a format 2 link as damaged', async () => {
    expect(await code(decodeInviteLink(encodeShortInviteLink(K)))).toBe('invite_invalid');
  });
});

describe('link format 2: resolve (04 §3.6.2 steps 2–5)', () => {
  it('fetches only the derived lookup ID, decrypts, and decodes exactly as format 1', async () => {
    const invite = await anInvite();
    const sealed = await sealShortInvite(K, await encodeInvitePayload(invite));
    const fetchObject = vi.fn(async (id: string) => {
      expect(id).toBe(encodeBase64url(shortInviteLookupId(K)));
      expect(id).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);
      return sealed.object;
    });
    const decoded = await decodeInviteLink(encodeShortInviteLink(K), {
      fetchShortInvite: fetchObject,
    });
    expect(decoded).toEqual(invite);
    // The fetcher never sees the secret, in any spelling.
    for (const [arg] of fetchObject.mock.calls) {
      expect(arg).not.toContain(encodeBase64url(K));
    }
    // The resolved long link equals the format 1 link of the same invite.
    expect(await resolveInviteLink(encodeShortInviteLink(K), fetchObject)).toBe(
      await encodeInviteLink(invite),
    );
  });

  it('fetches one link once per process: check, accept and the action share it', async () => {
    const sealed = await sealShortInvite(K, await encodeInvitePayload(await anInvite()));
    const fetchObject = vi.fn(async () => sealed.object);
    const link = encodeShortInviteLink(K);
    await resolveInviteLink(link, fetchObject);
    await resolveInviteLink(`2.${encodeBase64url(K)}`, fetchObject);
    await decodeInviteLink(link, { fetchShortInvite: fetchObject });
    expect(fetchObject).toHaveBeenCalledTimes(1);
  });

  it('a format 1 link resolves to itself with no fetch', async () => {
    const long = await encodeInviteLink(await anInvite());
    const fetchObject = vi.fn(async () => new Uint8Array(0));
    expect(await resolveInviteLink(long, fetchObject)).toBe(long);
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it('a tag failure (another secret, a swapped object) is invite_invalid, never retried', async () => {
    const other = new Uint8Array(32).fill(5);
    const sealed = await sealShortInvite(other, await encodeInvitePayload(await anInvite()));
    const fetchObject = vi.fn(async () => sealed.object);
    expect(await code(resolveInviteLink(encodeShortInviteLink(K), fetchObject))).toBe(
      'invite_invalid',
    );
    expect(fetchObject).toHaveBeenCalledTimes(1);
  });

  it('a decrypted payload that is not a valid D-69 invite is invite_invalid', async () => {
    const sealed = await sealShortInvite(K, new Uint8Array([1, 2, 3]));
    expect(await code(resolveInviteLink(encodeShortInviteLink(K), async () => sealed.object))).toBe(
      'invite_invalid',
    );
  });

  it('passes the fetcher’s fixed core errors through; anything else is invite_fetch_failed', async () => {
    const link = encodeShortInviteLink(K);
    const gone = async (): Promise<Uint8Array> => {
      throw new CoreError('invite_unavailable', 'x');
    };
    expect(await code(resolveInviteLink(link, gone))).toBe('invite_unavailable');
    const boom = async (): Promise<Uint8Array> => {
      throw new Error(`https://drop.example/v1/i/${encodeBase64url(K)}`);
    };
    const err = await resolveInviteLink(link, boom).catch((e: unknown) => e);
    expect((err as CoreError).code).toBe('invite_fetch_failed');
    // No inbound or secret text in the error (I-5, I-7).
    expect(String((err as Error).message)).not.toContain(encodeBase64url(K));
    // A failure is not cached: a retry fetches again.
    const sealed = await sealShortInvite(K, await encodeInvitePayload(await anInvite()));
    await expect(resolveInviteLink(link, async () => sealed.object)).resolves.toMatch(
      /^https:\/\/agentlink\.4thtech\.io\/i#[A-Za-z0-9_-]+$/,
    );
  });

  it('encodeInvitePayload is the raw D-69 payload bytes (base64url of it is the format 1 payload)', async () => {
    const invite = await anInvite();
    const long = await encodeInviteLink(invite);
    const p = await encodeInvitePayload(invite);
    expect(encodeBase64url(p)).toBe(long.slice(INVITE_LINK_PREFIX.length));
    expect(decodeBase64url(encodeBase64url(p))).toEqual(p);
  });
});
