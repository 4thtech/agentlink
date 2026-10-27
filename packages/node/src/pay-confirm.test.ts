// M1-PAY-CONFIRM-a acceptance (04 §2.5.3 rules 1 to 4, 6, 7; 08 §1; D-132; I-4, I-7): confirming a
// paid action on the owner's page.
//
// Refused, each on its own: a response without UV (verification_required, never presence alone), a
// reused or expired challenge, a changed amount after begin, a challenge from another session or
// origin, a statement built from an input value, a paid item in a review list, a paid approval or a
// spending change through an ordinary owner route, and a backup code entered wrong three times. A
// policy change without a spending field keeps the ordinary prompt. No MCP tool or CLI file reaches
// the confirmation (rule 4).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  POLICY_DEFAULTS_EFFECTIVE,
  type OwnerActionOutcome,
  type PayConfirmFlow,
} from '@4thtech-io/core';
import {
  canonicalize,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  ownerPrfSalt,
  randomBytes,
  type JsonObject,
  type JsonValue,
} from '@4thtech-io/crypto';
import { newWebauthnTestCredential } from '@4thtech-io/crypto/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_PRESENCE_BACKOFF_S,
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
} from './approval-server.js';
import {
  approvalId,
  digestOf,
  fakeSource,
  ownerSigValid,
  ownerWorld,
  send,
  type FakeSource,
  type OwnerWorld,
  type RawResponse,
} from './approval-ui.fixture.js';
import {
  OWNER_PASSKEY_ACCOUNT,
  OWNER_PASSKEY_KEY_ACCOUNT,
  readOwnerPasskeyKey,
  registerOwnerPasskey,
} from './owner-passkey.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import { VirtualPrfAuthenticator } from './passkey-authenticator.fixture.js';
import {
  BACKUP_CODE_TRIES,
  PAY_CONFIRM_TTL_MS,
  PayConfirmHolds,
  checkPayConfirmAssertion,
  encodePayConfirmAssertion,
  parsePayConfirmAssertion,
  type PayConfirmAssertion,
} from './pay-confirm.js';

const salt = ownerPrfSalt();
const FEE_TOKEN = `0x${'ab'.repeat(20)}`;
const CONTACT = `0x${'12'.repeat(20)}`;
let world: OwnerWorld;
let auth: VirtualPrfAuthenticator;

beforeAll(async () => {
  world = await ownerWorld('agentlink-pay-confirm-');
  auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
  await registerOwnerPasskey(
    world.keychain,
    world.owner,
    encodeUtf8(world.code),
    auth.create(world.owner.ownerNostr, salt),
  );
}, 60_000);

afterAll(async () => {
  await world.keychain.delete(OWNER_PASSKEY_ACCOUNT);
  await world.keychain.delete(OWNER_PASSKEY_KEY_ACCOUNT);
  world.cleanup();
});

/** A paid notarize action (06 §2.0) with a counterparty and a fee of `usd`. */
const paidAction = (usd = '0.1'): JsonObject => ({
  tool: 'agentlink_notarize',
  args: { envelopeId: 'E'.repeat(22) },
  context: {
    triggers: ['proofs.perActionMaxUSD'],
    counterparty: { agentId: CONTACT, ownerKey: 'cd'.repeat(32) },
    envelopeHash: `0x${'ef'.repeat(32)}`,
    fee: { token: FEE_TOKEN, amount: '100000', usd },
  },
});

const DETAILS = {
  who: '“Ana” (self-declared)',
  what: 'Record a proof',
  cost: '$0.10',
  expires: '12 Oct 2026 14:02 UTC',
  rule: 'Above your per-proof limit',
  fromAi: [],
};

/** Adds pending request `n` as a paid proof (fee `usd`). */
function addPaid(source: FakeSource, n: number, usd = '0.1') {
  const action = paidAction(usd);
  return source.add(n, {
    action,
    actionDigest: digestOf(action),
    storedDigest: digestOf(action),
    summary: 'Record a proof',
    details: DETAILS,
  });
}

// --- the policy the Rules page edits (a stand-in for core's client) -------------------------------

const policy = (): JsonObject =>
  JSON.parse(
    canonicalize((POLICY_DEFAULTS_EFFECTIVE as unknown as { policy: JsonValue }).policy),
  ) as JsonObject;

interface PolicyClient {
  version: number;
  current: JsonObject;
  /** The patch the next prepareEdit applies to `current` (shallow per section). */
}

function policyClient(state: PolicyClient) {
  return {
    agentId: world.agentId,
    ownerActions: {
      loadPolicy: () =>
        Promise.resolve(
          state.version === 0
            ? { mode: 'defaults', policy: state.current }
            : { mode: 'signed', policy: state.current, version: state.version },
        ),
      preparePolicyEdit: (patch: Record<string, Record<string, unknown>>) => {
        const next = JSON.parse(canonicalize(state.current)) as Record<string, JsonObject>;
        for (const [section, fields] of Object.entries(patch)) {
          next[section] = { ...next[section], ...(fields as JsonObject) };
        }
        const now = Math.floor(Date.now() / 1000);
        const body: JsonObject = {
          v: 1,
          agent: world.agentId,
          owner: encodeHex(world.owner.ownerNostr),
          op: 'policy.set',
          params: { version: state.version + 1, policy: next as unknown as JsonValue },
          nonce: encodeBase64url(randomBytes(16)),
          issuedAt: now,
          expiresAt: now + 600,
        };
        return Promise.resolve({
          status: 'prepared',
          body,
          jcs: canonicalize(body),
          version: state.version + 1,
          baseVersion: state.version,
          askKeepDeliveryReceipts: false,
          keepDeliveryReceipts: false,
          warnings: [],
        });
      },
      recordReceiptsKept: () => Promise.resolve(true),
    },
  };
}

// --- the server ---------------------------------------------------------------------------------

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

interface Harness {
  readonly server: ApprovalServer;
  readonly source: FakeSource;
  readonly port: number;
  readonly origin: string;
  readonly events: ApprovalServerEvent[];
  readonly clock: { ms: number };
  readonly policy: PolicyClient;
  readonly applied: JsonObject[];
  page(): Promise<Record<string, string>>;
}

async function harness(): Promise<Harness> {
  const source = fakeSource(world);
  const state: PolicyClient = { version: 1, current: policy() };
  const applied: JsonObject[] = [];
  // Policy bodies are applied by the stand-in client; decisions by the fake source.
  const apply = source.apply.bind(source);
  const wrapped = {
    ...source,
    apply: (signed: { body: JsonObject; sig: string }): Promise<OwnerActionOutcome> => {
      applied.push(signed.body);
      if (signed.body['op'] === 'policy.set') {
        if (!ownerSigValid(world.owner, signed.body, signed.sig)) {
          return Promise.resolve({ status: 'refused', op: 'policy.set' } as never);
        }
        const params = signed.body['params'] as { version: number; policy: JsonObject };
        state.version = params.version;
        state.current = params.policy;
        return Promise.resolve({ status: 'applied', op: 'policy.set' } as OwnerActionOutcome);
      }
      return apply(signed);
    },
  };
  const events: ApprovalServerEvent[] = [];
  const opened: string[] = [];
  const clock = { ms: Date.now() };
  const server = await startApprovalServerWith(
    {
      source: wrapped,
      onEvent: (e) => void events.push(e),
      localUi: { client: policyClient(state) as never },
    },
    {
      keychain: world.keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(world.keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      now: () => clock.ms,
    },
  );
  servers.push(server);
  const port = server.port;
  return {
    server,
    source,
    port,
    origin: server.origin,
    events,
    clock,
    policy: state,
    applied,
    async page() {
      const at = opened.length;
      await server.open();
      const token = new URL(opened[at] ?? '').searchParams.get('t') ?? '';
      const first = await send(port, `/?t=${token}`);
      const cookie = (first.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
      const shell = await send(port, '/', { headers: { Cookie: cookie } });
      const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(shell.body)?.[1];
      return {
        Cookie: cookie,
        Origin: server.origin,
        'Content-Type': 'application/octet-stream',
        'X-AgentLink-CSRF': csrf ?? '',
        'Sec-Fetch-Site': 'same-origin',
      };
    },
  };
}

const inputHeader = (value: JsonValue): string => encodeBase64url(encodeUtf8(canonicalize(value)));
const json = (res: RawResponse): Record<string, unknown> =>
  JSON.parse(res.body) as Record<string, unknown>;

interface Begun {
  readonly ceremony: string;
  readonly challenge: string;
  readonly statement: Record<string, unknown>;
  readonly response: RawResponse;
}

async function begin(h: Harness, page: Record<string, string>, input: JsonValue): Promise<Begun> {
  const response = await send(h.port, '/api/ui/pay-confirm/begin', {
    method: 'POST',
    headers: { ...page, 'X-AgentLink-Input': inputHeader(input) },
  });
  const body = response.status === 200 ? json(response) : {};
  const publicKey = (body['publicKey'] ?? {}) as Record<string, unknown>;
  return {
    ceremony: String(body['ceremony'] ?? ''),
    challenge: String(publicKey['challenge'] ?? ''),
    statement: (body['statement'] ?? {}) as Record<string, unknown>,
    response,
  };
}

/** What the page sends after navigator.credentials.get for `challenge` (the virtual passkey). */
function gesture(
  challenge: string,
  over: {
    origin?: string;
    type?: string;
    uv?: boolean;
    challenge?: string;
    /** `forged`: a random signature; `absent`: none; another authenticator signs (and answers). */
    signature?: 'forged' | 'absent';
    by?: VirtualPrfAuthenticator;
  } = {},
): PayConfirmAssertion {
  const signer = over.by ?? auth;
  const got = signer.get(salt);
  const authenticatorData = got.authenticatorData.slice();
  if (over.uv === false) authenticatorData[32] = (authenticatorData[32] as number) & ~0x04;
  const clientData = {
    type: over.type ?? 'webauthn.get',
    challenge: over.challenge ?? challenge,
    origin: over.origin ?? '',
    crossOrigin: false,
  };
  const clientDataJSON = encodeUtf8(JSON.stringify(clientData));
  // The authenticator signs exactly what it returns (a response without UV is signed without it).
  const signature =
    over.signature === 'forged'
      ? randomBytes(70)
      : over.signature === 'absent'
        ? new Uint8Array(0)
        : signer.sign(authenticatorData, clientDataJSON);
  return {
    credentialId: got.credentialId,
    authenticatorData,
    clientDataJSON,
    signature,
    userHandle: got.userHandle,
    prfOutput: got.prfOutput,
  };
}

function finishPasskey(
  h: Harness,
  page: Record<string, string>,
  ceremony: string,
  assertion: PayConfirmAssertion,
): Promise<RawResponse> {
  return send(h.port, '/api/ui/pay-confirm/finish', {
    method: 'POST',
    headers: {
      ...page,
      'X-AgentLink-Input': inputHeader({ ceremony }),
      'X-AgentLink-Presence': 'passkey',
    },
    body: encodePayConfirmAssertion(assertion),
  });
}

function finishCode(
  h: Harness,
  page: Record<string, string>,
  ceremony: string,
  code: string,
): Promise<RawResponse> {
  return send(h.port, '/api/ui/pay-confirm/finish', {
    method: 'POST',
    headers: { ...page, 'X-AgentLink-Input': inputHeader({ ceremony }) },
    body: encodeUtf8(code),
  });
}

const pastBackoff = (h: Harness): void => {
  h.clock.ms += MAX_PRESENCE_BACKOFF_S * 1000 + 1;
};

// --- rule 1: the WebAuthn checks ------------------------------------------------------------------

describe('the assertion checks (rule 1)', () => {
  const header = () => ({ ownerNostr: world.owner.ownerNostr, credentialId: auth.credentialId });
  const challenge = randomBytes(32);
  const origin = 'http://localhost:4321';
  const check = (a: PayConfirmAssertion) =>
    checkPayConfirmAssertion(a, {
      challenge,
      origin,
      passkey: header(),
      publicKey: auth.coseKey ?? null,
      owner: world.owner,
    });

  it('accepts webauthn.get for this challenge and origin with UP and UV', () => {
    expect(check(gesture(encodeBase64url(challenge), { origin }))).toBe('ok');
  });

  it('refuses a forged response: valid JSON and UV set, but a wrong or absent signature (rule 5)', () => {
    const c = encodeBase64url(challenge);
    expect(check(gesture(c, { origin, signature: 'forged' }))).toBe('presence_rejected');
    expect(check(gesture(c, { origin, signature: 'absent' }))).toBe('presence_rejected');
  });

  it('refuses another credential, and any passkey without a stored key (rule 5)', () => {
    const c = encodeBase64url(challenge);
    const other = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    other.create(world.owner.ownerNostr, salt);
    expect(check(gesture(c, { origin, by: other }))).toBe('presence_rejected');
    // The other key signing a response that names our credential is still refused.
    const swapped = { ...gesture(c, { origin, by: other }), credentialId: auth.credentialId };
    expect(check(swapped)).toBe('presence_rejected');
    expect(
      checkPayConfirmAssertion(gesture(c, { origin }), {
        challenge,
        origin,
        passkey: header(),
        publicKey: null,
        owner: world.owner,
      }),
    ).toBe('key_missing');
  });

  it('refuses a response without UV as verification_required, never presence alone', () => {
    expect(check(gesture(encodeBase64url(challenge), { origin, uv: false }))).toBe(
      'verification_required',
    );
  });

  it('refuses another challenge, origin or ceremony type', () => {
    const c = encodeBase64url(challenge);
    expect(check(gesture(c, { origin, challenge: encodeBase64url(randomBytes(32)) }))).toBe(
      'presence_rejected',
    );
    expect(check(gesture(c, { origin: 'http://localhost:9999' }))).toBe('presence_rejected');
    expect(check(gesture(c, { origin, type: 'webauthn.create' }))).toBe('presence_rejected');
  });

  it('round-trips the finish body and refuses a malformed one', () => {
    const a = gesture('x', { origin });
    const parsed = parsePayConfirmAssertion(encodePayConfirmAssertion(a));
    expect(parsed?.clientDataJSON).toEqual(a.clientDataJSON);
    expect(parsePayConfirmAssertion(encodePayConfirmAssertion(a).subarray(1))).toBeUndefined();
    expect(
      parsePayConfirmAssertion(encodePayConfirmAssertion({ ...a, prfOutput: new Uint8Array(0) })),
    ).toBeUndefined();
  });
});

// --- rules 2, 3: the holds ------------------------------------------------------------------------

describe('the holds (rules 2 and 3)', () => {
  const flow = (): PayConfirmFlow => ({
    statement: {
      v: 1,
      kind: 'proof',
      amountUsd: '0.1',
      purpose: 'proof',
      counterparty: null,
      changes: [],
    },
    body: paidAction(),
  });
  const decide = (): JsonObject => ({
    v: 1,
    op: 'approval.decide',
    agent: world.agentId,
    owner: encodeHex(world.owner.ownerNostr),
    params: {
      approvalId: approvalId(1),
      actionDigest: digestOf(paidAction()),
      decision: 'approve',
    },
    nonce: 'N'.repeat(22),
    issuedAt: 1,
    expiresAt: 2,
  });

  it('are single use, bound to the session and valid 120 s', () => {
    const clock = { ms: 1_000 };
    const holds = new PayConfirmHolds(() => clock.ms);
    const session = randomBytes(32);
    const hold = holds.begin(session, { kind: 'proof', approvalId: approvalId(1) }, flow(), [
      { kind: 'owner-action', action: decide() },
    ]);
    expect(PAY_CONFIRM_TTL_MS).toBe(120_000);
    expect(holds.get(hold.id, randomBytes(32), true)).toBe('unknown');
    expect(holds.get(hold.id, session, true)).toBe(hold);
    expect(holds.get(hold.id, session, true)).toBe('unknown');
    const late = holds.begin(session, { kind: 'proof', approvalId: approvalId(1) }, flow(), [
      { kind: 'owner-action', action: decide() },
    ]);
    clock.ms += PAY_CONFIRM_TTL_MS;
    expect(holds.get(late.id, session, true)).toBe('expired');
  });

  it('sign only the objects whose bodies are in the challenge (a policy.set is not)', () => {
    const holds = new PayConfirmHolds(() => 0);
    const extra: JsonObject = {
      ...decide(),
      op: 'policy.set',
      params: { version: 2, policy: policy() },
    };
    expect(() =>
      holds.begin(randomBytes(32), { kind: 'proof', approvalId: approvalId(1) }, flow(), [
        { kind: 'owner-action', action: decide() },
        { kind: 'owner-action', action: extra },
      ]),
    ).toThrow();
  });

  it('end after three wrong backup codes (rule 6)', () => {
    const holds = new PayConfirmHolds(() => 0);
    const session = randomBytes(32);
    const hold = holds.begin(session, { kind: 'proof', approvalId: approvalId(1) }, flow(), [
      { kind: 'owner-action', action: decide() },
    ]);
    expect(BACKUP_CODE_TRIES).toBe(3);
    expect(holds.backupFailed(hold)).toBe(false);
    expect(holds.backupFailed(hold)).toBe(false);
    expect(holds.backupFailed(hold)).toBe(true);
    expect(holds.get(hold.id, session, false)).toBe('unknown');
  });
});

// --- the server: a proof approval -----------------------------------------------------------------

describe('a proof above the limits, confirmed on the page (04 §2.5.3)', () => {
  it('begin states the pending request fee and the stored contact name; finish signs that approval', async () => {
    const h = await harness();
    const page = await h.page();
    const row = addPaid(h.source, 1, '0.25');
    const b = await begin(h, page, { flow: 'proof', approvalId: approvalId(1) });
    expect(b.response.status).toBe(200);
    expect(b.statement).toEqual({
      v: 1,
      kind: 'proof',
      amountUsd: '0.25',
      purpose: 'proof',
      counterparty: DETAILS.who,
      changes: [],
    });
    expect(json(b.response)['publicKey']).toMatchObject({
      rpId: 'localhost',
      userVerification: 'required',
      allowCredentials: [encodeBase64url(auth.credentialId)],
    });
    const res = await finishPasskey(
      h,
      page,
      b.ceremony,
      gesture(b.challenge, { origin: h.origin }),
    );
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ status: 'applied' });
    const signed = h.source.applied[0];
    expect(signed?.body['op']).toBe('approval.decide');
    expect(signed?.body['params']).toEqual({
      approvalId: approvalId(1),
      actionDigest: row.storedDigest,
      decision: 'approve',
    });
    expect(ownerSigValid(world.owner, signed?.body ?? {}, signed?.sig ?? '')).toBe(true);
    // Fixed values only in the events (I-7): no challenge, ceremony, amount or name.
    const text = JSON.stringify(h.events);
    for (const secret of [b.challenge, b.ceremony, '0.25', DETAILS.who]) {
      expect(text).not.toContain(secret);
    }
  });

  it('refuses a missing UV flag and uses the challenge up', async () => {
    const h = await harness();
    const page = await h.page();
    addPaid(h.source, 1);
    const b = await begin(h, page, { flow: 'proof', approvalId: approvalId(1) });
    const res = await finishPasskey(
      h,
      page,
      b.ceremony,
      gesture(b.challenge, { origin: h.origin, uv: false }),
    );
    expect(res.status).toBe(403);
    expect(json(res)['status']).toBe('verification_required');
    const again = await finishPasskey(
      h,
      page,
      b.ceremony,
      gesture(b.challenge, { origin: h.origin }),
    );
    expect(json(again)['status']).toBe('unknown');
    expect(h.source.applied).toHaveLength(0);
  });

  it('refuses a forged response (UV set, wrong or absent signature) and another credential', async () => {
    const h = await harness();
    const page = await h.page();
    addPaid(h.source, 1);
    for (const signature of ['forged', 'absent'] as const) {
      pastBackoff(h);
      const b = await begin(h, page, { flow: 'proof', approvalId: approvalId(1) });
      const res = await finishPasskey(
        h,
        page,
        b.ceremony,
        gesture(b.challenge, { origin: h.origin, signature }),
      );
      expect(json(res)['status']).toBe('presence_rejected');
    }
    pastBackoff(h);
    const other = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    other.create(world.owner.ownerNostr, salt);
    const c = await begin(h, page, { flow: 'proof', approvalId: approvalId(1) });
    const res = await finishPasskey(
      h,
      page,
      c.ceremony,
      gesture(c.challenge, { origin: h.origin, by: other }),
    );
    expect(json(res)['status']).toBe('presence_rejected');
    expect(h.source.applied).toHaveLength(0);
  });

  it('a passkey without a stored key is never accepted; the backup code still works (rule 5)', async () => {
    const h = await harness();
    const page = await h.page();
    addPaid(h.source, 1);
    const kept = await world.keychain.get(OWNER_PASSKEY_KEY_ACCOUNT);
    await world.keychain.delete(OWNER_PASSKEY_KEY_ACCOUNT);
    try {
      const b = await begin(h, page, { flow: 'proof', approvalId: approvalId(1) });
      expect(json(b.response)['publicKey']).toMatchObject({ allowCredentials: [] });
      const res = await finishPasskey(
        h,
        page,
        b.ceremony,
        gesture(b.challenge, { origin: h.origin }),
      );
      expect(json(res)['status']).toBe('passkey_update_needed');
      expect(h.source.applied).toHaveLength(0);
      const c = await begin(h, page, { flow: 'proof', approvalId: approvalId(1) });
      expect(json(await finishCode(h, page, c.ceremony, world.code))).toEqual({
        status: 'applied',
      });
    } finally {
      if (kept !== null) await world.keychain.set(OWNER_PASSKEY_KEY_ACCOUNT, kept);
    }
  });

  it('registration keeps the credential public key, bound to the credential ID', async () => {
    expect(await readOwnerPasskeyKey(world.keychain, auth.credentialId)).toEqual(auth.coseKey);
    expect(await readOwnerPasskeyKey(world.keychain, randomBytes(16))).toBeNull();
  });

  it('refuses a reused challenge', async () => {
    const h = await harness();
    const page = await h.page();
    addPaid(h.source, 1);
    addPaid(h.source, 2);
    const b = await begin(h, page, { flow: 'proof', approvalId: approvalId(1) });
    expect(
      (await finishPasskey(h, page, b.ceremony, gesture(b.challenge, { origin: h.origin }))).status,
    ).toBe(200);
    const replay = await finishPasskey(
      h,
      page,
      b.ceremony,
      gesture(b.challenge, { origin: h.origin }),
    );
    expect(json(replay)['status']).toBe('unknown');
    // The same signed challenge does not fit another begin either.
    const other = await begin(h, page, { flow: 'proof', approvalId: approvalId(2) });
    const swapped = await finishPasskey(
      h,
      page,
      other.ceremony,
      gesture(b.challenge, { origin: h.origin }),
    );
    expect(json(swapped)['status']).toBe('presence_rejected');
    expect(h.source.applied).toHaveLength(1);
  });

  it('refuses an expired challenge (120 s)', async () => {
    const h = await harness();
    const page = await h.page();
    addPaid(h.source, 1);
    const b = await begin(h, page, { flow: 'proof', approvalId: approvalId(1) });
    h.clock.ms += PAY_CONFIRM_TTL_MS;
    const res = await finishPasskey(
      h,
      page,
      b.ceremony,
      gesture(b.challenge, { origin: h.origin }),
    );
    expect(json(res)['status']).toBe('expired');
    expect(h.source.applied).toHaveLength(0);
  });

  it('refuses a changed amount after begin (a new begin and gesture are needed)', async () => {
    const h = await harness();
    const page = await h.page();
    addPaid(h.source, 1, '0.1');
    const b = await begin(h, page, { flow: 'proof', approvalId: approvalId(1) });
    addPaid(h.source, 1, '0.9');
    const res = await finishPasskey(
      h,
      page,
      b.ceremony,
      gesture(b.challenge, { origin: h.origin }),
    );
    expect(res.status).toBe(409);
    expect(json(res)['status']).toBe('changed');
    expect(h.source.applied).toHaveLength(0);
  });

  it('refuses a challenge from another session, and another origin', async () => {
    const h = await harness();
    const page = await h.page();
    const otherPage = await h.page();
    addPaid(h.source, 1);
    const b = await begin(h, page, { flow: 'proof', approvalId: approvalId(1) });
    const res = await finishPasskey(
      h,
      otherPage,
      b.ceremony,
      gesture(b.challenge, { origin: h.origin }),
    );
    expect(json(res)['status']).toBe('unknown');
    const c = await begin(h, page, { flow: 'proof', approvalId: approvalId(1) });
    const look = await finishPasskey(
      h,
      page,
      c.ceremony,
      gesture(c.challenge, { origin: 'http://localhost:1' }),
    );
    expect(json(look)['status']).toBe('presence_rejected');
    expect(h.source.applied).toHaveLength(0);
  });

  it('refuses a statement built from a URL or tool value: only the flow is named', async () => {
    const h = await harness();
    const page = await h.page();
    addPaid(h.source, 1);
    for (const extra of [{ amountUsd: '0.01' }, { counterparty: 'Bob' }, { statement: {} }]) {
      const b = await begin(h, page, { flow: 'proof', approvalId: approvalId(1), ...extra });
      expect(b.response.status).toBe(400);
    }
    // A free request is not a paid flow: the ordinary prompt decides it.
    h.source.add(2);
    expect(
      (await begin(h, page, { flow: 'proof', approvalId: approvalId(2) })).response.status,
    ).toBe(409);
  });

  it('the backup code signs the same single action; three wrong entries end the attempt', async () => {
    const h = await harness();
    const page = await h.page();
    addPaid(h.source, 1);
    const b = await begin(h, page, { flow: 'proof', approvalId: approvalId(1) });
    // The first three wrong entries are free (no backoff yet); the third ends the attempt.
    for (let i = 1; i <= BACKUP_CODE_TRIES; i += 1) {
      const res = await finishCode(h, page, b.ceremony, 'AAAA BBBB CCCC DDDD EEEE FFFF');
      expect(json(res)['status']).toBe(
        i < BACKUP_CODE_TRIES ? 'presence_rejected' : 'tries_exhausted',
      );
    }
    pastBackoff(h);
    const c = await begin(h, page, { flow: 'proof', approvalId: approvalId(1) });
    expect(json(await finishCode(h, page, b.ceremony, world.code))['status']).toBe('unknown');
    const ok = await finishCode(h, page, c.ceremony, world.code);
    expect(json(ok)).toEqual({ status: 'applied' });
    expect(h.source.applied).toHaveLength(1);
  });
});

describe('ordinary routes never sign a paid item (rules 3 and 7)', () => {
  const decideVia = (h: Harness, page: Record<string, string>, n: number, decision: string) =>
    h.source.get(approvalId(n)).then((row) =>
      send(h.port, `/api/approvals/${approvalId(n)}/${decision}`, {
        method: 'POST',
        headers: { ...page, 'X-AgentLink-Digest': row?.actionDigest ?? '' },
        body: encodeUtf8(world.code),
      }),
    );

  it('approving a paid request through the ordinary decision is confirm_required; denying works', async () => {
    const h = await harness();
    const page = await h.page();
    addPaid(h.source, 1);
    const res = await decideVia(h, page, 1, 'approve');
    expect(res.status).toBe(409);
    expect(json(res)['status']).toBe('confirm_required');
    expect(h.source.applied).toHaveLength(0);
    expect((await decideVia(h, page, 1, 'deny')).status).toBe(200);
  });

  it('a review list with a paid item is refused whole (paid_item_in_batch)', async () => {
    const h = await harness();
    const page = await h.page();
    const free = h.source.add(1);
    const paid = addPaid(h.source, 2);
    const items = [free, paid].map((r) => `${r.approvalId}:${r.storedDigest}:a`).join(',');
    const res = await send(h.port, '/api/approvals/review', {
      method: 'POST',
      headers: { ...page, 'X-AgentLink-Items': items },
      body: encodeUtf8(world.code),
    });
    expect(res.status).toBe(409);
    expect(json(res)).toEqual({ status: 'paid_item_in_batch', items: [paid.approvalId] });
    expect(h.source.applied).toHaveLength(0);
  });
});

// --- the server: a limits change ------------------------------------------------------------------

describe('a change to the spending limits (04 §2.5.3 table)', () => {
  const review = async (h: Harness, page: Record<string, string>, patch: JsonObject) => {
    const edit = encodeBase64url(encodeUtf8(canonicalize({ base: h.policy.version, patch })));
    const res = await send(h.port, `/api/ui/rules/review?edit=${edit}`, { headers: page });
    expect(res.status).toBe(200);
    return String(json(res)['review']);
  };
  const save = (h: Harness, page: Record<string, string>, hash: string) =>
    send(h.port, '/api/ui/rules', {
      method: 'POST',
      headers: { ...page, 'X-AgentLink-Input': inputHeader({ review: hash, acknowledged: [] }) },
      body: encodeUtf8(world.code),
    });

  it('the ordinary save refuses a spending change; the confirmation lists old and new and signs it', async () => {
    const h = await harness();
    const page = await h.page();
    const saved = await save(h, page, await review(h, page, { proofs: { perActionMaxUSD: '7' } }));
    expect(saved.status).toBe(409);
    expect(json(saved)['status']).toBe('confirm_required');
    expect(h.policy.version).toBe(1);

    const hash = await review(h, page, { proofs: { perActionMaxUSD: '7' } });
    const b = await begin(h, page, { flow: 'limits', review: hash, acknowledged: [] });
    expect(b.response.status).toBe(200);
    expect(b.statement).toMatchObject({
      kind: 'limits',
      amountUsd: null,
      purpose: 'limits_change',
      changes: [{ field: 'proofs.perActionMaxUSD', old: '1', new: '7' }],
    });
    const res = await finishPasskey(
      h,
      page,
      b.ceremony,
      gesture(b.challenge, { origin: h.origin }),
    );
    expect(json(res)).toEqual({ status: 'applied' });
    expect(h.policy.version).toBe(2);
    expect((h.policy.current['proofs'] as JsonObject)['perActionMaxUSD']).toBe('7');
  });

  it('refuses a limit changed elsewhere after begin', async () => {
    const h = await harness();
    const page = await h.page();
    const hash = await review(h, page, { proofs: { dailyBudgetUSD: '9' } });
    const b = await begin(h, page, { flow: 'limits', review: hash, acknowledged: [] });
    (h.policy.current['proofs'] as Record<string, JsonValue>)['perActionMaxUSD'] = '3';
    const res = await finishPasskey(
      h,
      page,
      b.ceremony,
      gesture(b.challenge, { origin: h.origin }),
    );
    expect(json(res)['status']).toBe('changed');
  });

  it('a policy change without a spending field keeps the ordinary prompt', async () => {
    const h = await harness();
    const page = await h.page();
    const hash = await review(h, page, { files: { maxSendSizeMB: 11 } });
    const res = await save(h, page, hash);
    expect(res.status).toBe(200);
    expect(h.policy.version).toBe(2);
    const other = await review(h, page, { files: { maxSendSizeMB: 12 } });
    const b = await begin(h, page, { flow: 'limits', review: other, acknowledged: [] });
    expect(json(b.response)['status']).toBe('not_paid');
  });
});

// --- rule 4: nothing but the owner's page reaches it ----------------------------------------------

describe('no MCP tool or CLI flag reaches begin or finish (rule 4, I-4)', () => {
  it('needs the page session', async () => {
    const h = await harness();
    addPaid(h.source, 1);
    const res = await send(h.port, '/api/ui/pay-confirm/begin', {
      method: 'POST',
      headers: {
        Origin: h.origin,
        'Content-Type': 'application/octet-stream',
        'Sec-Fetch-Site': 'same-origin',
        'X-AgentLink-Input': inputHeader({ flow: 'proof', approvalId: approvalId(1) }),
      },
    });
    expect(res.status).toBe(401);
  });

  it('no file of the MCP tools or the CLI names the confirmation routes', () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const roots = [join(repo, 'packages', 'mcp-tools', 'src'), join(repo, 'apps', 'cli', 'src')];
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && /\.(ts|mts|js|mjs)$/.test(entry.name)) {
          if (/pay-confirm|payConfirm|PayConfirm/.test(readFileSync(path, 'utf8'))) hits.push(path);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(hits).toEqual([]);
  });
});
