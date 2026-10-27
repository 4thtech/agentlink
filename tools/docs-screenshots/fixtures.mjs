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

/** The same list with a second, older connection of "Ana's agent" (same owner): the duplicate notice. */
export const CONTACTS_DUPLICATE = {
  status: 'ok',
  contacts: [
    ...CONTACTS.contacts.map((c) => (c.ref === ref(2) ? { ...c, olderSameOwner: ref(4) } : c)),
    {
      ref: ref(4),
      name: "Ana's agent",
      nameSource: 'owner',
      fingerprint: '2D3E·4F5A',
      label: 'self-declared',
      status: 'active',
      pairing: 'complete',
      since: NOW - 20 * DAY,
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

/** The status bar's health read: the agent is running (08 §1; apps/local-ui layout/health.ts). */
export const HEALTH = {
  agent: 'running',
  version: '0.4.0',
  relays: { connected: 3, total: 3 },
  lastSyncAt: NOW - 2 * MIN,
};

/** Two waiting approvals; the expiry is read at answer time so the time-left ring has a real clock. */
export const APPROVALS = () => {
  const soon = Math.floor(Date.now() / 1000);
  return {
    approvals: [
      {
        approvalId: 'apr_' + 'A'.repeat(22),
        summary: "Send project-plan.pdf to Marko's agent",
        actionDigest: 'a'.repeat(64),
        expiresAt: soon + 95,
        commitment: false,
        paid: false,
        details: {
          who: "Marko's agent",
          what: 'Send the file project-plan.pdf',
          cost: 'Free',
          expires: 'in about 2 minutes',
          rule: 'Your rule: ask me before sending files',
          fromAi: [{ name: 'File', value: 'project-plan.pdf' }],
        },
      },
      {
        approvalId: 'apr_' + 'B'.repeat(22),
        summary: "Add a proof of the agreement with Ana's agent",
        actionDigest: 'b'.repeat(64),
        expiresAt: soon + 170,
        commitment: false,
        paid: true,
        details: {
          who: "Ana's agent",
          what: 'Add a public proof of your agreement',
          cost: 'About $0.05 (1 proof)',
          expires: 'in about 3 minutes',
          rule: 'Your rule: ask me before adding proof',
          fromAi: [],
        },
      },
    ],
  };
};
export const OWNER_PASSKEY = { passkey: { rpId: 'localhost', registered: false } };
export const NO_APPROVALS = { approvals: [] };

export const MESSAGE_CONVERSATIONS = {
  conversations: [
    { contactId: ref(1), name: "Marko's agent", lastAt: NOW - 20 * MIN, lastInAt: NOW - 20 * MIN },
    { contactId: ref(2), name: "Ana's agent", lastAt: NOW - 1 * DAY, lastInAt: NOW - 1 * DAY },
  ],
};

const MESSAGES_IN = {
  items: [
    {
      id: 'm-in-2',
      at: NOW - 20 * MIN,
      text: 'The draft is ready. Can your agent send the notes before Friday?',
      files: [{ name: 'draft-notes.txt', size: 2048 }],
      receipt: false,
      proof: false,
      size: 180,
    },
    {
      id: 'm-in-1',
      at: NOW - 3 * HOUR,
      text: 'Thanks, I got the terms. I will go through them this afternoon.',
      files: [],
      receipt: false,
      proof: true,
      size: 96,
    },
  ],
};

const MESSAGES_OUT = {
  items: [
    {
      id: 'm-out-1',
      at: NOW - 4 * HOUR,
      text: 'Here are the terms we talked about.',
      files: [],
      status: 'sent',
      receipt: true,
      proof: false,
      size: 64,
    },
  ],
};

export const FILES_RECEIVED = {
  items: [
    {
      id: 'f-in-2',
      from: "Marko's agent",
      at: NOW - 20 * MIN,
      name: 'draft-notes.txt',
      size: 2048,
      state: 'saved',
      savedName: 'draft-notes.txt',
      proof: false,
    },
    {
      id: 'f-in-1',
      from: "Ana's agent",
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

export const FILES_SENT = {
  items: [
    {
      id: 'f-out-1',
      to: "Marko's agent",
      at: NOW - 5 * HOUR,
      name: 'project-plan.pdf',
      size: 96256,
      status: 'sent',
      receipt: true,
      state: 'available',
      expiresAt: NOW + 6 * DAY,
    },
    {
      id: 'f-out-2',
      to: "Ana's agent",
      at: NOW - 2 * DAY,
      name: 'invoice.pdf',
      size: 40960,
      status: 'sent',
      receipt: false,
      state: 'available',
      expiresAt: NOW + 5 * DAY,
    },
  ],
  next: null,
};

/** Rules: the review for raising "Ask me over" from $0.50 to $1 (no new warnings). */
export const RULES_REVIEW = {
  status: 'review',
  review: 'b'.repeat(64),
  warnings: [],
  askKeepDeliveryReceipts: false,
};

/** The paid-action sheet's begin answer for that spending change (fake challenge and credential). */
export const PAY_BEGIN = {
  status: 'ready',
  ceremony: 'C'.repeat(43),
  statement: {
    v: 1,
    kind: 'limits',
    amountUsd: null,
    purpose: 'limits_change',
    counterparty: null,
    changes: [{ field: 'proofs.perActionMaxUSD', old: '0.5', new: '1' }],
  },
  publicKey: {
    rpId: 'localhost',
    challenge: 'D'.repeat(43),
    allowCredentials: ['AAAAAAAAAAAAAAAAAAAAAA'],
    timeoutMs: 120000,
    prfSalt: 'E'.repeat(43),
  },
  rememberOffered: false,
};

/** The route table: exact path (no query) to the JSON answer, or a function of the URL. */
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
  '/api/ui/health': HEALTH,
  '/api/approvals': APPROVALS,
  '/api/owner/passkey': OWNER_PASSKEY,
  '/api/ui/messages': MESSAGE_CONVERSATIONS,
  [`/api/ui/messages/${ref(1)}`]: (url) =>
    url.searchParams.get('box') === 'out' ? MESSAGES_OUT : MESSAGES_IN,
  '/api/ui/files/received': FILES_RECEIVED,
  '/api/ui/files/sent': FILES_SENT,
  '/api/ui/rules/review': RULES_REVIEW,
  '/api/ui/pay-confirm/begin': PAY_BEGIN,
};
