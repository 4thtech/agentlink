// U3-f (S2; D-138, U3-spec-04; 08 §1 "Agents and AI apps in the app", "Entry-only config display";
// 04 §2.5 "Writing AI app configs", §2.5.1 `app.connect`, `app.disconnect`; 06 §7; b11 §30;
// proposed, owner confirms at merge): the AI apps routes of the local app.
//
// - `GET /api/ui/apps` (read, also before an owner exists): the detected apps, the agent each runs
//   and whether Claude Desktop runs; only fixed fields, never anything else the seam holds.
// - `GET /api/ui/apps/preview?app=&agent=` (read, owner needed): the exact entry change for the open
//   agent and its `changeId` = SHA-256(JCS({app, path, oldEntry, newEntry, agent})); writes nothing.
// - `POST /api/ui/apps/apply` and `/disconnect` `{changeId}` (presence): the agent the entry runs
//   must be the open agent's agentId, checked before anything is signed (a mismatch signs nothing);
//   the owner signs `app.connect` / `app.disconnect` over that changeId with a statement naming the
//   app and the agent; the change is recomputed from the file after the gesture and refused with
//   `changed` (nothing applied, nothing written) on any difference, including the file's identity;
//   only then core applies the signed object and the seam writes.
import { canonicalize, encodeHex, sha256, type JsonObject } from '@4thtech-io/crypto';
import type { PreparedOwnerAction } from '@4thtech-io/core';
import { describe, expect, it } from 'vitest';
import type {
  LocalUiAiAppPlan,
  LocalUiAiApps,
  LocalUiAiAppWrite,
  LocalUiContext,
  LocalUiReadClient,
} from '../context.js';
import type {
  LocalUiOwnerOperation,
  LocalUiOwnerRoute,
  LocalUiReadRoute,
  LocalUiResult,
} from '../route-types.js';
import type { OwnerReview, OwnerSignRequest } from '../../owner-operation.js';
import { appChangeId, appsRoutes } from './apps.js';

const SELF = '0x71c4000000000000000000000000000000009a2e';
const OTHER = '0x1111111111111111111111111111111111111111';
const OWNER_NOSTR = 'dd'.repeat(32);
const SENTINEL = 'other-server-private-value';
const FILE = '/Users/me/.claude.json';

const route = (method: string, path: string) => {
  const found = appsRoutes.find((r) => r.method === method && r.path === path);
  if (found === undefined) throw new Error(`no route ${method} ${path}`);
  return found;
};
const list = route('GET', '/api/ui/apps') as LocalUiReadRoute;
const preview = route('GET', '/api/ui/apps/preview') as LocalUiReadRoute;
const apply = route('POST', '/api/ui/apps/apply') as LocalUiOwnerRoute;
const disconnect = route('POST', '/api/ui/apps/disconnect') as LocalUiOwnerRoute;

const entry = (agent?: string): JsonObject => ({
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@4thtech-io/agentlink', 'mcp', ...(agent === undefined ? [] : ['--agent', agent])],
  env: {},
});

interface World {
  readonly context: LocalUiContext;
  readonly desk: LocalUiAiApps;
  readonly commits: string[];
  readonly applied: JsonObject[];
  readonly plans: { app: string; agent: string }[];
  /** What the next plans answer (shifted per call; the last one repeats). */
  readonly next: LocalUiAiAppPlan[];
}

function changePlan(
  over: Partial<Extract<LocalUiAiAppPlan, { status: 'change' }>> = {},
  commits: string[] = [],
  result: LocalUiAiAppWrite = 'written',
): LocalUiAiAppPlan {
  return {
    status: 'change',
    kind: 'connect',
    app: 'claude-code',
    name: 'Claude Code',
    path: '~/.claude.json',
    file: FILE,
    oldEntry: null,
    newEntry: entry('work'),
    oldAgent: null,
    newAgent: 'work',
    identity: '1:42',
    commit: (agentId: string) => {
      commits.push(agentId);
      return Promise.resolve(result);
    },
    // A seam field the routes must never pass on.
    ...({ secret: SENTINEL } as object),
    ...over,
  } as LocalUiAiAppPlan;
}

function world(
  options: {
    current?: string;
    owner?: boolean;
    agentIdOf?: string | undefined;
    plans?: (commits: string[]) => LocalUiAiAppPlan[];
    applyStatus?: 'applied' | 'refused';
  } = {},
): World {
  const commits: string[] = [];
  const applied: JsonObject[] = [];
  const plans: World['plans'] = [];
  const next = options.plans?.(commits) ?? [changePlan({}, commits)];
  const desk: LocalUiAiApps = {
    list: () =>
      Promise.resolve({
        desktopRunning: true,
        apps: [
          {
            app: 'claude-code',
            name: 'Claude Code',
            path: '~/.claude.json',
            state: { kind: 'agent', agent: 'work' },
            quitFirst: false,
            ...({ text: SENTINEL } as object),
          },
          {
            app: 'codex',
            name: 'Codex',
            path: '~/.codex/config.toml',
            state: { kind: 'foreign' },
            quitFirst: false,
          },
          {
            app: 'claude-desktop',
            name: 'Claude Desktop',
            path: '~/Library/Application Support/Claude/claude_desktop_config.json',
            state: { kind: 'none' },
            quitFirst: true,
          },
          {
            app: 'cursor',
            name: 'Cursor',
            path: '~/.cursor/mcp.json',
            state: { kind: 'unreadable' },
            quitFirst: false,
          },
        ],
      }),
    plan: (app, agent) => {
      plans.push({ app, agent });
      const plan = next.length > 1 ? next.shift() : next[0];
      return Promise.resolve(plan as LocalUiAiAppPlan);
    },
    agentIdOf: () => Promise.resolve('agentIdOf' in options ? options.agentIdOf : SELF),
  };
  const client = {
    agentId: SELF,
    agent: { label: () => Promise.resolve({ status: 'verified', label: 'Work' }) },
    apps: {
      prepare: (op: string, app: string, changeId: string) =>
        Promise.resolve({
          status: 'prepared',
          op,
          body: {
            v: 1,
            agent: SELF,
            owner: OWNER_NOSTR,
            op,
            params: { app, agent: SELF, changeId },
            nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
            issuedAt: 1_760_000_000,
            expiresAt: 1_760_000_600,
          },
        } as unknown as PreparedOwnerAction),
    },
  } as unknown as LocalUiReadClient;
  const context = {
    client,
    aiApps: desk,
    agentsManage: { current: () => options.current ?? 'work' },
    ownerContext: () =>
      Promise.resolve(options.owner === false ? undefined : ({ agent: SELF } as never)),
    applyOwnerAction: (signed: { body: JsonObject }) => {
      applied.push(signed.body);
      return Promise.resolve(
        options.applyStatus === 'refused'
          ? { status: 'refused', op: 'app.connect', reason: 'nonce_used' }
          : { status: 'applied', op: signed.body['op'] },
      );
    },
    now: () => 1_760_000_000_000,
  } as unknown as LocalUiContext;
  return { context, desk, commits, applied, plans, next };
}

interface Owner {
  readonly op: LocalUiOwnerOperation;
  readonly reviews: OwnerReview[];
  readonly signed: OwnerSignRequest[];
}

function owner(): Owner {
  const reviews: OwnerReview[] = [];
  const signed: OwnerSignRequest[] = [];
  return {
    reviews,
    signed,
    op: {
      sign: (review, requests) => {
        reviews.push(review);
        signed.push(...requests);
        return Promise.resolve(
          requests.map((r) => ({
            kind: 'owner-action',
            signed: { body: (r as { action: JsonObject }).action, sig: 'ee'.repeat(64) },
          })) as never,
        );
      },
    },
  };
}

const q = (query: string) => ({ params: {}, query: new URLSearchParams(query) });
const body = (result: LocalUiResult) => result.body as JsonObject;

async function previewed(w: World, agent = 'work'): Promise<string> {
  const result = await preview.handler(w.context, q(`app=claude-code&agent=${agent}`));
  expect(result.status).toBe(200);
  return body(result)['changeId'] as string;
}

describe('GET /api/ui/apps', () => {
  it('answers fixed fields only; no seam field and no secret reaches the answer', async () => {
    const w = world();
    const result = await list.handler(w.context, q(''));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      desktopRunning: true,
      apps: [
        {
          app: 'claude-code',
          name: 'Claude Code',
          path: '~/.claude.json',
          state: 'connected',
          agent: 'work',
          quitFirst: false,
        },
        {
          app: 'codex',
          name: 'Codex',
          path: '~/.codex/config.toml',
          state: 'not_ours',
          quitFirst: false,
        },
        {
          app: 'claude-desktop',
          name: 'Claude Desktop',
          path: '~/Library/Application Support/Claude/claude_desktop_config.json',
          state: 'not_connected',
          quitFirst: true,
        },
        {
          app: 'cursor',
          name: 'Cursor',
          path: '~/.cursor/mcp.json',
          state: 'unreadable',
          quitFirst: false,
        },
      ],
    });
    expect(JSON.stringify(result.body)).not.toContain(SENTINEL);
  });

  it('is allowed before an owner exists (first run) and refuses any query', async () => {
    const w = world({ owner: false });
    const noClient = Object.fromEntries(
      Object.entries(w.context).filter(([k]) => k !== 'client' && k !== 'agentsManage'),
    );
    expect((await list.handler(noClient as LocalUiContext, q(''))).status).toBe(200);
    expect((await list.handler(w.context, q('x=1'))).status).toBe(400);
  });

  it('is not_available without the seam', async () => {
    const w = world();
    const noApps = Object.fromEntries(Object.entries(w.context).filter(([k]) => k !== 'aiApps'));
    const result = await list.handler(noApps as LocalUiContext, q(''));
    expect(result).toEqual({ status: 501, body: { error: 'not_available' } });
  });
});

describe('GET /api/ui/apps/preview', () => {
  it('answers the exact entry change and its changeId; writes nothing', async () => {
    const w = world();
    const result = await preview.handler(w.context, q('app=claude-code&agent=work'));
    expect(result.status).toBe(200);
    const changeId = appChangeId({
      app: 'claude-code',
      path: FILE,
      oldEntry: null,
      newEntry: entry('work'),
      agent: SELF,
    });
    expect(changeId).toBe(
      encodeHex(
        sha256(
          new TextEncoder().encode(
            canonicalize({
              app: 'claude-code',
              path: FILE,
              oldEntry: null,
              newEntry: entry('work'),
              agent: SELF,
            }),
          ),
        ),
      ),
    );
    expect(result.body).toEqual({
      status: 'change',
      kind: 'connect',
      app: 'claude-code',
      name: 'Claude Code',
      path: '~/.claude.json',
      folder: 'work',
      oldEntry: null,
      newEntry: entry('work'),
      oldAgent: null,
      newAgent: 'work',
      changeId,
    });
    expect(JSON.stringify(result.body)).not.toContain(SENTINEL);
    expect(JSON.stringify(result.body)).not.toContain(FILE);
    expect(w.commits).toEqual([]);
  });

  it('refuses bad input, no owner, another agent than the open one and a mismatched agentId', async () => {
    expect((await preview.handler(world().context, q('app=vscode&agent=work'))).body).toEqual({
      error: 'bad_request',
    });
    expect((await preview.handler(world().context, q('app=claude-code&agent=../x'))).body).toEqual({
      error: 'bad_request',
    });
    expect((await preview.handler(world().context, q('app=claude-code'))).body).toEqual({
      error: 'bad_request',
    });
    expect(
      (await preview.handler(world().context, q('app=claude-code&agent=work&agent=x'))).body,
    ).toEqual({ error: 'bad_request' });
    // No path is ever taken from the page (08 §1).
    expect(
      (await preview.handler(world().context, q('app=claude-code&agent=work&path=/etc/x'))).body,
    ).toEqual({ error: 'bad_request' });
    expect(
      (await preview.handler(world({ owner: false }).context, q('app=claude-code&agent=work')))
        .status,
    ).toBe(409);
    expect(
      (await preview.handler(world({ current: 'home' }).context, q('app=claude-code&agent=work')))
        .body,
    ).toEqual({ error: 'agent_changed' });
    expect(
      (await preview.handler(world({ agentIdOf: OTHER }).context, q('app=claude-code&agent=work')))
        .body,
    ).toEqual({ error: 'agent_mismatch' });
  });

  it('passes through the non-change states as fixed words', async () => {
    for (const status of [
      'present',
      'not_connected',
      'conflict',
      'quit_first',
      'unreadable',
      'not_found',
    ] as const) {
      const w = world({
        plans: () => [{ status, app: 'claude-code', name: 'Claude Code' } as LocalUiAiAppPlan],
      });
      const result = await preview.handler(w.context, q('app=claude-code&agent=work'));
      expect(result.body).toEqual({ status, app: 'claude-code', name: 'Claude Code' });
    }
  });
});

describe('POST /api/ui/apps/apply', () => {
  it('signs app.connect over the changeId with a statement naming the app and the agent, then applies and writes', async () => {
    const w = world();
    const changeId = await previewed(w);
    const o = owner();
    const result = await apply.handler(w.context, { ...q(''), input: { changeId } }, o.op);
    expect(result).toEqual({ status: 200, body: { status: 'done', app: 'claude-code' } });
    expect(o.reviews).toEqual([{ lines: ['Connect Claude Code to Work'] }]);
    expect(o.signed).toHaveLength(1);
    const signed = (o.signed[0] as { action: JsonObject }).action;
    expect(signed['op']).toBe('app.connect');
    expect(signed['params']).toEqual({ app: 'claude-code', agent: SELF, changeId });
    expect(w.applied.map((b) => b['op'])).toEqual(['app.connect']);
    expect(w.commits).toEqual([SELF]);
    // The change was recomputed after the gesture (two plans: preview and apply).
    expect(w.plans).toHaveLength(2);
  });

  it('a mismatched agent signs nothing', async () => {
    const w = world();
    const changeId = await previewed(w);
    const o = owner();
    // The same pending preview; the folder's config now names another agentId.
    (w.desk as { agentIdOf: LocalUiAiApps['agentIdOf'] }).agentIdOf = () => Promise.resolve(OTHER);
    const result = await apply.handler(w.context, { ...q(''), input: { changeId } }, o.op);
    expect(result.body).toEqual({ error: 'agent_mismatch' });
    expect(o.signed).toEqual([]);
    expect(w.commits).toEqual([]);
    expect(w.applied).toEqual([]);
  });

  it('a changeId mismatch after the gesture gives changed, applies and writes nothing', async () => {
    const commits: string[] = [];
    const w = world({
      plans: (c) => [
        changePlan({}, c),
        changePlan({ oldEntry: entry('personal'), oldAgent: 'personal', kind: 'move' }, commits),
      ],
    });
    const changeId = await previewed(w);
    const o = owner();
    const result = await apply.handler(w.context, { ...q(''), input: { changeId } }, o.op);
    expect(result).toEqual({ status: 409, body: { error: 'changed' } });
    expect(o.signed).toHaveLength(1);
    expect(w.applied).toEqual([]);
    expect(w.commits).toEqual([]);
    expect(commits).toEqual([]);
  });

  it('a file swapped for another inode (same entries) gives changed', async () => {
    const w = world({ plans: (c) => [changePlan({}, c), changePlan({ identity: '1:43' }, c)] });
    const changeId = await previewed(w);
    const result = await apply.handler(w.context, { ...q(''), input: { changeId } }, owner().op);
    expect(result.body).toEqual({ error: 'changed' });
    expect(w.applied).toEqual([]);
    expect(w.commits).toEqual([]);
  });

  it('an unknown changeId, a bad input or a disconnect preview signs nothing', async () => {
    const w = world();
    const o = owner();
    await apply.handler(w.context, { ...q(''), input: { changeId: 'ab'.repeat(32) } }, o.op);
    await apply.handler(w.context, { ...q(''), input: { changeId: 'x' } }, o.op);
    await apply.handler(w.context, { ...q(''), input: { changeId: 'ab'.repeat(32), x: 1 } }, o.op);
    const d = world({
      plans: (c) => [
        changePlan(
          {
            kind: 'disconnect',
            oldEntry: entry('work'),
            oldAgent: 'work',
            newEntry: null,
            newAgent: null,
          },
          c,
        ),
      ],
    });
    const id = await previewed(d);
    await apply.handler(d.context, { ...q(''), input: { changeId: id } }, o.op);
    expect(o.signed).toEqual([]);
  });

  it('maps a refused core apply and a seam refusal to fixed codes', async () => {
    const refused = world({ applyStatus: 'refused' });
    const id1 = await previewed(refused);
    expect(
      (await apply.handler(refused.context, { ...q(''), input: { changeId: id1 } }, owner().op))
        .body,
    ).toEqual({ error: 'not_applied' });
    expect(refused.commits).toEqual([]);
    for (const outcome of ['quit_first', 'changed', 'agent_mismatch', 'failed'] as const) {
      const w = world({ plans: (c) => [changePlan({}, c, outcome)] });
      const id = await previewed(w);
      const result = await apply.handler(
        w.context,
        { ...q(''), input: { changeId: id } },
        owner().op,
      );
      expect(result.status).toBe(409);
      expect(result.body).toEqual({ error: outcome === 'failed' ? 'write_failed' : outcome });
    }
  });

  it('the statement names an unverified agent by its folder name; the signed op binds the agentId only', async () => {
    const w = world();
    (w.context.client as unknown as { agent: { label: () => Promise<unknown> } }).agent = {
      label: () => Promise.resolve({ status: 'unverified' }),
    };
    const changeId = await previewed(w);
    const o = owner();
    await apply.handler(w.context, { ...q(''), input: { changeId } }, o.op);
    expect(o.reviews).toEqual([{ lines: ['Connect Claude Code to work'] }]);
    const signed = (o.signed[0] as { action: JsonObject }).action;
    expect(signed['agent']).toBe(SELF);
    expect(JSON.stringify(signed)).not.toContain('Work');
  });

  it('a move names both agents', async () => {
    const w = world({
      plans: (c) => [
        changePlan({ kind: 'move', oldEntry: entry('personal'), oldAgent: 'personal' }, c),
      ],
    });
    const changeId = await previewed(w);
    const o = owner();
    await apply.handler(w.context, { ...q(''), input: { changeId } }, o.op);
    expect(o.reviews).toEqual([{ lines: ['Claude Code will use Work instead of personal'] }]);
  });
});

describe('POST /api/ui/apps/disconnect', () => {
  it('signs app.disconnect and removes only this entry', async () => {
    const w = world({
      plans: (c) => [
        changePlan(
          {
            kind: 'disconnect',
            oldEntry: entry('work'),
            oldAgent: 'work',
            newEntry: null,
            newAgent: null,
          },
          c,
        ),
      ],
    });
    const changeId = await previewed(w);
    const o = owner();
    const result = await disconnect.handler(w.context, { ...q(''), input: { changeId } }, o.op);
    expect(result).toEqual({ status: 200, body: { status: 'done', app: 'claude-code' } });
    expect(o.reviews).toEqual([{ lines: ['Claude Code will stop using Work'] }]);
    expect((o.signed[0] as { action: JsonObject }).action['op']).toBe('app.disconnect');
    expect(w.commits).toEqual([SELF]);
  });

  it('refuses a connect preview', async () => {
    const w = world();
    const changeId = await previewed(w);
    const o = owner();
    await disconnect.handler(w.context, { ...q(''), input: { changeId } }, o.op);
    expect(o.signed).toEqual([]);
  });
});
