// BROWSER-UPDATE (08 §1 "Updating the browser app"; 04 §4, §6; I-4, I-7): "Update now" and
// "Restart now" in the browser app, the local app server that `agentlink ui`, the installers'
// launcher or npx start. The desktop apps keep their own updater (apps/desktop); nothing here runs
// there. A global npm install is never updated from the page: it keeps the one update command.
//
// Update now (stage), each step must pass or the staged folder is removed and nothing can launch:
// 1. The version is the one the registry's `latest` dist-tag named (npm-update-check.ts), checked
//    again as plain x.y.z (packageSpec). The spec is the fixed name plus that version: nothing from
//    the page, the person or an inbound message goes into an argument, a URL, a path or the
//    environment.
// 2. Provenance, before anything is installed: the registry's document for exactly that version
//    (one fixed HTTPS URL, no redirects, no credentials, a byte cap, a timeout) must name the
//    expected tarball URL, a sha512 `integrity` and a SLSA v1 provenance attestation at the expected
//    URL. That attestation's statement (fetched the same way) must name exactly this package and
//    version, the same sha512 as `integrity`, and the build workflow
//    https://github.com/4thtech/agentlink `.github/workflows/release.yml` on `refs/heads/main`.
//    This step reads the statement; its Sigstore signature is checked by step 5 (npm verifies the
//    attestation bundle npm publishes for the installed package).
// 3. npm runs as `node <npm-cli.js> …` (the npm that ships with this Node, next to
//    process.execPath) through `execFile`, `shell: false`, with a clean environment (every inherited
//    `npm_config_*` dropped) and an empty user and global npmrc we write, so no npmrc can redirect
//    any package or scope. `npm install` into `~/.agentlink/updates/<version>` (0700, never through
//    a link) with `--ignore-scripts` (no install script of any package runs), `--omit=dev`,
//    `--strict-ssl=true`, `--package-lock=true` and the public registry. npm checks every tarball
//    against the sha512 in the registry's metadata.
// 4. The lockfile npm wrote: every package `resolved` from https://registry.npmjs.org/ with a sha512
//    `integrity`, no links; this package at exactly that version with the integrity of step 2.
// 5. `npm audit signatures --json` (same clean configuration): every installed package's registry
//    signature and every published attestation (Sigstore) must verify; anything invalid or missing,
//    or an answer that is not exactly that JSON, fails.
// 6. The installed package.json names this package at exactly that version; its entry is a plain
//    file, no link on the way (checked again at Restart now).
//
// Restart now (relaunch, ui.ts): this host stops like a yield (APP-CONTINUITY): its server closes
// (the open ID's store and keys with it) and its app-host.json goes, so there is no port clash and
// never a second owner; then this process runs the staged entry (`node <entry> ui`) in the same
// terminal (stdio inherited, so the owner-terminal check, Ctrl+C and the idle limit work as
// before), waits for it and exits with its code. The new version opens Home in a new browser tab
// with a fresh one-shot link. AI apps whose MCP entry runs `npx …@latest` pick up the new version
// when they start again (the page says so in fixed text).
//
// Never: from an MCP tool (no tool, and the MCP server's page has no desk: 501), without the page's
// session, CSRF and Origin (the mark gate), in a development build (no check, no offer). Nothing of
// npm's output or the registry's answers is shown, logged or stored beyond the checks above.
import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
  type ChildProcess,
} from 'node:child_process';
import { constants, lstatSync, statSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, posix as pathPosix, win32 as pathWin32, sep } from 'node:path';
import process from 'node:process';
import { parseJson } from '@4thtech-io/crypto';
import type { AppUpdateView, LocalUiAppUpdateDesk } from '@4thtech-io/node';
import {
  readCapped,
  type BrowserInstall,
  type NpmUpdateChecker,
  type RegistryFetch,
} from './npm-update-check.js';

export const PACKAGE_NAME = '@4thtech-io/agentlink';
export const NPM_REGISTRY = 'https://registry.npmjs.org/';
const SCOPE_REGISTRY = `--@4thtech-io:registry=${NPM_REGISTRY}`;
/** Under ~/.agentlink. */
export const UPDATES_DIR = 'updates';
/** The two empty npmrc files written into the staged folder (npm refuses one file for both). */
export const EMPTY_NPMRC = Object.freeze({
  user: 'empty-user-npmrc',
  global: 'empty-global-npmrc',
});
/** The npmrc files npm is pointed at (both empty). */
export interface NpmrcFiles {
  readonly user: string;
  readonly global: string;
}
/** The published CLI entry inside a staged folder (apps/cli package.json `bin`). */
export const STAGED_ENTRY: readonly string[] = Object.freeze([
  'node_modules',
  '@4thtech-io',
  'agentlink',
  'dist',
  'agentlink.js',
]);
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
export const VERIFY_TIMEOUT_MS = 5 * 60_000;
export const FETCH_TIMEOUT_MS = 30_000;
/** The audit's JSON answer is small; anything larger is not one. */
const MAX_AUDIT_BYTES = 256 * 1024;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_VERSION_DOC_BYTES = 256 * 1024;
const MAX_ATTESTATIONS_BYTES = 1024 * 1024;
const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024;
/** Restart now answers first; the host stops this long after. */
export const RESTART_DELAY_MS = 300;

/** The provenance every release must carry (apps/cli package.json publishConfig.provenance). */
export const PROVENANCE = Object.freeze({
  predicateType: 'https://slsa.dev/provenance/v1',
  repository: 'https://github.com/4thtech/agentlink',
  workflow: '.github/workflows/release.yml',
  ref: 'refs/heads/main',
});

const NUM = '(0|[1-9][0-9]{0,5})';
const RELEASE_VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const isRelease = (v: unknown): v is string => typeof v === 'string' && RELEASE_VERSION.test(v);
const SHA512_SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** `@4thtech-io/agentlink@x.y.z` for a plain release version; undefined for anything else. */
export function packageSpec(version: unknown): string | undefined {
  return isRelease(version) ? `${PACKAGE_NAME}@${version}` : undefined;
}

/** The registry's document for exactly that version (fixed form). */
export const versionDocUrl = (version: string): string =>
  `${NPM_REGISTRY}@4thtech-io%2fagentlink/${version}`;
const tarballUrl = (version: string): string =>
  `${NPM_REGISTRY}@4thtech-io/agentlink/-/agentlink-${version}.tgz`;
/** The attestations of exactly that version (fixed form). */
export const attestationsUrl = (version: string): string =>
  `${NPM_REGISTRY}-/npm/v1/attestations/@4thtech-io%2fagentlink@${version}`;

/** The npm configuration every run gets: an empty npmrc, TLS checked, the public registry. */
const config = (npmrc: NpmrcFiles): readonly string[] => [
  '--userconfig',
  npmrc.user,
  '--globalconfig',
  npmrc.global,
  '--strict-ssl=true',
  '--no-update-notifier',
  '--registry',
  NPM_REGISTRY,
  SCOPE_REGISTRY,
];

/** `npm install` of the spec into the staging folder (argv for `node`). */
export function installArgs(
  npmCli: string,
  prefix: string,
  spec: string,
  npmrc: NpmrcFiles,
): readonly string[] {
  return [
    npmCli,
    'install',
    spec,
    '--prefix',
    prefix,
    '--ignore-scripts',
    '--omit=dev',
    '--package-lock=true',
    '--no-audit',
    '--no-fund',
    ...config(npmrc),
  ];
}

/** `npm audit signatures` of the staging folder (argv for `node`). */
export function verifyArgs(npmCli: string, prefix: string, npmrc: NpmrcFiles): readonly string[] {
  return [npmCli, 'audit', 'signatures', '--json', '--prefix', prefix, ...config(npmrc)];
}

/** The environment npm runs with: no inherited npm configuration at all, scripts off. */
export function updateEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.toLowerCase().startsWith('npm_config_')) continue;
    out[key] = value;
  }
  out['npm_config_ignore_scripts'] = 'true';
  out['npm_config_update_notifier'] = 'false';
  return out;
}

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const decodeJson = (bytes: Uint8Array, max: number): unknown => {
  if (bytes.length === 0 || bytes.length > max) return undefined;
  try {
    return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim());
  } catch {
    return undefined;
  }
};

/** True only for the audit's JSON with an empty `invalid` and an empty `missing` list. */
export function parseAuditSignatures(bytes: Uint8Array): boolean {
  const value = decodeJson(bytes, MAX_AUDIT_BYTES);
  if (!isObject(value)) return false;
  const { invalid, missing } = value;
  return (
    Array.isArray(invalid) && invalid.length === 0 && Array.isArray(missing) && missing.length === 0
  );
}

/**
 * The registry's version document: the sha512 `integrity` when it names exactly this package and
 * version, the expected tarball and a SLSA v1 provenance attestation at the expected URL.
 */
export function checkVersionDoc(bytes: Uint8Array, version: string): string | undefined {
  const doc = decodeJson(bytes, MAX_VERSION_DOC_BYTES);
  if (!isObject(doc) || doc['name'] !== PACKAGE_NAME || doc['version'] !== version)
    return undefined;
  const dist = doc['dist'];
  if (!isObject(dist) || dist['tarball'] !== tarballUrl(version)) return undefined;
  const integrity = dist['integrity'];
  if (typeof integrity !== 'string' || !SHA512_SRI.test(integrity)) return undefined;
  const attestations = dist['attestations'];
  if (!isObject(attestations) || attestations['url'] !== attestationsUrl(version)) return undefined;
  const provenance = attestations['provenance'];
  if (!isObject(provenance) || provenance['predicateType'] !== PROVENANCE.predicateType) {
    return undefined;
  }
  return integrity;
}

/** The hex of a `sha512-<base64>` integrity. */
export function integrityHex(integrity: string): string {
  return Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
}

/**
 * The provenance statement: exactly one subject (this package at this version, the sha512 of
 * `integrity`), built by this repository's release workflow on main.
 */
export function checkProvenance(bytes: Uint8Array, version: string, integrity: string): boolean {
  const doc = decodeJson(bytes, MAX_ATTESTATIONS_BYTES);
  if (!isObject(doc) || !Array.isArray(doc['attestations'])) return false;
  const found = (doc['attestations'] as unknown[]).filter(
    (a) => isObject(a) && a['predicateType'] === PROVENANCE.predicateType,
  );
  if (found.length !== 1) return false;
  const bundle = (found[0] as Readonly<Record<string, unknown>>)['bundle'];
  const envelope = isObject(bundle) ? bundle['dsseEnvelope'] : undefined;
  if (!isObject(envelope) || envelope['payloadType'] !== 'application/vnd.in-toto+json') {
    return false;
  }
  const payload = envelope['payload'];
  if (typeof payload !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return false;
  const statement = decodeJson(
    new Uint8Array(Buffer.from(payload, 'base64')),
    MAX_ATTESTATIONS_BYTES,
  );
  if (!isObject(statement) || statement['predicateType'] !== PROVENANCE.predicateType) return false;
  const subject = statement['subject'];
  if (!Array.isArray(subject) || subject.length !== 1) return false;
  const only: unknown = subject[0];
  if (!isObject(only) || only['name'] !== `pkg:npm/%404thtech-io/agentlink@${version}`)
    return false;
  const digest = only['digest'];
  if (!isObject(digest) || digest['sha512'] !== integrityHex(integrity)) return false;
  const predicate = statement['predicate'];
  const build = isObject(predicate) ? predicate['buildDefinition'] : undefined;
  const external = isObject(build) ? build['externalParameters'] : undefined;
  const workflow = isObject(external) ? external['workflow'] : undefined;
  return (
    isObject(workflow) &&
    workflow['repository'] === PROVENANCE.repository &&
    workflow['path'] === PROVENANCE.workflow &&
    workflow['ref'] === PROVENANCE.ref
  );
}

/**
 * The lockfile npm wrote: every package from the public registry with a sha512 integrity, no
 * links; this package at exactly `version` with `integrity`.
 */
export function checkLockfile(text: string, version: string, integrity: string): boolean {
  let lock: unknown;
  try {
    lock = parseJson(text);
  } catch {
    return false;
  }
  if (!isObject(lock) || !isObject(lock['packages'])) return false;
  const packages = lock['packages'];
  let ours = false;
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '') continue;
    // Only packages inside the staged folder (never `../…`, an entry outside it).
    if (!key.startsWith('node_modules/') || key.split('/').includes('..')) return false;
    if (!isObject(entry) || entry['link'] !== undefined) return false;
    const resolved = entry['resolved'];
    if (typeof resolved !== 'string' || !resolved.startsWith(NPM_REGISTRY)) return false;
    try {
      if (new URL(resolved).origin !== 'https://registry.npmjs.org') return false;
    } catch {
      return false;
    }
    const sri = entry['integrity'];
    if (typeof sri !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(sri)) return false;
    if (key === 'node_modules/@4thtech-io/agentlink') {
      if (entry['version'] !== version || sri !== integrity) return false;
      if (resolved !== tarballUrl(version)) return false;
      ours = true;
    }
  }
  return ours;
}

const defaultIsFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The npm CLI that ships with this Node (never one found on PATH). */
export function findNpmCli(
  execPath: string,
  platform: NodeJS.Platform = process.platform,
  isFile: (path: string) => boolean = defaultIsFile,
): string | undefined {
  const p = platform === 'win32' ? pathWin32 : pathPosix;
  const bin = p.dirname(execPath);
  const candidate =
    platform === 'win32'
      ? p.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : p.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return isFile(candidate) ? candidate : undefined;
}

export interface RunResult {
  /** The exit code (null: ended by a signal or the timeout). */
  readonly code: number | null;
  readonly stdout: Uint8Array;
}
/** Runs `file` with `args`: never through a shell. */
export type Runner = (
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
) => Promise<RunResult>;

type SpawnLike = (
  file: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => ChildProcess;

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: Record<string, unknown>,
  callback: (error: (Error & { code?: unknown }) | null, stdout: Buffer | string) => void,
) => ChildProcess;

/**
 * The production runner: `execFile` (argv, `shell: false`), the update environment, a timeout,
 * stdout capped (a longer answer is a failure), stdin closed. Nothing of the output is logged.
 */
export function execFileRunner(
  execImpl: ExecFileLike = nodeExecFile as unknown as ExecFileLike,
): Runner {
  return (file, args, { cwd, timeoutMs }) =>
    new Promise<RunResult>((resolve) => {
      try {
        const child = execImpl(
          file,
          [...args],
          {
            cwd,
            shell: false,
            windowsHide: true,
            env: updateEnv(process.env),
            timeout: timeoutMs,
            maxBuffer: MAX_AUDIT_BYTES,
            encoding: 'buffer',
          },
          (error, stdout) => {
            const out = typeof stdout === 'string' ? Buffer.from(stdout, 'utf8') : stdout;
            const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
            resolve({ code, stdout: new Uint8Array(out) });
          },
        );
        child.stdin?.end();
      } catch {
        resolve({ code: null, stdout: new Uint8Array(0) });
      }
    });
}

/** One GET of a fixed registry URL: no redirects, no credentials, a byte cap. Never throws. */
async function fetchFixed(
  fetchImpl: RegistryFetch,
  url: string,
  max: number,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Uint8Array | undefined> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return await readCapped(response, max);
  } catch {
    return undefined;
  }
}

const defaultFetch: RegistryFetch = (url, init) =>
  fetch(url, { ...init, headers: { ...init.headers } });

export type UpdaterPhase = 'idle' | 'downloading' | 'verifying' | 'ready' | 'failed';

export interface BrowserUpdaterDeps {
  readonly home: string;
  /** process.execPath: the Node that runs npm and the new version. */
  readonly execPath: string;
  /** findNpmCli(execPath); undefined: nothing can be installed here. */
  readonly npmCli: string | undefined;
  readonly install: BrowserInstall;
  /** process.argv[1]. */
  readonly script: string | undefined;
  readonly run: Runner;
  /** The registry reads (default: fetch). */
  readonly fetch?: RegistryFetch;
}

/** Reads a small regular file (never through a link), or undefined. */
async function readSmall(path: string, max: number): Promise<string | undefined> {
  try {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > max) return undefined;
      const buffer = Buffer.alloc(max + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > max) return undefined;
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Stages one verified version; one at a time. */
export class BrowserUpdater {
  readonly #deps: BrowserUpdaterDeps;
  #phase: UpdaterPhase = 'idle';
  #version = '';
  #dir: string | undefined;
  #running: Promise<boolean> | undefined;

  constructor(deps: BrowserUpdaterDeps) {
    this.#deps = deps;
  }

  phase(): UpdaterPhase {
    return this.#phase;
  }

  /** The version being staged or staged ('' before any). */
  version(): string {
    return this.#version;
  }

  /** Whether Update now can run here (else the page shows the one command). */
  canInstall(): boolean {
    // A global npm install keeps its own command (it is never changed from the page).
    return this.#deps.npmCli !== undefined && this.#deps.install !== 'global';
  }

  /** Update now: stages `version`. True once it is ready to launch. Never throws. */
  stage(version: string): Promise<boolean> {
    if (this.#running !== undefined) return this.#running;
    const running = this.#stage(version).catch(() => this.#fail(undefined));
    this.#running = running;
    void running.finally(() => {
      if (this.#running === running) this.#running = undefined;
    });
    return running;
  }

  async #stage(version: string): Promise<boolean> {
    const spec = packageSpec(version);
    const npmCli = this.#deps.npmCli;
    if (spec === undefined || npmCli === undefined || !this.canInstall()) return false;
    this.#version = version;
    this.#dir = undefined;
    this.#phase = 'downloading';
    // Step 2: provenance before anything is installed.
    const fetchImpl = this.#deps.fetch ?? defaultFetch;
    const docBytes = await fetchFixed(fetchImpl, versionDocUrl(version), MAX_VERSION_DOC_BYTES);
    const integrity = docBytes === undefined ? undefined : checkVersionDoc(docBytes, version);
    if (integrity === undefined) return this.#fail(undefined);
    const attBytes = await fetchFixed(fetchImpl, attestationsUrl(version), MAX_ATTESTATIONS_BYTES);
    if (attBytes === undefined || !checkProvenance(attBytes, version, integrity)) {
      return this.#fail(undefined);
    }
    const given = join(this.#deps.home, '.agentlink', UPDATES_DIR);
    let dir: string | undefined;
    try {
      await mkdir(join(this.#deps.home, '.agentlink'), { recursive: true, mode: 0o700 });
      await mkdir(given, { recursive: true, mode: 0o700 });
      const info = await lstat(given);
      // Never through a link (another place would get the code this process then runs).
      if (!info.isDirectory() || info.isSymbolicLink()) return await this.#fail(undefined);
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) await chmod(given, 0o700);
      // The real path (a home behind a link, as /var on macOS): npm names lockfile entries from
      // the real location, and the checks below read exactly what npm wrote.
      const root = await realpath(given);
      dir = join(root, version);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { mode: 0o700 });
      await writeFile(join(dir, 'package.json'), '{"private":true}\n', { mode: 0o600 });
      const npmrc: NpmrcFiles = {
        user: join(dir, EMPTY_NPMRC.user),
        global: join(dir, EMPTY_NPMRC.global),
      };
      await writeFile(npmrc.user, '', { mode: 0o600 });
      await writeFile(npmrc.global, '', { mode: 0o600 });
      const { execPath, run } = this.#deps;
      // Step 3.
      const installed = await run(execPath, installArgs(npmCli, dir, spec, npmrc), {
        cwd: dir,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      if (installed.code !== 0) return await this.#fail(dir);
      this.#phase = 'verifying';
      // Step 4.
      const lock = await readSmall(join(dir, 'package-lock.json'), MAX_LOCKFILE_BYTES);
      if (lock === undefined || !checkLockfile(lock, version, integrity)) {
        return await this.#fail(dir);
      }
      // Step 5.
      const audited = await run(execPath, verifyArgs(npmCli, dir, npmrc), {
        cwd: dir,
        timeoutMs: VERIFY_TIMEOUT_MS,
      });
      if (audited.code !== 0 || !parseAuditSignatures(audited.stdout)) {
        return await this.#fail(dir);
      }
      // Step 6.
      if (!(await stagedOk(dir, version))) return await this.#fail(dir);
      await this.#tidy(root, version);
      this.#dir = dir;
      this.#phase = 'ready';
      return true;
    } catch {
      return this.#fail(dir);
    }
  }

  async #fail(dir: string | undefined): Promise<false> {
    this.#phase = 'failed';
    this.#dir = undefined;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return false;
  }

  /** Removes older staged versions, never the new one or the one this process runs from. */
  async #tidy(root: string, keep: string): Promise<void> {
    const running = this.#deps.script ?? '';
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (name === keep) continue;
      const path = join(root, name);
      if (running.startsWith(path + sep)) continue;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Whether a version is staged and ready (Restart now can be offered). */
  ready(): boolean {
    return this.#phase === 'ready' && this.#dir !== undefined;
  }

  /**
   * Restart now: what to run (`node <entry> ui`), after checking the staged files again (this
   * package at that version, the entry a plain file, no link on the way). Undefined otherwise.
   */
  async launch(): Promise<{ readonly file: string; readonly args: readonly string[] } | undefined> {
    const dir = this.#dir;
    if (!this.ready() || dir === undefined) return undefined;
    if (!(await stagedOk(dir, this.#version))) {
      await this.#fail(dir);
      return undefined;
    }
    return Object.freeze({
      file: this.#deps.execPath,
      args: Object.freeze([join(dir, ...STAGED_ENTRY), 'ui']),
    });
  }
}

/** Step 6: the staged package is this package at `version`; no link from the folder to the entry. */
async function stagedOk(dir: string, version: string): Promise<boolean> {
  const chain: string[] = [dir];
  for (let i = 1; i <= STAGED_ENTRY.length; i += 1)
    chain.push(join(dir, ...STAGED_ENTRY.slice(0, i)));
  for (const [i, part] of chain.entries()) {
    const info = lstatSync(part, { throwIfNoEntry: false });
    if (info === undefined || info.isSymbolicLink()) return false;
    if (i === chain.length - 1 ? !info.isFile() : !info.isDirectory()) return false;
  }
  const text = await readSmall(
    join(dir, ...STAGED_ENTRY.slice(0, 3), 'package.json'),
    MAX_PACKAGE_JSON_BYTES,
  );
  let pkg: unknown;
  try {
    pkg = text === undefined ? undefined : parseJson(text);
  } catch {
    return false;
  }
  return isObject(pkg) && pkg['name'] === PACKAGE_NAME && pkg['version'] === version;
}

/**
 * Restart now, after this host closed: runs the new version in this terminal and waits for it.
 * SIGTERM and SIGHUP sent to this process are passed on; Ctrl+C reaches the new one from the
 * terminal itself (this process ignores it meanwhile). Its exit code, or undefined when it could
 * not start.
 */
export function relaunch(
  launch: { readonly file: string; readonly args: readonly string[] },
  spawnImpl: SpawnLike = nodeSpawn as unknown as SpawnLike,
  proc: NodeJS.Process = process,
): Promise<number | undefined> {
  return new Promise<number | undefined>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(launch.file, [...launch.args], {
        shell: false,
        stdio: 'inherit',
        env: process.env,
      });
    } catch {
      resolve(undefined);
      return;
    }
    const ignore = (): void => undefined;
    const forward = (signal: NodeJS.Signals) => (): void => {
      child.kill(signal);
    };
    const term = forward('SIGTERM');
    const hup = forward('SIGHUP');
    proc.on('SIGINT', ignore);
    proc.on('SIGTERM', term);
    proc.on('SIGHUP', hup);
    let done = false;
    const finish = (code: number | undefined): void => {
      if (done) return;
      done = true;
      proc.off('SIGINT', ignore);
      proc.off('SIGTERM', term);
      proc.off('SIGHUP', hup);
      resolve(code);
    };
    child.on('error', () => finish(undefined));
    child.on('exit', (code: number | null) => finish(code ?? 1));
  });
}

export interface BrowserRestart {
  /** Stops this host for the new version (ui.ts yielders); false when nothing could take it. */
  readonly requestRestart: () => boolean;
  /** Runs `fn` shortly (default: an unref'd RESTART_DELAY_MS timer), so the answer goes out first. */
  readonly later?: (fn: () => void) => void;
}

/**
 * The browser app's desk with Update now and Restart now: the checker's view, overlaid with the
 * updater's phase. `installable` only where the updater can run (a global npm install keeps the
 * one command).
 */
export function browserUpdateDeskWith(
  checker: NpmUpdateChecker,
  install: BrowserInstall,
  updater: BrowserUpdater,
  restart: BrowserRestart,
): LocalUiAppUpdateDesk {
  let restarting = false;
  const later =
    restart.later ??
    ((fn: () => void): void => {
      setTimeout(fn, RESTART_DELAY_MS).unref();
    });
  const view = (): AppUpdateView => {
    const base = checker.view();
    const phase = updater.phase();
    const latest = updater.version();
    const current = base.current;
    const running = (state: AppUpdateView['state']): AppUpdateView =>
      Object.freeze({ state, current, latest, download: '', installable: true, percent: 0 });
    if (phase === 'downloading' || phase === 'verifying') return running(phase);
    if (phase === 'ready') return running(restarting ? 'restarting' : 'ready');
    if (phase === 'failed' && (base.state !== 'available' || base.latest === latest)) {
      return Object.freeze({
        state: 'install_failed',
        current,
        latest,
        download: '',
        installable: false,
        percent: 0,
      });
    }
    if (base.state === 'available') {
      return Object.freeze({ ...base, installable: updater.canInstall(), percent: 0 });
    }
    return base;
  };
  return Object.freeze<LocalUiAppUpdateDesk>({
    install,
    view,
    check: () => {
      const phase = updater.phase();
      if (phase === 'idle' || phase === 'failed') void checker.check().catch(() => undefined);
      return view();
    },
    startInstall: () => {
      const now = view();
      if (
        (now.state === 'available' && now.installable === true) ||
        (now.state === 'install_failed' && updater.canInstall())
      ) {
        void updater.stage(now.latest);
      }
      return view();
    },
    restart: () => {
      if (!updater.ready() || restarting) return view();
      restarting = true;
      later(() => {
        let taken: boolean;
        try {
          taken = restart.requestRestart();
        } catch {
          taken = false;
        }
        if (!taken) restarting = false;
      });
      return view();
    },
    busy: () => false,
  });
}

/** The production updater for this process. */
export function nodeBrowserUpdater(install: BrowserInstall, home: string): BrowserUpdater {
  return new BrowserUpdater({
    home,
    execPath: process.execPath,
    npmCli: findNpmCli(process.execPath),
    install,
    script: process.argv[1],
    run: execFileRunner(),
  });
}
