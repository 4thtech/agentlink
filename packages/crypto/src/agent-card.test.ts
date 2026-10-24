// M1-1e: the AgentCard (04 §2.4), its JSON form (§2.4, §2.4.1), cardSig and cardAgentSig (§2.9) and
// sha256(JCS(card)) (§3.6). viem is the independent oracle for the EIP-712 digest and signatures.
import { hashTypedData as viemHashTypedData } from 'viem';
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  AGENT_CARD_DOMAIN,
  AGENT_CARD_TYPES,
  CryptoInputError,
  agentCardJcsHash,
  agentCardNameHash,
  agentCardRelaysHash,
  canonicalize,
  encodeHex,
  encodeHex0x,
  encodeUtf8,
  hashAgentCard,
  keccak256,
  parseAgentCard,
  parseAgentCardJson,
  sha256,
  verifyAgentCard,
  verifyCardAgentSig,
  verifyCardOwnerSig,
  type AgentCard,
} from './index.js';
import { signAgentCard } from './keystore.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Test keys are derived at run time, so no key material sits in the source. */
const testKey = (label: string): Uint8Array => keccak256(encodeUtf8(`m11e/card/${label}`));
const address = (key: Uint8Array): string =>
  privateKeyToAddress(encodeHex0x(key) as `0x${string}`).toLowerCase();
const b32 = (label: string): string => encodeHex0x(keccak256(encodeUtf8(`m11e/b32/${label}`)));

const OWNER_KEY = testKey('owner');
const AGENT_KEY = testKey('agent');
const OTHER_KEY = testKey('other');

const CARD: AgentCard = Object.freeze({
  version: 1,
  agentEvm: address(AGENT_KEY),
  agentNostr: b32('agent-nostr'),
  agentEnc: b32('agent-enc'),
  ownerEvm: address(OWNER_KEY),
  ownerNostr: b32('owner-nostr'),
  ownerEnc: b32('owner-enc'),
  nameHash: encodeHex0x(agentCardNameHash("Tali's Claude")),
  relaysHash: encodeHex0x(agentCardRelaysHash(['wss://relay.example.com'])),
  issuedAt: 1760000000,
  expiresAt: 1791536000,
  keyEpoch: 0,
});

const card = (changes: Record<string, unknown> = {}): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...CARD };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
};

const viemDigest = (c: AgentCard): string =>
  viemHashTypedData({
    domain: AGENT_CARD_DOMAIN,
    types: AGENT_CARD_TYPES,
    primaryType: 'AgentCard',
    message: c,
  } as never);

const expectCardError = (run: () => unknown): CryptoInputError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoInputError);
    expect(['invalid_card', 'invalid_json']).toContain((error as CryptoInputError).code);
    return error as CryptoInputError;
  }
  throw new Error('expected a CryptoInputError');
};

describe('AgentCard type and domain', () => {
  it('has the 04 §2.4 field order and the chain-agnostic domain', () => {
    expect(AGENT_CARD_DOMAIN).toEqual({ name: 'OCC AgentCard', version: '1' });
    expect(AGENT_CARD_TYPES.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
    ]);
    expect(AGENT_CARD_TYPES.AgentCard?.map((f) => `${f.type} ${f.name}`).join(',')).toBe(
      'uint8 version,address agentEvm,bytes32 agentNostr,bytes32 agentEnc,address ownerEvm,' +
        'bytes32 ownerNostr,bytes32 ownerEnc,bytes32 nameHash,bytes32 relaysHash,uint64 issuedAt,' +
        'uint64 expiresAt,uint32 keyEpoch',
    );
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(AGENT_CARD_DOMAIN)).toBe(true);
    expect(Object.isFrozen(AGENT_CARD_TYPES)).toBe(true);
    expect(Object.isFrozen(AGENT_CARD_TYPES.AgentCard)).toBe(true);
    expect(Object.isFrozen(AGENT_CARD_TYPES.AgentCard?.[0])).toBe(true);
    expect(Object.isFrozen(AGENT_CARD_TYPES.EIP712Domain)).toBe(true);
  });
});

describe('hashAgentCard', () => {
  it('matches viem for the card and for generated cards', () => {
    expect(encodeHex0x(hashAgentCard(CARD).digest)).toBe(viemDigest(CARD));
    for (let i = 0; i < 50; i += 1) {
      const c = card({
        agentNostr: b32(`n${i}`),
        ownerEnc: b32(`e${i}`),
        issuedAt: (i * 7919) % 2 ** 31,
        expiresAt: i % 3 === 0 ? 0 : Number.MAX_SAFE_INTEGER - i,
        keyEpoch: 2 ** 32 - 1 - i,
      }) as unknown as AgentCard;
      expect(encodeHex0x(hashAgentCard(c).digest)).toBe(viemDigest(c));
    }
  });

  it('returns the AgentCard type hash and the domain separator', () => {
    const hashes = hashAgentCard(CARD);
    expect(hashes.typeHash).toEqual(
      keccak256(
        encodeUtf8(
          'AgentCard(uint8 version,address agentEvm,bytes32 agentNostr,bytes32 agentEnc,' +
            'address ownerEvm,bytes32 ownerNostr,bytes32 ownerEnc,bytes32 nameHash,' +
            'bytes32 relaysHash,uint64 issuedAt,uint64 expiresAt,uint32 keyEpoch)',
        ),
      ),
    );
    expect(encodeHex(hashes.domainSeparator)).toBe(
      encodeHex(
        keccak256(
          Uint8Array.of(
            ...keccak256(encodeUtf8('EIP712Domain(string name,string version)')),
            ...keccak256(encodeUtf8('OCC AgentCard')),
            ...keccak256(encodeUtf8('1')),
          ),
        ),
      ),
    );
  });
});

describe('parseAgentCard', () => {
  it('accepts the canonical card and returns a frozen copy', () => {
    const input = card();
    const parsed = parseAgentCard(input);
    expect(parsed).toEqual(CARD);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('accepts the integer limits', () => {
    expect(() =>
      parseAgentCard(
        card({
          issuedAt: Number.MAX_SAFE_INTEGER,
          expiresAt: Number.MAX_SAFE_INTEGER,
          keyEpoch: 2 ** 32 - 1,
        }),
      ),
    ).not.toThrow();
    expect(() => parseAgentCard(card({ issuedAt: 0, expiresAt: 0 }))).not.toThrow();
  });

  const bad: Array<[string, unknown]> = [
    ['null', null],
    ['an array', [CARD]],
    ['a string', JSON.stringify(CARD)],
    ['a missing field', card({ keyEpoch: undefined })],
    ['a thirteenth field', card({ note: 'x' })],
    ['version 2', card({ version: 2 })],
    ['version 0', card({ version: 0 })],
    ['version as a string', card({ version: '1' })],
    ['issuedAt 2^53', card({ issuedAt: 2 ** 53 })],
    ['issuedAt -1', card({ issuedAt: -1 })],
    ['issuedAt -0', card({ issuedAt: -0 })],
    ['issuedAt 1.5', card({ issuedAt: 1.5 })],
    ['issuedAt NaN', card({ issuedAt: Number.NaN })],
    ['issuedAt as a bigint', card({ issuedAt: 1760000000n })],
    ['issuedAt as a string', card({ issuedAt: '1760000000' })],
    ['keyEpoch 2^32', card({ keyEpoch: 2 ** 32 })],
    ['agentEvm EIP-55', card({ agentEvm: privateKeyToAddress(encodeHex0x(AGENT_KEY) as never) })],
    ['agentEvm upper case', card({ agentEvm: '0x' + CARD.agentEvm.slice(2).toUpperCase() })],
    ['agentEvm 19 bytes', card({ agentEvm: CARD.agentEvm.slice(0, 40) })],
    ['ownerEvm without 0x', card({ ownerEvm: CARD.ownerEvm.slice(2) })],
    ['agentNostr upper case', card({ agentNostr: '0x' + CARD.agentNostr.slice(2).toUpperCase() })],
    ['ownerNostr with 0X', card({ ownerNostr: '0X' + CARD.ownerNostr.slice(2) })],
    ['ownerEnc bare hex', card({ ownerEnc: CARD.ownerEnc.slice(2) })],
    ['nameHash 31 bytes', card({ nameHash: CARD.nameHash.slice(0, 64) })],
    ['relaysHash 33 bytes', card({ relaysHash: CARD.relaysHash + '00' })],
    ['agentEnc as bytes', card({ agentEnc: keccak256(new Uint8Array(1)) })],
    ['agentEvm equal to ownerEvm', card({ agentEvm: CARD.ownerEvm })],
  ];
  it.each(bad)('refuses %s', (_, value) => {
    expectCardError(() => parseAgentCard(value));
    expectCardError(() => hashAgentCard(value));
    expectCardError(() => agentCardJcsHash(value));
    expectCardError(() => signAgentCard(value, OWNER_KEY));
  });

  it('refuses accessor, symbol and inherited fields without reading them', () => {
    let reads = 0;
    const withGetter = card();
    Object.defineProperty(withGetter, 'keyEpoch', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 0;
      },
    });
    expectCardError(() => parseAgentCard(withGetter));
    expect(reads).toBe(0);

    const withSymbol = card();
    (withSymbol as Record<symbol, unknown>)[Symbol('x')] = 1;
    expectCardError(() => parseAgentCard(withSymbol));

    const inherited = Object.create(card()) as object;
    expectCardError(() => parseAgentCard(inherited));

    class Card {}
    expectCardError(() => parseAgentCard(Object.assign(new Card(), card())));
  });

  it('names no field value in its errors', () => {
    const marker = '0x' + 'ab'.repeat(19) + 'cd';
    const error = expectCardError(() => parseAgentCard(card({ agentEvm: marker.toUpperCase() })));
    expect(error.message.toLowerCase()).not.toContain('abab');
  });
});

describe('parseAgentCardJson', () => {
  const text = JSON.stringify(CARD);

  it('parses the card JSON text and hashes like the object', () => {
    expect(parseAgentCardJson(text)).toEqual(CARD);
    expect(hashAgentCard(parseAgentCardJson(text)).digest).toEqual(hashAgentCard(CARD).digest);
  });

  it('parses an escape inside a string value (M1-1h-b, 04 §2.5.1)', () => {
    const escaped = text.replace('"agentEvm":"0x', '"agentEvm":"\\u0030x');
    expect(escaped).not.toBe(text);
    expect(parseAgentCardJson(escaped)).toEqual(CARD);
  });

  it.each([
    ['a duplicate key', text.slice(0, -1) + ',"keyEpoch":0}'],
    ['version 1.0', text.replace('"version":1,', '"version":1.0,')],
    ['issuedAt 1.76e9', text.replace('"issuedAt":1760000000', '"issuedAt":1.76e9')],
    ['issuedAt 1760000000e0', text.replace('"issuedAt":1760000000', '"issuedAt":1760000000e0')],
    ['expiresAt with .0', text.replace('"expiresAt":1791536000', '"expiresAt":1791536000.0')],
    ['keyEpoch -0', text.replace('"keyEpoch":0', '"keyEpoch":-0')],
    [
      'issuedAt 9007199254740991.4',
      text.replace('"issuedAt":1760000000', '"issuedAt":9007199254740991.4'),
    ],
    [
      'issuedAt 9007199254740993',
      text.replace('"issuedAt":1760000000', '"issuedAt":9007199254740993'),
    ],
    ['issuedAt 01760000000', text.replace('"issuedAt":1760000000', '"issuedAt":01760000000')],
    ['trailing content', text + 'x'],
    // M1-1h-b (D-128, 04 §2.5.1): a member name written with an escape.
    ['an escaped member name', text.replace('"agentEvm":', '"\\u0061gentEvm":')],
    ['an escaped member name at the end', text.replace('"keyEpoch":', '"keyEpoc\\u0068":')],
    ['not an object', '[' + text + ']'],
  ])('refuses %s', (_, candidate) => {
    expect(candidate).not.toBe(text);
    expectCardError(() => parseAgentCardJson(candidate));
  });

  it('refuses a non-string', () => {
    try {
      parseAgentCardJson(CARD as unknown as string);
      throw new Error('expected a CryptoInputError');
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoInputError);
    }
  });
});

describe('agentCardJcsHash', () => {
  it('is sha256 over the RFC 8785 form of the card JSON', () => {
    // For this card (ASCII strings, safe integers) JCS is JSON.stringify with sorted keys.
    const sorted = Object.fromEntries(Object.entries(CARD).sort(([a], [b]) => (a < b ? -1 : 1)));
    const expected = sha256(encodeUtf8(JSON.stringify(sorted)));
    expect(agentCardJcsHash(CARD)).toEqual(expected);
    expect(agentCardJcsHash(card())).toEqual(expected);
    expect(canonicalize(parseAgentCard(card()))).toBe(JSON.stringify(sorted));
  });

  it('does not depend on the key order of the input', () => {
    const reversed = Object.fromEntries(Object.entries(CARD).reverse());
    expect(agentCardJcsHash(reversed)).toEqual(agentCardJcsHash(CARD));
  });

  it('differs from the EIP-712 digest and changes with every field', () => {
    const base = agentCardJcsHash(CARD);
    expect(base).not.toEqual(hashAgentCard(CARD).digest);
    expect(agentCardJcsHash(card({ keyEpoch: 1 }))).not.toEqual(base);
    expect(agentCardJcsHash(card({ agentEnc: b32('changed') }))).not.toEqual(base);
  });
});

describe('agentCardNameHash and agentCardRelaysHash', () => {
  it('hash the exact UTF-8 name and the JCS relay list, without normalising', () => {
    expect(agentCardNameHash("Tali's Claude")).toEqual(keccak256(encodeUtf8("Tali's Claude")));
    // NFC and NFD spellings of "Å" are different names.
    expect(agentCardNameHash('Å')).not.toEqual(agentCardNameHash('Å'));
    const relays = ['wss://b.example.org', 'wss://a.example.com'];
    expect(agentCardRelaysHash(relays)).toEqual(
      keccak256(encodeUtf8('["wss://b.example.org","wss://a.example.com"]')),
    );
    expect(agentCardRelaysHash([...relays].reverse())).not.toEqual(agentCardRelaysHash(relays));
    expect(agentCardRelaysHash([])).toEqual(keccak256(encodeUtf8('[]')));
  });

  it('refuse values JSON or UTF-8 cannot carry', () => {
    for (const run of [
      () => agentCardNameHash('a\ud800'),
      () => agentCardNameHash(1 as unknown as string),
      () => agentCardRelaysHash(['wss://a.example\udc00']),
      () => agentCardRelaysHash([1] as unknown as string[]),
      () => agentCardRelaysHash('wss://a.example.com' as unknown as string[]),
    ]) {
      expect(run).toThrow(CryptoInputError);
    }
  });
});

describe('cardSig and cardAgentSig', () => {
  const cardSig = signAgentCard(CARD, OWNER_KEY);
  const cardAgentSig = signAgentCard(CARD, AGENT_KEY);

  it('sign like viem: EIP-712 over the card under the card domain, 0x + 130 hex', async () => {
    const typed = {
      domain: AGENT_CARD_DOMAIN,
      types: AGENT_CARD_TYPES,
      primaryType: 'AgentCard',
      message: CARD,
    } as never;
    expect(cardSig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(cardSig).toBe(
      await privateKeyToAccount(encodeHex0x(OWNER_KEY) as never).signTypedData(typed),
    );
    expect(cardAgentSig).toBe(
      await privateKeyToAccount(encodeHex0x(AGENT_KEY) as never).signTypedData(typed),
    );
  });

  it('verify against the right key only', () => {
    expect(verifyCardOwnerSig(CARD, cardSig)).toBe(true);
    expect(verifyCardAgentSig(CARD, cardAgentSig)).toBe(true);
    expect(verifyAgentCard(CARD, cardSig, cardAgentSig)).toBe(true);
    // Swapped: the agent's signature is not the owner's and the reverse.
    expect(verifyCardOwnerSig(CARD, cardAgentSig)).toBe(false);
    expect(verifyCardAgentSig(CARD, cardSig)).toBe(false);
    expect(verifyAgentCard(CARD, cardAgentSig, cardSig)).toBe(false);
    expect(verifyAgentCard(CARD, cardSig, cardSig)).toBe(false);
    // Another key.
    const other = signAgentCard(CARD, OTHER_KEY);
    expect(verifyCardOwnerSig(CARD, other)).toBe(false);
    expect(verifyCardAgentSig(CARD, other)).toBe(false);
  });

  it('cardAgentSig is mandatory in verifyAgentCard (#24)', () => {
    for (const missing of [undefined, null, '', '0x']) {
      expect(verifyAgentCard(CARD, cardSig, missing)).toBe(false);
      expect(verifyAgentCard(CARD, missing, cardAgentSig)).toBe(false);
    }
  });

  it('fail when any field changes after signing', () => {
    for (const [field, value] of Object.entries({
      version: 2,
      agentNostr: b32('x'),
      agentEnc: b32('x'),
      ownerNostr: b32('x'),
      ownerEnc: b32('x'),
      nameHash: b32('x'),
      relaysHash: b32('x'),
      issuedAt: 1,
      expiresAt: 0,
      keyEpoch: 1,
    })) {
      const changed = card({ [field]: value });
      expect(verifyCardOwnerSig(changed, cardSig), field).toBe(false);
      expect(verifyCardAgentSig(changed, cardAgentSig), field).toBe(false);
    }
  });

  it('refuse every non-canonical signature form', () => {
    for (const sig of [cardSig, cardAgentSig]) {
      const r = sig.slice(2, 66);
      const s = BigInt('0x' + sig.slice(66, 130));
      const v = Number.parseInt(sig.slice(130), 16);
      const highS = '0x' + r + (N - s).toString(16).padStart(64, '0') + (55 - v).toString(16);
      const forms = [
        highS,
        sig.slice(0, 130) + (v - 27).toString(16).padStart(2, '0'),
        sig.slice(0, 130),
        '0x' + sig.slice(2).toUpperCase(),
        sig.slice(2),
        sig.slice(0, 130) + '1d',
        '0x' + '00'.repeat(32) + sig.slice(66),
        '0x' + r + '00'.repeat(32) + sig.slice(130),
        '0x' + N.toString(16) + sig.slice(66),
        Uint8Array.of(1, 2, 3),
        42,
        undefined,
      ];
      for (const form of forms) {
        expect(verifyCardOwnerSig(CARD, form)).toBe(false);
        expect(verifyCardAgentSig(CARD, form)).toBe(false);
      }
    }
  });

  it('refuse a signature under another domain', async () => {
    const owner = privateKeyToAccount(encodeHex0x(OWNER_KEY) as never);
    const withChain = await owner.signTypedData({
      domain: { ...AGENT_CARD_DOMAIN, chainId: 1 },
      types: { AgentCard: AGENT_CARD_TYPES.AgentCard },
      primaryType: 'AgentCard',
      message: CARD,
    } as never);
    expect(verifyCardOwnerSig(CARD, withChain)).toBe(false);
    const occ = await owner.signTypedData({
      domain: { name: 'OCC', version: '2' },
      types: { AgentCard: AGENT_CARD_TYPES.AgentCard },
      primaryType: 'AgentCard',
      message: CARD,
    } as never);
    expect(verifyCardOwnerSig(CARD, occ)).toBe(false);
  });

  it('verification never throws on hostile input', () => {
    const trap = (): never => {
      throw new TypeError('trap');
    };
    const proxy = new Proxy(card(), { ownKeys: trap, getOwnPropertyDescriptor: trap });
    const hostile = [
      null,
      1,
      'x',
      [],
      {},
      card({ agentEvm: CARD.ownerEvm }),
      card({ version: 2 }),
      proxy, // IR-M1-1e-1 I-1
    ];
    for (const c of hostile) {
      expect(verifyCardOwnerSig(c, cardSig)).toBe(false);
      expect(verifyCardAgentSig(c, cardAgentSig)).toBe(false);
      expect(verifyAgentCard(c, cardSig, cardAgentSig)).toBe(false);
    }
  });

  it('signing refuses a bad key without echoing it', () => {
    for (const [key, code] of [
      [new Uint8Array(32), 'invalid_argument'],
      [new Uint8Array(31).fill(9), 'invalid_length'],
    ] as const) {
      try {
        signAgentCard(CARD, key);
        throw new Error('expected a CryptoInputError');
      } catch (error) {
        expect((error as CryptoInputError).code).toBe(code);
        expect((error as Error).message).not.toContain('0909');
      }
    }
  });
});
