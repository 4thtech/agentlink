// M1-23-d: hands-free two-Mac dogfood (remote.mjs). Fixtures and a fake `ssh`; no network, no harness.
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSteps, parseArgs, parseCommand, runPlan } from './lib.mjs';
import {
  approveInvocation,
  combineResults,
  combinedOk,
  encodeLine,
  harnessEnvVars,
  makeInbox,
  plain,
  sealLine,
  parseLine,
  remotePath,
  remoteRunCommand,
  renderCombinedMd,
  shq,
  sshArgs,
  sshPreflight,
  sshSetupHelp,
  wireOutcome,
} from './remote.mjs';

const RUN_MJS = fileURLToPath(new URL('./run.mjs', import.meta.url));
const INVITE = 'https://agentlink.example/i/SECRETINVITETOKEN123456';
const APR = 'apr_abcdefghijklmnopqrstuv';
const base = ['--two-mac', '--remote', 'mini.local'];
const opts = (extra = []) => parseArgs([...base, ...extra]);

describe('arg parsing', () => {
  it('--two-mac makes this Mac role A with the remote defaults', () => {
    const o = opts(['--cc-agent', 'cc-gate', '--oc-agent', 'oc-test']);
    expect(o).toMatchObject({
      twoMac: true,
      role: 'a',
      remoteHost: 'mini.local',
      remoteRepo: '~/agentlink',
      ccAgent: 'cc-gate',
    });
  });

  it('takes the remote paths and the remote agentlink argv', () => {
    const o = opts([
      '--remote-repo',
      '~/code/agentlink',
      '--remote-opencode',
      '/Users/x/.opencode/bin/opencode',
      '--remote-agentlink',
      '["node","/a/cli.js"]',
    ]);
    expect(o.remoteRepo).toBe('~/code/agentlink');
    expect(o.remoteOpencode).toBe('/Users/x/.opencode/bin/opencode');
    expect(parseCommand(o.remoteAgentlink)).toEqual({ cmd: 'node', args: ['/a/cli.js'] });
  });

  it('refuses missing remote, ssh option injection, shell characters and bad combinations', () => {
    expect(() => parseArgs(['--two-mac'])).toThrow(/--remote/);
    expect(() => parseArgs(['--two-mac', '--remote', '-oProxyCommand=x'])).toThrow();
    expect(() => parseArgs(['--two-mac', '--remote', 'a;b'])).toThrow(/valid ssh host/);
    expect(() => opts(['--remote-repo', '~/a b; rm'])).toThrow(/not allowed/);
    expect(() => opts(['--remote-agentlink', '[]'])).toThrow();
    expect(() => opts(['--role', 'a'])).toThrow(/--two-mac/);
    expect(() => opts(['--manual'])).toThrow(/--two-mac/);
    expect(() => opts(['--invite', INVITE])).toThrow(/--two-mac/);
    expect(() => parseArgs(['--remote', 'mini.local'])).toThrow(/needs --two-mac/);
    expect(() => parseArgs(['--remote-repo', '~/x'])).toThrow(/needs --two-mac/);
  });

  it('--hands-free is role b only, needs the run ID, and takes no invite on the command line', () => {
    expect(() => parseArgs(['--hands-free'])).toThrow(/--role b/);
    expect(() => parseArgs(['--role', 'b', '--hands-free'])).toThrow(/--run-id/);
    expect(() =>
      parseArgs(['--role', 'b', '--hands-free', '--run-id', '20261017-101500', '--invite', INVITE]),
    ).toThrow(/stdin/);
    const o = parseArgs(['--role', 'b', '--hands-free', '--run-id', '20261017-101500']);
    expect(o.handsFree).toBe(true);
  });

  it('existing modes are unchanged', () => {
    expect(parseArgs([])).toMatchObject({ twoMac: false, handsFree: false, role: undefined });
    expect(parseArgs(['--role', 'a', '--same-owner']).role).toBe('a');
    expect(parseArgs(['--role', 'b']).twoMac).toBe(false);
  });
});

describe('status-line protocol', () => {
  it('round-trips every kind', () => {
    expect(parseLine(encodeLine('READY'))).toEqual({ kind: 'READY' });
    expect(parseLine(encodeLine('STEP', 'P2', 'ok'))).toEqual({
      kind: 'STEP',
      id: 'P2',
      outcome: 'ok',
    });
    expect(parseLine(encodeLine('INVITE', INVITE))).toEqual({ kind: 'INVITE', url: INVITE });
    expect(parseLine(encodeLine('PAIRED'))).toEqual({ kind: 'PAIRED' });
    expect(parseLine(encodeLine('APPROVAL', 'oc', 'oc-test', APR))).toEqual({
      kind: 'APPROVAL',
      harness: 'oc',
      agent: 'oc-test',
      approvalId: APR,
    });
  });

  it('FINAL carries bounded, fixed fields', () => {
    const final = {
      results: [
        {
          id: 'M2',
          title: 't',
          harness: 'oc',
          local: true,
          outcome: 'pass',
          seconds: 4.4,
          notes: ['n'],
          extra: 'x',
        },
      ],
      findings: [],
      versions: { agentlink: '0.1.0' },
      scan: 'clean (3 files)',
      dir: '/Users/x/agentlink-dogfood/r',
    };
    const parsed = parseLine(encodeLine('FINAL', JSON.stringify(final)));
    expect(parsed.final.results[0]).toEqual({
      id: 'M2',
      title: 't',
      harness: 'oc',
      local: true,
      benign: false,
      outcome: 'pass',
      seconds: 4,
      notes: ['n'],
    });
  });

  it('ignores anything malformed or hostile (nothing from Mac B reaches a shell)', () => {
    for (const line of [
      'plain output',
      '@@AL',
      '@@AL STEP p2 ok',
      '@@AL STEP P2 maybe',
      '@@AL STEP P2 ok extra',
      '@@AL APPROVAL oc oc-test apr_short',
      `@@AL APPROVAL oc oc-test;reboot ${APR}`,
      `@@AL APPROVAL oc oc-test ${APR}; reboot`,
      '@@AL INVITE not-a-url',
      "@@AL INVITE https://x/y'z",
      '@@AL FINAL {bad json',
      '@@AL FINAL {"results":[{"id":"bad id"}]}',
      '@@AL UNKNOWN',
    ]) {
      expect(parseLine(line), line).toBeUndefined();
    }
    expect(() => encodeLine('STEP', 'P2; x', 'ok')).toThrow();
  });

  it('maps outcomes to what the other Mac is told', () => {
    expect(['pass', 'skip', 'fail', 'inconclusive'].map((o) => wireOutcome(o))).toEqual([
      'ok',
      'skip',
      'fail',
      'fail',
    ]);
  });
});

describe('nonce and control characters (M1 status spoofing)', () => {
  const nonce = 'a'.repeat(32);
  it('only lines that carry the nonce are protocol on Mac B stdout', () => {
    const real = sealLine(encodeLine('STEP', 'P2', 'ok'), nonce);
    expect(parseLine(real, nonce)).toEqual({ kind: 'STEP', id: 'P2', outcome: 'ok' });
    expect(parseLine(encodeLine('STEP', 'P2', 'ok'), nonce)).toBeUndefined();
    expect(parseLine(sealLine(encodeLine('READY'), 'b'.repeat(32)), nonce)).toBeUndefined();
    expect(parseLine(encodeLine('NONCE', nonce))).toEqual({ kind: 'NONCE', nonce });
    expect(parseLine('@@AL NONCE short')).toBeUndefined();
  });
  it('a malicious tool name with CR and a FINAL line cannot forge a result', () => {
    const evil = '\r@@AL FINAL {"results":[],"findings":[]}\r';
    const row = renderCombinedMd(
      {
        startedAt: 's',
        ccAgent: 'a',
        ocAgent: 'b',
        host: 'h',
        dirA: '/a',
        scanA: 'c',
        scanB: 'c',
        versionsA: {},
        versionsB: {},
      },
      [
        {
          id: 'P1',
          title: 't',
          mac: 'B',
          harness: 'oc',
          outcome: 'pass',
          seconds: 1,
          notes: [evil],
        },
      ],
    );
    expect(row.includes('\r')).toBe(false);
    expect(plain(evil)).not.toMatch(/\r/);
    const final = parseLine(
      encodeLine('FINAL', JSON.stringify({ results: [{ id: 'P1', notes: [evil] }] })),
    );
    expect(final.final.results[0].notes[0]).not.toMatch(/\r/);
  });
  it('detects AI-app environment variables', () => {
    expect(harnessEnvVars({ CLAUDECODE: '1', PATH: '/x' })).toEqual(['CLAUDECODE']);
    expect(harnessEnvVars({ PATH: '/x' })).toEqual([]);
  });
});

describe('inbox', () => {
  it('delivers queued and later messages by match, and reports timeout and end', async () => {
    const inbox = makeInbox();
    inbox.push({ kind: 'STEP', id: 'P1', outcome: 'ok' });
    inbox.push({ kind: 'STEP', id: 'P2', outcome: 'ok' });
    expect((await inbox.take((m) => m.id === 'P2', 50)).id).toBe('P2');
    const later = inbox.take((m) => m.id === 'M2', 500);
    inbox.push({ kind: 'STEP', id: 'M2', outcome: 'fail' });
    expect((await later).outcome).toBe('fail');
    expect(await inbox.take((m) => m.id === 'zz', 20)).toBe('timeout');
    const pending = inbox.take((m) => m.id === 'zz', 500);
    inbox.end();
    expect(await pending).toBe('ended');
  });
});

describe('ssh commands', () => {
  it('uses BatchMode for non-interactive calls and a tty only for approve; refuses option-like hosts', () => {
    expect(sshArgs('mini.local', 'true')).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      '--',
      'mini.local',
      'true',
    ]);
    expect(sshArgs('mini.local', 'x', { tty: true })).toContain('-t');
    expect(() => sshArgs('-oProxyCommand=x', 'true')).toThrow();
  });

  it('the Mac B command has no invite, quotes paths, and expands ~ on Mac B', () => {
    const o = opts([
      '--cc-agent',
      'cc-gate',
      '--remote-opencode',
      '/Users/x/.opencode/bin/opencode',
      '--same-owner',
    ]);
    const cmd = remoteRunCommand(o, '20261017-101500');
    expect(cmd).toContain('--role b --hands-free');
    expect(cmd).toContain('--run-id 20261017-101500');
    expect(cmd).toContain('"$HOME"');
    expect(cmd).toContain('--same-owner');
    expect(cmd).not.toContain('--invite');
    expect(cmd).toContain('@4thtech-io/agentlink@latest');
    expect(cmd).not.toContain('https://');
    expect(remotePath('~/a')).toBe(`"$HOME"/'a'`);
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });

  it("approve runs on the person's terminal: inherited stdio, no code, no env on the command line", () => {
    const o = opts([
      '--agentlink',
      '["node","/a/cli.js"]',
      '--remote-agentlink',
      '["node","/b/cli.js"]',
    ]);
    const local = approveInvocation(o, 'local', 'cc-gate', APR, parseCommand);
    expect(local).toEqual({
      cmd: 'node',
      args: ['/a/cli.js', 'approve', '--agent', 'cc-gate', APR],
      stdio: 'inherit',
    });
    const remote = approveInvocation(o, 'remote', 'oc-test', APR, parseCommand);
    expect(remote.cmd).toBe('ssh');
    expect(remote.stdio).toBe('inherit');
    expect(remote.args).toContain('-t');
    expect(remote.args).not.toContain('BatchMode=yes');
    const joined = remote.args.join(' ');
    expect(joined).toContain(`approve --agent oc-test ${APR}`);
    expect(joined).not.toMatch(/CLAUDE|OPENCODE|ANTHROPIC|SendEnv|SetEnv/);
    expect(() => approveInvocation(o, 'remote', 'oc-test; x', APR, parseCommand)).toThrow();
    expect(() => approveInvocation(o, 'remote', 'oc-test', `${APR}; x`, parseCommand)).toThrow();
  });

  it('setup help names Remote Login and ssh-copy-id', () => {
    const t = sshSetupHelp('mini.local');
    expect(t).toMatch(/Remote Login/);
    expect(t).toMatch(/ssh-copy-id mini.local/);
  });
});

describe('with a fake ssh', () => {
  let dir;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'al-fakessh-'));
    // Logs its argv and stdin to files; fails when FAKE_SSH_FAIL is set; else prints READY.
    await writeFile(
      join(dir, 'ssh'),
      `#!/bin/sh
printf '%s\\n' "$@" >> "${dir}/argv.log"
if [ -n "$FAKE_SSH_FAIL" ]; then echo "Permission denied (publickey)." >&2; exit 255; fi
echo '@@AL READY'
cat >> "${dir}/stdin.log"
`,
    );
    await chmod(join(dir, 'ssh'), 0o755);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('the invite travels on stdin only: never in argv or output', async () => {
    const o = opts();
    const args = sshArgs(o.remoteHost, remoteRunCommand(o, '20261017-101500'));
    const r = spawnSync(join(dir, 'ssh'), args, {
      input: `${encodeLine('INVITE', INVITE)}\n`,
      encoding: 'utf8',
    });
    expect(r.stdout).toContain('@@AL READY');
    const stdin = await readFile(join(dir, 'stdin.log'), 'utf8');
    const argv = await readFile(join(dir, 'argv.log'), 'utf8');
    expect(stdin).toContain(INVITE);
    expect(argv).not.toContain('SECRETINVITETOKEN');
    expect(r.stdout + r.stderr).not.toContain('SECRETINVITETOKEN');
  });

  it('a failing key login stops before anything starts and prints the setup steps', () => {
    const calls = [];
    const fake = (_cmd, args, spawnOpts) => {
      calls.push(args);
      return spawnSync(join(dir, 'ssh'), args, {
        ...spawnOpts,
        env: { ...process.env, FAKE_SSH_FAIL: '1' },
      });
    };
    const r = sshPreflight('mini.local', fake);
    expect(r.ok).toBe(false);
    expect(r.help).toMatch(/Remote Login/);
    expect(r.help).toMatch(/ssh-copy-id mini.local/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('BatchMode=yes');
    expect(sshPreflight('mini.local', (_c, a, o) => spawnSync(join(dir, 'ssh'), a, o))).toEqual({
      ok: true,
    });
  });

  it('--two-mac refuses to run without a terminal or inside an AI app', () => {
    const r = spawnSync(process.execPath, [RUN_MJS, ...base, '--out', join(dir, 'out')], {
      encoding: 'utf8',
      input: '',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_SSH_FAIL: '1' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/own terminal/);
    expect(r.stdout + r.stderr).not.toContain('SECRETINVITETOKEN');
  });
});

describe('runPlan onResult and the combined table', () => {
  it('announces every result, including skips', async () => {
    const steps = buildSteps({
      cc: 'cc-gate',
      oc: 'oc-test',
      runId: '20261017-101500',
      workspace: '/w',
    });
    const seen = [];
    await runPlan(
      steps.slice(0, 2),
      {
        now: () => 0,
        log: () => {},
        agentOf: (h) => h,
        side: 'cc',
        onResult: (r) => seen.push([r.id, r.outcome, r.local]),
        waitRemote: async () => 'ok',
        run: async () => ({ calls: [], exitCode: 0, timedOut: false }),
      },
      ['P2'],
    );
    expect(seen.map((s) => s[0])).toEqual(['P1', 'P2']);
  });

  it('takes each step from the Mac that ran it; fails on a missing Mac B or a scan finding', () => {
    const a = [
      { id: 'P1', title: 'p1', harness: 'cc', local: true, outcome: 'pass', seconds: 3, notes: [] },
      {
        id: 'P2',
        title: 'p2',
        harness: 'oc',
        local: false,
        outcome: 'remote',
        seconds: 0,
        notes: ['x'],
      },
    ];
    const b = [
      { id: 'P2', title: 'p2', harness: 'oc', local: true, outcome: 'pass', seconds: 9, notes: [] },
    ];
    const rows = combineResults(['P1', 'P2'], a, b);
    expect(rows.map((r) => [r.id, r.mac, r.outcome])).toEqual([
      ['P1', 'A', 'pass'],
      ['P2', 'B', 'pass'],
    ]);
    const bFinal = { results: b, findings: [], scan: 'clean (2 files)', versions: {}, dir: '/b' };
    expect(combinedOk(rows, [], bFinal)).toBe(true);
    expect(combinedOk(rows, [{ name: 'k', file: 'f' }], bFinal)).toBe(false);
    expect(combinedOk(rows, [], undefined)).toBe(false);
    expect(combineResults(['P1', 'P2'], a, [])[1].outcome).toBe('fail');
    const md = renderCombinedMd(
      {
        startedAt: 's',
        ccAgent: 'cc-gate',
        ocAgent: 'oc-test',
        host: 'mini.local',
        dirA: '/a',
        dirB: '/b',
        scanA: 'clean',
        scanB: 'clean',
        versionsA: {},
        versionsB: {},
      },
      rows,
    );
    expect(md).toMatch(/\| P2 \| p2 \| B \| OpenCode \| pass/);
    expect(md).toContain('Mac A /a; Mac B /b');
  });
});
