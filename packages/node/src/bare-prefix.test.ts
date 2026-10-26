// M1-36e: no message of this package tells the user to run a bare `agentlink ...`: after the
// documented npx install it is not on PATH. Every command in a message starts with CLI_COMMAND
// (M1-36a-b). cli-command.test.ts checks the approval page and owner init; this checks every source
// file, so a new message cannot bring the bare name back. Comments may still name the commands.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLI_COMMAND } from './cli-command.js';

const SRC = dirname(fileURLToPath(import.meta.url));

/** A command that starts with the bare name: in backticks, after "run", or in <code>. */
const BARE = /(`|\\`|\b[Rr]un:? |<code>)agentlink [a-z]/;

/** The non-test source files of this package. */
const FILES = readdirSync(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

/** The source lines that are not comments. */
function codeLines(file: string): { line: number; text: string }[] {
  return readFileSync(join(SRC, file), 'utf8')
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text));
}

describe('no bare `agentlink` command prefix in node messages (M1-36e)', () => {
  it('reads the message files', () => {
    for (const file of ['owner-add-agent.ts', 'owner-change-code.ts', 'keychain.ts']) {
      expect(FILES).toContain(file);
    }
  });

  it('no message names a bare command', () => {
    const bad = FILES.flatMap((file) =>
      codeLines(file)
        .filter(({ text }) => BARE.test(text))
        .map(({ line, text }) => `${file}:${String(line)}: ${text.trim()}`),
    );
    expect(bad).toEqual([]);
  });

  it('the checker itself finds a bare prefix (self-test)', () => {
    expect(BARE.test("'Run `agentlink doctor` in your own terminal.'")).toBe(true);
    expect(BARE.test('`Check it at \\`agentlink owner init\\`.`')).toBe(true);
    expect(BARE.test(`Run \`${CLI_COMMAND} doctor\`.`)).toBe(false);
    expect(BARE.test("const KEYCHAIN_SERVICE = 'agentlink';")).toBe(false);
    expect(CLI_COMMAND).toBe('npx -y @4thtech-io/agentlink');
  });
});
