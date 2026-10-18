// Suite `owner-action` (M1-7d; 04 §2.5.1, §2.5.2, D-68, G-28): the core's SignedOwnerAction
// verification. `sign` computes the JCS text, the body hash and the tagged signature input through
// @4thtech-io/core, and signs that input with BIP-340 and the case's aux randomness. `verify` and
// `verifyJson` run the core's pure verifier against the receiving core described by `context`: its
// agent address, the card's ownerNostr and the clock, an empty nonce table, the applied policy
// version (absent = 0) and the pending request(s) an approval names. `outcome` is whether the core
// accepts the object. A `verify` case whose signed body is a `contact.check` (selected by its op,
// not by its id) runs through the core's contact.check verifier, the path OwnerActions.apply routes
// that op to (M1-7c-b, M1-7d): the object checks, the nonce, then `pairingDigest` against the digest
// recomputed from the stored signed `handshake` and `handshake-ack` in `context.pairings` (the core's
// recomputeSafetyCode, 04 §3.6.1 steps 1-5, each message opened with the CEK the vector gives), never
// a stored digest.
import { bip340Sign } from '@4thtech-io/crypto/keystore';
import {
  ownerActionSigningParts,
  verifyContactCheck,
  verifyOwnerAction,
  verifyOwnerActionText,
  type ApprovalRequestView,
  type OwnerActionCheckContext,
  type PairingDigestLookup,
} from '@4thtech-io/core';
import { recomputeSafetyCode } from '@4thtech-io/core/safety-code';
import { bytesToHex, hexToBytes } from '../hex';
import type { SuiteModule } from '../suite';

interface StoredMessage {
  readonly envelope: unknown;
  readonly cek: string;
}

/** A completed pairing as the receiving core stores it (04 §3.6.1). */
interface StoredPairing {
  readonly contact: string;
  readonly contactCard: unknown;
  readonly handshake: StoredMessage;
  readonly ack: StoredMessage;
}

interface Pending {
  readonly approvalId: string;
  readonly actionDigest: string;
  readonly expiresAt: number;
}

interface VectorContext {
  readonly agent: string;
  readonly ownerNostr: string;
  readonly now: number;
  readonly pendingApproval?: Pending;
  readonly pendingApprovals?: readonly Pending[];
  readonly appliedPolicyVersion?: number;
  readonly pairings?: readonly StoredPairing[];
}

type OwnerActionInput =
  | { op: 'sign'; body: Record<string, unknown>; secretKey: string; auxRand: string }
  | { op: 'verify'; signed: unknown; context: VectorContext }
  | { op: 'verifyJson'; json: string; context: VectorContext };

function parseInput(input: unknown): OwnerActionInput {
  const i = input as Record<string, unknown> | null;
  const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (
    i?.op === 'sign' &&
    isObject(i.body) &&
    typeof i.secretKey === 'string' &&
    typeof i.auxRand === 'string'
  ) {
    return i as OwnerActionInput;
  }
  if (i?.op === 'verify' && Object.hasOwn(i, 'signed') && isObject(i.context)) {
    return i as OwnerActionInput;
  }
  if (i?.op === 'verifyJson' && typeof i.json === 'string' && isObject(i.context)) {
    return i as OwnerActionInput;
  }
  throw new TypeError('owner-action: input does not match any op of case.schema.json');
}

/** The receiving core's view, as the case states it. Vector requests are never commitments. */
function checkContext(c: VectorContext): OwnerActionCheckContext {
  const requests = new Map<string, ApprovalRequestView>();
  for (const p of [
    ...(c.pendingApprovals ?? []),
    ...(c.pendingApproval ? [c.pendingApproval] : []),
  ]) {
    requests.set(p.approvalId, { ...p, commitment: false, pending: true });
  }
  return {
    agent: c.agent,
    ownerNostr: c.ownerNostr,
    now: c.now,
    nonceUsed: () => false,
    appliedPolicyVersion: c.appliedPolicyVersion ?? 0,
    approvalRequest: (approvalId) => requests.get(approvalId),
  };
}

const isUnavailable = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { readonly code?: unknown }).code === 'safety_code_unavailable';

/** The receiving core's recomputation for a contact, from the stored pair the context names. */
function pairingLookup(c: VectorContext) {
  return async (contact: string): Promise<PairingDigestLookup> => {
    const stored = (c.pairings ?? []).filter((p) => p.contact === contact);
    if (stored.length === 0) return { status: 'unknown' };
    if (stored.length > 1) throw new TypeError('owner-action: more than one pairing per contact');
    const p = stored[0]!;
    try {
      const { pairingDigest } = await recomputeSafetyCode({
        self: c.agent,
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

const opOf = (signed: unknown): unknown => (signed as { body?: { op?: unknown } } | null)?.body?.op;

export const ownerAction: SuiteModule = {
  async evaluate(testCase) {
    const input = parseInput(testCase.input);
    if (input.op === 'sign') {
      const parts = ownerActionSigningParts(input.body);
      const sig = bip340Sign(
        hexToBytes(input.secretKey),
        parts.signatureInput,
        hexToBytes(input.auxRand),
      );
      return [
        { field: 'jcs', actual: parts.jcs },
        { field: 'bodyHash', actual: bytesToHex(parts.bodyHash) },
        { field: 'signatureInput', actual: bytesToHex(parts.signatureInput) },
        { field: 'sig', actual: bytesToHex(sig) },
      ];
    }
    if (input.op === 'verify' && opOf(input.signed) === 'contact.check') {
      const c = input.context;
      const verdict = await verifyContactCheck(
        input.signed,
        { agent: c.agent, ownerNostr: c.ownerNostr, now: c.now, nonceUsed: () => false },
        pairingLookup(c),
      );
      return [{ field: 'outcome', actual: verdict.ok ? 'accept' : 'reject' }];
    }
    const context = checkContext(input.context);
    const verdict =
      input.op === 'verify'
        ? verifyOwnerAction(input.signed, context)
        : verifyOwnerActionText(input.json, context);
    return [{ field: 'outcome', actual: verdict.ok ? 'accept' : 'reject' }];
  },
};
