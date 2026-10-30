// @vitest-environment jsdom
// U3-invite (b11 §33.2): "Accept {name}'s invite?" and its states. The inviter is text only; the
// accept is bound to the shown inviteId; Touch ID cancelled keeps the card; "Not now" forgets it;
// the safety code is never shown before the pairing completed; first run ends here when an invite
// waits.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import type { PresenceProof } from '../contacts/owner.js';
import { endFirstRun } from '../first-run/index.js';
import type { JoinAcceptOutcome, JoinApi, JoinRead, JoinState } from './api.js';
import { JoinPage, TEN_MINUTES_MS, type JoinPageProps } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INVITE = {
  inviteId: 'AQEBAQEBAQEBAQEBAQEBAQ',
  name: 'Marko',
  fingerprint: '7F3A·19C2',
  expiresAt: Date.UTC(2027, 0, 15),
};

function fakeApi(states: JoinState[], accept: JoinAcceptOutcome = { kind: 'pending' }) {
  const calls = { accepted: [] as { id: string; proof: PresenceProof }[], dismissed: 0, reads: 0 };
  let at = 0;
  const api: JoinApi = {
    read: () => {
      calls.reads += 1;
      const state = states[Math.min(at, states.length - 1)] ?? 'none';
      const answer: JoinRead =
        state === 'none'
          ? { kind: 'ok', state }
          : { kind: 'ok', state, invite: INVITE, agent: 'Claude Code agent' };
      return Promise.resolve(answer);
    },
    accept: (id, proof) => {
      calls.accepted.push({ id, proof });
      at += 1;
      return Promise.resolve(accept);
    },
    dismiss: () => {
      calls.dismissed += 1;
      return Promise.resolve('dismissed');
    },
  };
  return { api, calls, advance: () => (at += 1) };
}

let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  vi.useRealTimers();
});

async function render(props: JoinPageProps): Promise<void> {
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(JoinPage, { platform: 'mac', ...props }));
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const text = (): string => host.textContent ?? '';
const button = (label: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
};
const click = async (label: string): Promise<void> => {
  await act(async () => {
    button(label).click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};
const PASSKEY = () => Promise.resolve({ credentialId: 'c', prfSalt: 's' });

const MARKO_REF = '0x7f3a19c200000000000000000000000000000001';
/** This app's contacts and the safety code, for the Connected moment. */
function contactsApi(): ApiClient & { paths: string[] } {
  const paths: string[] = [];
  const answer = (path: string): unknown =>
    path === '/api/ui/contacts'
      ? {
          status: 'ok',
          contacts: [
            {
              ref: MARKO_REF,
              name: 'Marko',
              nameSource: 'counterparty',
              fingerprint: '7F3A19C2AB12CD34',
              label: 'self-declared',
              status: 'active',
              pairing: 'complete',
              since: 1_800_000_000,
            },
          ],
        }
      : { status: 'ok', code: '4821 0937 5512' };
  return {
    paths,
    get: <T>(path: string) => {
      paths.push(path);
      return Promise.resolve({ kind: 'ok', status: 200, data: answer(path) } as ApiResult<T>);
    },
    post: () => Promise.resolve({ kind: 'error', status: 500 }),
    owner: () => Promise.resolve({ kind: 'error', status: 500 }),
  };
}

describe('the waiting card (b11 §33.2; W4 A6 Friend accepts)', () => {
  it('shows who invites you as text, For: the agent, and the fingerprint line, never a code', async () => {
    const { api } = fakeApi(['waiting']);
    await render({ api, passkey: PASSKEY });
    expect(host.querySelector('h1')?.textContent).toBe('Marko invites you to connect your AIs');
    expect(text()).toContain("Check it's Marko: 7F3A·19C2");
    expect(text()).toContain('Name set by the sender');
    expect(text()).toContain(
      "Your AI and Marko's agent can then send each other messages and files. Encrypted end to end. You approve anything that matters.",
    );
    expect(text()).toContain('For: Claude Code agent');
    expect(text()).not.toMatch(/\d{4} \d{4} \d{4}/);
    expect(button('Accept with Touch ID')).toBeDefined();
    expect(button('Not now')).toBeDefined();
    // Never a link, and the name never becomes markup.
    expect(host.innerHTML).not.toContain('agentlink.4thtech.io');
  });

  it('a hostile name stays text', async () => {
    const { api } = fakeApi(['waiting']);
    const hostile = {
      ...api,
      read: async () => ({
        ...(await api.read()),
        invite: { ...INVITE, name: '<img src=x onerror=alert(1)>' },
      }),
    } as JoinApi;
    await render({ api: hostile, passkey: PASSKEY });
    expect(host.querySelector('img')).toBeNull();
    expect(text()).toContain('<img src=x onerror=alert(1)>');
  });

  it('Accept with Touch ID: one accept bound to the shown inviteId, then Waiting for them', async () => {
    const { api, calls } = fakeApi(['waiting', 'waiting_for_them']);
    const proof: PresenceProof = { kind: 'passkey', body: new Uint8Array([9]) };
    await render({ api, passkey: PASSKEY, gesture: () => Promise.resolve(proof) });
    await click('Accept with Touch ID');
    expect(calls.accepted).toEqual([{ id: INVITE.inviteId, proof }]);
    expect(host.querySelector('h1')?.textContent).toBe("Waiting for Marko's agent to answer.");
    expect(text()).not.toMatch(/safety code with Marko$/);
  });

  it('Touch ID cancelled: "Not accepted yet. Try again." and the card stays; nothing sent', async () => {
    const { api, calls } = fakeApi(['waiting']);
    await render({ api, passkey: PASSKEY, gesture: () => Promise.resolve(undefined) });
    await click('Accept with Touch ID');
    expect(calls.accepted).toEqual([]);
    expect(text()).toContain('Not accepted yet. Try again.');
    expect(host.querySelector('h1')?.textContent).toBe('Marko invites you to connect your AIs');
  });

  it('no passkey: the backup code prompt', async () => {
    const { api } = fakeApi(['waiting']);
    await render({ api, passkey: () => Promise.resolve(undefined) });
    await click('Accept with your backup code');
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
  });

  it('the rules refuse new contacts: says so (the server answers policy_denied before presence)', async () => {
    const { api } = fakeApi(['waiting'], { kind: 'policy_denied' });
    await render({
      api,
      passkey: PASSKEY,
      gesture: () => Promise.resolve({ kind: 'passkey', body: new Uint8Array([1]) }),
    });
    await click('Accept with Touch ID');
    expect(text()).toContain("Your rules don't allow new contacts.");
    expect(text()).not.toContain('Not accepted yet');
  });

  it('invite_changed: says so and reads again; nothing else', async () => {
    const { api } = fakeApi(['waiting'], { kind: 'invite_changed' });
    await render({
      api,
      passkey: PASSKEY,
      gesture: () => Promise.resolve({ kind: 'passkey', body: new Uint8Array([1]) }),
    });
    await click('Accept with Touch ID');
    expect(text()).toContain('The invite on this screen changed.');
  });

  it('Not now forgets the invite here and says nothing was shared; the link still works', async () => {
    const { api, calls } = fakeApi(['waiting']);
    const go = vi.fn();
    await render({ api, passkey: PASSKEY, go });
    await click('Not now');
    expect(calls.dismissed).toBe(1);
    expect(go).not.toHaveBeenCalled();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'No problem. Nothing was shared. The link works until 15 Jan.',
    );
    await click('Go to Home');
    expect(go).toHaveBeenCalledWith('/');
  });
});

describe('the other states (b11 §33.2)', () => {
  it('waiting for them adds the 10-minute line after 10 minutes', async () => {
    let clock = 1_000_000;
    const { api } = fakeApi(['waiting_for_them']);
    await render({ api, now: () => clock, pollMs: 20 });
    expect(text()).not.toContain('If nothing happens');
    clock += TEN_MINUTES_MS;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(text()).toContain(
      "If nothing happens, the invite may have been used already or Marko's AI app isn't running. Ask Marko to check, or for a new invite.",
    );
  });

  it('connected: the Connected moment with the 12-digit safety code, then Done goes Home', async () => {
    const { api } = fakeApi(['connected']);
    const contacts = contactsApi();
    const go = vi.fn();
    await render({ api, go, contacts });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector('h1')?.textContent).toBe('You and Marko are connected');
    expect(contacts.paths).toContain(`/api/ui/contacts/${MARKO_REF}/safety-code`);
    expect(text()).toContain('4821');
    await click('Done');
    expect(go).toHaveBeenCalledWith('/');
  });

  it('expired, own and already accepted: one sentence each and Go to Home', async () => {
    for (const [state, sentence] of [
      ['expired', 'This invite has expired. Ask Marko for a new one.'],
      ['own', 'This is your own invite.'],
      ['already_accepted', 'You already accepted this invite.'],
    ] as const) {
      const { api } = fakeApi([state]);
      await render({ api });
      expect(host.querySelector('h1')?.textContent, state).toBe(sentence);
      expect(button('Go to Home')).toBeDefined();
      act(() => root?.unmount());
      root = undefined;
    }
  });
});

describe('first run ends on the waiting invite (08 §4)', () => {
  it('goes to the join screen while an invite waits, else Home', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...original, assign },
      configurable: true,
    });
    try {
      await endFirstRun(() => Promise.resolve({ kind: 'ok', state: 'waiting', invite: INVITE }));
      await endFirstRun(() => Promise.resolve({ kind: 'ok', state: 'none' }));
      await endFirstRun(() => Promise.resolve({ kind: 'offline' }));
      expect(assign.mock.calls).toEqual([
        ['/settings/join'],
        ['/settings/home'],
        ['/settings/home'],
      ]);
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true });
    }
  });
});
