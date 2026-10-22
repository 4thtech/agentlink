// M1-23-e: auto-sync two-Mac dogfood (autosync.mjs). A fake `ssh` runs the remote command locally
// with HOME set to a temp folder, so the file protocol is tested end to end; no network, no harness.
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSteps, parseArgs, planText } from './lib.mjs';
import { encodeLine, keychainOverSshCheck, sealLine } from './remote.mjs';
import {
  FILES,
  abortPeer,
  clearStaleInvite,
  clearStaleInvites,
  discoverWaiting,
  inviteText,
  localTransport,
  makeChannel,
  parseInviteFile,
  parseStatusFile,
  parseWaiting,
  runWithExitHooks,
  sshTransport,
  statusLine,
  waitingText,
} from './autosync.mjs';

const INVITE = 'https://agentlink.example/i/SECRETINVITETOKEN123456';
const NONCE = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const RUN = '20261017-101500';

describe('arg parsing', () => {
  it('role b waits; role a needs --remote; the modes do not mix', () => {
    expect(parseArgs(['--role', 'b', '--auto-sync']).autoSync).toBe(true);
    expect(() => parseArgs(['--auto-sync'])).toThrow(/--role/);
    expect(() => parseArgs(['--role', 'a', '--auto-sync'])).toThrow(/--remote/);
    const a = parseArgs(['--role', 'a', '--auto-sync', '--remote', 'u@mini.local']);
    expect(a).toMatchObject({ autoSync: true, remoteHost: 'u@mini.local', role: 'a' });
    expect(() => parseArgs(['--role', 'b', '--auto-sync', '--remote', 'mini.local'])).toThrow(
      /role a/,
    );
    expect(() => parseArgs(['--two-mac', '--remote', 'h', '--auto-sync'])).toThrow(/--two-mac/);
    expect(() => parseArgs(['--role', 'b', '--auto-sync', '--invite', INVITE])).toThrow(/--invite/);
    expect(() => parseArgs(['--role', 'b', '--auto-sync', '--run-id', RUN])).toThrow(/--run-id/);
    expect(() => parseArgs(['--role', 'b', '--auto-sync', '--paired'])).toThrow(/--paired/);
    expect(() => parseArgs(['--role', 'a', '--remote-out', '~/x'])).toThrow(/--auto-sync/);
    expect(
      parseArgs(['--role', 'a', '--auto-sync', '--remote', 'h', '--remote-out', '~/out']).remoteOut,
    ).toBe('~/out');
  });

  it('existing modes are unchanged', () => {
    expect(parseArgs(['--role', 'b']).autoSync).toBe(false);
    expect(() => parseArgs(['--remote', 'h'])).toThrow(/--two-mac/);
    expect(parseArgs(['--two-mac', '--remote', 'h']).role).toBe('a');
  });

  it('the dry-run plan names the mode', () => {
    const o = parseArgs(['--role', 'b', '--auto-sync']);
    const steps = buildSteps({ cc: 'cc-test', oc: 'oc-test', runId: RUN, workspace: '/w' });
    expect(planText(o, steps)).toMatch(/Auto-sync/);
  });
});

describe('sealed lines and files', () => {
  it('only lines with this run nonce count; forged and malformed lines are dropped', () => {
    const text = [
      statusLine(NONCE, 'STEP', 'P1', 'ok'),
      statusLine(OTHER, 'STEP', 'P2', 'ok'), // another run's nonce
      '@@AL STEP P3 ok', // no nonce at all
      `${sealLine(encodeLine('STEP', 'P4', 'ok'), NONCE)} extra`, // trailing junk
      sealLine('@@AL STEP P5 maybe', NONCE), // bad outcome
      'STEP P6 ok',
      statusLine(NONCE, 'DONE'),
    ].join('\n');
    expect(parseStatusFile(text, NONCE)).toEqual([
      { kind: 'STEP', id: 'P1', outcome: 'ok' },
      { kind: 'DONE' },
    ]);
  });

  it('waiting file and invite file parse strictly', () => {
    expect(parseWaiting(waitingText(RUN, NONCE))).toEqual({ runId: RUN, nonce: NONCE });
    expect(parseWaiting(`${RUN} short`)).toBeUndefined();
    expect(parseWaiting('x')).toBeUndefined();
    expect(parseInviteFile(inviteText(NONCE, 'INVITE', INVITE), NONCE)).toEqual({
      kind: 'INVITE',
      url: INVITE,
    });
    expect(parseInviteFile(inviteText(OTHER, 'INVITE', INVITE), NONCE)).toBeUndefined();
    expect(parseInviteFile(inviteText(NONCE, 'PAIRED'), NONCE)).toEqual({ kind: 'PAIRED' });
    expect(parseInviteFile(inviteText(NONCE, 'ABORT'), NONCE)).toEqual({ kind: 'ABORT' });
    expect(parseInviteFile(statusLine(NONCE, 'STEP', 'P1', 'ok'), NONCE)).toBeUndefined();
    expect(() => statusLine(NONCE, 'INVITE', 'javascript:alert(1)')).toThrow(/bad protocol line/);
  });
});

describe('the file protocol through a fake ssh', () => {
  let dir;
  let home;
  let ssh;
  const syncDir = `~/agentlink-dogfood/${RUN}/sync`;
  const aTransport = () => sshTransport('u@mini.local', syncDir, { ssh });
  let bTransport;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'al-autosync-'));
    home = join(dir, 'home');
    await mkdir(home, { recursive: true });
    ssh = join(dir, 'ssh');
    // Logs argv; runs the last argument (the remote command) with HOME = the temp home.
    await writeFile(
      ssh,
      `#!/bin/sh
printf '%s\\n' "$@" >> "${dir}/argv.log"
for last; do :; done
HOME="${home}"; export HOME
exec sh -c "$last"
`,
    );
    await chmod(ssh, 0o755);
    bTransport = localTransport(join(home, 'agentlink-dogfood', RUN, 'sync'));
    await bTransport.init();
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('Mac A discovers the waiting run and its nonce, then claims it', async () => {
    expect(await discoverWaiting('u@mini.local', '~/agentlink-dogfood', { ssh })).toBeUndefined();
    await bTransport.write(FILES.waiting, waitingText(RUN, NONCE));
    const found = await discoverWaiting('u@mini.local', '~/agentlink-dogfood', { ssh });
    expect(found).toEqual({ runId: RUN, nonce: NONCE, syncDir });
    await aTransport().remove(FILES.waiting);
    expect(await bTransport.read(FILES.waiting)).toBeUndefined();
    expect(await discoverWaiting('u@mini.local', '~/agentlink-dogfood', { ssh })).toBeUndefined();
  });

  it('the sync folder is 0700 and files written over ssh are 0600', async () => {
    const t = aTransport();
    await t.write(FILES.a, 'x\n');
    const folder = join(home, 'agentlink-dogfood', RUN, 'sync');
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(join(folder, FILES.a))).mode & 0o777).toBe(0o600);
    await t.remove(FILES.a);
  });

  it('the invite travels on stdin only; B reads it and deletes it', async () => {
    await aTransport().write(FILES.invite, inviteText(NONCE, 'INVITE', INVITE));
    const argv = await readFile(join(dir, 'argv.log'), 'utf8');
    expect(argv).not.toContain('SECRETINVITETOKEN');
    expect(argv).toContain('BatchMode=yes');
    const text = await bTransport.read(FILES.invite);
    expect(parseInviteFile(text, NONCE)).toEqual({ kind: 'INVITE', url: INVITE });
    await bTransport.remove(FILES.invite);
    expect(await bTransport.read(FILES.invite)).toBeUndefined();
  });

  it('status lines flow both ways in order; a wrong nonce or stale line is ignored', async () => {
    const clock = { t: 0 };
    const deps = {
      sleep: async (ms) => {
        clock.t += ms;
      },
      now: () => clock.t,
      intervalMs: 10,
    };
    const a = makeChannel({ transport: aTransport(), nonce: NONCE, role: 'a', ...deps });
    const b = makeChannel({ transport: bTransport, nonce: NONCE, role: 'b', ...deps });
    // a stale line from an earlier run sits in B's file first
    await bTransport.append(FILES.b, `${statusLine(OTHER, 'STEP', 'P1', 'ok')}\n`);
    a.send('READY');
    a.send('STEP', 'P1', 'ok');
    await a.send('STEP', 'P3', 'fail'); // sends are queued in order; awaiting the last flushes all
    expect(await b.take((m) => m.kind === 'READY', 1000)).toEqual({ kind: 'READY' });
    expect(await b.take((m) => m.kind === 'STEP' && m.id === 'P3', 1000)).toEqual({
      kind: 'STEP',
      id: 'P3',
      outcome: 'fail',
    });
    // P1 is still queued after P3 was taken first
    expect(await b.take((m) => m.id === 'P1', 1000)).toMatchObject({ outcome: 'ok' });
    await b.send('STEP', 'P2', 'ok');
    await b.send('DONE');
    // the stale other-nonce line never shows up on A's side
    expect(await a.take((m) => m.kind === 'STEP' && m.id === 'P1', 100)).toBe('timeout');
    expect(await a.take((m) => m.kind === 'STEP' && m.id === 'P2', 1000)).toMatchObject({
      outcome: 'ok',
    });
    expect(await a.take((m) => m.kind === 'DONE', 1000)).toEqual({ kind: 'DONE' });
  });

  it('take times out when nothing arrives, and survives a failing ssh', async () => {
    const clock = { t: 0 };
    const deps = {
      sleep: async (ms) => {
        clock.t += ms;
      },
      now: () => clock.t,
      intervalMs: 1000,
    };
    const broken = sshTransport('u@mini.local', syncDir, { ssh: join(dir, 'does-not-exist') });
    const a = makeChannel({ transport: broken, nonce: NONCE, role: 'a', ...deps });
    expect(await a.take(() => true, 5000)).toBe('timeout');
    expect(clock.t).toBeGreaterThanOrEqual(5000);
    await expect(broken.write(FILES.invite, 'x')).rejects.toThrow(/over ssh/);
  });

  it('refuses a sync path with characters that could reach a shell', async () => {
    const bad = sshTransport('u@mini.local', "~/x'; rm -rf ~; '", { ssh });
    await expect(bad.read(FILES.b)).rejects.toThrow(/not allowed/);
  });
});

describe('--two-mac keychain-over-ssh preflight', () => {
  const o = parseArgs(['--two-mac', '--remote', 'mini.local', '--oc-agent', 'oc-test']);
  const parse = (v) => ({ cmd: JSON.parse(v)[0], args: JSON.parse(v).slice(1) });
  const fake =
    (stdout, stderr = '') =>
    () => ({ status: 1, stdout, stderr });

  it('prints the --auto-sync advice for the macOS failures', () => {
    for (const text of [
      'no system keychain',
      'SecKeychainCopySettings: User interaction is not allowed.',
    ]) {
      const r = keychainOverSshCheck(o, parse, fake(text));
      expect(r.ok).toBe(false);
      // M1-23-f: names the macOS limitation and where the agent must run.
      expect(r.help).toMatch(/login keychain/);
      expect(r.help).toMatch(/SSH/);
      expect(r.help).toMatch(/own terminal/);
      expect(r.help).toMatch(/--auto-sync/);
    }
  });

  it('lets other outcomes through to Mac B own preflight', () => {
    expect(keychainOverSshCheck(o, parse, fake('all good'))).toEqual({ ok: true });
    expect(keychainOverSshCheck(o, parse, fake('', 'npx: not found'))).toEqual({ ok: true });
  });

  it('asks only for doctor, over a BatchMode ssh', () => {
    const calls = [];
    keychainOverSshCheck(o, parse, (cmd, args) => {
      calls.push([cmd, args]);
      return { status: 0, stdout: '', stderr: '' };
    });
    expect(calls[0][0]).toBe('ssh');
    expect(calls[0][1]).toContain('BatchMode=yes');
    expect(calls[0][1].join(' ')).toMatch(/doctor --agent oc-test/);
  });
});

describe('auto-sync cleanup and early exit (M1-23-f)', () => {
  let dir;
  let home;
  let ssh;
  let bTransport;
  const syncDir = `~/agentlink-dogfood/${RUN}/sync`;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'al-autosync-f-'));
    home = join(dir, 'home');
    await mkdir(home, { recursive: true });
    ssh = join(dir, 'ssh');
    await writeFile(
      ssh,
      `#!/bin/sh
for last; do :; done
HOME="${home}"; export HOME
exec sh -c "$last"
`,
    );
    await chmod(ssh, 0o755);
    bTransport = localTransport(join(home, 'agentlink-dogfood', RUN, 'sync'));
    await bTransport.init();
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('Mac B removes a stale invite file left behind by an earlier run', async () => {
    await bTransport.write(FILES.invite, inviteText(NONCE, 'INVITE', INVITE));
    await clearStaleInvite(bTransport);
    expect(await bTransport.read(FILES.invite)).toBeUndefined();
    await expect(clearStaleInvite(bTransport)).resolves.toBeUndefined();
  });

  it('Mac A sends ABORT to Mac B on an early exit; B reads it and no invite file stays', async () => {
    const a = sshTransport('u@mini.local', syncDir, { ssh });
    const channel = makeChannel({ transport: a, nonce: NONCE, role: 'a', sleep: async () => {} });
    await abortPeer({ transport: a, channel, nonce: NONCE });
    expect(parseInviteFile(await bTransport.read(FILES.invite), NONCE)).toEqual({ kind: 'ABORT' });
    const bChannel = makeChannel({
      transport: bTransport,
      nonce: NONCE,
      role: 'b',
      sleep: async () => {},
    });
    const got = await bChannel.take((m) => m.kind === 'ABORT', 0);
    expect(got.kind).toBe('ABORT');
    await clearStaleInvite(bTransport);
    expect(await bTransport.read(FILES.invite)).toBeUndefined();
  });

  it('abortPeer never throws when ssh is down', async () => {
    const down = sshTransport('u@mini.local', syncDir, { ssh: '/nonexistent/ssh' });
    const channel = makeChannel({
      transport: down,
      nonce: NONCE,
      role: 'a',
      sleep: async () => {},
    });
    await expect(abortPeer({ transport: down, channel, nonce: NONCE })).resolves.toBeUndefined();
  });

  it('exit hooks run last-first after main returns or throws, and a failing hook is ignored', async () => {
    const order = [];
    const hooks = [
      () => order.push('first'),
      () => {
        throw new Error('hook failed');
      },
      () => order.push('third'),
    ];
    expect(await runWithExitHooks(() => Promise.resolve(7), hooks)).toBe(7);
    expect(order).toEqual(['third', 'first']);
    order.length = 0;
    await expect(
      runWithExitHooks(() => Promise.reject(new Error('main failed')), hooks),
    ).rejects.toThrow('main failed');
    expect(order).toEqual(['third', 'first']);
  });
});

describe('stale invites from earlier runs (IR-M1-23-f-1)', () => {
  it('sweeps <out>/<run>/sync/invite of every earlier run, and nothing else', async () => {
    const out = await mkdtemp(join(tmpdir(), 'al-sweep-'));
    try {
      const runs = ['20261016-090000', '20261017-101500'];
      for (const r of runs) {
        await mkdir(join(out, r, 'sync'), { recursive: true });
        await writeFile(join(out, r, 'sync', FILES.invite), inviteText(NONCE, 'INVITE', INVITE));
        await writeFile(join(out, r, 'sync', FILES.b), 'keep\n');
      }
      // Not a run folder, and a symlinked sync folder: neither is followed.
      await mkdir(join(out, 'other', 'sync'), { recursive: true });
      await writeFile(join(out, 'other', 'sync', FILES.invite), 'x');
      const outside = await mkdtemp(join(tmpdir(), 'al-outside-'));
      await writeFile(join(outside, FILES.invite), 'x');
      await mkdir(join(out, '20261018-000000'), { recursive: true });
      await symlink(outside, join(out, '20261018-000000', 'sync'));
      await clearStaleInvites(out);
      for (const r of runs) {
        expect(await localTransport(join(out, r, 'sync')).read(FILES.invite)).toBeUndefined();
        expect(await localTransport(join(out, r, 'sync')).read(FILES.b)).toBe('keep\n');
      }
      expect(await readFile(join(out, 'other', 'sync', FILES.invite), 'utf8')).toBe('x');
      expect(await readFile(join(outside, FILES.invite), 'utf8')).toBe('x');
      await rm(outside, { recursive: true, force: true });
      await expect(clearStaleInvites(join(out, 'missing'))).resolves.toBeUndefined();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
