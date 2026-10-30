// @vitest-environment jsdom
// W4-PEOPLE-INVITE (prototype v23 A3/A5; D-139 short invites; 11 §5): the Invite screen and its
// panel (exported for Get started step 4).
//
// - The short link is made at once and shown as text only (never in an attribute, the title or the
//   address). "Invite link for {name}" follows the optional name, which is only for your list.
// - Copy puts the link on the clipboard and shows the ✓ "Copied" moment; Email opens the mail app
//   with the share text; Share appears only where the browser has a share sheet for text.
// - A name typed before the link went anywhere makes a fresh link with that name (the old one is
//   cancelled), and a link that never left the screen is cancelled when you leave it.
// - Under the hood: the invite's facts, a long link and the QR code. The long-link fallback (the
//   drop is down) says so in plain words.
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import type { CreateOutcome, InviteApi } from '../contacts/invite-api.js';
import { InvitePanel, InviteScreen, type InvitePanelProps } from './index.js';
import { INVITE_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SHORT_A = 'https://agentlink.4thtech.io/i#2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SHORT_B = 'https://agentlink.4thtech.io/i#2.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const LONG = `https://agentlink.4thtech.io/i#${'L'.repeat(300)}`;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 30, 12);
const EXPIRES = NOW + 7 * DAY;

interface World {
  readonly invites: InviteApi;
  readonly api: ApiClient;
  readonly created: { label: string | undefined; long: boolean }[];
  readonly cancelled: string[];
}

interface WorldOptions {
  /** The drop is down: every link falls back to the long one. */
  readonly fallback?: boolean;
  /** Every list read fails (the page must never need it to cancel). */
  readonly listFails?: boolean;
  /** Before each create, another invite is made elsewhere (the AI app's MCP, another tab). */
  readonly concurrent?: boolean;
}

/**
 * A fake server: each create adds an open invite with a new ID and answers that ID (IR-1 M);
 * list answers the open ones (or fails).
 */
function world(options: boolean | WorldOptions = false): World {
  const {
    fallback = false,
    listFails = false,
    concurrent = false,
  } = typeof options === 'boolean' ? { fallback: options } : options;
  let elsewhere = 0;
  const open: { inviteId: string; name: string | null; expiresAt: string }[] = [];
  const created: World['created'] = [];
  const cancelled: string[] = [];
  const invites: InviteApi = {
    create: (label, options) => {
      const long = options?.long === true || fallback;
      created.push({ label, long: options?.long === true });
      const url = long ? LONG : created.length % 2 === 1 ? SHORT_A : SHORT_B;
      if (concurrent) {
        elsewhere += 1;
        open.push({
          inviteId: `other--${String(elsewhere).padStart(16, '0')}`,
          name: 'Sent from the AI app',
          expiresAt: new Date(EXPIRES).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        });
      }
      const inviteId = `invite-${String(created.length).padStart(16, '0')}`;
      open.push({
        inviteId,
        name: label ?? null,
        expiresAt: new Date(EXPIRES).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      });
      const outcome: CreateOutcome = {
        kind: 'ok',
        invite: {
          inviteUrl: url,
          shareText: `Connect with me on AgentLink: ${url}`,
          expiresAt: EXPIRES,
          format: long ? 'long' : 'short',
          inviteId,
        },
      };
      return Promise.resolve(outcome);
    },
    cancel: (inviteId) => {
      cancelled.push(inviteId);
      const at = open.findIndex((o) => o.inviteId === inviteId);
      if (at >= 0) open.splice(at, 1);
      return Promise.resolve({ kind: 'cancelled' });
    },
    check: () => Promise.resolve({ kind: 'failed' }),
    accept: () => Promise.resolve({ kind: 'failed' }),
  };
  const api: ApiClient = {
    get: <T>() =>
      Promise.resolve(
        (listFails
          ? { kind: 'offline' }
          : {
              kind: 'ok',
              status: 200,
              data: { status: 'ok', invites: open.map((o) => ({ ...o })) },
            }) as ApiResult<T>,
      ),
    post: () => Promise.resolve({ kind: 'error', status: 500 }),
    owner: () => Promise.resolve({ kind: 'error', status: 500 }),
  };
  return { invites, api, created, cancelled };
}

let host: HTMLElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'share');
  Reflect.deleteProperty(navigator, 'clipboard');
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

async function show(element: ReactElement, hood = false): Promise<void> {
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(HoodProvider, { value: hood }, element));
  });
  await settle();
}

const panel = (w: World, extra: Partial<InvitePanelProps> = {}): ReactElement =>
  createElement(InvitePanel, { invites: w.invites, now: () => NOW, ...extra });

const text = (): string => host.textContent ?? '';
const button = (label: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label || b.getAttribute('aria-label') === label,
  );
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
};
const hasButton = (label: string): boolean =>
  [...host.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === label);
const click = async (label: string): Promise<void> => {
  await act(async () => {
    button(label).click();
  });
  await settle();
};
const nameField = (): HTMLInputElement => {
  const input = host.querySelector<HTMLInputElement>('input[type="text"]');
  if (input === null) throw new Error('no name field');
  return input;
};
async function typeName(value: string): Promise<void> {
  const input = nameField();
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function blurName(): Promise<void> {
  await act(async () => {
    nameField().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
  await settle();
}
function stubClipboard(): string[] {
  const written: string[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t: string) => (written.push(t), Promise.resolve()) },
  });
  return written;
}
/** No attribute anywhere on the page holds the link's secret part. */
function attributesHold(secret: string): boolean {
  for (const el of host.querySelectorAll('*')) {
    for (const attr of el.attributes) if (attr.value.includes(secret)) return true;
  }
  return false;
}

describe('the invite panel (A3/A5)', () => {
  it('makes a short link at once and shows it as text only, with the name label and 7 days', async () => {
    const w = world();
    await show(panel(w));
    expect(w.created).toEqual([{ label: undefined, long: false }]);
    // IR SEC-1 L2: the full https:// link, so a copied or selected link never loads over http.
    expect(host.querySelector('.inv-link')?.textContent).toBe(SHORT_A);
    expect(text()).toContain(S.linkLabel);
    expect(text()).toContain('Works for 7 days. Only the person with the link can accept.');
    expect(text()).toContain("Only for your list. It isn't sent anywhere.");
    expect(attributesHold('AAAAAAAAAAAAAAAAAAAA')).toBe(false);
    expect(document.title).not.toContain('AAAA');
    await typeName('Denis');
    expect(text()).toContain('Invite link for Denis');
  });

  it('Copy puts the link on the clipboard and shows the Copied moment', async () => {
    const w = world();
    const written = stubClipboard();
    await show(panel(w));
    await click(S.copy);
    expect(written).toEqual([SHORT_A]);
    expect(hasButton(S.copied)).toBe(true);
    expect(host.querySelector('.al-pop')).not.toBeNull();
    expect(text()).toContain(S.copiedAnnounce);
  });

  it('Email opens the mail app with the share text; Share only where a share sheet exists', async () => {
    const w = world();
    const opened: string[] = [];
    await show(panel(w, { openMail: (url) => opened.push(url) }));
    expect(hasButton(S.share)).toBe(false);
    await click(S.email);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^mailto:\?subject=/);
    expect(decodeURIComponent(opened[0] ?? '')).toContain(SHORT_A);
    act(() => root?.unmount());
    root = undefined;

    const shared: string[] = [];
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: (data: { text: string }) => (shared.push(data.text), Promise.resolve()),
    });
    await show(panel(world()));
    await click(S.share);
    expect(shared).toEqual([`Connect with me on AgentLink: ${SHORT_A}`]);
  });

  it('a name typed before the link went anywhere makes a fresh link with that name', async () => {
    const w = world();
    stubClipboard();
    await show(panel(w));
    await typeName('Denis');
    await blurName();
    expect(w.created).toEqual([
      { label: undefined, long: false },
      { label: 'Denis', long: false },
    ]);
    expect(w.cancelled).toEqual(['invite-0000000000000001']);
    expect(text()).toContain('agentlink.4thtech.io/i#2.BBBB');
    // Once the link went out, the name no longer changes it.
    await click(S.copy);
    expect(nameField().readOnly).toBe(true);
  });

  it('a link that never left the screen is cancelled when you leave; a copied one stays', async () => {
    const w = world();
    await show(panel(w));
    act(() => root?.unmount());
    root = undefined;
    await settle();
    expect(w.cancelled).toEqual(['invite-0000000000000001']);

    const kept = world();
    stubClipboard();
    await show(panel(kept));
    await click(S.copy);
    act(() => root?.unmount());
    root = undefined;
    await settle();
    expect(kept.cancelled).toEqual([]);
  });

  // IR-W4-PEOPLE-INVITE-1 (M): the panel cancels only an invite whose ID its own create answered.
  it('a failed list read never makes it cancel another invite', async () => {
    const w = world({ listFails: true, concurrent: true });
    await show(panel(w));
    await typeName('Denis');
    await blurName();
    act(() => root?.unmount());
    root = undefined;
    await settle();
    expect(w.cancelled).toEqual(['invite-0000000000000001', 'invite-0000000000000002']);
    expect(w.cancelled.some((id) => id.startsWith('other'))).toBe(false);
  });

  it('an invite made elsewhere at the same time is never cancelled (rename, leave)', async () => {
    const w = world({ concurrent: true });
    await show(panel(w));
    await typeName('Denis');
    await blurName();
    act(() => root?.unmount());
    root = undefined;
    await settle();
    expect(w.cancelled).toEqual(['invite-0000000000000001', 'invite-0000000000000002']);
  });

  it('copying the link by selecting it anywhere counts as sent: it stays when you leave', async () => {
    const w = world();
    await show(panel(w));
    const box = host.querySelector('.inv-link') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(box);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    await act(async () => {
      document.dispatchEvent(new Event('copy', { bubbles: true }));
    });
    selection?.removeAllRanges();
    act(() => root?.unmount());
    root = undefined;
    await settle();
    expect(w.cancelled).toEqual([]);
  });

  it('a copy of something else does not count as sent', async () => {
    const w = world();
    await show(panel(w));
    const other = document.createElement('p');
    other.textContent = 'unrelated text';
    document.body.append(other);
    const range = document.createRange();
    range.selectNodeContents(other);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    await act(async () => {
      document.dispatchEvent(new Event('copy', { bubbles: true }));
    });
    document.getSelection()?.removeAllRanges();
    other.remove();
    act(() => root?.unmount());
    root = undefined;
    await settle();
    expect(w.cancelled).toEqual(['invite-0000000000000001']);
  });

  it('the long-link fallback says so in plain words', async () => {
    await show(panel(world(true)));
    expect(text()).toContain(S.fellBack);
  });

  it('Under the hood: invite details, a long link and the QR code', async () => {
    const w = world();
    stubClipboard();
    await show(panel(w), true);
    expect(text()).toContain(S.details);
    expect(text()).toContain(S.kindShort);
    expect(text()).toContain(S.expires);
    await click(S.showQr);
    expect(host.querySelector('svg[role="img"]')).not.toBeNull();
    await click(S.makeLong);
    expect(w.created.at(-1)).toEqual({ label: undefined, long: true });
    expect(text()).toContain(S.kindLong);
  });

  it('not in simple mode: no details, no QR, no long-link button', async () => {
    await show(panel(world()));
    expect(text()).not.toContain(S.details);
    expect(hasButton(S.showQr)).toBe(false);
    expect(hasButton(S.makeLong)).toBe(false);
  });
});

describe('the Invite screen (A5)', () => {
  it('has the title, the intro, a way back Home, "See what they\'ll see" and Done', async () => {
    const w = world();
    const done = vi.fn();
    await show(
      createElement(InviteScreen, {
        invites: w.invites,
        now: () => NOW,
        sender: 'Tali',
        onDone: done,
      }),
    );
    expect(host.querySelector('h1')?.textContent).toBe(S.title);
    expect(text()).toContain(S.intro);
    expect(text()).toContain(S.back);
    await click(S.seeTheirs);
    expect(text()).toContain('Tali invites you to connect your AIs');
    expect(text()).toContain(S.nameBySender);
    await click(S.done);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
