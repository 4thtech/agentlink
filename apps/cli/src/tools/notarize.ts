// `agentlink_notarize` (06 §2.4, §2.0, §1 rule 3; 07 §6.3; D-40, D-55; M1-9d-2).
//
// Core `notarize` (M1-7g) does the work: the record kind from the payload, `USE_TERMS_TOOLS` for an
// `offer`, `accept` or `reject` before anything is selected or signed, automatic chain selection
// (nothing funded → `needs_credits` with the top-up route), policy `proofs.*` and the daily budget
// (`pending_approval`), then the Record. This handler maps its result to a ProofStatus result.
//
// `chain?` is the Advanced override only (06 §2.4): a shipped chain's key, mapped to its ID here;
// an unknown key is refused before the core is called. No default input asks for a chain (D-40).
// `clientRequestId` is accepted for the 06 §1 rule 6 shape; the core never signs a second Record for
// one envelope (04 §5), so a repeat returns the same proof.
// `requestReceipt` (M1-33d, D-109): asks the recipient for a delivery receipt through the `proof`
// envelope. The summary then always says what a receipt makes public (11 §5.6), not only the first
// time in a session; it is said only when the core reports the request was kept.
import type { NotarizeInput } from '@4thtech-io/core';
import type { ToolContext } from './context.js';
import {
  invalidArgument,
  isOutput,
  needsIdentity,
  notAvailable,
  notarizeOutput,
  proofRefusal,
  proofThrown,
} from './proofs-common.js';
import type { HandlerOutput } from './result.js';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function notarizeHandler(
  input: unknown,
  context: ToolContext,
): Promise<HandlerOutput> {
  if (!isPlainObject(input)) return invalidArgument();
  const { envelopeId, chain, approvalId, requestReceipt } = input;
  if (typeof envelopeId !== 'string') return invalidArgument();
  const self = await needsIdentity(context);
  if (isOutput(self)) return self;
  const proofs = context.client.proofs;
  if (proofs === undefined) return notAvailable();

  let chainId: number | undefined;
  if (typeof chain === 'string') {
    chainId = proofs.chainIdOf(chain);
    if (chainId === undefined) return proofRefusal('UNSUPPORTED_CHAIN');
  }
  const request: NotarizeInput = {
    envelopeId,
    ...(chainId === undefined ? {} : { chainId }),
    ...(typeof approvalId === 'string' ? { approvalId } : {}),
    ...(requestReceipt === true ? { requestReceipt: true } : {}),
  };
  let result;
  try {
    result = await proofs.notarize(request);
  } catch (error) {
    context.logger.info('notarize failed', { tool: 'agentlink_notarize' });
    return proofThrown(error);
  }
  context.logger.info('notarize', { status: result.status });
  return notarizeOutput(result, context, self.agentId);
}
