// UX1113-R1 (D-147; 06 §8 `agentlink backup restore [file] [--check]`, alias `agentlink restore`;
// 04 §2.3.3 "Restore"): interactive terminal only, harness-marker guard, no piped stdin. The flow
// itself (hidden prompts, never overwrites, the new master code once) is node's restoreInTerminal,
// tested over a temporary HOME in packages/node/src/recovery-kit-restore.test.ts ("the terminal").
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_NAMES,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  createDispatcher,
  type DispatchIO,
} from '../dispatch.js';
import type { TerminalContext } from '../runtime/guards.js';
import { BACKUP_TEXT, restoreText } from './backup-strings.js';
import { backupCommandHandler, createBackupHandler } from './backup.js';

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

  it('passes the file and --check to the node flow (never a code) and maps its outcome', async () => {
    const calls: unknown[] = [];
    const outcomes = ['restored', 'checked', 'refused', 'cancelled'] as const;
    let next = 0;
    const handler = createBackupHandler({
      restore: (request, text) => {
        calls.push(request);
        expect(text.checkOpens).toBe(BACKUP_TEXT.checkOpens);
        const outcome = outcomes[next] ?? 'refused';
        next += 1;
        return Promise.resolve(outcome);
      },
    });
    const dispatch = createDispatcher({ backup: handler, restore: handler });
    const run = (argv: string[]) => dispatch(argv, io().value);
    expect(await run(['restore', '/tmp/kit.alkk'])).toBe(EXIT_OK);
    expect(await run(['backup', 'restore', '--check'])).toBe(EXIT_OK);
    expect(await run(['restore'])).toBe(EXIT_FAILED);
    expect(await run(['restore', '--check'])).toBe(EXIT_FAILED);
    expect(calls).toEqual([
      { file: '/tmp/kit.alkk', check: false },
      { check: true },
      { check: false },
      { check: true },
    ]);
    // `backup` alone, another subcommand, or two files is a usage error; the flow never runs.
    expect(await run(['backup'])).toBe(EXIT_USAGE);
    expect(await run(['backup', 'export'])).toBe(EXIT_USAGE);
    expect(await run(['restore', 'a.alkk', 'b.alkk'])).toBe(EXIT_USAGE);
    expect(calls).toHaveLength(4);
  });

  it('every word is plain language (no seed phrase, wallet or transaction)', () => {
    const text = restoreText();
    const all = [
      text.noKit,
      text.pickKit,
      text.masterCodePrompt,
      text.recoveryCodePrompt,
      text.checkOpens,
      text.nothingToRestore,
      text.masterCodeShown,
      text.savedIt,
      text.nextSteps,
      ...Object.values(text.errors),
    ].join('\n');
    expect(all).not.toMatch(/seed phrase|wallet|transaction|\bgas\b/i);
    expect(text.recoveryCodePrompt).toMatch(/never give it to your AI/);
  });
});

describe('main wiring: agentlink restore reaches node and refuses without a real terminal', () => {
  it('runs restoreInTerminal (the dispatcher passes; the node prompt refuses a non-TTY) and writes nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'al-r1-e2e-'));
    const saved = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      await mkdir(join(home, 'Downloads'), { recursive: true });
      await writeFile(join(home, 'Downloads', 'agentlink-recovery-kit-x.alkk'), 'ALKK....');
      const out: string[] = [];
      const dispatch = createDispatcher({
        backup: backupCommandHandler,
        restore: backupCommandHandler,
      });
      // The test runner's stdin is not a TTY, so node's own prompt refuses before anything is read.
      const code = await dispatch(['restore'], {
        output: { print: (t) => out.push(t), printError: (t) => out.push(t) },
        terminal: OWNER_TTY,
        version: '0.0.0',
      });
      expect(code).toBe(EXIT_FAILED);
      expect(await readdir(home)).toEqual(['Downloads']);
      expect(out.join(' ')).not.toMatch(/ALKK|Downloads/);
    } finally {
      if (saved === undefined) delete process.env['HOME'];
      else process.env['HOME'] = saved;
      await rm(home, { recursive: true, force: true });
    }
  });
});
