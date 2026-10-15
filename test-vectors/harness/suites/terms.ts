// Suite `terms` (M1-21, D-32, D-55, D-74): the strict `terms` schema and canonical form, `TermsInput`
// and its mapping (@agentlink/types), termsHash = sha256(JCS(terms)) (@agentlink/crypto), and the
// pure negotiation-chain reducer. For the chain ops this module replays the case's `log` the way a
// core replays its own store: it drops a duplicate (the same envelope, D-71 (3); here the JCS of the
// abstract envelope stands in for its envelopeHash), checks the body and its termsHash, and passes
// every envelope to the reducer of its negotiation key (`recordSentTerms`, `receiveTerms`). The
// decisions are the reducer's; this module only keeps the per-key states. Nothing here supplies an
// expected value.
import {
  CryptoInputError,
  canonicalize,
  parseJson,
  termsHash,
  verifyTermsHash,
} from '@agentlink/crypto';
import {
  EMPTY_NEGOTIATION,
  acceptBodySchema,
  checkSendAccept,
  negotiationKey,
  newestOpenOffer,
  nextTermsLink,
  offerBodySchema,
  parseTermsInput,
  receiveTerms,
  recordSentTerms,
  rejectBodySchema,
  termsFromInput,
  termsSchema,
  type NegotiationState,
  type Terms,
} from '@agentlink/types';
import type { Comparison, SuiteModule } from '../suite';

type Obj = Record<string, unknown>;
type Dir = 'sent' | 'received';
interface Envelope {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly createdAt: number;
  readonly type: string;
  readonly replyTo: string | null;
  readonly body: unknown;
}

const BODY_SCHEMAS = {
  offer: offerBodySchema,
  accept: acceptBodySchema,
  reject: rejectBodySchema,
} as const;

const fail = (what: string): never => {
  throw new TypeError(`terms: input does not match case.schema.json (${what})`);
};
const obj = (v: unknown, what: string): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : fail(what);
const str = (v: unknown, what: string): string => (typeof v === 'string' ? v : fail(what));
const num = (v: unknown, what: string): number => (typeof v === 'number' ? v : fail(what));

/** A terms body that passes its strict schema and whose termsHash is the recomputed one. */
function parseBody(type: string, body: unknown): { terms: Terms; termsHash: string } | null {
  if (!Object.hasOwn(BODY_SCHEMAS, type)) return null;
  const parsed = BODY_SCHEMAS[type as keyof typeof BODY_SCHEMAS].safeParse(body);
  if (!parsed.success) return null;
  if (!verifyTermsHash(parsed.data.terms, parsed.data.termsHash)) return null;
  return { terms: parsed.data.terms, termsHash: parsed.data.termsHash };
}

class Store {
  private readonly chains = new Map<string, NegotiationState>();
  private readonly seen = new Set<string>();

  constructor(private readonly self: string) {}

  state(key: string): NegotiationState {
    return this.chains.get(key) ?? EMPTY_NEGOTIATION;
  }

  /** Finds the key of a stored offer by envelope id. */
  keyOfOffer(id: string): string | undefined {
    for (const [key, s] of this.chains) {
      if (s.offers.some((o) => o.envelopeId === id)) return key;
    }
    return undefined;
  }

  apply(
    dir: Dir,
    env: Envelope,
  ): { outcome: 'valid' | 'refused' | 'conflict' | 'duplicate'; key: string | undefined } {
    const identity = canonicalize(env as unknown as Obj);
    if (this.seen.has(identity)) return { outcome: 'duplicate', key: this.keyOf(env) };
    this.seen.add(identity);
    const body = parseBody(env.type, env.body);
    if (body === null) return { outcome: 'refused', key: this.keyOf(env) };
    const key = negotiationKey(body.terms.termsId, body.terms.parties);
    const envelope = {
      envelopeId: env.id,
      sender: env.from,
      recipient: env.to,
      createdAt: env.createdAt,
      type: env.type as 'offer' | 'accept' | 'reject',
      replyTo: env.replyTo,
      terms: body.terms,
      termsHash: body.termsHash,
    };
    if (dir === 'sent') {
      this.chains.set(key, recordSentTerms(this.state(key), envelope));
      return { outcome: 'valid', key };
    }
    const r = receiveTerms(this.state(key), envelope, this.self);
    this.chains.set(key, r.state);
    return { outcome: r.outcome, key };
  }

  /** The negotiation key of an envelope whose body may not parse (for the newest-version fields). */
  private keyOf(env: Envelope): string | undefined {
    const terms = (env.body as { terms?: { termsId?: unknown; parties?: unknown } } | null)?.terms;
    const r = termsSchema.safeParse(terms);
    return r.success ? negotiationKey(r.data.termsId, r.data.parties) : undefined;
  }
}

function replay(self: string, log: unknown): Store {
  const store = new Store(self);
  if (!Array.isArray(log)) fail('log');
  for (const entry of log as unknown[]) {
    const e = obj(entry, 'log entry');
    if (e.dir !== 'sent' && e.dir !== 'received') fail('log dir');
    store.apply(e.dir as Dir, obj(e.envelope, 'envelope') as unknown as Envelope);
  }
  return store;
}

const newest = (store: Store, key: string | undefined): Comparison[] => {
  const head = key === undefined ? undefined : newestOpenOffer(store.state(key).offers);
  return [
    { field: 'newestVersion', actual: String(head?.version ?? 0) },
    { field: 'newestTermsHash', actual: head?.termsHash ?? 'null' },
  ];
};

const parsed = (ok: boolean, hash: () => string): Comparison[] =>
  ok
    ? [
        { field: 'outcome', actual: 'accept' },
        { field: 'termsHash', actual: hash() },
      ]
    : [{ field: 'outcome', actual: 'reject' }];

function evaluate(input: Obj): Comparison[] {
  switch (input.op) {
    case 'parseTerms': {
      const r = termsSchema.safeParse(input.terms);
      return parsed(r.success, () => termsHash(r.data));
    }
    case 'parseTermsJson': {
      let value: unknown;
      try {
        value = parseJson(str(input.json, 'json'), { integersOnly: true });
      } catch (error) {
        if (error instanceof CryptoInputError) return parsed(false, () => '');
        throw error;
      }
      const r = termsSchema.safeParse(value);
      return parsed(r.success, () => termsHash(r.data));
    }
    case 'parseTermsBody': {
      const r = parseBody(str(input.type, 'type'), input.body);
      return parsed(r !== null, () => (r as { termsHash: string }).termsHash);
    }
    case 'parseTermsInput': {
      const ok = parseTermsInput(input.termsInput, num(input.now, 'now')).success;
      return [{ field: 'outcome', actual: ok ? 'accept' : 'reject' }];
    }
    case 'mapTermsInput': {
      const ctx = obj(input.context, 'context');
      const r = termsFromInput(input.termsInput, {
        self: ctx.me as string,
        counterparty: ctx.them as string,
        termsId: ctx.termsId as string,
        version: ctx.version as number,
        previousTermsHash: ctx.previousTermsHash as string | null,
        now: ctx.now as number,
      });
      if (!r.success) {
        return [
          { field: 'termsHash', actual: 'refused' },
          { field: 'termsJcs', actual: 'refused' },
        ];
      }
      return [
        { field: 'termsHash', actual: termsHash(r.data) },
        { field: 'termsJcs', actual: canonicalize(r.data) },
      ];
    }
    case 'unicodeProbe':
      return [{ field: 'nfc', actual: str(input.probe, 'probe').normalize('NFC') }];
    case 'chainReceive': {
      const self = str(input.self, 'self');
      const store = replay(self, input.log);
      const r = store.apply('received', obj(input.incoming, 'incoming') as unknown as Envelope);
      return [{ field: 'outcome', actual: r.outcome }, ...newest(store, r.key)];
    }
    case 'nextOffer': {
      const self = str(input.self, 'self');
      const store = replay(self, input.log);
      const key = negotiationKey(str(input.termsId, 'termsId'), [
        self,
        str(input.contact, 'contact'),
      ]);
      const link = nextTermsLink(store.state(key), self);
      return [
        { field: 'version', actual: String(link.version) },
        { field: 'previousTermsHash', actual: link.previousTermsHash ?? 'null' },
        { field: 'replyTo', actual: link.replyTo ?? 'null' },
      ];
    }
    case 'sendAccept': {
      const self = str(input.self, 'self');
      const store = replay(self, input.log);
      const id = str(input.answers, 'answers');
      const key = store.keyOfOffer(id);
      const r =
        key === undefined
          ? ({ result: 'refuse' } as const)
          : checkSendAccept(store.state(key), id, self, num(input.now, 'now'));
      return r.result === 'allowed'
        ? [
            { field: 'outcome', actual: 'allowed' },
            { field: 'termsHash', actual: r.termsHash },
          ]
        : [{ field: 'outcome', actual: 'refused' }];
    }
    default:
      return fail('op');
  }
}

export const terms: SuiteModule = {
  evaluate(testCase) {
    return Promise.resolve(evaluate(obj(testCase.input, 'input')));
  },
};
