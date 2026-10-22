// M1-36c: no dead-end commands. Everything the CLI tells a user to run (`--help`, command output,
// and the fixed text in the source) must name a registered command, subcommand and flag.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMANDS, createDispatcher, helpText, type DispatchIO } from '../dispatch.js';

/** The subcommands each command really handles (06 §8). */
const SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  owner: ['init', 'add-agent', 'change-code'],
  contacts: ['rename', 'remove'],
  policy: ['show', 'allow-folder', 'remove-folder', 'recover'],
  requests: ['accept', 'ignore', 'block', 'blocked', 'unblock'],
};
/** Flags that the dispatcher itself answers. */
const EXTRA_FLAGS = new Set(['help', 'version']);

const isPlaceholder = (token: string): boolean => /^[<[{$]/.test(token);

/** Returns what is wrong with one `agentlink ...` instruction, or undefined when it is real. */
function problemWith(instruction: string): string | undefined {
  const tokens = instruction
    .replace(/[…|]/g, ' ')
    .split(/\s+/)
    .filter((t) => t !== '' && t !== '†');
  if (tokens[0] !== 'agentlink' || tokens[1] === undefined) return undefined;
  const name = tokens[1];
  if (isPlaceholder(name)) return undefined;
  const spec = COMMANDS.find((c) => c.name === name);
  if (spec === undefined) return `unknown command "${name}"`;
  const options = spec.options ?? {};
  const subs = SUBCOMMANDS[name];
  for (let i = 2; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (isPlaceholder(token)) continue;
    if (token.startsWith('--')) {
      const flag = token.slice(2).replace(/[\]>].*$/, '');
      if (!EXTRA_FLAGS.has(flag) && !Object.hasOwn(options, flag)) {
        return `"${name}" has no flag --${flag}`;
      }
      if (options[flag]?.type === 'string' && !(tokens[i + 1] ?? '-').startsWith('-')) i += 1;
      continue;
    }
    if (i === 2 && subs !== undefined && !subs.includes(token.replace(/[^\w-]/g, ''))) {
      return `"${name}" has no subcommand "${token}"`;
    }
  }
  return undefined;
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !/\.test\.ts$/.test(path) ? [path] : [];
  });
}

/**
 * Files another card owns and is fixing (M1-36 UX-B and UX-D). Their dead ends are tolerated here
 * only until those cards land; remove each entry then. Every other file must be clean.
 */
const FIXED_BY_OTHER_CARDS = [
  'tools/strings/en.ts',
  'tools/invite-common.ts',
  'commands/init.ts',
  'approval/next-step.ts',
  'approval/approval-ui.ts',
];

describe('the instructions in --help (M1-36c)', () => {
  it('every usage line names a registered command, subcommand and flag', () => {
    const lines = helpText()
      .split('\n')
      .filter((l) => l.includes('agentlink '));
    expect(lines.length).toBeGreaterThan(10);
    const bad = lines
      .map((l) => ({ l: l.trim(), p: problemWith(l.trim()) }))
      .filter((x) => x.p !== undefined);
    expect(bad).toEqual([]);
  });

  it('does not list the commands that do not exist yet', () => {
    const help = helpText();
    for (const dead of ['--verify', 'policy set', '--keystore', 'agentlink ui']) {
      expect(help).not.toContain(dead);
    }
  });

  it('the checker itself rejects a dead end', () => {
    expect(problemWith('agentlink ui')).toContain('unknown command');
    expect(problemWith('agentlink contacts --verify <id>')).toContain('--verify');
    expect(problemWith('agentlink init --keystore file')).toContain('--keystore');
    expect(problemWith('agentlink policy set <key> <value>')).toContain('"set"');
    expect(problemWith('agentlink policy show | allow-folder <path>')).toBeUndefined();
  });
});

describe('the fixed text in the source (M1-36c)', () => {
  it('every backticked `agentlink ...` names something registered', () => {
    const bad: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (FIXED_BY_OTHER_CARDS.includes(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/`(agentlink [^`]*)`/g)) {
        const problem = problemWith(m[1] ?? '');
        if (problem !== undefined) bad.push(`${rel}: \`${m[1]}\` (${problem})`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('the commands answer what they list (M1-36c)', () => {
  it('a removed flag is a usage error, not a "not available" dead end', async () => {
    const err: string[] = [];
    const io: DispatchIO = {
      output: { print: () => undefined, printError: (t) => err.push(t) },
      terminal: { stdinIsTTY: true, stdoutIsTTY: true, env: {} },
      version: '0.0.0',
    };
    const code = await createDispatcher()(['contacts', '--verify', 'x'], io);
    expect(code).toBe(2);
    expect(err.join('\n')).not.toContain('not available');
  });
});
