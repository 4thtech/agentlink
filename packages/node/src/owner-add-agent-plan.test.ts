// W4-ONE-TOUCH (D-140; 04 §2.8 "One challenge binds the whole plan", "The restricted session"): the
// plan, its challenge and the restricted owner session. A real owner session (MemoryOwnerKeyStore)
// signs; nothing here fakes a signature.
import {
  AGENT_CARD_DOMAIN,
  AGENT_CARD_TYPES,
  agentCardNameHash,
  canonicalize,
  encodeHex,
  encodeHex0x,
  encodeUtf8,
  randomBytes,
  type JsonObject,
  type OwnerPublicKeys,
  type OwnerSession,
  type TypedData,
} from '@4thtech-io/crypto';
import { MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CREATE_CONNECT_DOMAIN,
  PlanOwnerSession,
  buildCreateConnectPlan,
  createConnectChallenge,
  type PlanStatement,
} from './owner-add-agent-plan.js';

const AGENT = `0x${'ab'.repeat(20)}`;
const NOW = 1_800_000_000;
const CHANGE = 'cd'.repeat(32);
const AGENT_NOSTR = encodeHex0x(new Uint8Array(32).fill(7));
const AGENT_ENC = encodeHex0x(new Uint8Array(32).fill(8));

let owner: OwnerPublicKeys;
let inner: OwnerSession;

beforeEach(async () => {
  const secret = 'plan test passphrase';
  const store = new MemoryOwnerKeyStore(randomBytes(32), {
    kind: 'passphrase',
    secret: encodeUtf8(secret),
  });
  owner = await store.getPublicKeys();
  inner = await store.unlock({ kind: 'passphrase', secret: encodeUtf8(secret) });
});
afterEach(async () => {
  await inner.close();
});

const plan = (app = true) =>
  buildCreateConnectPlan({
    agentId: AGENT,
    owner,
    label: 'Work',
    folder: 'work',
    sendFolder: '/home/test/AgentLink/Send',
    agentKeys: { agentNostr: AGENT_NOSTR, agentEnc: AGENT_ENC },
    ...(app ? { app: { app: 'claude-code', changeId: CHANGE } } : {}),
    nowSeconds: NOW,
  });

const statement = (label = 'Work'): PlanStatement => ({
  label,
  agentFingerprint: 'AAAA-BBBB',
  ownerFingerprint: 'CCCC-DDDD',
  folder: 'work',
});

describe('the plan', () => {
  it('is the ordered list [card, policy.set, agent.label, app.connect] for exactly this agent and owner', () => {
    const p = plan();
    expect(p.entries.map((e) => e['kind'] ?? e['op'])).toEqual([
      'card',
      'policy.set',
      'agent.label',
      'app.connect',
    ]);
    expect(p.card).toMatchObject({
      agentEvm: AGENT,
      ownerNostr: encodeHex0x(owner.ownerNostr),
      name: 'Work',
    });
    for (const body of [p.policy, p.labelBody, p.connect] as JsonObject[]) {
      expect(body['agent']).toBe(AGENT);
      expect(body['owner']).toBe(encodeHex(owner.ownerNostr));
      expect(body['issuedAt']).toBe(NOW);
      expect(body['expiresAt']).toBe(NOW + 600);
    }
    expect(p.connect?.['params']).toEqual({ app: 'claude-code', agent: AGENT, changeId: CHANGE });
    // Every body has its own fresh nonce.
    const nonces = [p.policy, p.labelBody, p.connect].map((b) => (b as JsonObject)['nonce']);
    expect(new Set(nonces).size).toBe(3);
  });

  it('ends with the label when no app was picked ("Not now")', () => {
    expect(plan(false).entries.map((e) => e['kind'] ?? e['op'])).toEqual([
      'card',
      'policy.set',
      'agent.label',
    ]);
  });

  it('the challenge binds the nonce, the statement and the plan (each change gives another)', () => {
    const p = plan();
    const nonce = randomBytes(32);
    const c = createConnectChallenge(nonce, statement(), p);
    expect(c).toHaveLength(32);
    expect(createConnectChallenge(nonce, statement(), p)).toEqual(c);
    expect(createConnectChallenge(randomBytes(32), statement(), p)).not.toEqual(c);
    expect(createConnectChallenge(nonce, statement('Home'), p)).not.toEqual(c);
    expect(createConnectChallenge(nonce, statement(), plan())).not.toEqual(c);
    expect(CREATE_CONNECT_DOMAIN).toBe('agentlink-create-connect-v1');
  });
});

describe('the restricted session signs exactly the plan, in order, each once', () => {
  it('signs the bodies in plan order (after the card), byte for byte', async () => {
    const p = plan();
    const session = new PlanOwnerSession(inner, p.entries);
    // The card comes first: a body before it is refused.
    await expect(session.signOwnerAction(p.policy as never)).rejects.toThrow();
  });

  it('cannot be split, extended or replayed', async () => {
    const p = plan();
    // Without the card entry the session starts at the policy body.
    const session = new PlanOwnerSession(inner, p.entries.slice(1));
    // Split: the label before the policy is refused.
    await expect(session.signOwnerAction(p.labelBody as never)).rejects.toThrow();
    expect(typeof (await session.signOwnerAction(p.policy as never))).toBe('string');
    // Replay: the same body again is refused.
    await expect(session.signOwnerAction(p.policy as never)).rejects.toThrow();
    // A changed body is refused.
    const changed = JSON.parse(canonicalize(p.labelBody)) as { params: Record<string, unknown> };
    changed.params['label'] = 'Other';
    await expect(session.signOwnerAction(changed as never)).rejects.toThrow();
    expect(typeof (await session.signOwnerAction(p.labelBody as never))).toBe('string');
    expect(typeof (await session.signOwnerAction(p.connect as never))).toBe('string');
    // Extend: nothing after the last body, not even another app.connect.
    const second = plan().connect as JsonObject;
    await expect(session.signOwnerAction(second as never)).rejects.toThrow();
    // Nothing else of an owner session.
    await expect(session.signNostr()).rejects.toThrow();
    await expect(session.signEnvelopeHash()).rejects.toThrow();
  });
});

describe('IR-W4-ONE-TOUCH L-1: the card is signed only as the whole descriptor', () => {
  const cardMessage = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    version: 1,
    agentEvm: AGENT,
    agentNostr: AGENT_NOSTR,
    agentEnc: AGENT_ENC,
    ownerEvm: encodeHex0x(owner.ownerEvm),
    ownerNostr: encodeHex0x(owner.ownerNostr),
    ownerEnc: encodeHex0x(owner.ownerEnc),
    nameHash: encodeHex0x(agentCardNameHash('Work')),
    relaysHash: encodeHex0x(new Uint8Array(32)),
    issuedAt: NOW,
    expiresAt: 0,
    keyEpoch: 0,
    ...over,
  });
  const typed = (message: Record<string, unknown>): TypedData =>
    ({
      types: AGENT_CARD_TYPES,
      primaryType: 'AgentCard',
      domain: AGENT_CARD_DOMAIN,
      message,
    }) as TypedData;

  it('refuses a card with another name, other agent keys or another agent', async () => {
    const p = plan();
    for (const over of [
      { nameHash: encodeHex0x(agentCardNameHash('Other')) },
      { agentNostr: encodeHex0x(new Uint8Array(32).fill(9)) },
      { agentEnc: encodeHex0x(new Uint8Array(32).fill(9)) },
      { agentEvm: `0x${'cd'.repeat(20)}` },
    ]) {
      const session = new PlanOwnerSession(inner, p.entries);
      await expect(session.sign712(typed(cardMessage(over)))).rejects.toThrow();
    }
  });

  it('signs the card that matches the descriptor, then the bodies in order', async () => {
    const p = plan();
    const session = new PlanOwnerSession(inner, p.entries);
    expect(typeof (await session.sign712(typed(cardMessage())))).toBe('string');
    expect(typeof (await session.signOwnerAction(p.policy as never))).toBe('string');
    // A second card is refused.
    await expect(session.sign712(typed(cardMessage()))).rejects.toThrow();
  });
});
