// @vitest-environment jsdom
// UX1113-R3 (D-147): the restore wizard, step by step and error by error, against a fake API. The
// secrets (recovery code, new master code) never reach storage, the URL or an attribute.
import { lintVocabulary } from '@4thtech-io/ui';
import axe from 'axe-core';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppsApi } from '../first-run/apps-api.js';
import type { OwnerClient, PresenceProof } from '../contacts/owner.js';
import type { RestoreApi, Summary } from './api.js';
import { clean, toGroups } from './code-field.js';
import { createSetupApi } from '../first-run/setup-api.js';
import { createRestoreApi } from './api.js';
import { RestoreWizard, type RestoreWizardProps } from './index.js';
import { setFinishRestore, setOutcome } from './outcome.js';
import { ReviewStep, rowName } from './steps.js';
import * as S from './strings.js';

const cssFiles = import.meta.glob<string>('./restore.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = 'k7qm2xwd9rfah3nvz4tc8bpe';
const MASTER = 'R4TN-8KQZ-W2MD-6HXA-P9CF-3VLE';
const SUMMARY: Summary = {
  kitId: 'kit-1',
  createdAt: 1_793_000_000,
  contents: 'full',
  ids: [
    {
      agentId: '0x' + '1'.repeat(40),
      name: 'tali',
      people: 3,
      lastMessageAt: 1_793_000_000,
      state: 'new',
    },
    {
      agentId: '0x' + '2'.repeat(40),
      name: 'work',
      people: 0,
      lastMessageAt: null,
      state: 'name_taken',
      suggestedName: 'work-2',
    },
    {
      agentId: '0x' + '3'.repeat(40),
      name: 'macbook',
      people: 1,
      lastMessageAt: null,
      state: 'already_here',
    },
    {
      agentId: '0x' + '4'.repeat(40),
      name: 'demo',
      people: 0,
      lastMessageAt: null,
      state: 'removed_earlier',
    },
  ],
};

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  setOutcome(undefined);
  host.remove();
  vi.useRealTimers();
});

const ok = <T extends object>(v: T): Promise<{ kind: 'ok' } & T> =>
  Promise.resolve({ kind: 'ok', ...v });

function fakeApi(over: Partial<RestoreApi> = {}): RestoreApi & { calls: string[] } {
  const calls: string[] = [];
  const api: RestoreApi = {
    found: () =>
      ok({
        kits: [
          {
            handle: 'h1',
            name: 'agentlink-recovery-kit-2026-11-03.alkk',
            folder: 'downloads',
            modifiedAt: 1_793_000_000,
            size: 4_200_000,
          },
        ],
      }),
    upload: () => ok({ handle: 'h2', size: 10 }),
    header: () => ok({ header: 'ok' as const, ownerPresent: false }),
    presence: () => ok({}),
    open: () => ok({ kit: 'kit-handle', summary: SUMMARY }),
    check: () => ok({ summary: SUMMARY }),
    cancel: () => ok({}),
    applyBegin: () =>
      ok({
        answer: {
          status: 'done' as const,
          ids: [{ agentId: 'a', name: 'tali', outcome: 'restored' as const }],
        },
      }),
    applyFinish: () => Promise.reject(new Error('unused')),
    ...over,
  };
  const wrapped = Object.fromEntries(
    Object.entries(api).map(([k, fn]) => [
      k,
      (...args: unknown[]) => {
        calls.push(k);
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as RestoreApi;
  return Object.assign(wrapped, { calls });
}

const appsApi = (): AppsApi =>
  ({
    list: () => Promise.resolve({ kind: 'ok', apps: [], desktopRunning: false }),
    currentAgent: () => Promise.resolve({ kind: 'none' }),
    preview: () => Promise.resolve({ kind: 'not_available' }),
    passkey: () => Promise.resolve(undefined),
    apply: () => Promise.resolve({ kind: 'failed' }),
  }) as AppsApi;

const owner = (passkey = false): OwnerClient => ({
  passkey: () => Promise.resolve(passkey ? { credentialId: 'c', prfSalt: 's' } : undefined),
  post: () => Promise.resolve({ kind: 'done' }),
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(
  api: RestoreApi,
  props: Partial<Parameters<typeof RestoreWizard>[0]> = {},
): Promise<{ left: string[] }> {
  const left: string[] = [];
  await act(async () => {
    root.render(
      h<RestoreWizardProps>(RestoreWizard, {
        api,
        appsApi: appsApi(),
        owner: owner(),
        platform: 'mac',
        onLeave: (to: string) => left.push(to),
        ...props,
      }),
    );
  });
  await settle();
  return { left };
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label);
async function click(label: string): Promise<void> {
  const b = button(label);
  if (b === undefined) {
    const have = [...host.querySelectorAll('button')].map((x) => x.textContent).join(' | ');
    throw new Error(`no button "${label}" in: ${have}`);
  }
  await act(async () => {
    b.click();
  });
  await settle();
}
const text = (): string => host.textContent ?? '';
const boxes = (): HTMLInputElement[] => [
  ...host.querySelectorAll<HTMLInputElement>('.rs-code-box'),
];

async function type(index: number, value: string): Promise<void> {
  const input = boxes()[index] as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function paste(index: number, value: string): Promise<void> {
  const input = boxes()[index] as HTMLInputElement;
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
    clipboardData: { getData: () => string };
  };
  event.clipboardData = { getData: () => value };
  await act(async () => {
    input.dispatchEvent(event);
  });
}
/** IR-REL051-R2C-2: step 4's type-back confirm (as Replace master code). */
async function typeBack(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('.rs-typeback input');
  if (input === null) throw new Error('no type-back field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function fillCode(): Promise<void> {
  await paste(0, CODE);
}

async function toCodeStep(api: RestoreApi): Promise<{ left: string[] }> {
  const m = await mount(api);
  await click(S.KIT.next);
  return m;
}

describe('step 1: your kit file', () => {
  it('lists the found kit, preselected, and asks for nothing yet', async () => {
    await mount(fakeApi());
    expect(text()).toContain(S.KIT.title);
    expect(text()).toContain('agentlink-recovery-kit-2026-11-03.alkk');
    expect(text()).toContain('In Downloads');
    expect(text()).toContain('4.2 MB');
    expect(host.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true);
    expect(text()).toContain(S.KIT.assurance);
    expect(text()).toContain('Step 1 of 4 · Your kit file');
    expect(boxes()).toHaveLength(0);
  });

  it.each([
    ['not_a_kit', S.KIT.notAKit],
    ['newer_version', S.KIT.newer],
    ['other_owner', S.KIT.otherOwner],
  ] as const)('shows the public header problem %s before any code', async (header, words) => {
    await mount(fakeApi({ header: () => ok({ header, ownerPresent: false }) }));
    await click(S.KIT.next);
    expect(text()).toContain(words);
    if (header === 'other_owner') expect(text()).toContain(S.KIT.otherOwnerHint);
    expect(boxes()).toHaveLength(0);
  });

  it('opens "I don\'t have my kit file" with a way to start fresh', async () => {
    const { left } = await mount(fakeApi());
    await click(S.KIT.noFile);
    expect(text()).toContain(S.KIT.noFileBody);
    await click(S.KIT.startFresh);
    expect(left).toEqual(['/']);
  });

  it('uploads a chosen or dropped file and uses its handle', async () => {
    const api = fakeApi({ found: () => ok({ kits: [] }) });
    await mount(api);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'agentlink-recovery-kit.alkk');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(api.calls).toContain('upload');
    expect(text()).toContain(S.KIT.picked('agentlink-recovery-kit.alkk'));
  });

  it('Cancel leaves for Home', async () => {
    const { left } = await mount(fakeApi());
    await click(S.WIZARD.cancel);
    expect(left).toEqual(['/']);
  });
});

describe('step 2: your recovery code', () => {
  it('has six boxes, autocomplete off, and a paste fills all of them', async () => {
    await toCodeStep(fakeApi());
    expect(text()).toContain(S.CODE.title);
    expect(text()).toContain('26 Oct 2026');
    expect(boxes()).toHaveLength(6);
    for (const b of boxes()) {
      expect(b.getAttribute('autocomplete')).toBe('off');
      expect(b.maxLength).toBe(4);
    }
    expect(button(S.CODE.open)?.disabled).toBe(true);
    await paste(0, 'K7QM-2xwd 9RFA h3nv Z4TC 8BPE');
    expect(boxes().map((b) => b.value)).toEqual(['K7QM', '2XWD', '9RFA', 'H3NV', 'Z4TC', '8BPE']);
    expect(button(S.CODE.open)?.disabled).toBe(false);
  });

  it('types into one box and keeps letters and digits only', async () => {
    await toCodeStep(fakeApi());
    await type(0, 'k7-q m');
    expect(boxes()[0]?.value).toBe('K7QM');
  });

  it('sends the code to open, wipes the boxes and moves to step 3', async () => {
    const seen: string[] = [];
    const api = fakeApi({
      open: (_h, code) => {
        seen.push(new TextDecoder().decode(code));
        return ok({ kit: 'kit-handle', summary: SUMMARY });
      },
    });
    await toCodeStep(api);
    await fillCode();
    await click(S.CODE.open);
    expect(seen).toEqual([CODE.toUpperCase()]);
    expect(text()).toContain(S.REVIEW.title);
  });

  it('says a wrong code changed nothing and keeps the groups to correct', async () => {
    const api = fakeApi({ open: () => Promise.resolve({ kind: 'error', problem: 'wrong_code' }) });
    await toCodeStep(api);
    await fillCode();
    await click(S.CODE.open);
    expect(text()).toContain(S.CODE.wrong);
    expect(boxes()[0]?.value).toBe('K7QM');
  });

  it('counts down a wait after too many wrong tries', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const api = fakeApi({
      open: () => Promise.resolve({ kind: 'error', problem: 'wait', retryAfter: 30 }),
    });
    await toCodeStep(api);
    await fillCode();
    await click(S.CODE.open);
    expect(text()).toContain('Too many wrong tries. Wait 30 seconds.');
    expect(button(S.CODE.open)?.disabled).toBe(true);
  });

  it('names a damaged file', async () => {
    await toCodeStep(
      fakeApi({ open: () => Promise.resolve({ kind: 'error', problem: 'damaged' }) }),
    );
    await fillCode();
    await click(S.CODE.open);
    expect(text()).toContain(S.CODE.damaged);
  });

  it('explains a lost recovery code', async () => {
    await toCodeStep(fakeApi());
    await click(S.CODE.lost);
    expect(text()).toContain(S.CODE.lostBody);
  });

  it('shows the Never-give-it-to-your-AI notice and the assurance', async () => {
    await toCodeStep(fakeApi());
    expect(text()).toContain(S.CODE.warnTitle);
    expect(text()).toContain(S.CODE.warn);
    expect(text()).toContain(S.CODE.assurance);
  });

  it('REL051-UF3 (R1-UI-06): a double click on Confirm with Touch ID asks once and confirms once', async () => {
    const presence = vi.fn(() => ok({}));
    const api = fakeApi({
      header: () => ok({ header: 'ok' as const, ownerPresent: true }),
      presence,
    });
    let answer: ((p: PresenceProof) => void) | undefined;
    const passkeyProof = vi.fn(
      (): Promise<PresenceProof | undefined> =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await mount(api, { owner: owner(true), passkeyProof });
    await click(S.KIT.next);
    const confirm = button(S.PRESENCE.usePasskey('Touch ID'));
    await act(async () => confirm?.click());
    await act(async () => confirm?.click());
    expect(passkeyProof).toHaveBeenCalledTimes(1);
    expect(confirm?.disabled).toBe(true);
    await act(async () =>
      answer?.({ kind: 'passkey', gesture: () => Promise.resolve(new Uint8Array([1])) }),
    );
    await settle();
    expect(presence).toHaveBeenCalledTimes(1);
    expect(text()).toContain(S.CODE.title);
  });

  it('asks for presence first on a computer that already has an owner', async () => {
    const presence = vi.fn(() => ok({}));
    const api = fakeApi({
      header: () => ok({ header: 'ok' as const, ownerPresent: true }),
      presence,
    });
    await mount(api, { owner: owner(false) });
    await click(S.KIT.next);
    expect(text()).toContain(S.PRESENCE.title);
    const field = host.querySelector<HTMLInputElement>(
      'input[type="password"]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        field,
        'master',
      );
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(S.PRESENCE.useCode);
    expect(presence).toHaveBeenCalled();
    expect(text()).toContain(S.CODE.title);
  });
});

describe('Check my kit', () => {
  it('shows two steps, then "This kit opens." and writes nothing', async () => {
    const api = fakeApi();
    await mount(api, { mode: 'check' });
    expect(text()).toContain('Step 1 of 2');
    await click(S.KIT.next);
    await fillCode();
    await click(S.CODE.open);
    expect(text()).toContain('This kit opens.');
    expect(text()).toContain('Tali, Work, Macbook and Demo');
    expect(api.calls).toContain('check');
    expect(api.calls).not.toContain('open');
    expect(api.calls).not.toContain('applyBegin');
  });

  it('UX1113-QA2 N4: names an ID already on this computer by its label', async () => {
    const labelled: Summary = {
      ...SUMMARY,
      ids: SUMMARY.ids.map((r) => (r.state === 'already_here' ? { ...r, label: 'My Mac' } : r)),
    };
    const api = fakeApi({ check: () => ok({ summary: labelled }) });
    await mount(api, { mode: 'check' });
    await click(S.KIT.next);
    await fillCode();
    await click(S.CODE.open);
    expect(text()).toContain('Tali, Work, My Mac and Demo');
  });

  it('says a wrong code changed nothing', async () => {
    await mount(
      fakeApi({ check: () => Promise.resolve({ kind: 'error', problem: 'wrong_code' }) }),
      {
        mode: 'check',
      },
    );
    await click(S.KIT.next);
    await fillCode();
    await click(S.CODE.open);
    expect(text()).toContain("That code doesn't open this kit.");
    expect(text()).toContain('Nothing was changed.');
  });
});

async function toReview(api: RestoreApi): Promise<{ left: string[] }> {
  const m = await toCodeStep(api);
  await fillCode();
  await click(S.CODE.open);
  return m;
}

describe('step 3: what comes back', () => {
  it('shows a row per ID with its case', async () => {
    await toReview(fakeApi());
    expect(text()).toContain(S.REVIEW.title);
    expect(text()).toContain('3 people · messages up to');
    expect(text()).toContain('This computer already has an ID called work.');
    // UX1113-QA2 (Fable ruling): the folder is not a name; the slug is never shown as one.
    expect(text()).not.toContain('work-2');
    expect(text()).toContain(S.REVIEW.hereLine);
    expect(text()).toContain("A removed ID can't come back.");
    expect(text()).toContain(S.REVIEW.willBeRestored);
    expect(text()).toContain(S.REVIEW.alreadyHere);
    expect(text()).toContain(S.REVIEW.removedEarlier);
    const boxesIn = [...host.querySelectorAll<HTMLInputElement>('.rs-row input[type="checkbox"]')];
    expect(boxesIn.map((b) => b.checked)).toEqual([true, true, false, false]);
    expect(boxesIn.map((b) => b.disabled)).toEqual([false, false, true, true]);
    expect(button('Restore 2 IDs')).toBeDefined();
    expect(text()).toContain(S.REVIEW.comesBack);
    expect(text()).toContain(S.REVIEW.doNext);
    // UX1113-R1-LABEL: the kit names each ID by its folder; its name comes back with it.
    expect(text()).toContain(S.REVIEW.nameHint);
  });

  it('UX1113-QA2: a clash is said honestly: it comes back next to it, still named the same; no folder editor', async () => {
    const begin = vi.fn(() =>
      ok({
        answer: {
          status: 'done' as const,
          ids: [{ agentId: 'a', name: 'work-2', outcome: 'restored' as const }],
        },
      }),
    );
    const labelled: Summary = {
      ...SUMMARY,
      ids: SUMMARY.ids.map((r) => (r.state === 'name_taken' ? { ...r, takenLabel: 'Work' } : r)),
    };
    await toReview(
      fakeApi({ applyBegin: begin, open: () => ok({ kit: 'kit-handle', summary: labelled }) }),
    );
    expect(text()).toContain(S.REVIEW.takenLine(0, 'Work'));
    expect(text()).toContain(
      'This computer already has an ID called Work. This one comes back next to it, still named the same. You can rename it afterwards.',
    );
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      'Change name',
    );
    expect(host.querySelector('.rs-row-edit')).toBeNull();
    await click('Restore 2 IDs');
    const call = begin.mock.calls[0] as unknown as [string, string[], Record<string, string>];
    expect(call[1]).toEqual(['0x' + '1'.repeat(40), '0x' + '2'.repeat(40)]);
    // The folder only (the server's suggestion); the ID keeps its name.
    expect(call[2]).toEqual({ ['0x' + '2'.repeat(40)]: 'work-2' });
  });

  it('REL051-UF3 (R1-UI-08): rows use the name people see; the folder only Under the hood', async () => {
    const named: Summary = {
      ...SUMMARY,
      ids: [
        // Restore on the same computer: the server knows the label of an ID already here.
        { ...SUMMARY.ids[2]!, label: 'Ana Novak' },
        // A new ID from the first-run folder: its label is inside the kit, read once restored.
        { ...SUMMARY.ids[0]!, name: 'default' },
      ],
    };
    await toReview(fakeApi({ open: () => ok({ kit: 'kit-handle', summary: named }) }));
    const rowNames = [...host.querySelectorAll('.rs-row-name')].map((n) => n.textContent);
    expect(rowNames).toEqual(['Ana Novak', S.REVIEW.firstId]);
    const boxes = [...host.querySelectorAll<HTMLInputElement>('.rs-row input[type="checkbox"]')];
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Restore Ana Novak',
      `Restore ${S.REVIEW.firstId}`,
    ]);
    expect(text()).not.toContain('macbook');
    expect(text()).not.toContain('default');
    // R1-UI-26: no Under the hood block in Simple.
    expect(host.querySelector('.rs-hood')).toBeNull();
    expect(text()).not.toContain(S.REVIEW.hood);
  });

  it('REL051-R2C (R2-CLASS-05): a new ID in another folder reads as a name, never a bare folder', () => {
    const base = SUMMARY.ids[0]!;
    expect(rowName({ ...base, name: 'work' })).toBe('Work');
    expect(rowName({ ...base, name: 'ana-novak' })).toBe('Ana novak');
    expect(rowName({ ...base, name: 'work', label: 'Work' })).toBe('Work');
  });

  it('keeps Restore off when nothing is ticked', async () => {
    await toReview(fakeApi());
    for (const b of host.querySelectorAll<HTMLInputElement>('.rs-row input:not(:disabled)')) {
      await act(async () => {
        b.click();
      });
    }
    expect(button('Restore 0 IDs')?.disabled).toBe(true);
  });

  it('says so when nothing can be restored (an owner is here)', async () => {
    const only: Summary = { ...SUMMARY, ids: SUMMARY.ids.slice(2) };
    const done = vi.fn();
    const restore = vi.fn();
    await act(async () => {
      root.render(
        h(ReviewStep, {
          summary: only,
          state: { selected: new Set(), names: {} },
          onState: () => undefined,
          sensor: 'Touch ID',
          newOwner: false,
          working: false,
          error: undefined,
          onRestore: restore,
          onBack: () => undefined,
          onDone: done,
        }),
      );
    });
    expect(text()).toContain(S.REVIEW.nothing);
    expect(button(S.REVIEW.finishOwner)).toBeUndefined();
    await click(S.REVIEW.done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
  });

  it('Back cancels the held kit and returns to step 1', async () => {
    const api = fakeApi();
    await toReview(api);
    await click(S.WIZARD.back);
    expect(api.calls).toContain('cancel');
    expect(text()).toContain(S.KIT.title);
  });
});

describe('step 4: protect and reconnect', () => {
  it('same computer: no new code, "unchanged", Go to Home enabled', async () => {
    const m = await toReview(fakeApi());
    await click('Restore 2 IDs');
    expect(text()).toContain("You're back. 1 ID restored.");
    expect(text()).toContain('Touch ID and your master code are unchanged.');
    expect(host.querySelector('[data-master-code]')).toBeNull();
    expect(button(S.PROTECT.home)?.disabled).toBe(false);
    await click(S.PROTECT.home);
    expect(m.left).toEqual(['/']);
  });

  async function newComputer(): Promise<{ left: string[] }> {
    const api = fakeApi({
      applyBegin: () =>
        ok({
          answer: {
            status: 'gesture' as const,
            nonce: 'n',
            publicKey: {
              rpId: 'localhost',
              rpName: 'AgentLink',
              userId: 'AA',
              userName: 'u',
              challenge: 'AA',
              prfSalt: 'AA',
            },
          },
        }),
      applyFinish: () =>
        ok({
          answer: {
            status: 'done' as const,
            ids: [
              { agentId: 'a', name: 'tali', outcome: 'restored' as const },
              { agentId: 'b', name: 'work-2', outcome: 'restored' as const },
            ],
            masterCode: MASTER,
            touchId: true,
          },
        }),
    });
    const passkey = await import('./passkey.js');
    vi.spyOn(passkey, 'canRestoreHere').mockReturnValue(true);
    vi.spyOn(passkey, 'createRestorePasskey').mockResolvedValue({
      kind: 'ok',
      body: new Uint8Array([1]),
      created: [new Uint8Array([1])],
    });
    const m = await toReview(api);
    await click('Restore 2 IDs');
    return m;
  }

  // IR-REL051-R2C-1 (High): a rolled-back computer: the IDs are here, no owner. Step 3 must finish
  // the owner from the kit (owner-only completion), never "Done" that cancels and leaves no owner.
  it('IDs already here and no owner: Finish restoring makes the owner and shows the new master code', async () => {
    const begins: string[][] = [];
    const cancels: string[] = [];
    const here: Summary = {
      ...SUMMARY,
      ids: SUMMARY.ids.slice(0, 2).map((r) => ({ ...r, state: 'already_here' as const })),
    };
    const api = fakeApi({
      open: () => ok({ kit: 'kit-handle', summary: here }),
      cancel: (k: string) => {
        cancels.push(k);
        return ok({ status: 'cancelled' as const });
      },
      applyBegin: (_k, selection) => {
        begins.push([...selection]);
        return ok({
          answer: {
            status: 'gesture' as const,
            nonce: 'n',
            publicKey: {
              rpId: 'localhost',
              rpName: 'AgentLink',
              userId: 'AA',
              userName: 'u',
              challenge: 'AA',
              prfSalt: 'AA',
            },
          },
        });
      },
      applyFinish: () =>
        ok({ answer: { status: 'done' as const, ids: [], masterCode: MASTER, touchId: true } }),
    } as Partial<RestoreApi>);
    const passkey = await import('./passkey.js');
    vi.spyOn(passkey, 'canRestoreHere').mockReturnValue(true);
    vi.spyOn(passkey, 'createRestorePasskey').mockResolvedValue({
      kind: 'ok',
      body: new Uint8Array([1]),
      created: [new Uint8Array([1])],
    });
    await toReview(api);
    expect(button(S.REVIEW.done)).toBeUndefined();
    await click(S.REVIEW.finishOwner);
    expect(begins).toEqual([[]]);
    expect(cancels).toEqual([]);
    expect(host.querySelector('[data-master-code]')?.textContent).toBe(MASTER);
    // IR-REL051-R2C-2: step 4 names the IDs that are ready, never "0 IDs restored".
    expect(host.querySelector('h1')?.textContent).toBe(S.PROTECT.titleReady(2));
    expect(text()).not.toContain('0 IDs restored');
    expect(button(S.PROTECT.home)?.disabled).toBe(true);
    await typeBack(MASTER);
    expect(button(S.PROTECT.home)?.disabled).toBe(false);
  });

  it('IR-REL051-R2C-2: an AI app button never reads "Connect to" with no name', () => {
    expect(S.PROTECT.connect('')).toBe('Connect an AI app');
    expect(S.PROTECT.connect('Work')).toBe('Connect to Work');
  });

  it('new computer: the master code is shown once, Home waits for "I saved it"', async () => {
    await newComputer();
    expect(text()).toContain(S.PROTECT.codeTitle);
    expect(text()).toContain(S.PROTECT.shownOnce);
    expect(host.querySelector('[data-master-code]')?.textContent).toBe(MASTER);
    expect(text()).toContain(S.PROTECT.codeBody('Touch ID'));
    expect(button(S.PROTECT.copy)).toBeDefined();
    expect(button(S.PROTECT.print)).toBeDefined();
    expect(button(S.PROTECT.home)?.disabled).toBe(true);
    // A wrong code never counts as saved.
    await typeBack('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA');
    expect(button(S.PROTECT.home)?.disabled).toBe(true);
    expect(text()).toContain(S.PROTECT.typeBackWrong);
    await typeBack(MASTER.toLowerCase().replace(/-/g, ' '));
    expect(button(S.PROTECT.home)?.disabled).toBe(false);
  });

  it('R1-UI-02: Cancel on step 4 asks first while the new master code is not saved', async () => {
    const { left } = await newComputer();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await click(S.WIZARD.cancel);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0]?.[0])).toMatch(/only once/);
    expect(left).toEqual([]);
    expect(text()).toContain(S.PROTECT.codeTitle);
    confirm.mockReturnValue(true);
    await click(S.WIZARD.cancel);
    expect(left).toEqual(['/']);
    confirm.mockRestore();
  });

  it('R1-UI-02: once the new code is typed back, Cancel leaves without asking', async () => {
    const { left } = await newComputer();
    await typeBack(MASTER);
    const confirm = vi.spyOn(window, 'confirm');
    await click(S.WIZARD.cancel);
    expect(confirm).not.toHaveBeenCalled();
    expect(left).toEqual(['/']);
    confirm.mockRestore();
  });

  it('survives the page being mounted again for the ID that opened (step 4 keeps its result)', async () => {
    await newComputer();
    act(() => root.unmount());
    root = createRoot(host);
    await mount(fakeApi());
    expect(text()).toContain(S.PROTECT.codeTitle);
    expect(host.querySelector('[data-master-code]')?.textContent).toBe(MASTER);
  });

  it('prints from memory: only a print-sheet node, no download', async () => {
    await newComputer();
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    await click(S.PROTECT.print);
    expect(print).toHaveBeenCalled();
    expect(host.querySelector('.rs-print-sheet')?.textContent).toContain(MASTER);
    expect(host.querySelector('a[download]')).toBeNull();
  });

  it('never puts the codes in storage, the URL or an attribute', async () => {
    // The recovery code was typed on step 2: scan after step 3; then the master code after step 4.
    await newComputer();
    const secrets = [CODE, CODE.toUpperCase(), MASTER, MASTER.replace(/-/g, '')];
    const stores = [localStorage, sessionStorage].map((s) =>
      JSON.stringify(Object.fromEntries(Object.entries(s))),
    );
    for (const secret of secrets) {
      for (const dump of stores) expect(dump).not.toContain(secret);
      expect(location.href).not.toContain(secret);
      for (const el of host.querySelectorAll('*')) {
        for (const attr of el.getAttributeNames()) {
          expect(el.getAttribute(attr) ?? '').not.toContain(secret);
        }
      }
    }
  });

  it('the recovery code is not left in the boxes after the kit opens', async () => {
    await toReview(fakeApi());
    expect(host.querySelectorAll('.rs-code-box')).toHaveLength(0);
  });
});

describe('copy and accessibility', () => {
  it('has no vocabulary violation in any string', () => {
    expect(lintVocabulary(JSON.stringify(S))).toEqual([]);
  });

  it('code helpers ignore separators and case', () => {
    expect(clean('ab-cd ef​12')).toBe('ABCDEF12');
    expect(toGroups('K7QM2XWD')).toEqual(['K7QM', '2XWD', '', '', '', '']);
  });

  it.each(['kit', 'code', 'review'] as const)('step %s has no axe violation', async (step) => {
    const api = fakeApi();
    if (step === 'kit') await mount(api);
    else if (step === 'code') await toCodeStep(api);
    else await toReview(api);
    const results = await axe.run(host, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it('adds no animation of its own (reduced motion needs nothing)', () => {
    const css = Object.values(cssFiles)[0] as string;
    expect(css).not.toMatch(/transition|animation|@keyframes/);
  });
});

describe('round 2: busy, finish restoring, per-ID failure', () => {
  it('busy shows a calm sentence and Continue is off while a request is in flight', async () => {
    let release: (v: Awaited<ReturnType<RestoreApi['header']>>) => void = () => undefined;
    const api = fakeApi({
      header: () => new Promise((r) => (release = r)) as ReturnType<RestoreApi['header']>,
    });
    await mount(api);
    await click(S.KIT.next);
    expect(button(S.KIT.working)?.disabled).toBe(true);
    await act(async () => {
      button(S.KIT.working)?.click();
    });
    expect(api.calls.filter((c) => c === 'header')).toHaveLength(1);
    await act(async () => release({ kind: 'error', problem: 'busy' }));
    await settle();
    expect(text()).toContain('Still working on the last step…');
  });

  it('shows "Finish restoring" when first run left a restore unfinished', async () => {
    setFinishRestore(true);
    await mount(fakeApi());
    expect(text()).toContain('Finish restoring: choose your kit again');
  });

  it('first-run owner setup maps 409 finish_restore to its own problem', async () => {
    const fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: 'finish_restore' }), { status: 409 }),
      )) as typeof globalThis.fetch;
    const r = await createSetupApi({ fetch, token: 't' }).begin('Ana');
    expect(r).toEqual({ kind: 'error', problem: 'finish_restore' });
  });

  it('first-run owner setup maps 409 keychain_unavailable to a retryable message', async () => {
    const fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: 'keychain_unavailable' }), { status: 409 }),
      )) as typeof globalThis.fetch;
    const r = await createSetupApi({ fetch, token: 't' }).begin('Ana');
    expect(r).toEqual({ kind: 'error', problem: 'keychain_unavailable' });
    const { SETUP_MESSAGES } = await import('../first-run/strings.js');
    expect(SETUP_MESSAGES.keychain_unavailable).toBe(
      "AgentLink couldn't check this computer's keychain. Try again.",
    );
  });

  it('a per-ID failed answer keeps the outcomes and step 4 says that ID was not restored', async () => {
    const fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: 'failed',
            ids: [
              { agentId: 'a', name: 'tali', outcome: 'restored' },
              { agentId: 'b', name: 'work', outcome: 'failed' },
            ],
          }),
          { status: 500 },
        ),
      )) as typeof globalThis.fetch;
    const real = createRestoreApi({ fetch, token: 't' });
    await toReview(
      fakeApi({
        applyBegin: (k, s, n) => real.applyBegin(k, s, n),
      }),
    );
    await click('Restore 2 IDs');
    expect(text()).toContain("You're back. 1 ID restored.");
    expect(text()).toContain(S.REVIEW.notRestored('work'));
  });

  it('UX1113-R1-LABEL: step 4 names restored IDs by their verified label; a hostile one falls back', async () => {
    const fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'done',
            ids: [
              { agentId: 'a', name: 'default', label: 'Ana', outcome: 'restored' },
              { agentId: 'b', name: 'work', label: '\u202eevil\u202c', outcome: 'restored' },
              { agentId: 'c', name: 'home', label: 'x'.repeat(40), outcome: 'failed' },
            ],
            touchId: 'unchanged',
          }),
          { status: 200 },
        ),
      )) as typeof globalThis.fetch;
    const real = createRestoreApi({ fetch, token: 't' });
    await toReview(
      fakeApi({
        applyBegin: (k, s, n) => real.applyBegin(k, s, n),
      }),
    );
    await click('Restore 2 IDs');
    expect(text()).toContain("You're back. 2 IDs restored.");
    expect(text()).toContain('Ana and work');
    expect(text()).not.toContain('default and');
    expect(text()).not.toContain('\u202e');
    expect(text()).toContain(S.REVIEW.notRestored('home'));
    expect(host.querySelector('.rs-lead bdi')?.textContent).toBe('Ana');
  });
});
