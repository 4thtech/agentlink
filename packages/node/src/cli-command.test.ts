// M1-36a-b: the approval pages and the owner-init messages never tell the user to run a bare
// `agentlink ...` (it is not on PATH after the documented npx install). `ui` is a real command
// (apps/cli dispatch.ts) since M1-11b-9; R1-UI-12 names it on the expired app link, and an expired
// approval link names `approve` (REL051-INTFIX). The command is the fixed npx form: a constant, never built from a request,
// a stored value or inbound content (I-5). M1-11b-2c: the server's pages are the fixed ones in
// approval-pages.ts; the approvals' own words live in the app (apps/local-ui strings.test.ts checks
// the same rules there).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EXPIRED_APPROVAL_HTML,
  EXPIRED_HTML,
  NO_APP_HTML,
  PAGE_STRINGS,
} from './approval-pages.js';
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

  it.each(['approval-pages.ts', 'owner-init.ts', 'owner-first-policy.ts'])(
    '%s has no bare prefix',
    (file) => {
      expect(codeLines(file).filter((line) => BARE.test(line))).toEqual([]);
    },
  );

  it('the page texts have no bare prefix, and `ui` only in its npx form on the app link', () => {
    const texts = [
      ...Object.values(PAGE_STRINGS),
      EXPIRED_HTML,
      EXPIRED_APPROVAL_HTML,
      NO_APP_HTML,
    ];
    expect(texts.filter((t) => BARE.test(t))).toEqual([]);
    const ui = texts.filter((t) => t.includes('agentlink ui'));
    expect(ui).toEqual([EXPIRED_HTML]);
    expect(EXPIRED_HTML).toContain(`<code>${CLI_COMMAND} ui</code>`);
  });

  it('the owner steps on the page name the command that works', () => {
    // An approval link (expired, or with no app) leads to `approve`, which lists what waits.
    expect(PAGE_STRINGS.noApp).toContain(`${CLI_COMMAND} approve`);
    expect(EXPIRED_APPROVAL_HTML).toContain(`<code>${CLI_COMMAND} approve</code>`);
    expect(NO_APP_HTML).toContain(`<code>${CLI_COMMAND} approve</code>`);
    // The app link leads back to the app.
    expect(EXPIRED_HTML).toContain(`<code>${CLI_COMMAND} ui</code>`);
    expect(EXPIRED_HTML).not.toContain(`${CLI_COMMAND} approve`);
  });

  it('the checker itself finds a bare prefix (self-test)', () => {
    expect(BARE.test('or run agentlink ui.')).toBe(true);
    expect(BARE.test('<code>agentlink ui</code>')).toBe(true);
    expect(BARE.test(`run ${CLI_COMMAND} approve`)).toBe(false);
  });
});
