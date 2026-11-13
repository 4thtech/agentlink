// @vitest-environment jsdom
// REL051-B2 (owner test, 13 Nov; replaces W5-INVITE-FEEDBACK "stop the double-create"): the app
// now keeps every open invite's link (sealed, on this computer), so an invite is never orphaned:
// it waits under Home and People with Copy link, Show link and Cancel invite. The panel therefore
// cancels nothing when the page hides or reloads and keeps nothing in the tab's storage. Only an
// explicit "Skip for now" in Get started (`discard`) ends a link that never left the screen.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateOutcome, InviteApi, LinkOutcome } from '../contacts/invite-api.js';
import { InvitePanel } from './invite-panel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID_1 = 'AQEBAQEBAQEBAQEBAQEBAQ';
const LINK = `https://agentlink.4thtech.io/i#2.${'A'.repeat(43)}`;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function fake(ids: string[], linkOf: (id: string) => LinkOutcome = () => ({ kind: 'not_found' })) {
  const cancelled: { id: string; keepalive: boolean }[] = [];
  const created: string[] = [];
  const linked: string[] = [];
  const api: InviteApi = {
    link: (id) => {
      linked.push(id);
      return Promise.resolve(linkOf(id));
    },
    create: () => {
      const id = ids.shift() ?? ID_1;
      created.push(id);
      return Promise.resolve<CreateOutcome>({
        kind: 'ok',
        invite: {
          inviteUrl: LINK,
          shareText: `Add my AI agent on AgentLink: ${LINK}`,
          expiresAt: Date.UTC(2999, 0, 1),
          format: 'short',
          inviteId: id,
        },
      });
    },
    cancel: (id, options) => {
      cancelled.push({ id, keepalive: options?.keepalive === true });
      return Promise.resolve({ kind: 'cancelled' });
    },
    check: () => Promise.resolve({ kind: 'failed' }),
    accept: () => Promise.resolve({ kind: 'failed' }),
  };
  return { api, cancelled, created, linked };
}

/** IR-REL051-B2-1 (4): the invite this screen made, by its public ID, for a reload. */
const SCREEN_KEY = 'agentlink.screenInvite';

/** The tab key an older build used for unsent invite IDs (W5-INVITE-FEEDBACK). */
const OLD_KEY = 'agentlink.unsentInvites';

describe('an invite is kept when the page goes (REL051-B2)', () => {
  it('a page that hides cancels nothing; the tab keeps only the public ID of the invite on screen', async () => {
    const { api, cancelled } = fake([ID_1]);
    await act(async () => {
      root.render(createElement(InvitePanel, { invites: api }));
    });
    await settle();
    expect(Object.keys(sessionStorage)).toEqual([SCREEN_KEY]);
    expect(sessionStorage.getItem(SCREEN_KEY)).toContain(ID_1);
    expect(sessionStorage.getItem(SCREEN_KEY)).not.toContain('agentlink.4thtech.io');
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    act(() => root.unmount());
    root = createRoot(host);
    await settle();
    expect(cancelled).toEqual([]);
  });

  it('an ID an older build left in the tab is never cancelled, and the key is cleared', async () => {
    sessionStorage.setItem(OLD_KEY, JSON.stringify([ID_1]));
    const { api, cancelled } = fake(['BwcHBwcHBwcHBwcHBwcHBw']);
    await act(async () => {
      root.render(createElement(InvitePanel, { invites: api }));
    });
    await settle();
    expect(cancelled).toEqual([]);
    expect(sessionStorage.getItem(OLD_KEY)).toBeNull();
  });

  it('Skip for now (discard) ends a link that never left the screen; a copied one stays', async () => {
    const discard = { current: false };
    const first = fake([ID_1]);
    await act(async () => {
      root.render(createElement(InvitePanel, { invites: first.api, discard }));
    });
    await settle();
    discard.current = true;
    act(() => root.unmount());
    root = createRoot(host);
    await settle();
    expect(first.cancelled.map((c) => c.id)).toEqual([ID_1]);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
    const kept = { current: false };
    const second = fake([ID_1]);
    await act(async () => {
      root.render(createElement(InvitePanel, { invites: second.api, discard: kept }));
    });
    await settle();
    await act(async () => {
      const copy = [...host.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Copy'),
      );
      copy?.click();
    });
    await settle();
    kept.current = true;
    act(() => root.unmount());
    root = createRoot(host);
    await settle();
    expect(second.cancelled).toEqual([]);
  });

  // IR-REL051-B2-1 (4): the double-create guard, now that leaving keeps the invite.
  it('a reload shows the invite this screen made again instead of making another', async () => {
    const { api, created, linked } = fake(['BwcHBwcHBwcHBwcHBwcHBw'], (id) =>
      id === ID_1
        ? {
            kind: 'ok',
            inviteUrl: LINK,
            shareText: `Add my AI agent on AgentLink: ${LINK}`,
            format: 'short',
            expiresAt: Date.UTC(2999, 0, 1),
          }
        : { kind: 'not_found' },
    );
    // What the first load of this tab left (the page was reloaded: nothing unmounted).
    sessionStorage.setItem(SCREEN_KEY, JSON.stringify({ id: ID_1, label: '' }));
    await act(async () => {
      root.render(createElement(InvitePanel, { invites: api }));
    });
    await settle();
    expect(linked).toEqual([ID_1]);
    expect(created).toEqual([]);
    expect(host.textContent).toContain(LINK);
  });

  it('an invite gone meanwhile (accepted, cancelled, expired) is not reused: one new invite', async () => {
    const { api, created } = fake([ID_1]);
    sessionStorage.setItem(SCREEN_KEY, JSON.stringify({ id: 'BwcHBwcHBwcHBwcHBwcHBw', label: '' }));
    await act(async () => {
      root.render(createElement(InvitePanel, { invites: api }));
    });
    await settle();
    expect(created).toEqual([ID_1]);
    expect(sessionStorage.getItem(SCREEN_KEY)).toContain(ID_1);
  });

  // REL051-R2C (R2-UI-05): looking at Invite someone never piles up nameless waiting invites.
  it('leaving an unnamed invite that went nowhere keeps it as the one draft: the next visit shows it again', async () => {
    const { api, created, cancelled, linked } = fake([ID_1, 'BwcHBwcHBwcHBwcHBwcHBw'], (id) =>
      id === ID_1
        ? {
            kind: 'ok',
            inviteUrl: LINK,
            shareText: `Add my AI agent on AgentLink: ${LINK}`,
            format: 'short',
            expiresAt: Date.UTC(2999, 0, 1),
          }
        : { kind: 'not_found' },
    );
    await act(async () => {
      root.render(createElement(InvitePanel, { invites: api }));
    });
    await settle();
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => {
      root.render(createElement(InvitePanel, { invites: api }));
    });
    await settle();
    expect(created).toEqual([ID_1]);
    expect(linked).toEqual([ID_1]);
    expect(cancelled).toEqual([]);
  });

  it('leaving after the link went out (Copy) forgets it: the next Invite someone makes a new invite', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
    const { api, created, cancelled } = fake([ID_1, 'BwcHBwcHBwcHBwcHBwcHBw']);
    await act(async () => {
      root.render(createElement(InvitePanel, { invites: api }));
    });
    await settle();
    await act(async () => {
      const copy = [...host.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Copy'),
      );
      copy?.click();
    });
    await settle();
    act(() => root.unmount());
    root = createRoot(host);
    expect(sessionStorage.getItem(SCREEN_KEY)).toBeNull();
    await act(async () => {
      root.render(createElement(InvitePanel, { invites: api }));
    });
    await settle();
    expect(created).toEqual([ID_1, 'BwcHBwcHBwcHBwcHBwcHBw']);
    expect(cancelled).toEqual([]);
  });
});
