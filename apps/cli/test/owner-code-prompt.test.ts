// M1-9zd: the owner code typed at a shell prompt (the M1-9z incident: an owner code typed into a
// shell and a chat). Two guards, both UX only (04 §2.5, §2.8; G-1, D-67), never a security boundary:
//
// - Before every owner code prompt the owner commands say, in fixed text, that the code goes only
//   at the prompt: it isn't a shell command and never goes into a chat (11 §5.5, §6.10). A wrong
//   code gets the same reminder.
// - An argument shaped like a generated owner code (04 §2.8 `password` kind 1: 24 base32
//   characters, spaces and dashes ignored, `0`/`1`/`8` read as `O`/`I`/`B`) stops the command
//   before anything runs, with fixed text that never echoes it (I-1, I-5), and says how to change
//   the code.
import { KeyStoreError, type OwnerPublicKeys } from '@4thtech-io/crypto';
import type { ChangeOwnerCodeOptions } from '@4thtech-io/node';
import { describe, expect, it } from 'vitest';
import {
  ownerCommandHandlers,
  type OwnerAgent,
  type OwnerCommandDeps,
} from '../src/commands/owner/index.js';
import { withOwnerPrompts } from '../src/commands/owner/prompts.js';
import { OWNER_TEXT } from '../src/commands/owner/strings.js';
import {
  COMMAND_NAMES,
  createDispatcher,
  DISPATCH_TEXT,
  type CommandHandler,
  type CommandName,
} from '../src/dispatch.js';
import { createOutput } from '../src/output.js';
import { looksLikeOwnerCode } from '../src/runtime/owner-code-shape.js';
import type { TerminalContext } from '../src/runtime/guards.js';

const TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };

// Shaped like a generated owner code, made up for these tests: 24 characters of A–Z and 2–7.
const CODE = 'QF7K2MZDH4XTWR6JPL3NAEBC';
const GROUPS = ['QF7K', '2MZD', 'H4XT', 'WR6J', 'PL3N', 'AEBC'];

/** Every recorded line, joined, so a test can check that no part of the code was printed. */
function printedNothingOf(lines: readonly string[]): void {
  const all = lines.join('\n').toUpperCase();
  for (const group of GROUPS) expect(all).not.toContain(group);
}

function dispatcherRecording() {
  const out: string[] = [];
  const err: string[] = [];
  const called: CommandName[] = [];
  const handlers: Partial<Record<CommandName, CommandHandler>> = {};
  for (const name of COMMAND_NAMES) {
    handlers[name] = () => {
      called.push(name);
      return Promise.resolve(0);
    };
  }
  const dispatch = createDispatcher(handlers);
  return {
    out,
    err,
    called,
    run: (argv: string[], terminal: TerminalContext = TTY) =>
      dispatch(argv, {
        output: createOutput({ log: (l) => out.push(l), error: (l) => err.push(l) }),
        terminal,
        version: '0.0.0',
      }),
  };
}

describe('an owner code typed as part of a command (M1-9zd)', () => {
  const typedInCommands: string[][] = [
    ['approve', CODE],
    ['approve', 'apr_AAAAAAAAAAAAAAAAAAAAAA', CODE],
    ['approve', GROUPS.join('-')],
    ['approve', GROUPS.join('-').toLowerCase()],
    // Typed with spaces: the shell splits it into six words.
    ['approve', ...GROUPS],
    ['owner', 'change-code', CODE],
    ['policy', 'allow-folder', CODE],
    ['contacts', 'rename', 'c1', GROUPS.join(' ')],
    ['status', `--agent=${CODE}`],
    ['status', '--agent', CODE],
    // 0, 1 and 8 are read as O, I and B (04 §2.8 kind 1, step 4).
    ['approve', CODE.replace('B', '8')],
    // The code alone, as if it were a command.
    [CODE],
    GROUPS,
  ];
  for (const argv of typedInCommands) {
    it(`stops \`${argv.length} words\` before anything runs, without echoing it (${argv[0] === CODE || argv[0] === GROUPS[0] ? 'code alone' : (argv[0] ?? '')})`, async () => {
      const d = dispatcherRecording();
      expect(await d.run(argv)).toBe(2);
      expect(d.called).toEqual([]);
      expect(d.err).toEqual([DISPATCH_TEXT.ownerCodeInCommand]);
      expect(d.out).toEqual([]);
      printedNothingOf([...d.out, ...d.err]);
    });
  }

  it('stops it the same way when an AI app runs the command (no terminal, a marker set)', async () => {
    const d = dispatcherRecording();
    const marked: TerminalContext = {
      stdinIsTTY: false,
      stdoutIsTTY: false,
      env: { CLAUDECODE: '1' },
    };
    expect(await d.run(['approve', CODE], marked)).toBe(2);
    expect(d.err).toEqual([DISPATCH_TEXT.ownerCodeInCommand]);
    expect(d.called).toEqual([]);
  });

  it('the refusal says how to change the code and names no part of what was typed', () => {
    const text = DISPATCH_TEXT.ownerCodeInCommand;
    expect(text.startsWith('Problem  ')).toBe(true);
    expect(text).toContain('agentlink owner change-code');
    expect(text).toMatch(/shell command|part of a command/);
    expect(text).toMatch(/chat/);
    // 11 §6.10: 80 columns; the command on its own line.
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
    expect(text.split('\n')).toContain('         npx -y @4thtech-io/agentlink owner change-code');
    // 11 §5.1 and §5.5: never "password", "wallet", "seed phrase".
    expect(text.toLowerCase()).not.toMatch(/password|wallet|seed phrase/);
  });

  const ordinary: string[][] = [
    // IR-M1-9zd-1 L-1: ordinary text whose letters happen to number 24 once spaces are removed.
    ['contacts', 'rename', 'c1', 'Northwind Legal Department'],
    ['contacts', 'rename', 'c1', 'Sales Team Acme Corporation'],
    ['policy', 'allow-folder', 'ProjectAlphaQuarterlyRpt'],
    // Six four-letter words in a row, as six words and as one quoted name.
    ['contacts', 'rename', 'c1', 'Team', 'Plan', 'Work', 'Note', 'Acme', 'Sale'],
    ['contacts', 'rename', 'c1', 'Team Plan Work Note Acme Sale'],
    ['contacts', 'rename', 'c1', 'team', 'plan', 'work', 'note', 'acme', 'sale'],
    ['contacts', 'rename', 'c1', 'team plan work note acme sale'],
    ['approve', 'apr_AAAAAAAAAAAAAAAAAAAAAA'],
    ['approve', '--agent', 'abcdefghijklmnopqrstuvwx'],
    ['status', '--agent=work-agent-2'],
    ['policy', 'allow-folder', '~/Documents/Reports'],
    ['policy', 'allow-folder', '/Users/ana/QF7K2MZDH4XTWR6JPL3NAEBC'],
    ['contacts', 'rename', '0x1234567890abcdef1234567890abcdef12345678', 'Ana Smith'],
    ['contacts', 'rename', 'c1', 'Ana'],
    ['accept', 'https://agentlink.dev/i/QF7K2MZDH4XTWR6JPL3NAEBC'],
    ['verify', 'proof.json'],
    // 23 and 25 characters: not the shape of a code.
    ['approve', CODE.slice(1)],
    ['approve', `${CODE}A`],
    // Five groups of four, and characters outside the alphabet (9 is not base32).
    ['approve', ...GROUPS.slice(0, 5)],
    ['approve', CODE.replace('Q', '9')],
    ['doctor'],
  ];
  for (const argv of ordinary) {
    it(`lets \`${argv.join(' ')}\` through to its command`, async () => {
      const d = dispatcherRecording();
      await d.run(argv);
      expect(d.err).not.toContain(DISPATCH_TEXT.ownerCodeInCommand);
    });
  }

  it('looksLikeOwnerCode follows the kind 1 reading and never mistakes an agent name', () => {
    expect(looksLikeOwnerCode([CODE])).toBe(true);
    expect(looksLikeOwnerCode([CODE.toLowerCase()])).toBe(false); // a valid local agent name
    expect(looksLikeOwnerCode([GROUPS.join('-').toLowerCase()])).toBe(true);
    expect(looksLikeOwnerCode(['--agent', GROUPS.join(' ')])).toBe(true);
    expect(looksLikeOwnerCode([`${CODE}é`])).toBe(false);
    expect(looksLikeOwnerCode([])).toBe(false);
  });
});

const OWNER: OwnerPublicKeys = {
  ownerEvm: new Uint8Array(20).fill(1),
  ownerNostr: new Uint8Array(32).fill(2),
  ownerEnc: new Uint8Array(32).fill(3),
};

/** Deps whose owner steps record what was printed when the owner code prompt would appear. */
function machine(options: { readonly cardOwner?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const printedAtPrompt: string[][] = [];
  const agent = {
    name: 'default',
    client: {
      agentId: '0x0000000000000000000000000000000000000001',
      identity: {
        get: () =>
          Promise.resolve(
            options.cardOwner === true
              ? {
                  card: {
                    ownerEvm: `0x${'01'.repeat(20)}`,
                    ownerNostr: `0x${'02'.repeat(32)}`,
                    ownerEnc: `0x${'03'.repeat(32)}`,
                  },
                }
              : undefined,
          ),
      },
    },
    close: () => Promise.resolve(),
  } as unknown as OwnerAgent;
  const atPrompt = (): void => {
    printedAtPrompt.push([...out]);
  };
  const deps: OwnerCommandDeps = {
    listAgents: () => Promise.resolve(['default']),
    open: () => Promise.resolve({ status: 'ok', agent }),
    backendOf: () => Promise.resolve('keychain'),
    initOwner: () => {
      atPrompt();
      return Promise.resolve({ fingerprint: '7F3A·19C2' } as never);
    },
    addAgent: () => Promise.reject(new Error('not used')),
    changeOwnerCode: (o: ChangeOwnerCodeOptions) => {
      atPrompt();
      return Promise.resolve({ fingerprint: '7F3A·19C2', owner: o.owner ?? OWNER });
    },
    decide: () => Promise.reject(new Error('not used')),
    signOwnerAction: () => Promise.reject(new Error('not used')),
    ask: () => Promise.resolve(''),
    now: () => 0,
    cardRelays: () => [],
  };
  const dispatch = createDispatcher(ownerCommandHandlers(deps));
  return {
    out,
    err,
    printedAtPrompt,
    run: (argv: string[]) =>
      dispatch(argv, {
        output: createOutput({ log: (l) => out.push(l), error: (l) => err.push(l) }),
        terminal: TTY,
        version: '0.0.0',
      }),
  };
}

describe('the owner code prompt says where the code goes (M1-9zd; 11 §5.5, §6.10)', () => {
  it('owner change-code: the reminder is the last line before the prompt', async () => {
    const m = machine();
    expect(await m.run(['owner', 'change-code'])).toBe(0);
    expect(m.printedAtPrompt).toHaveLength(1);
    expect(m.printedAtPrompt[0]?.at(-1)).toBe(OWNER_TEXT.codeHint);
  });

  it('owner init: says the new code goes only at AgentLink prompts before it is shown', async () => {
    const m = machine();
    expect(await m.run(['owner', 'init'])).toBe(0);
    expect(m.printedAtPrompt[0]?.at(-1)).toBe(OWNER_TEXT.newCodeHint);
  });

  it('the reminders state that the code is not a shell command and not for a chat', () => {
    for (const text of [OWNER_TEXT.codeHint, OWNER_TEXT.newCodeHint, OWNER_TEXT.wrongCode]) {
      expect(text).toMatch(/shell command|not a command/);
      expect(text.toLowerCase()).not.toMatch(/password|wallet|seed phrase/);
    }
    expect(OWNER_TEXT.codeHint).toMatch(/chat/);
    expect(OWNER_TEXT.newCodeHint).toMatch(/chat/);
    expect(OWNER_TEXT.wrongCode.startsWith('Problem  ')).toBe(true);
  });
});

describe('withOwnerPrompts (M1-9zd)', () => {
  function recordingDeps() {
    const calls: string[] = [];
    const out: string[] = [];
    const seen = (name: string) => {
      calls.push(`${name}@${String(out.length)}`);
    };
    const deps: OwnerCommandDeps = {
      listAgents: () => Promise.resolve([]),
      open: () => Promise.resolve({ status: 'needs_setup', message: 'm' }),
      backendOf: () => Promise.resolve(undefined),
      initOwner: () => {
        seen('initOwner');
        return Promise.resolve('init' as never);
      },
      addAgent: () => {
        seen('addAgent');
        return Promise.resolve('add' as never);
      },
      changeOwnerCode: () => {
        seen('changeOwnerCode');
        return Promise.resolve('change' as never);
      },
      decide: () => {
        seen('decide');
        return Promise.resolve('decide' as never);
      },
      signOwnerAction: () => {
        seen('signOwnerAction');
        return Promise.resolve('sign' as never);
      },
      ask: (q) => Promise.resolve(q),
      now: () => 7,
      cardRelays: () => ['r'],
    };
    const output = createOutput({ log: (l) => out.push(l), error: (l) => out.push(l) });
    return { deps, calls, out, wrapped: withOwnerPrompts(deps, output) };
  }

  it('prints the reminder right before every step that prompts, and passes results through', async () => {
    const r = recordingDeps();
    const owner = OWNER;
    expect(await r.wrapped.addAgent({} as never)).toBe('add');
    expect(await r.wrapped.changeOwnerCode({} as never)).toBe('change');
    expect(await r.wrapped.decide({} as never, [])).toBe('decide');
    expect(await r.wrapped.signOwnerAction(owner, {} as never)).toBe('sign');
    expect(await r.wrapped.initOwner({} as never)).toBe('init');
    expect(r.out).toEqual([
      OWNER_TEXT.codeHint,
      OWNER_TEXT.codeHint,
      OWNER_TEXT.codeHint,
      OWNER_TEXT.codeHint,
      OWNER_TEXT.newCodeHint,
    ]);
    expect(r.calls).toEqual([
      'addAgent@1',
      'changeOwnerCode@2',
      'decide@3',
      'signOwnerAction@4',
      'initOwner@5',
    ]);
  });

  it('prints nothing for owner init when the card already names an owner (node refuses first)', async () => {
    const r = recordingDeps();
    await r.wrapped.initOwner({ cardOwner: OWNER } as never);
    expect(r.out).toEqual([]);
  });

  it('leaves the steps that never prompt for the code untouched', async () => {
    const r = recordingDeps();
    expect(await r.wrapped.ask('q')).toBe('q');
    expect(r.wrapped.now()).toBe(7);
    expect(r.wrapped.cardRelays()).toEqual(['r']);
    expect(r.out).toEqual([]);
  });
});

describe('a wrong owner code (M1-9zd)', () => {
  it('owner change-code: node’s own refusal is kept; a bare presence_rejected gets the reminder', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: OwnerCommandDeps = {
      listAgents: () => Promise.resolve(['default']),
      open: () =>
        Promise.resolve({
          status: 'ok',
          agent: {
            name: 'default',
            client: { identity: { get: () => Promise.resolve(undefined) } },
            close: () => Promise.resolve(),
          } as unknown as OwnerAgent,
        }),
      backendOf: () => Promise.resolve('keychain'),
      initOwner: () => Promise.reject(new Error('not used')),
      addAgent: () => Promise.reject(new Error('not used')),
      changeOwnerCode: () => Promise.reject(new KeyStoreError('presence_rejected', 'presence')),
      decide: () => Promise.reject(new Error('not used')),
      signOwnerAction: () => Promise.reject(new Error('not used')),
      ask: () => Promise.resolve(''),
      now: () => 0,
      cardRelays: () => [],
    };
    const dispatch = createDispatcher(ownerCommandHandlers(deps));
    const code = await dispatch(['owner', 'change-code'], {
      output: createOutput({ log: (l) => out.push(l), error: (l) => err.push(l) }),
      terminal: TTY,
      version: '0.0.0',
    });
    expect(code).toBe(1);
    expect(err).toEqual([OWNER_TEXT.wrongCode]);
    expect(err.join('\n')).not.toContain('presence');
  });
});
