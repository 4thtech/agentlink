// @vitest-environment jsdom
// W4-WIZARD (W4 UX v2 layer 1): Get started opens by itself only while setup is incomplete, from real
// state (no owner, no agent, or no AI app connected), never from a "seen" flag; an unanswered read is
// never "incomplete". The Home card counts three steps from the same reads.
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import type { ContactRow } from '../contacts/data.js';
import { openStartIfIncomplete, shouldOpenStart } from './guard.js';
import {
  parseAgentOpen,
  readSetupState,
  setupIncomplete,
  startProgress,
  UNKNOWN_STATE,
  type SetupState,
} from './setup-state.js';
import { markAutoShown, resetAutoShown } from './store.js';

const SET_UP: SetupState = {
  owner: 'set_up',
  agent: true,
  appConnected: true,
  contacts: [],
};
const contact = (over: Partial<ContactRow> = {}): ContactRow => ({
  ref: `0x${'1'.repeat(40)}`,
  name: 'Denis',
  nameSource: 'owner',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1,
  ...over,
});

describe('setupIncomplete: real state only', () => {
  it('no owner, no agent, or no AI app connected is incomplete', () => {
    expect(setupIncomplete({ ...SET_UP, owner: 'missing' })).toBe(true);
    expect(setupIncomplete({ ...SET_UP, agent: false })).toBe(true);
    expect(setupIncomplete({ ...SET_UP, appConnected: false })).toBe(true);
  });
  it('set up, or unknown, is never incomplete', () => {
    expect(setupIncomplete(SET_UP)).toBe(false);
    expect(setupIncomplete(UNKNOWN_STATE)).toBe(false);
    expect(setupIncomplete({ ...SET_UP, appConnected: undefined })).toBe(false);
  });
});

describe('startProgress: the Home card (A4)', () => {
  it('counts connect, invite and the safety code check', () => {
    expect(startProgress({ ...SET_UP, contacts: [] }).done).toBe(1);
    const two = startProgress({ ...SET_UP, contacts: [contact()] });
    expect(two.done).toBe(2);
    expect(two.total).toBe(3);
    expect(two.steps[2]).toMatchObject({ id: 'check', done: false, name: 'Denis' });
    expect(
      startProgress({ ...SET_UP, contacts: [contact({ label: 'safety-code-checked' })] }).complete,
    ).toBe(true);
  });
  it('never shows a name the other side chose (I-5)', () => {
    const p = startProgress({ ...SET_UP, contacts: [contact({ nameSource: 'counterparty' })] });
    expect(p.steps[2]?.name).toBeNull();
  });
  it('is unknown while a read for an undone step has no answer', () => {
    expect(startProgress(UNKNOWN_STATE).unknown).toBe(true);
  });
});

describe('parseAgentOpen', () => {
  it('reads the agents list: an open agent, none, or no answer', () => {
    expect(parseAgentOpen({ switchable: true, current: 'work', agents: [] })).toBe(true);
    expect(parseAgentOpen({ switchable: true, current: null, agents: [] })).toBe(false);
    expect(parseAgentOpen({ switchable: false })).toBe(true);
    expect(parseAgentOpen({ nope: 1 })).toBeUndefined();
    expect(parseAgentOpen(undefined)).toBeUndefined();
  });
});

function client(answers: Record<string, ApiResult<unknown>>): ApiClient {
  return {
    get: (path: string) =>
      Promise.resolve(answers[path] ?? ({ kind: 'offline' } as const)) as never,
  } as unknown as ApiClient;
}
const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });

describe('readSetupState: the four reads', () => {
  it('an owner, an open agent with Claude Code and one contact', async () => {
    const state = await readSetupState({
      client: client({
        '/api/ui/first-run': ok({ owner: 'set_up' }),
        '/api/ui/agents': ok({
          switchable: true,
          generation: 1,
          current: 'work',
          label: 'Work',
          agents: [{ name: 'work', labelled: true, running: false, apps: ['claude-code'] }],
        }),
        '/api/ui/apps': ok({ apps: [] }),
        '/api/ui/contacts': ok({
          status: 'ok',
          contacts: [
            {
              ref: `0x${'2'.repeat(40)}`,
              name: 'Denis',
              nameSource: 'owner',
              label: 'self-declared',
              status: 'active',
              pairing: 'complete',
              since: 5,
            },
          ],
        }),
      }),
    });
    expect(state).toMatchObject({ owner: 'set_up', agent: true, appConnected: true });
    expect(state.contacts).toHaveLength(1);
    expect(setupIncomplete(state)).toBe(false);
  });

  it('no owner yet: no agent, no app, no contacts', async () => {
    const state = await readSetupState({
      client: client({ '/api/ui/first-run': ok({ owner: 'missing' }) }),
    });
    expect(state).toEqual({ owner: 'missing', agent: false, appConnected: false, contacts: [] });
  });

  it('an open agent with no AI app is incomplete', async () => {
    const state = await readSetupState({
      client: client({
        '/api/ui/first-run': ok({ owner: 'set_up' }),
        '/api/ui/agents': ok({
          switchable: true,
          current: 'work',
          agents: [{ name: 'work', labelled: true, running: false, apps: [] }],
        }),
        '/api/ui/apps': ok({ apps: [] }),
      }),
    });
    expect(state.appConnected).toBe(false);
    expect(setupIncomplete(state)).toBe(true);
  });

  it('failed reads are unknown, never incomplete', async () => {
    const state = await readSetupState({ client: client({}) });
    expect(state).toEqual(UNKNOWN_STATE);
    expect(setupIncomplete(state)).toBe(false);
  });
});

describe('openStartIfIncomplete: the open-on-launch check', () => {
  const incomplete = (): Promise<SetupState> => Promise.resolve({ ...SET_UP, appConnected: false });

  it('opens /start/app from Home while incomplete, once per page life', async () => {
    resetAutoShown();
    const go = vi.fn();
    expect(await openStartIfIncomplete({ path: () => '/', read: incomplete, go })).toBe(true);
    expect(go).toHaveBeenCalledWith('/start/app');
    expect(await openStartIfIncomplete({ path: () => '/', read: incomplete, go })).toBe(false);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('stays on Home once set up, on an unanswered read, and never takes over a deep link', async () => {
    resetAutoShown();
    const go = vi.fn();
    expect(
      await openStartIfIncomplete({ path: () => '/', read: () => Promise.resolve(SET_UP), go }),
    ).toBe(false);
    resetAutoShown();
    expect(
      await openStartIfIncomplete({ path: () => '/', read: () => Promise.reject(new Error()), go }),
    ).toBe(false);
    resetAutoShown();
    expect(await openStartIfIncomplete({ path: () => '/approve/abc', read: incomplete, go })).toBe(
      false,
    );
    expect(go).not.toHaveBeenCalled();
    expect(shouldOpenStart('/approve/abc', { ...SET_UP, owner: 'missing' })).toBe(false);
  });

  it('after Skip to Home (or Get started opened), it never opens by itself again', async () => {
    resetAutoShown();
    markAutoShown();
    const go = vi.fn();
    expect(await openStartIfIncomplete({ path: () => '/', read: incomplete, go })).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });

  it('stays put when the person moved on while the reads ran', async () => {
    resetAutoShown();
    let at = '/';
    const go = vi.fn();
    const read = (): Promise<SetupState> => {
      at = '/agents';
      return incomplete();
    };
    expect(await openStartIfIncomplete({ path: () => at, read, go })).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });
});
