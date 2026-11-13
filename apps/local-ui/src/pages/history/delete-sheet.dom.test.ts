// @vitest-environment jsdom
// RET-4 (D-148; 08 §1 "The delete sheet"; 11 §5): the delete sheet. It asks the server for the plan
// (counts and sizes only), shows the fixed lines, explains what is always kept, and has one danger
// button that is the sensor ("Delete with Touch ID"). The press sends exactly `{nonce}` to finish,
// then a 10-second Undo toast; Undo cancels; when the window ends the outcome is said ("Moved 2
// files to the Trash." or the Windows note). A list that changed in between is said, never applied.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ToastItem } from '@4thtech-io/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeToasts } from '../../notices/index.js';
import type { PresenceProof } from '../contacts/owner.js';
import { PresenceSeamsContext } from '../contacts/presence-button.js';
import { DeleteSheet, type DeleteSheetProps } from './delete-sheet.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REF = '0x4c21a0f700000000000000000000000000000002';
const NONCE = 'N'.repeat(43);
const PROOF: PresenceProof = { kind: 'code', code: 'ABCD-EFGH' };
const gesture = vi.fn(() => Promise.resolve<PresenceProof | undefined>(PROOF));

interface Sent {
  readonly path: string;
  readonly body: unknown;
  readonly input: unknown;
}

let host: HTMLElement;
let root: Root;
let sent: Sent[];
let toasts: ToastItem[];
let unsubscribe: () => void;
let finishAnswer: { status: number; body: unknown };
let statusAnswer: unknown;

beforeEach(() => {
  gesture.mockClear();
  sent = [];
  toasts = [];
  unsubscribe = subscribeToasts((t) => void toasts.push(t));
  finishAnswer = { status: 200, body: { status: 'done', undoSeconds: 10 } };
  statusAnswer = {
    status: 'done',
    result: {
      messages: { deleted: 3, notarized: 0, kept: 0 },
      files: { trashed: 2, changed: 0, missing: 0, refused: 0, noTrash: 0, failed: 0 },
    },
  };
  (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = class {};
  Object.defineProperty(navigator, 'credentials', { value: {}, configurable: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  unsubscribe();
  delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  act(() => root.unmount());
  host.remove();
});

const settle = async (ms = 0): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
};

function decodeInput(value: string | null): unknown {
  if (value === null) return undefined;
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(b64)) as unknown;
}

const reply = (status: number, body: unknown): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = typeof input === 'string' ? input : input.toString();
  const headers = new Headers(init?.headers);
  let body: unknown;
  if (init?.body instanceof Uint8Array && path !== '/api/ui/history/delete/finish') {
    body = JSON.parse(new TextDecoder().decode(init.body)) as unknown;
  }
  if ((init?.method ?? 'GET') === 'POST') {
    sent.push({ path, body, input: decodeInput(headers.get('X-AgentLink-Input')) });
  }
  if (path.includes('/api/owner/passkey')) {
    return reply(200, {
      passkey: { registered: true, rpId: 'localhost', credentialId: 'CQ', prfSalt: 'BQY' },
    });
  }
  if (path === '/api/ui/history/delete/begin') {
    const include = (body as { include?: string }).include;
    return reply(200, {
      status: 'planned',
      nonce: NONCE,
      messages: { count: include === 'files' ? 0 : 3, bytes: 3_000 },
      files: { count: include === 'messages' ? 0 : 2, bytes: 2_000_000 },
      notarized: 0,
      kept: 4,
      truncated: false,
      undoSeconds: 10,
    });
  }
  if (path === '/api/ui/history/delete/finish') return reply(finishAnswer.status, finishAnswer.body);
  if (path === '/api/ui/history/delete/undo') return reply(200, { status: 'cancelled' });
  if (path === '/api/ui/history/delete/status') return reply(200, statusAnswer);
  return reply(404, { error: 'not_found' });
}) as typeof fetch;

async function show(props: Partial<DeleteSheetProps> = {}): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        PresenceSeamsContext.Provider,
        { value: { gesture, platform: 'mac', userAgent: 'Mozilla/5.0 (Macintosh)' } },
        createElement(DeleteSheet, {
          name: 'Ana',
          target: { contact: REF },
          fetch: fetchFn,
          token: 't',
          onClose: () => undefined,
          waitMs: 5,
          ...props,
        }),
      ),
    );
  });
  await settle();
}

const text = (): string => host.textContent ?? '';
const button = (pattern: RegExp): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => pattern.test((b.textContent ?? '').trim()));
const click = async (el: HTMLElement | undefined | null): Promise<void> => {
  if (el === undefined || el === null) throw new Error(`no control in: ${text()}`);
  await act(async () => {
    el.click();
  });
  await settle();
};

describe('the delete sheet (RET-4)', () => {
  it('asks the server for the plan and shows counts, sizes, the fixed lines and what is kept', async () => {
    await show();
    expect(sent[0]).toEqual({
      path: '/api/ui/history/delete/begin',
      body: { contact: REF, include: 'both' },
      input: undefined,
    });
    const t = text();
    expect(t).toContain('Delete history with Ana?');
    expect(t).toContain('3 messages, 2 files, 2 MB');
    expect(t).toContain('Only on this computer; Ana keeps their copy and is not told.');
    expect(t).toContain('Proofs stay valid. Older backups may still contain it.');
    expect(t).toContain('4 kept: still needed for your contact, an approval or an agreement.');
    expect(t).toContain('Kept: pairing, agreed terms, approvals, receipts.');
    expect(t).toContain('Also move saved files to Trash');
    expect(button(/^Delete with Touch ID$/)).toBeDefined();
    expect(t).not.toMatch(/wallet|gas|seed phrase|transaction/i);
  });

  it('the Trash switch off plans messages only', async () => {
    await show();
    const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(toggle?.checked).toBe(true);
    await click(toggle);
    expect(sent.at(-1)).toMatchObject({ body: { contact: REF, include: 'messages' } });
    expect(text()).toContain('3 messages, 3 KB');
  });

  it('a selection plans those messages and says how many', async () => {
    await show({ target: { contact: REF, envelopeIds: ['m1', 'm2'] } });
    expect(sent[0]?.body).toEqual({ envelopeIds: ['m1', 'm2'], include: 'both' });
    expect(text()).toContain('Delete 2 messages?');
  });

  it('one press sends only the nonce, then a 10-second Undo; the outcome is said after', async () => {
    const scheduled = vi.fn();
    await show({ onScheduled: scheduled });
    await click(button(/^Delete with Touch ID$/));
    const finish = sent.find((s) => s.path === '/api/ui/history/delete/finish');
    expect(finish?.input).toEqual({ nonce: NONCE });
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveBeenCalledTimes(1);
    const undoToast = toasts.find((t) => t.text === 'Deleted 3 messages.');
    expect(undoToast?.action).toBe('Undo');
    await settle(10);
    expect(sent.some((s) => s.path === '/api/ui/history/delete/status')).toBe(true);
    expect(toasts.map((t) => t.text)).toContain('Moved 2 files to the Trash.');
  });

  it('Undo cancels: nothing is deleted, and it says so', async () => {
    await show({ waitMs: 1_000 });
    await click(button(/^Delete with Touch ID$/));
    const undoToast = toasts.find((t) => t.text === 'Deleted 3 messages.');
    await act(async () => {
      undoToast?.onAction?.();
    });
    await settle();
    expect(sent.find((s) => s.path === '/api/ui/history/delete/undo')?.body).toEqual({
      nonce: NONCE,
    });
    expect(toasts.map((t) => t.text)).toContain('Nothing was deleted.');
  });

  it('on Windows the files are not moved: the note says to remove them yourself', async () => {
    statusAnswer = {
      status: 'done',
      result: {
        messages: { deleted: 3, notarized: 0, kept: 0 },
        files: { trashed: 0, changed: 0, missing: 0, refused: 0, noTrash: 2, failed: 0 },
      },
    };
    await show();
    await click(button(/^Delete with Touch ID$/));
    await settle(10);
    expect(toasts.map((t) => t.text)).toContain(
      "2 files couldn't go to the Recycle Bin here. Remove them yourself.",
    );
  });

  it('a list that changed since it was shown is said, and planned again', async () => {
    finishAnswer = { status: 409, body: { status: 'not_applied' } };
    await show();
    const begins = sent.length;
    await click(button(/^Delete with Touch ID$/));
    expect(text()).toContain('What would be deleted changed. Check it again.');
    expect(sent.length).toBeGreaterThan(begins + 1);
    expect(toasts.find((t) => t.text === 'Deleted 3 messages.')).toBeUndefined();
  });
});
