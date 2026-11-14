// WIN-BROKEN-ID (04 §2.5 "An ID whose key is missing"; 11 §5): an ID folder whose identity key is
// gone from this computer's keychain (a leftover folder, a keychain entry removed) is told apart from
// every other start failure, and never ends the start: another ID opens instead ("Continue without
// it"), or, with none left, the app host starts with no ID open so Home can offer Restore or Remove.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAgentConfig } from '../runtime/agent-dir.js';
import { brokenIds, isIdentityMissing } from '../runtime/broken-id.js';
import { UI_TEXT, diagnoseStart, startUiServer, type UiDeps, type UiServer } from './ui.js';

const PREFIX = 'npx -y @4thtech-io/agentlink';
const newId = (): string => `0x${encodeHex(randomBytes(20))}`;

let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-broken-id-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** An error as the keychain KeyStore throws it when the seed or store key is missing. */
const missing = (): Error =>
  Object.assign(new Error('This ID has no identity on this computer.'), {
    code: 'identity_missing',
  });

const server = (name: string): UiServer & { readonly name: string } => ({
  name,
  page: 'home',
  open: () => Promise.resolve(true),
  close: () => Promise.resolve(),
});

describe('isIdentityMissing (WIN-BROKEN-ID)', () => {
  it('is true only for the identity_missing code', () => {
    expect(isIdentityMissing(missing())).toBe(true);
    expect(isIdentityMissing(Object.assign(new Error('x'), { code: 'keychain_failed' }))).toBe(
      false,
    );
    expect(isIdentityMissing(new Error('identity_missing'))).toBe(false);
    expect(isIdentityMissing(undefined)).toBe(false);
  });
});

describe('diagnoseStart: identity_missing is its own reason (WIN-BROKEN-ID)', () => {
  it('a folder whose key is missing is broken_id, not open', async () => {
    await writeAgentConfig(home, { v: 1, name: 'default', agentId: newId(), keyStore: 'keychain' });
    const reason = await diagnoseStart(home, {
      keychainUsable: () => Promise.resolve(true),
      identityMissing: () => Promise.resolve(true),
    });
    expect(reason).toBe('broken_id');
  });

  it('a folder whose key is here stays open (another failure)', async () => {
    await writeAgentConfig(home, { v: 1, name: 'default', agentId: newId(), keyStore: 'keychain' });
    const reason = await diagnoseStart(home, {
      keychainUsable: () => Promise.resolve(true),
      identityMissing: () => Promise.resolve(false),
    });
    expect(reason).toBe('open');
  });

  it('a probe that fails is not taken as broken (fails to the generic reason)', async () => {
    await writeAgentConfig(home, { v: 1, name: 'default', agentId: newId(), keyStore: 'keychain' });
    const reason = await diagnoseStart(home, {
      keychainUsable: () => Promise.resolve(true),
      identityMissing: () => Promise.reject(new Error('locked')),
    });
    expect(reason).toBe('open');
  });

  it('the line says the key is missing and what to do; never "couldn\'t open its page"', () => {
    const line = UI_TEXT.startFailure.broken_id(PREFIX);
    expect(line).toContain("can't be opened");
    expect(line).toContain('restore');
    expect(line).not.toContain('its page');
    expect(line).not.toMatch(/wallet|seed phrase|gas|transaction/i);
  });
});

describe('startUiServer: Continue without it (WIN-BROKEN-ID)', () => {
  it('when the chosen ID is broken, another ID opens and the broken one is noted', async () => {
    const tried: (string | undefined)[] = [];
    const noted: string[] = [];
    const deps: UiDeps = {
      agents: () => Promise.resolve(['default', 'work']),
      lastUsed: () => Promise.resolve(undefined),
      start: (name) => {
        tried.push(name);
        if (name === undefined || name === 'default') return Promise.reject(missing());
        return Promise.resolve(server(name));
      },
      noteBroken: (name) => {
        noted.push(name);
      },
      waitMs: 60_000,
      interrupt: () => () => undefined,
    };
    const started = await startUiServer(deps, undefined);
    expect(started.ok).toBe(true);
    expect(started.ok && (started.server as UiServer & { name?: string }).name).toBe('work');
    expect(noted).toEqual(['default']);
    expect(tried).toEqual([undefined, 'work']);
  });

  it('when every ID is broken, the app host starts with no ID open (Home offers the choices)', async () => {
    const noted: string[] = [];
    let welcome = 0;
    const deps: UiDeps = {
      agents: () => Promise.resolve(['default']),
      lastUsed: () => Promise.resolve(undefined),
      start: () => Promise.reject(missing()),
      noteBroken: (name) => {
        noted.push(name);
      },
      startWelcome: () => {
        welcome += 1;
        return Promise.resolve(server('none'));
      },
      waitMs: 60_000,
      interrupt: () => () => undefined,
    };
    const started = await startUiServer(deps, undefined);
    expect(started.ok).toBe(true);
    expect(welcome).toBe(1);
    expect(noted).toEqual(['default']);
  });

  it('an explicit --agent that is broken is not swapped for another ID', async () => {
    const tried: (string | undefined)[] = [];
    const deps: UiDeps = {
      agents: () => Promise.resolve(['default', 'work']),
      start: (name) => {
        tried.push(name);
        return Promise.reject(missing());
      },
      diagnose: () => Promise.resolve('broken_id'),
      waitMs: 60_000,
      interrupt: () => () => undefined,
    };
    const started = await startUiServer(deps, 'default');
    expect(started).toEqual({ ok: false, failure: 'broken_id' });
    expect(tried).toEqual(['default']);
  });
});

describe('brokenIds (WIN-BROKEN-ID): the names whose open failed for a missing key', () => {
  it('is per home, and a name is cleared once it opens', () => {
    const ids = brokenIds(home);
    ids.note('default');
    expect(brokenIds(home).has('default')).toBe(true);
    expect(brokenIds(join(home, 'other')).has('default')).toBe(false);
    ids.clear('default');
    expect(brokenIds(home).has('default')).toBe(false);
    ids.note('NOT A NAME');
    expect(brokenIds(home).has('NOT A NAME')).toBe(false);
  });
});
