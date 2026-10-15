// M1-1b: owner and agent fingerprints (04 §2.9); M1-1-sc: the sender code (D-72). Display strings only: they identify, they do not
// authenticate. The cross-runtime vectors are in test-vectors/fingerprint.
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  TAGS,
  agentFingerprint,
  concatBytes,
  decodeHex0x,
  encodeHex,
  formatFingerprint,
  decodeHex,
  ownerFingerprint,
  senderCode,
  taggedHash,
} from './index.js';

// test-vectors/fingerprint, case owner-a.
const OWNER_EVM = decodeHex0x('0x697fd2bdc55e958f691b55866c8dfa4ce4647afc');
const OWNER_NOSTR = decodeHex0x(
  '0x0ff90544f8f613aae3e42a3993eddadc5111aea279c7a9bd3f8ff846781bfa52',
);
const OWNER_ENC = decodeHex0x('0x4fecb0752fb38a3084a09412cf6f00012c0a73893fecccf1e85ced9583415871');
const AGENT_ID = decodeHex0x('0x6570c98c156b367a207f1589a4400ea5ba50e67a');
// test-vectors/fingerprint, case sender-code: an unknown sender's envelope `from` (bare hex).
const SENDER_FROM = decodeHex(
  '0296b365646245d8a883d850cc44b5152f014f02ee3b29d5a71c3ad6c01a0c35',
);

function expectRefused(run: () => unknown): void {
  expect(run).toThrow(CryptoInputError);
}

describe('fingerprint tags (IR-M1-1b-1 L-1: one frozen registry)', () => {
  it('are the 04 §2.9 tags, held in the frozen TAGS registry', () => {
    expect(TAGS.ownerFingerprint).toBe('agentlink/owner-fingerprint/v1');
    expect(TAGS.agentFingerprint).toBe('agentlink/agent-fingerprint/v1');
    expect(TAGS.senderCode).toBe('agentlink/sender-code/v1');
    expect(Object.isFrozen(TAGS)).toBe(true);
  });

  it('are distinct from every other protocol tag', () => {
    const tags = Object.values(TAGS);
    expect(new Set(tags).size).toBe(tags.length);
  });
});

describe('ownerFingerprint', () => {
  it('is the tagged hash over ownerEvm || ownerNostr || ownerEnc (20 + 32 + 32 raw bytes)', () => {
    const digest = ownerFingerprint(OWNER_EVM, OWNER_NOSTR, OWNER_ENC);
    expect(encodeHex(digest)).toBe(
      encodeHex(
        taggedHash(
          'agentlink/owner-fingerprint/v1',
          concatBytes(OWNER_EVM, OWNER_NOSTR, OWNER_ENC),
        ),
      ),
    );
    expect(encodeHex(digest)).toBe(
      '13afa1dc553e422f02164e31ce2940f0343390abd886c054d7be8096619f4e4b',
    );
  });

  it('changes with ownerEvm, so copying another owner nostr key does not copy its fingerprint', () => {
    const other = Uint8Array.from(OWNER_EVM);
    other[19] = (other[19] as number) ^ 1;
    expect(encodeHex(ownerFingerprint(other, OWNER_NOSTR, OWNER_ENC))).not.toBe(
      encodeHex(ownerFingerprint(OWNER_EVM, OWNER_NOSTR, OWNER_ENC)),
    );
  });

  it('refuses inputs of the wrong length, including swapped arguments', () => {
    expectRefused(() => ownerFingerprint(OWNER_NOSTR, OWNER_EVM, OWNER_ENC));
    expectRefused(() => ownerFingerprint(OWNER_EVM, OWNER_ENC.subarray(1), OWNER_ENC));
    expectRefused(() => ownerFingerprint(OWNER_EVM, OWNER_NOSTR, new Uint8Array(33)));
    expectRefused(() =>
      ownerFingerprint('0x697f' as unknown as Uint8Array, OWNER_NOSTR, OWNER_ENC),
    );
  });
});

describe('agentFingerprint', () => {
  it('is the tagged hash over the raw 20-byte agent ID', () => {
    expect(encodeHex(agentFingerprint(AGENT_ID))).toBe(
      encodeHex(taggedHash('agentlink/agent-fingerprint/v1', AGENT_ID)),
    );
  });

  it('is not the owner fingerprint tag (domain separation)', () => {
    expect(encodeHex(agentFingerprint(AGENT_ID))).not.toBe(
      encodeHex(taggedHash('agentlink/owner-fingerprint/v1', AGENT_ID)),
    );
  });

  it('refuses anything but 20 bytes', () => {
    expectRefused(() => agentFingerprint(new Uint8Array(19)));
    expectRefused(() => agentFingerprint(new Uint8Array(32)));
    expectRefused(() => agentFingerprint('0x6570' as unknown as Uint8Array));
  });
});

describe('formatFingerprint', () => {
  const digest = ownerFingerprint(OWNER_EVM, OWNER_NOSTR, OWNER_ENC);

  it('short: first 4 bytes, upper case, two groups joined by U+00B7', () => {
    expect(formatFingerprint(digest, 'short')).toBe('13AF·A1DC');
  });

  it('extended: first 8 bytes in four groups, for entries whose short forms collide', () => {
    expect(formatFingerprint(digest, 'extended')).toBe('13AF·A1DC·553E·422F');
  });

  it('long: all 32 bytes as 64 upper-case hex digits; domainClaim: the same in lower case', () => {
    expect(formatFingerprint(digest, 'long')).toBe(
      '13AFA1DC553E422F02164E31CE2940F0343390ABD886C054D7BE8096619F4E4B',
    );
    expect(formatFingerprint(digest, 'domainClaim')).toBe(
      '13afa1dc553e422f02164e31ce2940f0343390abd886c054d7be8096619f4e4b',
    );
  });

  it('refuses a digest that is not 32 bytes and an unknown form', () => {
    expectRefused(() => formatFingerprint(digest.subarray(0, 31), 'short'));
    expectRefused(() => formatFingerprint(digest, 'medium' as never));
  });
});

describe('senderCode (04 §2.9, D-72)', () => {
  it('is the tagged hash over the 32 raw bytes of the from key', () => {
    const digest = senderCode(SENDER_FROM);
    expect(encodeHex(digest)).toBe(
      encodeHex(taggedHash('agentlink/sender-code/v1', SENDER_FROM)),
    );
    expect(encodeHex(digest)).toBe(
      'aac5623d7d1800ea2a3d64eaf9b1d224dee78859f23323ce42cb2f24d6ff1e79',
    );
  });

  it('is shown in the short form, as in "unknown sender · XXXX·XXXX"', () => {
    expect(formatFingerprint(senderCode(SENDER_FROM), 'short')).toBe('AAC5·623D');
  });

  it('is not the agent or owner fingerprint tag (domain separation)', () => {
    const code = encodeHex(senderCode(SENDER_FROM));
    expect(code).not.toBe(encodeHex(taggedHash('agentlink/agent-fingerprint/v1', SENDER_FROM)));
    expect(code).not.toBe(encodeHex(taggedHash('agentlink/owner-fingerprint/v1', SENDER_FROM)));
  });

  it('tells two senders apart', () => {
    const other = Uint8Array.from(SENDER_FROM);
    other[31] = (other[31] as number) ^ 1;
    expect(encodeHex(senderCode(other))).not.toBe(encodeHex(senderCode(SENDER_FROM)));
  });

  it('refuses anything but 32 bytes', () => {
    expectRefused(() => senderCode(new Uint8Array(31)));
    expectRefused(() => senderCode(new Uint8Array(33)));
    expectRefused(() => senderCode(AGENT_ID));
    expectRefused(() => senderCode(new Uint8Array(0)));
    expectRefused(() =>
      senderCode('0296b365646245d8a883d850cc44b5152f014f02ee3b29d5a71c3ad6c01a0c35' as never),
    );
  });
});
