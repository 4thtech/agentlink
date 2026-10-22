// @vitest-environment jsdom
/// <reference types="vite/client" />
// M1-11c-a3: the Files page (d1 Local-files with DESIGN-ADJ-1 FI-3; 04 §4; 06 §3; 11 §5, §6.2; D-99,
// D-118, D-119; UX audit 4b, 10a).
//
// - The folders the AI may send files from, each with its real location when it differs, and a
//   remove action. An empty list shows one next step and what to ask the AI.
// - "Allow a folder": the owner types a path; the server checks it (04 §4) and answers the folder
//   that would be allowed (a link is followed and the real folder shown) and every warning. The
//   confirm screen lists each warning in plain words with its own tick; the confirm button stays
//   off until every one is ticked, and the request names every code and the review it belongs to.
// - The browser never signs: the confirm sends the owner's passkey gesture or owner code to the
//   local server, which signs.
// - Server values render as text; the copy has no web3 words and never says "policy".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesPage } from './index.js';
import { FILES_STRINGS as S, WARNING_TEXT, refusalText } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

class Answer {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

type Handler = unknown | ((call: Call) => unknown);

function server(routes: Record<string, Handler>): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    calls.push(call);
    let found = routes[`${call.method} ${url}`] ?? routes[url];
    if (typeof found === 'function') found = (found as (c: Call) => unknown)(call);
    if (found === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    const answer = found instanceof Answer ? found : new Answer(200, found);
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

const LIST = '/api/ui/files';
const PASSKEY = '/api/owner/passkey';
const COMMIT = '/api/ui/files/folders';
const reviewUrl = (key: 'add' | 'remove', path: string): string =>
  `/api/ui/files/review?${new URLSearchParams({ [key]: path }).toString()}`;
const TOKEN = 'R'.repeat(43);
const NO_PASSKEY = {
  passkey: { registered: false, rpId: 'localhost', userId: 'dQ', prfSalt: 'cw' },
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

async function mount(routes: Record<string, Handler>) {
  const s = server(routes);
  await act(async () => {
    root.render(<FilesPage fetch={s.fetch} token="tok" />);
  });
  await flush();
  return s;
}

function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function decodeInput(headers: Headers): unknown {
  const raw = headers.get('X-AgentLink-Input') ?? '';
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
}

describe('the folder list', () => {
  it('shows each folder, its real location when different, and a remove action', async () => {
    await mount({
      [LIST]: {
        folders: [
          { path: '/Users/tali/Work', resolved: '/Users/tali/Work' },
          { path: '~/Linked', resolved: '/Volumes/Shared/Contracts' },
          { path: '/Users/tali/Gone', resolved: null },
        ],
        max: 32,
      },
    });
    const text = host.textContent ?? '';
    expect(host.querySelector('h1')?.textContent).toBe('Files');
    expect(text).toContain(S.foldersLabel);
    expect(text).toContain('/Users/tali/Work');
    expect(text).toContain('~/Linked');
    expect(text).toContain('/Volumes/Shared/Contracts');
    expect(text).toContain(S.folderMissing);
    expect(button('Stop sending from /Users/tali/Work')).toBeDefined();
    expect(button(S.allowFolder)).toBeDefined();
    expect(text).toContain(S.everyChange);
  });

  it('shows an empty state with what to ask the AI', async () => {
    await mount({ [LIST]: { folders: [], max: 32 } });
    const empty = host.querySelector('.al-empty');
    expect(empty?.textContent).toContain(S.emptyTitle);
    expect(empty?.textContent).toContain(`Try: ${S.emptyPrompt}`);
  });

  it('shows the not-set-up and unavailable states', async () => {
    await mount({ [LIST]: new Answer(409, { error: 'not_set_up' }) });
    expect(host.textContent).toContain(S.notSetUp);
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ [LIST]: new Answer(503, { error: 'unavailable' }) });
    expect(host.textContent).toContain(S.unavailable);
  });
});

describe('allow a folder (04 §4, D-119)', () => {
  const twoWarnings = {
    review: TOKEN,
    change: 'add',
    folder: '/Volumes/Shared/Contracts',
    typed: '~/Linked',
    elsewhere: true,
    warnings: ['allowed_folders_added', 'limits_raised'],
    expiresAt: 4_102_444_800,
  };

  async function toConfirm(answer: unknown = twoWarnings, typed = '~/Linked') {
    const s = await mount({
      [LIST]: { folders: [], max: 32 },
      [reviewUrl('add', typed)]: answer,
      [PASSKEY]: NO_PASSKEY,
      [`POST ${COMMIT}`]: { status: 'applied', confirmed: true },
    });
    await click(button(S.allowFolder));
    const input = host.querySelector<HTMLInputElement>('input[name="folder"]');
    expect(input).not.toBeNull();
    await type(input as HTMLInputElement, typed);
    await click(button(S.check));
    return s;
  }

  it('shows the real folder, every warning in plain words with its own tick', async () => {
    await toConfirm();
    const text = host.textContent ?? '';
    expect(text).toContain(S.confirmAddTitle);
    expect(text).toContain('/Volumes/Shared/Contracts');
    expect(text).toContain(S.elsewhere('~/Linked'));
    expect(text).toContain(WARNING_TEXT.allowed_folders_added);
    expect(text).toContain(WARNING_TEXT.limits_raised);
    expect(text).not.toContain('allowed_folders_added');
    const ticks = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(ticks).toHaveLength(2);
    expect(button(S.confirmAdd).disabled).toBe(true);
    await click(ticks[0] as HTMLInputElement);
    expect(button(S.confirmAdd).disabled).toBe(true);
  });

  it('sends every code, the review token and the owner code to the server, never signing', async () => {
    const s = await toConfirm();
    for (const tick of host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      await click(tick);
    }
    const code = host.querySelector<HTMLInputElement>('input[name="owner-code"]');
    expect(code?.type).toBe('password');
    await type(code as HTMLInputElement, 'ABCD EFGH IJKL');
    expect(button(S.confirmAdd).disabled).toBe(false);
    await click(button(S.confirmAdd));
    const post = s.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe(COMMIT);
    expect(post?.headers.get('content-type')).toBe('application/octet-stream');
    expect(post?.headers.get('X-AgentLink-CSRF')).toBe('tok');
    expect(post?.headers.get('X-AgentLink-Presence')).toBeNull();
    expect(decodeInput(post?.headers as Headers)).toEqual({
      review: TOKEN,
      acknowledged: ['allowed_folders_added', 'limits_raised'],
    });
    expect(new TextDecoder().decode(post?.body as Uint8Array)).toBe('ABCD EFGH IJKL');
    expect(host.textContent).toContain(S.added);
  });

  it('a change without warnings needs no tick', async () => {
    await toConfirm(
      {
        ...twoWarnings,
        warnings: [],
        elsewhere: false,
        typed: '/Users/t/Docs',
        folder: '/Users/t/Docs',
      },
      '/Users/t/Docs',
    );
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(host.textContent).not.toContain(S.elsewhere('/Users/t/Docs'));
  });

  it.each([
    ['contains_protected', { protectedFolder: '~/Library/Keychains' }],
    ['protected', {}],
    ['too_broad', {}],
    ['missing', {}],
  ])('explains a refused folder (%s) and signs nothing', async (reason, extra) => {
    const s = await toConfirm(new Answer(422, { error: 'folder_refused', reason, ...extra }));
    const shown = refusalText(reason, (extra as { protectedFolder?: string }).protectedFolder);
    expect(host.textContent).toContain(shown);
    if (reason === 'contains_protected') expect(shown).toContain('~/Library/Keychains');
    expect(s.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('says what to do when the rules cannot be read or receipts need an answer first', async () => {
    await toConfirm(new Answer(409, { error: 'rules_unreadable' }));
    expect(host.textContent).toContain(S.rulesUnreadable);
    act(() => root.unmount());
    root = createRoot(host);
    await toConfirm(new Answer(409, { error: 'receipts_question' }));
    expect(host.textContent).toContain(S.receiptsQuestion);
  });

  it('a wrong owner code changes nothing and says so', async () => {
    const s = server({
      [LIST]: { folders: [], max: 32 },
      [reviewUrl('add', '/x/y')]: {
        ...twoWarnings,
        warnings: [],
        typed: '/x/y',
        folder: '/x/y',
        elsewhere: false,
      },
      [PASSKEY]: NO_PASSKEY,
      [`POST ${COMMIT}`]: new Answer(403, { status: 'presence_rejected' }),
    });
    await act(async () => {
      root.render(<FilesPage fetch={s.fetch} token="tok" />);
    });
    await flush();
    await click(button(S.allowFolder));
    await type(
      host.querySelector<HTMLInputElement>('input[name="folder"]') as HTMLInputElement,
      '/x/y',
    );
    await click(button(S.check));
    await type(
      host.querySelector<HTMLInputElement>('input[name="owner-code"]') as HTMLInputElement,
      'X',
    );
    await click(button(S.confirmAdd));
    expect(host.textContent).toContain(S.presenceRejected);
  });
});

describe('remove a folder', () => {
  it('reviews the removal and confirms it with the owner', async () => {
    const s = await mount({
      [LIST]: { folders: [{ path: '/Users/tali/Work', resolved: '/Users/tali/Work' }], max: 32 },
      [reviewUrl('remove', '/Users/tali/Work')]: {
        review: TOKEN,
        change: 'remove',
        folder: '/Users/tali/Work',
        typed: '/Users/tali/Work',
        elsewhere: false,
        warnings: [],
        expiresAt: 4_102_444_800,
      },
      [PASSKEY]: NO_PASSKEY,
      [`POST ${COMMIT}`]: { status: 'applied', confirmed: true },
    });
    await click(button('Stop sending from /Users/tali/Work'));
    expect(host.textContent).toContain(S.confirmRemoveTitle);
    await type(
      host.querySelector<HTMLInputElement>('input[name="owner-code"]') as HTMLInputElement,
      'C',
    );
    await click(button(S.confirmRemove));
    expect(decodeInput(s.calls.find((c) => c.method === 'POST')?.headers as Headers)).toEqual({
      review: TOKEN,
      acknowledged: [],
    });
    expect(host.textContent).toContain(S.removed);
  });
});

describe('copy and source rules (11 §5, CSP)', () => {
  const FORBIDDEN =
    /\b(wallet|gas|seed phrase|transaction|policy|hash|chain|blockchain|token|nonce|signature)\b/i;

  it('has plain words for every warning code core can return', () => {
    const codes = [
      'invites_auto',
      'unknown_senders_queued',
      'contacts_allowed_widened',
      'limits_raised',
      'retention_longer',
      'allowed_folders_added',
      'folder_changed',
      'files_drop_allowed',
      'proofs_notarize_looser',
      'proofs_spend_raised',
      'key_disclosure_approval',
      'proofs_chain_changed',
      'delivery_receipts_public',
      'opened_receipts_auto',
      'commitments_looser',
      'commitments_allow',
      'auto_accept_widened',
      'sell_auto_accept',
      'contact_proof_rules_looser',
      'contact_receipts_public',
      'contact_rule_removed_loosens',
    ];
    expect(Object.keys(WARNING_TEXT).sort()).toEqual([...codes].sort());
    for (const text of Object.values(WARNING_TEXT)) expect(text).not.toMatch(FORBIDDEN);
  });

  it('page copy has no web3 words and never says policy', () => {
    const all: string[] = [
      ...Object.values(S).filter((v) => typeof v === 'string'),
      S.elsewhere('~/x'),
      ...[
        'not_full_path',
        'dot_segments',
        'missing',
        'not_folder',
        'too_broad',
        'protected',
        'hidden',
        'not_showable',
        'contains_protected',
        'already_allowed',
        'too_many',
        'not_allowed',
        'unknown',
      ].map((r) => refusalText(r, '~/.ssh')),
    ];
    // A command the owner types (in backticks) is shown exactly; the words around it are checked.
    for (const text of all) expect(text.replace(/`[^`]*`/g, '')).not.toMatch(FORBIDDEN);
  });

  it('uses no inline styles and no raw HTML', () => {
    const sources = import.meta.glob<string>(['./*.ts', './*.tsx', '!./*.test.tsx'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(4);
    for (const [name, src] of Object.entries(sources)) {
      expect(src, name).not.toContain('dangerouslySetInnerHTML');
      expect(src, name).not.toMatch(/style=\{/);
    }
  });
});
