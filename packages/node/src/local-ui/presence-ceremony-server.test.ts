// REL051-SF1 (04 §2.5 "each passkey gesture unlocks the owner key for exactly one owner operation";
// §2.5.3 rules 1 and 5 on every presence route; presence-ceremony.ts): a passkey proof on the local
// app is a fresh, server-issued, single-use challenge, bound to the page session, the route and its
// input, and signed by the stored passkey. A request body seen once is not a credential: sent again,
// sent to another route, with other input or from another page session, it is refused, and nothing
// is staged, signed or unlocked. The master code is unchanged.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  encodeBase64url,
  encodeUtf8,
  ownerPrfSalt,
  randomBytes,
  type JsonObject,
} from '@4thtech-io/crypto';
import { newWebauthnTestCredential } from '@4thtech-io/crypto/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerSource,
} from '../approval-server.js';
import {
  fakeSource,
  ownerWorld,
  send,
  type FakeSource,
  type OwnerWorld,
} from '../approval-ui.fixture.js';
import type { KeychainBackend } from '../keychain.js';
import { TEST_APP } from '../local-ui-app.fixture.js';
import { KeychainOwnerKeyStore, OWNER_NEXT_ACCOUNT } from '../owner-keystore.js';
import {
  OWNER_PASSKEY_KEY_ACCOUNT,
  encodePasskeyAssertion,
  registerOwnerPasskey,
} from '../owner-passkey.js';
import { VirtualPrfAuthenticator } from '../passkey-authenticator.fixture.js';
import { encodePayConfirmAssertion } from '../pay-confirm.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

// The fixed paths (08 §1), spelled out so this suite does not depend on the modules under test.
const TEST = '/api/ui/owner-presence/test';
const REPLACE = '/api/ui/owner-code/replace';
const RULES = '/api/ui/rules';
const EMPTY_INPUT = 'e30'; // base64url of `{}`

const worlds: OwnerWorld[] = [];
const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const w of worlds.splice(0)) w.cleanup();
});

interface Answer {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

interface RequestOptions {
  readonly presence?: 'passkey' | 'challenge';
  readonly ceremony?: string;
  readonly input?: string | null;
  readonly headers?: Record<string, string>;
}

type Post = (path: string, body: Uint8Array, options?: RequestOptions) => Promise<Answer>;

interface Harness {
  readonly world: OwnerWorld;
  readonly server: ApprovalServer;
  readonly events: ApprovalServerEvent[];
  readonly applied: JsonObject[];
  readonly source: ApprovalServerSource;
  readonly post: Post;
  /** A second page session of the same server (another tab). */
  otherSession(): Promise<Post>;
}

async function harness(
  options: { source?: (world: OwnerWorld) => ApprovalServerSource } = {},
): Promise<Harness> {
  const world = await ownerWorld('agentlink-sf1-');
  worlds.push(world);
  const home = join(world.root, 'home');
  mkdirSync(join(home, '.agentlink', 'agents', 'default'), { recursive: true });
  const applied: JsonObject[] = [];
  const source: ApprovalServerSource = options.source?.(world) ?? {
    context: () => Promise.resolve({ agent: world.agentId, owner: world.owner }),
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    apply: (signed) => {
      applied.push(signed.body as JsonObject);
      return Promise.resolve({ status: 'applied', op: 'x' } as never);
    },
  };
  const events: ApprovalServerEvent[] = [];
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    {
      source,
      onEvent: (event) => void events.push(event),
      localUi: { assets: TEST_APP },
    },
    {
      keychain: world.keychain as KeychainBackend,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(world.keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      ownerKdf: KDF,
    },
  );
  servers.push(server);
  await server.open();

  const session = async (): Promise<Post> => {
    const before = opened.length;
    if (before > 0) await server.open();
    const token = new URL(opened[before] ?? '').searchParams.get('t') ?? '';
    const login = await send(server.port, `/?t=${token}`);
    const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    const page = await send(server.port, '/', { headers: { Cookie: cookie } });
    const csrf =
      /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
    return async (path, body, o = {}) => {
      const input = o.input === undefined ? EMPTY_INPUT : o.input;
      const res = await send(server.port, path, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: server.origin,
          'X-AgentLink-CSRF': csrf,
          'Content-Type': 'application/octet-stream',
          'Sec-Fetch-Site': 'same-origin',
          ...(input === null ? {} : { 'X-AgentLink-Input': input }),
          ...(o.presence === undefined ? {} : { 'X-AgentLink-Presence': o.presence }),
          ...(o.ceremony === undefined ? {} : { 'X-AgentLink-Ceremony': o.ceremony }),
          ...o.headers,
        },
        body,
      });
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(res.body) as Record<string, unknown>;
      } catch {
        // not JSON
      }
      return { status: res.status, json };
    };
  };
  const post = await session();
  return { world, server, events, applied, source, post, otherSession: session };
}

interface Passkey {
  readonly auth: VirtualPrfAuthenticator;
  /** The pre-fix body: credential ID, authenticator data, user handle, PRF output; no challenge. */
  bare(): Uint8Array;
}

async function withPasskey(world: OwnerWorld, signing = true): Promise<Passkey> {
  const salt = ownerPrfSalt();
  const auth = new VirtualPrfAuthenticator(
    signing ? { credential: newWebauthnTestCredential() } : {},
  );
  await registerOwnerPasskey(
    world.keychain,
    world.owner,
    encodeUtf8(world.code),
    auth.create(world.owner.ownerNostr, salt),
  );
  return { auth, bare: () => encodePasskeyAssertion(auth.get(salt)) };
}

/** What the page does: asks the route for a ceremony, then one gesture that answers its challenge. */
async function ceremonyGesture(
  h: Harness,
  key: Passkey,
  path: string,
  options: {
    post?: Post;
    input?: string | null;
    headers?: Record<string, string>;
    /** Changes the clientDataJSON after the authenticator signed it. */
    tamper?: boolean;
  } = {},
): Promise<{ ceremony: string; body: Uint8Array; challenge: Answer }> {
  const post = options.post ?? h.post;
  const challenge = await post(path, new Uint8Array(0), {
    presence: 'challenge',
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  const publicKey = (challenge.json['publicKey'] ?? {}) as Record<string, unknown>;
  const got = key.auth.get(ownerPrfSalt());
  const clientDataJSON = encodeUtf8(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: String(publicKey['challenge'] ?? ''),
      origin: h.server.origin,
      crossOrigin: false,
    }),
  );
  const signature = key.auth.sign(got.authenticatorData, clientDataJSON);
  const sent = options.tamper === true ? encodeUtf8(JSON.stringify({ type: 'x' })) : clientDataJSON;
  return {
    ceremony: String(challenge.json['ceremony'] ?? ''),
    challenge,
    body: encodePayConfirmAssertion({
      credentialId: got.credentialId,
      authenticatorData: got.authenticatorData,
      clientDataJSON: sent,
      signature,
      userHandle: got.userHandle,
      prfOutput: got.prfOutput,
    }),
  };
}

const withCeremony = (ceremony: string, input?: string | null): RequestOptions => ({
  presence: 'passkey',
  ceremony,
  ...(input === undefined ? {} : { input }),
});

describe('a passkey proof without a server challenge is refused (R1-SEC-01)', () => {
  it('Test Touch ID: the bare assertion body is presence_required', async () => {
    const h = await harness();
    const key = await withPasskey(h.world);
    const res = await h.post(TEST, key.bare(), { presence: 'passkey' });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ status: 'presence_required' });
  });

  it('Replace master code: the bare assertion stages nothing', async () => {
    const h = await harness();
    const key = await withPasskey(h.world);
    const res = await h.post(REPLACE, key.bare(), { presence: 'passkey' });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ status: 'presence_required' });
    expect(await h.world.keychain.get(OWNER_NEXT_ACCOUNT)).toBeNull();
  });

  it('an owner route: the bare assertion signs nothing', async () => {
    const h = await harness();
    const key = await withPasskey(h.world);
    const res = await h.post(RULES, key.bare(), { presence: 'passkey' });
    expect(res.status).toBe(403);
    expect(h.applied).toEqual([]);
  });
});

describe('the ceremony: issued by the route, used once (R1-SEC-01)', () => {
  it('the challenge answer carries a ceremony and the WebAuthn request values, nothing else', async () => {
    const h = await harness();
    const key = await withPasskey(h.world);
    const { challenge } = await ceremonyGesture(h, key, TEST);
    expect(challenge.status).toBe(200);
    expect(challenge.json['status']).toBe('ready');
    expect(challenge.json['ceremony']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const publicKey = challenge.json['publicKey'] as Record<string, unknown>;
    expect(publicKey['rpId']).toBe('localhost');
    expect(publicKey['userVerification']).toBe('required');
    expect(publicKey['challenge']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(publicKey['allowCredentials']).toEqual([encodeBase64url(key.auth.credentialId)]);
    expect(publicKey['prfSalt']).toBe(encodeBase64url(ownerPrfSalt()));
    // Asking for a ceremony is not an owner operation: nothing counted, nothing unlocked.
    expect(h.events.filter((e) => e.kind === 'owner_operation')).toEqual([]);
  });

  it('a fresh gesture for this route works once; the same body again is refused', async () => {
    const h = await harness();
    const key = await withPasskey(h.world);
    const g = await ceremonyGesture(h, key, TEST);
    const first = await h.post(TEST, g.body.slice(), withCeremony(g.ceremony));
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ status: 'done' });
    const replay = await h.post(TEST, g.body.slice(), withCeremony(g.ceremony));
    expect(replay.status).toBe(403);
    expect(replay.json).toEqual({ status: 'presence_required' });
  });

  it('Replace master code with a fresh gesture stages a new code; the replayed body does not', async () => {
    const h = await harness();
    const key = await withPasskey(h.world);
    const g = await ceremonyGesture(h, key, REPLACE);
    const first = await h.post(REPLACE, g.body.slice(), withCeremony(g.ceremony));
    expect(first.status).toBe(200);
    expect(first.json['status']).toBe('staged');
    await h.post('/api/ui/owner-code/replace/cancel', new Uint8Array(0));
    const replay = await h.post(REPLACE, g.body.slice(), withCeremony(g.ceremony));
    expect(replay.status).toBe(403);
    expect(await h.world.keychain.get(OWNER_NEXT_ACCOUNT)).toBeNull();
  });

  it('a ceremony asked for one route is refused on another, and is spent', async () => {
    const h = await harness();
    const key = await withPasskey(h.world);
    const g = await ceremonyGesture(h, key, TEST);
    const other = await h.post(REPLACE, g.body.slice(), withCeremony(g.ceremony));
    expect(other.status).toBe(403);
    expect(await h.world.keychain.get(OWNER_NEXT_ACCOUNT)).toBeNull();
    const back = await h.post(TEST, g.body.slice(), withCeremony(g.ceremony));
    expect(back.status).toBe(403);
  });

  it('a ceremony asked for one input is refused with another input', async () => {
    const h = await harness();
    const key = await withPasskey(h.world);
    const asked = encodeBase64url(encodeUtf8('{"a":1}'));
    const g = await ceremonyGesture(h, key, TEST, { input: asked });
    const res = await h.post(TEST, g.body.slice(), withCeremony(g.ceremony, EMPTY_INPUT));
    expect(res.status).toBe(403);
  });

  it("another page session can't use the ceremony", async () => {
    const h = await harness();
    const key = await withPasskey(h.world);
    const g = await ceremonyGesture(h, key, TEST);
    const other = await h.otherSession();
    const res = await other(TEST, g.body.slice(), withCeremony(g.ceremony));
    expect(res.status).toBe(403);
    // Not spent by the other session: the page that asked can still use it.
    const own = await h.post(TEST, g.body.slice(), withCeremony(g.ceremony));
    expect(own.status).toBe(200);
  });

  it('an unknown ceremony is refused', async () => {
    const h = await harness();
    const key = await withPasskey(h.world);
    const g = await ceremonyGesture(h, key, TEST);
    const res = await h.post(TEST, g.body.slice(), withCeremony(encodeBase64url(randomBytes(16))));
    expect(res.status).toBe(403);
  });

  it('an assertion whose signed data was changed is presence_rejected (counted)', async () => {
    const h = await harness();
    const key = await withPasskey(h.world);
    const g = await ceremonyGesture(h, key, TEST, { tamper: true });
    const res = await h.post(TEST, g.body, withCeremony(g.ceremony));
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ status: 'presence_rejected' });
  });

  it('a passkey with no kept credential key: the passkey path answers passkey_update_needed', async () => {
    const h = await harness();
    const key = await withPasskey(h.world, false);
    expect(await h.world.keychain.get(OWNER_PASSKEY_KEY_ACCOUNT)).toBeNull();
    const challenge = await h.post(TEST, new Uint8Array(0), { presence: 'challenge' });
    expect(challenge.status).toBe(409);
    expect(challenge.json).toEqual({ status: 'passkey_update_needed' });
    expect(key.auth.gestures).toBe(1);
  });

  it('a challenge request with a body is refused', async () => {
    const h = await harness();
    await withPasskey(h.world);
    const res = await h.post(TEST, encodeUtf8('x'), { presence: 'challenge' });
    expect(res.status).toBe(400);
  });

  it('the master code is unchanged and needs no ceremony', async () => {
    const h = await harness();
    await withPasskey(h.world);
    const res = await h.post(REPLACE, encodeUtf8(h.world.code));
    expect(res.status).toBe(200);
    expect(res.json['status']).toBe('staged');
  });

  it('nothing of the ceremony reaches an event', async () => {
    const h = await harness();
    const key = await withPasskey(h.world);
    const g = await ceremonyGesture(h, key, TEST);
    await h.post(TEST, g.body.slice(), withCeremony(g.ceremony));
    const publicKey = g.challenge.json['publicKey'] as Record<string, unknown>;
    const text = JSON.stringify(h.events);
    expect(text).not.toContain(g.ceremony);
    expect(text).not.toContain(String(publicKey['challenge']));
  });
});

describe('approval decisions take the same ceremony (R1-SEC-01)', () => {
  const decideHarness = async (): Promise<Harness & { fake: FakeSource }> => {
    let fake: FakeSource | undefined;
    const h = await harness({
      source: (world) => {
        fake = fakeSource(world);
        return fake;
      },
    });
    return { ...h, fake: fake as FakeSource };
  };

  it('a bare assertion is refused; a ceremony for this approval and digest approves it once', async () => {
    const h = await decideHarness();
    const key = await withPasskey(h.world);
    const one = h.fake.add(1);
    const two = h.fake.add(2);
    const path1 = `/api/approvals/${one.approvalId}/approve`;
    const path2 = `/api/approvals/${two.approvalId}/approve`;
    const digest1 = { 'X-AgentLink-Digest': one.actionDigest };
    const digest2 = { 'X-AgentLink-Digest': two.actionDigest };
    const bare = await h.post(path1, key.bare(), {
      presence: 'passkey',
      input: null,
      headers: digest1,
    });
    expect(bare.status).toBe(403);
    expect(h.fake.pending(1)).toBe(true);

    const g = await ceremonyGesture(h, key, path1, { input: null, headers: digest1 });
    // The ceremony of approval 1 can't approve approval 2.
    const wrong = await h.post(path2, g.body.slice(), {
      ...withCeremony(g.ceremony, null),
      headers: digest2,
    });
    expect(wrong.status).toBe(403);
    expect(h.fake.pending(2)).toBe(true);

    const g2 = await ceremonyGesture(h, key, path1, { input: null, headers: digest1 });
    const ok = await h.post(path1, g2.body.slice(), {
      ...withCeremony(g2.ceremony, null),
      headers: digest1,
    });
    expect(ok.status).toBe(200);
    expect(h.fake.pending(1)).toBe(false);
    expect(h.fake.pending(2)).toBe(true);
  });
});
