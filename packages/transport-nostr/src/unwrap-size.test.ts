// M1-5a acceptance: on receipt, the rumor `content` is checked against the 24 576-byte envelope
// limit on the string, before it is parsed (04 §3.1.1 "Size before parsing"). Spy test: the JSON
// parser (@agentlink/crypto parseJson, and the global JSON.parse) never sees an oversized content.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeUtf8, type EnvelopeKeys } from '@agentlink/crypto';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { wrapEvent } from 'nostr-tools/nip59';

const parseJsonSpy = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('@agentlink/crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agentlink/crypto')>();
  return {
    ...original,
    parseJson: (text: string, options?: Parameters<typeof original.parseJson>[1]) => {
      parseJsonSpy.calls.push(text);
      return original.parseJson(text, options);
    },
  };
});

const { ENVELOPE_MAX_BYTES, TransportError, unwrapGiftWrap } = await import('./index.js');

function recipientKeys(): EnvelopeKeys & { pubkey: string } {
  const secretKey = generateSecretKey();
  const reject = () => Promise.reject(new Error('not used by the transport'));
  return {
    pubkey: getPublicKey(secretKey),
    signEnvelopeHash: reject,
    unwrapCek: reject,
    signNostr: reject,
    nip44Encrypt: reject,
    nip44Decrypt: (peer: string, payload: string) =>
      Promise.resolve(nip44.decrypt(payload, nip44.utils.getConversationKey(secretKey, peer))),
  };
}

async function unwrapCode(content: string): Promise<string> {
  const sender = generateSecretKey();
  const recipient = recipientKeys();
  const wrap = wrapEvent(
    { kind: 14, tags: [['agentlink', '1']], content },
    sender,
    recipient.pubkey,
  );
  parseJsonSpy.calls.length = 0;
  try {
    await unwrapGiftWrap(wrap, recipient);
  } catch (error) {
    if (error instanceof TransportError) return error.code;
    throw error;
  }
  return 'accepted';
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('receive: rumor content size before JSON.parse (04 §3.1.1)', () => {
  it('drops a 24 577-byte content without parsing it', async () => {
    const jsonParse = vi.spyOn(JSON, 'parse');
    const content = `{${' '.repeat(ENVELOPE_MAX_BYTES + 1 - 2)}}`;
    expect(encodeUtf8(content).length).toBe(24_577);
    expect(await unwrapCode(content)).toBe('envelope_too_large');
    // The seal and the rumor were parsed (two calls); the content never was.
    expect(parseJsonSpy.calls).toHaveLength(2);
    expect(parseJsonSpy.calls).not.toContain(content);
    expect(jsonParse.mock.calls.some((call) => call[0] === content)).toBe(false);
  });

  it('counts UTF-8 bytes, not UTF-16 code units: 8 193 three-byte characters (24 579 bytes) are dropped', async () => {
    const content = '€'.repeat(8_193);
    expect(content.length).toBeLessThan(ENVELOPE_MAX_BYTES);
    expect(await unwrapCode(content)).toBe('envelope_too_large');
    expect(parseJsonSpy.calls).not.toContain(content);
  });

  it('parses a 24 576-byte content (the limit itself); it is refused only by the envelope parser', async () => {
    const content = `{${' '.repeat(ENVELOPE_MAX_BYTES - 2)}}`;
    expect(await unwrapCode(content)).toBe('invalid_envelope');
    expect(parseJsonSpy.calls).toContain(content);
  });
});
