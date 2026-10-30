// W4-AUTO-SAVE (S2; D-142; 08 §1, 11 §5.7; proposed, owner confirms at merge): what the local app
// reads about files saved automatically, and the one-time notice.
// - A received item carries `savedBy: 'auto'` (only when saved) and `reason` (only when not saved,
//   one of the fixed codes); anything else is left out. Never error text, a path or a link.
// - The received page carries `autoSave: {on, folder, notice}`: the owner's own Inbox folder setting
//   with home as `~`; off and no folder while the rules are not valid.
// - `GET /api/ui/files/auto-save-notice/dismiss` dismisses the notice: display state only.
// - `POST /api/ui/files/save` (W4-FILES-SAVE, SEC-L1): an ID that names no received file is 404
//   before presence is asked.
import {
  POLICY_DEFAULTS_EFFECTIVE,
  type EffectivePolicy,
  type ReceivedFileItem,
} from '@4thtech-io/core';
import { AUTO_SAVE_NOTICE_PATH } from '@4thtech-io/types/ui-contract/auto-save';
import { describe, expect, it } from 'vitest';
import type { LocalUiContext, LocalUiReadClient } from '../context.js';
import type { LocalUiOwnerRoute, LocalUiReadRoute, LocalUiResult } from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import { displayFolder, filesIoRoutes } from './files-io.js';
import { filesSaveRoute } from './files-save.js';

const ENV = 'AQEBAQEBAQEBAQEBAQEBAQ';
const marko = { name: 'Marko Novak', label: 'self-declared', nameSource: 'counterparty' } as const;

function item(over: Partial<Record<keyof ReceivedFileItem, unknown>>): ReceivedFileItem {
  return {
    id: `${ENV}.00`,
    from: marko,
    at: 1_761_000_000,
    name: 'report.pdf',
    size: 50_000,
    state: 'not_saved',
    proof: false,
    ...over,
  } as unknown as ReceivedFileItem;
}

function context(
  items: ReceivedFileItem[],
  extra: Partial<Record<string, unknown>> = {},
): { context: LocalUiContext; dismissed: { n: number } } {
  const dismissed = { n: 0 };
  const client = {
    agentId: 'a',
    filesIo: {
      received: () => Promise.resolve({ items }),
      sent: () => Promise.resolve({ items: [] }),
      savedName: () => Promise.resolve(null),
      isReceived: (id: string) => Promise.resolve(id === `${ENV}.00`),
    },
    policy: { load: () => Promise.resolve(POLICY_DEFAULTS_EFFECTIVE) },
    autoSaveNotice: {
      due: () => Promise.resolve(dismissed.n === 0),
      dismiss: () => {
        dismissed.n += 1;
        return Promise.resolve();
      },
    },
    ...extra,
  } as unknown as LocalUiReadClient;
  return {
    dismissed,
    context: {
      client,
      ownerContext: () => Promise.resolve(undefined),
      applyOwnerAction: () => Promise.reject(new Error('no')),
      now: () => 0,
    },
  };
}

const route = (path: string): LocalUiReadRoute =>
  filesIoRoutes.find((r) => r.path === path) as LocalUiReadRoute;
const get = (path: string, ctx: LocalUiContext, query = ''): Promise<LocalUiResult> =>
  route(path).handler(ctx, { params: {}, query: new URLSearchParams(query) });

describe('received items: savedBy and reason (08 §1)', () => {
  it('passes savedBy only on a saved item and a fixed reason only on a not-saved item', async () => {
    const { context: ctx } = context([
      item({ id: `${ENV}.00`, state: 'saved', savedName: 'report.pdf', savedBy: 'auto' }),
      item({ id: `${ENV}.01`, reason: 'limit_contact' }),
      item({ id: `${ENV}.02`, reason: 'before_auto_save' }),
      item({ id: `${ENV}.03`, reason: 'ENOSPC: /Users/x/AgentLink/Inbox/a.txt' }),
      item({ id: `${ENV}.04`, state: 'expired', reason: 'limit_today', savedBy: 'auto' }),
      item({ id: `${ENV}.05`, savedBy: 'auto' }),
    ]);
    const res = await get('/api/ui/files/received', ctx);
    const items = (res.body as { items: Record<string, unknown>[] }).items;
    expect(items[0]).toMatchObject({ state: 'saved', savedBy: 'auto' });
    expect(items[1]).toMatchObject({ reason: 'limit_contact' });
    expect(items[2]).toMatchObject({ reason: 'before_auto_save' });
    expect(items[3]).not.toHaveProperty('reason');
    expect(items[4]).not.toHaveProperty('reason');
    expect(items[4]).not.toHaveProperty('savedBy');
    expect(items[5]).not.toHaveProperty('savedBy');
    expect(JSON.stringify(res.body)).not.toContain('/Users/');
  });
});

describe('the autoSave block and the notice (08 §1, Decision 51)', () => {
  it('carries on, the folder with home as ~, and notice; off and no folder when rules fail closed', async () => {
    const { context: ctx } = context([]);
    const res = await get('/api/ui/files/received', ctx);
    expect((res.body as { autoSave: unknown }).autoSave).toEqual({
      on: true,
      folder: '~/AgentLink/Inbox',
      notice: true,
    });
    const closed: EffectivePolicy = { mode: 'fail_closed', problem: 'invalid' };
    const { context: ctx2 } = context([], {
      policy: { load: () => Promise.resolve(closed) },
    });
    expect(
      ((await get('/api/ui/files/received', ctx2)).body as { autoSave: unknown }).autoSave,
    ).toEqual({ on: false, folder: '', notice: true });
  });

  it('the folder shows home as ~, and never resolves anything', () => {
    expect(displayFolder('/Users/ana/AgentLink/Inbox', '/Users/ana')).toBe('~/AgentLink/Inbox');
    expect(displayFolder('~/AgentLink/Inbox', '/Users/ana')).toBe('~/AgentLink/Inbox');
    expect(displayFolder('/Volumes/Disk/In', '/Users/ana')).toBe('/Volumes/Disk/In');
    expect(displayFolder('/Users/anabel/In', '/Users/ana')).toBe('/Users/anabel/In');
  });

  it('dismiss: a read-kind route, idempotent, fixed answer; the notice is gone after it', async () => {
    const { context: ctx, dismissed } = context([]);
    const r = route(AUTO_SAVE_NOTICE_PATH);
    expect(r.method).toBe('GET');
    expect(r.presence).toBe(false);
    expect((await get(AUTO_SAVE_NOTICE_PATH, ctx)).body).toEqual({ status: 'dismissed' });
    expect((await get(AUTO_SAVE_NOTICE_PATH, ctx)).body).toEqual({ status: 'dismissed' });
    expect(dismissed.n).toBe(2);
    const after = await get('/api/ui/files/received', ctx);
    expect((after.body as { autoSave: { notice: boolean } }).autoSave.notice).toBe(false);
    expect((await get(AUTO_SAVE_NOTICE_PATH, ctx, 'x=1')).status).toBe(400);
  });

  it('the routes are registered, and no route changes an auto-save setting without presence', () => {
    const registry = createLocalUiRoutes();
    const paths = registry.routes().map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain(`GET ${AUTO_SAVE_NOTICE_PATH}`);
  });
});

describe('Save precheck (W4-FILES-SAVE SEC-L1)', () => {
  it('an ID that names no received file is 404 before presence', async () => {
    const { context: ctx } = context([]);
    const precheck = (filesSaveRoute as LocalUiOwnerRoute).precheck;
    expect(precheck).toBeDefined();
    const unknown = await precheck?.(ctx, {
      params: {},
      query: new URLSearchParams(),
      input: { id: 'AgICAgICAgICAgICAgICAg.00' },
    });
    expect(unknown).toMatchObject({ status: 404, body: { error: 'not_found' } });
    const known = await precheck?.(ctx, {
      params: {},
      query: new URLSearchParams(),
      input: { id: `${ENV}.00` },
    });
    expect(known).toBeUndefined();
  });
});
