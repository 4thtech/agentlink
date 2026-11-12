// WP-D9 (plan Decision 4; 08 §4 "One step from an invite link"): the shell accepts only
// `agentlink://join#<payload>`, rebuilds the canonical `https://agentlink.4thtech.io/i#<payload>`,
// checks it with the same patterns as `agentlink join` and forwards it over the pipe. Everything
// else (the 08 §4 crafted list, other schemes, switch injection, several links) is ignored, and
// nothing from the argument is ever shown or logged.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEEP_LINK_JOIN_PREFIX,
  INVITE_LONG_PATTERN,
  INVITE_RESULT_COPY,
  INVITE_SHORT_PATTERN,
  inviteResultCopy,
  toInviteLink,
} from '../../src/main/deep-link.js';
import { realProcess, runShell, type ShellProcess } from '../../src/main/main.js';
import { INVITE_OUTCOMES, isCanonicalInviteLink } from '../../src/shared/protocol.js';
import { FakeEvent, FakeTimers, fakeElectron, fakeSpawn } from './fakes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../../..');

const SHORT = `2.${'A'.repeat(42)}w`;
const LONG = 'jVPLbtswEPyXPdOGJMt66JZDgV56aNqgQOGDnlsnamACSqJjh_iC';
const PREFIX = 'https://agentlink.4thtech.io/i#';

describe('toInviteLink: valid links', () => {
  it('rebuilds the canonical link from agentlink://join#<long payload>', () => {
    expect(DEEP_LINK_JOIN_PREFIX).toBe('agentlink://join#');
    expect(toInviteLink(`agentlink://join#${LONG}`)).toBe(`${PREFIX}${LONG}`);
  });

  it('rebuilds the canonical link from agentlink://join#<short payload>', () => {
    expect(toInviteLink(`agentlink://join#${SHORT}`)).toBe(`${PREFIX}${SHORT}`);
  });

  it('accepts the longest payload and refuses one character more', () => {
    const max = 'A'.repeat(21_846);
    expect(toInviteLink(`agentlink://join#${max}`)).toBe(`${PREFIX}${max}`);
    expect(toInviteLink(`agentlink://join#${max}A`)).toBeNull();
  });

  it('only ever returns a link the pipe accepts', () => {
    for (const payload of [LONG, SHORT, 'A', '-_']) {
      const link = toInviteLink(`agentlink://join#${payload}`);
      expect(isCanonicalInviteLink(link)).toBe(true);
    }
  });
});

describe('toInviteLink: the 08 §4 crafted list is ignored', () => {
  const crafted = [
    "'",
    '"',
    ' ',
    '\n',
    '\r',
    '\t',
    ';',
    '$(id)',
    '`id`',
    '%41',
    '&',
    '|',
    '^',
    '!',
    '\\',
    '#',
    '<',
    '>',
    '(',
    ')',
    '\u0000',
    ' ',
    '​',
    // Confusables: Cyrillic а, full-width A.
    'а',
    'Ａ',
  ];
  for (const bad of crafted) {
    it(`ignores ${JSON.stringify(bad)} around a good payload`, () => {
      expect(toInviteLink(`agentlink://join#${bad}${LONG}`)).toBeNull();
      expect(toInviteLink(`agentlink://join#${LONG}${bad}`)).toBeNull();
      expect(toInviteLink(`agentlink://join#${LONG.slice(0, 5)}${bad}${LONG.slice(5)}`)).toBeNull();
    });
  }

  it('ignores an empty payload, a second #, percent-encoding and a bad short link', () => {
    expect(toInviteLink('agentlink://join#')).toBeNull();
    expect(toInviteLink(`agentlink://join#${LONG}#${LONG}`)).toBeNull();
    expect(toInviteLink(`agentlink://join#${encodeURIComponent('A#B')}`)).toBeNull();
    expect(toInviteLink(`agentlink://join#2.${'A'.repeat(42)}B`)).toBeNull(); // trailing bits
    expect(toInviteLink(`agentlink://join#2.${'A'.repeat(43)}A`)).toBeNull(); // too long
    expect(toInviteLink(`agentlink://join#2.${'A'.repeat(41)}A`)).toBeNull(); // too short
  });

  it('ignores a full canonical link or a look-alike host inside the fragment', () => {
    expect(toInviteLink(`agentlink://join#${PREFIX}${LONG}`)).toBeNull();
    expect(toInviteLink(`agentlink://join#agentlink.4thtech.io/i#${LONG}`)).toBeNull();
    expect(
      toInviteLink(`agentlink://join#https://agentlink.4thtech.io.evil.example/i#${LONG}`),
    ).toBeNull();
  });

  it('ignores any other host, path, query, user info or spelling of the prefix', () => {
    for (const prefix of [
      'agentlink://i#',
      'agentlink://join/#',
      'agentlink://join?#',
      'agentlink://join?x=1#',
      'agentlink://join.evil.example#',
      'agentlink://user@join#',
      'agentlink://join:1#',
      'agentlink:///join#',
      'agentlink:join#',
      'agentlink:/join#',
      'AGENTLINK://join#',
      'Agentlink://join#',
      'agentlink://JOIN#',
      'agentlink://Join#',
      ' agentlink://join#',
      'agentlink:// join#',
      'agentlink://jo%69n#',
    ]) {
      expect(toInviteLink(`${prefix}${LONG}`), prefix).toBeNull();
    }
  });
});

describe('toInviteLink: other schemes and non-strings are ignored', () => {
  it('ignores other schemes', () => {
    for (const link of [
      `${PREFIX}${LONG}`,
      `http://agentlink.4thtech.io/i#${LONG}`,
      `file:///etc/passwd#${LONG}`,
      `javascript:alert(1)//#${LONG}`,
      `data:text/html,x#${LONG}`,
      `agentlinkx://join#${LONG}`,
      `x-agentlink://join#${LONG}`,
    ]) {
      expect(toInviteLink(link), link).toBeNull();
    }
  });

  it('ignores anything that is not a string', () => {
    for (const value of [undefined, null, 1, true, {}, [`agentlink://join#${LONG}`], Symbol('x')]) {
      expect(toInviteLink(value)).toBeNull();
    }
  });
});

describe('toInviteLink: switch injection and several links are ignored', () => {
  it('ignores agentlink://x --remote-debugging-port=1 and every switch appended to a link', () => {
    expect(toInviteLink('agentlink://x --remote-debugging-port=1')).toBeNull();
    for (const tail of [
      ' --remote-debugging-port=1',
      '\t--inspect',
      '\n--js-flags=--expose-gc',
      '" --proxy-server=evil.example:1 "',
      ' -- agentlink://join#AAAA',
      '&--disable-web-security',
    ]) {
      expect(toInviteLink(`agentlink://join#${LONG}${tail}`), tail).toBeNull();
    }
  });

  it('ignores several links in one argument', () => {
    expect(toInviteLink(`agentlink://join#${LONG} agentlink://join#${SHORT}`)).toBeNull();
    expect(toInviteLink(`agentlink://join#${LONG}agentlink://join#${SHORT}`)).toBeNull();
    expect(toInviteLink(`agentlink://join#${LONG},agentlink://join#${SHORT}`)).toBeNull();
  });
});

describe('the same patterns as agentlink join and the invite page (08 §4)', () => {
  const regexSource = (file: string, name: string): string => {
    const text = readFileSync(join(REPO, file), 'utf8');
    const match = new RegExp(`const ${name} = /(.+)/;`).exec(text);
    if (match === null) throw new Error(`${name} not found in ${file}`);
    return match[1] as string;
  };

  it('equals the CANONICAL and SHORT regexes of apps/cli/src/commands/join.ts', () => {
    expect(INVITE_LONG_PATTERN.source).toBe(
      regexSource('apps/cli/src/commands/join.ts', 'CANONICAL'),
    );
    expect(INVITE_SHORT_PATTERN.source).toBe(regexSource('apps/cli/src/commands/join.ts', 'SHORT'));
    expect(INVITE_LONG_PATTERN.flags).toBe('');
    expect(INVITE_SHORT_PATTERN.flags).toBe('');
  });

  it('equals the invite page patterns (apps/invite/src/prompt.ts)', () => {
    expect(INVITE_LONG_PATTERN.source).toBe(
      regexSource('apps/invite/src/prompt.ts', 'CANONICAL_LINK'),
    );
    expect(INVITE_SHORT_PATTERN.source).toBe(
      regexSource('apps/invite/src/prompt.ts', 'SHORT_LINK'),
    );
  });
});

describe('invite-result copy (fixed text, 11 §5)', () => {
  it('has a fixed text for every outcome except waiting (the join page opens)', () => {
    for (const outcome of INVITE_OUTCOMES) {
      const copy = inviteResultCopy(outcome);
      if (outcome === 'waiting') expect(copy).toBeNull();
      else {
        expect(typeof copy).toBe('string');
        expect(copy).not.toMatch(/[{}]/);
        expect(copy).not.toMatch(/\b(wallet|gas|seed phrase|transaction|key)s?\b/i);
      }
    }
    expect(Object.isFrozen(INVITE_RESULT_COPY)).toBe(true);
    expect(inviteResultCopy('nope' as never)).toBeNull();
  });
});

// The shell wired with the real handler (main.ts runShell + realProcess).
const EXE = '/Applications/AgentLink.app/Contents/MacOS/AgentLink';

function setup(args: string[]) {
  const electron = fakeElectron();
  const { spawn, children } = fakeSpawn();
  const proc: ShellProcess = {
    argv: [EXE, ...args],
    execArgv: [],
    env: { HOME: '/Users/x', PATH: '/usr/bin' },
    platform: 'darwin',
    execPath: EXE,
    resourcesPath: '/Applications/AgentLink.app/Contents/Resources',
    homeDir: '/Users/x',
    tmpDir: '/var/folders/ab/T',
    writable: () => true,
    exists: () => true,
    spawn,
    timers: new FakeTimers(),
    preview: null,
    toInviteLink,
  };
  return { electron, children, proc };
}

const inviteLine = (payload: string): string =>
  `${JSON.stringify({ v: 1, type: 'invite', link: `${PREFIX}${payload}` })}\n`;

describe('the shell with the real handler', () => {
  it('realProcess wires the WP-D9 handler', () => {
    expect(realProcess().toInviteLink).toBe(toInviteLink);
  });

  it('argv after -- (Windows/Linux): a valid link reaches the core as the canonical link', async () => {
    const { electron, children, proc } = setup(['--', `agentlink://join#${SHORT}`]);
    expect(await runShell(electron, proc)).toBe('running');
    expect(children[0]?.stream.written).toEqual([inviteLine(SHORT)]);
  });

  it('argv after --: switch injection in one argument is ignored, never on the pipe', async () => {
    const { electron, children, proc } = setup(['--', 'agentlink://x --remote-debugging-port=1']);
    expect(await runShell(electron, proc)).toBe('running');
    expect(children[0]?.stream.written).toEqual([]);
  });

  it('argv: a split switch injection or several links refuse the launch', async () => {
    for (const args of [
      ['--', 'agentlink://x', '--remote-debugging-port=1'],
      ['--', `agentlink://join#${LONG}`, `agentlink://join#${SHORT}`],
      [`agentlink://join#${LONG}`],
    ]) {
      const { electron, children, proc } = setup(args);
      expect(await runShell(electron, proc)).toBe('refused');
      expect(children).toEqual([]);
    }
  });

  it('second instance: only the forwarded link, checked again', async () => {
    const { electron, children, proc } = setup([]);
    await runShell(electron, proc);
    electron.app.emit(
      'second-instance',
      new FakeEvent(),
      [EXE, '--', 'agentlink://join#RAW'],
      '/',
      {
        deepLink: 'agentlink://x --remote-debugging-port=1',
      },
    );
    electron.app.emit('second-instance', new FakeEvent(), [EXE], '/', {
      deepLink: `agentlink://join#${LONG}`,
    });
    const written = children[0]?.stream.written ?? [];
    expect(written.filter((line) => line.includes('"invite"'))).toEqual([inviteLine(LONG)]);
    expect(written.join('')).not.toContain('RAW');
  });

  it('open-url (macOS): valid → forwarded; other schemes and crafted links ignored', async () => {
    const { electron, children, proc } = setup([]);
    await runShell(electron, proc);
    for (const url of [
      `${PREFIX}${LONG}`,
      `agentlink://join#${LONG}'`,
      'agentlink://x --remote-debugging-port=1',
      `agentlink://i#${LONG}`,
    ]) {
      electron.app.emit('open-url', new FakeEvent(), url);
    }
    expect(children[0]?.stream.written).toEqual([]);
    electron.app.emit('open-url', new FakeEvent(), `agentlink://join#${SHORT}`);
    expect(children[0]?.stream.written).toEqual([inviteLine(SHORT)]);
  });

  it('invite-result: a fixed dialog for a refusal, none for waiting, one at a time', async () => {
    const { electron, children, proc } = setup([]);
    await runShell(electron, proc);
    const child = children[0];
    if (child === undefined) throw new Error('no core');
    child.stream.push(`${JSON.stringify({ v: 1, type: 'invite-result', outcome: 'waiting' })}\n`);
    await Promise.resolve();
    expect(electron.dialog.shown).toEqual([]);
    child.stream.push(`${JSON.stringify({ v: 1, type: 'invite-result', outcome: 'expired' })}\n`);
    child.stream.push(`${JSON.stringify({ v: 1, type: 'invite-result', outcome: 'refused' })}\n`);
    await Promise.resolve();
    expect(electron.dialog.shown).toHaveLength(1);
    expect(electron.dialog.shown[0]?.message).toBe(INVITE_RESULT_COPY.expired);
  });
});
