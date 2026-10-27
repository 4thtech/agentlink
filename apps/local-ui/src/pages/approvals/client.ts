// M1-11b-2: the approvals page's calls. The same routes, headers and bodies as the former
// server-rendered approval page (removed in M1-11b-2c), so the server's decision logic, presence
// checks and gates are untouched (04 §2.5, §2.5.2; D-68, D-118; I-4):
//
// - GET /api/approvals, GET /api/approvals/<id>, GET /api/owner/passkey;
// - POST /api/approvals/<id>/(approve|deny) with `X-AgentLink-Digest`, and POST /api/approvals/review
//   with `X-AgentLink-Items` (`<id>:<digest>:a|d,…`). The body is the owner code (octet-stream), or,
//   with `X-AgentLink-Presence: passkey`, the assertion: credential ID, authenticator data, user
//   handle and PRF output, each with a 16-bit length first.
//
// The session token travels as `X-AgentLink-CSRF`. The browser never signs (D-118); the passkey is
// asked only after the owner clicks (11 §6.2.1). The code and the assertion bytes are wiped after the
// request and never logged. Paid approvals go through the confirmation sheet (pay-confirm), never here.

/** What the card shows, built by the agent's runtime (approval-server.ts ApprovalDetails). */
export interface ApprovalDetailsView {
  readonly headline?: string;
  readonly who: string;
  readonly what: string;
  readonly cost: string;
  readonly expires: string;
  readonly rule: string;
  readonly fromAi: readonly { readonly name: string; readonly value: string }[];
  readonly terms?: readonly string[];
}

/** One pending request as the server lists it (approval-server.ts PendingApprovalView). */
export interface ApprovalItem {
  readonly approvalId: string;
  readonly summary: string;
  readonly actionDigest: string;
  readonly expiresAt: number;
  readonly commitment: boolean;
  readonly paid: boolean;
  readonly details?: ApprovalDetailsView;
}

/** The localhost passkey the server keeps for decisions (M1-8e). */
export interface DecisionPasskey {
  readonly credentialId: string;
  readonly prfSalt: string;
}

export type PasskeyAnswer =
  /** The owner is set up; `passkey` when one is registered for `localhost`. */
  | { readonly kind: 'ready'; readonly passkey?: DecisionPasskey; readonly offered: boolean }
  /** No owner yet: nothing can be approved here. */
  | { readonly kind: 'needs_owner' };

export type ListAnswer =
  { readonly kind: 'ok'; readonly items: readonly ApprovalItem[] } | { readonly kind: 'offline' };

export type OneAnswer =
  | { readonly kind: 'ok'; readonly item: ApprovalItem }
  | { readonly kind: 'not_pending' }
  | { readonly kind: 'offline' };

/** The owner's presence for one decision or one review. */
export type Presence =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'passkey'; readonly passkey: DecisionPasskey };

export type DecideAnswer =
  | {
      readonly kind: 'status';
      readonly status: string;
      readonly decision?: string;
      readonly retryAfter?: number;
    }
  /** The passkey prompt was dismissed: nothing was sent. */
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'offline' };

export type Decision = 'approve' | 'deny';

export interface ReviewPick {
  readonly item: ApprovalItem;
  readonly decision: Decision;
}

export interface ApprovalsClient {
  passkey(): Promise<PasskeyAnswer>;
  list(): Promise<ListAnswer>;
  one(approvalId: string): Promise<OneAnswer>;
  decide(item: ApprovalItem, decision: Decision, presence: Presence): Promise<DecideAnswer>;
  review(picks: readonly ReviewPick[], presence: Presence): Promise<DecideAnswer>;
}

export interface ApprovalsClientOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
  readonly credentials?: CredentialsContainer;
}

const CSRF_HEADER = 'X-AgentLink-CSRF';
export const APPROVAL_ID = /^apr_[A-Za-z0-9_-]{22}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

const fromB64 = (text: string): Uint8Array<ArrayBuffer> => {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const bytesOf = (buffer: ArrayBuffer | null | undefined): Uint8Array =>
  buffer ? new Uint8Array(buffer) : new Uint8Array(0);

function fields(list: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(list.reduce((n, f) => n + 2 + f.length, 0));
  let at = 0;
  for (const f of list) {
    out[at] = f.length >> 8;
    out[at + 1] = f.length & 255;
    out.set(f, at + 2);
    at += 2 + f.length;
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';

function detailsOf(v: unknown): ApprovalDetailsView | undefined {
  if (!isObject(v)) return undefined;
  const { who, what, cost, expires, rule, fromAi, headline, terms } = v;
  if (!str(who) || !str(what) || !str(cost) || !str(expires) || !str(rule)) return undefined;
  if (!Array.isArray(fromAi)) return undefined;
  const args = fromAi.filter(
    (f): f is { name: string; value: string } => isObject(f) && str(f['name']) && str(f['value']),
  );
  return {
    who,
    what,
    cost,
    expires,
    rule,
    fromAi: args.map((f) => ({ name: f.name, value: f.value })),
    ...(str(headline) ? { headline } : {}),
    ...(Array.isArray(terms) ? { terms: terms.filter(str) } : {}),
  };
}

/** A listed request, checked; anything else is left out. */
function itemOf(v: unknown): ApprovalItem | undefined {
  if (!isObject(v)) return undefined;
  const { approvalId, summary, actionDigest, expiresAt, commitment, paid, details } = v;
  if (!str(approvalId) || !APPROVAL_ID.test(approvalId)) return undefined;
  if (!str(summary) || !str(actionDigest) || !DIGEST.test(actionDigest)) return undefined;
  if (typeof expiresAt !== 'number') return undefined;
  const d = detailsOf(details);
  return {
    approvalId,
    summary,
    actionDigest,
    expiresAt,
    commitment: commitment === true,
    paid: paid === true,
    ...(d === undefined ? {} : { details: d }),
  };
}

export function createApprovalsClient(options: ApprovalsClientOptions = {}): ApprovalsClient {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();
  const credentials = (): CredentialsContainer | undefined =>
    options.credentials ?? (typeof navigator === 'undefined' ? undefined : navigator.credentials);

  async function get(path: string): Promise<{ status: number; json: unknown } | undefined> {
    try {
      const res = await doFetch(path, {
        method: 'GET',
        headers: { [CSRF_HEADER]: token() },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      return { status: res.status, json };
    } catch {
      return undefined;
    }
  }

  async function post(
    path: string,
    headers: Record<string, string>,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<DecideAnswer> {
    try {
      const res = await doFetch(path, {
        method: 'POST',
        headers: {
          [CSRF_HEADER]: token(),
          'Content-Type': 'application/octet-stream',
          ...headers,
        },
        body,
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const json = (await res.json()) as unknown;
      if (!isObject(json) || !str(json['status'])) return { kind: 'status', status: 'refused' };
      return {
        kind: 'status',
        status: json['status'],
        ...(str(json['decision']) ? { decision: json['decision'] } : {}),
        ...(typeof json['retryAfter'] === 'number' ? { retryAfter: json['retryAfter'] } : {}),
      };
    } catch {
      return { kind: 'offline' };
    } finally {
      body.fill(0);
    }
  }

  /** One gesture with this page's own challenge: the four-field decision assertion (M1-8e). */
  async function assertion(passkey: DecisionPasskey): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const container = credentials();
    if (container === undefined) return undefined;
    const challenge = new Uint8Array(32);
    globalThis.crypto.getRandomValues(challenge);
    let credential: Credential | null;
    try {
      credential = await container.get({
        publicKey: {
          challenge,
          rpId: 'localhost',
          allowCredentials: [{ type: 'public-key', id: fromB64(passkey.credentialId) }],
          userVerification: 'required',
          timeout: 120000,
          extensions: {
            prf: { eval: { first: fromB64(passkey.prfSalt) } },
          } as AuthenticationExtensionsClientInputs,
        },
      });
    } catch {
      return undefined;
    }
    if (credential === null) return undefined;
    const c = credential as PublicKeyCredential;
    const r = c.response as AuthenticatorAssertionResponse;
    const ext = c.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
    const prf = bytesOf(ext.prf?.results?.first);
    const body = fields([
      bytesOf(c.rawId),
      bytesOf(r.authenticatorData),
      bytesOf(r.userHandle),
      prf,
    ]);
    prf.fill(0);
    return body;
  }

  /** The body and headers for the owner's presence; undefined when the prompt was dismissed. */
  async function presenceBody(
    presence: Presence,
  ): Promise<{ body: Uint8Array<ArrayBuffer>; headers: Record<string, string> } | undefined> {
    if (presence.kind === 'code') {
      return { body: Uint8Array.from(new TextEncoder().encode(presence.code)), headers: {} };
    }
    const body = await assertion(presence.passkey);
    return body === undefined
      ? undefined
      : { body, headers: { 'X-AgentLink-Presence': 'passkey' } };
  }

  return {
    async passkey() {
      const answer = await get('/api/owner/passkey');
      if (answer?.status === 503) return { kind: 'needs_owner' };
      if (answer === undefined || answer.status !== 200 || !isObject(answer.json)) {
        return { kind: 'ready', offered: false };
      }
      const p = answer.json['passkey'];
      if (!isObject(p) || p['rpId'] !== 'localhost') return { kind: 'ready', offered: false };
      const { credentialId, prfSalt } = p;
      if (p['registered'] === true && str(credentialId) && str(prfSalt)) {
        return { kind: 'ready', offered: true, passkey: { credentialId, prfSalt } };
      }
      return { kind: 'ready', offered: true };
    },

    async list() {
      const answer = await get('/api/approvals');
      if (answer === undefined || answer.status !== 200 || !isObject(answer.json)) {
        return { kind: 'offline' };
      }
      const raw = answer.json['approvals'];
      const items = (Array.isArray(raw) ? raw : [])
        .map(itemOf)
        .filter((i): i is ApprovalItem => i !== undefined);
      return { kind: 'ok', items };
    },

    async one(approvalId) {
      if (!APPROVAL_ID.test(approvalId)) return { kind: 'not_pending' };
      const answer = await get(`/api/approvals/${approvalId}`);
      if (answer === undefined) return { kind: 'offline' };
      if (answer.status === 404) return { kind: 'not_pending' };
      const item = isObject(answer.json) ? itemOf(answer.json['approval']) : undefined;
      if (answer.status !== 200 || item === undefined) return { kind: 'offline' };
      return { kind: 'ok', item };
    },

    async decide(item, decision, presence) {
      if (!APPROVAL_ID.test(item.approvalId)) return { kind: 'status', status: 'refused' };
      const p = await presenceBody(presence);
      if (p === undefined) return { kind: 'dismissed' };
      return post(
        `/api/approvals/${item.approvalId}/${decision}`,
        { 'X-AgentLink-Digest': item.actionDigest, ...p.headers },
        p.body,
      );
    },

    async review(picks, presence) {
      const items = picks
        .map(
          (p) =>
            `${p.item.approvalId}:${p.item.actionDigest}:${p.decision === 'approve' ? 'a' : 'd'}`,
        )
        .join(',');
      const p = await presenceBody(presence);
      if (p === undefined) return { kind: 'dismissed' };
      return post('/api/approvals/review', { 'X-AgentLink-Items': items, ...p.headers }, p.body);
    },
  };
}
