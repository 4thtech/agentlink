// R2-10 (IR-REL051-SF4-1; golden-path gate): the owner's DEFAULT WEB BROWSER, the program the OS
// opens an http link with, so the private launch file (approval-os.ts, R1-SEC-05) opens there and
// never in the OS's `.html` handler (on many computers an editor, or a browser without the passkey).
//
// Read-only, by fixed programs at absolute paths with shell false (never through PATH):
// - macOS: the `http` entry of LaunchServices' own record
//   (`~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`, read with
//   `/usr/bin/plutil -convert json`); no record, or no `http` entry, means Safari, the system default.
//   Launched as `/usr/bin/open -b <bundle id> <file>`.
// - Windows: the per-user `UrlAssociations\http\UserChoice` ProgId and that ProgId's
//   `shell\open\command`, read with `%SystemRoot%\System32\reg.exe query`; the browser program is run
//   directly with the launch file's `file:///` URL in place of `%1`.
// - Linux and others: `/usr/bin/xdg-settings get default-web-browser`, then that `.desktop` file's
//   `Exec` line from the XDG application folders (and the snap and flatpak ones); the launch file's
//   path takes the place of `%u`/`%U`/`%f`/`%F`.
// Every value read is checked against a strict pattern; anything unexpected (a shell, a relative or
// odd program, a malformed id) means "unknown", and the opener falls back to the pre-0.5.1 behaviour
// (the link itself to the OS opener; a residual recorded in 04 §2.8). Nothing here is logged.
import { join } from 'node:path';

/** How to start the default browser with one launch file. */
export interface BrowserLaunch {
  /** Absolute program path. */
  readonly program: string;
  /** The arguments for the launch file at `file` (its path, or its file URL on Windows). */
  args(file: string): readonly string[];
}

/** Internal (tests): what the reader may touch. */
export interface DefaultBrowserSeams {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly executable: (path: string) => boolean;
  /** Runs a fixed program (absolute path, shell false); its stdout, or undefined on any failure. */
  readonly readOutput: (file: string, args: readonly string[]) => Promise<string | undefined>;
  /** A small text file's content, or undefined. */
  readonly readText: (path: string) => Promise<string | undefined>;
  readonly exists: (path: string) => Promise<boolean>;
}

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/;
const PROG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DESKTOP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.desktop$/;
const WINDOWS_ROOT = /^[A-Za-z]:\\Windows$/i;
/** A Windows browser program: a drive path to an `.exe`, never a shell or a script host. */
const WINDOWS_EXE = /^[A-Za-z]:\\[^"%<>|*?\r\n]+\.exe$/i;
const WINDOWS_SHELLS =
  /\\(?:cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|conhost)\.exe$/i;
const POSIX_SHELLS = /\/(?:sh|bash|dash|zsh|ksh|fish|csh|tcsh|python[0-9.]*|perl|ruby|node)$/;
/** Where a relative `Exec` program is looked up on Linux: fixed folders, never PATH. */
const LINUX_BIN_DIRS = ['/usr/bin', '/bin', '/usr/local/bin', '/snap/bin'];

export const MAC_LAUNCH_SERVICES =
  'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist';

/** The default web browser, or undefined when it cannot be found safely. */
export async function defaultBrowser(
  seams: DefaultBrowserSeams,
): Promise<BrowserLaunch | undefined> {
  try {
    switch (seams.platform) {
      case 'darwin':
        return await macBrowser(seams);
      case 'win32':
        return await windowsBrowser(seams);
      default:
        return await linuxBrowser(seams);
    }
  } catch {
    return undefined;
  }
}

async function macBrowser(seams: DefaultBrowserSeams): Promise<BrowserLaunch | undefined> {
  const open = '/usr/bin/open';
  if (!seams.executable(open)) return undefined;
  const plist = join(seams.home, MAC_LAUNCH_SERVICES);
  let bundle = 'com.apple.Safari';
  if (await seams.exists(plist)) {
    const json = await seams.readOutput('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
    if (json === undefined) return undefined;
    const parsed = JSON.parse(json) as { LSHandlers?: unknown };
    const handlers = Array.isArray(parsed.LSHandlers) ? (parsed.LSHandlers as unknown[]) : [];
    const http = handlers.find(
      (h): h is Record<string, unknown> =>
        typeof h === 'object' &&
        h !== null &&
        (h as Record<string, unknown>)['LSHandlerURLScheme'] === 'http',
    );
    if (http !== undefined) {
      const role = http['LSHandlerRoleAll'] ?? http['LSHandlerRoleViewer'];
      if (typeof role !== 'string' || !BUNDLE_ID.test(role)) return undefined;
      bundle = role;
    }
  }
  return { program: open, args: (file) => ['-b', bundle, file] };
}

/** Splits a command line on spaces outside double quotes; the quotes are removed. */
function splitCommand(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let any = false;
  for (const c of line) {
    if (c === '"') {
      quoted = !quoted;
      any = true;
    } else if ((c === ' ' || c === '\t') && !quoted) {
      if (any || current !== '') out.push(current);
      current = '';
      any = false;
    } else {
      current += c;
    }
  }
  if (quoted) throw new Error('unbalanced');
  if (any || current !== '') out.push(current);
  return out;
}

async function windowsBrowser(seams: DefaultBrowserSeams): Promise<BrowserLaunch | undefined> {
  const configured = seams.env['SystemRoot'] ?? seams.env['SYSTEMROOT'];
  const root =
    typeof configured === 'string' && WINDOWS_ROOT.test(configured) ? configured : 'C:\\Windows';
  const reg = `${root}\\System32\\reg.exe`;
  if (!seams.executable(reg)) return undefined;
  const choice = await seams.readOutput(reg, [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
    '/v',
    'ProgId',
  ]);
  const progId = /\bProgId\s+REG_SZ\s+(\S+)\s*$/m.exec(choice ?? '')?.[1];
  if (progId === undefined || !PROG_ID.test(progId)) return undefined;
  const command = await seams.readOutput(reg, [
    'query',
    `HKCR\\${progId}\\shell\\open\\command`,
    '/ve',
  ]);
  const line = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(command ?? '')?.[1];
  if (line === undefined) return undefined;
  const [program, ...rest] = splitCommand(line);
  if (program === undefined || !WINDOWS_EXE.test(program) || WINDOWS_SHELLS.test(program)) {
    return undefined;
  }
  if (!seams.executable(program)) return undefined;
  if (!rest.some((a) => a.includes('%1'))) rest.push('%1');
  return {
    program,
    args: (file) =>
      rest.filter((a) => a !== '%*').map((a) => (a.includes('%1') ? a.replace('%1', file) : a)),
  };
}

function linuxApplicationDirs(seams: DefaultBrowserSeams): string[] {
  const dataHome = seams.env['XDG_DATA_HOME'];
  const dirs = [
    dataHome !== undefined && dataHome.startsWith('/')
      ? dataHome
      : join(seams.home, '.local/share'),
    ...(seams.env['XDG_DATA_DIRS'] ?? '/usr/local/share:/usr/share')
      .split(':')
      .filter((d) => d.startsWith('/')),
    '/var/lib/snapd/desktop',
    '/var/lib/flatpak/exports/share',
    join(seams.home, '.local/share/flatpak/exports/share'),
  ];
  return [...new Set(dirs.map((d) => join(d, 'applications')))];
}

/** The `Exec` value of the `[Desktop Entry]` group, or undefined. */
function desktopExec(text: string): string | undefined {
  let inEntry = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    if (inEntry && line.startsWith('Exec=')) return line.slice('Exec='.length);
  }
  return undefined;
}

async function linuxBrowser(seams: DefaultBrowserSeams): Promise<BrowserLaunch | undefined> {
  const settings = '/usr/bin/xdg-settings';
  if (!seams.executable(settings)) return undefined;
  const id = (await seams.readOutput(settings, ['get', 'default-web-browser']))?.trim();
  if (id === undefined || !DESKTOP_ID.test(id)) return undefined;
  let exec: string | undefined;
  for (const dir of linuxApplicationDirs(seams)) {
    const text = await seams.readText(join(dir, id));
    if (text !== undefined) {
      exec = desktopExec(text);
      break;
    }
  }
  if (exec === undefined) return undefined;
  const [first, ...rest] = splitCommand(exec);
  if (first === undefined) return undefined;
  const program = first.startsWith('/')
    ? first
    : LINUX_BIN_DIRS.map((d) => `${d}/${first}`).find(
        (p) => /^[A-Za-z0-9._+-]+$/.test(first) && seams.executable(p),
      );
  if (program === undefined || POSIX_SHELLS.test(program) || !seams.executable(program)) {
    return undefined;
  }
  const FILE_CODE = /^%[uUfF]$/;
  const hasFile = rest.some((a) => FILE_CODE.test(a));
  // Other field codes (%i, %c, %k, ...) are dropped, as the Desktop Entry spec allows.
  const kept = rest.filter((a) => FILE_CODE.test(a) || !/^%[a-zA-Z]$/.test(a));
  return {
    program,
    args: (file) => {
      const args = kept.map((a) => (FILE_CODE.test(a) ? file : a));
      return hasFile ? args : [...args, file];
    },
  };
}
