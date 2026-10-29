// U3-invite (S2; 06 §8, 08 §4 "One step from an invite link"; I-2, I-5, I-7): `agentlink join`.
//
// - Exactly one argument, one surrounding pair of `'` removed, the 08 §4 pattern with the shipped
//   host, then Accept step 1, before anything else. Every bad form (bare payload, another host or
//   scheme, an extra argument or option, whitespace, percent-encoding, a second `#`, shell
//   metacharacters, confusables) gets the one fixed line and exit code 2, printing nothing from it.
// - Windows: cmd.exe passes `'…'` through (one pair removed); PowerShell removes them itself.
// - A running app host: one loopback handoff; `invite_waiting` prints the fixed line.
// - Otherwise in the owner's terminal: the app starts as `ui` with the invite held in memory; run by
//   an AI, the fixed line. No network request before the app opens, the invite never printed.
import { describe, expect, it, vi } from 'vitest';
import { CoreError } from '@4thtech-io/core';
import {
  createDispatcher,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  type CommandContext,
} from '../dispatch.js';
import type { AppHostRecord, HandoffOutcome } from '../runtime/app-host-record.js';
import type { TerminalContext } from '../runtime/guards.js';
import { JOIN_TEXT, joinLinkOf, joinStep, type JoinDeps } from './join.js';
import type { UiDeps } from './ui.js';

const TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };
const AI: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: { CLAUDECODE: '1' } };
const PIPE: TerminalContext = { stdinIsTTY: false, stdoutIsTTY: false, env: {} };
const PAYLOAD = `jZBNb9swDIb_isGz${'Ab_-9'.repeat(40)}`;
const LINK = `https://agentlink.4thtech.io/i#${PAYLOAD}`;
const RECORD: AppHostRecord = { pid: 4242, port: 51234, handoffToken: 'T'.repeat(43) };

/** Every argument form 08 §4 refuses. */
const BAD_ARGS: readonly (readonly string[])[] = [
  [],
  [PAYLOAD],
  [`'${PAYLOAD}'`],
  [LINK, '--agent'],
  [LINK, 'extra'],
  ['--agent', 'work', LINK],
  [`--invite=${LINK}`],
  [`http://agentlink.4thtech.io/i#${PAYLOAD}`],
  [`https://agentlink.4thtech.io.evil.example/i#${PAYLOAD}`],
  [`https://agentIink.4thtech.io/i#${PAYLOAD}`],
  [`https://agentlink.4thtech.io:443/i#${PAYLOAD}`],
  [`https://agentlink.4thtech.io/j#${PAYLOAD}`],
  [`https://evil.example/i#${PAYLOAD}`],
  [`file:///i#${PAYLOAD}`],
  [` ${LINK}`],
  [`${LINK} `],
  [`${LINK}\n`],
  [`${LINK}\r\n`],
  [`${LINK}\t`],
  [`${LINK}%41`],
  [`https://agentlink.4thtech.io/i#%6A${PAYLOAD}`],
  [`${LINK}#second`],
  [`${LINK}'`],
  [`'${LINK}`],
  [`''${LINK}''`],
  [`"${LINK}"`],
  [`${LINK};rm -rf ~`],
  [`${LINK}$(id)`],
  [`${LINK}\`id\``],
  [`${LINK}&calc`],
  [`${LINK}|sh`],
  [`${LINK}^`],
  [`${LINK}!`],
  [`${LINK}\\`],
  [`https://agentlink.4thtech.io/i#а${PAYLOAD}`], // Cyrillic а
  [`https://agentlink.4thtech.io/i#${'A'.repeat(21_847)}`],
  ['https://agentlink.4thtech.io/i#'],
  [''],
];

function harness(
  terminal: TerminalContext = TTY,
  script: {
    readonly check?: 'ok' | 'expired' | 'invalid';
    readonly record?: AppHostRecord;
    readonly alive?: boolean;
    readonly handoff?: HandoffOutcome;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const calls = {
    checked: [] as string[],
    records: 0,
    handoffs: [] as { record: AppHostRecord; link: string }[],
    starts: [] as { name: string | undefined; invite: string | undefined }[],
    opened: 0,
  };
  let stop: (() => void) | undefined;
  const ui: UiDeps = {
    start: (name, options) => {
      calls.starts.push({ name, invite: options?.invite });
      return Promise.resolve({
        page: 'first-run',
        open: () => {
          calls.opened += 1;
          setTimeout(() => stop?.(), 5);
          return Promise.resolve(true);
        },
        close: () => Promise.resolve(),
      });
    },
    waitMs: 1_000,
    interrupt: (s) => {
      stop = s;
      return () => undefined;
    },
  };
  const deps: JoinDeps = {
    check: (link) => {
      calls.checked.push(link);
      if (script.check === 'expired') return Promise.reject(new CoreError('invite_expired', 'x'));
      if (script.check === 'invalid') return Promise.reject(new CoreError('invite_invalid', 'x'));
      return Promise.resolve({});
    },
    now: () => 1_790_000_000,
    readRecord: () => {
      calls.records += 1;
      return Promise.resolve(script.record);
    },
    alive: () => script.alive ?? true,
    handoff: (record, link) => {
      calls.handoffs.push({ record, link });
      return Promise.resolve(script.handoff ?? 'waiting');
    },
    ui,
  };
  const context = (positionals: readonly string[]): CommandContext => ({
    command: 'join',
    parsed: { values: {}, positionals, agent: undefined },
    output: { print: (t) => out.push(t), printError: (t) => err.push(t) },
    terminal,
  });
  return { out, err, calls, deps, run: (args: readonly string[]) => joinStep(context(args), deps) };
}

describe('joinLinkOf: the 08 §4 argument rule', () => {
  it('takes the canonical link, bare (sh, zsh, PowerShell) or in one pair of single quotes (cmd.exe)', () => {
    expect(joinLinkOf([LINK])).toBe(LINK);
    expect(joinLinkOf([`'${LINK}'`])).toBe(LINK);
    expect(joinLinkOf([`https://agentlink.4thtech.io/i#${'A'.repeat(21_846)}`])).toBeDefined();
  });

  it('refuses every other form', () => {
    for (const args of BAD_ARGS) expect(joinLinkOf(args), JSON.stringify(args)).toBeUndefined();
  });
});

describe('agentlink join: refusals print one fixed line and exit 2 (I-5)', () => {
  it('refuses each bad form before Accept step 1, the record or the app, printing nothing of it', async () => {
    for (const args of BAD_ARGS) {
      const h = harness();
      expect(await h.run(args), JSON.stringify(args)).toBe(EXIT_USAGE);
      expect(h.err).toEqual([JOIN_TEXT.refused]);
      expect(h.out).toEqual([]);
      expect(h.calls.checked).toEqual([]);
      expect(h.calls.records).toBe(0);
      expect(h.calls.starts).toEqual([]);
    }
  });

  it('a link that fails Accept step 1 is refused the same way; an expired one says so', async () => {
    const bad = harness(TTY, { check: 'invalid' });
    expect(await bad.run([LINK])).toBe(EXIT_USAGE);
    expect(bad.err).toEqual([JOIN_TEXT.refused]);
    expect(bad.calls.records).toBe(0);
    const expired = harness(TTY, { check: 'expired' });
    expect(await expired.run([LINK])).toBe(EXIT_USAGE);
    expect(expired.err).toEqual([JOIN_TEXT.expired]);
    expect(expired.calls.starts).toEqual([]);
  });

  it('the fixed lines are the b11 §33.3 / 08 §4 wording and hold no placeholder', () => {
    expect(JOIN_TEXT.refused).toBe(
      "This isn't a complete AgentLink invite. Open the link again and copy the command.",
    );
    expect(JOIN_TEXT.waiting).toBe(
      'Finish or close the invite already open in AgentLink, then run the command again.',
    );
    for (const text of Object.values(JOIN_TEXT)) {
      expect(text).not.toMatch(/[{}]|wallet|\bkey\b|address|transaction|relay|harness/i);
    }
  });
});

describe('agentlink join: a running app host takes it with one loopback handoff', () => {
  it('hands it over and exits 0; no app is started', async () => {
    const h = harness(TTY, { record: RECORD });
    expect(await h.run([`'${LINK}'`])).toBe(EXIT_OK);
    expect(h.calls.handoffs).toEqual([{ record: RECORD, link: LINK }]);
    expect(h.calls.starts).toEqual([]);
    expect(h.out).toEqual([JOIN_TEXT.handedOff]);
  });

  it('invite_waiting prints the fixed line; nothing else is started', async () => {
    const h = harness(TTY, { record: RECORD, handoff: 'invite_waiting' });
    expect(await h.run([LINK])).toBe(EXIT_FAILED);
    expect(h.err).toEqual([JOIN_TEXT.waiting]);
    expect(h.calls.starts).toEqual([]);
  });

  it('a dead pid or a failed handoff starts its own host instead', async () => {
    const dead = harness(TTY, { record: RECORD, alive: false });
    expect(await dead.run([LINK])).toBe(EXIT_OK);
    expect(dead.calls.handoffs).toEqual([]);
    expect(dead.calls.starts).toEqual([{ name: undefined, invite: LINK }]);
    const failed = harness(TTY, { record: RECORD, handoff: 'failed' });
    expect(await failed.run([LINK])).toBe(EXIT_OK);
    expect(failed.calls.starts).toEqual([{ name: undefined, invite: LINK }]);
  });

  it('works when an AI runs it too: the host opens the screen; the AI never gets a link', async () => {
    const h = harness(AI, { record: RECORD });
    expect(await h.run([LINK])).toBe(EXIT_OK);
    expect(h.calls.handoffs).toHaveLength(1);
    expect(h.out.join(' ')).not.toContain(PAYLOAD.slice(0, 20));
  });
});

describe('agentlink join: no host running', () => {
  it('in the owner terminal: starts the app as `ui` with the invite in memory, opens it, prints the fixed line', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const h = harness(TTY);
      expect(await h.run([LINK])).toBe(EXIT_OK);
      expect(h.calls.starts).toEqual([{ name: undefined, invite: LINK }]);
      expect(h.calls.opened).toBe(1);
      expect(h.out).toEqual([JOIN_TEXT.opened]);
      expect(h.err).toEqual([]);
      // No network request of its own (the only request `join` ever makes is the handoff).
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(h.calls.handoffs).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('run by an AI or with no terminal: the fixed line, no app, nothing of the invite', async () => {
    for (const terminal of [AI, PIPE]) {
      const h = harness(terminal);
      expect(await h.run([LINK])).toBe(EXIT_FAILED);
      expect(h.err).toEqual([JOIN_TEXT.agentRun]);
      expect(h.calls.starts).toEqual([]);
      expect([...h.out, ...h.err].join(' ')).not.toContain(PAYLOAD.slice(0, 20));
    }
  });
});

describe('the dispatcher hands `join` its raw arguments (no option parsing)', () => {
  it('options and extra arguments reach the handler, which refuses them with the join line', async () => {
    const seen: (readonly string[])[] = [];
    const dispatch = createDispatcher({
      join: (context) => {
        seen.push(context.parsed.positionals);
        return Promise.resolve(EXIT_OK);
      },
    });
    const io = {
      output: { print: () => undefined, printError: () => undefined },
      terminal: TTY,
      version: '0',
    };
    await dispatch(['join', LINK], io);
    await dispatch(['join', '--agent', 'x', LINK], io);
    await dispatch(['join', '--help'], io);
    expect(seen).toEqual([[LINK], ['--agent', 'x', LINK], ['--help']]);
  });

  it('the real handler: a bad form through the dispatcher is the fixed line and exit 2', async () => {
    const err: string[] = [];
    const h = harness();
    const dispatch = createDispatcher({
      join: (context) => joinStep(context, h.deps),
    });
    const code = await dispatch(['join', '--agent', 'work', `${LINK};id`], {
      output: { print: () => undefined, printError: (t) => err.push(t) },
      terminal: TTY,
      version: '0',
    });
    expect(code).toBe(EXIT_USAGE);
    expect(err).toEqual([JOIN_TEXT.refused]);
  });
});
