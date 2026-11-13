// RET-7 (D-148 (3); 06 §1 rule 3; 08 §1; I-4): the app link of an `agentlink_tidy` proposal.
// - `<origin>` plus the fixed Storage page with the AI's filter, and nothing else: a page that is not
//   exactly `/settings/storage?tidy=files|both&days=30|90|365[&contact=0x…]` gives no link.
// - Like the Allow a folder link it is given only while a browser holds this server's session; when
//   none does yet, Home opens once (same one-shot rules and interval). It holds no secret and grants
//   nothing: the page needs the owner's session and the delete needs presence.
import type { ApprovalServer } from '@4thtech-io/node';
import { createLogger } from '@4thtech-io/log';
import { describe, expect, it, vi } from 'vitest';
import { createApprovalUi } from './approval-ui.js';

const ORIGIN = 'http://localhost:47321';
const MARKO = `0x${'b'.repeat(40)}`;
const silent = createLogger({ sink: () => undefined });

function server(origin = ORIGIN, homes: number[] = [], opens = true): ApprovalServer {
  const port = Number(new URL(origin).port);
  return {
    origin,
    port,
    address: () => ({ host: 'localhost', port, addresses: ['127.0.0.1'] }),
    activity: { lastAt: () => Date.now(), openStreams: () => 0, linksUsed: () => 0 },
    approvalUrl: (id: string) => `${origin}/approve/${id}`,
    open: () => Promise.resolve(true),
    openFirstRun: () => Promise.resolve(true),
    openHome: () => {
      homes.push(1);
      return Promise.resolve(opens);
    },
    openJoin: () => Promise.resolve(true),
    openUpdates: () => Promise.resolve(true),
    desktopAlerts: () => Promise.resolve(undefined),
    ownerNames: () => Promise.resolve(new Map<string, string>()),
    notifyNewApproval: (id: string) => Promise.resolve(`${origin}/approve/${id}`),
    close: () => Promise.resolve(),
  } as unknown as ApprovalServer;
}

const ui = (s: ApprovalServer) => {
  const start = vi.fn(() => Promise.resolve(s));
  return { ui: createApprovalUi({ start, agentName: 'default', logger: silent }), start };
};

describe('RET-7: the tidy proposal link (Settings › Storage with the filter)', () => {
  it('gives exactly origin + the fixed page; opens Home once when no browser holds the session', async () => {
    const homes: number[] = [];
    const { ui: approvalUi } = ui(server(ORIGIN, homes));
    const page = `/settings/storage?tidy=files&days=90&contact=${MARKO}`;
    expect(await approvalUi.tidyLink?.(page)).toEqual({ url: `${ORIGIN}${page}`, origin: ORIGIN });
    await approvalUi.tidyLink?.('/settings/storage?tidy=both&days=30');
    expect(homes).toHaveLength(1);
    await approvalUi.close();
  });

  it('any other page gives no link (and starts nothing)', async () => {
    const { ui: approvalUi, start } = ui(server());
    for (const page of [
      '/approve/apr_AAAAAAAAAAAAAAAAAAAAAA',
      '/settings/storage',
      '/settings/storage?tidy=all&days=90',
      '/settings/storage?tidy=files&days=1',
      '/settings/storage?tidy=files&days=90&contact=Marko',
      '/settings/storage?tidy=files&days=90&t=SESSION',
      'https://evil.example/settings/storage?tidy=files&days=90',
    ]) {
      expect(await approvalUi.tidyLink?.(page), page).toBeUndefined();
    }
    expect(start).not.toHaveBeenCalled();
    await approvalUi.close();
  });

  it('no browser: no link; a server off the local UI origin: no link', async () => {
    const { ui: none } = ui(server(ORIGIN, [], false));
    expect(await none.tidyLink?.('/settings/storage?tidy=files&days=90')).toBeUndefined();
    await none.close();
    const { ui: odd } = ui(server('http://127.0.0.1:47321'));
    expect(await odd.tidyLink?.('/settings/storage?tidy=files&days=90')).toBeUndefined();
    await odd.close();
  });
});
