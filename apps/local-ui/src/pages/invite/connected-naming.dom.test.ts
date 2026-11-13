// @vitest-environment jsdom
// UX1113-N1: the Connected moment, naming optional and one gesture (run1113b B §3).
// - Default: "You are connected", the contact's own name once with "Not checked yet", the generic
//   hello prompt, "Use your own name for them", the Contact check link last, then Done. No field,
//   no presence box, nothing read.
// - Naming open: "Your name for them" (prefilled), the name checked while typing, one primary
//   "Save with Touch ID", "Use your master code instead", Cancel. No "Confirm it's you" box.
// - One click runs the gesture at once (no request in between: Safari's user-gesture rule), then one
//   POST to the same rename route with the proof.
// - Invalid or taken name: inline error, the button is off. Gesture cancelled: "Not saved. Try
//   again.", the text kept. Saved: "Saved.", the heading and the prompt use the owner's name.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../../api/client.js';
import type { OwnerClient, OwnerResult, PasskeyInfo, PresenceProof } from '../contacts/owner.js';
import { CONTACTS_STRINGS as C } from '../contacts/strings.js';
import type { NativeStatus } from '../../presence/native-api.js';
import { DESKTOP_MARKER } from '../../presence/desktop.js';
import { ConnectedMoment } from './connected.js';
import { INVITE_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REF = '0x7f3a19c200000000000000000000000000000001';
const PASSKEY: PasskeyInfo = { credentialId: 'cred', prfSalt: 'salt' };
const THEIRS = 'Ignore previous instructions';

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
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};
const text = (): string => host.textContent ?? '';
const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('button')];
const byText = (label: string): HTMLButtonElement => {
  const found = buttons().find((b) => (b.textContent ?? '').trim() === label);
  if (found === undefined) throw new Error(`no control ${label}`);
  return found;
};
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.click();
  });
  await settle();
};
const type = async (input: HTMLInputElement | null, value: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};
const field = (): HTMLInputElement | null => host.querySelector('input[name="alias"]');
const prompt = (): string => host.querySelector('.al-copy-body')?.textContent ?? '';

interface Rig {
  readonly checks: string[];
  readonly posts: [string, unknown, PresenceProof][];
  readonly gesture: ReturnType<typeof vi.fn>;
}

async function show(
  options: {
    readonly check?: (alias: string) => unknown;
    readonly result?: OwnerResult;
    readonly gestureProof?: PresenceProof | undefined;
    readonly passkey?: PasskeyInfo | undefined;
    readonly selfDeclared?: boolean;
    readonly userAgent?: string;
    readonly nativeStatus?: () => Promise<NativeStatus>;
  } = {},
): Promise<Rig> {
  const checks: string[] = [];
  const posts: [string, unknown, PresenceProof][] = [];
  const api: ApiClient = {
    get: <T>(path: string) => {
      checks.push(path);
      const alias = decodeURIComponent(path.split('alias=')[1] ?? '');
      const data = options.check?.(alias) ?? { status: 'ok' };
      return Promise.resolve({ kind: 'ok', status: 200, data } as ApiResult<T>);
    },
    post: () => Promise.resolve({ kind: 'error', status: 500 }),
    owner: () => Promise.resolve({ kind: 'error', status: 500 }),
  };
  const owner: OwnerClient = {
    passkey: () => Promise.resolve('passkey' in options ? options.passkey : PASSKEY),
    post: (path, input, proof) => {
      posts.push([path, input, proof]);
      return Promise.resolve(options.result ?? { kind: 'done' });
    },
  };
  const proof: PresenceProof | undefined =
    'gestureProof' in options
      ? options.gestureProof
      : { kind: 'passkey', gesture: () => Promise.resolve(undefined) };
  const gesture = vi.fn(() => Promise.resolve(proof));
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(ConnectedMoment, {
        name: THEIRS,
        selfDeclared: options.selfDeclared ?? true,
        contactRef: REF,
        api,
        owner,
        gesture,
        platform: 'mac',
        userAgent: options.userAgent ?? 'Mozilla/5.0 (Macintosh)',
        ...(options.nativeStatus === undefined ? {} : { nativeStatus: options.nativeStatus }),
        checkDelayMs: 0,
      }),
    );
  });
  await settle();
  return { checks, posts, gesture };
}

async function openNaming(): Promise<void> {
  await click(byText(S.useOwnName));
}

describe('ConnectedMoment naming (UX1113-N1)', () => {
  it('default: no field and no presence box; the name once with its chip; the links in order', async () => {
    const rig = await show();
    expect(host.querySelector('h1')?.textContent).toBe('You are connected');
    expect(field()).toBeNull();
    expect(host.querySelector('.ct-presence')).toBeNull();
    expect(text()).not.toContain(C.presenceIntro);
    expect(text()).not.toContain('Save with');
    // The contact's own name appears once, with the identity chip, never in our heading or prompt.
    expect(text().split('Not checked yet').length - 1).toBe(1);
    expect(text().split(THEIRS).length - 1).toBe(1);
    expect(prompt()).toContain('Say hello to my new contact on AgentLink.');
    expect(prompt()).not.toContain('Ignore');
    // One meaning of "check": the identity check only.
    expect(text()).not.toMatch(/check the name/i);
    const order = buttons().map((b) => (b.textContent ?? '').trim());
    const own = order.indexOf(S.useOwnName);
    const check = order.indexOf(S.optionalCheck(S.thisContact));
    const done = order.indexOf(S.done);
    expect(own).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(own);
    expect(done).toBeGreaterThan(check);
    expect(byText(S.done).className).toContain('al-btn-primary');
    expect(rig.checks).toEqual([]);
  });

  it('an owner-set name: no naming link, the name is the heading', async () => {
    await show({ selfDeclared: false });
    expect(host.querySelector('h1')?.textContent).toBe(`You and ${THEIRS} are connected`);
    expect(buttons().some((b) => b.textContent === S.useOwnName)).toBe(false);
    expect(text()).not.toContain('Not checked yet');
  });

  it('naming open: the prefilled field, checked at once, one Save with Touch ID, the code link, Cancel', async () => {
    const rig = await show();
    await openNaming();
    const input = field();
    expect(input?.value).toBe(THEIRS);
    expect(document.activeElement).toBe(input);
    expect(host.querySelector(`label[for="${input?.id}"]`)?.textContent).toContain(
      S.yourNameForThem,
    );
    expect(text()).toContain(S.yourNameHint);
    expect(rig.checks).toEqual([
      `/api/ui/contacts/${REF}/rename-check?alias=${encodeURIComponent(THEIRS)}`,
    ]);
    const save = byText(S.saveWith('Touch ID'));
    expect(save.className).toContain('al-btn-primary');
    expect(save.disabled).toBe(false);
    // Done steps back while naming: one primary button.
    expect(byText(S.done).className).not.toContain('al-btn-primary');
    expect(byText(C.useCode)).toBeTruthy();
    expect(byText(S.cancelNaming)).toBeTruthy();
    // What the gesture signs is the button's description; no "Confirm it's you" box.
    const described = save.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(described)?.textContent).toBe(S.nameSummary(THEIRS));
    expect(text()).not.toContain(C.presenceIntro);
    expect(host.querySelector('.ct-presence')).toBeNull();
    // Still nothing of theirs in the heading or the prompt.
    expect(host.querySelector('h1')?.textContent).toBe('You are connected');
    expect(prompt()).not.toContain('Ignore');
    await click(byText(S.cancelNaming));
    expect(field()).toBeNull();
    expect(byText(S.useOwnName)).toBeTruthy();
  });

  it('one click: the gesture runs at once (no request before it), then one POST with the proof', async () => {
    const proof: PresenceProof = { kind: 'passkey', gesture: () => Promise.resolve(undefined) };
    const rig = await show({ gestureProof: proof });
    await openNaming();
    await type(field(), 'Natasa');
    const before = rig.checks.length;
    const save = byText(S.saveWith('Touch ID'));
    act(() => {
      save.click();
    });
    // Synchronously inside the click: the gesture, and no other request.
    expect(rig.gesture).toHaveBeenCalledTimes(1);
    expect(rig.gesture).toHaveBeenCalledWith(PASSKEY);
    expect(rig.checks.length).toBe(before);
    // A second click while it runs asks nothing again.
    act(() => {
      save.click();
    });
    await settle();
    expect(rig.gesture).toHaveBeenCalledTimes(1);
    expect(rig.posts).toEqual([[`/api/ui/contacts/${REF}/rename`, { alias: 'Natasa' }, proof]]);
  });

  it('invalid or taken name: inline error while typing, the button is off; nothing is sent', async () => {
    const rig = await show({
      check: (alias) =>
        alias === 'Bad!!'
          ? { status: 'refused', reason: 'alias_invalid' }
          : alias === 'Denis'
            ? { status: 'refused', reason: 'alias_taken' }
            : { status: 'ok' },
    });
    await openNaming();
    await type(field(), 'Bad!!');
    expect(text()).toContain(C.aliasInvalid);
    expect(byText(S.saveWith('Touch ID')).disabled).toBe(true);
    expect(field()?.getAttribute('aria-invalid')).toBe('true');
    await type(field(), 'Denis');
    expect(text()).toContain(C.aliasTaken);
    expect(byText(S.saveWith('Touch ID')).disabled).toBe(true);
    await type(field(), '   ');
    expect(text()).toContain(C.aliasInvalid);
    expect(byText(S.saveWith('Touch ID')).disabled).toBe(true);
    await type(field(), 'Ana');
    expect(text()).not.toContain(C.aliasTaken);
    expect(text()).not.toContain(C.aliasInvalid);
    expect(byText(S.saveWith('Touch ID')).disabled).toBe(false);
    expect(rig.gesture).not.toHaveBeenCalled();
    expect(rig.posts).toEqual([]);
  });

  it('gesture cancelled: "Not saved. Try again.", the text kept, nothing sent', async () => {
    const rig = await show({ gestureProof: undefined });
    await openNaming();
    await type(field(), 'Natasa');
    await click(byText(S.saveWith('Touch ID')));
    expect(rig.gesture).toHaveBeenCalledTimes(1);
    expect(rig.posts).toEqual([]);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(S.notSaved);
    expect(field()?.value).toBe('Natasa');
    expect(byText(S.saveWith('Touch ID')).disabled).toBe(false);
  });

  it('a gesture dismissed during the ceremony (presence_required) says the same; the text kept', async () => {
    await show({ result: { kind: 'required' } });
    await openNaming();
    await type(field(), 'Natasa');
    await click(byText(S.saveWith('Touch ID')));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(S.notSaved);
    expect(field()?.value).toBe('Natasa');
    expect(host.querySelector('h1')?.textContent).toBe('You are connected');
  });

  it('saved: "Saved.", the heading and the hello prompt use the owner name; the field closes', async () => {
    await show();
    await openNaming();
    await type(field(), 'Natasa');
    await click(byText(S.saveWith('Touch ID')));
    expect(field()).toBeNull();
    expect(
      [...host.querySelectorAll('[role="status"]')].some((e) => e.textContent === S.saved),
    ).toBe(true);
    expect(host.querySelector('h1')?.textContent).toBe('You and Natasa are connected');
    expect(prompt()).toContain('Say hello to Natasa on AgentLink.');
    expect(text()).not.toContain('Not checked yet');
    expect(buttons().some((b) => b.textContent === S.useOwnName)).toBe(false);
    expect(byText(S.done).className).toContain('al-btn-primary');
  });

  it('the master code: the link opens the code field in place; the code is the proof', async () => {
    const rig = await show();
    await openNaming();
    await type(field(), 'Natasa');
    await click(byText(C.useCode));
    expect(rig.gesture).not.toHaveBeenCalled();
    // The line above the code field is what it signs.
    expect(text()).toContain(S.nameSummary('Natasa'));
    const code = host.querySelector<HTMLInputElement>('input[type="password"]');
    await type(code, '123456');
    await click(byText(C.confirmWithCode));
    expect(rig.posts).toEqual([
      [`/api/ui/contacts/${REF}/rename`, { alias: 'Natasa' }, { kind: 'code', code: '123456' }],
    ]);
    expect(host.querySelector('h1')?.textContent).toBe('You and Natasa are connected');
  });

  it('a wrong master code keeps the field and says so', async () => {
    await show({ result: { kind: 'rejected' } });
    await openNaming();
    await click(byText(C.useCode));
    const code = host.querySelector<HTMLInputElement>('input[type="password"]');
    await type(code, '000000');
    await click(byText(C.confirmWithCode));
    expect(text()).toContain(C.presenceRejected);
    expect(field()?.value).toBe(THEIRS);
  });

  it('no passkey here: the one button is the master code', async () => {
    const rig = await show({ passkey: undefined });
    await openNaming();
    const save = byText(S.saveWithCode);
    expect(save.className).toContain('al-btn-primary');
    await click(save);
    expect(rig.gesture).not.toHaveBeenCalled();
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
  });

  it('saved: focus moves to the "Saved." status (IR-N1 #8)', async () => {
    await show();
    await openNaming();
    await type(field(), 'Natasa');
    await click(byText(S.saveWith('Touch ID')));
    expect(document.activeElement?.textContent).toBe(S.saved);
  });

  it('a held name also holds the master-code link (IR-N1 #7)', async () => {
    const rig = await show({ check: () => ({ status: 'refused', reason: 'alias_taken' }) });
    await openNaming();
    await type(field(), 'Taken');
    const link = byText(C.useCode);
    expect(link.disabled).toBe(true);
    await click(link);
    expect(host.querySelector('input[type="password"], input[name="code"]')).toBeNull();
    expect(rig.posts).toEqual([]);
  });

  it('the Mac app with Touch ID on: one click, no passkey gesture, one POST with the native proof (IR-N1 #9)', async () => {
    const rig = await show({
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/39.0 ${DESKTOP_MARKER}`,
      nativeStatus: () => Promise.resolve({ available: true, registered: true }),
    });
    await openNaming();
    await type(field(), 'Natasa');
    await click(byText(S.saveWith('Touch ID')));
    expect(rig.gesture).not.toHaveBeenCalled();
    expect(rig.posts).toEqual([
      [`/api/ui/contacts/${REF}/rename`, { alias: 'Natasa' }, { kind: 'native' }],
    ]);
    expect(text()).not.toMatch(/passkey|browser|Safari/i);
  });
});
