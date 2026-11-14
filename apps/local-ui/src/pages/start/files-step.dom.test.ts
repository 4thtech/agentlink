// @vitest-environment jsdom
// FILES-ONB-1 (D-152; 08 §1 "Files step" and "Choose another folder"; 11 §5.7; b11 §8 row 24; I-4):
// the Files step of Get started and New ID. Read-only by default: Continue and Skip for now change
// no rule (nothing signs, nothing is set up). Show in Finder / Show in Explorer sends no path.
// Choose another folder is the existing Settings › Files add review and confirm (D-99, D-119), with
// its own presence: the master code in the desktop app's window, never WebAuthn there. Not allowed:
// the line of 11 §5.7 and Allow Send folder (the banner flow, its own presence in Settings › Files).
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RevealApi } from '../../api/reveal-folder.js';
import { COMMIT_PATH, reviewPath } from '../files/data.js';
import type { Answer, CommitOutcome, FilesApi, Presence } from '../files/files-api.js';
import { FILES_COPY, appTip } from '../files/folders-copy.js';
import { FILES_STRINGS } from '../files/strings.js';
import { FIRST_RUN } from '../first-run/strings.js';
import { filesLinkFor, type SendFolderApi } from '../home/send-folder-banner.js';
import { FilesStep, type FilesStepProps } from './files-step.js';
import { CONNECT_ONLY_STEP_IDS, FILES_STEP, STEP_IDS, WIZARD } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const realAgent = navigator.userAgent;
const realPlatform = navigator.platform;
const setNavigator = (key: 'userAgent' | 'platform', value: string): void => {
  Object.defineProperty(navigator, key, { value, configurable: true });
};
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setNavigator('platform', 'MacIntel');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setNavigator('userAgent', realAgent);
  setNavigator('platform', realPlatform);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ALLOWED = { path: '~/AgentLink/Send', resolved: '/h/AgentLink/Send' };
const OTHER = '/Users/me/Work';
const TOKEN = 'r'.repeat(43);

interface World {
  folders: { path: string; resolved: string | null }[];
  warnings?: string[];
}

function fakes(world: World) {
  const gets: string[] = [];
  const commits: {
    path: string;
    input: { review: string; acknowledged: readonly string[] };
    presence: Presence;
  }[] = [];
  let passkeyReads = 0;
  const answer = (status: number, json: unknown): Promise<Answer> =>
    Promise.resolve({ kind: 'answer', status, json });
  const api: FilesApi = {
    get: (path) => {
      gets.push(path);
      if (path === '/api/ui/files') {
        return answer(200, { folders: world.folders, max: 32, version: 7 });
      }
      if (path.startsWith('/api/ui/files/received')) {
        return answer(200, {
          items: [],
          autoSave: { on: true, folder: '~/AgentLink/Inbox', notice: false },
        });
      }
      if (path.startsWith('/api/ui/files/sent')) return answer(200, { items: [] });
      if (path.startsWith('/api/ui/files/review')) {
        return answer(200, {
          review: TOKEN,
          change: 'add',
          folder: OTHER,
          typed: OTHER,
          elsewhere: false,
          warnings: world.warnings ?? [],
          expiresAt: 1_900_000_000,
        });
      }
      return answer(404, {});
    },
    passkey: () => {
      passkeyReads += 1;
      return Promise.resolve({ credentialId: 'abc', prfSalt: 'def' });
    },
    commit: (path, input, presence) => {
      commits.push({ path, input, presence });
      world.folders = [...world.folders, { path: OTHER, resolved: OTHER }];
      return Promise.resolve<CommitOutcome>({ kind: 'applied', confirmed: true });
    },
    reveal: () => Promise.resolve('shown'),
    preview: () => Promise.resolve({ kind: 'failed' }),
  };
  const reveals: string[] = [];
  const reveal: RevealApi = {
    revealSendFolder: () => {
      reveals.push('send');
      return Promise.resolve('shown');
    },
    revealInbox: () => {
      reveals.push('inbox');
      return Promise.resolve('shown');
    },
  };
  const prepared: string[] = [];
  const sendFolder: SendFolderApi = {
    noFolder: () => Promise.resolve(world.folders.length === 0),
    prepare: () => {
      prepared.push('prepare');
      return Promise.resolve('/h/AgentLink/Send');
    },
  };
  const calls = { back: 0, next: 0, skip: 0 };
  const went: string[] = [];
  return {
    api,
    gets,
    commits,
    reveals,
    reveal,
    prepared,
    sendFolder,
    calls,
    went,
    passkeyReads: () => passkeyReads,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(world: World, props: Partial<FilesStepProps> = {}) {
  const f = fakes(world);
  await act(async () => {
    root.render(
      h(FilesStep, {
        api: f.api,
        reveal: f.reveal,
        sendFolder: f.sendFolder,
        appName: 'Claude Code',
        onBack: () => (f.calls.back += 1),
        onContinue: () => (f.calls.next += 1),
        onSkip: () => (f.calls.skip += 1),
        go: (to: string) => f.went.push(to),
        ...props,
      }),
    );
  });
  await settle();
  return f;
}

const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
const click = async (el: Element | undefined): Promise<void> => {
  expect(el).toBeDefined();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
};
const typeInto = async (input: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('FILES-ONB-1: the step order and the counter', () => {
  it('Get started and New ID have five steps, Files fourth; Connect another AI app has four', () => {
    expect([...STEP_IDS]).toEqual(['app', 'connect', 'connected', 'files', 'invite']);
    expect([...CONNECT_ONLY_STEP_IDS]).toEqual(['app', 'connect', 'connected', 'invite']);
    expect(WIZARD.stepLabel(4, 5, WIZARD.stepNames.files)).toBe('Step 4 of 5 · Files');
    expect(WIZARD.stepLabel(4, 4, WIZARD.stepNames.invite)).toBe('Step 4 of 4 · Invite someone');
  });
});

describe('FILES-ONB-1: the Files step, read-only by default', () => {
  it('shows Send and Inbox with paths, the chip, Show in Finder and the tip of the AI app', async () => {
    const f = await mount({ folders: [ALLOWED] });
    expect(host.querySelector('h1')?.textContent).toBe(FILES_STEP.title);
    expect(host.textContent).toContain(FILES_STEP.eyebrow);
    expect(host.textContent).toContain(FILES_COPY.oneLine);
    const send = host.querySelector('[data-row="send"]');
    expect(send?.textContent).toContain('~/AgentLink/Send');
    expect(send?.textContent).toContain(FILES_COPY.chipAllowed);
    expect(send?.textContent).toContain(FILES_COPY.sendLine);
    expect(host.querySelector('[data-row="inbox"]')?.textContent).toContain('~/AgentLink/Inbox');
    expect(host.textContent).toContain(FILES_COPY.aiAppHeading);
    expect(host.textContent).toContain(appTip('Claude Code', 'Mac'));
    await click(buttonNamed('Show in Finder'));
    expect(f.reveals).toEqual(['send']);
    expect(lintVocabulary(host.textContent ?? '')).toEqual([]);
    expect(host.textContent).not.toMatch(/harness/i);
  });

  it('Choose another folder sits in the Send row (11 §5.7)', async () => {
    await mount({ folders: [ALLOWED] });
    const send = host.querySelector('[data-row="send"]');
    expect(
      [...(send?.querySelectorAll('button') ?? [])].some(
        (b) => b.textContent?.trim() === FILES_STEP.choose,
      ),
    ).toBe(true);
  });

  it('the unknown-app tip when no AI app is known', async () => {
    await mount({ folders: [ALLOWED] }, { appName: undefined });
    expect(host.textContent).toContain(appTip(undefined, 'Mac'));
  });

  it('Windows says Show in Explorer and PC', async () => {
    setNavigator('platform', 'Win32');
    await mount({ folders: [{ path: '~/AgentLink/Send', resolved: null }] });
    expect(host.textContent).toContain(FILES_COPY.chipNotFound('PC'));
    await act(async () => root.render(h('div')));
    await mount({ folders: [ALLOWED] });
    expect(buttonNamed('Show in Explorer')).toBeDefined();
    expect(buttonNamed('Show in Finder')).toBeUndefined();
  });

  it('Skip for now and Continue change no rule: nothing signs, nothing is set up', async () => {
    const f = await mount({ folders: [ALLOWED] });
    await click(buttonNamed(FILES_STEP.skip));
    expect(f.calls.skip).toBe(1);
    await click(buttonNamed(FILES_STEP.next));
    expect(f.calls.next).toBe(1);
    expect(f.commits).toEqual([]);
    expect(f.prepared).toEqual([]);
    expect(f.gets.some((p) => p.startsWith('/api/ui/files/review'))).toBe(false);
  });

  it('Back goes to the step before', async () => {
    const f = await mount({ folders: [ALLOWED] });
    await click(buttonNamed(FILES_STEP.back));
    expect(f.calls.back).toBe(1);
  });

  it('Not allowed: the line and Allow Send folder (the banner flow, Settings › Files)', async () => {
    const f = await mount({ folders: [] });
    expect(host.textContent).toContain(FILES_COPY.chipNotAllowed);
    expect(host.textContent).toContain(FILES_COPY.notAllowedLine);
    await click(buttonNamed(FILES_COPY.allowSendFolder));
    expect(f.prepared).toEqual(['prepare']);
    expect(f.went).toEqual([filesLinkFor('/h/AgentLink/Send')]);
    expect(f.commits).toEqual([]);
  });

  it('Not confirmed: the existing text', async () => {
    await mount({ folders: [ALLOWED] }, { sendOutcome: 'not_confirmed' });
    expect(host.textContent).toContain(FIRST_RUN.sendNotConfirmed);
  });
});

describe('FILES-ONB-1 (S2): Choose another folder is the existing add review and confirm', () => {
  it('reviews the typed folder at the list version, needs every warning ticked, then signs with the master code', async () => {
    const world: World = { folders: [ALLOWED], warnings: ['allowed_folders_added'] };
    const f = await mount(world);
    await click(buttonNamed(FILES_STEP.choose));
    const field = host.querySelector<HTMLInputElement>('input[name="folder"]');
    expect(field).not.toBeNull();
    await typeInto(field as HTMLInputElement, OTHER);
    await click(buttonNamed(FILES_STRINGS.check));
    expect(f.gets).toContain(reviewPath('add', OTHER, 7));
    expect(host.textContent).toContain(FILES_STRINGS.confirmAddTitle);
    expect(host.textContent).toContain(FILES_STRINGS.confirmAddBody);
    expect(host.textContent).toContain(OTHER);
    const confirm = buttonNamed(FILES_STRINGS.confirmAdd);
    expect(confirm?.disabled).toBe(true);
    const code = host.querySelector<HTMLInputElement>('input[name="owner-code"]');
    expect(code).not.toBeNull();
    await typeInto(code as HTMLInputElement, 'ABCD EFGH');
    expect(buttonNamed(FILES_STRINGS.confirmAdd)?.disabled).toBe(true);
    await click(host.querySelector('.fl-warnings input[type="checkbox"]') ?? undefined);
    expect(buttonNamed(FILES_STRINGS.confirmAdd)?.disabled).toBe(false);
    await click(buttonNamed(FILES_STRINGS.confirmAdd));
    expect(f.commits).toHaveLength(1);
    expect(f.commits[0]?.path).toBe(COMMIT_PATH);
    expect(f.commits[0]?.input).toEqual({ review: TOKEN, acknowledged: ['allowed_folders_added'] });
    expect(f.commits[0]?.presence).toEqual({ kind: 'code', code: 'ABCD EFGH' });
    expect(host.textContent).toContain(FILES_STRINGS.added);
    // The step itself still changes nothing more: Continue goes on.
    await click(buttonNamed(FILES_STEP.next));
    expect(f.calls.next).toBe(1);
    expect(f.commits).toHaveLength(1);
  });

  it('Cancel leaves the rules as they are', async () => {
    const f = await mount({ folders: [ALLOWED] });
    await click(buttonNamed(FILES_STEP.choose));
    await typeInto(host.querySelector<HTMLInputElement>('input[name="folder"]')!, OTHER);
    await click(buttonNamed(FILES_STRINGS.check));
    await click(buttonNamed(FILES_STRINGS.cancel));
    expect(f.commits).toEqual([]);
    expect(host.textContent).not.toContain(FILES_STRINGS.confirmAddTitle);
  });

  it("the Connect card's Change opens the folder choice at once", async () => {
    await mount({ folders: [ALLOWED] }, { chooseFirst: true });
    expect(host.querySelector('input[name="folder"]')).not.toBeNull();
  });

  it("in the desktop app's window nothing calls WebAuthn: the master code only", async () => {
    setNavigator('userAgent', `${realAgent} AgentLinkDesktop/1`);
    const get = vi.fn(() => Promise.reject(new Error('no WebAuthn here')));
    const create = vi.fn(() => Promise.reject(new Error('no WebAuthn here')));
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    Object.defineProperty(navigator, 'credentials', {
      value: { get, create },
      configurable: true,
    });
    const f = await mount({ folders: [ALLOWED] });
    await click(buttonNamed(FILES_STEP.choose));
    await typeInto(host.querySelector<HTMLInputElement>('input[name="folder"]')!, OTHER);
    await click(buttonNamed(FILES_STRINGS.check));
    expect(f.passkeyReads()).toBe(0);
    const code = host.querySelector<HTMLInputElement>('input[name="owner-code"]');
    expect(code).not.toBeNull();
    await typeInto(code as HTMLInputElement, 'ABCD');
    await click(buttonNamed(FILES_STRINGS.confirmAdd));
    expect(f.commits[0]?.presence).toEqual({ kind: 'code', code: 'ABCD' });
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
