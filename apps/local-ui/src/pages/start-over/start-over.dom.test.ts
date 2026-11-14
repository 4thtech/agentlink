// @vitest-environment jsdom
// OWNER-START-OVER (D-152; 11 §5): "Forgot your master code? Start over on this computer". The page
// warns first and offers Restore from recovery kit first; going on needs the typed phrase; every
// outcome (done, partial, refused) has its own fixed text; the API sends the phrase, the nonce and
// the presence mode only.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStartOverApi, type StartOverApi, type StartOverOutcome } from './api.js';
import { ForgotCodeLink } from './forgot-link.js';
import { StartOverPage, type StartOverPageProps } from './index.js';
import * as S from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
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

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

function fakeApi(outcomes: StartOverOutcome[], unfinished = false) {
  const runs: string[] = [];
  const api: StartOverApi = {
    state: () => Promise.resolve({ presence: 'native', unfinished }),
    run: (phrase) => {
      runs.push(phrase);
      return Promise.resolve(outcomes.shift() ?? { kind: 'error', problem: 'failed' });
    },
  };
  return { api, runs };
}

async function mount(props: StartOverPageProps): Promise<{ left: string[] }> {
  const left: string[] = [];
  await act(async () => {
    root.render(h(StartOverPage, { onLeave: (to: string) => left.push(to), ...props }));
  });
  await settle();
  return { left };
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label);
async function click(label: string): Promise<void> {
  const b = button(label);
  if (b === undefined) throw new Error(`no button "${label}"`);
  await act(async () => {
    b.click();
  });
  await settle();
}
async function typeIn(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const text = (): string => host.textContent ?? '';

describe('start over page', () => {
  it('warns first, with Restore from recovery kit as the first action', async () => {
    const { api, runs } = fakeApi([]);
    const { left } = await mount({ api, desktop: 'mac' });
    expect(text()).toContain(S.WARN.title);
    for (const line of S.WARN.lost) expect(text()).toContain(line);
    expect(text()).toContain('Keychain');
    const actions = [...host.querySelectorAll('.rs-actions button')].map((b) => b.textContent);
    expect(actions[0]).toBe(S.WARN.restore);
    await click(S.WARN.restore);
    expect(left).toEqual(['/restore/kit']);
    expect(runs).toEqual([]);
  });

  it('needs the typed phrase before the Touch ID button works', async () => {
    const { api, runs } = fakeApi([
      { kind: 'done', backup: '~/.agentlink.backup-20261114-090507' },
    ]);
    const { left } = await mount({ api, desktop: 'mac' });
    await click(S.WARN.goOn);
    const go = button('Start over with Touch ID') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await typeIn('start');
    expect(go.disabled).toBe(true);
    await typeIn('  Start Over ');
    expect(go.disabled).toBe(false);
    await click('Start over with Touch ID');
    expect(runs).toEqual(['start over']);
    expect(text()).toContain(S.DONE.title);
    expect(text()).toContain('~/.agentlink.backup-20261114-090507');
    await click(S.DONE.next);
    expect(left).toEqual(['/start/app']);
  });

  it('names Windows Hello in the Windows app, and the browser gesture in a browser', async () => {
    const win = fakeApi([]);
    await mount({ api: win.api, desktop: 'windows' });
    await click(S.WARN.goOn);
    expect(button('Start over with Windows Hello')).toBeDefined();
    expect(text()).not.toContain(S.CONFIRM.browserNote);
    await act(async () => {
      root.render(h('div'));
    });
    const web = fakeApi([]);
    await mount({ api: web.api, desktop: undefined });
    await click(S.WARN.goOn);
    expect(button('Start over')).toBeDefined();
    expect(text()).toContain(S.CONFIRM.browserNote);
  });

  it('a partial keychain step says so and Try again finishes it', async () => {
    const { api, runs } = fakeApi([
      { kind: 'partial', backup: '~/.agentlink.backup-1', failed: 'keychain' },
      { kind: 'done', backup: '~/.agentlink.backup-1' },
    ]);
    await mount({ api, desktop: 'mac' });
    await click(S.WARN.goOn);
    await typeIn('start over');
    await click('Start over with Touch ID');
    expect(text()).toContain(S.PARTIAL.keychainTitle);
    expect(text()).toContain("Some of AgentLink's items in Keychain couldn't be removed yet.");
    await click(S.PARTIAL.retry);
    expect(runs).toHaveLength(2);
    expect(text()).toContain(S.DONE.title);
  });

  it('a failed move, a refused gesture and a browser without a sensor each have their text', async () => {
    const cases: [StartOverOutcome, string][] = [
      [{ kind: 'partial', backup: null, failed: 'move' }, S.PARTIAL.move],
      [
        { kind: 'error', problem: 'presence_rejected' },
        S.PROBLEM_TEXT.presence_rejected('Touch ID'),
      ],
      [{ kind: 'error', problem: 'unsupported' }, S.PROBLEM_TEXT.unsupported],
      [{ kind: 'error', problem: 'wait', retryAfter: 60 }, S.PROBLEM_TEXT.wait(60)],
      [{ kind: 'error', problem: 'open_app' }, S.PROBLEM_TEXT.open_app],
    ];
    for (const [outcome, line] of cases) {
      const { api } = fakeApi([outcome]);
      await mount({ api, desktop: 'mac' });
      await click(S.WARN.goOn);
      await typeIn('start over');
      await click('Start over with Touch ID');
      expect(text()).toContain(line);
      await act(async () => {
        root.render(h('div'));
      });
    }
  });

  it('an unfinished start over is offered to finish', async () => {
    const { api } = fakeApi([], true);
    await mount({ api, desktop: 'mac' });
    expect(text()).toContain(S.UNFINISHED.lead);
  });

  it('the copy follows 11 §5, and the link names the page', async () => {
    expect(lintVocabulary(JSON.stringify(S))).toEqual([]);
    await act(async () => {
      root.render(h(ForgotCodeLink));
    });
    const link = host.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/restore/start-over');
    expect(link.textContent).toBe(S.FORGOT_LINK);
  });
});

describe('start over api', () => {
  it('begin with the phrase, then finish with the nonce and the native presence header', async () => {
    const seen: { path: string; headers: Headers; body: unknown }[] = [];
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      seen.push({ path, headers: new Headers(init?.headers), body: init?.body });
      const json = path.endsWith('/begin')
        ? { status: 'presence', presence: 'native', nonce: 'n'.repeat(22), expiresInMs: 120000 }
        : { status: 'done', backup: '~/.agentlink.backup-x' };
      return Promise.resolve(new Response(JSON.stringify(json), { status: 200 }));
    }) as typeof fetch;
    const api = createStartOverApi({ fetch: fetcher, token: 'csrf' });
    expect(await api.run('start over')).toEqual({ kind: 'done', backup: '~/.agentlink.backup-x' });
    expect(seen.map((s) => s.path)).toEqual([
      '/api/ui/start-over/begin',
      '/api/ui/start-over/finish',
    ]);
    const input = (h2: Headers) =>
      JSON.parse(atob((h2.get('X-AgentLink-Input') ?? '').replace(/-/g, '+').replace(/_/g, '/')));
    expect(input(seen[0]!.headers)).toEqual({ phrase: 'start over' });
    expect(seen[0]!.headers.get('X-AgentLink-Presence')).toBeNull();
    expect(input(seen[1]!.headers)).toEqual({ nonce: 'n'.repeat(22) });
    expect(seen[1]!.headers.get('X-AgentLink-Presence')).toBe('native');
    expect(seen[1]!.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('in a browser: one passkey creation; a cancel changes nothing', async () => {
    const paths: string[] = [];
    const fetcher = ((input: RequestInfo | URL) => {
      paths.push(String(input));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'presence',
            presence: 'passkey',
            nonce: 'n'.repeat(22),
            publicKey: {
              rpId: 'localhost',
              rpName: 'AgentLink',
              userId: 'dXNlcg',
              userName: 'AgentLink start over',
              challenge: 'Y2hhbGxlbmdl',
            },
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch;
    const api = createStartOverApi({
      fetch: fetcher,
      token: 'csrf',
      create: () => Promise.resolve('cancelled'),
    });
    expect(await api.run('start over')).toEqual({ kind: 'error', problem: 'cancelled' });
    expect(paths).toEqual(['/api/ui/start-over/begin']);
  });
});
