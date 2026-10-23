// M1-36e (11 §5.1, finding F14): everything the CLI shows a person stays inside the default
// vocabulary: terminal output, tool summaries, `nextStep` and hints. The texts are the exported
// fixed-text tables, so the lint reads user-facing strings only, never code identifiers or comments.
// Exceptions are listed in ALLOWED, each with its reason; an entry that no longer matches fails, so
// the list cannot outlive the text it excuses.
import { describe, expect, it } from 'vitest';
import { CREDITS_TEXT } from './commands/credits.js';
import { DOCTOR_PROOF_TEXT, DOCTOR_TEXT } from './commands/doctor.js';
import { HOOK_TEXT, INIT_TEXT } from './commands/init.js';
import { CONTACTS_MANAGE_TEXT } from './commands/owner/contacts-manage.js';
import { POLICY_REVIEW_ROWS, POLICY_TEXT } from './commands/owner/policy.js';
import { OWNER_TEXT } from './commands/owner/strings.js';
import { TERMS_CARD_TEXT } from './commands/owner/terms-card.js';
import { TEXT } from './commands/shared.js';
import {
  VERIFY_CLI_TEXT,
  VERIFY_CONTENT_TEXT,
  VERIFY_FAILURE_TEXT,
  VERIFY_NOTICE_TEXT,
} from './commands/verify.js';
import { DISPATCH_TEXT, helpText } from './dispatch.js';
import { NO_AGENT_MESSAGE } from './runtime/open-agent.js';
import { ACK_TEXT } from './tools/acknowledge.js';
import { EXPORT_TEXT } from './tools/export-proof-pack.js';
import { FETCH_FILE_TEXT } from './tools/fetch-file.js';
import { FILE_TEXT } from './tools/files-common.js';
import { GET_PROOF_TEXT } from './tools/get-proof.js';
import { INBOX_TEXT } from './tools/inbox.js';
import { INVITE_TEXT } from './tools/invite-common.js';
import { PROOF_TEXT } from './tools/proofs-common.js';
import { TERMS_FREE_CREDITS_TEXT } from './tools/propose-terms.js';
import { RESULT_TEXT } from './tools/result.js';
import { SEND_TEXT } from './tools/send.js';
import { en } from './tools/strings/en.js';
import { TERMS_TEXT } from './tools/terms-common.js';
import { TOOL_TEXT } from './tools/text.js';
import { VERIFY_TEXT } from './tools/verify-proof-pack.js';
import { NEVER_SAY, lintVocabulary, proseOf } from './vocabulary.js';

/** Sample arguments for the text functions: plain words, so they add no banned term. */
const SAMPLE_ARGS: readonly unknown[] = ['Sample', 'Sample', 'Sample', 'Sample'];

/** Every string of a text table, keyed `<table>.<key>`; functions are called with samples. */
function stringsOf(table: string, value: unknown): [string, string][] {
  if (typeof value === 'string') return [[table, value]];
  if (typeof value === 'function') {
    for (const args of [SAMPLE_ARGS, [['Sample']], [1, 1, 1]]) {
      try {
        const out: unknown = (value as (...a: unknown[]) => unknown)(...args);
        if (typeof out === 'string') return [[table, out]];
      } catch {
        // try the next sample shape
      }
    }
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => stringsOf(`${table}.${String(i)}`, v));
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).flatMap((k) =>
      stringsOf(`${table}.${k}`, (value as Record<string, unknown>)[k]),
    );
  }
  return [];
}

/** The user-facing text tables of the CLI. */
const TABLES: Readonly<Record<string, unknown>> = {
  CREDITS_TEXT,
  DOCTOR_PROOF_TEXT,
  DOCTOR_TEXT,
  HOOK_TEXT,
  INIT_TEXT,
  CONTACTS_MANAGE_TEXT,
  POLICY_TEXT,
  POLICY_REVIEW_ROWS: POLICY_REVIEW_ROWS.map((row) => row.label),
  OWNER_TEXT,
  TERMS_CARD_TEXT,
  TEXT,
  VERIFY_CLI_TEXT,
  VERIFY_CONTENT_TEXT,
  VERIFY_FAILURE_TEXT,
  VERIFY_NOTICE_TEXT,
  DISPATCH_TEXT,
  // The usage lines are command syntax (`agentlink policy show`, `--harness`), not prose.
  helpText: helpText()
    .split('\n')
    .filter((line) => !/^\s*agentlink /.test(line))
    .join('\n'),
  NO_AGENT_MESSAGE,
  ACK_TEXT,
  EXPORT_TEXT,
  FETCH_FILE_TEXT,
  FILE_TEXT,
  GET_PROOF_TEXT,
  INBOX_TEXT,
  INVITE_TEXT,
  PROOF_TEXT,
  TERMS_FREE_CREDITS_TEXT,
  RESULT_TEXT,
  SEND_TEXT,
  en,
  TERMS_TEXT,
  TOOL_TEXT,
  VERIFY_TEXT,
};

/**
 * Reviewed exceptions: `<table>.<key>` (or a prefix ending in `.`) → the terms it may use, and why.
 * Keep each entry as narrow as the text allows.
 */
const ALLOWED: readonly {
  readonly where: string;
  readonly terms: readonly string[];
  readonly reason: string;
}[] = [
  {
    where: 'PROOF_TEXT.useTermsToolsNextStep',
    terms: ['notarize'],
    reason: 'a nextStep for the AI that names the `notarize` argument of the terms tools',
  },
  {
    where: 'SEND_TEXT.notarizeRetry',
    terms: ['notarize'],
    reason: 'a hint for the AI that names the `notarize` argument of agentlink_send',
  },
  {
    where: 'TERMS_TEXT.notarizeUnavailableNextStep',
    terms: ['notarize'],
    reason: 'a nextStep for the AI that names the `notarize` argument to leave out',
  },
];

const allowFor = (where: string): string[] =>
  ALLOWED.filter((a) =>
    a.where.endsWith('.') ? where.startsWith(a.where) : where === a.where,
  ).flatMap((a) => a.terms);

const ALL = Object.entries(TABLES).flatMap(([table, value]) => stringsOf(table, value));

describe('CLI vocabulary lint (M1-36e, 11 §5.1)', () => {
  it('reads every text table', () => {
    for (const table of Object.keys(TABLES)) {
      expect(
        ALL.some(([where]) => where === table || where.startsWith(`${table}.`)),
        table,
      ).toBe(true);
    }
    expect(ALL.length).toBeGreaterThan(300);
  });

  it('no default text uses a banned term', () => {
    const bad = ALL.flatMap(([where, text]) =>
      lintVocabulary(text, allowFor(where)).map((term) => `${where}: "${term}"`),
    );
    expect(bad).toEqual([]);
  });

  it('every exception has a reason and still matches its text', () => {
    for (const entry of ALLOWED) {
      expect(entry.reason.length, entry.where).toBeGreaterThan(20);
      const texts = ALL.filter(([where]) =>
        entry.where.endsWith('.') ? where.startsWith(entry.where) : where === entry.where,
      );
      expect(texts.length, entry.where).toBeGreaterThan(0);
      for (const term of entry.terms) {
        expect(
          texts.some(([, text]) => lintVocabulary(text).includes(term)),
          `${entry.where}: "${term}" is no longer used, remove the exception`,
        ).toBe(true);
      }
    }
  });
});

describe('the lint itself (self-test)', () => {
  it('fails on a planted violation', () => {
    expect(lintVocabulary('Open your wallet to pay gas.')).toEqual(['wallet', 'gas']);
    expect(lintVocabulary('Some relays did not answer.')).toEqual(['nostr/relay']);
    expect(lintVocabulary('Your policy was saved on-chain.')).toEqual([
      'blockchain',
      'chain',
      'policy',
    ]);
    expect(lintVocabulary('Keep it in your password manager.')).toEqual([]);
    expect(lintVocabulary('Enter your password.')).toEqual(['password']);
  });

  it('a planted violation in a real table is caught', () => {
    const planted = { ...TEXT, planted: 'Check the transaction hash.' };
    const bad = stringsOf('TEXT', planted).flatMap(([where, text]) =>
      lintVocabulary(text, allowFor(where)).map((term) => `${where}: ${term}`),
    );
    expect(bad).toContain('TEXT.planted: transaction');
    expect(bad).toContain('TEXT.planted: hash');
  });

  it('an exception covers only its own text', () => {
    expect(allowFor('SEND_TEXT.notarizeRetry')).toEqual(['notarize']);
    expect(allowFor('SEND_TEXT.useTermsToolsNextStep')).toEqual([]);
  });

  it('a command or tool name in backticks or <code> is not prose', () => {
    expect(lintVocabulary('Run `npx -y @4thtech-io/agentlink policy show`.')).toEqual([]);
    expect(lintVocabulary('Use <code>agentlink_notarize</code>.')).toEqual([]);
    expect(proseOf('a `b` c')).toBe('a   c');
  });

  it('matches whole words only: keychain and rehash are fine', () => {
    expect(lintVocabulary('Your system keychain is locked.')).toEqual([]);
    expect(lintVocabulary('rehash')).toEqual([]);
  });

  it('an allowed term is skipped for that text only', () => {
    expect(lintVocabulary('your owner key', ['owner key'])).toEqual([]);
    expect(lintVocabulary('your owner key')).toEqual(['owner key']);
  });

  it('names every 11 §5.1 term', () => {
    const names = NEVER_SAY.map((t) => t.name);
    for (const term of ['wallet', 'gas', 'seed phrase', 'transaction', 'chain', 'address']) {
      expect(names).toContain(term);
    }
  });
});
