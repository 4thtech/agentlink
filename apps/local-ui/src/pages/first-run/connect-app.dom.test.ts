// @vitest-environment jsdom
// REL051-UF3 (R1-UI-06): connecting an AI app asks for Touch ID once per press. A double click on
// "Apply with Touch ID" starts one gesture and one apply.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PresenceProof } from '../contacts/owner.js';
import type { AppChange, AppsApi } from './apps-api.js';
import { ConnectApp } from './connect-app.js';
import { CONNECT as T } from './strings.js';

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

const CHANGE: AppChange = {
  kind: 'connect',
  app: 'claude-code',
  name: 'Claude Code',
  path: '/tmp/home/.claude.json',
  folder: 'default',
  oldEntry: null,
  newEntry: { command: 'npx' },
  oldAgent: null,
  newAgent: null,
  changeId: 'c1',
};

it('a double click on Apply with Touch ID asks once and applies once', async () => {
  const apply = vi.fn(() => Promise.resolve({ kind: 'done' as const }));
  const appsApi = {
    preview: () => Promise.resolve({ kind: 'change' as const, change: CHANGE }),
    passkey: () => Promise.resolve({ credentialId: 'c', prfSalt: 's' }),
    apply,
  } as unknown as AppsApi;
  let answer: ((p: PresenceProof) => void) | undefined;
  const passkeyProof = vi.fn(
    (): Promise<PresenceProof | undefined> =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  await act(async () => {
    root.render(
      createElement(ConnectApp, {
        appsApi,
        appId: 'claude-code',
        appName: 'Claude Code',
        folder: 'default',
        agentLabel: 'Ana',
        sensor: 'Touch ID',
        passkeyProof,
        onDone: () => undefined,
        onConnected: () => undefined,
      }),
    );
  });
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  const go = [...host.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === T.apply('Touch ID'),
  );
  expect(go).toBeDefined();
  await act(async () => go?.click());
  await act(async () => go?.click());
  expect(passkeyProof).toHaveBeenCalledTimes(1);
  expect(go?.disabled).toBe(true);
  await act(async () =>
    answer?.({ kind: 'passkey', gesture: () => Promise.resolve(new Uint8Array([1])) }),
  );
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  expect(apply).toHaveBeenCalledTimes(1);
});
