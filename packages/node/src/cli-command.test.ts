// M1-36a-b: the approval page and the owner-init messages never tell the user to run a bare
// `agentlink ...` (it is not on PATH after the documented npx install) or a command that does not
// exist (`agentlink ui`). The command is the fixed npx form: a constant, never built from a request,
// a stored value or inbound content (I-5).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPIRED_HTML, UI_STRINGS, pageHtml } from './approval-page.js';
import { CLI_COMMAND } from './cli-command.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const BARE = /(`|\b[Rr]un |<code>)agentlink [a-z]/;

function codeLines(file: string): string[] {
  return readFileSync(join(SRC, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

describe('the npx command form (M1-36a-b)', () => {
  it('is the documented install form', () => {
    expect(CLI_COMMAND).toBe('npx -y @4thtech-io/agentlink');
  });

  it.each(['approval-page.ts', 'owner-init.ts', 'owner-first-policy.ts'])(
    '%s has no bare prefix',
    (file) => {
      expect(codeLines(file).filter((line) => BARE.test(line))).toEqual([]);
    },
  );

  it('the page texts have no bare prefix and no dead `ui` command', () => {
    const texts = [...Object.values(UI_STRINGS), EXPIRED_HTML, pageHtml('abc')];
    expect(texts.filter((t) => BARE.test(t))).toEqual([]);
    expect(texts.filter((t) => t.includes('agentlink ui'))).toEqual([]);
  });

  it('the owner steps on the page name the command that works', () => {
    expect(UI_STRINGS.needsOwner).toContain(`${CLI_COMMAND} owner init`);
    expect(UI_STRINGS.needsSetup).toContain(`${CLI_COMMAND} owner init`);
    expect(UI_STRINGS.expired).toContain(`${CLI_COMMAND} approve`);
    expect(EXPIRED_HTML).toContain(`<code>${CLI_COMMAND} approve</code>`);
  });

  it('the checker itself finds a bare prefix (self-test)', () => {
    expect(BARE.test('or run agentlink ui.')).toBe(true);
    expect(BARE.test('<code>agentlink ui</code>')).toBe(true);
    expect(BARE.test(`run ${CLI_COMMAND} approve`)).toBe(false);
  });
});
