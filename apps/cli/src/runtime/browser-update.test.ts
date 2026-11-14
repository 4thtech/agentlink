// BROWSER-UPDATE: "Update now" and "Restart now" in the browser app (the local app server that
// `agentlink`, the installers' launcher or npx start). Before installing, the registry's document
// for the exact version must carry this repository's provenance for the same sha512; npm runs by
// argv (never a shell) with no inherited npm configuration, scripts off; the lockfile must be all
// public-registry sha512 entries; `npm audit signatures` must pass. Restart now hands over to the
// staged copy (the old host closes first) after checking the staged files again.
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NPM_REGISTRY,
  PACKAGE_NAME,
  PROVENANCE,
  STAGED_ENTRY,
  BrowserUpdater,
  attestationsUrl,
  browserUpdateDeskWith,
  checkLockfile,
  checkProvenance,
  checkVersionDoc,
  execFileRunner,
  findNpmCli,
  installArgs,
  integrityHex,
  packageSpec,
  parseAuditSignatures,
  relaunch,
  updateEnv,
  verifyArgs,
  versionDocUrl,
  type Runner,
} from './browser-update.js';
import { NpmUpdateChecker, type RegistryFetch } from './npm-update-check.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const NPM = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
const NODE = '/opt/node/bin/node';
/** A stand-in sha512 integrity (64 bytes, as a real one). */
const SRI = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const OTHER_SRI = `sha512-${Buffer.alloc(64, 9).toString('base64')}`;

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});
async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'al-browser-update-'));
  homes.push(home);
  return home;
}

/** The registry's document for `v` (as registry.npmjs.org serves it). */
function versionDoc(v: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: PACKAGE_NAME,
    version: v,
    dist: {
      tarball: `https://registry.npmjs.org/@4thtech-io/agentlink/-/agentlink-${v}.tgz`,
      integrity: SRI,
      attestations: {
        url: `https://registry.npmjs.org/-/npm/v1/attestations/@4thtech-io%2fagentlink@${v}`,
        provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
      },
      ...((over['dist'] as object | undefined) ?? {}),
    },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'dist')),
  };
}

/** The attestations document for `v`: a publish attestation and the SLSA provenance. */
function attestations(
  v: string,
  over: { readonly repository?: string; readonly sha512?: string; readonly name?: string } = {},
): Record<string, unknown> {
  const statement = (predicateType: string, predicate: unknown) => ({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: over.name ?? `pkg:npm/%404thtech-io/agentlink@${v}`,
        digest: { sha512: over.sha512 ?? integrityHex(SRI) },
      },
    ],
    predicateType,
    predicate,
  });
  const wrap = (predicateType: string, body: unknown) => ({
    predicateType,
    bundle: {
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: {},
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: Buffer.from(JSON.stringify(body)).toString('base64'),
        signatures: [],
      },
    },
  });
  return {
    attestations: [
      wrap(
        'https://github.com/npm/attestation/tree/main/specs/publish/v0.1',
        statement('https://github.com/npm/attestation/tree/main/specs/publish/v0.1', {}),
      ),
      wrap(
        PROVENANCE.predicateType,
        statement(PROVENANCE.predicateType, {
          buildDefinition: {
            externalParameters: {
              workflow: {
                ref: 'refs/heads/main',
                repository: over.repository ?? 'https://github.com/4thtech/agentlink',
                path: '.github/workflows/release.yml',
              },
            },
          },
        }),
      ),
    ],
  };
}

/** A lockfile as npm writes it for the staged folder. */
function lockfile(v: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'staged',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { dependencies: { [PACKAGE_NAME]: `^${v}` } },
      'node_modules/@4thtech-io/agentlink': {
        version: v,
        resolved: `https://registry.npmjs.org/@4thtech-io/agentlink/-/agentlink-${v}.tgz`,
        integrity: SRI,
      },
      'node_modules/zod': {
        version: '4.6.7',
        resolved: 'https://registry.npmjs.org/zod/-/zod-4.6.7.tgz',
        integrity: OTHER_SRI,
      },
      ...extra,
    },
  });
}

/** The registry reads: the version document and the attestations, nothing else. */
function registry(
  doc: (v: string) => unknown = (v) => versionDoc(v),
  att: (v: string) => unknown = (v) => attestations(v),
) {
  const urls: string[] = [];
  const fetchImpl: RegistryFetch = (url, init) => {
    urls.push(url);
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    const v = /agentlink[/@]([0-9.]+)$/.exec(url)?.[1] ?? '';
    const body = url === versionDocUrl(v) ? doc(v) : url === attestationsUrl(v) ? att(v) : null;
    return Promise.resolve(
      body === null
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 }),
    );
  };
  return { fetchImpl, urls };
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

describe('the npm argv (no shell, no user strings, no npmrc)', () => {
  const spec = '@4thtech-io/agentlink@0.5.6';
  const npmrc = {
    user: '/h/.agentlink/updates/0.5.6/empty-user-npmrc',
    global: '/h/.agentlink/updates/0.5.6/empty-global-npmrc',
  };
  const pair = (args: readonly string[], flag: string): readonly string[] =>
    args.slice(args.indexOf(flag), args.indexOf(flag) + 2);

  it('install: the fixed spec, scripts off, TLS checked, a lockfile, the public registry', () => {
    const args = installArgs(NPM, '/h/.agentlink/updates/0.5.6', spec, npmrc);
    expect(args[0]).toBe(NPM);
    expect(args[1]).toBe('install');
    expect(args).toContain(spec);
    for (const flag of [
      '--ignore-scripts',
      '--omit=dev',
      '--strict-ssl=true',
      '--package-lock=true',
    ]) {
      expect(args).toContain(flag);
    }
    expect(pair(args, '--prefix')).toEqual(['--prefix', '/h/.agentlink/updates/0.5.6']);
    expect(pair(args, '--registry')).toEqual(['--registry', NPM_REGISTRY]);
    expect(pair(args, '--userconfig')).toEqual(['--userconfig', npmrc.user]);
    expect(pair(args, '--globalconfig')).toEqual(['--globalconfig', npmrc.global]);
    expect(args).toContain(`--@4thtech-io:registry=${NPM_REGISTRY}`);
    expect(args.filter((a) => a.includes('@4thtech-io/agentlink'))).toEqual([spec]);
  });

  it('verify: npm audit signatures as JSON with the same empty configuration', () => {
    const args = verifyArgs(NPM, '/h/.agentlink/updates/0.5.6', npmrc);
    expect(args.slice(0, 3)).toEqual([NPM, 'audit', 'signatures']);
    expect(args).toContain('--json');
    expect(args).toContain('--strict-ssl=true');
    expect(pair(args, '--userconfig')).toEqual(['--userconfig', npmrc.user]);
    expect(pair(args, '--globalconfig')).toEqual(['--globalconfig', npmrc.global]);
    expect(args).toContain(NPM_REGISTRY);
  });

  it('the environment carries no inherited npm configuration at all', () => {
    const env = updateEnv({
      PATH: '/bin',
      HOME: '/h',
      npm_config_registry: 'https://evil.example/',
      'npm_config_@noble:registry': 'https://evil.example/',
      NPM_CONFIG_REGISTRY: 'https://evil.example/',
      npm_config_userconfig: '/tmp/evil-npmrc',
      NPM_CONFIG_GLOBALCONFIG: '/tmp/evil-npmrc',
      npm_config_strict_ssl: 'false',
      npm_config_ignore_scripts: 'false',
    });
    expect(
      Object.keys(env)
        .filter((k) => k.toLowerCase().startsWith('npm_config_'))
        .sort(),
    ).toEqual(['npm_config_ignore_scripts', 'npm_config_update_notifier']);
    expect(env['npm_config_ignore_scripts']).toBe('true');
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

describe('checkVersionDoc (provenance must be published for the exact version)', () => {
  const doc = (d: unknown): Uint8Array => enc(JSON.stringify(d));
  it('the integrity of a document with SLSA provenance at the expected URL', () => {
    expect(checkVersionDoc(doc(versionDoc('0.5.6')), '0.5.6')).toBe(SRI);
    expect(versionDocUrl('0.5.6')).toBe('https://registry.npmjs.org/@4thtech-io%2fagentlink/0.5.6');
  });

  it.each([
    ['another version', versionDoc('0.5.7')],
    ['another name', versionDoc('0.5.6', { name: '@evil/agentlink' })],
    ['no attestations', versionDoc('0.5.6', { dist: { attestations: undefined } })],
    [
      'no provenance',
      versionDoc('0.5.6', {
        dist: { attestations: { url: attestationsUrl('0.5.6') } },
      }),
    ],
    [
      'attestations elsewhere',
      versionDoc('0.5.6', {
        dist: {
          attestations: {
            url: 'https://evil.example/a',
            provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
          },
        },
      }),
    ],
    ['a sha1 only', versionDoc('0.5.6', { dist: { integrity: 'sha1-abc' } })],
    [
      'a tarball elsewhere',
      versionDoc('0.5.6', { dist: { tarball: 'https://evil.example/x.tgz' } }),
    ],
  ])('refuses %s', (_label, d) => {
    expect(checkVersionDoc(doc(d), '0.5.6')).toBeUndefined();
  });
});

describe('checkProvenance (this repository built exactly these bytes)', () => {
  const att = (a: unknown): Uint8Array => enc(JSON.stringify(a));
  it('passes for this repository’s release workflow and the same sha512', () => {
    expect(checkProvenance(att(attestations('0.5.6')), '0.5.6', SRI)).toBe(true);
  });

  it.each([
    [
      'another repository',
      attestations('0.5.6', { repository: 'https://github.com/evil/agentlink' }),
    ],
    ['other bytes', attestations('0.5.6', { sha512: integrityHex(OTHER_SRI) })],
    ['another package', attestations('0.5.6', { name: 'pkg:npm/evil@0.5.6' })],
    ['another version', attestations('0.5.7')],
    ['no provenance', { attestations: [] }],
    ['not JSON', 'nope'],
  ])('refuses %s', (_label, a) => {
    expect(checkProvenance(att(a), '0.5.6', SRI)).toBe(false);
  });
});

describe('checkLockfile (every package from the public registry, with sha512)', () => {
  it('passes for npm’s lockfile of the staged folder', () => {
    expect(checkLockfile(lockfile('0.5.6'), '0.5.6', SRI)).toBe(true);
  });

  it.each([
    [
      'a dependency from another registry',
      lockfile('0.5.6', {
        'node_modules/@noble/hashes': {
          version: '2.4.0',
          resolved: 'https://evil.example/@noble/hashes/-/hashes-2.4.0.tgz',
          integrity: OTHER_SRI,
        },
      }),
    ],
    [
      'a look-alike host',
      lockfile('0.5.6', {
        'node_modules/x': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org.evil.example/x.tgz',
          integrity: OTHER_SRI,
        },
      }),
    ],
    [
      'no integrity',
      lockfile('0.5.6', {
        'node_modules/x': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz',
        },
      }),
    ],
    [
      'a sha1 integrity',
      lockfile('0.5.6', {
        'node_modules/x': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz',
          integrity: 'sha1-abc=',
        },
      }),
    ],
    ['a link', lockfile('0.5.6', { 'node_modules/x': { resolved: '../x', link: true } })],
    [
      'an entry outside the staged folder',
      lockfile('0.5.6', {
        '../../elsewhere/node_modules/x': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz',
          integrity: OTHER_SRI,
        },
      }),
    ],
    [
      'a git dependency',
      lockfile('0.5.6', { 'node_modules/x': { resolved: 'git+ssh://x', integrity: OTHER_SRI } }),
    ],
  ])('refuses %s', (_label, text) => {
    expect(checkLockfile(text, '0.5.6', SRI)).toBe(false);
  });

  it('refuses our package at another version or with other bytes', () => {
    expect(checkLockfile(lockfile('0.5.6'), '0.5.7', SRI)).toBe(false);
    expect(checkLockfile(lockfile('0.5.6'), '0.5.6', OTHER_SRI)).toBe(false);
    expect(checkLockfile('{"packages":{}}', '0.5.6', SRI)).toBe(false);
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

/** A fake npm: `install` writes the package and lockfile; `audit signatures` answers. */
function fakeNpm(
  options: {
    readonly installCode?: number;
    readonly auditOut?: string;
    readonly writeVersion?: string;
    readonly lock?: (v: string) => string;
  } = {},
) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const run: Runner = async (file, args) => {
    calls.push({ file, args });
    if (args[1] === 'install') {
      const prefix = args[args.indexOf('--prefix') + 1] ?? '';
      const spec = args.find((a) => a.startsWith('@4thtech-io/agentlink@')) ?? '';
      const asked = spec.slice('@4thtech-io/agentlink@'.length);
      const version = options.writeVersion ?? asked;
      const root = join(prefix, 'node_modules', '@4thtech-io', 'agentlink');
      await mkdir(join(root, 'dist'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version }));
      await writeFile(join(root, 'dist', 'agentlink.js'), '// cli\n');
      await writeFile(join(prefix, 'package-lock.json'), (options.lock ?? lockfile)(asked));
      return { code: options.installCode ?? 0, stdout: new Uint8Array(0) };
    }
    return { code: 0, stdout: enc(options.auditOut ?? '{"invalid":[],"missing":[]}') };
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
    fetch: registry().fetchImpl,
    ...extra,
  });
}

describe('BrowserUpdater.stage', () => {
  it('provenance first, then install, lockfile and audit through node + npm-cli.js; then ready', async () => {
    const home = await tempHome();
    const npm = fakeNpm();
    const reg = registry();
    const u = updater(home, npm.run, { fetch: reg.fetchImpl });
    expect(u.canInstall()).toBe(true);
    await expect(u.stage('0.5.6')).resolves.toBe(true);
    expect(reg.urls).toEqual([versionDocUrl('0.5.6'), attestationsUrl('0.5.6')]);
    expect(npm.calls.map((c) => [c.file, c.args[1], c.args[2]])).toEqual([
      [NODE, 'install', '@4thtech-io/agentlink@0.5.6'],
      [NODE, 'audit', 'signatures'],
    ]);
    expect(npm.calls.every((c) => c.args[0] === NPM)).toBe(true);
    // The real path: npm and the lockfile see the staged folder where it really is.
    const dir = join(await realpath(home), '.agentlink', 'updates', '0.5.6');
    const npmrc = npm.calls[0]?.args[npm.calls[0].args.indexOf('--userconfig') + 1] ?? '';
    const globalrc = npm.calls[0]?.args[npm.calls[0].args.indexOf('--globalconfig') + 1] ?? '';
    expect(npmrc.startsWith(dir)).toBe(true);
    expect(globalrc.startsWith(dir)).toBe(true);
    expect(globalrc).not.toBe(npmrc);
    expect(await readFile(npmrc, 'utf8')).toBe('');
    expect(await readFile(globalrc, 'utf8')).toBe('');
    expect(u.phase()).toBe('ready');
    expect(await u.launch()).toEqual({ file: NODE, args: [join(dir, ...STAGED_ENTRY), 'ui'] });
    if (process.platform !== 'win32') {
      expect((await stat(join(home, '.agentlink', 'updates'))).mode & 0o777).toBe(0o700);
    }
  });

  it('a version that is not plain x.y.z reads and runs nothing', async () => {
    const home = await tempHome();
    const npm = fakeNpm();
    const reg = registry();
    const u = updater(home, npm.run, { fetch: reg.fetchImpl });
    await expect(u.stage('0.5.6 --global')).resolves.toBe(false);
    await expect(u.stage('latest')).resolves.toBe(false);
    expect(npm.calls).toEqual([]);
    expect(reg.urls).toEqual([]);
    expect(await u.launch()).toBeUndefined();
  });

  it.each([
    [
      'the version has no provenance',
      registry((v) => versionDoc(v, { dist: { attestations: undefined } })),
    ],
    [
      'the provenance names another repository',
      registry(undefined, (v) => attestations(v, { repository: 'https://github.com/evil/x' })),
    ],
    [
      'the provenance is for other bytes',
      registry(undefined, (v) => attestations(v, { sha512: '00' })),
    ],
    ['the registry does not answer', registry(() => null)],
  ])('%s: nothing is installed', async (_label, reg) => {
    const home = await tempHome();
    const npm = fakeNpm();
    const u = updater(home, npm.run, { fetch: reg.fetchImpl });
    await expect(u.stage('0.5.6')).resolves.toBe(false);
    expect(u.phase()).toBe('failed');
    expect(npm.calls).toEqual([]);
  });

  it.each([
    ['the install fails', { installCode: 1 }],
    [
      'a dependency came from another registry',
      {
        lock: (v: string) =>
          lockfile(v, {
            'node_modules/@noble/hashes': {
              version: '2.4.0',
              resolved: 'https://evil.example/hashes-2.4.0.tgz',
              integrity: OTHER_SRI,
            },
          }),
      },
    ],
    ['a signature is invalid', { auditOut: '{"invalid":[{"name":"x"}],"missing":[]}' }],
    ['a signature is missing', { auditOut: '{"invalid":[],"missing":[{"name":"x"}]}' }],
    ['the audit answer is unreadable', { auditOut: 'oops' }],
    ['another version was installed', { writeVersion: '0.5.7' }],
  ])('%s: failed, the staged folder removed, nothing to launch', async (_label, options) => {
    const home = await tempHome();
    const u = updater(home, fakeNpm(options).run);
    await expect(u.stage('0.5.6')).resolves.toBe(false);
    expect(u.phase()).toBe('failed');
    expect(await u.launch()).toBeUndefined();
    await expect(stat(join(home, '.agentlink', 'updates', '0.5.6'))).rejects.toThrow();
  });

  it('a foreign lockfile stops before the audit runs', async () => {
    const npm = fakeNpm({ lock: () => '{"packages":{}}' });
    await expect(updater(await tempHome(), npm.run).stage('0.5.6')).resolves.toBe(false);
    expect(npm.calls.map((c) => c.args[1])).toEqual(['install']);
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
    const u = updater(await tempHome(), fakeNpm().run, { npmCli: undefined });
    expect(u.canInstall()).toBe(false);
    await expect(u.stage('0.5.6')).resolves.toBe(false);
  });

  it('a global npm install is never updated from the page (the one command instead)', async () => {
    const npm = fakeNpm();
    const u = updater(await tempHome(), npm.run, {
      install: 'global',
      script: '/Users/me/.npm-global/lib/node_modules/@4thtech-io/agentlink/dist/agentlink.js',
    });
    expect(u.canInstall()).toBe(false);
    await expect(u.stage('0.5.6')).resolves.toBe(false);
    expect(npm.calls).toEqual([]);
  });

  it('Restart now checks the staged files again: a swapped entry launches nothing', async () => {
    if (process.platform === 'win32') return;
    const home = await tempHome();
    const u = updater(home, fakeNpm().run);
    await expect(u.stage('0.5.6')).resolves.toBe(true);
    const entry = join(home, '.agentlink', 'updates', '0.5.6', ...STAGED_ENTRY);
    const elsewhere = join(await tempHome(), 'evil.js');
    await writeFile(elsewhere, '// evil\n');
    await rm(entry);
    await symlink(elsewhere, entry);
    expect(await u.launch()).toBeUndefined();
    expect(u.phase()).toBe('failed');
  });

  it('Restart now checks the version again: a changed package.json launches nothing', async () => {
    const home = await tempHome();
    const u = updater(home, fakeNpm().run);
    await expect(u.stage('0.5.6')).resolves.toBe(true);
    const pkg = join(
      home,
      '.agentlink',
      'updates',
      '0.5.6',
      ...STAGED_ENTRY.slice(0, 3),
      'package.json',
    );
    await writeFile(pkg, JSON.stringify({ name: PACKAGE_NAME, version: '9.9.9' }));
    expect(await u.launch()).toBeUndefined();
  });

  it('an older staged version is removed once the new one is ready', async () => {
    const home = await tempHome();
    const old = join(home, '.agentlink', 'updates', '0.5.5');
    await mkdir(old, { recursive: true });
    await writeFile(join(old, 'package.json'), '{}');
    await expect(updater(home, fakeNpm().run).stage('0.5.6')).resolves.toBe(true);
    await expect(stat(old)).rejects.toThrow();
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

async function deskHarness(install: 'npx' | 'global' | 'installer' = 'npx') {
  const home = await tempHome();
  const checker = new NpmUpdateChecker({
    currentVersion: '0.5.5',
    enabled: true,
    fetch: latest('0.5.6'),
  });
  await checker.check();
  const npm = fakeNpm();
  const u = updater(home, npm.run, { install });
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
    const failing = updater(await tempHome(), fakeNpm({ installCode: 1 }).run);
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
  });

  it('a global npm install: not installable (the command fallback)', async () => {
    const h = await deskHarness('global');
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
