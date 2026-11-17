// SEC-KS-712-ALLOWLIST: the agent key signs only known typed-data shapes (04 §3.1.1 `sign712`).
// typedDataSnapshot is the one validator every KeyStore backend runs before it reads a seed; the
// MemoryKeyStore cases show a backend refuses before any key is used.
import { describe, expect, it } from 'vitest';
import { AGENT_CARD_DOMAIN, AGENT_CARD_TYPES, type AgentCard } from './agent-card.js';
import { decodeEcdsaSignature, recoverEvmAddress } from './ecdsa.js';
import { hashTypedData, type TypedData } from './eip712.js';
import { encodeHex, encodeHex0x } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { DIRECT_TX_ALLOWLIST } from './evm-tx.js';
import { deriveAgentId, derivePublicIdentity } from './keys.js';
import {
  occV2Domain,
  receiptTypedData,
  receiveWithAuthorizationTypedData,
  recordTypedData,
} from './proof-types.js';
import { MemoryKeyStore } from './testing.js';
import {
  TYPED_DATA_ALLOWLIST,
  TYPED_DATA_REFUSED,
  typedDataSnapshot,
  type TypedDataRefusal,
} from './typed-data-allowlist.js';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 3);
const OWN = deriveAgentId(SEED);
const OTHER = `0x${'11'.repeat(20)}`;
const ZERO32 = `0x${'0'.repeat(64)}`;
const NATIVE = `0x${'0'.repeat(40)}`;
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const NOTARY = (DIRECT_TX_ALLOWLIST[84532] as { notary: string }).notary;
const VAULT = (DIRECT_TX_ALLOWLIST[84532] as { vault: string }).vault;
const now = (): number => Math.floor(Date.now() / 1000);

function record(over: Record<string, unknown> = {}, domain = occV2Domain(84532, NOTARY)) {
  return recordTypedData(domain, {
    signer: OWN,
    envelopeHash: `0x${'ab'.repeat(32)}`,
    recipientCommitment: `0x${'cd'.repeat(32)}`,
    parentRecordId: ZERO32,
    appId: ZERO32,
    kind: 1,
    feeToken: USDC,
    maxFee: '100000',
    nonce: '7',
    deadline: now() + 3_600,
    ...over,
  });
}

function receipt(over: Record<string, unknown> = {}, domain = occV2Domain(84532, NOTARY)) {
  return receiptTypedData(domain, {
    signer: OWN,
    recordId: `0x${'ef'.repeat(32)}`,
    receiptType: 1,
    salt: `0x${'12'.repeat(32)}`,
    deadline: now() + 3_600,
    ...over,
  });
}

function card(over: Partial<AgentCard> = {}): TypedData {
  const id = derivePublicIdentity(SEED, 0);
  return {
    types: AGENT_CARD_TYPES,
    primaryType: 'AgentCard',
    domain: { ...AGENT_CARD_DOMAIN },
    message: {
      version: 1,
      agentEvm: OWN,
      agentNostr: encodeHex0x(id.agentNostr),
      agentEnc: encodeHex0x(id.agentEnc),
      ownerEvm: OTHER,
      ownerNostr: `0x${'21'.repeat(32)}`,
      ownerEnc: `0x${'22'.repeat(32)}`,
      nameHash: `0x${'23'.repeat(32)}`,
      relaysHash: `0x${'24'.repeat(32)}`,
      issuedAt: now(),
      expiresAt: 0,
      keyEpoch: 0,
      ...over,
    },
  };
}

const USDC_DOMAIN = { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC };

function topUp(over: Record<string, unknown> = {}, domain: object = USDC_DOMAIN) {
  return receiveWithAuthorizationTypedData(domain, {
    from: OWN,
    to: VAULT,
    value: '20000000',
    validAfter: '0',
    validBefore: String(now() + 900),
    nonce: `0x${'5a'.repeat(32)}`,
    ...over,
  });
}

function refusal(fn: () => unknown): { code: string; message: string } | 'accepted' {
  try {
    fn();
  } catch (error) {
    if (error instanceof CryptoInputError) return { code: error.code, message: error.message };
    throw error;
  }
  return 'accepted';
}

const fixed = (reason: TypedDataRefusal) => ({
  code: 'typed_data_refused',
  message: TYPED_DATA_REFUSED[reason],
});

describe('typedDataSnapshot: the allowed shapes', () => {
  it.each([
    ['an OCC v2 Record', () => record()],
    [
      'an OCC v2 Record on Gnosis Chiado (native fee)',
      () => record({ feeToken: NATIVE, maxFee: '100000000000000000' }, occV2Domain(10200, NOTARY)),
    ],
    ['an OCC v2 Receipt', () => receipt()],
    ['the agent card', () => card()],
    ['the vault top-up authorization', () => topUp()],
  ])('%s passes unchanged (same digest)', (_what, make) => {
    const typed = make();
    const snapshot = typedDataSnapshot(typed, OWN, now());
    expect(encodeHex(hashTypedData(snapshot).digest)).toBe(encodeHex(hashTypedData(typed).digest));
  });

  it('accepts the token domain address in its EIP-55 form, as a chain read returns it', () => {
    const typed = topUp(
      {},
      { ...USDC_DOMAIN, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
    );
    expect(refusal(() => typedDataSnapshot(typed, OWN, now()))).toBe('accepted');
  });

  it('every chain of the allowlist is a direct-mode chain with the same contracts', () => {
    for (const [chainId, chain] of Object.entries(TYPED_DATA_ALLOWLIST)) {
      const direct = DIRECT_TX_ALLOWLIST[Number(chainId)];
      expect(direct).toBeDefined();
      expect(chain.notary).toBe(direct?.notary);
      expect(chain.vault).toBe(direct?.vault);
    }
  });
});

describe('typedDataSnapshot: everything else is refused with a fixed error', () => {
  const MAIL: TypedData = {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }],
      Note: [{ name: 'text', type: 'string' }],
    },
    primaryType: 'Note',
    domain: { name: 'AgentLink test' },
    message: { text: 'hello' },
  };
  const later = now() + 86_400;

  const cases: [string, () => unknown, TypedDataRefusal][] = [
    ['an unknown primaryType', () => MAIL, 'type_not_allowed'],
    [
      'a Registration (owner-signed only)',
      () => ({ ...record(), primaryType: 'Registration' }),
      'type_not_allowed',
    ],
    [
      'a Record with an extra type member',
      () => {
        const td = record();
        return { ...td, types: { ...td.types, Extra: [{ name: 'x', type: 'uint8' }] } };
      },
      'type_not_allowed',
    ],
    [
      'a Record with a field renamed',
      () => {
        const td = record();
        const fields = (td.types.Record ?? []).map((f) =>
          f.name === 'maxFee' ? { ...f, name: 'fee' } : f,
        );
        return { ...td, types: { ...td.types, Record: fields } };
      },
      'type_not_allowed',
    ],
    ['a Record on a mainnet', () => record({}, occV2Domain(1, NOTARY)), 'domain_not_allowed'],
    ['a Record on Base mainnet', () => record({}, occV2Domain(8453, NOTARY)), 'domain_not_allowed'],
    [
      'a Record for another contract',
      () => record({}, occV2Domain(84532, OTHER)),
      'domain_not_allowed',
    ],
    [
      'a Record under another domain name',
      () => ({ ...record(), domain: { ...record().domain, name: 'OCX' } }),
      'domain_not_allowed',
    ],
    [
      'a Record under another domain version',
      () => ({ ...record(), domain: { ...record().domain, version: '3' } }),
      'domain_not_allowed',
    ],
    ['a Record signed for someone else', () => record({ signer: OTHER }), 'signer_not_allowed'],
    ['a Record over the fee ceiling', () => record({ maxFee: '500001' }), 'fee_not_allowed'],
    [
      'a Record in a token that is not a fee token there',
      () => record({ feeToken: OTHER }),
      'fee_not_allowed',
    ],
    [
      'a Record in the native coin on Base Sepolia',
      () => record({ feeToken: NATIVE }),
      'fee_not_allowed',
    ],
    [
      'a Record with another app ID',
      () => record({ appId: `0x${'0'.repeat(63)}1` }),
      'app_not_allowed',
    ],
    ['a Record with a long deadline', () => record({ deadline: later }), 'deadline_not_allowed'],
    ['a Receipt signed for someone else', () => receipt({ signer: OTHER }), 'signer_not_allowed'],
    ['a Receipt with a long deadline', () => receipt({ deadline: later }), 'deadline_not_allowed'],
    [
      'a Receipt for another contract',
      () => receipt({}, occV2Domain(84532, OTHER)),
      'domain_not_allowed',
    ],
    ['another agent card', () => card({ agentEvm: OTHER }), 'signer_not_allowed'],
    [
      'a card under another domain',
      () => ({ ...card(), domain: { name: 'OCC AgentCard', version: '2' } }),
      'domain_not_allowed',
    ],
    ['a top-up to another address', () => topUp({ to: OTHER }), 'payee_not_allowed'],
    ['a top-up from another address', () => topUp({ from: OTHER }), 'signer_not_allowed'],
    ['a top-up over the cap', () => topUp({ value: '50000001' }), 'value_not_allowed'],
    [
      'a top-up with a long validity',
      () => topUp({ validBefore: String(later) }),
      'deadline_not_allowed',
    ],
    [
      'a top-up under another token',
      () => topUp({}, { ...USDC_DOMAIN, verifyingContract: OTHER }),
      'domain_not_allowed',
    ],
    [
      'a top-up under another token name',
      () => topUp({}, { ...USDC_DOMAIN, name: 'USD Coin' }),
      'domain_not_allowed',
    ],
    [
      'a top-up on another chain',
      () => topUp({}, { ...USDC_DOMAIN, chainId: 8453 }),
      'domain_not_allowed',
    ],
    [
      'a top-up with the OCC domain',
      () => topUp({}, { ...occV2Domain(84532, NOTARY) }),
      'domain_not_allowed',
    ],
    [
      'a record message with an extra field',
      () => ({ ...record(), message: { ...record().message, extra: 1 } }),
      'malformed',
    ],
    ['typed data with an extra member', () => ({ ...record(), extra: 1 }), 'malformed'],
    ['not an object', () => 'typed data', 'malformed'],
  ];

  it.each(cases)('%s', (_what, make, reason) => {
    expect(refusal(() => typedDataSnapshot(make(), OWN, now()))).toEqual(fixed(reason));
  });

  it('refusal messages are fixed sentences that never name an input', () => {
    for (const message of Object.values(TYPED_DATA_REFUSED)) {
      expect(message).toMatch(/^sign712: /);
      expect(message).not.toMatch(/0x/);
    }
  });
});

describe('MemoryKeyStore.sign712 applies the allowlist before any key is used', () => {
  it('signs each allowed shape with the agent EVM key', async () => {
    const store = new MemoryKeyStore(SEED, { keyEpoch: 2 });
    for (const typed of [record(), receipt(), card(), topUp()]) {
      const sig = await store.sign712(typed);
      const signer = recoverEvmAddress(hashTypedData(typed).digest, decodeEcdsaSignature(sig));
      expect(encodeHex0x(signer)).toBe(OWN);
    }
  });

  it('refuses on a closed store with the fixed error, not keystore_closed', async () => {
    const store = new MemoryKeyStore(SEED);
    await store.close();
    await expect(store.sign712(record({ maxFee: '500001' }))).rejects.toMatchObject(
      fixed('fee_not_allowed'),
    );
    await expect(store.sign712(topUp({ to: OTHER }))).rejects.toMatchObject(
      fixed('payee_not_allowed'),
    );
  });
});
