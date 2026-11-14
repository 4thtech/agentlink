// BROWSER-UPDATE (08 §8; 04 §4, §6; I-4, I-7): "Update now" and "Restart now" in the browser app,
// the local app server that `agentlink ui`, the installers' launcher or npx start. The desktop apps
// keep their own updater (apps/desktop); nothing here runs there.
//
// Update now (stage):
// - The version is the one the registry's `latest` dist-tag named (npm-update-check.ts: one fixed
//   HTTPS URL, no redirects, a byte cap, a timeout) and is checked again here as plain x.y.z
//   (packageSpec). The package spec is the fixed name plus that version: nothing from the page, the
//   person or an inbound message ever goes into an argument, a path or the environment.
// - npm runs as `node <npm-cli.js> …` (the npm that ships with this Node, found next to
//   process.execPath), through `execFile` with `shell: false`: no shell, no PATH lookup, no `.cmd`
//   shim. Only the relaunch uses `spawn` (it needs the terminal inherited; scripts/bundle-check.mjs).
// - Into `~/.agentlink/updates/<version>` (0700, refused when it is a link): `npm install` with
//   `--ignore-scripts` (and npm_config_ignore_scripts=true: no install script of any package runs),
//   `--omit=dev`, and the public registry forced for the package and its scope (an npmrc registry or
//   scoped registry cannot send it elsewhere). A fresh install with no lockfile checks every
//   tarball against the sha512 `integrity` the registry's metadata names.
// - Then `npm audit signatures --json` in that folder: every installed package's ECDSA registry
//   signature, and the Sigstore provenance attestation of every package that has one (ours is
//   published with provenance from this repository's release workflow). Anything invalid or missing,
//   or an answer that is not exactly that JSON, fails the update and removes the folder.
// - Then the installed package must be this package at exactly that version, its entry a plain file
//   (no link). A global npm install is updated in place the same way (`--global --prefix <the prefix
//   it runs from>`, scripts off, from npm's cache the verified install just filled) only when this
//   user can write that prefix; otherwise the page shows the one update command (11 §5).
//
// Restart now (relaunch, ui.ts): this host stops like a yield (APP-CONTINUITY): its server closes and
// its app-host.json goes, so there is no port clash and never a second owner; then this process runs
// the staged entry (`node <entry> ui`) in the same terminal (stdio inherited, so the owner-terminal
// check, Ctrl+C and the idle limit work as before), waits for it and exits with its code. The new
// version opens Home in a new browser tab with a fresh one-shot link (the old tab's session is gone).
// AI apps whose MCP entry runs `npx …@latest` pick up the new version when they start again (the page
// says so in fixed text).
//
// Never: from an MCP tool (no tool, and the MCP server's page has no desk: 501), without the page's
// session, CSRF and Origin (the mark gate), in a development build (no check, no offer). Nothing of
// npm's output is shown, logged or stored; only the audit's two lists are read.
import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
  type ChildProcess,
} from 'node:child_process';
import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix as pathPosix, win32 as pathWin32, sep } from 'node:path';
import process from 'node:process';
import { parseJson } from '@4thtech-io/crypto';
import type { AppUpdateView, LocalUiAppUpdateDesk } from '@4thtech-io/node';
import type { BrowserInstall, NpmUpdateChecker } from './npm-update-check.js';

export const PACKAGE_NAME = '@4thtech-io/agentlink';
export const NPM_REGISTRY = 'https://registry.npmjs.org/';
const SCOPE_REGISTRY = `--@4thtech-io:registry=${NPM_REGISTRY}`;
/** Under ~/.agentlink. */
export const UPDATES_DIR = 'updates';
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
/** The audit's JSON answer is small; anything larger is not one. */
const MAX_AUDIT_BYTES = 256 * 1024;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
/** Restart now answers first; the host stops this long after. */
export const RESTART_DELAY_MS = 300;

const NUM = '(0|[1-9][0-9]{0,5})';
const RELEASE_VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const isRelease = (v: unknown): v is string => typeof v === 'string' && RELEASE_VERSION.test(v);

/** `@4thtech-io/agentlink@x.y.z` for a plain release version; undefined for anything else. */
export function packageSpec(version: unknown): string | undefined {
  return isRelease(version) ? `${PACKAGE_NAME}@${version}` : undefined;
}

const common = (): readonly string[] => [
  '--ignore-scripts',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  '--no-update-notifier',
  '--registry',
  NPM_REGISTRY,
  SCOPE_REGISTRY,
];

/** `npm install` of the spec into the staging folder (argv for `node`). */
export function installArgs(npmCli: string, prefix: string, spec: string): readonly string[] {
  return [npmCli, 'install', spec, '--prefix', prefix, ...common()];
}

/** `npm audit signatures` of the staging folder (argv for `node`). */
export function verifyArgs(npmCli: string, prefix: string): readonly string[] {
  return [
    npmCli,
    'audit',
    'signatures',
    '--json',
    '--prefix',
    prefix,
    '--no-update-notifier',
    '--registry',
    NPM_REGISTRY,
    SCOPE_REGISTRY,
  ];
}

/** The global install in place, at the prefix this copy runs from (argv for `node`). */
export function globalInstallArgs(npmCli: string, prefix: string, spec: string): readonly string[] {
  return [npmCli, 'install', spec, '--global', '--prefix', prefix, '--prefer-offline', ...common()];
}

/** The environment npm runs with: scripts off, no registry overrides, no update notice. */
export function updateEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'npm_config_registry' || /^npm_config_@[^:]*:registry$/.test(lower)) continue;
    if (lower === 'npm_config_ignore_scripts' || lower === 'npm_config_update_notifier') continue;
    out[key] = value;
  }
  out['npm_config_ignore_scripts'] = 'true';
  out['npm_config_update_notifier'] = 'false';
  return out;
}

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** True only for the audit's JSON with an empty `invalid` and an empty `missing` list. */
export function parseAuditSignatures(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.length > MAX_AUDIT_BYTES) return false;
  let value: unknown;
  try {
    value = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim());
  } catch {
    return false;
  }
  if (!isObject(value)) return false;
  const { invalid, missing } = value;
  return (
    Array.isArray(invalid) && invalid.length === 0 && Array.isArray(missing) && missing.length === 0
  );
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

/**
 * The prefix of the global install `script` belongs to, from its layout only
 * (`<prefix>/lib/node_modules/@4thtech-io/agentlink/dist/agentlink.js`; on Windows without `lib`).
 */
export function globalPrefix(
  script: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const p = platform === 'win32' ? pathWin32 : pathPosix;
  const parts = p.normalize(script).split(p.sep);
  const tail = ['node_modules', '@4thtech-io', 'agentlink', 'dist', 'agentlink.js'];
  if (parts.length < tail.length + 1) return undefined;
  const end = parts.slice(-tail.length);
  if (end.some((part, i) => part !== tail[i])) return undefined;
  let head = parts.slice(0, -tail.length);
  if (platform !== 'win32') {
    if (head.at(-1) !== 'lib') return undefined;
    head = head.slice(0, -1);
  }
  const prefix = head.join(p.sep);
  return prefix === '' ? undefined : prefix;
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
  readonly platform?: NodeJS.Platform;
  /** Whether this user may write `path` (default: an access check). */
  readonly writable?: (path: string) => boolean;
}

const defaultWritable = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

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
  #entry: string | undefined;
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

  /** The prefix of a global install this user can write, or undefined. */
  #globalTarget(): string | undefined {
    const { script } = this.#deps;
    if (script === undefined) return undefined;
    const platform = this.#deps.platform ?? process.platform;
    let real = script;
    try {
      real = realpathSync(script);
    } catch {
      // Judged from the path as given.
    }
    const prefix = globalPrefix(real, platform);
    if (prefix === undefined) return undefined;
    const p = platform === 'win32' ? pathWin32 : pathPosix;
    const scopeDir = p.dirname(p.dirname(p.dirname(real)));
    const binDir = platform === 'win32' ? prefix : p.join(prefix, 'bin');
    const writable = this.#deps.writable ?? defaultWritable;
    return writable(scopeDir) && writable(binDir) ? prefix : undefined;
  }

  /** Whether Update now can run here (else the page shows the one command). */
  canInstall(): boolean {
    if (this.#deps.npmCli === undefined) return false;
    if (this.#deps.install !== 'global') return true;
    return this.#globalTarget() !== undefined;
  }

  /** Update now: stages `version`. True once it is ready to launch. Never throws. */
  stage(version: string): Promise<boolean> {
    if (this.#running !== undefined) return this.#running;
    const running = this.#stage(version).catch(() => false);
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
    const globalTarget = this.#deps.install === 'global' ? this.#globalTarget() : undefined;
    if (this.#deps.install === 'global' && globalTarget === undefined) return false;
    this.#version = version;
    this.#entry = undefined;
    this.#phase = 'downloading';
    const root = join(this.#deps.home, '.agentlink', UPDATES_DIR);
    const dir = join(root, version);
    try {
      await mkdir(join(this.#deps.home, '.agentlink'), { recursive: true, mode: 0o700 });
      await mkdir(root, { recursive: true, mode: 0o700 });
      const info = await lstat(root);
      // Never through a link (another place would get the code this process then runs).
      if (!info.isDirectory() || info.isSymbolicLink()) return this.#fail(undefined);
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
        await chmod(root, 0o700);
      }
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { mode: 0o700 });
      await writeFile(join(dir, 'package.json'), '{"private":true}\n', { mode: 0o600 });
      const { execPath, run } = this.#deps;
      const installed = await run(execPath, installArgs(npmCli, dir, spec), {
        cwd: dir,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      if (installed.code !== 0) return this.#fail(dir);
      this.#phase = 'verifying';
      const audited = await run(execPath, verifyArgs(npmCli, dir), {
        cwd: dir,
        timeoutMs: VERIFY_TIMEOUT_MS,
      });
      if (audited.code !== 0 || !parseAuditSignatures(audited.stdout)) return this.#fail(dir);
      const pkgRoot = join(dir, ...STAGED_ENTRY.slice(0, 3));
      const text = await readSmall(join(pkgRoot, 'package.json'), MAX_PACKAGE_JSON_BYTES);
      let pkg: unknown;
      try {
        pkg = text === undefined ? undefined : parseJson(text);
      } catch {
        pkg = undefined;
      }
      if (!isObject(pkg) || pkg['name'] !== PACKAGE_NAME || pkg['version'] !== version) {
        return this.#fail(dir);
      }
      const entry = join(dir, ...STAGED_ENTRY);
      const entryInfo = await lstat(entry).catch(() => undefined);
      if (entryInfo === undefined || !entryInfo.isFile()) return this.#fail(dir);
      for (const part of [pkgRoot, dirname(entry)]) {
        const linkInfo = lstatSync(part, { throwIfNoEntry: false });
        if (linkInfo === undefined || linkInfo.isSymbolicLink()) return this.#fail(dir);
      }
      if (globalTarget !== undefined) {
        const updated = await run(execPath, globalInstallArgs(npmCli, globalTarget, spec), {
          cwd: dir,
          timeoutMs: INSTALL_TIMEOUT_MS,
        });
        if (updated.code !== 0) return this.#fail(dir);
      }
      await this.#tidy(root, version);
      this.#entry = entry;
      this.#phase = 'ready';
      return true;
    } catch {
      return this.#fail(dir);
    }
  }

  async #fail(dir: string | undefined): Promise<false> {
    this.#phase = 'failed';
    this.#entry = undefined;
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

  /** Restart now: what to run (`node <entry> ui`), only once a version is ready. */
  launch(): { readonly file: string; readonly args: readonly string[] } | undefined {
    if (this.#phase !== 'ready' || this.#entry === undefined) return undefined;
    return Object.freeze({ file: this.#deps.execPath, args: Object.freeze([this.#entry, 'ui']) });
  }
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
 * updater's phase. `installable` only where the updater can run (a global install this user cannot
 * write keeps the one command).
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
      if (updater.launch() === undefined || restarting) return view();
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
