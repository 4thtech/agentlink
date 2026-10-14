// The owner-action `contact.check` verify cases (M1-1h, version 4, IR-M1-2f-1 F02) run through the
// core's verification (M1-7c-b; 04 §2.5.1, §3.6.1, G-28): the strict encoding, `agent`, `owner`
// against the card's ownerNostr, `sig`, freshness and the 24 h lifetime, then `pairingDigest`
// against the digest recomputed from the stored signed `handshake` and `handshake-ack` in
// `context.pairings` (never a stored digest). The recomputation is the core's own
// (recomputeSafetyCode, 04 §3.6.1 steps 1-5), each message opened with the CEK the vector gives.
//
// The `owner-action` suite as a whole stays pending for M1-7d (pending-suites.json), whose module
// will run these cases too; until it lands, this file runs them in all five runtimes, like the
// contact.check schema cross-check (contact-check-form.test.ts). Expected outcomes come only from the
// committed vectors.
import { verifyContactCheck, type PairingDigestLookup } from '@agentlink/core/contact-check';
import { recomputeSafetyCode } from '@agentlink/core/safety-code';
import { describe, expect, test } from 'vitest';
import { hexToBytes } from './hex';
import { vectorFiles, type VectorCase } from './registry';

interface Message {
  readonly envelope: unknown;
  readonly cek: string;
}
interface StoredPairing {
  readonly contact: string;
  readonly contactCard: unknown;
  readonly handshake: Message;
  readonly ack: Message;
}
interface VerifyInput {
  readonly op: 'verify';
  readonly signed: { readonly body: { readonly op: string } };
  readonly context: {
    readonly agent: string;
    readonly ownerNostr: string;
    readonly now: number;
    readonly pairings: readonly StoredPairing[];
  };
}

const ownerAction = vectorFiles.find((f) => f.directory === 'owner-action')?.file;
const cases: readonly VectorCase[] = ownerAction?.cases ?? [];
const input = (c: VectorCase) => c.input as VerifyInput;

/** Every `verify` case whose signed body is a `contact.check`: selected by its op, not by its id. */
const verifyCases = cases.filter(
  (c) => input(c).op === 'verify' && input(c).signed?.body?.op === 'contact.check',
);

/** The nine core cases of version 4: the two accepts and the seven core-only refusals. */
const CORE_CASES = [
  'verify-contact-check',
  'verify-contact-check-at-expiry',
  'verify-contact-check-reject-contact-uppercase',
  'verify-contact-check-reject-digest-mismatch',
  'verify-contact-check-reject-wrong-signer',
  'verify-contact-check-reject-expired',
  'verify-contact-check-reject-lifetime',
  'verify-contact-check-reject-unknown-contact',
  'verify-contact-check-reject-stored-ack-tampered',
];

const isUnavailable = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { readonly code?: unknown }).code === 'safety_code_unavailable';

/** The receiving core's recomputation for a contact, from the stored pair the context names. */
function lookup(context: VerifyInput['context']) {
  return async (contact: string): Promise<PairingDigestLookup> => {
    const stored = context.pairings.filter((p) => p.contact === contact);
    if (stored.length === 0) return { status: 'unknown' };
    expect(stored, 'one stored pairing per contact').toHaveLength(1);
    const p = stored[0]!;
    try {
      const { pairingDigest } = await recomputeSafetyCode({
        self: context.agent,
        contactCard: p.contactCard,
        handshake: { envelope: p.handshake.envelope, cek: hexToBytes(p.handshake.cek) },
        ack: { envelope: p.ack.envelope, cek: hexToBytes(p.ack.cek) },
      });
      return { status: 'ok', pairingDigest };
    } catch (error) {
      if (isUnavailable(error)) return { status: 'unavailable' };
      throw error;
    }
  };
}

describe('owner-action contact.check verify vectors through the core (M1-7c-b, G-28)', () => {
  test('the nine core verify cases are committed', () => {
    const ids = verifyCases.map((c) => c.id);
    for (const id of CORE_CASES) expect(ids, id).toContain(id);
  });

  test.each(verifyCases.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    const { signed, context } = input(c);
    const verdict = await verifyContactCheck(
      signed,
      { agent: context.agent, ownerNostr: context.ownerNostr, now: context.now },
      lookup(context),
    );
    const expected = (c.expected as { outcome: string }).outcome;
    expect(verdict.ok ? 'accept' : 'reject', c.id).toBe(expected);
  });
});
