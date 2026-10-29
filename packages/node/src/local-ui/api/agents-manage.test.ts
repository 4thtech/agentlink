// U3-d (S2; D-138, U3-spec-04; 08 §1 "Agents and AI apps in the app", "Signed local owner actions";
// 04 §2.5, §2.5.1 `agent.label`, §2.8 "From the local app"; b11 §29.3, §29.5; proposed, owner
// confirms at merge): create an agent and rename one from the local app.
//
// - `GET /api/ui/agents/label-check?label=`: whether core would sign that label (the 06 §2.1
//   restricted form, 1 to 32 code points), so the page asks for Touch ID only for a label that can
//   be applied. Signs and writes nothing.
// - `POST /api/ui/agents/label` `{name, label}` (presence): signs one `agent.label` for the OPEN
//   agent only. The body core prepared binds the open agent's `agentId` (never a name or the label
//   in config.json); the owner statement names the agent by its verified label ("Rename Personal to
//   Home"), never by config.json's text. Only after core applied it is config.json's label written.
// - `POST /api/ui/agents` `{label}` (presence): the server creates a keychain agent (folder name a
//   slug of the label), the one gesture signs exactly its first card, its first policy and its first
//   label, and on any failure exactly what the request created is removed again (all or nothing).
// - A handler that signs nothing performed no owner operation (the gate answers 409 `refused`).
import type { LabelReading, PreparedOwnerAction } from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import { describe, expect, it } from 'vitest';
import type {
  LocalUiAgentsManage,
  LocalUiContext,
  LocalUiNewAgent,
  LocalUiReadClient,
} from '../context.js';
import type {
  LocalUiOwnerOperation,
  LocalUiOwnerRoute,
  LocalUiReadRoute,
  LocalUiRenameOutcome,
  LocalUiRenameRequest,
  LocalUiResult,
} from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import type { OwnerReview, OwnerSignRequest } from '../../owner-operation.js';
import { agentsManageRoutes } from './agents-manage.js';

const SELF = '0x71c4000000000000000000000000000000009a2e';
const OWNER_NOSTR = 'dd'.repeat(32);

const route = (method: string, path: string) => {
  const found = agentsManageRoutes.find((r) => r.method === method && r.path === path);
  if (found === undefined) throw new Error(`no route ${method} ${path}`);
  return found;
};
const labelCheck = route('GET', '/api/ui/agents/label-check') as LocalUiReadRoute;
const rename = route('POST', '/api/ui/agents/label') as LocalUiOwnerRoute;
const add = route('POST', '/api/ui/agents') as LocalUiOwnerRoute;
const cardNameRead = route('GET', '/api/ui/agents/card-name') as LocalUiReadRoute;

function prepared(label: string, agent = SELF): PreparedOwnerAction {
  const body = {
    v: 1,
    agent,
    owner: OWNER_NOSTR,
    op: 'agent.label',
    params: { agent, label },
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    issuedAt: 1_760_000_000,
    expiresAt: 1_760_000_600,
  };
  return {
    status: 'prepared',
    op: 'agent.label',
    body,
    jcs: JSON.stringify(body),
  } as unknown as PreparedOwnerAction;
}

interface World {
  readonly context: LocalUiContext;
  readonly applied: { readonly body: JsonObject; readonly sig: string }[];
  readonly saved: [string, string][];
  readonly settled: [string, boolean][];
  readonly created: string[];
}

function world(
  options: {
    current?: string;
    /** What core loads as this agent's label. */
    reading?: LabelReading;
    applyStatus?: 'applied' | 'refused';
    create?: 'ok' | 'fail';
    /**
     * W4-RENAME-REACHES-CONTACTS: the name in the agent's current card. Default 'Home', the label
     * most cases here rename to: a label equal to the card's name changes only the label (D-141 (3)).
     */
    cardName?: string;
    allowance?: { status: 'ok'; left: number } | { status: 'limited'; retryAt: number };
    sendState?: string;
  } = {},
): World {
  const applied: World['applied'] = [];
  const saved: World['saved'] = [];
  const settled: World['settled'] = [];
  const created: string[] = [];
  const client = {
    agentId: SELF,
    agent: {
      cardName: () => Promise.resolve(options.cardName ?? 'Home'),
      renameAllowance: () => Promise.resolve(options.allowance ?? { status: 'ok', left: 3 }),
      sendState: () => Promise.resolve(options.sendState ?? 'ready'),
      label: () => Promise.resolve(options.reading ?? { status: 'none' }),
      prepareLabel: (label: string) =>
        Promise.resolve(
          /^[A-Za-z][A-Za-z0-9 ]{0,31}$/.test(label) && !label.includes('  ')
            ? prepared(label)
            : ({
                status: 'refused',
                op: 'agent.label',
                reason: 'label_invalid',
              } as unknown as PreparedOwnerAction),
        ),
    },
  } as unknown as LocalUiReadClient;
  const manage: LocalUiAgentsManage = {
    current: () => (options.current === undefined ? 'personal' : options.current),
    create: (label) => {
      created.push(label);
      if (options.create === 'fail') return Promise.resolve(undefined);
      return Promise.resolve({ name: 'work-agent' } as unknown as LocalUiNewAgent);
    },
    settle: (agent, ok) => {
      settled.push([agent.name, ok]);
      return Promise.resolve();
    },
    labelSaved: (name, label) => {
      saved.push([name, label]);
      return Promise.resolve();
    },
  };
  const context = {
    client,
    agentsManage: manage,
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: (signed: { body: JsonObject; sig: string }) => {
      applied.push(signed);
      return Promise.resolve(
        options.applyStatus === 'refused'
          ? { status: 'refused', op: 'agent.label', reason: 'nonce_used' }
          : { status: 'applied', op: 'agent.label' },
      );
    },
    now: () => 0,
  } as unknown as LocalUiContext;
  return { context, applied, saved, settled, created };
}

interface Owner {
  readonly operation: LocalUiOwnerOperation;
  readonly reviews: OwnerReview[];
  readonly requests: OwnerSignRequest[][];
  readonly added: LocalUiNewAgent[];
  readonly renamed: LocalUiRenameRequest[];
}

function owner(
  addOutcome: 'done' | 'failed' = 'done',
  renameOutcome?: LocalUiRenameOutcome,
): Owner {
  const reviews: OwnerReview[] = [];
  const requests: OwnerSignRequest[][] = [];
  const added: LocalUiNewAgent[] = [];
  const renamed: LocalUiRenameRequest[] = [];
  const operation: LocalUiOwnerOperation = {
    renameAgent: (review, request) => {
      reviews.push(review);
      renamed.push(request);
      return Promise.resolve(
        renameOutcome ?? {
          status: 'signed',
          label: { body: request.labelBody, sig: 'cd'.repeat(64) },
          contacts: 2,
        },
      );
    },
    sign: (review, reqs) => {
      reviews.push(review);
      requests.push([...reqs]);
      return Promise.resolve(
        reqs.map((r) =>
          r.kind === 'owner-action'
            ? { kind: 'owner-action', signed: { body: r.action, sig: 'ab'.repeat(64) } }
            : { kind: 'typed-data', signature: '0x' },
        ),
      );
    },
    addAgent: (review, agent) => {
      reviews.push(review);
      added.push(agent);
      return Promise.resolve(
        addOutcome === 'done' ? { status: 'done' as const } : { status: 'failed' as const },
      );
    },
  };
  return { operation, reviews, requests, added, renamed };
}

const run = (r: LocalUiOwnerRoute, w: World, o: Owner, input: unknown): Promise<LocalUiResult> =>
  r.handler(
    w.context,
    { params: {}, query: new URLSearchParams(), input: input as never },
    o.operation,
  );

describe('the U3-d routes are registered once and replace the U3-c stubs', () => {
  it('registers label-check, create and rename; none is a stub', () => {
    const all = createLocalUiRoutes().routes();
    for (const [method, path] of [
      ['GET', '/api/ui/agents/label-check'],
      ['POST', '/api/ui/agents'],
      ['POST', '/api/ui/agents/label'],
    ] as const) {
      const found = all.filter((r) => r.method === method && r.path === path);
      expect(found, path).toHaveLength(1);
      expect((found[0] as { stub?: unknown }).stub, path).toBeUndefined();
    }
    expect(rename.presence).toBe(true);
    expect(add.presence).toBe(true);
    expect(labelCheck.presence).toBe(false);
  });
});

describe('GET /api/ui/agents/label-check', () => {
  const check = async (label: string | undefined): Promise<LocalUiResult> => {
    const query = new URLSearchParams(label === undefined ? {} : { label });
    return labelCheck.handler(world().context, { params: {}, query });
  };

  it('answers ok for a restricted label and label_invalid otherwise; signs nothing', async () => {
    expect(await check('Home agent')).toEqual({ status: 200, body: { status: 'ok' } });
    for (const label of ['', 'Work  agent', ' Work', 'Work‮agent', '<b>x</b>', 'a'.repeat(33)]) {
      expect(await check(label), JSON.stringify(label)).toEqual({
        status: 200,
        body: { status: 'refused', reason: 'label_invalid' },
      });
    }
  });

  it('a missing, repeated or extra query is invalid_query', async () => {
    expect((await check(undefined)).status).toBe(400);
    const twice = new URLSearchParams([
      ['label', 'a'],
      ['label', 'b'],
    ]);
    expect((await labelCheck.handler(world().context, { params: {}, query: twice })).status).toBe(
      400,
    );
    const extra = new URLSearchParams({ label: 'a', name: 'x' });
    expect((await labelCheck.handler(world().context, { params: {}, query: extra })).status).toBe(
      400,
    );
  });
});

describe('POST /api/ui/agents/label (rename; signs agent.label)', () => {
  it('signs one agent.label for the open agent, names it by its verified label, then saves config.json', async () => {
    const w = world({ reading: { status: 'verified', label: 'Personal' } });
    const o = owner();
    const result = await run(rename, w, o, { name: 'personal', label: 'Home' });
    expect(result).toEqual({ status: 200, body: { status: 'done', label: 'Home' } });
    expect(o.requests).toHaveLength(1);
    const action = (o.requests[0]?.[0] as { action: JsonObject }).action;
    expect(action['op']).toBe('agent.label');
    expect(action['agent']).toBe(SELF);
    expect(action['params']).toEqual({ agent: SELF, label: 'Home' });
    // b11 §29.5: the statement names the agent and the new name.
    expect(o.reviews[0]?.lines).toEqual(['Rename Personal to Home']);
    expect(w.applied).toHaveLength(1);
    expect(w.saved).toEqual([['personal', 'Home']]);
  });

  it('with no verified label the statement names the folder name, never config.json text', async () => {
    const w = world({ reading: { status: 'unverified' } });
    const o = owner();
    await run(rename, w, o, { name: 'personal', label: 'Home' });
    expect(o.reviews[0]?.lines).toEqual(['Rename personal to Home']);
  });

  it('editing config.json does not change what the signed op applies to: it binds the agentId', async () => {
    // config.json says "Work" for the open agent (a same-user edit); core's verified label is
    // "Personal" and the agent is SELF. The page sends the folder name it shows.
    const w = world({ reading: { status: 'verified', label: 'Personal' } });
    const o = owner();
    await run(rename, w, o, { name: 'personal', label: 'Home' });
    const action = (o.requests[0]?.[0] as { action: JsonObject }).action;
    expect(action['agent']).toBe(SELF);
    expect((action['params'] as JsonObject)['agent']).toBe(SELF);
    expect(JSON.stringify(action)).not.toContain('Work');
    expect(JSON.stringify(o.reviews)).not.toContain('Work');
  });

  it('refuses another agent than the open one, a bad label and a bad input, signing nothing', async () => {
    for (const input of [
      { name: 'work', label: 'Home' },
      { name: 'personal', label: 'Work  agent' },
      { name: 'personal' },
      { label: 'Home' },
      { name: 'personal', label: 'Home', agent: SELF },
      { name: 'Personal!', label: 'Home' },
      'Home',
      undefined,
    ]) {
      const w = world();
      const o = owner();
      const result = await run(rename, w, o, input);
      expect(result.status, JSON.stringify(input)).toBeGreaterThanOrEqual(400);
      expect(o.requests, JSON.stringify(input)).toEqual([]);
      expect(w.applied).toEqual([]);
      expect(w.saved).toEqual([]);
    }
  });

  it('a body core prepared for another agent is never signed', async () => {
    const w = world();
    const client = w.context.client as unknown as {
      agent: { prepareLabel: (l: string) => Promise<PreparedOwnerAction> };
    };
    client.agent.prepareLabel = (label) => Promise.resolve(prepared(label, '0x' + '77'.repeat(20)));
    const o = owner();
    const result = await run(rename, w, o, { name: 'personal', label: 'Home' });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(o.requests).toEqual([]);
  });

  it('a signature core did not apply writes no config.json label', async () => {
    const w = world({ applyStatus: 'refused' });
    const o = owner();
    const result = await run(rename, w, o, { name: 'personal', label: 'Home' });
    expect(result).toEqual({ status: 409, body: { error: 'not_applied' } });
    expect(w.saved).toEqual([]);
  });
});

describe('POST /api/ui/agents (add an agent; card, first policy and first label)', () => {
  it('creates the agent, signs it through the one owner operation, keeps it on success', async () => {
    const w = world();
    const o = owner('done');
    const result = await run(add, w, o, { label: 'Work agent' });
    expect(result).toEqual({
      status: 200,
      body: { status: 'done', name: 'work-agent', label: 'Work agent' },
    });
    expect(w.created).toEqual(['Work agent']);
    expect(o.added).toHaveLength(1);
    // The statement names the new agent's label (04 §2.5 "The label in every presence statement").
    expect(o.reviews[0]?.lines.join(' ')).toContain('Work agent');
    expect(w.settled).toEqual([['work-agent', true]]);
    expect(o.requests).toEqual([]);
  });

  it('all or nothing: a failed signing removes exactly the agent this request created', async () => {
    const w = world();
    const o = owner('failed');
    const result = await run(add, w, o, { label: 'Work agent' });
    expect(result).toEqual({ status: 409, body: { error: 'not_applied' } });
    expect(w.settled).toEqual([['work-agent', false]]);
  });

  it('refuses a bad label or input before anything is created or signed', async () => {
    for (const input of [
      { label: '' },
      { label: 'Work  agent' },
      { label: '<b>x</b>' },
      { label: 'Work', app: 'codex' },
      { name: 'x' },
      undefined,
    ]) {
      const w = world();
      const o = owner();
      const result = await run(add, w, o, input);
      expect(result.status, JSON.stringify(input)).toBeGreaterThanOrEqual(400);
      expect(w.created, JSON.stringify(input)).toEqual([]);
      expect(o.added).toEqual([]);
    }
  });

  it('a creation that fails signs nothing', async () => {
    const w = world({ create: 'fail' });
    const o = owner();
    const result = await run(add, w, o, { label: 'Work agent' });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(o.added).toEqual([]);
  });

  it('outside the app host (no agents port) it signs nothing', async () => {
    const w = world();
    const context = { ...w.context, agentsManage: undefined } as unknown as LocalUiContext;
    const o = owner();
    const result = await add.handler(
      context,
      { params: {}, query: new URLSearchParams(), input: { label: 'Work' } },
      o.operation,
    );
    expect(result.status).toBe(501);
    expect(o.added).toEqual([]);
  });
});

describe('W4-RENAME-REACHES-CONTACTS: a rename reaches contacts (D-141; 08 §1)', () => {
  const pre = (w: World, input: unknown) => {
    if (rename.precheck === undefined) throw new Error('no precheck');
    return rename.precheck(w.context, {
      params: {},
      query: new URLSearchParams(),
      input: input as never,
    });
  };

  it('a label that differs from the card name is one gesture that rotates (renameAgent), then the label is applied', async () => {
    const w = world({ reading: { status: 'verified', label: 'Personal' }, cardName: 'Personal' });
    const o = owner();
    const result = await run(rename, w, o, { name: 'personal', label: 'Home' });
    expect(result).toEqual({ status: 200, body: { status: 'done', label: 'Home', contacts: 2 } });
    // One owner operation: renameAgent, never `sign` as well.
    expect(o.requests).toEqual([]);
    expect(o.renamed).toHaveLength(1);
    expect(o.renamed[0]?.label).toBe('Home');
    expect(o.renamed[0]?.labelBody['op']).toBe('agent.label');
    expect(o.renamed[0]?.labelBody['params']).toEqual({ agent: SELF, label: 'Home' });
    // 11 §5.8: the statement says contacts will see the new name.
    expect(o.reviews[0]?.lines).toEqual([
      'Rename Personal to Home',
      'Your contacts will see the new name.',
    ]);
    expect(w.applied).toHaveLength(1);
    expect(w.saved).toEqual([['personal', 'Home']]);
  });

  it('a label equal to the card name changes only the label (no rotation; the repair path)', async () => {
    const w = world({ reading: { status: 'verified', label: 'Personal' }, cardName: 'Home' });
    const o = owner();
    const result = await run(rename, w, o, { name: 'personal', label: 'Home' });
    expect(result).toEqual({ status: 200, body: { status: 'done', label: 'Home' } });
    expect(o.renamed).toEqual([]);
    expect(o.requests).toHaveLength(1);
  });

  it('the precheck refuses the 4th rename in 24 h before the gesture (rename_limited, retryAt)', async () => {
    const w = world({
      cardName: 'Personal',
      allowance: { status: 'limited', retryAt: 1_800_086_400 },
    });
    expect(await pre(w, { name: 'personal', label: 'Home' })).toEqual({
      status: 409,
      body: { error: 'rename_limited', retryAt: 1_800_086_400 },
    });
    // The limit counts only renames that rotate: a label-only change is let on.
    const same = world({ cardName: 'Home', allowance: { status: 'limited', retryAt: 1 } });
    expect(await pre(same, { name: 'personal', label: 'Home' })).toBeUndefined();
  });

  it('the precheck refuses while an earlier rotation is unfinished (rotation_pending)', async () => {
    const w = world({ cardName: 'Personal', sendState: 'rotation_pending' });
    expect(await pre(w, { name: 'personal', label: 'Home' })).toEqual({
      status: 409,
      body: { error: 'rotation_pending' },
    });
    expect(await pre(world({ cardName: 'Personal' }), { name: 'personal', label: 'Home' })).toBe(
      undefined,
    );
  });

  it('the gate refusing the rename signs no label and writes nothing', async () => {
    const w = world({ cardName: 'Personal' });
    const o = owner('done', { status: 'refused', reason: 'rename_limited', retryAt: 99 });
    const result = await run(rename, w, o, { name: 'personal', label: 'Home' });
    expect(result).toEqual({ status: 409, body: { error: 'rename_limited', retryAt: 99 } });
    expect(w.applied).toEqual([]);
    expect(w.saved).toEqual([]);
  });

  it('without the rename operation (outside the app host) a renaming label is not_available', async () => {
    const w = world({ cardName: 'Personal' });
    const o = owner();
    const { renameAgent: _dropped, ...operation } = o.operation;
    void _dropped;
    const result = await rename.handler(
      w.context,
      { params: {}, query: new URLSearchParams(), input: { name: 'personal', label: 'Home' } },
      operation,
    );
    expect(result.status).toBe(501);
    expect(o.requests).toEqual([]);
  });

  it('GET /api/ui/agents/card-name: "Contacts still see {cardName}" only when the label differs', async () => {
    const read = (w: World) =>
      cardNameRead.handler(w.context, { params: {}, query: new URLSearchParams() });
    expect(
      await read(world({ reading: { status: 'verified', label: 'Home' }, cardName: 'My agent' })),
    ).toEqual({ status: 200, body: { status: 'differs', cardName: 'My agent' } });
    expect(
      await read(world({ reading: { status: 'verified', label: 'Home' }, cardName: 'Home' })),
    ).toEqual({ status: 200, body: { status: 'same' } });
    // No verified label: nothing to update.
    expect(await read(world({ reading: { status: 'none' }, cardName: 'My agent' }))).toEqual({
      status: 200,
      body: { status: 'same' },
    });
    expect(cardNameRead.presence).toBe(false);
  });
});
