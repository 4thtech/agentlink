// M1-35c: the shipped English strings. Vocabulary lint (11 §5.1), key coverage in both directions,
// the 11 §5.6 disclosure lines, and the DESIGN-ADJ-1 (a) copy items.
import { describe, expect, it } from 'vitest';
import { awaitingUse } from './awaiting-use.js';
import { en, formatMessage, pendingStrings, t } from './index.js';

const strings = Object.entries(en) as [string, string][];

// 11 §5.1 "Never say". Matched case-insensitively on whole words unless noted.
const BANNED: [string, RegExp][] = [
  ['wallet', /\bwallets?\b/i],
  ['seed phrase', /\bseed phrases?\b/i],
  ['private key', /\bprivate keys?\b/i],
  ['transaction', /\btransactions?\b|\btx hash\b/i],
  ['gas', /\bgas\b/i],
  ['mint', /\bmint(ed|ing)?\b/i],
  ['notarize', /\bnotari[sz]\w*/i],
  ['blockchain', /\bblockchain\b|\bon-chain\b|\bsmart contracts?\b/i],
  ['chain', /\bchains?\b/i],
  ['network names', /\b(Base|Gnosis|Chiado)\b/],
  ['tokens', /\b(USDC|USDT|faucet|deposit|native token)\b/i],
  ['hash', /\bhash(es)?\b|\btermsHash\b/i],
  ['nostr/relay', /\bnostr\b|\brelays?\b/i],
  ['policy/harness', /\bpolic(y|ies)\b|\bharness\b|\benvelopes?\b|\bagent cards?\b/i],
  ['mcp', /\bMCP\b/],
  ['owner key / signature', /\bowner keys?\b|\bsignatures?\b/i],
  ['keystore', /\bkeystore\b|\.alks\b/i],
  ['password', /\bpasswords?\b/i],
  ['contract', /\bcontracts?\b|\blegally binding\b/i],
  ['commitment label', /\bcommitments?\b/i],
  ['unverified', /\bunverified\b/i],
  ['encryption key', /\bdecrypt\w*\b|\bencryption keys?\b/i],
  ['loopback address', /127\.0\.0\.1/],
  ['address', /\baddress\b/i],
];

// Reviewed exceptions, each with its reason. Anything else fails.
const EXEMPT: Record<string, string[]> = {
  // Reassures that invites never ask for a password; it does not name one of our codes (11 §5.5).
  'invite.noPasswords': ['password'],
  // A literal terminal command that names its flag (keystore is terminal only, 11 §5.1, D-54).
  'chat.status.needs_setup.keychain': ['keystore'],
};

const prefixOf = (key: string): string => key.split('.')[0] ?? '';

describe('vocabulary lint (11 §5.1)', () => {
  it('has strings to lint', () => {
    expect(strings.length).toBeGreaterThan(100);
  });

  it.each(strings)('%s has no banned term', (key, value) => {
    // Advanced and developer-config strings may name the technical term (11 §5.1, "Advanced only").
    if (prefixOf(key) === 'advanced' || prefixOf(key) === 'devconfig') return;
    const allowed = EXEMPT[key] ?? [];
    for (const [name, re] of BANNED) {
      if (allowed.includes(name)) continue;
      expect(re.test(value), `${key}: "${value}" contains "${name}"`).toBe(false);
    }
  });

  it('lists no exemption for a missing key', () => {
    for (const k of Object.keys(EXEMPT)) expect(en).toHaveProperty(k);
  });

  it('keeps the pending list apart from the shipped strings', () => {
    for (const p of pendingStrings) {
      expect(p.key in en, `${p.key} must not also be shipped`).toBe(false);
      expect(p.brief).toMatch(/^B-(1|2|8)$/);
    }
    expect(new Set(pendingStrings.map((p) => p.brief))).toEqual(new Set(['B-1', 'B-2', 'B-8']));
  });
});

describe('key hygiene (11 §5.4)', () => {
  const PREFIXES = new Set([
    'chat',
    'cli',
    'local',
    'desktop',
    'os',
    'console',
    'cloud',
    'verify',
    'print',
    'invite',
    'accept',
    'onboarding',
    'pay',
    'pricing',
    'site',
    'common',
    'advanced',
    'devconfig',
  ]);

  it('uses the 11 §5.4 surface prefixes', () => {
    for (const [key] of strings) expect(PREFIXES.has(prefixOf(key)), key).toBe(true);
  });

  it('uses valid ICU placeholders only', () => {
    for (const [key, value] of strings) {
      expect(() => formatMessage(value, {}), key).not.toThrow();
    }
  });

  // Source files outside this folder that reference keys. Components (M1-35b) and the building
  // cards add references over time.
  // The ui zone allows no Node built-ins, so the sources are read through Vite.
  const sources = import.meta.glob(
    [
      '../**/*.{ts,tsx}',
      '!../**/*.test.ts',
      '!../**/*.fixture.ts',
      '!../**/*.d.ts',
      '!../strings/**',
    ],
    { query: '?raw', import: 'default', eager: true },
  );
  const REF =
    /['"`]((?:common|chat|cli|os|local|desktop|console|cloud|verify|print|invite|accept|onboarding|pay|pricing|site|advanced|devconfig)\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)['"`]/g;
  const referenced = new Map<string, string>();
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(REF)) referenced.set(m[1]!, file);
  }

  it('scans the package sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0);
  });

  it('every key a component references exists', () => {
    const missing = [...referenced].filter(([k]) => !(k in en));
    expect(missing).toEqual([]);
  });

  // Keys nothing references yet are listed one by one in awaiting-use.ts.
  const findUnused = (
    keys: readonly string[],
    refs: ReadonlySet<string>,
    awaiting: readonly string[],
  ) => keys.filter((k) => !refs.has(k) && !awaiting.includes(k));

  it('has no unused key that is not listed as awaiting its card', () => {
    expect(findUnused(Object.keys(en), new Set(referenced.keys()), awaitingUse)).toEqual([]);
  });

  it('fails on an unreferenced, typo-d key', () => {
    const keys = [...Object.keys(en), 'chat.status.ok.sentt.summary'];
    expect(findUnused(keys, new Set(referenced.keys()), awaitingUse)).toEqual([
      'chat.status.ok.sentt.summary',
    ]);
  });

  it('keeps the awaiting list honest: no stale, duplicate or referenced entry', () => {
    expect(new Set(awaitingUse).size).toBe(awaitingUse.length);
    for (const k of awaitingUse) {
      expect(k in en, `${k} no longer exists`).toBe(true);
      expect(referenced.has(k), `${k} is referenced now; remove it from awaiting-use.ts`).toBe(
        false,
      );
    }
  });
});

describe('spec-faithful chat and terminal lines (IR-M1-35c-1)', () => {
  it('flags a contact only in the activity feed (04 §3.1.1), with no promised hold', () => {
    expect(en['chat.contact.flagged']).toContain('activity feed');
    expect(en['chat.contact.flagged']).not.toMatch(/wait for your review|held|hold/i);
  });

  it('covers both recover paths (06 §8, D-100)', () => {
    expect(en['cli.policy.recover']).toMatch(/rules you had/);
    expect(en['cli.policy.recover']).toMatch(/recommended defaults/);
  });

  it('splits storage by rule (07): own storage and the encrypted drop', () => {
    expect(en).not.toHaveProperty('chat.storage.connected');
    expect(en['chat.storage.own']).toMatch(/own storage/);
    expect(en['chat.storage.drop']).toMatch(/encrypted drop/);
    expect(en['chat.storage.drop']).not.toMatch(/own storage/);
  });

  it('keeps backup commands on the terminal surface and warns about the old copy', () => {
    for (const k of Object.keys(en)) expect(k.startsWith('chat.backup.'), k).toBe(false);
    expect(en['cli.backup.restored']).toMatch(/Stop the agent on your old computer now/);
    expect(en['cli.backup.restored']).toContain('agentlink storage connect');
  });

  it('discloses the recipient and the document key in the export summary', () => {
    const base = { path: '/p.zip', recipient: 'no', documentKey: 'no' };
    expect(formatMessage(en['chat.export.summary'], base)).not.toMatch(/received|document key/);
    expect(formatMessage(en['chat.export.summary'], { ...base, recipient: 'yes' })).toMatch(
      /who received it/,
    );
    expect(formatMessage(en['chat.export.summary'], { ...base, documentKey: 'yes' })).toMatch(
      /document key, so anyone with the file can read the content/,
    );
  });
});

describe('11 §5.6 disclosure lines (D-109)', () => {
  it('ships every line verbatim', () => {
    expect(en['common.public.proof']).toBe(
      "A proof is public. Anyone can see that your agent recorded something, when, and what kind it was (a message, a file, an offer). They can't see what it says.",
    );
    expect(en['common.public.proof.receipt']).toBe(
      'If {contactName} confirms delivery, it also becomes public that it went to their agent.',
    );
    expect(en['common.public.receiptAsk']).toBe(
      'Ask {contactName} to confirm delivery? If they do, anyone can see that this went to their agent.',
    );
    expect(en['common.public.receiptRequest']).toBe(
      '{contactName} asked you to confirm delivery. Confirming shows publicly that this reached your agent. Nothing about the content.',
    );
    expect(en['common.public.receiptRequest.confirm']).toBe('Confirm delivery');
    expect(en['common.public.receiptRequest.later']).toBe('Not now');
    expect(en['common.public.autoConfirm']).toBe(
      'Confirm deliveries from {contactName} automatically? Each confirmation shows publicly that their proof reached your agent.',
    );
    expect(en['common.public.receipt']).toBe(
      'This is public: anyone can see that your agent {action, select, opened {opened} accepted {accepted} rejected {rejected} other {received}} it, and when.',
    );
    expect(en['local.rules.receipts']).toBe(
      'Confirm deliveries publicly: Off (recommended). Turn on for contacts you trust.',
    );
    expect(en['cli.receipts.olderDefault']).toBe(
      'Delivery receipts are on from an older default. Each one shows publicly that a proof reached your agent, never the content.',
    );
    expect(en['cli.receipts.keepPrompt']).toBe(
      'Keep delivery receipts on? Type y and press Enter to keep them on, or anything else to turn them off.',
    );
    expect(en['cli.doctor.receiptsOlderDefault']).toBe(
      'Delivery receipts are on from an older default; they will turn off unless you keep them.',
    );
    expect(en['common.public.topup']).toBe(
      'The account you add credits from is publicly linked to your agent. For more privacy, use free test credits or a separate account only for AgentLink.',
    );
    expect(en['common.public.export']).toBe(
      'This file shows the proof, your agent profile and the message details. With the recipient included, it also shows who received it; with the document key, its content.',
    );
    expect(en['common.public.register']).toBe(
      "Registering puts your agent's link to you on the public record. Your agent's name is not published.",
    );
  });
});

describe('DESIGN-ADJ-1 (a) copy items', () => {
  it('names no network as a choice in the default view (PA-1, X-3)', () => {
    for (const [key, v] of strings) {
      if (key.startsWith('advanced.')) continue;
      expect(/choose Base|cheapest/i.test(v), key).toBe(false);
    }
    expect(en['pay.exchange.network']).toContain('{network}');
    expect(en['advanced.network']).toContain('{network}');
    expect(en['advanced.network']).toMatch(/proof network/i);
  });

  it('keeps raw record IDs out of the default view (X-12)', () => {
    for (const [key, v] of strings) {
      if (key.startsWith('advanced.')) continue;
      expect(/0x[0-9a-f…]/i.test(v), key).toBe(false);
      expect(/\{(recordId|txHash|termsFingerprint)\}/.test(v), key).toBe(false);
    }
    expect(en['advanced.recordId']).toContain('{recordId}');
  });

  it('uses rolling windows, not fixed ones (X-4)', () => {
    expect(en['common.credits.today']).toBe('{spent} of {budget} in the last 24 hours');
    expect(en['common.state.quotaReached']).not.toMatch(/resets on|this week/i);
    expect(en['common.state.quotaReached']).toMatch(/last 7 days/);
  });

  it('names unknown senders as a request, never a contact (X-7, S-7)', () => {
    expect(en['common.untrusted.label.unknown']).toContain('unknown sender');
    expect(en['common.untrusted.label.unknown']).not.toMatch(/Contact \{/);
    expect(en['common.unknownSender.row']).toBe('Request from an unknown sender · {fingerprint}');
  });

  it('uses the full config args and the package scope (X-9)', () => {
    expect(en['devconfig.args']).toBe('["-y", "@4thtech-io/agentlink", "mcp"]');
    expect(en['devconfig.args.agent']).toContain('"--agent", "{agentName}"');
    expect(en['onboarding.paste.prompt']).toContain('npx -y @4thtech-io/agentlink init');
    for (const [, v] of strings) expect(v).not.toMatch(/@4thtech\/|@4thtech\b(?!-io)/);
  });

  it('names every owner-presence option (X-10, LF-1, LS-2)', () => {
    expect(en['local.firstRun.body']).toBe(
      'Approvals need you: each approval, or each list of approvals you review together, asks for your passkey, owner code or owner passphrase, and only after you click Approve. Never give them to your AI.',
    );
    expect(en['common.state.passkeyUnsupported']).toMatch(/owner code or owner passphrase/);
    expect(en['local.firstRun.waits']).not.toMatch(/over your limit/);
  });

  it('adds the terminal path and the credits wording (S-1, S-2, S-5)', () => {
    expect(en['chat.status.pending_approval.summary']).toContain('agentlink approve {approvalId}');
    expect(en['chat.status.needs_credits.summary']).toContain('Add at least {shortfall}');
    expect(en['chat.status.needs_credits.summary']).toContain('$5 covers 50 proofs');
    expect(en['chat.status.needs_credits.notLive']).toBe(
      'Adding credits is not available yet in this version of AgentLink.',
    );
    expect(en['chat.status.ok.invite.summary']).toContain('Send it only to {contactName}');
    expect(en['chat.status.ok.invite.summary']).toContain('agentlink contacts --verify');
  });

  it('derives no text from a counterparty name (S-4, S-6)', () => {
    for (const [key, v] of strings) expect(v, key).not.toContain('contactFirstName');
    expect(en['common.safetyCode.changed']).toMatch(/same owner/);
    expect(en['common.safetyCode.changed']).not.toMatch(/Compare it again/);
  });

  it('says where a decision happened elsewhere (LA-6) and replaces the retired words (S-10)', () => {
    expect(en['common.approval.state.decidedElsewhere']).toBe(
      'Already decided in your terminal or another window.',
    );
    expect(en['common.empty.proof']).toMatch(/add proof/);
    expect(en['common.suggestedPassOn']).toBe('Suggested way to pass it on');
  });

  it('makes the owner code the terminal default (T-1)', () => {
    expect(en['cli.init.ownerCode']).toMatch(/owner code/);
    expect(en['cli.init.ownerCode']).not.toMatch(/passphrase/);
  });
});

describe('format and lookup', () => {
  it('fills placeholders and plurals', () => {
    expect(formatMessage('Hi {name}', { name: 'Ana' })).toBe('Hi Ana');
    const p = '{count, plural, one {# proof left} other {# proofs left}}';
    expect(formatMessage(p, { count: 1 })).toBe('1 proof left');
    expect(formatMessage(p, { count: 5 })).toBe('5 proofs left');
  });

  it('handles select and nested plural', () => {
    expect(formatMessage(en['common.public.receipt'], { action: 'opened' })).toContain('opened it');
    expect(formatMessage(en['common.public.receipt'], { action: 'zzz' })).toContain('received it');
    expect(formatMessage(en['chat.session.start'], { count: 1, contactName: 'Ana' })).toBe(
      '1 new message from Ana. Want me to read it?',
    );
    expect(formatMessage(en['chat.session.start'], { count: 3, contactName: 'Ana' })).toBe(
      '3 new messages from Ana. Want me to read them?',
    );
  });

  it('leaves unknown placeholders visible rather than inventing text', () => {
    expect(formatMessage('Hi {name}', {})).toBe('Hi {name}');
  });

  it('never interprets values as templates', () => {
    expect(formatMessage('Hi {name}', { name: '{count}' })).toBe('Hi {count}');
  });

  it('looks up by key', () => {
    expect(t('common.footer.endorsement')).toBe('by 4thTech');
  });
});
