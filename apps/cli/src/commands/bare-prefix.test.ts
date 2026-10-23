// M1-36a-b: after the documented install (`npx -y @4thtech-io/agentlink init`) the bare `agentlink`
// is not on the user's PATH, so no "run this" text in these files may start with it. Commands are
// built from the runtime's `cliPrefix()` (M1-36a) or the fixed npx form; comments may still name the
// commands by their short name.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOOK_TEXT, INIT_TEXT } from './init.js';
import { OWNER_TEXT } from './owner/strings.js';
import { NO_AGENT_MESSAGE } from '../runtime/open-agent.js';
import { en } from '../tools/strings/en.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The files of this card (M1-36a-b). */
const FILES = [
  'commands/init.ts',
  'commands/owner/strings.ts',
  'tools/strings/en.ts',
  'runtime/open-agent.ts',
];

/** A command line that starts with the bare name: in backticks, after "run", or in <code>. */
const BARE = /(`|\brun |\brun: |<code>)agentlink [a-z]/i;

/** The source lines that are not comments. */
function codeLines(rel: string): { line: number; text: string }[] {
  return readFileSync(join(SRC, rel), 'utf8')
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text));
}

const valuesOf = (o: object): string[] =>
  Object.values(o).flatMap((v) =>
    typeof v === 'string' ? [v] : typeof v === 'function' ? [String(v(['work']))] : [],
  );

describe('no bare `agentlink` command prefix (M1-36a-b)', () => {
  it.each(FILES)('%s has none in its text', (rel) => {
    const bad = codeLines(rel)
      .filter(({ text }) => BARE.test(text))
      .map(({ line, text }) => `${rel}:${line}: ${text.trim()}`);
    expect(bad).toEqual([]);
  });

  it('the rendered texts have none either', () => {
    const texts = [
      ...valuesOf(INIT_TEXT),
      ...valuesOf(HOOK_TEXT),
      ...valuesOf(OWNER_TEXT),
      ...Object.values(en),
      NO_AGENT_MESSAGE,
    ];
    expect(texts.filter((t) => BARE.test(t))).toEqual([]);
  });

  it('the checker itself finds a bare prefix (self-test)', () => {
    expect(BARE.test('Run `agentlink doctor` in your own terminal.')).toBe(true);
    expect(BARE.test('or run agentlink ui.')).toBe(true);
    expect(BARE.test('Run `npx -y @4thtech-io/agentlink doctor`.')).toBe(false);
    expect(BARE.test('an entry named agentlink that is different')).toBe(false);
  });

  it('the hook text asks for the same command again after the install', () => {
    expect(HOOK_TEXT.noInstall).toContain('npm install -g @4thtech-io/agentlink');
    expect(HOOK_TEXT.noInstall).toContain('run the same command again');
  });
});
