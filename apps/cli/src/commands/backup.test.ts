// UX1113-R1 (D-147; 06 §8 `agentlink backup restore [file] [--check]`, alias `agentlink restore`;
// 04 §2.3.3 "Restore"): interactive terminal only, harness-marker guard, the recovery code only from
// the hidden prompt, never overwrites, a new master code shown once when it creates the owner.
import { mkdtemp, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OwnerTerminal } from '@4thtech-io/node';
import {
  FAST,
  MemoryKeychain,
  makeAgent,
  makeKit,
  makeOwner,
} from '../../../../packages/node/src/recovery-kit-restore.fixture.js';
import { COMMAND_NAMES, EXIT_FAILED, EXIT_OK, createDispatcher, type DispatchIO } from '../dispatch.js';
import type { TerminalContext } from '../runtime/guards.js';
import { BACKUP_TEXT } from './backup-strings.js';
import { createBackupHandler } from './backup.js';

const POSIX = process.platform !== 'win32';
const OWNER_TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };

function io(terminal: TerminalContext = OWNER_TTY) {
  const out: string[] = [];
  const err: string[] = [];
  const value: DispatchIO = {
    output: { print: (t) => out.push(t), printError: (t) => err.push(t) },
    terminal,
    version: '0.0.0',
  };
  return { value, out, err };
}

/** A scripted owner terminal: answers in order; records everything written. */
function scripted(answers: string[]) {
  const written: string[] = [];
  const asked: string[] = [];
  const terminal: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: (label) => {
      asked.push(`secret:${label}`);
      return Promise.resolve(new TextEncoder().encode(answers.shift() ?? ''));
    },
    confirm: (question) => {
      asked.push(`confirm:${question}`);
      return Promise.resolve(/^y/i.test(answers.shift() ?? ''));
    },
    readText: (label) => {
      asked.push(`text:${label}`);
      return Promise.resolve(answers.shift() ?? '');
    },
    clearScreen: () => void written.push('<clear>'),
  };
  return { terminal, written, asked };
}

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'al-r1-cli-'));
  home = join(root, 'home');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('agentlink backup restore and agentlink restore (06 §8)', () => {
  it('both commands are registered as owner commands (†)', () => {
    expect(COMMAND_NAMES).toContain('backup');
    expect(COMMAND_NAMES).toContain('restore');
  });

  it('refuses under a harness marker and with piped stdin, before the handler runs', async () => {
    let ran = 0;
    const dispatch = createDispatcher({
      backup: () => Promise.resolve((ran += 1) && EXIT_OK),
      restore: () => Promise.resolve((ran += 1) && EXIT_OK),
    });
    for (const argv of [['restore'], ['backup', 'restore'], ['restore', '--check']]) {
      const marker = io({ ...OWNER_TTY, env: { CLAUDECODE: '1' } });
      expect(await dispatch(argv, marker.value)).toBe(EXIT_FAILED);
      const piped = io({ stdinIsTTY: false, stdoutIsTTY: true, env: {} });
      expect(await dispatch(argv, piped.value)).toBe(EXIT_FAILED);
    }
    expect(ran).toBe(0);
  });

  it.runIf(POSIX)('restores a kit on a clean computer and shows the new master code once', async () => {
    const owner = await makeOwner();
    const agent = await makeAgent(root, owner, 'helper', { people: 1 });
    const kit = await makeKit(root, owner, [agent], 'agentlink-recovery-kit-a.alkk', join(home, 'Downloads'));
    const keychain = new MemoryKeychain();
    const { terminal, written } = scripted([kit.code, 'yes', 'yes']);
    const handler = createBackupHandler({
      home: () => home,
      keychain: () => keychain,
      terminal: () => terminal,
      kdf: FAST,
    });
    const out = io();
    const code = await handler({
      command: 'restore',
      parsed: { values: {}, positionals: [kit.path], agent: undefined },
      output: out.value.output,
      terminal: OWNER_TTY,
    });
    expect(code).toBe(EXIT_OK);
    const config = await readFile(join(home, '.agentlink', 'agents', 'helper', 'config.json'), 'utf8');
    expect(config).toContain(agent.agentId);
    const shown = written.join('\n');
    expect(shown).toMatch(/[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}/);
    expect(shown).not.toContain(kit.code);
    expect([...out.out, ...out.err].join('\n')).not.toContain(kit.code);
    expect(written).toContain('<clear>');
  });

  it.runIf(POSIX)('--check opens and lists without writing anything', async () => {
    const owner = await makeOwner();
    const agent = await makeAgent(root, owner, 'helper');
    const kit = await makeKit(root, owner, [agent], 'agentlink-recovery-kit-b.alkk', join(home, 'Downloads'));
    const keychain = new MemoryKeychain();
    const { terminal, written } = scripted([kit.code]);
    const handler = createBackupHandler({
      home: () => home,
      keychain: () => keychain,
      terminal: () => terminal,
      kdf: FAST,
    });
    const out = io();
    // Without a file: the kit found in Downloads is offered (the newest is the default).
    const code = await handler({
      command: 'backup',
      parsed: { values: { check: true }, positionals: ['restore'], agent: undefined },
      output: out.value.output,
      terminal: OWNER_TTY,
    });
    expect(code).toBe(EXIT_OK);
    expect(written.join('\n')).toContain(BACKUP_TEXT.checkOpens);
    expect([...keychain.items.keys()]).toEqual([]);
    await expect(lstat(join(home, '.agentlink', 'agents'))).rejects.toThrow();
  });

  it.runIf(POSIX)('a wrong code three times ends with nothing written and the code never echoed', async () => {
    const owner = await makeOwner();
    const agent = await makeAgent(root, owner, 'helper');
    const kit = await makeKit(root, owner, [agent], 'agentlink-recovery-kit-c.alkk', join(home, 'Downloads'));
    const keychain = new MemoryKeychain();
    const wrong = 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA';
    const { terminal, written } = scripted([wrong, wrong, wrong]);
    const handler = createBackupHandler({
      home: () => home,
      keychain: () => keychain,
      terminal: () => terminal,
      kdf: FAST,
    });
    const out = io();
    const code = await handler({
      command: 'restore',
      parsed: { values: {}, positionals: [kit.path], agent: undefined },
      output: out.value.output,
      terminal: OWNER_TTY,
    });
    expect(code).toBe(EXIT_FAILED);
    expect([...written, ...out.out, ...out.err].join('\n')).not.toContain(wrong);
    expect([...keychain.items.keys()]).toEqual([]);
  });
});
