// M1-11b-2: the approvals words. M1-11b-2c: the server-rendered approval page they were compared
// with is gone, so these are the only approvals words; the rules that page's tests held for them
// (packages/node cli-command.test.ts M1-36a-b, approval-page.test.ts PRE-031-FIXES) are checked
// here: the CLI prefix is the server's, every owner step names the npx form (never a bare
// `agentlink ...` or the dead `agentlink ui`), the paid note states no amount of its own, and the
// local app says "backup code" (11 §5.5, UX-031-QUICKWINS).
import { lintVocabulary } from '@4thtech-io/ui';
import { describe, expect, it } from 'vitest';
import { APPROVAL_STRINGS, BACKUP_CODE_WORDING, CLI_PREFIX } from './strings.js';

// Read through Vite: a relative import would leave the app (boundaries rule).
const files = import.meta.glob(['../../../../../packages/node/src/cli-command.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

function source(name: string): string {
  const entry = Object.entries(files).find(([path]) => path.endsWith(name));
  const text = entry?.[1];
  if (typeof text !== 'string' || text === '') throw new Error(`${name} missing`);
  return text;
}

const BARE = /(`|\b[Rr]un |<code>)agentlink [a-z]/;

describe('the approvals words name the command that works (M1-36a-b)', () => {
  it('uses the same CLI prefix as the server', () => {
    expect(source('cli-command.ts')).toContain(`export const CLI_COMMAND = '${CLI_PREFIX}';`);
  });

  it('the owner steps name the npx form', () => {
    expect(APPROVAL_STRINGS.needsOwner).toContain(`${CLI_PREFIX} owner init`);
    expect(APPROVAL_STRINGS.needsSetup).toContain(`${CLI_PREFIX} owner init`);
    expect(APPROVAL_STRINGS.notRunning).toContain(`${CLI_PREFIX} approve`);
    expect(APPROVAL_STRINGS.wait).toContain(`${CLI_PREFIX} approve`);
  });

  it('has no bare prefix and no dead `ui` command', () => {
    const texts = Object.values(APPROVAL_STRINGS);
    expect(texts.filter((t) => BARE.test(t))).toEqual([]);
    expect(texts.filter((t) => t.includes('agentlink ui'))).toEqual([]);
  });

  it('the checker itself finds a bare prefix (self-test)', () => {
    expect(BARE.test('or run agentlink ui.')).toBe(true);
    expect(BARE.test(`run ${CLI_PREFIX} approve`)).toBe(false);
  });
});

describe('the approvals words (11 §5)', () => {
  it('passes lintVocabulary', () => {
    expect(lintVocabulary(Object.values(APPROVAL_STRINGS).join('\n'))).toEqual([]);
  });

  it('says "backup code", never "owner code", in the renamed keys (11 §5.5)', () => {
    expect(BACKUP_CODE_WORDING.size).toBeGreaterThan(0);
    for (const key of BACKUP_CODE_WORDING) {
      const text = APPROVAL_STRINGS[key as keyof typeof APPROVAL_STRINGS];
      expect(text, key).toMatch(/[Bb]ackup code/);
      expect(text, key).not.toMatch(/[Oo]wner code/);
    }
  });

  it('PRE-031-FIXES: the paid note names no amount, so it never differs from the signed statement', () => {
    expect(APPROVAL_STRINGS.paidAlone).not.toContain('{cost}');
    expect(APPROVAL_STRINGS.paidAlone).not.toMatch(/\$\d/);
  });
});
