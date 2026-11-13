// WP-D7 (S2; plan 2026-11-12 Decision 2 "AI apps"; 04 §2.5 "Writing AI app configs"): "Use the app
// for …" through the real routes. `form=app` previews a `switch`; Apply signs `app.connect` with a
// statement naming the app and the agent, recomputes the same request after the gesture and writes
// only then. The launcher is bound by the changeId. A desktop app that moved to a place that is never
// written is refused after the gesture, before anything is applied or written.
import type { PreparedOwnerAction } from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import { describe, expect, it } from 'vitest';
import type { OwnerReview, OwnerSignRequest } from '../../owner-operation.js';
import type {
  LocalUiAiAppPlan,
  LocalUiAiAppPlanRequest,
  LocalUiAiApps,
  LocalUiContext,
  LocalUiReadClient,
} from '../context.js';
import type {
  LocalUiOwnerOperation,
  LocalUiOwnerRoute,
  LocalUiReadRoute,
  LocalUiRequest,
} from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import { appChangeId } from './apps.js';

const AGENT_ID = '0x1111111111111111111111111111111111111111';
const routes = createLocalUiRoutes().routes();
const read = (path: string) =>
  routes.find((r) => r.method === 'GET' && r.path === path) as LocalUiReadRoute;
const owner = (path: string) =>
  routes.find((r) => r.method === 'POST' && r.path === path) as LocalUiOwnerRoute;

const NODE = '/Applications/AgentLink.app/Contents/Resources/node/bin/node';
const CLI =
  '/Applications/AgentLink.app/Contents/Resources/core/node_modules/@4thtech-io/agentlink/dist/agentlink.js';
const npx: JsonObject = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'work'],
  env: {},
};
const appForm: JsonObject = {
  type: 'stdio',
  command: NODE,
  args: [CLI, 'mcp', '--agent', 'work'],
  env: {},
};
const LAUNCHER = { path: '~/.agentlink/bin/agentlink', oldText: 'old\n', newText: 'new\n' };
const FILE = '/Users/ana/.claude.json';

function world(opts: { afterGesture?: () => LocalUiAiAppPlan | undefined } = {}) {
  const asked: (LocalUiAiAppPlanRequest | undefined)[] = [];
  const written: string[] = [];
  const reviews: OwnerReview[] = [];
  const applied: JsonObject[] = [];
  let calls = 0;
  const switchPlan = (request: LocalUiAiAppPlanRequest | undefined): LocalUiAiAppPlan => ({
    status: 'change',
    kind: 'switch',
    app: 'claude-code',
    name: 'Claude Code',
    path: '~/.claude.json',
    file: FILE,
    oldEntry: npx,
    newEntry: appForm,
    oldAgent: 'work',
    newAgent: 'work',
    identity: '1:42',
    ...(request?.launcher === true ? { launcher: LAUNCHER } : { launcherOffer: true }),
    commit: () => {
      written.push(request?.launcher === true ? 'entry+launcher' : 'entry');
      return Promise.resolve('written');
    },
  });
  const desk: LocalUiAiApps = {
    list: () =>
      Promise.resolve({
        desktopRunning: false,
        desktopApp: 'available',
        apps: [
          {
            app: 'claude-code',
            name: 'Claude Code',
            path: '~/.claude.json',
            state: { kind: 'agent', agent: 'work', form: 'app' },
            quitFirst: false,
          },
        ],
      }),
    plan: (_app, _agent, request) => {
      asked.push(request);
      calls += 1;
      if (calls > 1 && opts.afterGesture !== undefined) {
        const fresh = opts.afterGesture();
        if (fresh !== undefined) return Promise.resolve(fresh);
      }
      if (request?.form !== 'app') {
        return Promise.resolve({
          ...switchPlan(request),
          kind: 'disconnect',
          newEntry: null,
          newAgent: null,
        } as LocalUiAiAppPlan);
      }
      return Promise.resolve(switchPlan(request));
    },
    agentIdOf: () => Promise.resolve(AGENT_ID),
  };
  const client = {
    agentId: AGENT_ID,
    agent: { label: () => Promise.resolve({ status: 'verified', label: 'Work' }) },
    apps: {
      prepare: (op: string, app: string, changeId: string) =>
        Promise.resolve({
          status: 'prepared',
          op,
          body: {
            v: 1,
            agent: AGENT_ID,
            owner: 'dd'.repeat(32),
            op,
            params: { app, agent: AGENT_ID, changeId },
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
    agentsManage: { current: () => 'work' },
    ownerContext: () => Promise.resolve({ agent: AGENT_ID } as never),
    applyOwnerAction: (signed: { body: JsonObject }) => {
      applied.push(signed.body);
      return Promise.resolve({ status: 'applied', op: signed.body['op'] });
    },
    now: () => 1_760_000_000_000,
  } as unknown as LocalUiContext;
  const operation: LocalUiOwnerOperation = {
    sign: (review, requests: readonly OwnerSignRequest[]) => {
      reviews.push(review);
      return Promise.resolve(
        requests.map((r) => ({
          kind: 'owner-action',
          signed: { body: (r as { action: JsonObject }).action, sig: 'ee'.repeat(64) },
        })) as never,
      );
    },
  };
  return { context, operation, asked, written, reviews, applied };
}

const query = (q: string): LocalUiRequest =>
  ({ query: new URLSearchParams(q), input: undefined }) as unknown as LocalUiRequest;
const input = (changeId: string): LocalUiRequest =>
  ({ query: new URLSearchParams(), input: { changeId } }) as unknown as LocalUiRequest;

describe('GET /api/ui/apps: the app form and the desktop app', () => {
  it('names the app form and the desktop app state', async () => {
    const { context } = world();
    const r = await read('/api/ui/apps').handler(context, query(''));
    expect(r.body).toEqual({
      desktopRunning: false,
      apps: [
        {
          app: 'claude-code',
          name: 'Claude Code',
          path: '~/.claude.json',
          state: 'connected',
          agent: 'work',
          form: 'app',
          quitFirst: false,
        },
      ],
      desktopApp: 'available',
    });
  });
});

describe('preview form=app', () => {
  it('a switch with its changeId; the request reaches the seam', async () => {
    const w = world();
    const r = await read('/api/ui/apps/preview').handler(
      w.context,
      query('app=claude-code&agent=work&form=app'),
    );
    expect(w.asked).toEqual([{ form: 'app' }]);
    expect(r.body).toEqual({
      status: 'change',
      kind: 'switch',
      app: 'claude-code',
      name: 'Claude Code',
      path: '~/.claude.json',
      folder: 'work',
      oldEntry: npx,
      newEntry: appForm,
      oldAgent: 'work',
      newAgent: 'work',
      changeId: appChangeId({
        app: 'claude-code',
        path: FILE,
        oldEntry: npx,
        newEntry: appForm,
        agent: AGENT_ID,
      }),
      launcherOffer: true,
    });
  });

  it('launcher=1: the launcher change is shown and bound by the changeId', async () => {
    const w = world();
    const r = await read('/api/ui/apps/preview').handler(
      w.context,
      query('app=claude-code&agent=work&form=app&launcher=1'),
    );
    const body = r.body as Record<string, unknown>;
    expect(body['launcher']).toEqual(LAUNCHER);
    expect(body).not.toHaveProperty('launcherOffer');
    const withLauncher = appChangeId({
      app: 'claude-code',
      path: FILE,
      oldEntry: npx,
      newEntry: appForm,
      agent: AGENT_ID,
      launcher: LAUNCHER,
    });
    expect(body['changeId']).toBe(withLauncher);
    expect(withLauncher).not.toBe(
      appChangeId({
        app: 'claude-code',
        path: FILE,
        oldEntry: npx,
        newEntry: appForm,
        agent: AGENT_ID,
      }),
    );
  });

  it('bad queries are refused: unknown form, launcher without the app form, extra keys', async () => {
    const w = world();
    for (const q of [
      'app=claude-code&agent=work&form=npx',
      'app=claude-code&agent=work&launcher=1',
      'app=claude-code&agent=work&form=app&launcher=yes',
      'app=claude-code&agent=work&form=app&form=app',
      'app=claude-code&agent=work&path=/etc/passwd',
    ]) {
      const r = await read('/api/ui/apps/preview').handler(w.context, query(q));
      expect(r.status, q).toBe(400);
    }
    expect(w.asked).toEqual([]);
  });

  it('a switch answered to a plain preview is refused (fail closed)', async () => {
    const w = world();
    (w.context.aiApps as { plan: unknown }).plan = () =>
      Promise.resolve({
        status: 'change',
        kind: 'switch',
        app: 'claude-code',
        name: 'Claude Code',
        path: '~/.claude.json',
        file: FILE,
        oldEntry: npx,
        newEntry: appForm,
        oldAgent: 'work',
        newAgent: 'work',
        identity: '1:42',
        commit: () => Promise.resolve('written'),
      });
    const r = await read('/api/ui/apps/preview').handler(
      w.context,
      query('app=claude-code&agent=work'),
    );
    expect(r.status).toBe(503);
  });
});

describe('apply a switch', () => {
  it('signs app.connect with the statement, re-plans the same request, then writes', async () => {
    const w = world();
    const p = await read('/api/ui/apps/preview').handler(
      w.context,
      query('app=claude-code&agent=work&form=app&launcher=1'),
    );
    const changeId = (p.body as { changeId: string }).changeId;
    const r = await owner('/api/ui/apps/apply').handler(w.context, input(changeId), w.operation);
    expect(r.body).toEqual({ status: 'done', app: 'claude-code' });
    expect(w.reviews[0]?.lines).toEqual(['Claude Code will use the AgentLink app for Work']);
    expect(w.applied[0]?.['op']).toBe('app.connect');
    expect(w.asked).toEqual([
      { form: 'app', launcher: true },
      { form: 'app', launcher: true },
    ]);
    expect(w.written).toEqual(['entry+launcher']);
  });

  it('a switch is not a disconnect', async () => {
    const w = world();
    const p = await read('/api/ui/apps/preview').handler(
      w.context,
      query('app=claude-code&agent=work&form=app'),
    );
    const changeId = (p.body as { changeId: string }).changeId;
    const r = await owner('/api/ui/apps/disconnect').handler(
      w.context,
      input(changeId),
      w.operation,
    );
    expect(r.status).toBe(400);
    expect(w.written).toEqual([]);
  });

  it('the app moved to a translocated place during the gesture: refused, nothing applied', async () => {
    const w = world({
      afterGesture: () => ({ status: 'app_location', app: 'claude-code', name: 'Claude Code' }),
    });
    const p = await read('/api/ui/apps/preview').handler(
      w.context,
      query('app=claude-code&agent=work&form=app'),
    );
    const changeId = (p.body as { changeId: string }).changeId;
    const r = await owner('/api/ui/apps/apply').handler(w.context, input(changeId), w.operation);
    expect(r).toEqual({ status: 409, body: { error: 'app_location' } });
    expect(w.applied).toEqual([]);
    expect(w.written).toEqual([]);
  });

  it('the launcher was not changed: done, and the answer says so', async () => {
    const w = world();
    const base = w.context.aiApps as LocalUiAiApps;
    const plan = base.plan.bind(base);
    (w.context.aiApps as { plan: unknown }).plan = async (
      app: string,
      agent: string,
      request?: LocalUiAiAppPlanRequest,
    ) => {
      const p = await plan(app, agent, request);
      return p.status === 'change'
        ? { ...p, commit: () => Promise.resolve('written_launcher_unchanged') }
        : p;
    };
    const p = await read('/api/ui/apps/preview').handler(
      w.context,
      query('app=claude-code&agent=work&form=app&launcher=1'),
    );
    const changeId = (p.body as { changeId: string }).changeId;
    const r = await owner('/api/ui/apps/apply').handler(w.context, input(changeId), w.operation);
    expect(r).toEqual({
      status: 200,
      body: { status: 'done', app: 'claude-code', launcher: 'not_changed' },
    });
  });

  it('a commit that finds the app moved answers app_location', async () => {
    const w = world();
    const base = w.context.aiApps as LocalUiAiApps;
    const plan = base.plan.bind(base);
    (w.context.aiApps as { plan: unknown }).plan = async (
      app: string,
      agent: string,
      request?: LocalUiAiAppPlanRequest,
    ) => {
      const p = await plan(app, agent, request);
      return p.status === 'change' ? { ...p, commit: () => Promise.resolve('app_location') } : p;
    };
    const p = await read('/api/ui/apps/preview').handler(
      w.context,
      query('app=claude-code&agent=work&form=app'),
    );
    const changeId = (p.body as { changeId: string }).changeId;
    const r = await owner('/api/ui/apps/apply').handler(w.context, input(changeId), w.operation);
    expect(r).toEqual({ status: 409, body: { error: 'app_location' } });
  });
});
