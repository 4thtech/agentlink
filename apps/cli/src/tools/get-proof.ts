// `agentlink_get_proof` (06 §2.4, §2.0; M1-9d-2). Read-only: core `getProof` reads the stored record
// and, where the chain answers, its receipts; it signs, sends and charges nothing. The result is a
// ProofStatus by the stored status (recorded → ok, signed or pending → submitted, …).
import type { ToolContext } from './context.js';
import {
  invalidArgument,
  isOutput,
  needsIdentity,
  notAvailable,
  oneTarget,
  proofThrown,
  proofViewOutput,
} from './proofs-common.js';
import { fail, type HandlerOutput } from './result.js';

export const GET_PROOF_TEXT = Object.freeze({
  notFound: 'There is no proof for that message or record.',
  notFoundNextStep:
    'Check the envelopeId or recordId. To add proof to a message this agent sent, use agentlink_notarize.',
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function getProofHandler(
  input: unknown,
  context: ToolContext,
): Promise<HandlerOutput> {
  if (!isPlainObject(input)) return invalidArgument();
  const target = oneTarget(input);
  if (target === undefined) return invalidArgument();
  const self = await needsIdentity(context);
  if (isOutput(self)) return self;
  const proofs = context.client.proofs;
  if (proofs === undefined) return notAvailable();
  let view;
  try {
    view = await proofs.get(target);
  } catch (error) {
    return proofThrown(error);
  }
  if (view === undefined) {
    return fail('not_found', GET_PROOF_TEXT.notFound, GET_PROOF_TEXT.notFoundNextStep);
  }
  return proofViewOutput(view, self.agentId);
}
