// FILES-FOLDER-PICKER (D-161; 04 §4.1 "The folder"; I-4, I-5): changing the Inbox folder. A picked
// or typed path grants nothing: the server checks it (realpath, not a link, not home or a root, not
// hidden or protected, owned, not shared-writable, not an OS folder, not a Send folder, writable),
// signs only behind the presence gate with every warning acknowledged, and checks it again first.
// Also: a Send folder can't be the Inbox, inside it or around it.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, type JsonObject } from '@4thtech-io/crypto';
import type { OwnerActionOutcome, PreparedPolicyEdit, ResolvedFolders } from '@4thtech-io/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { OwnerReview, OwnerSignRequest, OwnerSignature } from '../../owner-operation.js';
import type { LocalUiContext, LocalUiReadClient } from '../context.js';
import type {
  LocalUiOwnerOperation,
  LocalUiOwnerRoute,
  LocalUiReadRoute,
  LocalUiResult,
} from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import { createFilesRoutes } from './files.js';
import { INBOX_COMMIT_PATH, INBOX_REVIEW_PATH, createInboxRoutes } from './files-inbox.js';

const WIN = process.platform === 'win32';
const FLAVOR = WIN ? 'win32' : 'posix';
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agentlink-folder-picker-')));
const home = join(root, 'home');
const inbox = join(home, 'AgentLink', 'Inbox');
const send = join(home, 'AgentLink', 'Send');
const received = join(home, 'Documents', 'Received');
const outside = join(root, 'elsewhere');
const shared = join(home, 'Shared-open');
const readOnly = join(home, 'ReadOnly');
afterAll(() => {
  try {
    chmodSync(readOnly, 0o700);
  } catch {
    // gone
  }
  rmSync(root, { recursive: true, force: true });
});
for (const d of [inbox, send, received, outside, shared, readOnly, join(home, '.ssh')]) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
}
mkdirSync(join(send, 'Sub'), { recursive: true, mode: 0o700 });
if (!WIN) {
  chmodSync(shared, 0o777);
  chmodSync(readOnly, 0o500);
}
symlinkSync(outside, join(home, 'Shortcut'));

const AGENT = '0x71c4000000000000000000000000000000009a2e';

interface Fake {
  inboxFolder: string;
  configured: string[];
  patches: unknown[];
  applied: JsonObject[];
  outcome: OwnerActionOutcome;
}
let fake: Fake;
beforeEach(() => {
  fake = {
    inboxFolder: '~/AgentLink/Inbox',
    configured: [send],
    patches: [],
    applied: [],
    outcome: { status: 'applied', op: 'policy.set', policyVersion: 4, markRaised: true },
  };
});

let n = 0;
function client(): LocalUiReadClient {
  return {
    agentId: AGENT,
    policy: {
      load: () =>
        Promise.resolve({
          mode: 'verified',
          policy: { files: { inboxFolder: fake.inboxFolder, allowedFolders: fake.configured } },
        }),
    },
    files: {
      resolvedFolders: (): Promise<ResolvedFolders> =>
        Promise.resolve({ configured: [...fake.configured], resolved: [...fake.configured] }),
      preparePolicyEdit: (patch: unknown): Promise<PreparedPolicyEdit> => {
        fake.patches.push(patch);
        n += 1;
        const body = {
          v: 2,
          agent: AGENT,
          op: 'policy.set',
          params: { version: 4, policy: patch },
          nonce: `n-${String(n)}`,
          issuedAt: 1_000,
          expiresAt: 1_600,
        } as unknown as JsonObject;
        return Promise.resolve({
          status: 'prepared',
          op: 'policy.set',
          body,
          jcs: canonicalize(body),
          version: 4,
          baseVersion: 3,
          askKeepDeliveryReceipts: false,
          keepDeliveryReceipts: false,
          warnings: (patch as { files?: { inboxFolder?: string } }).files?.inboxFolder
            ? [{ code: 'folder_changed', fields: ['files.inboxFolder'] }]
            : [{ code: 'allowed_folders_added', fields: ['files.allowedFolders'] }],
        } as unknown as PreparedPolicyEdit);
      },
    },
  } as unknown as LocalUiReadClient;
}

function ctx(): LocalUiContext {
  return {
    client: client(),
    ownerContext: () => Promise.reject(new Error('not used')),
    applyOwnerAction: (signed) => {
      fake.applied.push((signed as { body: JsonObject }).body);
      return Promise.resolve(fake.outcome);
    },
    now: () => 1_100_000,
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
      return Promise.resolve(
        requests.map((r): OwnerSignature => {
          if (r.kind !== 'owner-action') throw new Error('unexpected');
          return { kind: 'owner-action', signed: { body: r.action, sig: 'sig' } };
        }),
      );
    },
  };
}

function setup() {
  const routes = createInboxRoutes({ home, flavor: FLAVOR });
  const context = ctx();
  const reviewRoute = routes.find((r) => r.path === INBOX_REVIEW_PATH) as LocalUiReadRoute;
  const commitRoute = routes.find((r) => r.path === INBOX_COMMIT_PATH) as LocalUiOwnerRoute;
  const review = (path: string, version = '3') =>
    reviewRoute.handler(context, {
      params: {},
      query: new URLSearchParams({ set: path, version }),
    });
  const commit = (input: unknown, calls: SignCall[] = []) =>
    commitRoute.handler(
      context,
      { params: {}, query: new URLSearchParams(), input: input as never },
      owner(calls),
    );
  return { routes, review, commit, context };
}

const body = (r: LocalUiResult): Record<string, unknown> => r.body as Record<string, unknown>;

describe('routes', () => {
  it('a read review and one owner operation behind the presence gate', () => {
    const { routes } = setup();
    expect(routes.map((r) => [r.method, r.path, r.presence])).toEqual([
      ['GET', '/api/ui/files/inbox/review', false],
      ['POST', '/api/ui/files/inbox', true],
    ]);
    const registry = createLocalUiRoutes();
    expect(registry.match('POST', '/api/ui/files/inbox')).toMatchObject({
      route: { presence: true },
    });
  });
});

describe('GET /api/ui/files/inbox/review: the picked path is checked, never trusted', () => {
  it('a good folder: the real folder, the folder_changed warning, nothing signed', async () => {
    const { review } = setup();
    const answer = await review(received);
    expect(answer.status).toBe(200);
    expect(body(answer)).toMatchObject({
      change: 'inbox',
      folder: received,
      typed: received,
      elsewhere: false,
      warnings: ['folder_changed'],
    });
    expect(fake.patches).toEqual([{ files: { inboxFolder: received } }]);
    expect(fake.applied).toHaveLength(0);
  });

  it.each([
    ['a link (a shortcut to another place)', () => join(home, 'Shortcut'), 'link'],
    ['the home folder', () => home, 'too_broad'],
    ['the filesystem root', () => (WIN ? 'C:\\' : '/'), 'too_broad'],
    ['a hidden or protected folder', () => join(home, '.ssh'), 'protected'],
    ['a Send folder', () => send, 'send_folder'],
    ['inside a Send folder', () => join(send, 'Sub'), 'send_folder'],
    ['around a Send folder', () => join(home, 'AgentLink'), 'send_folder'],
    ['the Inbox already', () => inbox, 'already_inbox'],
    ['a missing folder', () => join(home, 'Nope'), 'missing'],
    ['a relative path', () => 'Documents/Received', 'not_full_path'],
  ])('refuses %s', async (_name, path, reason) => {
    const { review } = setup();
    const answer = await review(path());
    expect(answer.status).toBe(422);
    expect(body(answer)).toEqual({ error: 'folder_refused', reason });
    expect(fake.patches).toHaveLength(0);
  });

  it.skipIf(WIN)(
    'refuses a folder others can write to, and one this user cannot write',
    async () => {
      const { review } = setup();
      expect(body(await review(shared))).toMatchObject({ reason: 'shared_writable' });
      expect(body(await review(readOnly))).toMatchObject({ reason: 'not_writable' });
    },
  );

  it('refuses a malformed query', async () => {
    const routes = createInboxRoutes({ home, flavor: FLAVOR });
    const reviewRoute = routes.find((r) => r.path === INBOX_REVIEW_PATH) as LocalUiReadRoute;
    const answer = await reviewRoute.handler(ctx(), {
      params: {},
      query: new URLSearchParams({ set: received }),
    });
    expect(answer.status).toBe(400);
  });
});

describe('POST /api/ui/files/inbox: presence, every warning, checked again', () => {
  it('signs exactly the reviewed body once, with the plain lines, and core applies it', async () => {
    const { review, commit } = setup();
    const token = body(await review(received))['review'] as string;
    const calls: SignCall[] = [];
    const answer = await commit({ review: token, acknowledged: ['folder_changed'] }, calls);
    expect(answer).toMatchObject({ status: 200, body: { status: 'applied', confirmed: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.review.lines[0]).toBe(`Save files people send you in ${received}.`);
    expect(calls[0]?.review.lines[1]).toContain('Files already saved stay where they are.');
    expect(fake.applied).toHaveLength(1);
    // One use.
    const again = await commit({ review: token, acknowledged: ['folder_changed'] });
    expect(again).toMatchObject({ status: 409, body: { error: 'unknown_review' } });
  });

  it('refuses without every warning acknowledged, before signing', async () => {
    const { review, commit } = setup();
    const token = body(await review(received))['review'] as string;
    const calls: SignCall[] = [];
    const answer = await commit({ review: token, acknowledged: [] }, calls);
    expect(answer).toMatchObject({ status: 409, body: { error: 'not_acknowledged' } });
    expect(calls).toHaveLength(0);
  });

  it('refuses a folder that became a Send folder since the review', async () => {
    const { review, commit } = setup();
    const token = body(await review(received))['review'] as string;
    fake.configured = [send, received];
    const calls: SignCall[] = [];
    const answer = await commit({ review: token, acknowledged: ['folder_changed'] }, calls);
    expect(answer).toMatchObject({ status: 409, body: { error: 'folder_changed' } });
    expect(calls).toHaveLength(0);
  });
});

describe('a Send folder never overlaps the Inbox', () => {
  it.each([
    ['the Inbox', () => inbox],
    ['around the Inbox', () => join(home, 'AgentLink')],
  ])('refuses adding %s as a Send folder', async (_name, path) => {
    const routes = createFilesRoutes({ home, flavor: FLAVOR });
    const reviewRoute = routes.find((r) => r.path === '/api/ui/files/review') as LocalUiReadRoute;
    const answer = await reviewRoute.handler(ctx(), {
      params: {},
      query: new URLSearchParams({ add: path(), version: '3' }),
    });
    expect(answer.status).toBe(422);
    expect(body(answer)).toEqual({ error: 'folder_refused', reason: 'inbox_folder' });
  });
});
