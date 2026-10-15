// Suite `owner-action` (M1-7d; 04 §2.5.1, §2.5.2, D-68, G-28): the core's SignedOwnerAction
// verification. `sign` computes the JCS text, the body hash and the tagged signature input through
// @agentlink/core, and signs that input with BIP-340 and the case's aux randomness. `verify` and
// `verifyJson` run the core's pure verifier against the receiving core described by `context`: its
// agent address, the card's ownerNostr and the clock, an empty nonce table, the applied policy
// version (absent = 0) and the pending request(s) an approval names. `outcome` is whether the core
// accepts the object. The `contact.check` verify cases, whose `context.pairings` needs the pairing
// recomputation, are pending for M1-7c-b (pending-suites.json `cases`); the core refuses that op.
import { bip340Sign } from '@agentlink/crypto/keystore';
import {
  ownerActionSigningParts,
  verifyOwnerAction,
  verifyOwnerActionText,
  type ApprovalRequestView,
  type OwnerActionCheckContext,
} from '@agentlink/core';
import { bytesToHex, hexToBytes } from '../hex';
import type { SuiteModule } from '../suite';

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

export const ownerAction: SuiteModule = {
  evaluate(testCase) {
    const input = parseInput(testCase.input);
    if (input.op === 'sign') {
      const parts = ownerActionSigningParts(input.body);
      const sig = bip340Sign(
        hexToBytes(input.secretKey),
        parts.signatureInput,
        hexToBytes(input.auxRand),
      );
      return Promise.resolve([
        { field: 'jcs', actual: parts.jcs },
        { field: 'bodyHash', actual: bytesToHex(parts.bodyHash) },
        { field: 'signatureInput', actual: bytesToHex(parts.signatureInput) },
        { field: 'sig', actual: bytesToHex(sig) },
      ]);
    }
    const context = checkContext(input.context);
    const verdict =
      input.op === 'verify'
        ? verifyOwnerAction(input.signed, context)
        : verifyOwnerActionText(input.json, context);
    return Promise.resolve([{ field: 'outcome', actual: verdict.ok ? 'accept' : 'reject' }]);
  },
};
