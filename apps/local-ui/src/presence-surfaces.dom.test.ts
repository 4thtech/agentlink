// @vitest-environment jsdom
// FB-8 (UX audit 2026-11-12 §1.6, P-1…P-5): every screen that asks for Touch ID, Windows Hello or a
// passkey also offers "Use your master code instead", and that choice submits the screen's existing
// backup-code path (the server's presence gate takes either, approval-server.ts).
//
// Two parts, both table-driven:
// 1. SURFACES: each owner-presence screen this package draws with its own buttons, mounted with a
//    passkey present. The option is visible, the passkey gesture is never asked for, and the typed
//    code reaches that screen's own code path.
// 2. The guard: every .tsx under src/ that handles an owner-presence proof is listed in PRESENCE_FILES
//    with what in its source offers the code (or why it is not a confirm screen). A new presence
//    screen that is not listed, or a listed one that loses its code option, fails here.
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient, type OwnerApiResult } from './api/client.js';
import type { CheckOutcome, InviteApi } from './pages/contacts/invite-api.js';
import type { PasskeyInfo, PresenceProof } from './pages/contacts/owner.js';
import { PresenceButton } from './pages/contacts/presence-button.js';
import { PresencePrompt } from './pages/contacts/presence-prompt.js';
import type { AppChange, AppsApi } from './pages/first-run/apps-api.js';
import { ConnectApp } from './pages/first-run/connect-app.js';
import { PasteInvite } from './pages/invite/paste-invite.js';
import type { JoinApi } from './pages/join/api.js';
import { JoinPage } from './pages/join/index.js';
import { ConfirmMove, type Move } from './pages/proofs/top-up.js';
import { RulesPage, type RulesPageProps } from './pages/rules/index.js';
import type { OwnerClient as RulesOwner, Presence } from './pages/rules/owner.js';
import { TouchIdPage } from './pages/touch-id/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The words the owner sees on every presence screen (FB-8). */
const USE_CODE = 'Use your master code instead';
const CODE = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX';
const PASSKEY: PasskeyInfo = { credentialId: 'Y3JlZA', prfSalt: 'c2FsdA' };

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

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
  await settle();
}
const labels = (): string[] =>
  [...host.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  );
  if (found === undefined) throw new Error(`no button "${label}" in: ${labels().join(' | ')}`);
  return found;
}
async function click(label: string): Promise<void> {
  const b = button(label);
  expect(b.disabled).toBe(false);
  await act(async () => {
    b.click();
  });
  await settle();
}
async function typeCode(value: string): Promise<void> {
  const fields = host.querySelectorAll<HTMLInputElement>('input[type="password"]');
  expect(fields).toHaveLength(1);
  const input = fields[0] as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

/** What a surface's code path received: the code it would send, in order. */
type Sent = string[];

interface Surface {
  /** The file that draws the screen (relative to src/). */
  readonly file: string;
  readonly name: string;
  /** Renders the screen with a passkey present; `gestures` counts passkey prompts. */
  readonly mount: (sent: Sent, gestures: { n: number }) => Promise<void>;
  /** Gets from the first screen to the one that asks for the passkey (if any). */
  readonly reach?: () => Promise<void>;
  /** The button that submits the master code once the option was chosen. */
  readonly submit: string;
}

const gesture = (gestures: { n: number }) => (): Promise<PresenceProof | undefined> => {
  gestures.n += 1;
  return Promise.resolve({ kind: 'passkey', gesture: () => Promise.resolve(new Uint8Array([1])) });
};
const codeOf = (proof: PresenceProof): string => (proof.kind === 'code' ? proof.code : 'PASSKEY');

// --- P-1 Rules --------------------------------------------------------------------------------------

const RULES = {
  status: 'ok',
  version: 0,
  rules: {
    proofs: {
      notarize: 'allow',
      dailyBudgetUSD: '5',
      perActionMaxUSD: '1',
      allowKeyDisclosure: 'approval',
    },
    contacts: { acceptInvites: 'approval', unknownSenders: 'queue', allowed: 'paired', listed: 0 },
    files: { maxSendSizeMB: 100, maxReceiveSizeMB: 200, allowedFolders: 0 },
    receipts: { autoDelivered: false },
    commitments: {
      accept: 'approval',
      autoAcceptDirection: 'buy',
      autoAcceptMaxUSD: '0',
      autoAcceptMinUSD: null,
      autoAcceptContacts: 2,
    },
    contactRules: 0,
  },
};
const REVIEW = {
  status: 'review',
  review: 'ab'.repeat(32),
  warnings: [],
  askKeepDeliveryReceipts: false,
};
function rulesApi(): ApiClient {
  const fetchFn = (input: RequestInfo | URL): Promise<Response> => {
    const path = (typeof input === 'string' ? input : input.toString()).split('?')[0];
    const body = path === '/api/ui/rules' ? RULES : path === '/api/ui/rules/review' ? REVIEW : {};
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return createApiClient({ fetch: fetchFn as typeof fetch, token: 't' });
}

// --- P-2 Connect app --------------------------------------------------------------------------------

const CHANGE: AppChange = {
  kind: 'connect',
  app: 'claude-code',
  name: 'Claude Code',
  path: '~/.claude.json',
  folder: 'personal',
  oldEntry: null,
  newEntry: { command: 'agentlink' },
  oldAgent: null,
  newAgent: 'personal',
  changeId: 'c1',
};

// --- P-3 / P-4 invites ------------------------------------------------------------------------------

const INVITE = {
  inviteId: 'AQEBAQEBAQEBAQEBAQEBAQ',
  name: 'Marko',
  fingerprint: '7F3A·19C2',
  expiresAt: Date.UTC(2999, 0, 1),
};
const LINK = `https://agentlink.4thtech.io/i#2.${'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdE'}`;

// --- P-5 Credits ------------------------------------------------------------------------------------

const MOVE: Move = {
  kind: 'deposit',
  money: { usd: '$5.00', amount: '5000000' },
  net: {
    network: 'gnosis-test',
    method: 'address',
    available: true,
    address: '0x0000000000000000000000000000000000000001',
    received: '5000000',
    addable: { usd: '$5.00', amount: '5000000' },
    credits: { usd: '$0.00', amount: '0' },
  },
};

const SURFACES: readonly Surface[] = [
  {
    file: 'pages/contacts/presence-prompt.tsx',
    name: 'the shared presence prompt (contacts, IDs, people)',
    submit: 'Confirm with your master code',
    mount: (sent, gestures) =>
      render(
        createElement(PresencePrompt, {
          summary: 'Rename Marko',
          passkey: PASSKEY,
          busy: false,
          error: undefined,
          onSubmit: (proof: PresenceProof) => {
            if (proof.kind === 'passkey') gestures.n += 1;
            sent.push(codeOf(proof));
          },
          onCancel: () => undefined,
        }),
      ),
  },
  {
    // UX1113-N1: the step's own button is the sensor (the Connected moment's "Save with Touch ID").
    file: 'pages/contacts/presence-button.tsx',
    name: 'the one-gesture sensor button (Connected moment naming)',
    submit: 'Confirm with your master code',
    mount: (sent, gestures) =>
      render(
        createElement(PresenceButton, {
          withSensor: (sensor: string) => `Save with ${sensor}`,
          withCode: 'Save with your master code',
          statement: 'Name this contact Marko.',
          busy: false,
          notUsed: 'Not saved. Try again.',
          owner: {
            passkey: () => Promise.resolve(PASSKEY),
            post: () => Promise.resolve({ kind: 'done' as const }),
          },
          gesture: gesture(gestures),
          onProof: (proof: PresenceProof) => {
            sent.push(codeOf(proof));
          },
        }),
      ),
  },
  {
    file: 'pages/rules/index.tsx',
    name: 'P-1 Rules save',
    submit: 'Save',
    mount: (sent, gestures) => {
      const owner: RulesOwner = {
        passkey: () => Promise.resolve(PASSKEY),
        save: (_path: string, _input: unknown, presence: Presence) => {
          if (presence.kind === 'passkey') gestures.n += 1;
          else sent.push(presence.code);
          return Promise.resolve({ kind: 'saved' });
        },
      };
      return render(createElement<RulesPageProps>(RulesPage, { api: rulesApi(), owner }));
    },
    reach: async () => {
      // WP-S3: the contact rules sit under "More rules"; open it first.
      const more = [...host.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').startsWith('More rules'),
      );
      await act(async () => {
        more?.click();
      });
      await settle();
      const group = host.querySelector(
        '[role="radiogroup"][aria-label="Connect with someone new"]',
      );
      const allow = [...(group?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].find(
        (b) => b.textContent?.startsWith('Allow'),
      );
      await act(async () => {
        allow?.click();
      });
      await settle();
      await click('Review and save');
    },
  },
  {
    file: 'pages/first-run/connect-app.tsx',
    name: 'P-2 First-run connect app',
    submit: 'Apply with my master code',
    mount: (sent, gestures) => {
      const appsApi: AppsApi = {
        list: () => Promise.resolve({ kind: 'failed' }) as ReturnType<AppsApi['list']>,
        currentAgent: () => Promise.resolve({ kind: 'none' }),
        preview: () => Promise.resolve({ kind: 'change', change: CHANGE }),
        passkey: () => Promise.resolve(PASSKEY),
        apply: (_id, proof) => {
          sent.push(codeOf(proof));
          return Promise.resolve({ kind: 'done' });
        },
      };
      return render(
        createElement(ConnectApp, {
          appsApi,
          appId: 'claude-code',
          appName: 'Claude Code',
          folder: 'personal',
          agentLabel: 'Personal',
          sensor: 'Touch ID',
          passkeyProof: gesture(gestures),
          onDone: () => undefined,
        }),
      );
    },
  },
  {
    file: 'pages/join/index.tsx',
    name: 'P-3 Join accept',
    submit: 'Confirm with your master code',
    mount: (sent, gestures) => {
      const api: JoinApi = {
        read: () =>
          Promise.resolve({ kind: 'ok', state: 'waiting', invite: INVITE, agent: 'Claude Code' }),
        accept: (_id, proof) => {
          sent.push(codeOf(proof));
          return Promise.resolve({ kind: 'pending' });
        },
        dismiss: () => Promise.resolve('dismissed'),
      };
      return render(
        createElement(JoinPage, {
          api,
          platform: 'mac',
          passkey: () => Promise.resolve(PASSKEY),
          gesture: gesture(gestures),
          pollMs: 60_000,
        }),
      );
    },
  },
  {
    file: 'pages/invite/paste-invite.tsx',
    name: 'P-4 Paste-invite accept',
    submit: 'Confirm with your master code',
    mount: (sent, gestures) => {
      const checked: CheckOutcome = {
        kind: 'ok',
        invite: { name: 'Ana', fingerprint: '7F3A·19C2', expiresAt: Date.UTC(2999, 0, 1) },
      };
      const invites: InviteApi = {
        create: () => Promise.resolve({ kind: 'failed' }),
        cancel: () => Promise.resolve({ kind: 'cancelled' }),
        check: () => Promise.resolve(checked),
        accept: (_link, proof) => {
          sent.push(codeOf(proof));
          return Promise.resolve({ kind: 'pending' });
        },
      };
      return render(
        createElement(PasteInvite, {
          invites,
          passkey: PASSKEY,
          gesture: gesture(gestures),
          platform: 'mac',
          startOpen: true,
        }),
      );
    },
    reach: async () => {
      const area = host.querySelector<HTMLTextAreaElement>('textarea[name="invite-link"]');
      expect(area).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
          area,
          LINK,
        );
        area?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await settle();
      await click('Continue');
    },
  },
  {
    file: 'pages/proofs/top-up.tsx',
    name: 'P-5 Credits move',
    submit: 'Confirm',
    mount: (sent, gestures) => {
      const api: ApiClient = {
        get: () => Promise.resolve({ kind: 'error', status: 500 }),
        post: () => Promise.resolve({ kind: 'error', status: 500 }),
        owner: (_path, _input, presence): Promise<OwnerApiResult> => {
          if (typeof presence === 'string') sent.push(presence);
          else gestures.n += 1;
          return Promise.resolve({ kind: 'ok', status: 200, data: { status: 'ok' } });
        },
      };
      return render(
        createElement(ConfirmMove, {
          api,
          move: MOVE,
          onClose: () => undefined,
          onDone: () => undefined,
          passkey: () => Promise.resolve(PASSKEY),
          gesture: gesture(gestures),
        } as Parameters<typeof ConfirmMove>[0]),
      );
    },
  },
  {
    file: 'pages/touch-id/index.tsx',
    name: 'WP-S2 Replace master code',
    submit: 'Confirm with your master code',
    mount: (sent, gestures) => {
      const api: ApiClient = {
        get: () => Promise.resolve({ kind: 'error', status: 500 }),
        post: () => Promise.resolve({ kind: 'error', status: 500 }),
        owner: (_path, _input, presence): Promise<OwnerApiResult> => {
          if (typeof presence === 'string') sent.push(presence);
          else gestures.n += 1;
          return Promise.resolve({ kind: 'presence_rejected' });
        },
      };
      return render(
        createElement(TouchIdPage, {
          api,
          platform: 'mac',
          passkeyStatus: () => Promise.resolve({ kind: 'ready' as const, info: PASSKEY }),
          passkeyProof: gesture(gestures),
        }),
      );
    },
    reach: () => click('Replace master code'),
  },
];

describe('FB-8: with a passkey present, every presence screen offers the master code', () => {
  it.each(SURFACES.map((s) => [s.name, s] as const))(
    '%s: "Use your master code instead" is shown and submits the code path',
    async (_name, surface) => {
      const sent: Sent = [];
      const gestures = { n: 0 };
      await surface.mount(sent, gestures);
      await surface.reach?.();
      // The passkey is the first way here, and the code is offered next to it.
      expect(host.querySelector('input[type="password"]')).toBeNull();
      const option = button(USE_CODE);
      expect(option.hasAttribute('data-use-code')).toBe(true);
      await click(USE_CODE);
      await typeCode(CODE);
      await click(surface.submit);
      expect(sent).toEqual([CODE]);
      expect(gestures.n).toBe(0);
    },
  );
});

// --- The guard ----------------------------------------------------------------------------------------

// Every .tsx under src/ as text (tests excluded below); paths as `./pages/…`.
const SOURCES = import.meta.glob<string>('./**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const sourceOf = (file: string): string => {
  const text = SOURCES[`./${file}`];
  if (text === undefined) throw new Error(`no source ${file}`);
  return text;
};

/** What makes a .tsx an owner-presence file: it reads, asks for or hands on a presence proof. */
const PRESENCE_SIGNAL =
  /PasskeyInfo|PresenceProof|PasskeyStatus|kind: 'passkey'|\.passkey\(\)|credentials\.get|passkeyProof|withPasskey|<PresencePrompt|<OwnerGate|<OwnerButton|<OwnerStep/;

type Entry =
  /** A confirm screen: `offers` must be in its source (the code option or a shared prompt with it). */
  | { readonly offers: RegExp }
  /** Not a confirm screen (it only reads the passkey state or passes a proof through). */
  | { readonly notAScreen: string };

const PRESENCE_FILES: Readonly<Record<string, Entry>> = {
  // This package's own presence screens (the SURFACES table above mounts each).
  'pages/contacts/presence-prompt.tsx': { offers: /<UseCodeInstead\b/ },
  'pages/rules/index.tsx': { offers: /<UseCodeInstead\b/ },
  'pages/first-run/connect-app.tsx': { offers: /<UseCodeInstead\b/ },
  'pages/join/index.tsx': { offers: /<UseCodeInstead\b/ },
  'pages/invite/paste-invite.tsx': { offers: /<UseCodeInstead\b/ },
  'pages/proofs/top-up.tsx': { offers: /<UseCodeInstead\b/ },
  // Screens that confirm through the shared prompt (presence-prompt.tsx offers the code).
  'pages/agents/owner-gate.tsx': { offers: /<PresencePrompt\b/ },
  'pages/agents/name-update.tsx': { offers: /<OwnerButton\b/ },
  'pages/agents/parts.tsx': { offers: /<OwnerButton\b/ },
  'pages/agents/sheets.tsx': { offers: /<OwnerButton\b/ },
  'pages/apps/panel.tsx': { offers: /<OwnerGate\b/ },
  // WP-11: Save recovery kit (Settings › Backup and the ID card's Back up panel).
  'pages/backup/export-kit.tsx': { offers: /<OwnerGate\b/ },
  // UX1113 WP-S2: Replace master code on Settings › Touch ID & master code.
  'pages/touch-id/index.tsx': { offers: /<UseCodeInstead\b/ },
  // UX1113-R3: Restore here asks first on a computer that has an owner (PresenceStep offers the code).
  'pages/restore/index.tsx': { offers: /<PresenceStep\b/ },
  'pages/contacts/index.tsx': { offers: /<PresenceButton\b/ },
  'pages/contacts/presence-button.tsx': { offers: /<UseCodeInstead\b/ },
  'pages/invite/name-contact.tsx': { offers: /<PresenceButton\b/ },
  'pages/home/person-menu.tsx': { offers: /<PresenceButton\b/ },
  // Approvals: OWNERSTEP-LEFT, the one-step PresenceAction offers the code (link, or the code field
  // when no sensor works here; approvals/card.tsx CodeStep).
  'pages/approvals/card.tsx': { offers: /<CodeForm\b/ },
  'pages/approvals/board.tsx': { offers: /<PresenceAction\b/ },
  'pages/home/home-approvals.tsx': { offers: /<PresenceAction\b/ },
  'pages/inbox/save.tsx': { offers: /<PresenceAction\b/ },
  // Their own code option (each with its own DOM tests).
  'pages/apps/create-agent-gate.tsx': { offers: /NAME\.backupInstead/ },
  'pages/files/index.tsx': { offers: /S\.useCode/ },
  'pages/first-run/index.tsx': { offers: /N\.backupInstead/ },
  'pay-confirm/index.tsx': { offers: /phase: 'backup'/ },
  // Not confirm screens.
  'pages/approvals/index.tsx': { notAScreen: 'reads the passkey state for the approval cards' },
  'pages/home/home-screen.tsx': { notAScreen: 'reads the passkey state; HomeApprovals confirms' },
};

describe('FB-8 guard: every owner-presence screen is listed and offers the master code', () => {
  const found = Object.entries(SOURCES)
    .filter(([path, text]) => !/\.test\./.test(path) && PRESENCE_SIGNAL.test(text))
    .map(([path]) => path.replace(/^\.\//, ''))
    .sort();

  it('finds the presence screens (the scan works)', () => {
    expect(found).toContain('pages/rules/index.tsx');
    expect(found.length).toBeGreaterThanOrEqual(10);
  });

  it('every presence file is in PRESENCE_FILES (a new one says how it offers the code)', () => {
    const unlisted = found.filter((f) => PRESENCE_FILES[f] === undefined);
    expect(unlisted, 'add each to PRESENCE_FILES with its backup-code option').toEqual([]);
  });

  it.each(Object.entries(PRESENCE_FILES))('%s offers the master code', (file, entry) => {
    const source = sourceOf(file);
    if ('notAScreen' in entry) {
      expect(entry.notAScreen.length).toBeGreaterThan(0);
      return;
    }
    expect(source).toMatch(entry.offers);
  });

  it('every surface this package draws itself is mounted in SURFACES', () => {
    const own = Object.entries(PRESENCE_FILES)
      .filter(([, e]) => 'offers' in e && e.offers.source.includes('UseCodeInstead'))
      .map(([f]) => f)
      .sort();
    expect(SURFACES.map((s) => s.file).sort()).toEqual(own);
  });

  it('the shared option carries the guard marker and the words', () => {
    const source = sourceOf('pages/first-run/backup-code.tsx');
    expect(source).toContain('data-use-code');
    expect(source).toContain(`'${USE_CODE}'`);
  });
});
