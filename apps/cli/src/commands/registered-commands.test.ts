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
    .replace(/[…|\\]/g, ' ')
    .split(/\s+/)
    .filter((t) => t !== '' && t !== '†');
  if (tokens[0] !== 'agentlink' || tokens[1] === undefined) return undefined;
  const name = tokens[1];
  if (isPlaceholder(name) || (name.startsWith('--') && EXTRA_FLAGS.has(name.slice(2)))) {
    return undefined;
  }
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

describe('the subcommand list matches the handlers (M1-36c)', () => {
  const handlerFile: Readonly<Record<string, string>> = {
    owner: 'owner/owner-init.ts',
    contacts: 'owner/contacts-manage.ts',
    policy: 'owner/policy.ts',
    requests: 'requests.ts',
  };
  it.each(Object.entries(SUBCOMMANDS))('%s: every listed subcommand is handled', (name, subs) => {
    const source = readFileSync(join(SRC, 'commands', handlerFile[name] ?? ''), 'utf8');
    for (const sub of subs) expect(source).toContain(`'${sub}'`);
  });
});

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
    for (const dead of ['--verify', 'policy set', '--keystore', 'agentlink backup']) {
      expect(help).not.toContain(dead);
    }
  });

  it('the source scan reads the prefix forms too (M1-36e)', () => {
    const found = (text: string): string[] =>
      [...text.matchAll(COMMAND_IN_SOURCE)].map((m) => (m[1] ?? '').replace(/\\$/, ''));
    expect(found('run \\`${commandPrefix()} policy show\\` now')).toEqual(['policy show']);
    expect(found('run `{prefix} doctor`')).toEqual(['doctor']);
    expect(found('`${NPX_COMMAND} backup`').map((c) => problemWith(`agentlink ${c}`))).toEqual([
      'unknown command "backup"',
    ]);
    expect(found('`${name} · owner`')).toEqual([]);
  });

  it('the checker itself rejects a dead end', () => {
    expect(problemWith('agentlink backup')).toContain('unknown command');
    expect(problemWith('agentlink ui')).toBeUndefined();
    expect(problemWith('agentlink ui --agent <name>')).toBeUndefined();
    expect(problemWith('agentlink contacts --verify <id>')).toContain('--verify');
    expect(problemWith('agentlink init --keystore file')).toContain('--keystore');
    expect(problemWith('agentlink policy set <key> <value>')).toContain('"set"');
    expect(problemWith('agentlink policy show | allow-folder <path>')).toBeUndefined();
  });
});

/**
 * A backticked command in the source: the bare name, or (M1-36a-b, M1-36e) one of the prefix forms
 * that replace it, so the commands keep being checked after the bare name is gone.
 */
const COMMAND_IN_SOURCE =
  /`(?:agentlink|\{prefix\}|\$\{(?:commandPrefix\(\)|prefix\(\)|cliPrefix\(\)|NPX_COMMAND)\}) ([^`]*)`/g;

describe('the fixed text in the source (M1-36c)', () => {
  // M1-36e: every file is checked; the M1-36 UX-B and UX-D exceptions are gone.
  it('every backticked `agentlink ...` names something registered', () => {
    const bad: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(COMMAND_IN_SOURCE)) {
        // A trailing `\` is the escape of the closing backtick; a `{slot}` glued to a word is its
        // own (placeholder) token.
        const rest = (m[1] ?? '').replace(/\\$/, '').replace(/\{(\w+)\}/g, ' {$1}');
        const command = `agentlink ${rest}`;
        const problem = problemWith(command);
        if (problem !== undefined) bad.push(`${rel}: \`${command}\` (${problem})`);
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
