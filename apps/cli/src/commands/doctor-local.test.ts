// R1: the local checks `agentlink doctor` adds: why AgentLink closed last time, a leftover
// app-host.json, half-removed IDs, AI-app entries that name an ID that is gone. Temp HOME only;
// read-only; nothing but fixed words, app names and ID folder names is printed.
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import { agentlinkEntry } from '../harness/entry.js';
import { harnessById } from '../harness/harnesses.js';
import { writeAppHostRecord } from '../runtime/app-host-record.js';
import { writeLastExit } from '../runtime/last-exit.js';
import { createDoctorHandler } from './doctor.js';
import { DOCTOR_LOCAL_TEXT, localDoctorChecks } from './doctor-local.js';
import { createDeps } from './shared.js';

const TOKEN = 'T'.repeat(43);
let home = '';
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-r1-doctor-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const noApps = { list: () => Promise.resolve({ apps: [], desktopRunning: false }) };
const deadPid = (): number => {
  const child = spawnSync(process.execPath, ['-e', '0']);
  return child.pid;
};

describe('doctor: why AgentLink closed last time (R1)', () => {
  it('says nothing when there is no record', async () => {
    const r = await localDoctorChecks({ home, ids: () => Promise.resolve([]), apps: noApps });
    expect(r).toEqual({ lines: [], problems: 0, ids: [] });
  });

  it.each([
    ['ctrl_c', 'you pressed Ctrl+C'],
    ['sighup', 'its terminal window was closed'],
    ['idle', 'it was not used for 30 minutes'],
  ] as const)('%s reads as a plain sentence', async (reason, words) => {
    await writeLastExit(home, { reason, version: '1.0.0', at: 1 });
    const r = await localDoctorChecks({ home, ids: () => Promise.resolve([]), apps: noApps });
    expect(r.lines).toEqual([`OK       Last time AgentLink closed because ${words}.`]);
    expect(r.problems).toBe(0);
  });

  it.each(['uncaught', 'rejections', 'start_keychain', 'start_removing'] as const)(
    '%s is a warning, not a problem count',
    async (reason) => {
      await writeLastExit(home, { reason, version: '1.0.0', at: 1 });
      const r = await localDoctorChecks({ home, ids: () => Promise.resolve([]), apps: noApps });
      expect(r.lines[0]).toMatch(/^Warning {2}Last time AgentLink closed because /);
      expect(r.problems).toBe(0);
    },
  );
});

describe('doctor: a leftover app-host.json (R1)', () => {
  it('a record whose process is gone is a problem', async () => {
    await writeAppHostRecord(home, { pid: deadPid(), port: 50123, handoffToken: TOKEN });
    const r = await localDoctorChecks({ home, ids: () => Promise.resolve([]), apps: noApps });
    expect(r.lines).toEqual([DOCTOR_LOCAL_TEXT.staleHost]);
    expect(r.problems).toBe(1);
    expect(r.lines.join('\n')).not.toContain(TOKEN);
  });

  it('a record whose process is alive is fine', async () => {
    await writeAppHostRecord(home, { pid: process.pid, port: 50123, handoffToken: TOKEN });
    const r = await localDoctorChecks({ home, ids: () => Promise.resolve([]), apps: noApps });
    expect(r.lines).toEqual([]);
  });
});

describe('doctor: half-removed IDs (R1)', () => {
  it('counts them and points to the app, naming none', async () => {
    const r = await localDoctorChecks({
      home,
      ids: () =>
        Promise.resolve([
          { name: 'old-one', removing: true },
          { name: 'old-two', removing: true },
          { name: 'work', removing: false },
        ]),
      apps: noApps,
    });
    expect(r.lines).toEqual([DOCTOR_LOCAL_TEXT.halfRemoved(2)]);
    expect(r.problems).toBe(1);
    expect(r.lines.join('\n')).not.toMatch(/old-one|old-two|work/);
  });

  it('one and many read right', () => {
    expect(DOCTOR_LOCAL_TEXT.halfRemoved(1)).toContain('1 ID was only half removed');
    expect(DOCTOR_LOCAL_TEXT.halfRemoved(3)).toContain('3 IDs were only half removed');
  });
});

describe('doctor: AI apps that start an ID that is gone (R1)', () => {
  const app = (name: string, agent: string) => ({
    app: 'claude-code',
    name,
    path: '~/.claude.json',
    state: { kind: 'agent' as const, agent },
    quitFirst: false,
  });

  it('names the app and the ID folder only', async () => {
    const r = await localDoctorChecks({
      home,
      ids: () => Promise.resolve([{ name: 'work', removing: false }]),
      apps: {
        list: () =>
          Promise.resolve({
            apps: [app('Claude Code', 'gone'), app('Cursor', 'work')],
            desktopRunning: false,
          }),
      },
    });
    expect(r.lines).toEqual([DOCTOR_LOCAL_TEXT.appMissingId('Claude Code')]);
    expect(r.problems).toBe(1);
    expect(r.lines.join('\n')).not.toContain('~/.claude.json');
  });

  it('also lists an AI app with a live session for the ID, as the app does', async () => {
    const r = await localDoctorChecks({
      home,
      ids: () =>
        Promise.resolve([
          { name: 'work', removing: false, label: 'Work' },
          { name: 'ops', removing: false, label: 'Ops' },
        ]),
      apps: {
        list: () => Promise.resolve({ apps: [app('Claude Code', 'ops')], desktopRunning: false }),
      },
      liveApps: () => Promise.resolve(['claude-code']),
    });
    expect(r.ids?.map((i) => i.apps)).toEqual([
      ['Claude Code (connected now)'],
      ['Claude Code (connected now)'],
    ]);
  });

  it('lists every ID by display name with the AI apps that start it', async () => {
    const r = await localDoctorChecks({
      home,
      ids: () =>
        Promise.resolve([
          { name: 'work', removing: false, label: 'My work ID' },
          { name: 'spare', removing: false },
          { name: 'old', removing: true },
        ]),
      apps: {
        list: () =>
          Promise.resolve({
            apps: [app('Cursor', 'work'), app('Codex', 'work')],
            desktopRunning: false,
          }),
      },
    });
    expect(r.ids).toEqual([
      { name: 'work', label: 'My work ID', apps: ['Cursor', 'Codex'] },
      { name: 'spare', label: 'spare', apps: [] },
    ]);
  });

  it('the missing-ID line names the app, not a folder name, and points to the app, never a command to type', () => {
    const line = DOCTOR_LOCAL_TEXT.appMissingId('Cursor');
    expect(line).toContain('Cursor');
    expect(line).not.toContain('"');
    expect(line).toContain('connect Cursor to another ID');
    expect(line).not.toContain('add-agent');
  });

  it('an app that starts a half-removed ID is also flagged', async () => {
    const r = await localDoctorChecks({
      home,
      ids: () => Promise.resolve([{ name: 'old', removing: true }]),
      apps: {
        list: () => Promise.resolve({ apps: [app('Cursor', 'old')], desktopRunning: false }),
      },
    });
    expect(r.lines).toContain(DOCTOR_LOCAL_TEXT.appMissingId('Cursor'));
  });

  it('reads the real harness config of a temp home, read-only', async () => {
    await chmod(home, 0o700);
    const path = join(home, '.claude.json');
    const text = `${JSON.stringify(
      {
        numStartups: 3,
        mcpServers: { agentlink: agentlinkEntry(harnessById('claude-code'), 'gone') },
      },
      null,
      2,
    )}\n`;
    await writeFile(path, text, { mode: 0o600 });
    await chmod(path, 0o600);
    await mkdir(join(home, '.claude'), { mode: 0o700 });
    const r = await localDoctorChecks({
      home,
      env: {},
      platform: 'darwin',
      ids: () => Promise.resolve([]),
    });
    expect(r.lines).toEqual([DOCTOR_LOCAL_TEXT.appMissingId('Claude Code')]);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path, 'utf8')).toBe(text);
  });

  it('a failing reader never breaks doctor', async () => {
    const r = await localDoctorChecks({
      home,
      ids: () => Promise.reject(new Error('x')),
      apps: { list: () => Promise.reject(new Error('x')) },
    });
    expect(r).toEqual({ lines: [], problems: 0 });
  });
});

describe('doctor runs the local checks even with no ID (R1)', () => {
  it('prints them first and counts the problems', async () => {
    const out: string[] = [];
    const deps = createDeps({
      open: () =>
        Promise.resolve({ status: 'needs_setup', reason: 'no_agent', message: 'Not set up here.' }),
      home: '/nonexistent-home',
    });
    const handler = createDoctorHandler({
      ...deps,
      local: () => Promise.resolve({ lines: ['Problem  Local line'], problems: 1 }),
    });
    const code = await createDispatcher({ doctor: handler })(['doctor'], {
      output: { print: (t) => out.push(t), printError: (t) => out.push(t) },
      terminal: { stdinIsTTY: true, stdoutIsTTY: true, env: {} },
      version: '0.0.0',
    });
    expect(code).toBe(1);
    expect(out[0]).toBe('Problem  Local line');
    expect(out.join('\n')).toContain('Not set up here.');
  });

  it('OK lines are printed too', async () => {
    const out: string[] = [];
    const deps = createDeps({
      open: () => Promise.resolve({ status: 'needs_setup', reason: 'no_agent', message: 'x' }),
      home: '/nonexistent-home',
    });
    const handler = createDoctorHandler({
      ...deps,
      local: () => Promise.resolve({ lines: ['OK       Last time'], problems: 0 }),
    });
    await createDispatcher({ doctor: handler })(['doctor'], {
      output: { print: (t) => out.push(t), printError: (t) => out.push(t) },
      terminal: { stdinIsTTY: true, stdoutIsTTY: true, env: {} },
      version: '0.0.0',
    });
    expect(out[0]).toBe('OK       Last time');
  });
});

describe('UX1113-R1: an unfinished restore (04 §2.3.3)', () => {
  it('doctor names it first, as a problem', async () => {
    const out: string[] = [];
    const deps = createDeps({
      open: () =>
        Promise.resolve({ status: 'needs_setup', reason: 'no_agent', message: 'Not set up here.' }),
      home: '/nonexistent-home',
    });
    const handler = createDoctorHandler({ ...deps, restorePending: () => Promise.resolve(true) });
    const code = await createDispatcher({ doctor: handler })(['doctor'], {
      output: { print: (t) => out.push(t), printError: (t) => out.push(t) },
      terminal: { stdinIsTTY: true, stdoutIsTTY: true, env: {} },
      version: '0.0.0',
    });
    expect(code).toBe(1);
    expect(out[0]).toContain("A restore didn't finish");
  });
});
