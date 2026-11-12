// Command-line and environment lockdown (plan Decision 3 "Command-line switches", Fable H1).
//
// At startup, before anything else, the shell EXITS (non-zero, no window) when its command line
// carries anything but an allowlisted argument. A same-user process (an AI with shell access) could
// otherwise start the app with --remote-debugging-port, --inspect, --js-flags, --proxy-server,
// --disable-web-security, --host-rules, --user-data-dir, --load-extension, --enable-logging or any
// switch Chromium or Electron understands, and drive or watch the window.
//
// Allowed, and nothing else:
// - argv[0], the executable; in a development run (not packaged) also argv[1], the app path;
// - on macOS, one `-psn_<n>_<n>` (the process serial number old macOS versions add);
// - the separator `--` followed by exactly one argument that starts with `agentlink://` and is the
//   last argument (the scheme registration is `"<exe>" -- "%1"`, so a crafted link lands after `--`
//   and cannot become a switch);
// - in a PREVIEW (development) build only: `--user-data-dir=<absolute path>` before the separator,
//   for the owner-feedback loop with a temp HOME. A release build has preview = false compiled in.
//
// The environment is checked too: variables that make Electron/Node behave differently
// (ELECTRON_*, NODE_OPTIONS, …) cause an exit. Fuses also disable RunAsNode/NODE_OPTIONS/inspect in
// release builds; these checks are the second layer. The deep link itself is NOT validated here
// beyond its scheme: the deep-link handler (WP-D9) rebuilds and checks it.
//
// Pure: the inputs are passed in, so every denial is unit-tested.

/** The only scheme a launch argument may carry. */
export const DEEP_LINK_SCHEME = 'agentlink://';

/** Longest deep-link argument accepted at all (the handler applies the exact rules). */
export const MAX_DEEP_LINK_CHARS = 32 * 1024;

const PSN = /^-psn_\d{1,10}_\d{1,10}$/;

/**
 * Chromium/Electron/Node switches checked with `app.commandLine.hasSwitch` after argv passed (a
 * second layer: anything that reached Chromium's command line by another route). A denylist only
 * because hasSwitch needs names; the argv check above is the allowlist.
 */
export const FORBIDDEN_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'remote-allow-origins',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-publish-uid',
  'js-flags',
  'proxy-server',
  'proxy-pac-url',
  'proxy-bypass-list',
  'disable-web-security',
  'host-rules',
  'host-resolver-rules',
  'user-data-dir',
  'load-extension',
  'enable-logging',
  'log-file',
  'v',
  'vmodule',
  'ignore-certificate-errors',
  'ignore-certificate-errors-spki-list',
  // NOT 'allow-file-access-from-files': Electron itself appends it to every launch (seen on the
  // built app, Electron 45), so listing it here refused every start. A launch argument carrying it is
  // still refused by the argv allowlist above; the window never loads file:// (origin lock, and the
  // GrantFileProtocolExtraPrivileges fuse is off).
  'no-sandbox',
  'disable-site-isolation-trials',
  'auto-open-devtools-for-tabs',
  'disable-features',
  'enable-features',
  'enable-blink-features',
  'disable-blink-features',
  'force-fieldtrials',
  'unsafely-treat-insecure-origin-as-secure',
  'disable-renderer-backgrounding',
  'renderer-cmd-prefix',
  'gpu-launcher',
  'utility-cmd-prefix',
  'browser-subprocess-path',
  'register-pepper-plugins',
] as const;

/** Environment variables (exact names) that change Electron/Node behaviour; any one → exit. */
export const FORBIDDEN_ENV = [
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_DEBUG',
  'NODE_DEBUG_NATIVE',
  'SSLKEYLOGFILE',
  'CHROME_LOG_FILE',
] as const;
/** Any variable with this prefix → exit (ELECTRON_RUN_AS_NODE, ELECTRON_ENABLE_LOGGING, …). */
export const FORBIDDEN_ENV_PREFIX = 'ELECTRON_';
/**
 * Any variable with this prefix → exit (NODE_OPTIONS, NODE_PATH, NODE_TLS_REJECT_UNAUTHORIZED, …):
 * the whole NODE_ family, not only the names in FORBIDDEN_ENV.
 *
 * Residual (unsigned phase): the dynamic loader reads DYLD_* (macOS) and LD_PRELOAD /
 * LD_LIBRARY_PATH (Linux) before any of this code runs, so checking them here cannot stop an
 * injection. They are closed by the hardened runtime and library validation once the app is signed
 * (WP-D18), not by this check; the threat model already assumes a same-user shell (04 §2.5).
 */
export const FORBIDDEN_ENV_NODE_PREFIX = 'NODE_';

export interface LaunchInput {
  /** process.argv. */
  readonly argv: readonly string[];
  /** process.execArgv (Node options given to the main process). */
  readonly execArgv: readonly string[];
  /** process.env. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** process.platform. */
  readonly platform: string;
  /** app.isPackaged: false only in a development run (`electron <app path>`). */
  readonly packaged: boolean;
  /** The build-time preview constant (always false in a release build). */
  readonly preview: boolean;
}

/** Why a launch was refused: a fixed code, never the offending value (it may hold a secret). */
export type LaunchRefusal =
  'exec_argv' | 'env' | 'switch' | 'positional' | 'deep_link' | 'after_deep_link' | 'command_line';

export type LaunchCheck =
  | {
      readonly ok: true;
      /** The raw `agentlink://` argument after `--`, for the deep-link handler; null when none. */
      readonly deepLink: string | null;
      /** Preview builds only: the --user-data-dir value; null otherwise. */
      readonly userDataDir: string | null;
    }
  | { readonly ok: false; readonly reason: LaunchRefusal };

const refuse = (reason: LaunchRefusal): LaunchCheck => ({ ok: false, reason });

const isAbsolutePath = (value: string): boolean =>
  value.startsWith('/') || /^[A-Za-z]:\\/.test(value);

/** True when the environment carries a variable that changes Electron/Node behaviour. */
export function forbiddenEnvironment(env: Readonly<Record<string, string | undefined>>): boolean {
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (upper.startsWith(FORBIDDEN_ENV_PREFIX)) return true;
    if (upper.startsWith(FORBIDDEN_ENV_NODE_PREFIX)) return true;
    if ((FORBIDDEN_ENV as readonly string[]).includes(upper)) return true;
  }
  return false;
}

/** Checks the arguments after argv[0] (and, in a development run, the app path). */
function checkArguments(args: readonly string[], platform: string, preview: boolean): LaunchCheck {
  let deepLink: string | null = null;
  let userDataDir: string | null = null;
  let psnSeen = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--') {
      // Exactly one argument after the separator, and it must be the last one.
      const rest = args.slice(i + 1);
      if (rest.length === 0) return { ok: true, deepLink: null, userDataDir };
      if (rest.length > 1) return refuse('after_deep_link');
      const link = rest[0] as string;
      if (!link.startsWith(DEEP_LINK_SCHEME) || link.length > MAX_DEEP_LINK_CHARS) {
        return refuse('deep_link');
      }
      deepLink = link;
      return { ok: true, deepLink, userDataDir };
    }
    if (platform === 'darwin' && !psnSeen && PSN.test(arg)) {
      psnSeen = true;
      continue;
    }
    if (preview && userDataDir === null && arg.startsWith('--user-data-dir=')) {
      const value = arg.slice('--user-data-dir='.length);
      if (value.length > 0 && isAbsolutePath(value)) {
        userDataDir = value;
        continue;
      }
      return refuse('switch');
    }
    // A switch (any leading "-", including Chromium's single-dash and Windows "/" forms) or a bare
    // positional argument (Chromium also reads switches after positionals): both refused.
    if (arg.startsWith('-') || arg.startsWith('/')) return refuse('switch');
    return refuse('positional');
  }
  return { ok: true, deepLink, userDataDir };
}

/**
 * Checks the launch (argv, execArgv, env). A refusal means: exit now with a non-zero code, before
 * the single-instance lock, a window or the core.
 */
export function checkLaunch(input: LaunchInput): LaunchCheck {
  if (input.execArgv.length > 0) return refuse('exec_argv');
  if (forbiddenEnvironment(input.env)) return refuse('env');
  const skip = input.packaged ? 1 : 2;
  if (input.argv.length < skip) return refuse('positional');
  return checkArguments(input.argv.slice(skip), input.platform, input.preview);
}

/**
 * The second layer: switches present on Chromium's command line by any route. `allowUserDataDir`
 * only in a preview build that passed --user-data-dir through checkLaunch.
 */
export function commandLineIsClean(
  hasSwitch: (name: string) => boolean,
  allowUserDataDir: boolean,
): boolean {
  for (const name of FORBIDDEN_SWITCHES) {
    if (name === 'user-data-dir' && allowUserDataDir) continue;
    if (hasSwitch(name)) return false;
  }
  return true;
}

/**
 * The deep link a SECOND launch forwards to the running instance. The second instance checked its
 * own argv with checkLaunch and passes only the deep link as single-instance `additionalData`
 * (`{ deepLink: string | null }`); the first instance never reads the second one's raw argv (on
 * Windows Chromium adds its own switches there). Anything else → null (ignored silently).
 */
export function forwardedDeepLink(additionalData: unknown): string | null {
  if (typeof additionalData !== 'object' || additionalData === null) return null;
  if (Object.getPrototypeOf(additionalData) !== Object.prototype) return null;
  const keys = Object.keys(additionalData);
  if (keys.length !== 1 || keys[0] !== 'deepLink') return null;
  const link = (additionalData as { deepLink: unknown }).deepLink;
  if (typeof link !== 'string') return null;
  if (!link.startsWith(DEEP_LINK_SCHEME) || link.length > MAX_DEEP_LINK_CHARS) return null;
  return link;
}
