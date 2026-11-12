// @vitest-environment jsdom
// UX1113 WP-S2 (design-1112 §3.3): Settings › Touch ID & master code. How the owner confirms that it
// is them, in one place: Touch ID on, off or not possible here; Test Touch ID (signs nothing); Check
// my master code (right or doesn't match, nothing else); Replace master code (presence, the new code
// shown once, typed back to finish; the old code works until then); what asks for Touch ID.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, OwnerApiResult, OwnerPresence } from '../../api/client.js';
import { subscribeToasts } from '../../notices/index.js';
import type { PasskeyStatus, PresenceProof } from '../contacts/owner.js';
import { TouchIdPage } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OLD = 'WXYZ WXYZ WXYZ WXYZ WXYZ WXYZ';
const NEW = 'ABCD EFGH IJKL MNOP QRST UVWX';

let host: HTMLElement;
let root: Root;
let toasts: string[];
let stop: () => void;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  toasts = [];
  stop = subscribeToasts((t) => void toasts.push(t.text));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  stop();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
const text = (): string => host.textContent ?? '';
const labels = (): string[] =>
  [...host.querySelectorAll('button, a')].map((b) => (b.textContent ?? '').trim());
async function click(label: string): Promise<void> {
  const b = [...host.querySelectorAll<HTMLElement>('button, a')].find(
    (x) => (x.textContent ?? '').trim() === label,
  );
  if (b === undefined) throw new Error(`no control "${label}" in: ${labels().join(' | ')}`);
  await act(async () => {
    b.click();
  });
  await settle();
}
async function typeIn(value: string, at = 0): Promise<void> {
  const input = host.querySelectorAll<HTMLInputElement>('input')[at];
  if (input === undefined) throw new Error('no field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}
async function submit(): Promise<void> {
  const form = host.querySelector('form');
  if (form === null) throw new Error('no form');
  await act(async () => {
    form.requestSubmit();
  });
  await settle();
}

interface Call {
  readonly path: string;
  readonly presence: OwnerPresence;
}

function fakeApi(answers: Record<string, OwnerApiResult[]>): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const api: ApiClient = {
    get: () => Promise.resolve({ kind: 'error', status: 404 }),
    post: () => Promise.resolve({ kind: 'error', status: 404 }),
    owner: (path, _input, presence) => {
      calls.push({ path, presence });
      const next = answers[path]?.shift();
      return Promise.resolve(next ?? { kind: 'error', status: 500 });
    },
  };
  return { api, calls };
}

const READY: PasskeyStatus = {
  kind: 'ready',
  info: { credentialId: 'Y3JlZA', prfSalt: 'c2FsdA' },
};
const OFF: PasskeyStatus = {
  kind: 'unavailable',
  reason: 'not_set_up_here',
  switchTo: { rpId: 'localhost', userId: 'dXNlcg', prfSalt: 'c2FsdA' },
};
const NO_BROWSER: PasskeyStatus = { kind: 'unavailable', reason: 'browser' };
const UNKNOWN: PasskeyStatus = { kind: 'unavailable', reason: 'unknown' };

const DONE: OwnerApiResult = { kind: 'ok', status: 200, data: { status: 'done' } };
const STAGED: OwnerApiResult = { kind: 'ok', status: 200, data: { status: 'staged', code: NEW } };

async function render(
  status: PasskeyStatus,
  answers: Record<string, OwnerApiResult[]> = {},
  extra: Record<string, unknown> = {},
) {
  const { api, calls } = fakeApi(answers);
  const proof = vi.fn((): Promise<PresenceProof | undefined> =>
    Promise.resolve({ kind: 'passkey', body: new Uint8Array([1, 2, 3]) }),
  );
  await act(async () => {
    root.render(
      h(TouchIdPage, {
        api,
        platform: 'mac',
        passkeyStatus: () => Promise.resolve(status),
        passkeyProof: proof,
        ...extra,
      }),
    );
  });
  await settle();
  return { calls, proof };
}

describe('Touch ID & master code (WP-S2, §3.3)', () => {
  it('shows the title, the lead and the three cards', async () => {
    await render(READY);
    expect(host.querySelector('h1')?.textContent).toBe('Touch ID & master code');
    expect(text()).toContain('How you confirm that it is you.');
    expect(text()).toContain('Your AI can never confirm for you.');
    expect(text()).toContain('Touch ID is on');
    expect(text()).toContain('Master code');
    expect(text()).toContain('What asks for Touch ID');
    expect(text()).toContain('Reading messages and looking around never asks.');
    expect(text()).toContain('Three things to keep, and what each is for');
    expect(labels()).toEqual(
      expect.arrayContaining([
        'Test Touch ID',
        'Check my master code',
        'Replace master code',
        'I lost my master code',
      ]),
    );
  });

  it('Test Touch ID asks for the passkey, posts it to the test route and says it works', async () => {
    const { calls, proof } = await render(READY, { '/api/ui/owner-presence/test': [DONE] });
    await click('Test Touch ID');
    expect(proof).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/ui/owner-presence/test');
    expect(typeof calls[0]?.presence).toBe('object');
    expect(toasts).toContain('Touch ID works.');
  });

  it('a failed test says so plainly and never claims it works', async () => {
    await render(READY, { '/api/ui/owner-presence/test': [{ kind: 'presence_rejected' }] });
    await click('Test Touch ID');
    expect(toasts).not.toContain('Touch ID works.');
    expect(text()).toMatch(/didn't work/i);
  });

  it('off: says the master code confirms, and offers Turn on Touch ID', async () => {
    await render(OFF);
    expect(text()).toContain('Touch ID is off');
    expect(text()).toContain('You confirm with your master code.');
    expect(labels()).toContain('Turn on Touch ID');
    expect(labels()).not.toContain('Test Touch ID');
  });

  it("can't here: the existing reason sentence, no test and no switch", async () => {
    await render(NO_BROWSER);
    expect(text()).toContain("This browser can't use Touch ID for AgentLink");
    expect(labels()).not.toContain('Test Touch ID');
    expect(labels()).not.toContain('Turn on Touch ID');
  });

  it('Check my master code: right', async () => {
    const { calls } = await render(UNKNOWN, { '/api/ui/owner-code/check': [DONE] });
    await click('Check my master code');
    await typeIn(OLD);
    await submit();
    expect(calls).toEqual([{ path: '/api/ui/owner-code/check', presence: OLD }]);
    expect(text()).toContain("That's the right code.");
    // The typed code is not kept on the page.
    expect(host.querySelector<HTMLInputElement>('input')?.value ?? '').toBe('');
  });

  it("Check my master code: doesn't match, and the wait after wrong codes", async () => {
    await render(UNKNOWN, {
      '/api/ui/owner-code/check': [{ kind: 'presence_rejected' }, { kind: 'wait' }],
    });
    await click('Check my master code');
    await typeIn(OLD);
    await submit();
    expect(text()).toContain("That doesn't match.");
    await typeIn(OLD);
    await submit();
    expect(text()).not.toContain("That's the right code.");
    expect(text()).toMatch(/wait/i);
  });

  it('Replace: presence, the new code shown once, typed back to finish; then it is gone', async () => {
    const { calls } = await render(UNKNOWN, {
      '/api/ui/owner-code/replace': [STAGED],
      '/api/ui/owner-code/replace/finish': [DONE],
    });
    await click('Replace master code');
    await typeIn(OLD);
    await submit();
    expect(calls[0]).toEqual({ path: '/api/ui/owner-code/replace', presence: OLD });
    expect(text()).toContain(NEW.split(' ')[0] ?? 'x');
    expect(text()).toMatch(/shown once/i);
    // The old code still works until the new one is typed back.
    expect(text()).toMatch(/current master code (still )?works/i);
    await typeIn(NEW);
    await submit();
    expect(calls[1]).toEqual({ path: '/api/ui/owner-code/replace/finish', presence: NEW });
    expect(text()).toContain('The old code stops working now.');
    expect(text()).not.toContain('ABCD');
  });

  it('M-1: written but not confirmed keeps the new code on screen, says keep both, offers no Finish', async () => {
    const { calls } = await render(UNKNOWN, {
      '/api/ui/owner-code/replace': [STAGED],
      '/api/ui/owner-code/replace/finish': [
        { kind: 'ok', status: 200, data: { status: 'unconfirmed' } },
      ],
    });
    await click('Replace master code');
    await typeIn(OLD);
    await submit();
    await typeIn(NEW);
    await submit();
    expect(calls).toHaveLength(2);
    // The code stays (never cleared on this path) and the copy never claims nothing changed.
    expect(host.querySelector('[data-new-code]')?.textContent).toBe(NEW);
    expect(text()).toContain('Keep both your current and your new master code');
    expect(text()).toContain('agentlink owner change-code');
    expect(text()).not.toContain('Nothing was changed');
    expect(text()).not.toContain('still works until you finish');
    // No second Finish (it would be not_pending and clear the code) and no Cancel.
    expect(labels()).not.toContain('Finish');
    expect(labels()).not.toContain('Cancel');
    expect(host.querySelector('[data-new-code]')).not.toBeNull();
  });

  it('L-2: the new code carries the first-run clipboard warning', async () => {
    await render(UNKNOWN, { '/api/ui/owner-code/replace': [STAGED] });
    await click('Replace master code');
    await typeIn(OLD);
    await submit();
    expect(text()).toContain('Other apps can read your clipboard.');
  });

  it('Cancel that the server holds back keeps the code and says so', async () => {
    await render(UNKNOWN, {
      '/api/ui/owner-code/replace': [STAGED],
      '/api/ui/owner-code/replace/cancel': [{ kind: 'busy' }],
    });
    await click('Replace master code');
    await typeIn(OLD);
    await submit();
    await click('Cancel');
    expect(host.querySelector('[data-new-code]')?.textContent).toBe(NEW);
    expect(text()).not.toContain('Nothing was changed. Your current master code still works.');
  });

  it('L-1: leaving the page with a staged change sends one best-effort cancel (keepalive)', async () => {
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      sent.push({ url, init });
      return Promise.resolve(new Response('{}'));
    }) as typeof fetch;
    try {
      await render(UNKNOWN, { '/api/ui/owner-code/replace': [STAGED] });
      await click('Replace master code');
      await typeIn(OLD);
      await submit();
      await act(async () => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.url).toBe('/api/ui/owner-code/replace/cancel');
      expect(sent[0]?.init?.keepalive).toBe(true);
      expect(JSON.stringify(sent[0]?.init)).not.toContain('ABCD');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('Replace with Touch ID sends the passkey as the presence', async () => {
    const { calls } = await render(READY, { '/api/ui/owner-code/replace': [STAGED] });
    await click('Replace master code');
    await click('Confirm with Touch ID');
    expect(calls[0]?.path).toBe('/api/ui/owner-code/replace');
    expect(typeof calls[0]?.presence).toBe('object');
  });

  it('Replace, then Cancel: the staged change is dropped and the code leaves the page', async () => {
    const { calls } = await render(UNKNOWN, {
      '/api/ui/owner-code/replace': [STAGED],
      '/api/ui/owner-code/replace/cancel': [
        { kind: 'ok', status: 200, data: { status: 'cancelled' } },
      ],
    });
    await click('Replace master code');
    await typeIn(OLD);
    await submit();
    await click('Cancel');
    expect(calls[1]?.path).toBe('/api/ui/owner-code/replace/cancel');
    expect(text()).not.toContain('ABCD');
    expect(text()).toMatch(/current master code (still )?works/i);
  });

  it('Replace refused for an unfinished earlier change points to the terminal step', async () => {
    await render(UNKNOWN, {
      '/api/ui/owner-code/replace': [
        { kind: 'answer', status: 409, data: { status: 'unfinished' } },
      ],
    });
    await click('Replace master code');
    await typeIn(OLD);
    await submit();
    expect(text()).toContain('owner change-code');
  });

  it('I lost my master code: replace now if Touch ID works, else restore; links to both', async () => {
    await render(READY);
    await click('I lost my master code');
    expect(text()).toContain('If Touch ID still works, replace the code now.');
    expect(text()).toContain('restore from your recovery kit on this computer');
    const hrefs = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/settings/backup');
  });

  it('has a named mount slot for the desktop app’s native Touch ID switch', async () => {
    await render(READY, {}, { nativeSwitch: h('span', { id: 'native' }, 'native switch') });
    const slot = host.querySelector('[data-slot="native-touch-id-switch"]');
    expect(slot).not.toBeNull();
    expect(slot?.querySelector('#native')).not.toBeNull();
  });

  it('never logs a code', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    try {
      await render(UNKNOWN, {
        '/api/ui/owner-code/replace': [STAGED],
        '/api/ui/owner-code/replace/finish': [DONE],
      });
      await click('Replace master code');
      await typeIn(OLD);
      await submit();
      await typeIn(NEW);
      await submit();
      const logged = JSON.stringify(spies.map((s) => s.mock.calls));
      expect(logged).not.toContain('WXYZ');
      expect(logged).not.toContain('ABCD');
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
