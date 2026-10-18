// Suite `safety-code-recompute` (M1-7c; 04 §3.6.1 steps 1-5, G-28): the core's recomputation of the
// safety code from the signed `handshake` H and `handshake-ack` K, run from source. Each message is
// opened with its CEK from the vector (a surface opens it with its own key), each body passes its
// strict schema, and steps 1-5 run for the surface's own agent ID and the contact's current card.
// A refusal (`safety_code_unavailable`, "Can't show the safety code") is `outcome: reject`; any
// other error is a bug and fails the case.
import { recomputeSafetyCode } from '@4thtech-io/core/safety-code';
import { hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

interface Message {
  readonly envelope: unknown;
  readonly cek: string;
}

interface RecomputeInput {
  readonly self: string;
  readonly contactCard: unknown;
  readonly handshake: Message;
  readonly ack: Message;
}

const isMessage = (v: unknown): v is Message =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Record<string, unknown>).envelope === 'object' &&
  typeof (v as Record<string, unknown>).cek === 'string';

function parseInput(input: unknown): RecomputeInput {
  const i = input as Record<string, unknown> | null;
  if (
    i?.op === 'recompute' &&
    typeof i.self === 'string' &&
    typeof i.contactCard === 'object' &&
    isMessage(i.handshake) &&
    isMessage(i.ack)
  ) {
    return i as unknown as RecomputeInput;
  }
  throw new TypeError('safety-code-recompute: input does not match any op of case.schema.json');
}

const isRefusal = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { readonly code?: unknown }).code === 'safety_code_unavailable';

export const safetyCodeRecompute: SuiteModule = {
  async evaluate(testCase): Promise<readonly Comparison[]> {
    const input = parseInput(testCase.input);
    try {
      const result = await recomputeSafetyCode({
        self: input.self,
        contactCard: input.contactCard,
        handshake: { envelope: input.handshake.envelope, cek: hexToBytes(input.handshake.cek) },
        ack: { envelope: input.ack.envelope, cek: hexToBytes(input.ack.cek) },
      });
      return [
        { field: 'pairingDigest', actual: result.pairingDigest },
        { field: 'code', actual: result.code },
      ];
    } catch (error) {
      if (isRefusal(error)) return [{ field: 'outcome', actual: 'reject' }];
      throw error;
    }
  },
};
