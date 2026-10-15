// M1-8h (IR-M1-9b-1 M-1, IR-M1-8c-1 F-4): the owner key signs only what an owner flow of 04 §2.5
// defines. EIP-712 typed data: only the agent card (04 §2.4: domain {name: "OCC AgentCard",
// version: "1"}, primary type AgentCard, exactly its twelve fields). Owner actions: only the ops of
// 04 §2.5.1 (approval.decide, approval.decideBatch, approval.cancel, policy.set, agent.revoke,
// contact.check). Anything else is refused with one fixed text before the owner is asked anything,
// so no prompt opens and nothing is signed.
import {
  AGENT_CARD_DOMAIN,
  AGENT_CARD_TYPES,
  agentCardNameHash,
  agentCardRelaysHash,
  decodeHex,
  encodeHex,
  encodeHex0x,
  encodeUtf8,
  equalBytes,
  hashTypedData,
  randomBytes,
  recoverEvmAddress,
  verifyCardOwnerSig,
  type AgentCard,
  type JsonObject,
  type OwnerPublicKeys,
  type TypedData,
} from '@agentlink/crypto';
import { describe, expect, it } from 'vitest';
import { NodeKeyStoreError } from './errors.js';
import { performOwnerOperation } from './index.js';
import type { KeychainBackend } from './keychain.js';
import { OWNER_OPERATION_REFUSED } from './owner-allowlist.js';
import { initOwnerWith } from './owner-init.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import { runOwnerGesture, runOwnerOperation, type OwnerSignRequest } from './owner-operation.js';
import type { OwnerTerminal } from './owner-terminal.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const AGENT = `0x${'ab'.repeat(20)}`;

/** The fixed refusal text, spelled out so this test does not trust the code's constant. */
const REFUSED = "AgentLink doesn't sign this with your owner key. Nothing was signed.";

class FakeKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    return this.items.get(account)?.slice() ?? null;
  }
  async set(account: string, value: Uint8Array): Promise<void> {
    await Promise.resolve();
    this.items.set(account, value.slice());
  }
  async delete(account: string): Promise<boolean> {
    await Promise.resolve();
    return this.items.delete(account);
  }
}

function scripted(answers: string[]) {
  const written: string[] = [];
  const labels: string[] = [];
  const terminal: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: (label) => {
      labels.push(label);
      const next = answers.shift();
      if (next === undefined) return Promise.reject(new Error('no scripted answer'));
      return Promise.resolve(encodeUtf8(next));
    },
    confirm: () => Promise.resolve(true),
    clearScreen: () => void written.push('<clear>'),
  };
  return { terminal, written, labels };
}

const codeShown = (written: readonly string[]): string =>
  (written.find((t) => t.startsWith('Your owner code: ')) ?? '').slice('Your owner code: '.length);

async function ready() {
  const keychain = new FakeKeychain();
  const run = scripted([]);
  run.terminal.readSecret = () => Promise.resolve(encodeUtf8(codeShown(run.written).slice(-4)));
  const result = await initOwnerWith(
    keychain,
    run.terminal,
    { backend: 'keychain', env: {} },
    { kdf: KDF },
  );
  const store = await KeychainOwnerKeyStore.open(keychain, result.owner);
  return { owner: result.owner, code: codeShown(run.written), store };
}

function cardFor(owner: OwnerPublicKeys): AgentCard {
  return {
    version: 1,
    agentEvm: AGENT,
    agentNostr: encodeHex0x(randomBytes(32)),
    agentEnc: encodeHex0x(randomBytes(32)),
    ownerEvm: encodeHex0x(owner.ownerEvm),
    ownerNostr: encodeHex0x(owner.ownerNostr),
    ownerEnc: encodeHex0x(owner.ownerEnc),
    nameHash: encodeHex0x(agentCardNameHash('Agent')),
    relaysHash: encodeHex0x(agentCardRelaysHash(['wss://one.relay-alpha.net', 'wss://nos.lol'])),
    issuedAt: 1_760_000_000,
    expiresAt: 0,
    keyEpoch: 0,
  } as unknown as AgentCard;
}

const cardTyped = (card: AgentCard): TypedData => ({
  types: AGENT_CARD_TYPES,
  primaryType: 'AgentCard',
  domain: AGENT_CARD_DOMAIN,
  message: card as unknown as Record<string, unknown>,
});

function ownerAction(owner: OwnerPublicKeys, op: string, params: JsonObject): JsonObject {
  return {
    v: 1,
    agent: AGENT,
    owner: encodeHex(owner.ownerNostr),
    op,
    params,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    issuedAt: 1_760_000_000,
    expiresAt: 1_760_000_600,
  };
}

/** Every typed-data request the allowlist must refuse, built from a valid card for `owner`. */
function refusedTypedData(owner: OwnerPublicKeys): [string, unknown][] {
  const card = cardFor(owner) as unknown as Record<string, unknown>;
  const good = cardTyped(card as unknown as AgentCard) as unknown as Record<string, unknown>;
  const domainField = (name: string, type: string) => ({ name, type });
  return [
    ['a domain with a chainId', { ...good, domain: { ...AGENT_CARD_DOMAIN, chainId: 1 } }],
    [
      'a domain with a verifyingContract',
      { ...good, domain: { ...AGENT_CARD_DOMAIN, verifyingContract: AGENT } },
    ],
    ['a domain with a salt', { ...good, domain: { ...AGENT_CARD_DOMAIN, salt: '0x' + '00'.repeat(32) } }],
    ['another domain name', { ...good, domain: { name: 'OCC Registry', version: '1' } }],
    ['another domain version', { ...good, domain: { name: 'OCC AgentCard', version: '2' } }],
    ['a domain without version', { ...good, domain: { name: 'OCC AgentCard' } }],
    [
      'the OCC v2 Registration',
      {
        types: {
          EIP712Domain: [
            domainField('name', 'string'),
            domainField('version', 'string'),
            domainField('chainId', 'uint256'),
            domainField('verifyingContract', 'address'),
          ],
          Registration: [domainField('agentEvm', 'address'), domainField('appId', 'bytes32')],
        },
        primaryType: 'Registration',
        domain: { name: 'OCC', version: '2', chainId: 84532, verifyingContract: AGENT },
        message: { agentEvm: AGENT, appId: '0x' + '11'.repeat(32) },
      },
    ],
    [
      'any other typed data (a permit-like Mail)',
      {
        types: {
          EIP712Domain: [domainField('name', 'string')],
          Mail: [domainField('text', 'string')],
        },
        primaryType: 'Mail',
        domain: { name: 'AgentLink test' },
        message: { text: 'hello' },
      },
    ],
    ['the card domain with another primary type', { ...good, primaryType: 'EIP712Domain' }],
    [
      'an extra struct in types',
      { ...good, types: { ...AGENT_CARD_TYPES, Extra: [domainField('x', 'uint8')] } },
    ],
    [
      'an AgentCard type with a renamed field',
      {
        ...good,
        types: {
          ...AGENT_CARD_TYPES,
          AgentCard: (AGENT_CARD_TYPES.AgentCard ?? []).map((f) =>
            f.name === 'expiresAt' ? { ...f, name: 'validUntil' } : f,
          ),
        },
      },
    ],
    [
      'an AgentCard type with its fields reordered',
      {
        ...good,
        types: { ...AGENT_CARD_TYPES, AgentCard: [...(AGENT_CARD_TYPES.AgentCard ?? [])].reverse() },
      },
    ],
    ['a card with an extra field', { ...good, message: { ...card, memo: 'x' } }],
    [
      'a card with a field missing',
      { ...good, message: Object.fromEntries(Object.entries(card).filter(([k]) => k !== 'keyEpoch')) },
    ],
    ['a card in checksummed hex', { ...good, message: { ...card, agentEvm: '0x' + 'AB'.repeat(20) } }],
    ['a card with version 2', { ...good, message: { ...card, version: 2 } }],
    ['no message', { types: good['types'], primaryType: 'AgentCard', domain: AGENT_CARD_DOMAIN }],
    ['an extra top-level key', { ...good, note: 'x' }],
    ['typed data that is not an object', 'AgentCard'],
    ['typed data that is null', null],
  ];
}

function refusedOwnerActions(owner: OwnerPublicKeys): [string, unknown][] {
  const decide = { approvalId: 'apr_test', actionDigest: '00'.repeat(32), decision: 'approve' };
  const base = ownerAction(owner, 'approval.decide', decide);
  return [
    ['an unknown op', ownerAction(owner, 'agent.unrevoke', {})],
    ['a later op that no task defines yet', ownerAction(owner, 'storage.add', {})],
    ['a key export op', ownerAction(owner, 'keys.export', {})],
    ['an op that differs only in case', ownerAction(owner, 'Approval.decide', decide)],
    ['no op', Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'op'))],
    ['an op that is not a string', { ...base, op: ['approval.decide'] }],
  ];
}

async function refusal(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof NodeKeyStoreError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('EIP-712 and owner-action allowlist (M1-8h; 04 §2.4, §2.5.1)', () => {
  it('the fixed text is exactly the one owners see', () => {
    expect(OWNER_OPERATION_REFUSED).toBe(REFUSED);
  });

  it('performOwnerOperation refuses every typed data but the agent card, before any prompt', async () => {
    const owner = (await ready()).owner;
    for (const [why, typedData] of refusedTypedData(owner)) {
      const item = { kind: 'typed-data', typedData, summary: 'Sign' } as never;
      // No TTY and possibly an AI-app marker here: the allowlist answers first, with fixed text.
      expect(await refusal(() => performOwnerOperation(owner, item)), why).toEqual({
        code: 'owner_operation_refused',
        message: REFUSED,
      });
    }
  });

  it('performOwnerOperation refuses an owner action whose op 04 §2.5.1 does not define', async () => {
    const owner = (await ready()).owner;
    for (const [why, action] of refusedOwnerActions(owner)) {
      const item = { kind: 'owner-action', action, summary: 'Sign' } as never;
      expect(await refusal(() => performOwnerOperation(owner, item)), why).toEqual({
        code: 'owner_operation_refused',
        message: REFUSED,
      });
    }
  });

  it('one owner operation refuses them too: no line shown, no code asked, nothing signed', async () => {
    const { owner, code, store } = await ready();
    const cases = [...refusedTypedData(owner), ...refusedOwnerActions(owner)];
    for (const [why, value] of cases) {
      const run = scripted([code]);
      const request = (
        typeof value === 'object' && value !== null && 'v' in value
          ? { kind: 'owner-action', action: value }
          : { kind: 'typed-data', typedData: value }
      ) as OwnerSignRequest;
      expect(
        await refusal(() => runOwnerOperation(store, run.terminal, { lines: ['Sign'] }, request)),
        why,
      ).toEqual({ code: 'owner_operation_refused', message: REFUSED });
      expect(run.written, why).toEqual([]);
      expect(run.labels, why).toEqual([]);
    }
    await store.close();
  });

  it('a gesture with one allowed and one refused object signs neither', async () => {
    const { owner, code, store } = await ready();
    const run = scripted([code]);
    const decide = ownerAction(owner, 'approval.decide', {
      approvalId: 'apr_test',
      actionDigest: '00'.repeat(32),
      decision: 'approve',
    });
    const other = ownerAction(owner, 'storage.add', {});
    expect(
      await refusal(() =>
        runOwnerGesture(store, run.terminal, { lines: ['Approve'] }, [
          { kind: 'owner-action', action: decide },
          { kind: 'owner-action', action: { ...other, op: 'policy.sett' } },
        ]),
      ),
    ).toEqual({ code: 'owner_operation_refused', message: REFUSED });
    expect(run.labels).toEqual([]);
    await store.close();
  });

  it('signs the agent card (owner EVM key, the card verifies)', async () => {
    const { owner, code, store } = await ready();
    const card = cardFor(owner);
    const run = scripted([code]);
    const out = await runOwnerOperation(
      store,
      run.terminal,
      { lines: ['Sign your agent card'] },
      { kind: 'typed-data', typedData: cardTyped(card) },
    );
    if (out.kind !== 'typed-data') throw new Error('expected typed data');
    expect(verifyCardOwnerSig(card, out.signature)).toBe(true);
    const recovered = recoverEvmAddress(
      hashTypedData(cardTyped(card)).digest,
      decodeHex(out.signature.slice(2)),
    );
    expect(equalBytes(recovered, owner.ownerEvm)).toBe(true);
    await store.close();
  });

  it('signs each owner-action op of 04 §2.5.1', async () => {
    const { owner, code, store } = await ready();
    const ops: [string, JsonObject][] = [
      ['approval.decide', { approvalId: 'apr_test', actionDigest: '00'.repeat(32), decision: 'deny' }],
      ['approval.decideBatch', { items: [] }],
      ['approval.cancel', { approvalId: 'apr_test' }],
      ['policy.set', { version: 1, policy: {} }],
      ['agent.revoke', { reason: 'retired' }],
      ['contact.check', { contact: AGENT, pairingDigest: '00'.repeat(32) }],
    ];
    for (const [op, params] of ops) {
      const run = scripted([code]);
      const out = await runOwnerOperation(
        store,
        run.terminal,
        { lines: ['Sign'] },
        { kind: 'owner-action', action: ownerAction(owner, op, params) },
      );
      expect(out.kind, op).toBe('owner-action');
    }
    await store.close();
  });
});
