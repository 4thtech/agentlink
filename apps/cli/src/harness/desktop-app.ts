// WP-D7 (S2; plan 2026-11-12 Decision 2 "AI apps", "Translocation (M3)"; 04 §2.5 "Writing AI app
// configs"; 06 §7 "The app as a second path"): where the AgentLink desktop app keeps its bundled Node
// and CLI, and whether an AI app may be pointed at them. The ONE module with these path constants.
//
// Layout inside the app (WP-D4 build-mac.mjs / build-win.mjs, which is what the build produces):
//   macOS    AgentLink.app/Contents/Resources/node/bin/node            official Node, untouched
//   Windows  AgentLink\resources\node\node.exe
//   both     <resources>/core/node_modules/@4thtech-io/agentlink/dist/agentlink.js   the CLI (`mcp`)
//            <resources>/core/node_modules/@4thtech-io/agentlink/dist/desktop-host.js the host
// `core/` is an `npm install --prefix core <packed tgz>`, so the package sits under node_modules.
// WP-D2 (shell) still names `core/desktop/host.js`; the D4 layout wins (it is the installed package).
//
// An AI app entry starts a program, so it must point at a stable copy: never a translocated app
// (macOS App Translocation runs a quarantined app from a random read-only folder), a mounted disk
// image, a temporary folder or npx's cache. Those are refused (`appLocationProblem`). A path with a
// character that changes meaning in a shell or a `.cmd` file is not used at all. Nothing here runs the
// program; it only checks that the files are regular files of the AgentLink package.
import { accessSync, constants as fsConstants } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';
import process from 'node:process';
import { PACKAGE_NAME } from './harnesses.js';

/** The app's product name and macOS bundle folder (WP-D4 APP_NAME). */
export const DESKTOP_APP_NAME = 'AgentLink';
export const DESKTOP_MAC_BUNDLE = 'AgentLink.app';

/** Below the app's resources folder: the bundled Node binary, per system. */
export const BUNDLED_NODE_PARTS: Readonly<Record<'darwin' | 'win32', readonly string[]>> =
  Object.freeze({
    darwin: Object.freeze(['node', 'bin', 'node']),
    win32: Object.freeze(['node', 'node.exe']),
  });
/** Below the resources folder: the installed AgentLink package. */
export const BUNDLED_PACKAGE_PARTS: readonly string[] = Object.freeze([
  'core',
  'node_modules',
  '@4thtech-io',
  'agentlink',
]);
/** The CLI an AI app runs as `<node> <cli> mcp …` (the `bin` of the package). */
export const BUNDLED_CLI_PARTS: readonly string[] = Object.freeze([
  ...BUNDLED_PACKAGE_PARTS,
  'dist',
  'agentlink.js',
]);
/** The hidden desktop host entry (WP-D3/D4); never written into an AI app's config. */
export const BUNDLED_HOST_PARTS: readonly string[] = Object.freeze([
  ...BUNDLED_PACKAGE_PARTS,
  'dist',
  'desktop-host.js',
]);

/** The two absolute paths an app-form entry starts. */
export interface AppStart {
  readonly node: string;
  readonly cli: string;
}

export type AppLocationProblem = 'translocated' | 'read_only' | 'temporary';

export type DesktopApp =
  | { readonly status: 'ok'; readonly resources: string; readonly start: AppStart }
  /** Found, but in a place an AI app must not be pointed at. Its entries are still recognised. */
  | {
      readonly status: 'refused';
      readonly reason: AppLocationProblem;
      readonly resources: string;
      readonly start: AppStart;
    };

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);
type AppPlatform = 'darwin' | 'win32';
const appPlatform = (platform: NodeJS.Platform): AppPlatform | undefined =>
  platform === 'darwin' || platform === 'win32' ? platform : undefined;

/** The app's two files below `resources`, for this system (`undefined`: no app on this system). */
export function appStartAt(resources: string, platform: NodeJS.Platform): AppStart | undefined {
  const os = appPlatform(platform);
  if (os === undefined) return undefined;
  const p = pathFor(platform);
  return Object.freeze({
    node: p.join(resources, ...BUNDLED_NODE_PARTS[os]),
    cli: p.join(resources, ...BUNDLED_CLI_PARTS),
  });
}

/**
 * Where the app is installed by default: macOS `/Applications/AgentLink.app` (and the person's own
 * `~/Applications`), Windows per user `%LOCALAPPDATA%\Programs\AgentLink` (taken as
 * `<home>\AppData\Local`, like every other folder here: an environment value does not move a write).
 */
export function installedResources(home: string, platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      posix.join('/Applications', DESKTOP_MAC_BUNDLE, 'Contents', 'Resources'),
      posix.join(home, 'Applications', DESKTOP_MAC_BUNDLE, 'Contents', 'Resources'),
    ];
  }
  if (platform === 'win32') {
    return [win32.join(home, 'AppData', 'Local', 'Programs', DESKTOP_APP_NAME, 'resources')];
  }
  return [];
}

/**
 * The resources folder of the app this process runs from, when `execPath` is the app's bundled Node
 * (the desktop host runs on it); else `undefined`.
 */
export function resourcesOfExecPath(
  execPath: string,
  platform: NodeJS.Platform,
): string | undefined {
  const os = appPlatform(platform);
  if (os === undefined) return undefined;
  const p = pathFor(platform);
  if (!p.isAbsolute(execPath)) return undefined;
  const parts = BUNDLED_NODE_PARTS[os];
  let dir = execPath;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const name = p.basename(dir);
    const want = parts[i] as string;
    if (os === 'win32' ? name.toLowerCase() !== want : name !== want) return undefined;
    dir = p.dirname(dir);
  }
  if (os === 'darwin') {
    // Only a real bundle: `<Name>.app/Contents/Resources`.
    if (p.basename(dir) !== 'Resources' || p.basename(p.dirname(dir)) !== 'Contents') {
      return undefined;
    }
    if (!p.basename(p.dirname(p.dirname(dir))).endsWith('.app')) return undefined;
  } else if (p.basename(dir).toLowerCase() !== 'resources') {
    return undefined;
  }
  return dir;
}

/** Characters that change meaning in a shell word or a `.cmd` line (or cannot be quoted at all). */
const UNQUOTABLE = /["'$`\r\n\0%!^&|<>]/;

/** True when a path may be written into an entry or a launcher as it is. */
export function quotablePath(path: string, platform: NodeJS.Platform): boolean {
  if (path === '' || UNQUOTABLE.test(path)) return false;
  return platform === 'win32' || !path.includes('\\');
}

export interface LocationInput {
  readonly platform: NodeJS.Platform;
  /** os.tmpdir() of this process. */
  readonly tmpDir: string;
  readonly home: string;
  /** Whether a folder can be written by this user (default: fs.accessSync W_OK). */
  readonly writable?: (path: string) => boolean;
  /** Tests only: the temporary folders, instead of this system's. */
  readonly tempRoots?: readonly string[];
}

const canWrite = (path: string): boolean => {
  try {
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** `dir` or a folder inside it (case-insensitive on Windows). */
function within(path: string, dir: string, platform: NodeJS.Platform): boolean {
  const p = pathFor(platform);
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s);
  const base = fold(p.normalize(dir)).replace(/[\\/]+$/, '');
  const full = fold(p.normalize(path));
  if (base.length <= 1) return false;
  return full === base || full.startsWith(`${base}${p.sep}`);
}

/**
 * Why an AI app must not be pointed at `path` (a file inside the app), or `undefined`: translocated
 * (macOS App Translocation), on a read-only mounted disk image (`/Volumes/…`), or in a temporary
 * folder (this process's temp folder, macOS per-user temp folders, `/tmp`, Windows' Temp, npx's
 * cache). Plan Decision 2 "Translocation (M3)": the same rules as the shell's own refusal (WP-D2
 * move.ts), applied to the path that would be written.
 */
export function appLocationProblem(
  path: string,
  input: LocationInput,
): AppLocationProblem | undefined {
  const { platform } = input;
  const p = pathFor(platform);
  const segments = p.normalize(path).split(/[\\/]+/);
  if (platform === 'darwin') {
    if (segments.includes('AppTranslocation')) return 'translocated';
    if (path.startsWith('/Volumes/')) {
      const mount = segments.slice(0, 3).join('/');
      if (!(input.writable ?? canWrite)(mount)) return 'read_only';
    }
  }
  if (segments.includes('_npx')) return 'temporary';
  const temps: string[] = input.tempRoots === undefined ? [input.tmpDir] : [...input.tempRoots];
  if (input.tempRoots !== undefined) {
    // Exactly the folders given.
  } else if (platform === 'win32') {
    temps.push(win32.join(input.home, 'AppData', 'Local', 'Temp'), 'C:\\Windows\\Temp');
  } else {
    temps.push('/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp');
    if (input.tmpDir.startsWith('/') && !input.tmpDir.startsWith('/private/')) {
      temps.push(`/private${input.tmpDir}`);
    }
    if (platform === 'darwin') temps.push('/var/folders', '/private/var/folders');
  }
  for (const dir of temps) {
    if (dir !== '' && p.isAbsolute(dir) && within(path, dir, platform)) return 'temporary';
  }
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function packageNameAt(dir: string, platform: NodeJS.Platform): Promise<unknown> {
  try {
    const file = pathFor(platform).join(dir, 'package.json');
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return (parsed as { name?: unknown } | null)?.name;
  } catch {
    return undefined;
  }
}

export interface LocateOptions {
  readonly home: string;
  readonly platform?: NodeJS.Platform;
  /** This process's Node binary (default process.execPath): the app it runs from comes first. */
  readonly execPath?: string;
  /** Default os.tmpdir(). */
  readonly tmpDir?: string;
  /** Resources folders to look at after the running app (default: installedResources). */
  readonly candidates?: readonly string[];
  readonly writable?: (path: string) => boolean;
  /** Tests only (LocationInput.tempRoots). */
  readonly tempRoots?: readonly string[];
}

/** One resources folder: the app is there when both files are real files of the AgentLink package. */
async function appAt(
  resources: string,
  options: Required<Pick<LocateOptions, 'home' | 'platform' | 'tmpDir'>> &
    Pick<LocateOptions, 'writable' | 'tempRoots'>,
): Promise<DesktopApp | undefined> {
  const { platform } = options;
  const start = appStartAt(resources, platform);
  if (start === undefined) return undefined;
  let node: string;
  let cli: string;
  let realResources: string;
  try {
    node = await realpath(start.node);
    cli = await realpath(start.cli);
    realResources = await realpath(resources);
  } catch {
    return undefined;
  }
  if (!(await isFile(node)) || !(await isFile(cli))) return undefined;
  const p = pathFor(platform);
  // The CLI is the package's own file: `<package>/dist/agentlink.js` under a package.json named ours.
  const pkgDir = p.dirname(p.dirname(cli));
  if ((await packageNameAt(pkgDir, platform)) !== PACKAGE_NAME) return undefined;
  if (!quotablePath(node, platform) || !quotablePath(cli, platform)) return undefined;
  const real: AppStart = Object.freeze({ node, cli });
  const input: LocationInput = {
    platform,
    tmpDir: options.tmpDir,
    home: options.home,
    ...(options.writable === undefined ? {} : { writable: options.writable }),
    ...(options.tempRoots === undefined ? {} : { tempRoots: options.tempRoots }),
  };
  const reason =
    appLocationProblem(start.node, input) ??
    appLocationProblem(node, input) ??
    appLocationProblem(cli, input);
  if (reason !== undefined) {
    return Object.freeze({ status: 'refused', reason, resources: realResources, start: real });
  }
  return Object.freeze({ status: 'ok', resources: realResources, start: real });
}

/**
 * The AgentLink desktop app on this computer: the app this process runs from, else an installed copy
 * at its default place. `undefined`: none (or not a usable AgentLink package).
 */
export async function locateDesktopApp(options: LocateOptions): Promise<DesktopApp | undefined> {
  const platform = options.platform ?? process.platform;
  if (appPlatform(platform) === undefined) return undefined;
  const base = {
    home: options.home,
    platform,
    tmpDir: options.tmpDir ?? tmpdir(),
    ...(options.writable === undefined ? {} : { writable: options.writable }),
    ...(options.tempRoots === undefined ? {} : { tempRoots: options.tempRoots }),
  };
  const running = resourcesOfExecPath(options.execPath ?? process.execPath, platform);
  const roots = [
    ...(running === undefined ? [] : [running]),
    ...(options.candidates ?? installedResources(options.home, platform)),
  ];
  for (const root of roots) {
    const found = await appAt(root, base);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** `command` and `args` of the app form: `<node> <cli> mcp`, plus `--agent <name>`. */
export function appMcpWords(
  start: AppStart,
  agent: string | undefined,
): { readonly command: string; readonly args: string[] } {
  return {
    command: start.node,
    args: [start.cli, 'mcp', ...(agent === undefined ? [] : ['--agent', agent])],
  };
}
