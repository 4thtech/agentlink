// The command dispatcher (M1-9k; 06 §8): the M1a commands, the guards, and fixed text only.
import { encodeBase64url, randomBytes } from '@4thtech-io/crypto';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_NAMES,
  DISPATCH_TEXT,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  createDispatcher,
  helpText,
  type CommandContext,
  type DispatchIO,
} from './dispatch.js';
import { RUNTIME_MESSAGES } from './runtime/errors.js';
import type { TerminalContext } from './runtime/guards.js';

const newId = (): string => `apr_${encodeBase64url(randomBytes(16))}`;

const OWNER_TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };
/** What an `agentlink mcp` process sees: stdin and stdout are the MCP pipe. */
const MCP_PIPE: TerminalContext = { stdinIsTTY: false, stdoutIsTTY: false, env: {} };

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

/** A handler that records that it ran. */
function recorder() {
  const calls: CommandContext[] = [];
  const handler = (context: CommandContext) => {
    calls.push(context);
    return Promise.resolve(EXIT_OK);
  };
  return { calls, handler };
}

describe('--help (06 §8)', () => {
  it('lists exactly the M1a commands', () => {
    expect([...COMMAND_NAMES]).toEqual([
      'init',
      'owner',
      'status',
      'invite',
      'accept',
      'contacts',
      'requests',
      'policy',
      'credits',
      'verify',
      'approve',
      'deny',
      'cancel',
      'doctor',
      'mcp',
    ]);
    const help = helpText();
    for (const usage of [
      'agentlink init [--agent <name>]',
      'agentlink owner init',
      'agentlink owner add-agent --agent <name>',
      'agentlink owner change-code',
      'agentlink init [--agent <name>] [--harness <id|none>] [--config <path>]',
      'agentlink status [--brief]',
      'agentlink invite',
      'agentlink accept <url>',
      'agentlink contacts',
      // M1-9za.
      'agentlink contacts rename <contactId> <name> [--agent <name>]',
      'agentlink contacts remove <contactId> [--agent <name>]',
      'agentlink requests [accept | ignore | block <requestId>]',
      // M1-9m.
      'agentlink policy show [--agent <name>]',
      'agentlink policy allow-folder <path> [--agent <name>]',
      'agentlink policy remove-folder <path> [--agent <name>]',
      // M1-9m-b (D-100).
      'agentlink policy recover [--agent <name>]',
      // M1-36b-2-c.
      'agentlink policy set-up-send-folder [--agent <name>]',
      // M1-9h.
      'agentlink credits [--topup] [--agent <name>]',
      'agentlink verify <proof.json> [--agent <name>]',
      'agentlink approve <approvalId> [--agent <name>]',
      'agentlink approve [--agent <name>]',
      'agentlink deny <approvalId> [--agent <name>]',
      'agentlink cancel <approvalId> [--agent <name>]',
      'agentlink doctor',
      'agentlink mcp [--advanced]',
    ]) {
      expect(help).toContain(usage);
    }
    // Later cards, and the file KeyStore (M1-8f, off the M1a path): not listed.
    for (const absent of [
      'agentlink ui',
      'storage',
      'backup',
      'relays',
      '--keystore',
      'keystore passphrase',
    ]) {
      expect(help).not.toContain(absent);
    }
    const commandLines = help.split('\n').filter((line) => line.startsWith('  agentlink '));
    // M1-9m: `policy` show, allow-folder, remove-folder; M1-9m-b: recover; M1-9h: credits and
    // verify; M1-29: init --hook. M1-36c: `contacts --verify` and `policy set` are not listed.
    expect(commandLines).toHaveLength(25);
  });

  it('prints help for no arguments, --help, -h and help', async () => {
    const dispatch = createDispatcher();
    for (const argv of [[], ['--help'], ['-h'], ['help']]) {
      const t = io();
      expect(await dispatch(argv, t.value)).toBe(EXIT_OK);
      expect(t.out).toEqual([helpText()]);
    }
  });

  it('prints the version', async () => {
    const t = io();
    expect(await createDispatcher()(['--version'], t.value)).toBe(EXIT_OK);
    expect(t.out).toEqual(['0.0.0']);
  });
});

describe('dispatching', () => {
  it('every registered command without a handler answers "not available yet"', async () => {
    const dispatch = createDispatcher();
    for (const name of COMMAND_NAMES) {
      const t = io();
      const argv = ['approve', 'deny', 'cancel'].includes(name) ? [name, newId()] : [name];
      expect(await dispatch(argv, t.value)).toBe(EXIT_FAILED);
      expect(t.err).toEqual([DISPATCH_TEXT.notAvailable]);
    }
  });

  it('runs a registered handler with the parsed arguments', async () => {
    const r = recorder();
    const dispatch = createDispatcher({ status: r.handler });
    const t = io();
    expect(await dispatch(['status', '--brief', '--agent', 'work'], t.value)).toBe(EXIT_OK);
    expect(r.calls[0]?.parsed.values['brief']).toBe(true);
    expect(r.calls[0]?.parsed.agent).toBe('work');
  });

  it('never echoes an unknown command or a bad argument', async () => {
    const canary = '\u001b]8;;https://evil.example/\u0007x\u001b[2J';
    const dispatch = createDispatcher();
    const a = io();
    expect(await dispatch([canary], a.value)).toBe(EXIT_USAGE);
    expect(a.err).toEqual([DISPATCH_TEXT.unknownCommand]);
    const b = io();
    expect(await dispatch(['status', `--${canary}`], b.value)).toBe(EXIT_USAGE);
    expect(b.err).toEqual([DISPATCH_TEXT.badArguments]);
    for (const line of [...a.err, ...b.err, ...a.out, ...b.out]) {
      expect(line).not.toContain('evil');
      expect(line).not.toContain('\u001b');
    }
  });

  it('refuses an --agent value that fails the agent-name rule, without echoing it', async () => {
    const r = recorder();
    const dispatch = createDispatcher({ status: r.handler });
    for (const bad of ['-x', 'Work', 'a b', 'work\n', '$(id)']) {
      const t = io();
      expect(await dispatch(['status', `--agent=${bad}`], t.value)).toBe(EXIT_USAGE);
      expect(t.err).toEqual([RUNTIME_MESSAGES.agent_name_invalid]);
    }
    expect(r.calls).toHaveLength(0);
  });

  it('refuses a malformed approval ID before the handler', async () => {
    const r = recorder();
    const dispatch = createDispatcher({ approve: r.handler });
    const t = io();
    expect(await dispatch(['approve', 'apr_$(id)'], t.value)).toBe(EXIT_USAGE);
    expect(t.err).toEqual([RUNTIME_MESSAGES.approval_id_invalid]);
    expect(r.calls).toHaveLength(0);
  });

  it('a handler error prints fixed text, never the error message', async () => {
    const dispatch = createDispatcher({
      status: () => Promise.reject(new Error('inbound \u001b[2J SECRET-CANARY')),
    });
    const t = io();
    expect(await dispatch(['status'], t.value)).toBe(EXIT_FAILED);
    expect(t.err).toEqual([DISPATCH_TEXT.failed]);
  });
});

describe('an MCP-side process cannot approve (04 §2.5, I-4)', () => {
  const ownerCommands: string[][] = [
    ['approve', newId()],
    ['approve'],
    ['deny', newId()],
    ['cancel', newId()],
    ['owner', 'init'],
    ['contacts', 'remove', 'c1'],
    ['policy', 'show'],
  ];

  it.each(ownerCommands)(
    '`%s …` on the MCP pipe is refused before its handler',
    async (...argv) => {
      const r = recorder();
      const dispatch = createDispatcher({
        approve: r.handler,
        deny: r.handler,
        cancel: r.handler,
        owner: r.handler,
        policy: r.handler,
        contacts: r.handler,
      });
      const t = io(MCP_PIPE);
      expect(await dispatch(argv, t.value)).toBe(EXIT_FAILED);
      expect(t.err).toEqual([DISPATCH_TEXT.notInteractive]);
      expect(r.calls).toHaveLength(0);
    },
  );

  it('with a harness marker set, even on a TTY, owner commands are refused', async () => {
    const r = recorder();
    const dispatch = createDispatcher({ approve: r.handler, requests: r.handler });
    for (const env of [{ CLAUDECODE: '1' }, { CODEX_SANDBOX: 'seatbelt' }, { GEMINI_CLI: '1' }]) {
      for (const argv of [['approve', newId()], ['requests']]) {
        const t = io({ ...OWNER_TTY, env });
        expect(await dispatch(argv, t.value)).toBe(EXIT_FAILED);
        expect(t.err).toEqual([DISPATCH_TEXT.harnessDetected]);
      }
    }
    expect(r.calls).toHaveLength(0);
  });

  it('stdin piped (an agent feeding the prompt) is refused even with stdout on a TTY', async () => {
    const r = recorder();
    const t = io({ stdinIsTTY: false, stdoutIsTTY: true, env: {} });
    expect(await createDispatcher({ approve: r.handler })(['approve', newId()], t.value)).toBe(
      EXIT_FAILED,
    );
    expect(r.calls).toHaveLength(0);
  });

  it('the owner at an interactive terminal reaches the handler', async () => {
    const r = recorder();
    const id = newId();
    const t = io(OWNER_TTY);
    expect(await createDispatcher({ approve: r.handler })(['approve', id], t.value)).toBe(EXIT_OK);
    expect(r.calls[0]?.parsed.positionals).toEqual([id]);
  });

  it('a shell the agent controls with a faked TTY and cleared markers passes the guard: it is not the boundary (D-67)', async () => {
    // IR-M1-9k-1 F04: e.g. `env -u CLAUDECODE script -q /dev/null agentlink approve <id>`. Nothing may
    // rely on the guard; the owner-presence step in the handler (M1-9b) is what stops the agent.
    const r = recorder();
    const faked = io({ stdinIsTTY: true, stdoutIsTTY: true, env: { PATH: '/usr/bin' } });
    expect(await createDispatcher({ approve: r.handler })(['approve', newId()], faked.value)).toBe(
      EXIT_OK,
    );
    expect(r.calls).toHaveLength(1);
  });

  it('plain `contacts` and `mcp` are not owner commands', async () => {
    const r = recorder();
    const dispatch = createDispatcher({ contacts: r.handler, mcp: r.handler });
    expect(await dispatch(['contacts'], io(MCP_PIPE).value)).toBe(EXIT_OK);
    expect(await dispatch(['mcp'], io(MCP_PIPE).value)).toBe(EXIT_OK);
    expect(r.calls).toHaveLength(2);
  });

  it('M1-36h: `mcp --advanced` is parsed as a flag (the Advanced tool surface)', async () => {
    const r = recorder();
    const dispatch = createDispatcher({ mcp: r.handler });
    expect(await dispatch(['mcp', '--advanced'], io(MCP_PIPE).value)).toBe(EXIT_OK);
    expect(await dispatch(['mcp'], io(MCP_PIPE).value)).toBe(EXIT_OK);
    expect(r.calls.map((c) => c.parsed.values['advanced'])).toEqual([true, undefined]);
  });
});
