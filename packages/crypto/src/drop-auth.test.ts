// M1-27a (D-48): the encrypted-drop request signature and the drop's URL MAC (07 §5.4, 04 §4).
// A drop request carries a NIP-98-style event (kind 27235) signed with the agent's drop key, bound to
// the method, the exact URL and the SHA-256 of the body, and domain-separated by its `domain` tag.
// The cross-runtime vectors are in test-vectors/drop-auth; these tests pin the API rules.
import { describe, expect, it } from 'vitest';
import { bip340PublicKey } from './bip340.js';
import { encodeBase64url, encodeHex, encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { createSha256, sha256 } from './hash.js';
import {
  DROP_AUTH_DOMAIN,
  DROP_AUTH_KIND,
  DROP_AUTH_MAX_HEADER_LENGTH,
  DROP_AUTH_MAX_SKEW_SECONDS,
  DROP_OBJECT_ID_LENGTH,
  DROP_URL_MAC_LABEL,
  dropAuthEvent,
  dropUrlMac,
  encodeDropAuthorization,
  verifyDropAuthorization,
  verifyDropUrlMac,
  type DropAuthRequest,
} from './drop-auth.js';
import * as index from './index.js';
import { signNostrEvent, type NostrEvent } from './nostr-event.js';
import { hmacSha256 } from './pairing.js';

const DROP_SECRET = new Uint8Array(32).fill(7);
const DROP_PUB = encodeHex(bip340PublicKey(DROP_SECRET));
const NOW = 1_790_000_000;
const URL_UPLOAD = 'https://drop.agentlink.4thtech.io/v1/upload';
const BODY = encodeUtf8('{"v":1,"size":20000,"expiresAt":1790600000,"nonce":"AAAAAAAAAAAAAAAAAAAAAA","ts":1790000000}');
const REQUEST: DropAuthRequest = { method: 'POST', url: URL_UPLOAD, body: BODY };

function signed(request: DropAuthRequest = REQUEST, createdAt = NOW): NostrEvent {
  return signNostrEvent(DROP_SECRET, dropAuthEvent(request, createdAt));
}

function header(event: NostrEvent): string {
  return encodeDropAuthorization(event);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof CryptoInputError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('dropAuthEvent', () => {
  it('builds kind 27235 with exactly the u, method, payload and domain tags and empty content', () => {
    const event = dropAuthEvent(REQUEST, NOW);
    expect(event.kind).toBe(DROP_AUTH_KIND);
    expect(DROP_AUTH_KIND).toBe(27235);
    expect(event.created_at).toBe(NOW);
    expect(event.content).toBe('');
    expect(event.tags).toEqual([
      ['u', URL_UPLOAD],
      ['method', 'POST'],
      ['payload', encodeHex(sha256(BODY))],
      ['domain', DROP_AUTH_DOMAIN],
    ]);
    expect(DROP_AUTH_DOMAIN).toBe('agentlink/v1/drop');
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('refuses methods other than POST and DELETE, non-https URLs and bad timestamps', () => {
    expect(codeOf(() => dropAuthEvent({ ...REQUEST, method: 'GET' }, NOW))).toBe('invalid_argument');
    expect(codeOf(() => dropAuthEvent({ ...REQUEST, method: 'post' }, NOW))).toBe('invalid_argument');
    expect(codeOf(() => dropAuthEvent({ ...REQUEST, url: 'http://drop.example/v1/upload' }, NOW))).toBe(
      'invalid_argument',
    );
    expect(codeOf(() => dropAuthEvent({ ...REQUEST, url: `https://d.example/${'a'.repeat(600)}` }, NOW))).toBe(
      'invalid_argument',
    );
    expect(codeOf(() => dropAuthEvent(REQUEST, -1))).toBe('invalid_argument');
    expect(codeOf(() => dropAuthEvent(REQUEST, 1.5))).toBe('invalid_argument');
    expect(codeOf(() => dropAuthEvent({ ...REQUEST, body: 'x' as unknown as Uint8Array }, NOW))).toBe(
      'invalid_argument',
    );
  });
});

describe('verifyDropAuthorization', () => {
  it('accepts a correctly signed request and returns the drop key and timestamp', () => {
    const result = verifyDropAuthorization(header(signed()), REQUEST, NOW);
    expect(result).toEqual({ ok: true, pubkey: DROP_PUB, createdAt: NOW });
  });

  it('accepts DELETE with its own body', () => {
    const del: DropAuthRequest = {
      method: 'DELETE',
      url: 'https://drop.agentlink.4thtech.io/v1/o/abc',
      body: encodeUtf8('{"v":1}'),
    };
    expect(verifyDropAuthorization(header(signed(del)), del, NOW).ok).toBe(true);
  });

  it('accepts timestamps at the edge of the skew window and refuses beyond it as stale', () => {
    const skew = DROP_AUTH_MAX_SKEW_SECONDS;
    expect(skew).toBe(60);
    expect(verifyDropAuthorization(header(signed(REQUEST, NOW - skew)), REQUEST, NOW).ok).toBe(true);
    expect(verifyDropAuthorization(header(signed(REQUEST, NOW + skew)), REQUEST, NOW).ok).toBe(true);
    expect(verifyDropAuthorization(header(signed(REQUEST, NOW - skew - 1)), REQUEST, NOW)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(verifyDropAuthorization(header(signed(REQUEST, NOW + skew + 1)), REQUEST, NOW)).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('refuses a signature over another method, URL or body (request_mismatch)', () => {
    const auth = header(signed());
    for (const other of [
      { ...REQUEST, method: 'DELETE' },
      { ...REQUEST, url: 'https://drop.agentlink.4thtech.io/v1/upload?x=1' },
      { ...REQUEST, url: 'https://evil.example/v1/upload' },
      { ...REQUEST, body: encodeUtf8('{"v":1}') },
    ]) {
      expect(verifyDropAuthorization(auth, other, NOW)).toEqual({ ok: false, reason: 'request_mismatch' });
    }
  });

  it('refuses a tampered signature or id (invalid_signature)', () => {
    const event = signed();
    const flipped = event.sig.slice(0, -1) + (event.sig.endsWith('0') ? '1' : '0');
    expect(verifyDropAuthorization(header({ ...event, sig: flipped }), REQUEST, NOW)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('refuses another kind, extra or reordered tags, content, or a missing domain tag (malformed)', () => {
    const base = dropAuthEvent(REQUEST, NOW);
    const variants = [
      { ...base, kind: 22242 },
      { ...base, content: 'x' },
      { ...base, tags: [...base.tags, ['x', 'y']] },
      { ...base, tags: [base.tags[1], base.tags[0], base.tags[2], base.tags[3]] },
      { ...base, tags: base.tags.slice(0, 3) },
      { ...base, tags: [base.tags[0], base.tags[1], base.tags[2], ['domain', 'agentlink/v1/other']] },
    ];
    for (const variant of variants) {
      const event = signNostrEvent(DROP_SECRET, variant as typeof base);
      expect(verifyDropAuthorization(header(event), REQUEST, NOW)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses a missing, oversized, wrong-scheme or non-canonical header (malformed)', () => {
    const good = header(signed());
    const json = JSON.stringify(signed());
    for (const bad of [
      null,
      undefined,
      '',
      good.replace('Nostr ', 'Bearer '),
      good.replace('Nostr ', 'nostr '),
      `${good}=`,
      good.replace('Nostr ', 'Nostr  '),
      `${good.slice(0, 10)}+${good.slice(11)}`, // a '+' is not base64url
      `Nostr ${encodeBase64url(encodeUtf8(`${json} `))}`,
      `Nostr ${encodeBase64url(encodeUtf8(json.replace('"sig"', '"sig":"x","extra":1,"sig2"')))}`,
      `Nostr ${'A'.repeat(DROP_AUTH_MAX_HEADER_LENGTH)}`,
    ]) {
      const result = verifyDropAuthorization(bad, REQUEST, NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['malformed']).toContain(result.reason);
    }
  });

  it('never throws, whatever it is given', () => {
    expect(() => verifyDropAuthorization(42 as unknown as string, REQUEST, NOW)).not.toThrow();
    expect(() =>
      verifyDropAuthorization(header(signed()), { ...REQUEST, body: null as unknown as Uint8Array }, NOW),
    ).not.toThrow();
    expect(verifyDropAuthorization(header(signed()), REQUEST, Number.NaN).ok).toBe(false);
  });
});

describe('dropUrlMac', () => {
  const key = sha256(encodeUtf8('drop-auth.test/url-key'));
  const objectId = sha256(encodeUtf8('drop-auth.test/object')).subarray(0, DROP_OBJECT_ID_LENGTH);
  const fields = { purpose: 'get', objectId, part: 0, expiresAt: 1_790_604_800 } as const;

  it('is HMAC-SHA256(key, label ‖ 0x00 ‖ purpose ‖ objectId ‖ u16be(part) ‖ u64be(expiresAt))', () => {
    expect(DROP_URL_MAC_LABEL).toBe('agentlink/v1/drop-url');
    const expiry = new Uint8Array(8);
    new DataView(expiry.buffer).setBigUint64(0, BigInt(fields.expiresAt));
    const message = new Uint8Array([
      ...encodeUtf8(DROP_URL_MAC_LABEL),
      0,
      2,
      ...objectId,
      0,
      0,
      ...expiry,
    ]);
    expect(encodeHex(dropUrlMac(key, fields))).toBe(encodeHex(hmacSha256(key, message)));
  });

  it('binds purpose, object, part and expiry', () => {
    const mac = dropUrlMac(key, fields);
    expect(verifyDropUrlMac(key, fields, mac)).toBe(true);
    expect(verifyDropUrlMac(key, { ...fields, purpose: 'put' }, mac)).toBe(false);
    expect(verifyDropUrlMac(key, { ...fields, expiresAt: fields.expiresAt + 1 }, mac)).toBe(false);
    expect(verifyDropUrlMac(key, { ...fields, purpose: 'put', part: 1 }, mac)).toBe(false);
    const otherId = objectId.slice();
    otherId[0] = (otherId[0] ?? 0) ^ 1;
    expect(verifyDropUrlMac(key, { ...fields, objectId: otherId }, mac)).toBe(false);
    expect(verifyDropUrlMac(sha256(key), fields, mac)).toBe(false);
    expect(verifyDropUrlMac(key, fields, mac.subarray(0, 31))).toBe(false);
  });

  it('refuses a short key, a wrong-length object id, a bad part or expiry', () => {
    expect(codeOf(() => dropUrlMac(key.subarray(0, 16), fields))).toBe('invalid_length');
    expect(codeOf(() => dropUrlMac(key, { ...fields, objectId: objectId.subarray(0, 15) }))).toBe('invalid_length');
    expect(codeOf(() => dropUrlMac(key, { ...fields, part: 1 }))).toBe('invalid_argument'); // get has part 0
    expect(codeOf(() => dropUrlMac(key, { ...fields, purpose: 'put', part: 10_001 }))).toBe('invalid_argument');
    expect(codeOf(() => dropUrlMac(key, { ...fields, expiresAt: -1 }))).toBe('invalid_argument');
    expect(codeOf(() => dropUrlMac(key, { ...fields, purpose: 'other' as 'get' }))).toBe('invalid_argument');
    expect(verifyDropUrlMac(key, { ...fields, part: 1 }, dropUrlMac(key, fields))).toBe(false);
  });
});

describe('createSha256', () => {
  it('hashes incrementally to the same digest as sha256', () => {
    const data = encodeUtf8('a'.repeat(1000) + 'b'.repeat(777));
    const hasher = createSha256();
    hasher.update(data.subarray(0, 1)).update(data.subarray(1, 999));
    hasher.update(data.subarray(999));
    expect(encodeHex(hasher.digest())).toBe(encodeHex(sha256(data)));
    expect(() => hasher.update(data)).toThrow(CryptoInputError);
  });
});

describe('public entry', () => {
  it('exports the verifier, the event builder and the URL MAC, and no signer', () => {
    expect(typeof index.verifyDropAuthorization).toBe('function');
    expect(typeof index.dropAuthEvent).toBe('function');
    expect(typeof index.encodeDropAuthorization).toBe('function');
    expect(typeof index.dropUrlMac).toBe('function');
    expect(typeof index.verifyDropUrlMac).toBe('function');
    expect(typeof index.createSha256).toBe('function');
    expect('signNostrEvent' in index).toBe(false);
  });
});
