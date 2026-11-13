// @vitest-environment jsdom
// UX1113-N2: IDs. Rename, Remove, Resume and "Update name" are one step each: the action's own button
// is the sensor, the master code a link; one click -> one gesture -> one request. A cancelled sensor
// keeps the state and sends nothing. No second box after the button.
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerClient, PasskeyInfo, PresenceProof } from '../contacts/owner.js';
import { PresenceSeamsContext } from '../contacts/presence-button.js';
import type { AgentsApi } from './api.js';
import type { AgentRow } from './data.js';
import { ResumeGate } from './parts.js';
import { RemoveSheet, RenameEditor } from './sheets.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PASSKEY: PasskeyInfo = { credentialId: 'cred', prfSalt: 'salt' };
const PROOF: PresenceProof = { kind: 'passkey', gesture: () => Promise.resolve(undefined) };
const answer: { proof: PresenceProof | undefined } = { proof: PROOF };
const gesture = vi.fn(() => Promise.resolve(answer.proof));

const ROW: AgentRow = {
  name: 'work',
  label: 'Work',
  current: true,
  available: true,
  removing: false,
  contacts: 0,
  running: false,
  apps: [],
};

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  gesture.mockClear();
  answer.proof = PROOF;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = async (ms = 0): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
};
const text = (): string => host.textContent ?? '';
const named = (pattern: RegExp): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => pattern.test((b.textContent ?? '').trim()));
const click = async (el: HTMLElement | undefined): Promise<void> => {
  if (el === undefined) throw new Error(`no control in: ${text()}`);
  await act(async () => {
    el.click();
  });
  await settle();
};
const type = async (name: string, value: string): Promise<void> => {
  const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (input === null) throw new Error(`no input ${name}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(400);
};

interface Rig {
  readonly renames: [unknown, PresenceProof][];
  readonly removes: [unknown, PresenceProof][];
  readonly resumes: PresenceProof[];
  readonly codes: PresenceProof[];
}

async function show(ui: (api: AgentsApi, owner: OwnerClient) => ReactElement): Promise<Rig> {
  const rig: Rig = { renames: [], removes: [], resumes: [], codes: [] };
  const api = {
    list: () =>
      Promise.resolve({
        kind: 'ok',
        list: { switchable: true, current: 'work', label: 'Work', agents: [ROW] },
      }),
    labelCheck: () => Promise.resolve('ok'),
    rename: (input: unknown, proof: PresenceProof) => {
      rig.renames.push([input, proof]);
      return Promise.resolve({ kind: 'done' });
    },
    remove: (input: unknown, proof: PresenceProof) => {
      rig.removes.push([input, proof]);
      return Promise.resolve({ kind: 'done' });
    },
    resume: (proof: PresenceProof) => {
      rig.resumes.push(proof);
      return Promise.resolve({ kind: 'done' });
    },
  } as unknown as AgentsApi;
  const owner: OwnerClient = {
    passkey: () => Promise.resolve(PASSKEY),
    post: () => Promise.resolve({ kind: 'done' }),
  };
  await act(async () => {
    root.render(
      createElement(
        PresenceSeamsContext.Provider,
        { value: { gesture, platform: 'mac', userAgent: 'Mozilla/5.0 (Macintosh)' } },
        ui(api, owner),
      ),
    );
  });
  await settle();
  return rig;
}

const noSecondBox = (): void => {
  expect(host.querySelector('input[name="owner-code"]')).toBeNull();
};

describe('IDs: one step, one gesture', () => {
  it('Rename: one click, one gesture, one request; the name is checked before the click', async () => {
    const rig = await show((api, owner) =>
      createElement(RenameEditor, {
        row: ROW,
        api,
        owner,
        onDone: () => undefined,
        onCancel: () => undefined,
        onChanged: () => undefined,
      }),
    );
    await type('agent-label', 'Home');
    await click(named(/^Rename with Touch ID$/));
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(rig.renames).toEqual([[{ name: 'work', label: 'Home' }, PROOF]]);
    noSecondBox();
  });

  it('Rename: a cancelled sensor keeps the text and sends nothing', async () => {
    answer.proof = undefined;
    const rig = await show((api, owner) =>
      createElement(RenameEditor, {
        row: ROW,
        api,
        owner,
        onDone: () => undefined,
        onCancel: () => undefined,
        onChanged: () => undefined,
      }),
    );
    await type('agent-label', 'Home');
    await click(named(/^Rename with Touch ID$/));
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(rig.renames).toEqual([]);
    expect(host.querySelector<HTMLInputElement>('input[name="agent-label"]')?.value).toBe('Home');
    expect(text()).toContain("Touch ID wasn't used");
  });

  it('Rename: the master code link is the other way, and an unchanged name holds it too', async () => {
    const rig = await show((api, owner) =>
      createElement(RenameEditor, {
        row: ROW,
        api,
        owner,
        onDone: () => undefined,
        onCancel: () => undefined,
        onChanged: () => undefined,
      }),
    );
    // The label is unchanged: both the button and the link are held.
    expect(named(/^Rename with Touch ID$/)?.disabled).toBe(true);
    expect(named(/^Use your master code instead$/)?.disabled).toBe(true);
    await type('agent-label', 'Home');
    await click(named(/^Use your master code instead$/));
    expect(gesture).not.toHaveBeenCalled();
    expect(host.querySelector('input[name="owner-code"]')).not.toBeNull();
    expect(rig.renames).toEqual([]);
  });

  it('Remove: typing the name is the last thing before the one button; one gesture, one request', async () => {
    const rig = await show((api, owner) =>
      createElement(RemoveSheet, {
        row: ROW,
        api,
        owner,
        onClose: () => undefined,
        onChanged: () => undefined,
        onRemoved: () => undefined,
        onAgentChanged: () => undefined,
      }),
    );
    const sheet = (): HTMLElement => document.body;
    expect(sheet().textContent).toContain('Work');
    const input = document.body.querySelector<HTMLInputElement>('input[name="confirm-label"]');
    if (input === null) throw new Error('no name field');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'Work',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    const button = [...document.body.querySelectorAll('button')].find((b) =>
      /^Remove with Touch ID$/.test((b.textContent ?? '').trim()),
    );
    if (button === undefined) throw new Error('no remove button');
    await click(button);
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(rig.removes).toEqual([[{ name: 'work', typedLabel: 'Work' }, PROOF]]);
    expect(document.body.querySelector('input[name="owner-code"]')).toBeNull();
  });

  it('Resume: the banner button is the gesture; one request', async () => {
    const rig = await show((api, owner) =>
      createElement(ResumeGate, {
        row: ROW,
        api,
        owner,
        onResumed: () => undefined,
        onAgentChanged: () => undefined,
      }),
    );
    await click(named(/^Resume with Touch ID$/));
    expect(gesture).toHaveBeenCalledTimes(1);
    expect(rig.resumes).toEqual([PROOF]);
    noSecondBox();
  });

  it('Resume: a cancelled sensor sends nothing and keeps the button', async () => {
    answer.proof = undefined;
    const rig = await show((api, owner) =>
      createElement(ResumeGate, {
        row: ROW,
        api,
        owner,
        onResumed: () => undefined,
        onAgentChanged: () => undefined,
      }),
    );
    await click(named(/^Resume with Touch ID$/));
    expect(rig.resumes).toEqual([]);
    expect(named(/^Resume with Touch ID$/)).toBeDefined();
  });
});
