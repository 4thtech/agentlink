// M1-11c-a3: the Files page's API (08 §1; 04 §2.5, §4; 06 §3; D-99, D-118, D-119; I-4, I-5, I-7).
//
// - `GET /api/ui/files`: the allowed folders through core `files.resolvedFolders()`, display paths
//   only (never a file, a key or an error's text).
// - `GET /api/ui/files/review?add=<path>` or `?remove=<path>`: the 04 §4 folder checks on the path the
//   owner typed (realpath, links followed and shown, never a protected, hidden or too broad folder,
//   D-99), then core `preparePolicyEdit` builds the unsigned `policy.set`. The server keeps that body
//   and answers the folder that will be signed, every warning code and an opaque review token (the
//   body's hash). Nothing is signed and nothing changes.
// - `POST /api/ui/files/folders` (`presence: true`): signs exactly the kept body, once, and only when
//   the owner acknowledged every warning code returned for THAT body (D-119). The acknowledgement is
//   bound to the body hash: a missing, extra or foreign code, an unknown, used or expired review, or
//   a folder that changed since the review is refused before `sign` is ever called.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import {
  canonicalize,
  encodeBase64url,
  encodeUtf8,
  sha256,
  type JsonObject,
} from '@4thtech-io/crypto';
import type {
  OwnerActionOutcome,
  PolicyEditWarning,
  PreparedPolicyEdit,
  ResolvedFolders,
} from '@4thtech-io/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { OwnerReview, OwnerSignRequest, OwnerSignature } from '../../owner-operation.js';
import { readOnlyClient, type LocalUiContext, type LocalUiReadClient } from '../context.js';
import {
  UI_INVALID_QUERY,
  UI_NOT_SET_UP,
  UI_UNAVAILABLE,
  type LocalUiOwnerOperation,
  type LocalUiOwnerRoute,
  type LocalUiReadRoute,
  type LocalUiRequest,
  type LocalUiResult,
} from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import { createFilesRoutes, filesRoutes } from './files.js';

// The routes pick the path flavour from the platform; the tests build real paths with node:path, so
// they must run with the same flavour (a Windows path is never a posix full path).
const WIN = process.platform === 'win32';
const FLAVOR = WIN ? 'win32' : 'posix';
const sepOut = (p: string): string => (WIN ? p.replace(/\//g, '\\') : p);
// `.native` like the production `fs.promises.realpath`: on Windows it expands 8.3 short names
// (RUNNER~1), which the JS `realpathSync` keeps, so the two would name the same folder differently.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agentlink-m1-11c-a3-')));
const home = join(root, 'home');
const docs = join(home, 'Documents');
const shared = join(docs, 'Shared');
const work = join(home, 'Work');
const outside = join(root, 'elsewhere');
afterAll(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(shared, { recursive: true });
mkdirSync(work, { recursive: true });
mkdirSync(outside, { recursive: true });
mkdirSync(join(home, '.ssh'), { recursive: true });
mkdirSync(join(home, '.config', 'thing'), { recursive: true });
// A protected folder below the home folder, per platform (04 §4: macOS Keychains, Windows DPAPI).
const PROTECTED_TOP = WIN ? 'AppData' : 'Library';
const PROTECTED_TAIL = WIN ? ['Roaming', 'Microsoft', 'Protect'] : ['Keychains'];
mkdirSync(join(home, PROTECTED_TOP, ...PROTECTED_TAIL), { recursive: true });
writeFileSync(join(docs, 'note.txt'), 'x');
symlinkSync(outside, join(home, 'Linked'));
symlinkSync(join(home, '.ssh'), join(home, 'Keys'));

const AGENT = '0x71c4000000000000000000000000000000009a2e';
const OWNER_HEX = 'ab'.repeat(32);
const NONCE_MARK = 'nonce-leak-marker-0001';

let nonceCounter = 0;
function bodyFor(folders: readonly string[]): JsonObject {
  nonceCounter += 1;
  return {
    v: 2,
    agent: AGENT,
    owner: OWNER_HEX,
    op: 'policy.set',
    params: { version: 4, policy: { files: { allowedFolders: [...folders] } } },
    nonce: `${NONCE_MARK}-${String(nonceCounter)}`,
    issuedAt: 1_000,
    expiresAt: 1_600,
  } as unknown as JsonObject;
}

const hashOf = (jcs: string): string => encodeBase64url(sha256(encodeUtf8(jcs)));

const ADDED: PolicyEditWarning = {
  code: 'allowed_folders_added',
  fields: ['files.allowedFolders'],
};

interface Fake {
  configured: string[];
  resolved: string[] | 'throw';
  warnings: PolicyEditWarning[];
  refusal?: 'policy_not_valid' | 'patch_invalid' | 'identity_missing' | 'stale_version' | undefined;
  base: number;
  askKeep: boolean;
  prepareThrows: boolean;
  patches: unknown[];
  applied: { body: JsonObject; sig: string }[];
  outcome: OwnerActionOutcome;
}

let fake: Fake;
beforeEach(() => {
  fake = {
    configured: [work],
    resolved: [work],
    warnings: [ADDED],
    askKeep: false,
    base: 3,
    prepareThrows: false,
    patches: [],
    applied: [],
    outcome: { status: 'applied', op: 'policy.set', policyVersion: 4, markRaised: true },
  };
});

function fakeClient(): LocalUiReadClient {
  return {
    agentId: AGENT,
    getProof: () => Promise.reject(new Error('not used')),
    files: {
      resolvedFolders: (): Promise<ResolvedFolders> =>
        fake.resolved === 'throw'
          ? Promise.reject(new Error(`store error at ${root}`))
          : Promise.resolve({ configured: [...fake.configured], resolved: [...fake.resolved] }),
      preparePolicyEdit: (
        patch: unknown,
        options?: { baseVersion?: number },
      ): Promise<PreparedPolicyEdit> => {
        fake.patches.push(patch);
        if (fake.prepareThrows) return Promise.reject(new Error(`boom ${root}`));
        if (fake.refusal !== undefined) {
          return Promise.resolve({ status: 'refused', op: 'policy.set', reason: fake.refusal });
        }
        // core: an edit built on another version than the one in force is refused.
        if (options?.baseVersion !== undefined && options.baseVersion !== fake.base) {
          return Promise.resolve({ status: 'refused', op: 'policy.set', reason: 'stale_version' });
        }
        const folders =
          (patch as { files?: { allowedFolders: string[] } }).files?.allowedFolders ?? [];
        const body = bodyFor(folders);
        return Promise.resolve({
          status: 'prepared',
          op: 'policy.set',
          body,
          jcs: canonicalize(body),
          version: 4,
          baseVersion: fake.base,
          askKeepDeliveryReceipts: fake.askKeep,
          keepDeliveryReceipts: false,
          warnings: fake.warnings.map((w) => ({ ...w })),
        } as unknown as PreparedPolicyEdit);
      },
    },
  } as unknown as LocalUiReadClient;
}

function ctx(client: LocalUiReadClient | null = fakeClient(), now = 1_100_000): LocalUiContext {
  return {
    client: client ?? undefined,
    ownerContext: () => Promise.reject(new Error('not used')),
    applyOwnerAction: (signed) => {
      fake.applied.push(signed as { body: JsonObject; sig: string });
      return Promise.resolve(fake.outcome);
    },
    now: () => now,
  };
}

interface SignCall {
  readonly review: OwnerReview;
  readonly requests: readonly OwnerSignRequest[];
}

function owner(calls: SignCall[]): LocalUiOwnerOperation {
  return {
    sign: (review, requests) => {
      calls.push({ review, requests });
      const out: OwnerSignature[] = requests.map((r) => {
        if (r.kind !== 'owner-action') throw new Error('unexpected');
        return { kind: 'owner-action', signed: { body: r.action, sig: 'sig-1' } };
      });
      return Promise.resolve(out);
    },
  };
}

function read(routes: ReturnType<typeof createFilesRoutes>, path: string): LocalUiReadRoute {
  const found = routes.find((r) => r.path === path && !r.presence);
  if (found === undefined || found.presence) throw new Error(`no read route ${path}`);
  return found;
}

function write(routes: ReturnType<typeof createFilesRoutes>): LocalUiOwnerRoute {
  const found = routes.find((r) => r.presence === true);
  if (found === undefined || found.presence !== true) throw new Error('no owner route');
  return found;
}

const req = (query = ''): LocalUiRequest => ({ params: {}, query: new URLSearchParams(query) });
const q = (key: 'add' | 'remove', value: string, version = 3): string =>
  new URLSearchParams({ [key]: value, version: String(version) }).toString();

function setup(now?: number) {
  const routes = createFilesRoutes({ home, flavor: FLAVOR });
  const context = ctx(fakeClient(), now);
  const review = (query: string) =>
    read(routes, '/api/ui/files/review').handler(context, req(query));
  const commit = (input: unknown, calls: SignCall[] = []) =>
    write(routes).handler(
      context,
      { params: {}, query: new URLSearchParams(), input: input as never },
      owner(calls),
    );
  return { routes, context, review, commit };
}

const body = (r: LocalUiResult): Record<string, unknown> => r.body as Record<string, unknown>;

/** Never an error's text, a nonce, the owner key or the body itself in an answer. */
function expectNoLeak(result: LocalUiResult): void {
  const text = JSON.stringify(result.body);
  for (const marker of [NONCE_MARK, OWNER_HEX, 'boom', 'store error', 'policy.set', 'sig-1']) {
    expect(text, marker).not.toContain(marker);
  }
}

describe('routes (M1-11c-a3)', () => {
  it('declares two reads and one owner operation behind the presence gate', () => {
    expect(filesRoutes.map((r) => [r.method, r.path, r.presence])).toEqual([
      ['GET', '/api/ui/files', false],
      ['GET', '/api/ui/files/review', false],
      ['POST', '/api/ui/files/folders', true],
    ]);
    expect(Object.isFrozen(filesRoutes)).toBe(true);
  });

  it('is in the default registry', () => {
    const registry = createLocalUiRoutes();
    for (const [method, path] of [
      ['GET', '/api/ui/files'],
      ['GET', '/api/ui/files/review'],
      ['POST', '/api/ui/files/folders'],
    ] as const) {
      const hit = registry.match(method, path);
      expect(hit !== undefined && hit !== 'method' && hit.route.path).toBe(path);
    }
    expect(registry.match('GET', '/api/ui/files/folders')).toBe('method');
  });

  it('the read-only client view gives files only its two inert calls', () => {
    const calls: string[] = [];
    const full = {
      agentId: AGENT,
      getProof: () => Promise.resolve(undefined),
      files: {
        resolvedFolders: () => {
          calls.push('resolved');
          return Promise.resolve({ configured: [], resolved: [] });
        },
      },
      ownerActions: {
        preparePolicyEdit: () => {
          calls.push('prepare');
          return Promise.resolve({ status: 'refused', op: 'policy.set', reason: 'patch_invalid' });
        },
        apply: () => Promise.reject(new Error('never')),
        recordReceiptsKept: () => Promise.reject(new Error('never')),
      },
    };
    const view = readOnlyClient(full as never);
    expect(Object.isFrozen(view.files)).toBe(true);
    expect(Object.keys(view.files).sort()).toEqual(['preparePolicyEdit', 'resolvedFolders']);
    expect((view as unknown as Record<string, unknown>)['ownerActions']).toBeUndefined();
    void view.files.resolvedFolders();
    void view.files.preparePolicyEdit({});
    expect(calls).toEqual(['resolved', 'prepare']);
  });
});

describe('GET /api/ui/files: the allowed folders', () => {
  it('answers each configured folder with its realpath when core resolved it', async () => {
    fake.configured = [work, '~/Linked', join(home, 'Gone')];
    fake.resolved = [work, outside];
    const { routes, context } = setup();
    const res = await read(routes, '/api/ui/files').handler(context, req());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      folders: [
        { path: work, resolved: work },
        { path: '~/Linked', resolved: outside },
        { path: join(home, 'Gone'), resolved: null },
      ],
      max: 32,
      version: 3,
    });
  });

  it('is 409 not_set_up without an agent, 503 when core fails, 400 for any query', async () => {
    const routes = createFilesRoutes({ home, flavor: FLAVOR });
    const list = read(routes, '/api/ui/files');
    expect(await list.handler(ctx(null), req())).toEqual(UI_NOT_SET_UP);
    fake.resolved = 'throw';
    const failed = await list.handler(ctx(), req());
    expect(failed).toEqual(UI_UNAVAILABLE);
    expectNoLeak(failed);
    expect(await list.handler(ctx(), req('x=1'))).toEqual(UI_INVALID_QUERY);
  });
});

describe('GET /api/ui/files/review: the 04 §4 checks before anything is prepared', () => {
  it('accepts exactly one of add or remove, once', async () => {
    const { review } = setup();
    for (const query of [
      '',
      'version=3',
      `add=${encodeURIComponent(shared)}`,
      'add=a&add=b&version=3',
      `add=${encodeURIComponent(shared)}&remove=${encodeURIComponent(work)}&version=3`,
      'folder=x&version=3',
      `add=${encodeURIComponent(shared)}&x=1`,
      `add=${encodeURIComponent(shared)}&version=3&version=3`,
      `add=${encodeURIComponent(shared)}&version=-1`,
      `add=${encodeURIComponent(shared)}&version=03`,
      `add=${encodeURIComponent(shared)}&version=1.5`,
      `add=${'a'.repeat(4097)}&version=3`,
    ]) {
      expect(await review(query), query).toEqual(UI_INVALID_QUERY);
    }
    expect(fake.patches).toEqual([]);
  });

  it.each([
    ['relative', 'Documents/Shared', 'not_full_path'],
    ['a ~user form', '~other/Shared', 'not_full_path'],
    ['dot segments', `${docs}/../Documents/Shared`, 'dot_segments'],
    ['missing', join(home, 'Nope'), 'missing'],
    ['a file', join(docs, 'note.txt'), 'not_folder'],
    ['the root', parse(root).root, 'too_broad'],
    ['the home folder', '~', 'too_broad'],
    ['above the home folder', root, 'too_broad'],
    ['inside ~/.ssh', join(home, '.ssh'), 'protected'],
    ['a link into ~/.ssh', join(home, 'Keys'), 'protected'],
    ['hidden', join(home, '.config', 'thing'), 'hidden'],
    ['a control character', `${shared}\u0007`, 'not_showable'],
    ['a bidi override', `${docs}/‮Shared`, 'not_showable'],
  ])('refuses %s before preparing anything', async (_what, path, reason) => {
    const { review } = setup();
    const res = await review(q('add', path));
    expect(res).toEqual({ status: 422, body: { error: 'folder_refused', reason } });
    expect(fake.patches).toEqual([]);
  });

  it('D-99: refuses a folder that contains a protected folder and names it', async () => {
    const { review } = setup();
    const res = await review(q('add', join(home, PROTECTED_TOP)));
    expect(res).toEqual({
      status: 422,
      body: {
        error: 'folder_refused',
        reason: 'contains_protected',
        // Windows paths are parsed case-folded (path-guard), so the folder is named in lower case there.
        protectedFolder: WIN
          ? sepOut(['~', PROTECTED_TOP, ...PROTECTED_TAIL].join('/')).toLowerCase()
          : ['~', PROTECTED_TOP, ...PROTECTED_TAIL].join('/'),
      },
    });
    expect(fake.patches).toEqual([]);
  });

  it('refuses a folder already allowed, and a 33rd folder', async () => {
    const { review } = setup();
    expect(await review(q('add', work))).toEqual({
      status: 422,
      body: { error: 'folder_refused', reason: 'already_allowed' },
    });
    fake.configured = Array.from({ length: 32 }, (_, i) => `/f/${String(i)}`);
    expect(await review(q('add', shared))).toEqual({
      status: 422,
      body: { error: 'folder_refused', reason: 'too_many' },
    });
    expect(fake.patches).toEqual([]);
  });

  it('adds the realpath, shows it, and returns every warning code and a review token', async () => {
    const { review } = setup();
    const res = await review(q('add', '~/Documents/Shared/'));
    expect(fake.patches).toEqual([{ files: { allowedFolders: [work, shared] } }]);
    expect(res.status).toBe(200);
    const b = body(res);
    expect(b['change']).toBe('add');
    expect(b['folder']).toBe(shared);
    expect(b['typed']).toBe('~/Documents/Shared/');
    expect(b['elsewhere']).toBe(false);
    expect(b['warnings']).toEqual(['allowed_folders_added']);
    expect(b['expiresAt']).toBe(1_600);
    expect(b['review']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(b).sort()).toEqual(
      ['change', 'elsewhere', 'expiresAt', 'folder', 'review', 'typed', 'warnings'].sort(),
    );
    expectNoLeak(res);
  });

  it('follows a link to the real folder and says the folder is elsewhere', async () => {
    const { review } = setup();
    const res = await review(q('add', join(home, 'Linked')));
    expect(res.status).toBe(200);
    expect(body(res)['folder']).toBe(outside);
    expect(body(res)['elsewhere']).toBe(true);
    expect(fake.patches).toEqual([{ files: { allowedFolders: [work, outside] } }]);
  });

  it('removes a configured entry exactly as written', async () => {
    fake.configured = [work, '~/Linked'];
    fake.warnings = [];
    const { review } = setup();
    const res = await review(q('remove', '~/Linked'));
    expect(res.status).toBe(200);
    expect(fake.patches).toEqual([{ files: { allowedFolders: [work] } }]);
    expect(body(res)['change']).toBe('remove');
    expect(body(res)['folder']).toBe('~/Linked');
    expect(body(res)['warnings']).toEqual([]);
    expect(await review(q('remove', shared))).toEqual({
      status: 422,
      body: { error: 'folder_refused', reason: 'not_allowed' },
    });
  });

  it('L-1: passes the listed version as baseVersion, so a concurrent edit is stale, not undone', async () => {
    const { routes, context, review } = setup();
    const listed = await read(routes, '/api/ui/files').handler(context, req());
    expect(body(listed)['version']).toBe(3);
    // Another surface applied version 4 after the page listed version 3.
    fake.base = 4;
    expect(await review(q('add', shared, 3))).toEqual({ status: 409, body: { error: 'stale' } });
    expect(fake.patches.at(-1)).toEqual({ files: { allowedFolders: [work, shared] } });
    // Nothing was kept: the stale review has no token to sign.
    const fresh = await review(q('add', shared, 4));
    expect(fresh.status).toBe(200);
  });

  it('L-3: refuses a remove target with an unsafe character before anything is prepared', async () => {
    const bidi = `${docs}/\u202eShared`;
    fake.configured = [work, bidi];
    const { review } = setup();
    for (const path of [bidi, `${work}\u0007`, `${work}\u200b`]) {
      expect(await review(q('remove', path))).toEqual({
        status: 422,
        body: { error: 'folder_refused', reason: 'not_showable' },
      });
    }
    expect(fake.patches).toEqual([]);
  });

  it('maps a core refusal or failure to a fixed answer', async () => {
    const { review } = setup();
    fake.refusal = 'policy_not_valid';
    expect(await review(q('add', shared))).toEqual({
      status: 409,
      body: { error: 'rules_unreadable' },
    });
    fake.refusal = 'identity_missing';
    expect(await review(q('add', shared))).toEqual(UI_NOT_SET_UP);
    fake.refusal = 'stale_version';
    expect(await review(q('add', shared))).toEqual({ status: 409, body: { error: 'stale' } });
    fake.refusal = undefined;
    fake.prepareThrows = true;
    const failed = await review(q('add', shared));
    expect(failed).toEqual(UI_UNAVAILABLE);
    expectNoLeak(failed);
  });

  it('never signs delivery receipts off behind a folder edit (D-109): it asks for Rules', async () => {
    fake.askKeep = true;
    const { review, commit } = setup();
    const res = await review(q('add', shared));
    expect(res).toEqual({ status: 409, body: { error: 'receipts_question' } });
    const calls: SignCall[] = [];
    // Nothing was kept, so there is nothing to sign.
    await commit({ review: 'A'.repeat(43), acknowledged: [] }, calls);
    expect(calls).toEqual([]);
  });

  it('is 409 not_set_up without an agent', async () => {
    const routes = createFilesRoutes({ home, flavor: FLAVOR });
    expect(
      await read(routes, '/api/ui/files/review').handler(ctx(null), req(q('add', shared))),
    ).toEqual(UI_NOT_SET_UP);
  });
});

describe('POST /api/ui/files/folders: D-119, every warning acknowledged for this exact body', () => {
  async function reviewed(s: ReturnType<typeof setup>, query = q('add', shared)) {
    const res = await s.review(query);
    expect(res.status).toBe(200);
    return body(res) as { review: string; warnings: string[]; folder: string };
  }

  it('signs exactly the kept body once, applies it and answers applied', async () => {
    const s = setup();
    const r = await reviewed(s);
    const calls: SignCall[] = [];
    const res = await s.commit(
      { review: r.review, acknowledged: ['allowed_folders_added'] },
      calls,
    );
    expect(res).toEqual({ status: 200, body: { status: 'applied', confirmed: true } });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.requests).toHaveLength(1);
    const request = call?.requests[0];
    expect(request?.kind).toBe('owner-action');
    const action = request?.kind === 'owner-action' ? request.action : undefined;
    expect(hashOf(canonicalize(action as JsonObject))).toBe(r.review);
    expect(call?.review.lines.join('\n')).toContain(shared);
    expect(fake.applied).toEqual([{ body: action, sig: 'sig-1' }]);
  });

  it('refuses a missing acknowledgement without signing (the D-119 acceptance test)', async () => {
    const s = setup();
    fake.warnings = [ADDED, { code: 'limits_raised', fields: ['files.maxSendSizeMB'] }];
    const r = await reviewed(s);
    expect(r.warnings).toEqual(['allowed_folders_added', 'limits_raised']);
    const calls: SignCall[] = [];
    const res = await s.commit(
      { review: r.review, acknowledged: ['allowed_folders_added'] },
      calls,
    );
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'not_acknowledged' });
    expect(calls).toEqual([]);
    expect(fake.applied).toEqual([]);
  });

  it('refuses an acknowledgement with an extra, repeated or unknown code', async () => {
    const s = setup();
    for (const acknowledged of [
      ['allowed_folders_added', 'limits_raised'],
      ['allowed_folders_added', 'allowed_folders_added'],
      ['allowed_folders_added', 'not_a_code'],
      [],
    ]) {
      const r = await reviewed(s);
      const calls: SignCall[] = [];
      const res = await s.commit({ review: r.review, acknowledged }, calls);
      expect(res.status, JSON.stringify(acknowledged)).toBeGreaterThanOrEqual(400);
      expect(calls).toEqual([]);
    }
    expect(fake.applied).toEqual([]);
  });

  it('binds the acknowledgement to the body hash: no replay onto another edit', async () => {
    const s = setup();
    const add = await reviewed(s);
    fake.configured = [work];
    fake.warnings = [];
    const remove = await reviewed(s, q('remove', work));
    const calls: SignCall[] = [];
    // The add's acknowledgement sent with the remove's token: the codes don't match that body.
    expect(
      (await s.commit({ review: remove.review, acknowledged: add.warnings }, calls)).status,
    ).toBe(409);
    // An unknown token (a hash of another body) is refused.
    const other = hashOf(canonicalize(bodyFor([shared])));
    expect((await s.commit({ review: other, acknowledged: add.warnings }, calls)).status).toBe(409);
    expect(calls).toEqual([]);
    // Each token is used once, whatever the outcome.
    expect((await s.commit({ review: add.review, acknowledged: add.warnings }, calls)).status).toBe(
      200,
    );
    expect((await s.commit({ review: add.review, acknowledged: add.warnings }, calls)).status).toBe(
      409,
    );
    expect((await s.commit({ review: remove.review, acknowledged: [] }, calls)).status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it('keeps reviews per server (context), never shared', async () => {
    const routes = createFilesRoutes({ home, flavor: FLAVOR });
    const a = ctx();
    const b = ctx();
    const res = await read(routes, '/api/ui/files/review').handler(a, req(q('add', shared)));
    const token = body(res)['review'];
    const calls: SignCall[] = [];
    const other = await write(routes).handler(
      b,
      {
        params: {},
        query: new URLSearchParams(),
        input: { review: token, acknowledged: ['allowed_folders_added'] } as never,
      },
      owner(calls),
    );
    expect(other.status).toBe(409);
    expect(calls).toEqual([]);
  });

  it('refuses an expired review', async () => {
    const routes = createFilesRoutes({ home, flavor: FLAVOR });
    let now = 1_100_000;
    const context: LocalUiContext = { ...ctx(), now: () => now };
    const res = await read(routes, '/api/ui/files/review').handler(context, req(q('add', shared)));
    now = 1_600_000;
    const calls: SignCall[] = [];
    const late = await write(routes).handler(
      context,
      {
        params: {},
        query: new URLSearchParams(),
        input: { review: body(res)['review'], acknowledged: ['allowed_folders_added'] } as never,
      },
      owner(calls),
    );
    expect(late).toEqual({ status: 409, body: { error: 'expired' } });
    expect(calls).toEqual([]);
  });

  it('checks the folder again before signing: a folder swapped for a link is refused', async () => {
    const swap = join(home, 'Swap');
    mkdirSync(swap);
    const s = setup();
    const r = await reviewed(s, q('add', swap));
    rmSync(swap, { recursive: true });
    symlinkSync(join(home, '.ssh'), swap);
    const calls: SignCall[] = [];
    const res = await s.commit({ review: r.review, acknowledged: r.warnings }, calls);
    expect(res).toEqual({ status: 409, body: { error: 'folder_changed' } });
    expect(calls).toEqual([]);
  });

  it('refuses malformed input without signing', async () => {
    const s = setup();
    const r = await reviewed(s);
    for (const input of [
      undefined,
      null,
      'x',
      [],
      { review: r.review },
      { acknowledged: [] },
      { review: r.review, acknowledged: 'allowed_folders_added' },
      { review: r.review, acknowledged: [], extra: 1 },
      { review: 'short', acknowledged: [] },
      { review: r.review, acknowledged: Array.from({ length: 40 }, () => 'limits_raised') },
    ]) {
      const calls: SignCall[] = [];
      const res = await s.commit(input, calls);
      expect(res, JSON.stringify(input)).toEqual({ status: 400, body: { error: 'invalid' } });
      expect(calls).toEqual([]);
    }
    // The review is still usable after malformed attempts that never named it validly.
    const calls: SignCall[] = [];
    expect((await s.commit({ review: r.review, acknowledged: r.warnings }, calls)).status).toBe(
      200,
    );
  });

  it('maps a core refusal at apply to a fixed answer', async () => {
    const s = setup();
    const r = await reviewed(s);
    fake.outcome = {
      status: 'refused',
      op: 'policy.set',
      reason: 'version_not_newer',
      nonceBurnt: true,
    };
    const res = await s.commit({ review: r.review, acknowledged: r.warnings });
    expect(res).toEqual({ status: 409, body: { error: 'changed' } });
    const r2 = await reviewed(s);
    fake.outcome = { status: 'applied', op: 'policy.set', policyVersion: 4, markRaised: false };
    expect(await s.commit({ review: r2.review, acknowledged: r2.warnings })).toEqual({
      status: 200,
      body: { status: 'applied', confirmed: false },
    });
  });
});
