// M1-7c-b: `contact.check` verify and store (04 §2.5.1, §3.6.1; 07 §3, §3.4; G-28). A signed
// `contact.check` is applied only when its owner signature, agent binding, freshness and lifetime
// hold and its `pairingDigest` equals the digest recomputed from the stored signed `handshake` and
// `handshake-ack`; the nonce, the nonce record and the `contacts.safety_check` write are one store
// transaction. `safetyCodeChecked` is derived from the stored object on every read, never from the
// `safety_code_checked` column.
import {
  canonicalize,
  encodeBase64url,
  encodeHex,
  encodeHex0x,
  randomBytes,
  type JsonObject,
  type JsonValue,
} from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { CLOCK_SKEW_SECONDS, OWNER_ACTION_MAX_LIFETIME_SECONDS } from '@agentlink/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { storedContactCheckHolds } from './contact-check.js';
import { FakeClock, passphrase, seed } from './testing/fixtures.js';
import { makeAgent, pairWith, type TestAgent, type TestOwner } from './testing/envelopes.js';

const LIFETIME = OWNER_ACTION_MAX_LIFETIME_SECONDS['contact.check'];

let clock: FakeClock;
let ownerA: MemoryOwnerKeyStore;
let ownerB: MemoryOwnerKeyStore;
let a: TestAgent;
let b: TestAgent;

const asOwner = (o: MemoryOwnerKeyStore): TestOwner => o as unknown as TestOwner;

beforeEach(async () => {
  clock = new FakeClock();
  ownerA = new MemoryOwnerKeyStore(seed(211), passphrase());
  ownerB = new MemoryOwnerKeyStore(seed(212), passphrase());
  a = await makeAgent(clock, new MemoryKeyStore(seed(111)), asOwner(ownerA), 'Alpha');
  b = await makeAgent(clock, new MemoryKeyStore(seed(112)), asOwner(ownerB), 'Bravo');
  await pairWith(clock, a, b);
});

/** The digest the owner surface recomputes and compares (04 §3.6.1). */
async function digestOf(agent: TestAgent, contactId: string): Promise<string> {
  const code = await agent.client.pairing.ownerSafetyCode(contactId);
  if (code.status !== 'ok') throw new Error('test: no safety code');
  return code.pairingDigest;
}

interface CheckOptions {
  readonly owner?: MemoryOwnerKeyStore;
  readonly agent?: string;
  readonly contact?: string;
  readonly pairingDigest?: string;
  readonly nonce?: string;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
}

/** A `contact.check` signed by `owner` (default A's owner) through its OwnerSession. */
async function signCheck(options: CheckOptions = {}): Promise<{ body: JsonObject; sig: string }> {
  const owner = options.owner ?? ownerA;
  const issuedAt = options.issuedAt ?? clock.t;
  const body: JsonObject = {
    v: 1,
    agent: options.agent ?? a.id,
    owner: encodeHex((await owner.getPublicKeys()).ownerNostr),
    op: 'contact.check',
    params: {
      contact: options.contact ?? b.id,
      pairingDigest: options.pairingDigest ?? (await digestOf(a, b.id)),
    },
    nonce: options.nonce ?? encodeBase64url(randomBytes(16)),
    issuedAt,
    expiresAt: options.expiresAt ?? issuedAt + 600,
  };
  const session = await owner.unlock(passphrase());
  try {
    return { body, sig: await session.signOwnerAction(body) };
  } finally {
    await session.close();
  }
}

const contactRow = (agent: TestAgent, id: string) =>
  agent.store.transaction((tx) => tx.get('contacts', { contact_id: id }));
const nonceCount = (agent: TestAgent) =>
  agent.store.transaction((tx) => tx.count('owner_action_nonces'));
const checked = async (agent: TestAgent, id: string) =>
  (await agent.client.contacts.get(id)).safetyCodeChecked;

async function expectNothingStored(): Promise<void> {
  const row = await contactRow(a, b.id);
  expect(row?.safety_check).toBeNull();
  expect(row?.safety_code_checked).toBe(0);
  expect(await nonceCount(a)).toBe(0);
  expect(await checked(a, b.id)).toBe(false);
}

const flipHex = (hex: string, at = 0): string =>
  hex.slice(0, at) + (hex[at] === '0' ? '1' : '0') + hex.slice(at + 1);

describe('contact.check verify and store (M1-7c-b)', () => {
  it('is false before any check, and true once a matching check is applied', async () => {
    expect(await checked(a, b.id)).toBe(false);
    const signed = await signCheck();
    const outcome = await a.client.contacts.applyContactCheck(signed);
    expect(outcome.status).toBe('applied');
    if (outcome.status !== 'applied') return;
    expect(outcome.contact.id).toBe(b.id);
    expect(outcome.contact.safetyCodeChecked).toBe(true);
    expect(outcome.contact.display.label).toBe('safety-code-checked');

    const view = await a.client.contacts.get(b.id);
    expect(view.safetyCodeChecked).toBe(true);
    expect((await a.client.contacts.list()).find((c) => c.id === b.id)?.safetyCodeChecked).toBe(
      true,
    );
    // The exact signed object is what is stored (07 §3.4), and its nonce is recorded.
    const row = await contactRow(a, b.id);
    expect(row?.safety_check).toBe(canonicalize(signed as unknown as JsonValue));
    const nonces = await a.store.transaction((tx) => tx.select('owner_action_nonces'));
    expect(nonces).toHaveLength(1);
    expect(nonces[0]?.nonce).toBe(signed.body.nonce);
    expect(nonces[0]?.op).toBe('contact.check');
    expect(nonces[0]?.issued_at).toBe(signed.body.issuedAt);
    expect(nonces[0]?.expires_at).toBe(signed.body.expiresAt);
    expect(nonces[0]?.applied_at).toBe(clock.t);
    expect(nonces[0]?.action_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a digest that is not the recomputed one, and stores nothing', async () => {
    const digest = await digestOf(a, b.id);
    const outcome = await a.client.contacts.applyContactCheck(
      await signCheck({ pairingDigest: flipHex(digest, 63) }),
    );
    expect(outcome).toStrictEqual({ status: 'refused', reason: 'digest_mismatch' });
    await expectNothingStored();
  });

  it('refuses a bad owner signature, and stores nothing', async () => {
    const signed = await signCheck();
    const flipped = { body: signed.body, sig: flipHex(signed.sig, 10) };
    expect(await a.client.contacts.applyContactCheck(flipped)).toStrictEqual({
      status: 'refused',
      reason: 'signature_invalid',
    });
    // A valid signature by the owner, over another body.
    const other = await signCheck();
    expect(
      await a.client.contacts.applyContactCheck({ body: signed.body, sig: other.sig }),
    ).toStrictEqual({ status: 'refused', reason: 'signature_invalid' });
    await expectNothingStored();
  });

  it('refuses a check signed by another owner key (not the one in the agent card)', async () => {
    const outcome = await a.client.contacts.applyContactCheck(await signCheck({ owner: ownerB }));
    expect(outcome).toStrictEqual({ status: 'refused', reason: 'owner_mismatch' });
    await expectNothingStored();
  });

  it('refuses a check bound to another agent', async () => {
    const outcome = await a.client.contacts.applyContactCheck(await signCheck({ agent: b.id }));
    expect(outcome).toStrictEqual({ status: 'refused', reason: 'agent_mismatch' });
    await expectNothingStored();
  });

  it('refuses a reused nonce, and the stored object stays the first one', async () => {
    const first = await signCheck();
    expect((await a.client.contacts.applyContactCheck(first)).status).toBe('applied');
    // The same object again (a replay) and another object with the same nonce.
    expect(await a.client.contacts.applyContactCheck(first)).toStrictEqual({
      status: 'refused',
      reason: 'nonce_used',
    });
    clock.t += 5;
    const second = await signCheck({ nonce: first.body.nonce as string });
    expect(await a.client.contacts.applyContactCheck(second)).toStrictEqual({
      status: 'refused',
      reason: 'nonce_used',
    });
    expect((await contactRow(a, b.id))?.safety_check).toBe(
      canonicalize(first as unknown as JsonValue),
    );
    expect(await nonceCount(a)).toBe(1);
    expect(await checked(a, b.id)).toBe(true);
  });

  it('applies a second check with a fresh nonce (idempotent label)', async () => {
    expect((await a.client.contacts.applyContactCheck(await signCheck())).status).toBe('applied');
    clock.t += 5;
    const again = await signCheck();
    expect((await a.client.contacts.applyContactCheck(again)).status).toBe('applied');
    expect((await contactRow(a, b.id))?.safety_check).toBe(
      canonicalize(again as unknown as JsonValue),
    );
    expect(await nonceCount(a)).toBe(2);
    expect(await checked(a, b.id)).toBe(true);
  });

  it('refuses an unknown contact and an upper-case contact, never normalising it', async () => {
    const unknown = encodeHex0x(randomBytes(20));
    expect(
      await a.client.contacts.applyContactCheck(await signCheck({ contact: unknown })),
    ).toStrictEqual({ status: 'refused', reason: 'contact_unknown' });
    const upper = `0x${b.id.slice(2).toUpperCase()}`;
    expect(
      await a.client.contacts.applyContactCheck(await signCheck({ contact: upper })),
    ).toStrictEqual({ status: 'refused', reason: 'malformed' });
    await expectNothingStored();
  });

  it('refuses a removed contact', async () => {
    const signed = await signCheck();
    await a.client.contacts.remove(b.id);
    expect(await a.client.contacts.applyContactCheck(signed)).toStrictEqual({
      status: 'refused',
      reason: 'contact_unknown',
    });
    expect(await nonceCount(a)).toBe(0);
  });

  it('refuses input that is not a contact.check SignedOwnerAction', async () => {
    const signed = await signCheck();
    for (const bad of [
      null,
      'text',
      [],
      { body: signed.body },
      { ...signed, extra: 1 },
      { body: { ...signed.body, op: 'policy.set' }, sig: signed.sig },
      { body: { ...signed.body, params: { contact: b.id } }, sig: signed.sig },
    ]) {
      expect(await a.client.contacts.applyContactCheck(bad)).toStrictEqual({
        status: 'refused',
        reason: 'malformed',
      });
    }
    await expectNothingStored();
  });

  describe('G-7 boundaries (04 §2.5.1)', () => {
    it('accepts at now = expiresAt and refuses at expiresAt + 1', async () => {
      const atExpiry = await signCheck({ issuedAt: clock.t - 600, expiresAt: clock.t });
      expect((await a.client.contacts.applyContactCheck(atExpiry)).status).toBe('applied');
      const expired = await signCheck({ issuedAt: clock.t - 601, expiresAt: clock.t - 1 });
      expect(await a.client.contacts.applyContactCheck(expired)).toStrictEqual({
        status: 'refused',
        reason: 'expired',
      });
    });

    it('accepts a lifetime of exactly 24 h and refuses 24 h + 1 s', async () => {
      const max = await signCheck({ issuedAt: clock.t, expiresAt: clock.t + LIFETIME });
      expect((await a.client.contacts.applyContactCheck(max)).status).toBe('applied');
      const over = await signCheck({ issuedAt: clock.t, expiresAt: clock.t + LIFETIME + 1 });
      expect(await a.client.contacts.applyContactCheck(over)).toStrictEqual({
        status: 'refused',
        reason: 'lifetime_exceeded',
      });
    });

    it('accepts issuedAt = now + S and refuses now + S + 1', async () => {
      const skew = await signCheck({ issuedAt: clock.t + CLOCK_SKEW_SECONDS });
      expect((await a.client.contacts.applyContactCheck(skew)).status).toBe('applied');
      const future = await signCheck({ issuedAt: clock.t + CLOCK_SKEW_SECONDS + 1 });
      expect(await a.client.contacts.applyContactCheck(future)).toStrictEqual({
        status: 'refused',
        reason: 'issued_in_future',
      });
    });
  });

  describe('derived on every read, never from a flag', () => {
    beforeEach(async () => {
      expect((await a.client.contacts.applyContactCheck(await signCheck())).status).toBe('applied');
      expect(await checked(a, b.id)).toBe(true);
    });

    const editRow = (patch: Record<string, unknown>) =>
      a.store.transaction((tx) => tx.update('contacts', { contact_id: b.id }, patch));

    it('editing the stored object makes it false', async () => {
      const row = await contactRow(a, b.id);
      const stored = JSON.parse(row!.safety_check!) as { body: JsonObject; sig: string };
      const edits: unknown[] = [
        { ...stored, sig: flipHex(stored.sig, 0) },
        { ...stored, body: { ...stored.body, nonce: encodeBase64url(randomBytes(16)) } },
        {
          ...stored,
          body: {
            ...stored.body,
            params: { contact: b.id, pairingDigest: encodeHex(randomBytes(32)) },
          },
        },
        { ...stored, extra: true },
        'not json',
      ];
      for (const edit of edits) {
        await editRow({
          safety_check: typeof edit === 'string' ? edit : JSON.stringify(edit),
        });
        expect(await checked(a, b.id)).toBe(false);
      }
    });

    it('a valid object for another contact does not count', async () => {
      // A second contact C, checked properly; its object copied onto B's row.
      const ownerC = new MemoryOwnerKeyStore(seed(213), passphrase());
      const c = await makeAgent(clock, new MemoryKeyStore(seed(113)), asOwner(ownerC), 'Charlie');
      await pairWith(clock, a, c);
      const forC = await signCheck({ contact: c.id, pairingDigest: await digestOf(a, c.id) });
      expect((await a.client.contacts.applyContactCheck(forC)).status).toBe('applied');
      await editRow({ safety_check: canonicalize(forC as unknown as JsonValue) });
      expect(await checked(a, b.id)).toBe(false);
      expect(await checked(a, c.id)).toBe(true);
    });

    it('the safety_code_checked column alone never makes it true', async () => {
      await editRow({ safety_check: null, safety_code_checked: 1 });
      expect(await checked(a, b.id)).toBe(false);
    });

    it('a tampered stored ack makes it false, and a new check is refused', async () => {
      const row = await contactRow(a, b.id);
      await a.store.transaction((tx) => {
        const ack = tx.get('envelopes', { envelope_id: row!.handshake_ack_envelope_id! });
        const envelope = JSON.parse(ack!.envelope_json!) as { sig: string };
        envelope.sig = flipHex(envelope.sig, 5);
        tx.update(
          'envelopes',
          { envelope_id: ack!.envelope_id },
          { envelope_json: JSON.stringify(envelope) },
        );
      });
      expect(await checked(a, b.id)).toBe(false);
      clock.t += 5;
      const signed = await signCheck({ pairingDigest: encodeHex(randomBytes(32)) });
      expect(await a.client.contacts.applyContactCheck(signed)).toStrictEqual({
        status: 'refused',
        reason: 'pairing_unavailable',
      });
    });

    it('a completed re-pair clears it, and the old digest no longer applies', async () => {
      const oldDigest = await digestOf(a, b.id);
      clock.t += 60;
      await pairWith(clock, a, b);
      expect(await digestOf(a, b.id)).not.toBe(oldDigest);
      expect(await checked(a, b.id)).toBe(false);
      expect((await contactRow(a, b.id))?.safety_check).toBeNull();
      expect(
        await a.client.contacts.applyContactCheck(await signCheck({ pairingDigest: oldDigest })),
      ).toStrictEqual({ status: 'refused', reason: 'digest_mismatch' });
      expect((await a.client.contacts.applyContactCheck(await signCheck())).status).toBe('applied');
      expect(await checked(a, b.id)).toBe(true);
    });

    it('a validly signed check from before a re-pair, written back, does not count (IR-M1-7c-b-1 F01)', async () => {
      const old = (await contactRow(a, b.id))!.safety_check!;
      clock.t += 60;
      await pairWith(clock, a, b);
      // The old object is still exactly what the owner signed (agent, owner, sig, contact all
      // valid); only its pairingDigest names the previous pairing.
      await editRow({ safety_check: old, safety_code_checked: 1 });
      const view = await a.client.contacts.get(b.id);
      expect(view.safetyCodeChecked).toBe(false);
      expect(view.display.label).toBe('self-declared');
    });

    it('a replay after a re-pair is refused by its nonce first (04 §2.5.1 order, IR-M1-7c-b-1 F02)', async () => {
      const applied = JSON.parse((await contactRow(a, b.id))!.safety_check!) as unknown;
      clock.t += 60;
      await pairWith(clock, a, b);
      expect(await a.client.contacts.applyContactCheck(applied)).toStrictEqual({
        status: 'refused',
        reason: 'nonce_used',
      });
      await a.client.contacts.remove(b.id);
      expect(await a.client.contacts.applyContactCheck(applied)).toStrictEqual({
        status: 'refused',
        reason: 'nonce_used',
      });
    });
  });

  describe('storedContactCheckHolds (pure, IR-M1-7c-b-1 F01)', () => {
    it('holds only for this agent, owner, contact and the recomputed digest', async () => {
      const signed = await signCheck();
      const own = (await a.client.identity.get())!.card;
      const expected = {
        agent: a.id,
        ownerNostr: own.ownerNostr,
        contact: b.id,
        pairingDigest: await digestOf(a, b.id),
      };
      expect(storedContactCheckHolds(signed, expected)).toBe(true);
      // Every field valid, only the recomputed digest differs: false.
      expect(
        storedContactCheckHolds(signed, {
          ...expected,
          pairingDigest: flipHex(expected.pairingDigest, 63),
        }),
      ).toBe(false);
      expect(
        storedContactCheckHolds(signed, { ...expected, pairingDigest: encodeHex(randomBytes(32)) }),
      ).toBe(false);
      expect(storedContactCheckHolds(signed, { ...expected, contact: a.id })).toBe(false);
      expect(storedContactCheckHolds(signed, { ...expected, agent: b.id })).toBe(false);
      const otherOwner = encodeHex0x((await ownerB.getPublicKeys()).ownerNostr);
      expect(storedContactCheckHolds(signed, { ...expected, ownerNostr: otherOwner })).toBe(false);
    });
  });

  it('puts no digest, code, nonce or signature in a refusal (I-5)', async () => {
    const signed = await signCheck({ pairingDigest: encodeHex(randomBytes(32)) });
    const outcome = await a.client.contacts.applyContactCheck(signed);
    const text = JSON.stringify(outcome);
    const code = await a.client.pairing.ownerSafetyCode(b.id);
    if (code.status !== 'ok') throw new Error('test: no code');
    for (const secretish of [
      code.code,
      code.code.replace(/ /g, ''),
      code.pairingDigest,
      (signed.body.params as JsonObject).pairingDigest as string,
      signed.body.nonce as string,
      signed.sig,
    ]) {
      expect(text).not.toContain(secretish);
    }
  });
});
