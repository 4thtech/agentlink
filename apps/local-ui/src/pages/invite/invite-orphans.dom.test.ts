// @vitest-environment jsdom
// W5-INVITE-FEEDBACK "stop the double-create" (owner test of 0.4.6, 1 Nov: two invites 10 s apart,
// the first never used and never cancelled). A link the panel made that never left the screen is
// cancelled when the panel goes away; when the page is reloaded or closed instead, there is no
// unmount, so the panel remembers in this tab (sessionStorage: public invite IDs only, never a link)
// the invites that did not leave the screen, cancels them with a keepalive request when the page
// hides, and cancels any that are left over when it opens next.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateOutcome, InviteApi } from '../contacts/invite-api.js';
import { InvitePanel } from './invite-panel.js';
import { UNSENT_INVITES_KEY } from './unsent-invites.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID_1 = 'AQEBAQEBAQEBAQEBAQEBAQ';
const ID_2 = 'BwcHBwcHBwcHBwcHBwcHBw';
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

function fake(ids: string[]) {
  const cancelled: { id: string; keepalive: boolean }[] = [];
  const api: InviteApi = {
    create: () => {
      const id = ids.shift() ?? ID_2;
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
  return { api, cancelled };
}

describe('the double-create', () => {
  it('remembers a link that did not leave the screen, and cancels it with keepalive on pagehide', async () => {
    const { api, cancelled } = fake([ID_1]);
    await act(async () => {
      root.render(createElement(InvitePanel, { invites: api }));
    });
    await settle();
    expect(JSON.parse(sessionStorage.getItem(UNSENT_INVITES_KEY) ?? '[]')).toEqual([ID_1]);
    expect(sessionStorage.getItem(UNSENT_INVITES_KEY)).not.toContain('agentlink.4thtech.io');
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(cancelled).toEqual([{ id: ID_1, keepalive: true }]);
  });

  it('cancels a link left over from the last load before it makes a new one', async () => {
    sessionStorage.setItem(UNSENT_INVITES_KEY, JSON.stringify([ID_1]));
    const { api, cancelled } = fake([ID_2]);
    await act(async () => {
      root.render(createElement(InvitePanel, { invites: api }));
    });
    await settle();
    expect(cancelled.map((c) => c.id)).toEqual([ID_1]);
    expect(JSON.parse(sessionStorage.getItem(UNSENT_INVITES_KEY) ?? '[]')).toEqual([ID_2]);
  });

  it('a copied link is never cancelled and is forgotten', async () => {
    const { api, cancelled } = fake([ID_1]);
    await act(async () => {
      root.render(createElement(InvitePanel, { invites: api }));
    });
    await settle();
    await act(async () => {
      document.dispatchEvent(new Event('copy'));
      const copy = [...host.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Copy'),
      );
      copy?.click();
    });
    await settle();
    expect(JSON.parse(sessionStorage.getItem(UNSENT_INVITES_KEY) ?? '[]')).toEqual([]);
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(cancelled).toEqual([]);
  });

  it('ignores a stored value of another shape', async () => {
    sessionStorage.setItem(UNSENT_INVITES_KEY, '{"x":1}');
    const { api, cancelled } = fake([ID_1]);
    await act(async () => {
      root.render(createElement(InvitePanel, { invites: api }));
    });
    await settle();
    expect(cancelled).toEqual([]);
  });
});
