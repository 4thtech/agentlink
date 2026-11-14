// DESK051-UPD: Settings > Updates reads (node api/app-update.ts). Every value is checked again before
// use; anything shaped wrong is dropped (the page then says it could not read), never guessed. The
// download link is used only in one of the exact forms the app builds: this repository's release file
// for this Mac, or its release page. REL051-UPD2: `install` says how this copy was installed; only
// the desktop app ever has a link (the browser app shows a restart or a fixed command instead).
export const APP_UPDATE_PATH = '/api/ui/app-update';
export const APP_UPDATE_CHECK_PATH = '/api/ui/app-update/check';
// UPD-5: "Update now" and "Restart now" (POST, no body; the Mac app only).
export const APP_UPDATE_INSTALL_PATH = '/api/ui/app-update/install';
export const APP_UPDATE_RESTART_PATH = '/api/ui/app-update/restart';

export type UpdateState =
  | 'off'
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'failed'
  | 'offline'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'restarting'
  | 'install_failed';
const STATES: readonly UpdateState[] = [
  'off',
  'idle',
  'checking',
  'current',
  'available',
  'failed',
  'offline',
  'downloading',
  'verifying',
  'ready',
  'restarting',
  'install_failed',
];
/** UPD-5: a running in-app update (always installable). */
export const IN_APP_STATES: readonly UpdateState[] = [
  'downloading',
  'verifying',
  'ready',
  'restarting',
];
/** The states that carry a newer version and the download link. */
const WITH_RELEASE: readonly UpdateState[] = ['available', 'install_failed', ...IN_APP_STATES];

export type UpdateInstall = 'desktop' | 'installer' | 'npx' | 'global';
const INSTALLS: readonly UpdateInstall[] = ['desktop', 'installer', 'npx', 'global'];

export interface UpdateView {
  readonly state: UpdateState;
  readonly install: UpdateInstall;
  readonly current: string;
  /** Set only when available. */
  readonly latest: string;
  readonly download: string;
  /** The link is this Mac's file (else the release page). */
  readonly macFile: boolean;
  /** WIN-DESK-2: the link is the Windows setup file. */
  readonly winFile: boolean;
  /** UPD-5: "Update now" can run here (the Mac app with the in-app update on). */
  readonly installable: boolean;
  /** UPD-5: the download's whole percentage (0 outside downloading). */
  readonly percent: number;
  /** UPD-5: a request is waiting for the owner (warn before Restart now). */
  readonly busy: boolean;
}

const NUM = '(0|[1-9][0-9]{0,5})';
const RELEASE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const APP = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-[0-9A-Za-z][0-9A-Za-z.]{0,31})?$`);
const RELEASES = 'https://github.com/4thtech/agentlink/releases';
/**
 * FIRSTRUN-EXIT: the Windows app has no in-app update; its fallback is the stable link to the latest
 * release's setup file (a fixed string, never from an answer; the window opens it in the default
 * browser, apps/desktop security.ts allows only this repository on github.com).
 */
export const WINDOWS_SETUP_URL = `${RELEASES}/latest/download/AgentLink-win-x64-setup.exe`;

function newer(latest: string, current: string): boolean {
  const a = RELEASE.exec(latest);
  const b = RELEASE.exec(current);
  if (a === null || b === null) return false;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  }
  return false;
}

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The answer as a view, or undefined when any field breaks the rules. UPD-5: `installable`,
 * `percent` and `busy` come only from the desktop app (absent: false, 0, false), with the same rules
 * as the pipe: installable in the running states, never in install_failed or without a release; a
 * whole percentage only while downloading.
 */
export function parseUpdate(data: unknown): UpdateView | undefined {
  if (!isObject(data)) return undefined;
  const { state, current, latest, download, install } = data;
  const installable = data['installable'] ?? false;
  const percent = data['percent'] ?? 0;
  const busy = data['busy'] ?? false;
  if (typeof state !== 'string' || !(STATES as readonly string[]).includes(state)) return undefined;
  if (typeof current !== 'string' || !APP.test(current)) return undefined;
  if (typeof install !== 'string' || !(INSTALLS as readonly string[]).includes(install)) {
    return undefined;
  }
  if (typeof installable !== 'boolean' || typeof busy !== 'boolean') return undefined;
  if (typeof percent !== 'number' || !Number.isSafeInteger(percent)) return undefined;
  if (percent < 0 || percent > 100 || (state !== 'downloading' && percent !== 0)) return undefined;
  const st = state as UpdateState;
  if (IN_APP_STATES.includes(st) ? !installable : st !== 'available' && installable) {
    return undefined;
  }
  const how = install as UpdateInstall;
  const extra = { installable, percent, busy };
  if (!WITH_RELEASE.includes(st)) {
    if (latest !== '' || download !== '') return undefined;
    return {
      state: st,
      install: how,
      current,
      latest: '',
      download: '',
      macFile: false,
      winFile: false,
      ...extra,
    };
  }
  if (typeof latest !== 'string' || !newer(latest, current) || typeof download !== 'string') {
    return undefined;
  }
  if (how !== 'desktop') {
    // The in-app update is the Mac app's alone.
    if (download !== '' || st !== 'available' || installable) return undefined;
    return {
      state: 'available',
      install: how,
      current,
      latest,
      download: '',
      macFile: false,
      winFile: false,
      ...extra,
    };
  }
  const mac = [
    `${RELEASES}/download/v${latest}/AgentLink-${latest}-mac-arm64.dmg`,
    `${RELEASES}/download/v${latest}/AgentLink-${latest}-mac-x64.dmg`,
  ];
  const macFile = mac.includes(download);
  // WIN-DESK-2: the Windows app's setup (x64 only).
  const winFile =
    download === `${RELEASES}/download/v${latest}/AgentLink-${latest}-win-x64-setup.exe`;
  if (!macFile && !winFile && download !== `${RELEASES}/tag/v${latest}`) return undefined;
  return { state: st, install: how, current, latest, download, macFile, winFile, ...extra };
}
