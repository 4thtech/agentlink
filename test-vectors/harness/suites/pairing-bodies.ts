// Suite `pairing-bodies` (M1-2d, M1-2a G-23/G-28): the strict @agentlink/types schemas of the
// pairing bodies (04 §3.4, §3.4.1, §3.6; G-24 relay lists of 2 to 16). `outcome` is whether the
// schema accepts the body. Signatures, hashes, the proof and the commitment are not checked here
// (M1-7c, safety-code-recompute). Schemas report through `safeParse` and never throw on input.
import {
  cardUpdateBodySchema,
  handshakeAckBodySchema,
  handshakeBodySchema,
  inviteSchema,
  relayListSchema,
} from '@agentlink/types';
import type { SuiteModule } from '../suite';

const SCHEMAS = {
  parseInvite: inviteSchema,
  parseHandshake: handshakeBodySchema,
  parseHandshakeAck: handshakeAckBodySchema,
  parseCardUpdate: cardUpdateBodySchema,
  parseRelayList: relayListSchema,
} as const;

type Op = keyof typeof SCHEMAS;

/** The value under test: `relays` for `parseRelayList`, `body` for every other op. */
function parseInput(input: unknown): { op: Op; body: unknown } {
  const i = input as Record<string, unknown> | null;
  if (
    typeof i === 'object' &&
    i !== null &&
    typeof i.op === 'string' &&
    Object.hasOwn(SCHEMAS, i.op)
  ) {
    const key = i.op === 'parseRelayList' ? 'relays' : 'body';
    if (Object.hasOwn(i, key)) return { op: i.op as Op, body: i[key] };
  }
  throw new TypeError('pairing-bodies: input does not match any op of case.schema.json');
}

export const pairingBodies: SuiteModule = {
  evaluate(testCase) {
    const { op, body } = parseInput(testCase.input);
    const ok = SCHEMAS[op].safeParse(body).success;
    return Promise.resolve([{ field: 'outcome', actual: ok ? 'accept' : 'reject' }]);
  },
};
