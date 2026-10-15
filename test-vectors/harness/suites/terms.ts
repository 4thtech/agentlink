// Suite `terms` (M1-21, D-32, D-55): the strict `terms` schema and canonical form, `TermsInput` and
// its mapping (@agentlink/types), termsHash = sha256(JCS(terms)) (@agentlink/crypto), and the pure
// negotiation-chain helpers. For the chain ops this module replays the case's `log` the way a core
// replays its own store: it groups offers by `negotiationKey`, checks every received envelope with
// the helpers and applies their result (store, refuse, mark conflict, lock). The decisions are the
// helpers'; this module only keeps the list. Nothing here supplies an expected value.
import {
  CryptoInputError,
  canonicalize,
  parseJson,
  termsHash,
  verifyTermsHash,
} from '@agentlink/crypto';
import {
  acceptBodySchema,
  checkSendAccept,
  evaluateIncomingAnswer,
  evaluateIncomingOffer,
  negotiationKey,
  newestOpenOffer,
  nextTermsLink,
  offerBodySchema,
  rejectBodySchema,
  termsFromInput,
  termsInputSchema,
  termsSchema,
  type StoredTermsOffer,
  type Terms,
} from '@agentlink/types';
import type { Comparison, SuiteModule } from '../suite';

type Obj = Record<string, unknown>;
type Dir = 'sent' | 'received';
interface Envelope {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly type: string;
  readonly replyTo: string | null;
  readonly body: unknown;
}
interface LogEntry {
  readonly dir: Dir;
  readonly envelope: Envelope;
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

/** A terms body that passes its strict schema and whose termsHash is the recomputed one. */
function parseBody(type: string, body: unknown): { terms: Terms; termsHash: string } | null {
  if (!Object.hasOwn(BODY_SCHEMAS, type)) return null;
  const parsed = BODY_SCHEMAS[type as keyof typeof BODY_SCHEMAS].safeParse(body);
  if (!parsed.success) return null;
  if (!verifyTermsHash(parsed.data.terms, parsed.data.termsHash)) return null;
  return { terms: parsed.data.terms, termsHash: parsed.data.termsHash };
}

/** One negotiation key's state, as a core keeps it. */
interface Chain {
  offers: StoredTermsOffer[];
  lockedVersions: number[];
}

class Store {
  private readonly chains = new Map<string, Chain>();

  constructor(private readonly self: string) {}

  chain(key: string): Chain {
    let c = this.chains.get(key);
    if (c === undefined) {
      c = { offers: [], lockedVersions: [] };
      this.chains.set(key, c);
    }
    return c;
  }

  /** Finds a stored offer by envelope id in any negotiation. */
  findOffer(id: string): { key: string; offer: StoredTermsOffer } | undefined {
    for (const [key, c] of this.chains) {
      const offer = c.offers.find((o) => o.envelopeId === id);
      if (offer !== undefined) return { key, offer };
    }
    return undefined;
  }

  /** Applies one envelope; returns the outcome of a received one and its negotiation key. */
  apply(dir: Dir, env: Envelope): { outcome: 'valid' | 'refused' | 'conflict'; key?: string } {
    const body = parseBody(env.type, env.body);
    if (body === null) return { outcome: 'refused' };
    const { terms, termsHash: hash } = body;
    const key = negotiationKey(terms.termsId, terms.parties);
    const c = this.chain(key);
    const offer: StoredTermsOffer = {
      envelopeId: env.id,
      sender: env.from,
      version: terms.version,
      termsHash: hash,
      state: 'open',
      validUntil: terms.validUntil,
    };
    if (dir === 'sent') {
      // The own core wrote it after its own checks.
      if (env.type === 'offer') c.offers.push(offer);
      if (env.type === 'accept') c.lockedVersions.push(terms.version);
      return { outcome: 'valid', key };
    }
    if (env.type === 'offer') {
      const r = evaluateIncomingOffer(
        { envelopeId: env.id, sender: env.from, self: this.self, terms },
        c,
      );
      if (r.result === 'accept') {
        c.offers.push(offer);
        return { outcome: 'valid', key };
      }
      if (r.result === 'conflict') {
        c.offers = c.offers.map((o) =>
          o.envelopeId === r.with ? { ...o, state: 'conflict' as const } : o,
        );
        c.offers.push({ ...offer, state: 'conflict' });
        return { outcome: 'conflict', key };
      }
      return { outcome: 'refused', key };
    }
    const r = evaluateIncomingAnswer(
      {
        envelopeId: env.id,
        type: env.type as 'accept' | 'reject',
        sender: env.from,
        self: this.self,
        replyTo: env.replyTo,
        terms,
        termsHash: hash,
      },
      c,
    );
    if (r.result !== 'accept') return { outcome: 'refused', key };
    if (env.type === 'accept') c.lockedVersions.push(terms.version);
    return { outcome: 'valid', key };
  }
}

function replay(self: string, log: unknown): Store {
  const store = new Store(self);
  if (!Array.isArray(log)) fail('log');
  for (const entry of log as LogEntry[]) {
    const e = obj(entry, 'log entry');
    if (e.dir !== 'sent' && e.dir !== 'received') fail('log dir');
    store.apply(e.dir as Dir, obj(e.envelope, 'envelope') as unknown as Envelope);
  }
  return store;
}

const newest = (store: Store, key: string | undefined): Comparison[] => {
  const head = key === undefined ? undefined : newestOpenOffer(store.chain(key).offers);
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
    case 'parseTermsInput':
      return [
        {
          field: 'outcome',
          actual: termsInputSchema.safeParse(input.termsInput).success ? 'accept' : 'reject',
        },
      ];
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
      const link = nextTermsLink(store.chain(key).offers);
      return [
        { field: 'version', actual: String(link.version) },
        { field: 'previousTermsHash', actual: link.previousTermsHash ?? 'null' },
      ];
    }
    case 'sendAccept': {
      const self = str(input.self, 'self');
      const store = replay(self, input.log);
      const id = str(input.answers, 'answers');
      const found = store.findOffer(id);
      const r =
        found === undefined
          ? { result: 'refuse' as const }
          : checkSendAccept(store.chain(found.key), id, self, input.now as number);
      return r.result === 'allowed'
        ? [
            { field: 'outcome', actual: 'allowed' },
            { field: 'termsHash', actual: (found as { offer: StoredTermsOffer }).offer.termsHash },
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
