// BROWSER-UPDATE: "Update now" and "Restart now" in the browser app (the local app server that
// `agentlink`, the installers' launcher or npx start). The server stages the exact version the
// registry named, with npm run by argv (never a shell), scripts off, npm's integrity check and
// `npm audit signatures`; Restart now hands over to the staged copy (the old host closes first).
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NPM_REGISTRY,
  PACKAGE_NAME,
  STAGED_ENTRY,
  BrowserUpdater,
  execFileRunner,
  browserUpdateDeskWith,
  findNpmCli,
  globalInstallArgs,
  globalPrefix,
  installArgs,
  packageSpec,
  parseAuditSignatures,
  relaunch,
  updateEnv,
  verifyArgs,
  type Runner,
} from './browser-update.js';
import { NpmUpdateChecker, type RegistryFetch } from './npm-update-check.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const NPM = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
const NODE = '/opt/node/bin/node';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});
async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'al-browser-update-'));
  homes.push(home);
  return home;
}

describe('packageSpec', () => {
  it('the fixed package at the exact version the registry named', () => {
    expect(packageSpec('0.5.6')).toBe('@4thtech-io/agentlink@0.5.6');
    expect(PACKAGE_NAME).toBe('@4thtech-io/agentlink');
  });

  it.each([
    'latest',
    '0.5.6-beta.1',
    '^0.5.6',
    '>=0.5.6',
    'v0.5.6',
    '0.05.6',
    '0.5.6 --global',
    '0.5.6;rm -rf ~',
    '../../evil',
    'file:/tmp/x',
    'git+https://example.com/x',
    '',
    5,
    undefined,
  ])('refuses %s', (value) => {
    expect(packageSpec(value)).toBeUndefined();
  });
});

describe('the npm argv (no shell, no user strings)', () => {
  const spec = '@4thtech-io/agentlink@0.5.6';

  it('install: the fixed spec into the staging folder, scripts off, the public registry', () => {
    const args = installArgs(NPM, '/h/.agentlink/updates/0.5.6', spec);
    expect(args[0]).toBe(NPM);
    expect(args[1]).toBe('install');
    expect(args).toContain(spec);
    expect(args).toContain('--ignore-scripts');
    expect(args).toContain('--omit=dev');
    expect(args.slice(args.indexOf('--prefix'), args.indexOf('--prefix') + 2)).toEqual([
      '--prefix',
      '/h/.agentlink/updates/0.5.6',
    ]);
    expect(args.slice(args.indexOf('--registry'), args.indexOf('--registry') + 2)).toEqual([
      '--registry',
      NPM_REGISTRY,
    ]);
    // A scoped registry in the person's npmrc cannot send the package elsewhere.
    expect(args).toContain(`--@4thtech-io:registry=${NPM_REGISTRY}`);
    expect(args.filter((a) => a.includes('@4thtech-io/agentlink'))).toEqual([spec]);
  });

  it('verify: npm audit signatures (registry signatures and provenance) as JSON', () => {
    const args = verifyArgs(NPM, '/h/.agentlink/updates/0.5.6');
    expect(args.slice(0, 3)).toEqual([NPM, 'audit', 'signatures']);
    expect(args).toContain('--json');
    expect(args).toContain('/h/.agentlink/updates/0.5.6');
    expect(args).toContain(NPM_REGISTRY);
  });

  it('a global install in place: the same spec, scripts off, at the prefix it runs from', () => {
    const args = globalInstallArgs(NPM, '/Users/me/.npm-global', spec);
    expect(args).toContain('--global');
    expect(args).toContain('--ignore-scripts');
    expect(args).toContain('/Users/me/.npm-global');
    expect(args.filter((a) => a.includes('@4thtech-io/agentlink'))).toEqual([spec]);
  });

  it('the environment turns scripts off too and drops registry overrides', () => {
    const env = updateEnv({
      PATH: '/bin',
      HOME: '/h',
      npm_config_registry: 'https://evil.example/',
      'npm_config_@4thtech-io:registry': 'https://evil.example/',
      NPM_CONFIG_REGISTRY: 'https://evil.example/',
      npm_config_ignore_scripts: 'false',
    });
    expect(env['npm_config_ignore_scripts']).toBe('true');
    expect(env['npm_config_registry']).toBeUndefined();
    expect(env['NPM_CONFIG_REGISTRY']).toBeUndefined();
    expect(env['npm_config_@4thtech-io:registry']).toBeUndefined();
    expect(env['PATH']).toBe('/bin');
  });
});

describe('parseAuditSignatures', () => {
  it('only an answer with nothing invalid and nothing missing passes', () => {
    expect(parseAuditSignatures(enc('{\n  "invalid": [],\n  "missing": []\n}\n'))).toBe(true);
    expect(parseAuditSignatures(enc('{"invalid":[{"name":"x"}],"missing":[]}'))).toBe(false);
    expect(parseAuditSignatures(enc('{"invalid":[],"missing":[{"name":"x"}]}'))).toBe(false);
    expect(parseAuditSignatures(enc('{"invalid":[]}'))).toBe(false);
    expect(parseAuditSignatures(enc('not json'))).toBe(false);
    expect(parseAuditSignatures(enc(''))).toBe(false);
  });
});

describe('findNpmCli', () => {
  it('the npm that ships with this Node (posix and Windows layouts)', () => {
    const files = new Set([
      '/opt/node/lib/node_modules/npm/bin/npm-cli.js',
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    ]);
    const isFile = (p: string): boolean => files.has(p);
    expect(findNpmCli('/opt/node/bin/node', 'darwin', isFile)).toBe(
      '/opt/node/lib/node_modules/npm/bin/npm-cli.js',
    );
    expect(findNpmCli('C:\\Program Files\\nodejs\\node.exe', 'win32', isFile)).toBe(
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    );
    expect(findNpmCli('/somewhere/else/node', 'linux', isFile)).toBeUndefined();
  });
});

describe('globalPrefix', () => {
  it('the prefix of a global install, from the script that runs', () => {
    expect(
      globalPrefix(
        '/Users/me/.npm-global/lib/node_modules/@4thtech-io/agentlink/dist/agentlink.js',
        'darwin',
      ),
    ).toBe('/Users/me/.npm-global');
    expect(
      globalPrefix(
        'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@4thtech-io\\agentlink\\dist\\agentlink.js',
        'win32',
      ),
    ).toBe('C:\\Users\\me\\AppData\\Roaming\\npm');
    expect(globalPrefix('/tmp/agentlink.js', 'darwin')).toBeUndefined();
    expect(globalPrefix('/x/node_modules/other/dist/agentlink.js', 'darwin')).toBeUndefined();
  });
});

describe('execFileRunner', () => {
  it('runs the argv with execFile: no shell, the update environment, a timeout and a cap', async () => {
    const seen: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
    let stdinEnded = false;
    const runner = execFileRunner(((
      file: string,
      args: readonly string[],
      options: object,
      callback: (error: Error | null, stdout: Buffer) => void,
    ) => {
      seen.push({ file, args, options: options as Record<string, unknown> });
      setTimeout(() => callback(null, Buffer.from('{"invalid":[],"missing":[]}')), 1);
      return {
        stdin: {
          end: () => {
            stdinEnded = true;
          },
        },
      };
    }) as never);
    const result = await runner(NODE, [NPM, 'audit', 'signatures'], {
      cwd: '/h',
      timeoutMs: 1_000,
    });
    expect(result.code).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain('invalid');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.file).toBe(NODE);
    expect(seen[0]?.args).toEqual([NPM, 'audit', 'signatures']);
    expect(seen[0]?.options['shell']).toBe(false);
    expect(seen[0]?.options['timeout']).toBe(1_000);
    expect(typeof seen[0]?.options['maxBuffer']).toBe('number');
    expect((seen[0]?.options['env'] as Record<string, string>)['npm_config_ignore_scripts']).toBe(
      'true',
    );
    expect(stdinEnded).toBe(true);
  });

  it('a non-zero exit, a timeout or a start error is never success', async () => {
    const failing = (error: Error) =>
      execFileRunner(((
        _f: string,
        _a: readonly string[],
        _o: object,
        callback: (error: Error | null, stdout: Buffer) => void,
      ) => {
        setTimeout(() => callback(error, Buffer.alloc(0)), 1);
        return { stdin: null };
      }) as never);
    const opts = { cwd: '/h', timeoutMs: 10 };
    const exit1 = Object.assign(new Error('x'), { code: 1 });
    const enoent = Object.assign(new Error('x'), { code: 'ENOENT' });
    const killed = Object.assign(new Error('x'), { killed: true, code: null });
    expect((await failing(exit1)(NODE, [], opts)).code).toBe(1);
    expect((await failing(enoent)(NODE, [], opts)).code).toBeNull();
    expect((await failing(killed)(NODE, [], opts)).code).toBeNull();
  });
});

/** A fake npm: `install` writes the package the spec names; `audit signatures` answers. */
function fakeNpm(
  options: {
    readonly installCode?: number;
    readonly auditOut?: string;
    readonly writeVersion?: string;
    readonly globalCode?: number;
  } = {},
) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const run: Runner = async (file, args) => {
    calls.push({ file, args });
    if (args[1] === 'install' && args.includes('--global')) {
      return { code: options.globalCode ?? 0, stdout: new Uint8Array(0) };
    }
    if (args[1] === 'install') {
      const prefix = args[args.indexOf('--prefix') + 1] ?? '';
      const spec = args.find((a) => a.startsWith('@4thtech-io/agentlink@')) ?? '';
      const version = options.writeVersion ?? spec.slice('@4thtech-io/agentlink@'.length);
      const root = join(prefix, 'node_modules', '@4thtech-io', 'agentlink');
      await mkdir(join(root, 'dist'), { recursive: true });
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: '@4thtech-io/agentlink', version }),
      );
      await writeFile(join(root, 'dist', 'agentlink.js'), '// cli\n');
      return { code: options.installCode ?? 0, stdout: new Uint8Array(0) };
    }
    return {
      code: 0,
      stdout: enc(options.auditOut ?? '{"invalid":[],"missing":[]}'),
    };
  };
  return { run, calls };
}

function updater(
  home: string,
  run: Runner,
  extra: Partial<ConstructorParameters<typeof BrowserUpdater>[0]> = {},
) {
  return new BrowserUpdater({
    home,
    execPath: NODE,
    npmCli: NPM,
    install: 'npx',
    script: '/h/.npm/_npx/abc/node_modules/@4thtech-io/agentlink/dist/agentlink.js',
    run,
    ...extra,
  });
}

describe('BrowserUpdater.stage', () => {
  it('install, then verify, both through node + npm-cli.js; then ready to launch', async () => {
    const home = await tempHome();
    const npm = fakeNpm();
    const u = updater(home, npm.run);
    expect(u.canInstall()).toBe(true);
    await expect(u.stage('0.5.6')).resolves.toBe(true);
    expect(npm.calls.map((c) => [c.file, c.args[1], c.args[2]])).toEqual([
      [NODE, 'install', '@4thtech-io/agentlink@0.5.6'],
      [NODE, 'audit', 'signatures'],
    ]);
    expect(npm.calls.every((c) => c.args[0] === NPM)).toBe(true);
    expect(npm.calls[0]?.args).toContain('--ignore-scripts');
    expect(u.phase()).toBe('ready');
    const dir = join(home, '.agentlink', 'updates', '0.5.6');
    expect(u.launch()).toEqual({ file: NODE, args: [join(dir, ...STAGED_ENTRY), 'ui'] });
    if (process.platform !== 'win32') {
      expect((await stat(join(home, '.agentlink', 'updates'))).mode & 0o777).toBe(0o700);
    }
  });

  it('a version that is not plain x.y.z runs nothing', async () => {
    const home = await tempHome();
    const npm = fakeNpm();
    const u = updater(home, npm.run);
    await expect(u.stage('0.5.6 --global')).resolves.toBe(false);
    await expect(u.stage('latest')).resolves.toBe(false);
    expect(npm.calls).toEqual([]);
    expect(u.launch()).toBeUndefined();
  });

  it.each([
    ['the install fails', { installCode: 1 }],
    ['a signature is invalid', { auditOut: '{"invalid":[{"name":"x"}],"missing":[]}' }],
    ['a signature is missing', { auditOut: '{"invalid":[],"missing":[{"name":"x"}]}' }],
    ['the audit answer is unreadable', { auditOut: 'oops' }],
    ['another version was installed', { writeVersion: '0.5.7' }],
  ])('%s: failed, the staged folder removed, nothing to launch', async (_label, options) => {
    const home = await tempHome();
    const u = updater(home, fakeNpm(options).run);
    await expect(u.stage('0.5.6')).resolves.toBe(false);
    expect(u.phase()).toBe('failed');
    expect(u.launch()).toBeUndefined();
    await expect(stat(join(home, '.agentlink', 'updates', '0.5.6'))).rejects.toThrow();
  });

  it('a linked updates folder is refused (nothing is installed through a link)', async () => {
    if (process.platform === 'win32') return;
    const home = await tempHome();
    const elsewhere = await tempHome();
    await mkdir(join(home, '.agentlink'), { recursive: true });
    await symlink(elsewhere, join(home, '.agentlink', 'updates'));
    const npm = fakeNpm();
    await expect(updater(home, npm.run).stage('0.5.6')).resolves.toBe(false);
    expect(npm.calls).toEqual([]);
  });

  it('no npm next to this Node: nothing can be installed (the page shows the command)', async () => {
    const home = await tempHome();
    const u = updater(home, fakeNpm().run, { npmCli: undefined });
    expect(u.canInstall()).toBe(false);
    await expect(u.stage('0.5.6')).resolves.toBe(false);
  });

  it('a user-writable global install is updated in place after the verified staging', async () => {
    const home = await tempHome();
    // The real path (a temporary folder may sit behind a link, as /var on macOS).
    const prefix = await realpath(await tempHome());
    const script = join(
      prefix,
      'lib',
      'node_modules',
      '@4thtech-io',
      'agentlink',
      'dist',
      'agentlink.js',
    );
    await mkdir(join(prefix, 'lib', 'node_modules', '@4thtech-io', 'agentlink', 'dist'), {
      recursive: true,
    });
    await mkdir(join(prefix, 'bin'), { recursive: true });
    await writeFile(script, '// old\n');
    const npm = fakeNpm();
    const u = updater(home, npm.run, { install: 'global', script, platform: 'darwin' });
    expect(u.canInstall()).toBe(true);
    await expect(u.stage('0.5.6')).resolves.toBe(true);
    expect(npm.calls.map((c) => c.args[1])).toEqual(['install', 'audit', 'install']);
    const last = npm.calls[2]?.args ?? [];
    expect(last).toContain('--global');
    expect(last).toContain(prefix);
    expect(last).toContain('--ignore-scripts');
  });

  it('a global install this user cannot write: no in-app update (the one command instead)', async () => {
    const npm = fakeNpm();
    const u = updater(await tempHome(), npm.run, {
      install: 'global',
      script: '/usr/local/lib/node_modules/@4thtech-io/agentlink/dist/agentlink.js',
      platform: 'darwin',
      writable: () => false,
    });
    expect(u.canInstall()).toBe(false);
    await expect(u.stage('0.5.6')).resolves.toBe(false);
    expect(npm.calls).toEqual([]);
  });

  it('an older staged version is removed once the new one is ready', async () => {
    const home = await tempHome();
    const old = join(home, '.agentlink', 'updates', '0.5.5');
    await mkdir(old, { recursive: true });
    await writeFile(join(old, 'package.json'), '{}');
    await expect(updater(home, fakeNpm().run).stage('0.5.6')).resolves.toBe(true);
    await expect(stat(old)).rejects.toThrow();
    expect(
      JSON.parse(
        await readFile(
          join(
            home,
            '.agentlink',
            'updates',
            '0.5.6',
            'node_modules',
            '@4thtech-io',
            'agentlink',
            'package.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({ version: '0.5.6' });
  });
});

const latest =
  (v: string): RegistryFetch =>
  () =>
    Promise.resolve(
      new Response(`{"latest":"${v}"}`, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

async function deskHarness(install: 'npx' | 'global' | 'installer' = 'npx', canWrite = true) {
  const home = await tempHome();
  const checker = new NpmUpdateChecker({
    currentVersion: '0.5.5',
    enabled: true,
    fetch: latest('0.5.6'),
  });
  await checker.check();
  const npm = fakeNpm();
  const u = updater(home, npm.run, {
    install,
    ...(install === 'global'
      ? {
          script: '/usr/local/lib/node_modules/@4thtech-io/agentlink/dist/agentlink.js',
          platform: 'darwin' as const,
          writable: () => canWrite,
        }
      : {}),
  });
  const restarts: number[] = [];
  let accept = true;
  const timers: (() => void)[] = [];
  const desk = browserUpdateDeskWith(checker, install, u, {
    requestRestart: () => {
      restarts.push(1);
      return accept;
    },
    later: (fn) => timers.push(fn),
  });
  return {
    desk,
    u,
    npm,
    restarts,
    flush: () => timers.splice(0).forEach((fn) => fn()),
    refuse: () => {
      accept = false;
    },
  };
}

describe('browserUpdateDeskWith (Settings › Updates in the browser app)', () => {
  it('a newer version: Update now is offered (installable)', async () => {
    const h = await deskHarness('npx');
    expect(h.desk.view()).toMatchObject({ state: 'available', latest: '0.5.6', installable: true });
  });

  it('Update now stages the version the registry named, then Restart now hands over', async () => {
    const h = await deskHarness('npx');
    const first = h.desk.startInstall?.();
    expect(first?.state).toBe('downloading');
    await vi_wait(() => h.u.phase() === 'ready');
    expect(h.desk.view()).toMatchObject({ state: 'ready', latest: '0.5.6', installable: true });
    const restarting = h.desk.restart?.();
    expect(restarting?.state).toBe('restarting');
    expect(h.restarts).toEqual([]);
    h.flush();
    expect(h.restarts).toEqual([1]);
  });

  it('Restart now before the update is ready does nothing', async () => {
    const h = await deskHarness('npx');
    expect(h.desk.restart?.()?.state).toBe('available');
    h.flush();
    expect(h.restarts).toEqual([]);
  });

  it('a restart nobody could take: back to ready', async () => {
    const h = await deskHarness('installer');
    h.desk.startInstall?.();
    await vi_wait(() => h.u.phase() === 'ready');
    h.refuse();
    h.desk.restart?.();
    h.flush();
    expect(h.desk.view()?.state).toBe('ready');
  });

  it('a failed update: install_failed (the page shows the steps instead)', async () => {
    const h = await deskHarness('npx');
    const failing = new BrowserUpdater({
      home: await tempHome(),
      execPath: NODE,
      npmCli: NPM,
      install: 'npx',
      script: '/x/_npx/a/node_modules/@4thtech-io/agentlink/dist/agentlink.js',
      run: fakeNpm({ installCode: 1 }).run,
    });
    const checker = new NpmUpdateChecker({
      currentVersion: '0.5.5',
      enabled: true,
      fetch: latest('0.5.6'),
    });
    await checker.check();
    const desk = browserUpdateDeskWith(checker, 'npx', failing, {
      requestRestart: () => true,
      later: () => undefined,
    });
    desk.startInstall?.();
    await vi_wait(() => failing.phase() === 'failed');
    expect(desk.view()).toMatchObject({
      state: 'install_failed',
      latest: '0.5.6',
      installable: false,
    });
    void h;
  });

  it('a global install this user cannot write: not installable (the command fallback)', async () => {
    const h = await deskHarness('global', false);
    expect(h.desk.view()).toMatchObject({ state: 'available', installable: false });
    expect(h.desk.startInstall?.()?.state).toBe('available');
    expect(h.npm.calls).toEqual([]);
  });
});

describe('relaunch (the new version takes over this terminal)', () => {
  it('starts node with the staged entry and `ui`, stdio inherited, no shell; returns its exit code', async () => {
    const seen: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    const code = await relaunch(
      { file: NODE, args: ['/h/.agentlink/updates/0.5.6/x/agentlink.js', 'ui'] },
      ((file: string, args: readonly string[], options: object) => {
        seen.push({ file, args, options: options as Record<string, unknown> });
        const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
        child.kill = () => true;
        setTimeout(() => child.emit('exit', 0, null), 1);
        return child;
      }) as never,
      proc,
    );
    expect(code).toBe(0);
    expect(seen[0]?.file).toBe(NODE);
    expect(seen[0]?.args).toEqual(['/h/.agentlink/updates/0.5.6/x/agentlink.js', 'ui']);
    expect(seen[0]?.options['shell']).toBe(false);
    expect(seen[0]?.options['stdio']).toBe('inherit');
  });

  it('a child that cannot start: undefined', async () => {
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    const code = await relaunch(
      { file: NODE, args: ['x', 'ui'] },
      (() => {
        const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
        child.kill = () => true;
        setTimeout(() => child.emit('error', new Error('ENOENT')), 1);
        return child;
      }) as never,
      proc,
    );
    expect(code).toBeUndefined();
  });
});

async function vi_wait(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(done()).toBe(true);
}
