// @vitest-environment jsdom
// M1-11b-1: the shared states (d1 Local-states, `shared-states--all`) with the UX audit fixes:
// copy as designed, the non-technical path first, no "owner actions blocked" and no web3 words; the
// recovery-kit "Later" flag (D-120 (2)) holds nothing secret and survives a refusing storage.
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorState,
  LinkExpiredState,
  LoadingState,
  NetworkBanner,
  NotAvailablePage,
  NotFoundPage,
  NotRunningState,
  NothingWaiting,
  RECOVERY_KIT_LATER_KEY,
  RecoveryKitBanner,
  STATE_STRINGS,
  SetupUnfinishedBanner,
  connectionOf,
  forgetRecoveryKitLater,
  recoveryKitPending,
  rememberRecoveryKitLater,
} from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function show(element: ReactElement): string {
  act(() => root.render(element));
  return host.textContent ?? '';
}

const BANNED = /\b(wallet|gas|seed|transaction|chain|hash|key|address|localhost|blocked)\b/i;

describe('shared states (d1 Local-states)', () => {
  it('link expired: the AI path first, then the terminal command', () => {
    const text = show(h(LinkExpiredState));
    expect(text).toContain('This link has expired');
    expect(text.indexOf('Ask your AI')).toBeLessThan(text.indexOf('agentlink ui'));
  });

  it('not running: plain words and agentlink doctor', () => {
    const text = show(h(NotRunningState));
    expect(text).toContain("AgentLink isn't running");
    expect(text).toContain('agentlink doctor');
  });

  it('setup unfinished: one action back to first run, no "owner actions blocked"', () => {
    const text = show(h(SetupUnfinishedBanner));
    expect(text).toContain('Finish setup to approve.');
    expect(text.toLowerCase()).not.toContain('owner actions');
    const links = host.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('/first-run');
  });

  it('recovery kit banner, and the stronger reminder after the first contact', () => {
    expect(show(h(RecoveryKitBanner))).toContain(STATE_STRINGS.kitPendingTitle);
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/settings/backup');
    expect(show(h(RecoveryKitBanner, { afterFirstContact: true }))).toContain(
      STATE_STRINGS.kitPendingAfterContact,
    );
  });

  it('network states', () => {
    expect(show(h(NetworkBanner, { state: 'slow' }))).toContain('arriving slowly');
    expect(show(h(NetworkBanner, { state: 'offline' }))).toContain(
      "Can't reach the message network.",
    );
    expect(show(h(NetworkBanner, { state: 'back', newMessages: 2 }))).toBe(
      'Back online. 2 new messages.',
    );
    expect(show(h(NetworkBanner, { state: 'back', newMessages: 1 }))).toBe(
      'Back online. 1 new message.',
    );
  });

  it('empty, loading and error', () => {
    const empty = show(h(NothingWaiting));
    expect(empty).toContain('Nothing waiting for you.');
    expect(empty).toContain('Create an AgentLink invite for a colleague.');
    expect(show(h(LoadingState))).toContain('Checking for new messages');
    let retried = 0;
    show(
      h(ErrorState, { title: 'It failed.', body: 'Nothing changed.', onRetry: () => retried++ }),
    );
    act(() => host.querySelector('button')?.click());
    expect(retried).toBe(1);
  });

  it('not available and not found keep the shell copy', () => {
    expect(show(h(NotAvailablePage, { title: 'Files' }))).toContain('available yet');
    expect(show(h(NotFoundPage))).toContain("This page isn't here.");
  });

  it('no default state uses web3 or key words (11 §5.1)', () => {
    for (const element of [
      h(LinkExpiredState),
      h(NotRunningState),
      h(SetupUnfinishedBanner),
      h(RecoveryKitBanner),
      h(RecoveryKitBanner, { afterFirstContact: true }),
      h(NetworkBanner, { state: 'offline' }),
      h(NothingWaiting),
    ]) {
      expect(show(element)).not.toMatch(BANNED);
    }
  });

  it('the status bar connection follows the API answer', () => {
    expect(connectionOf({ kind: 'offline' })).toBe('offline');
    expect(connectionOf({ kind: 'ok' })).toBe('connected');
    expect(connectionOf({ kind: 'session_expired' })).toBe('connected');
  });
});

describe('recovery kit "Later" flag (D-120 (2))', () => {
  it('remembers only a time, and is forgotten when the kit is saved', () => {
    expect(recoveryKitPending()).toBe(false);
    rememberRecoveryKitLater(1_800_000_000_000);
    expect(localStorage.getItem(RECOVERY_KIT_LATER_KEY)).toBe('1800000000000');
    expect(recoveryKitPending()).toBe(true);
    forgetRecoveryKitLater();
    expect(recoveryKitPending()).toBe(false);
  });

  it('a malformed value is not a pending kit; a refusing storage throws nothing', () => {
    localStorage.setItem(RECOVERY_KIT_LATER_KEY, 'yes');
    expect(recoveryKitPending()).toBe(false);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => rememberRecoveryKitLater()).not.toThrow();
    expect(recoveryKitPending()).toBe(false);
  });
});
