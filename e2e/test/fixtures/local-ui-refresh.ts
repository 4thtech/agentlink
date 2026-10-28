// UI-REFRESH-q: canned answers for the local app's /api/** routes in the refresh audit
// (e2e/test/local-ui-refresh.test.ts). Everything is made up (11 §5 sample names, placeholder
// references the app never shows); no key, code, address or hash of a real agent. The large lists
// (200 Activity rows, 60 conversations, 200 messages) are the plan §7 scrolling fixtures. Shapes follow
// tools/docs-screenshots/fixtures.mjs (copied, not imported: e2e may not import outside its zone).

const NOW = Math.floor(Date.UTC(2026, 9, 26, 15, 30) / 1000);
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
const ref = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

const NAMES = ["Marko's agent", "Ana's agent", "Ivan's agent", "Lea's agent", "Tom's agent"];

export const CONTACTS = {
  status: 'ok',
  contacts: [
    {
      ref: ref(1),
      name: NAMES[0],
      nameSource: 'owner',
      fingerprint: '1A2B·3C4D',
      label: 'safety-code-checked',
      status: 'active',
      pairing: 'complete',
      since: NOW - 12 * DAY,
    },
    {
      ref: ref(2),
      name: NAMES[1],
      nameSource: 'owner',
      fingerprint: '5E6F·7A8B',
      label: 'self-declared',
      status: 'active',
      pairing: 'complete',
      since: NOW - 3 * DAY,
    },
    {
      ref: ref(3),
      name: NAMES[2],
      nameSource: 'owner',
      fingerprint: '9C0D·1E2F',
      label: 'self-declared',
      status: 'active',
      pairing: 'pending',
      since: NOW - 2 * HOUR,
    },
  ],
};

const ACTIVITY_KINDS = [
  { kind: 'approval_decided', decision: 'approved' },
  { kind: 'proof', direction: 'sent', state: 'recorded' },
  { kind: 'approval_decided', decision: 'approved_by_rules' },
  { kind: 'proof', direction: 'received', state: 'received' },
  { kind: 'sender_blocked', senderCode: 'K7Q2·M9X4' },
  { kind: 'approval_decided', decision: 'denied' },
  { kind: 'rules_changed' },
  { kind: 'proof', direction: 'sent', state: 'needs_credits' },
] as const;

/** 200 rows over about two weeks: the plan §7 "scrolling Activity with 200 rows". */
export const ACTIVITY_200 = {
  items: Array.from({ length: 200 }, (_, i) => ({
    ...ACTIVITY_KINDS[i % ACTIVITY_KINDS.length],
    at: NOW - 10 * MIN - i * 97 * MIN,
  })),
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
  ],
  version: 4,
};

/** 60 conversations: a long Messages list. */
export const CONVERSATIONS_60 = {
  conversations: Array.from({ length: 60 }, (_, i) => ({
    contactId: ref(i + 1),
    name: i < NAMES.length ? NAMES[i] : `Agent ${String(i + 1)}`,
    lastAt: NOW - 20 * MIN - i * 3 * HOUR,
    lastInAt: NOW - 20 * MIN - i * 3 * HOUR,
  })),
};

/** 200 messages in the first conversation. */
export const MESSAGES_200 = {
  items: Array.from({ length: 200 }, (_, i) => ({
    id: `m-in-${String(i)}`,
    at: NOW - 20 * MIN - i * 41 * MIN,
    text:
      i % 3 === 0
        ? 'The draft is ready. Can your agent send the notes before Friday?'
        : 'Thanks, I got the terms. I will go through them this afternoon.',
    files: i % 7 === 0 ? [{ name: 'draft-notes.txt', size: 2048 }] : [],
    receipt: false,
    proof: i % 5 === 0,
    size: 120,
  })),
};

const FILES_RECEIVED = {
  items: [
    {
      id: 'f-in-1',
      from: NAMES[1],
      at: NOW - 1 * DAY,
      name: 'agreement.pdf',
      size: 184320,
      state: 'saved',
      savedName: 'agreement (2).pdf',
      proof: true,
    },
  ],
  next: null,
};

const FILES_SENT = {
  items: [
    {
      id: 'f-out-1',
      to: NAMES[0],
      at: NOW - 5 * HOUR,
      name: 'project-plan.pdf',
      size: 96256,
      status: 'sent',
      receipt: true,
      state: 'available',
      expiresAt: NOW + 6 * DAY,
    },
  ],
  next: null,
};

const approval = (n: number, summary: string, paid: boolean): Record<string, unknown> => ({
  approvalId: `apr_${String(n).repeat(22).slice(0, 22)}`,
  summary,
  actionDigest: String(n).repeat(64).slice(0, 64),
  expiresAt: Math.floor(Date.now() / 1000) + (n + 1) * HOUR,
  commitment: !paid,
  paid,
  details: {
    who: NAMES[(n - 1) % NAMES.length],
    what: summary,
    cost: paid ? '$0.05' : 'Free',
    expires: 'in 1 hour',
    rule: 'Ask me first',
    fromAi: [{ name: 'note', value: 'Sending the notes we agreed on.' }],
  },
});

/** Three requests waiting: the Approvals page and Home's "approvals waiting" tile. */
export const APPROVALS = {
  approvals: [
    approval(1, "Send draft-notes.txt to Marko's agent", false),
    approval(2, 'Add a public proof to the agreement', true),
    approval(3, "Accept Ana's agent's terms", false),
  ],
};

/** No passkey yet: the owner code path (the Approvals page offers the code field). */
export const OWNER_PASSKEY = { passkey: { rpId: 'localhost', registered: false } };

export const ROUTES: Readonly<Record<string, unknown>> = {
  '/api/ui/first-run': { owner: 'missing' },
  '/api/ui/contacts': CONTACTS,
  '/api/ui/activity': ACTIVITY_200,
  '/api/ui/proofs': PROOFS,
  '/api/ui/proofs/credits': CREDITS,
  '/api/ui/rules': RULES,
  '/api/ui/files': FILES,
  '/api/ui/first-run': { owner: 'missing' },
  '/api/ui/health': { agent: 'running', version: '0.4.0' },
  '/api/ui/messages': CONVERSATIONS_60,
  [`/api/ui/messages/${ref(1)}`]: MESSAGES_200,
  '/api/ui/files/received': FILES_RECEIVED,
  '/api/ui/files/sent': FILES_SENT,
  '/api/approvals': APPROVALS,
  '/api/owner/passkey': OWNER_PASSKEY,
};
