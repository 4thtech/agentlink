// Canned answers for the local app's /api/ui/* routes. Everything here is made up: names come from
// the 11 §5 samples, the "references" are obvious placeholders (the app never shows them), and no
// key, code, address or hash of a real agent appears. Times are fixed so a re-run gives the same page.

const NOW = Date.UTC(2026, 9, 26, 15, 30) / 1000; // 26 Oct 2026, 15:30 UTC
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
const ref = (n) => `0x${n.toString(16).padStart(40, '0')}`;

export const CONTACTS = {
  status: 'ok',
  contacts: [
    {
      ref: ref(1),
      name: "Marko's agent",
      nameSource: 'owner',
      fingerprint: '1A2B·3C4D',
      label: 'safety-code-checked',
      status: 'active',
      pairing: 'complete',
      since: NOW - 12 * DAY,
    },
    {
      ref: ref(2),
      name: "Ana's agent",
      nameSource: 'owner',
      fingerprint: '5E6F·7A8B',
      label: 'self-declared',
      status: 'active',
      pairing: 'complete',
      since: NOW - 3 * DAY,
    },
    {
      ref: ref(3),
      name: "Ivan's agent",
      nameSource: 'owner',
      fingerprint: '9C0D·1E2F',
      label: 'self-declared',
      status: 'active',
      pairing: 'pending',
      since: NOW - 2 * HOUR,
    },
  ],
};

export const SAFETY_CODE = { status: 'ok', code: '4821 7390 1564' };

export const ACTIVITY = {
  items: [
    { kind: 'approval_decided', at: NOW - 10 * MIN, decision: 'approved' },
    { kind: 'proof', at: NOW - 55 * MIN, direction: 'sent', state: 'recorded' },
    { kind: 'approval_decided', at: NOW - 3 * HOUR, decision: 'approved_by_rules' },
    { kind: 'proof', at: NOW - 5 * HOUR, direction: 'received', state: 'received' },
    { kind: 'sender_blocked', at: NOW - 1 * DAY, senderCode: 'K7Q2·M9X4' },
    { kind: 'approval_decided', at: NOW - 1 * DAY - 2 * HOUR, decision: 'denied' },
    { kind: 'rules_changed', at: NOW - 2 * DAY },
    { kind: 'proof', at: NOW - 3 * DAY, direction: 'sent', state: 'needs_credits' },
  ],
};

export const PROOFS = {
  status: 'ok',
  items: [
    { direction: 'sent', state: 'recorded', createdAt: NOW - 55 * MIN },
    { direction: 'received', state: 'recorded', createdAt: NOW - 5 * HOUR },
    { direction: 'sent', state: 'submitted', createdAt: NOW - 1 * DAY },
    { direction: 'sent', state: 'recorded', createdAt: NOW - 2 * DAY },
    { direction: 'sent', state: 'needs-credits', createdAt: NOW - 3 * DAY },
  ],
};

export const CREDITS = {
  status: 'ok',
  proofsLeft: 24,
  balance: '$1.20',
  price: '$0.05',
  test: true,
  partial: false,
};

export const RULES = {
  status: 'ok',
  version: 4,
  rules: {
    proofs: {
      notarize: 'approval',
      dailyBudgetUSD: '2',
      perActionMaxUSD: '0.5',
      allowKeyDisclosure: 'approval',
    },
    contacts: { acceptInvites: 'approval', unknownSenders: 'queue', allowed: 'paired', listed: 3 },
    files: { maxSendSizeMB: 50, maxReceiveSizeMB: 100 },
    receipts: { autoDelivered: true },
    commitments: {
      accept: 'approval',
      autoAcceptDirection: 'buy',
      autoAcceptMaxUSD: '0',
      autoAcceptMinUSD: null,
      autoAcceptContacts: 0,
    },
  },
};

export const FILES = {
  folders: [
    { path: '~/AgentLink/Send', resolved: '~/AgentLink/Send' },
    { path: '~/Documents/Contracts', resolved: '~/Documents/Contracts' },
    { path: '~/Projects/shared', resolved: '~/Dropbox/Shared/projects' },
  ],
  version: 4,
};

export const FILES_REVIEW = {
  review: 'A'.repeat(43),
  change: 'add',
  folder: '~/Documents/Shared',
  typed: '~/Documents/Shared',
  elsewhere: false,
  warnings: ['allowed_folders_added'],
  expiresAt: NOW + 300,
};

export const FIRST_RUN = { owner: 'missing' };

/** The route table: exact path (no query) to the JSON answer. */
export const ROUTES = {
  '/api/ui/contacts': CONTACTS,
  [`/api/ui/contacts/${ref(2)}/safety-code`]: SAFETY_CODE,
  '/api/ui/activity': ACTIVITY,
  '/api/ui/proofs': PROOFS,
  '/api/ui/proofs/credits': CREDITS,
  '/api/ui/rules': RULES,
  '/api/ui/files': FILES,
  '/api/ui/files/review': FILES_REVIEW,
  '/api/ui/first-run': FIRST_RUN,
};
