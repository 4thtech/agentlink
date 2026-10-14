// The invite link codec (04 §3.6, D-69, G-12) in Node: the M1-7c decoder tests that need a spy or
// a slow reader. The fixed payloads and the reject cases run in every runtime through the
// `invite-link` vector suite (test-vectors/harness/suites/invite-link.ts).
import { canonicalize, encodeBase64url, encodeUtf8, type JsonValue } from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import type { Invite } from '@agentlink/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INVITE_LINK_PREFIX,
  INVITE_MAX_JSON_BYTES,
  INVITE_MAX_PAYLOAD_CHARS,
  decodeInviteLink,
  encodeInviteLink,
} from './invite-link.js';
import { makeAgent } from './testing/envelopes.js';
import { FakeClock, RELAYS, passphrase, seed } from './testing/fixtures.js';
import {
  compress,
  patchDecompression,
  slowReader,
  sleep,
  watchUnhandled,
} from './testing/platform.js';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const payloadOf = async (json: string): Promise<string> =>
  encodeBase64url(await compress(encodeUtf8(json)));
const jsonOf = (invite: Invite): string => canonicalize(invite as unknown as JsonValue);
/** The JSON object text with `text` inserted right after its opening brace. */
const afterBrace = (json: string, text: string): string => `{${text}${json.slice(1)}`;

async function anInvite(): Promise<Invite> {
  const clock = new FakeClock();
  const owner = new MemoryOwnerKeyStore(seed(201), passphrase());
  const agent = await makeAgent(clock, new MemoryKeyStore(seed(1)), owner, 'Tali’s Claude');
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

/** Counts every DecompressionStream the codec constructs. */
function countInflates(): () => number {
  let n = 0;
  restore = patchDecompression((real) => {
    n += 1;
    return real;
  });
  return () => n;
}

describe('encode, then decode (04 §3.6)', () => {
  it('round-trips through the full link and the bare payload', async () => {
    const invite = await anInvite();
    const link = await encodeInviteLink(invite);
    expect(link.startsWith(INVITE_LINK_PREFIX)).toBe(true);
    expect(await decodeInviteLink(link)).toEqual(invite);
    expect(await decodeInviteLink(link.slice(INVITE_LINK_PREFIX.length))).toEqual(invite);
  });

  it('the largest schema-valid invite (16 long relays, a 256-code-point name with control characters) round-trips', async () => {
    const invite = await anInvite();
    const relays = Array.from(
      { length: 16 },
      (_, i) => `wss://relay-${String.fromCharCode(97 + i)}.example.com/${'p'.repeat(256 - 31)}`,
    );
    expect(relays.every((r) => r.length <= 256)).toBe(true);
    const name = '\u0001'.repeat(128) + 'é'.repeat(128);
    const big = { ...invite, relays, name };
    const json = jsonOf(big);
    expect(encodeUtf8(json).length).toBeLessThan(7_168);
    expect(await decodeInviteLink(INVITE_LINK_PREFIX + (await payloadOf(json)))).toEqual(big);
    expect(await decodeInviteLink(await encodeInviteLink(big))).toEqual(big);
  });

  it('the encoder refuses a schema-invalid invite', async () => {
    const invite = await anInvite();
    await expect(
      encodeInviteLink({ ...invite, relays: ['wss://nos.lol'] } as Invite),
    ).rejects.toMatchObject({ code: 'invite_invalid' });
  });
});

describe('decoder step 1: the input is bounded and checked before any parsing or inflating', () => {
  it.each([
    ['over the bound', () => INVITE_LINK_PREFIX + 'A'.repeat(INVITE_MAX_PAYLOAD_CHARS + 1)],
    ['bare over the bound', () => 'A'.repeat(INVITE_MAX_PAYLOAD_CHARS + 1)],
    ['another scheme', () => 'http://agentlink.4thtech.io/i#AAAA'],
    ['another host', () => 'https://evil.example/i#AAAA'],
    ['another path', () => 'https://agentlink.4thtech.io/x#AAAA'],
    ['a query', () => 'https://agentlink.4thtech.io/i?a=b#AAAA'],
    ['a second #', () => `${INVITE_LINK_PREFIX}AAAA#AAAA`],
    ['percent-encoding', () => `${INVITE_LINK_PREFIX}AA%41A`],
    ['a leading space', () => ` ${INVITE_LINK_PREFIX}AAAA`],
    ['padding', () => 'AAA='],
    ['the standard alphabet', () => 'AA+/'],
    ['a length of 1 mod 4', () => 'AAAAA'],
    ['empty', () => ''],
  ])('%s', async (_name, make) => {
    const inflates = countInflates();
    await expect(decodeInviteLink(make())).rejects.toMatchObject({ code: 'invite_invalid' });
    expect(inflates()).toBe(0);
  });

  it('refuses a non-string', async () => {
    await expect(decodeInviteLink(42)).rejects.toMatchObject({ code: 'invite_invalid' });
  });

  it('the error never carries inbound text (I-5)', async () => {
    const canary = 'SECRETCANARY';
    const error: unknown = await decodeInviteLink(`https://evil.example/${canary}`).catch(
      (e: unknown) => e,
    );
    expect(String((error as Error).message)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
  });
});

describe('decoder step 2: bounded inflation', () => {
  it('a deflate bomb read by a slow reader is refused at the cap, in bounded chunks, with no unhandled rejection', async () => {
    // 12 MiB of zeros compress to about 12 KiB: a payload that fits, of about 12 slices of 1 KiB.
    const payload = encodeBase64url(await compress(new Uint8Array(12 * 1024 * 1024)));
    expect(payload.length).toBeLessThanOrEqual(INVITE_MAX_PAYLOAD_CHARS);
    let delivered = 0;
    let largest = 0;
    restore = patchDecompression((real) =>
      slowReader(real, 1, (bytes) => {
        delivered += bytes;
        largest = Math.max(largest, bytes);
      }),
    );
    const unhandled = watchUnhandled();
    try {
      await expect(decodeInviteLink(payload)).rejects.toMatchObject({ code: 'invite_invalid' });
      await sleep(20);
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
    }
    // The output reached the codec as stream chunks of at most one slice's expansion (about
    // 1 MiB), read and discarded past the cap, never as one buffer of the whole output. How far
    // the platform decoder runs ahead of the reader is its own buffering (Node's adapter accepts up
    // to its 16 KiB writable high-water mark of input at once); the input bound of step 1 caps that
    // work at about 16 MiB of output per decode.
    expect(delivered).toBeGreaterThan(INVITE_MAX_JSON_BYTES);
    expect(largest).toBeLessThanOrEqual(1_100 * 1024);
  });

  it('refuses output of 16 385 bytes and accepts exactly 16 384 (whitespace counts)', async () => {
    const invite = await anInvite();
    const json = jsonOf(invite);
    const atCap = afterBrace(json, ' '.repeat(INVITE_MAX_JSON_BYTES - encodeUtf8(json).length));
    expect(encodeUtf8(atCap).length).toBe(INVITE_MAX_JSON_BYTES);
    expect(await decodeInviteLink(await payloadOf(atCap))).toEqual(invite);
    await expect(decodeInviteLink(await payloadOf(`${atCap} `))).rejects.toMatchObject({
      code: 'invite_invalid',
    });
  });
});

describe('decoder step 3: exact end of stream', () => {
  it('refuses a trailing 0x00, other trailing bytes, a second stream and a truncated stream; a valid invite still decodes', async () => {
    const invite = await anInvite();
    const raw = await compress(encodeUtf8(jsonOf(invite)));
    expect(await decodeInviteLink(encodeBase64url(raw))).toEqual(invite);
    for (const bad of [
      new Uint8Array([...raw, 0]),
      new Uint8Array([...raw, 1, 2, 3]),
      new Uint8Array([...raw, ...raw]),
      raw.slice(0, -1),
      raw.slice(0, raw.length >> 1),
    ]) {
      await expect(decodeInviteLink(encodeBase64url(bad))).rejects.toMatchObject({
        code: 'invite_invalid',
      });
    }
  });
});

describe('decoder step 4: strict text, I-JSON and the strict schema', () => {
  it('refuses a zlib or gzip wrapper, invalid UTF-8, a leading BOM, duplicate keys, unknown keys and an array', async () => {
    const invite = await anInvite();
    const json = jsonOf(invite);
    const bytes = encodeUtf8(json);
    const cases = [
      encodeBase64url(await compress(bytes, 'deflate')),
      encodeBase64url(await compress(bytes, 'gzip')),
      encodeBase64url(
        await compress(new Uint8Array([...bytes.slice(0, 20), 0xff, ...bytes.slice(20)])),
      ),
      await payloadOf(`\uFEFF${json}`),
      await payloadOf(afterBrace(json, '"v":1,')),
      await payloadOf(afterBrace(json, '"extra":1,')),
      await payloadOf(`[${json}]`),
    ];
    for (const payload of cases) {
      await expect(decodeInviteLink(payload)).rejects.toMatchObject({ code: 'invite_invalid' });
    }
  });
});
