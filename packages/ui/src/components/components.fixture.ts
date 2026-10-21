// M1-35b: shared fixtures for the component tests. One element per component and state, built only
// from the public API (`./index.js`), so a test that renders "everything" cannot miss a component.
// Excluded from the build (tsconfig.json), like the other `*.fixture.ts` files in this repository.
import { createElement as h, type ReactElement } from 'react';
import * as ui from './index.js';

/** Hostile text: markup, script, attribute breakers, a bidi override and a link. */
export const XSS =
  '<img src=x onerror=alert(1)><script>alert(1)</script>"\'><svg onload=alert(2)> ‮evil https://evil.example/path?x=1';

const termsRows = [
  { field: 'Price', old: '$100', new: '$120' },
  { field: 'Subject', old: null, new: 'Rush job', proposerWords: true },
];

/** Every component in its main states. Keys are `<Component>/<state>`. */
export const fixtures: Record<string, () => ReactElement> = {
  'Mark/default': () => h(ui.Mark, { size: 32 }),
  'Mark/small': () => h(ui.Mark, { size: 16, mono: true }),
  'Wordmark/default': () => h(ui.Wordmark, { height: 20 }),
  'Lockup/endorsed': () => h(ui.Lockup, { size: 24, endorsed: true }),
  'Icon/labelled': () => h(ui.Icon, { name: 'check', label: 'Done' }),
  'Button/primary': () => h(ui.Button, { variant: 'primary', icon: 'check' }, 'Save'),
  'Kbd/default': () => h(ui.Kbd, null, 'Ctrl'),
  'TextField/error': () =>
    h(ui.TextField, { label: 'Owner code', hint: 'Letters and digits', error: 'Too short' }),
  'Switch/off': () => h(ui.Switch, { label: 'Confirm deliveries', defaultChecked: false }),
  'Segmented/default': () =>
    h(ui.Segmented, {
      label: 'Sending files',
      defaultValue: 'ask',
      options: [
        { value: 'allowed', label: 'Allowed' },
        { value: 'ask', label: 'Ask me', hint: 'recommended' },
        { value: 'never', label: 'Never' },
      ],
    }),
  'StatusChip/flagged': () => h(ui.StatusChip, { status: 'flagged' }),
  'IdentityLabel/verified': () => h(ui.IdentityLabel, { kind: 'verified', domain: 'example.com' }),
  'Fingerprint/default': () => h(ui.Fingerprint, { value: '7F3A·19C2' }),
  'ContactName/restricted': () =>
    h(ui.ContactName, { name: 'Marko', fingerprint: '7F3A·19C2', label: 'selfdeclared' }),
  'SafetyCode/unchecked': () => h(ui.SafetyCode, { code: '1234 5678 9012', contactName: 'Marko' }),
  'SafetyCode/waiting': () =>
    h(ui.SafetyCode, { code: '1234 5678 9012', contactName: 'Marko', state: 'waiting' }),
  'ContactCard/flagged': () =>
    h(ui.ContactCard, {
      alias: 'Marko',
      fingerprint: '7F3A·19C2',
      label: 'checked',
      agent: 'marko-agent',
      lastActivity: 'Last activity 2 hours ago',
      state: 'flagged',
    }),
  'ContactCard/unknown': () => h(ui.ContactCard, { unknownSender: true, fingerprint: '2B9E·04D1' }),
  'UntrustedContent/message': () =>
    h(ui.UntrustedContent, { from: 'Marko', kind: 'message' }, 'Hello https://example.com/a?b=c'),
  'UntrustedContent/unknown': () =>
    h(ui.UntrustedContent, { unknown: true, fingerprint: '2B9E·04D1' }, 'Let us talk'),
  'ApprovalCard/proof': () =>
    h(ui.ApprovalCard, {
      type: 'proof',
      agent: 'work-agent',
      headline: 'Add proof to this file',
      who: 'Marko',
      what: 'contract.pdf',
      cost: '$0.10',
      expires: 'Expires in 9 min',
      disclosure: ['A proof is public.'],
      method: 'Touch ID',
    }),
  'ApprovalCard/waiting': () =>
    h(ui.ApprovalCard, {
      type: 'new-contact',
      agent: 'work-agent',
      headline: 'Add Marko',
      state: 'waiting',
    }),
  'TermsDiff/default': () => h(ui.TermsDiff, { rows: termsRows }),
  'CommitmentCard/accept': () =>
    h(ui.CommitmentCard, {
      headline: 'Website redesign',
      who: 'Marko',
      proposer: 'Marko',
      subject: 'Redesign',
      diff: { rows: termsRows },
      validUntil: '28 Oct',
      scope: 'Accepts version 3 only',
      cost: 'Free for you',
      method: 'Touch ID',
    }),
  'ProofBadge/needs-credits': () => h(ui.ProofBadge, { state: 'needs-credits' }),
  'ReceiptTimeline/default': () =>
    h(ui.ReceiptTimeline, {
      steps: [
        { key: 'recorded', done: true, time: '10:00' },
        { key: 'asked', done: true, time: '10:01' },
        { key: 'delivered', done: false },
      ],
    }),
  'CostChip/free': () => h(ui.CostChip, { free: true }),
  'CreditsMeter/low': () =>
    h(ui.CreditsMeter, {
      balance: '$1.20',
      proofsLeft: 12,
      spentLast24h: 3.4,
      budget: 5,
      state: 'low',
    }),
  'FileCard/receipt': () =>
    h(ui.FileCard, { name: 'contract.pdf', size: '1.2 MB', removal: 'receipt', integrity: 'ok' }),
  'CopyPrompt/hero': () => h(ui.CopyPrompt, { prompt: 'Set up AgentLink', size: 'hero' }),
  'CopyPrompt/command': () => h(ui.CopyPrompt, { command: 'agentlink ui' }),
  'SecretDisplay/default': () =>
    h(ui.SecretDisplay, { label: 'Recovery code', value: 'ABCD EFGH JKLM' }),
  'Banner/warning': () => h(ui.Banner, { tone: 'warning', title: 'Heads up' }, 'Low credits'),
  'Toast/success': () => h(ui.Toast, { tone: 'success', action: 'Undo' }, 'Saved'),
  'EmptyState/default': () =>
    h(ui.EmptyState, { title: 'No files yet', prompt: 'Send the contract to Marko' }),
  'AppShell/default': () =>
    h(
      ui.AppShell,
      {
        agent: 'work-agent',
        nav: [
          { icon: 'activity', label: 'Activity', active: true },
          { icon: 'users', label: 'Contacts', count: 2 },
        ],
        version: '0.1.0',
      },
      h('p', null, 'Content'),
    ),
  'TrayMenu/default': () => h(ui.TrayMenu, { os: 'macos', approvals: 2 }),
};
