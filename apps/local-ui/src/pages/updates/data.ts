// DESK051-UPD: Settings > Updates reads (node api/app-update.ts). Every value is checked again before
// use; anything shaped wrong is dropped (the page then says it could not read), never guessed. The
// download link is used only in one of the exact forms the app builds: this repository's release file
// for this Mac, or its release page. REL051-UPD2: `install` says how this copy was installed; only
// the desktop app ever has a link (the browser app shows a restart or a fixed command instead).
export const APP_UPDATE_PATH = '/api/ui/app-update';
export const APP_UPDATE_CHECK_PATH = '/api/ui/app-update/check';

export type UpdateState =
  'off' | 'idle' | 'checking' | 'current' | 'available' | 'failed' | 'offline';
const STATES: readonly UpdateState[] = [
  'off',
  'idle',
  'checking',
  'current',
  'available',
  'failed',
  'offline',
];

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
}

const NUM = '(0|[1-9][0-9]{0,5})';
const RELEASE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const APP = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-[0-9A-Za-z][0-9A-Za-z.]{0,31})?$`);
const RELEASES = 'https://github.com/4thtech/agentlink/releases';

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

/** The answer as a view, or undefined when any field breaks the rules. */
export function parseUpdate(data: unknown): UpdateView | undefined {
  if (!isObject(data)) return undefined;
  const { state, current, latest, download, install } = data;
  if (typeof state !== 'string' || !(STATES as readonly string[]).includes(state)) return undefined;
  if (typeof current !== 'string' || !APP.test(current)) return undefined;
  if (typeof install !== 'string' || !(INSTALLS as readonly string[]).includes(install)) {
    return undefined;
  }
  const how = install as UpdateInstall;
  if (state !== 'available') {
    if (latest !== '' || download !== '') return undefined;
    return {
      state: state as UpdateState,
      install: how,
      current,
      latest: '',
      download: '',
      macFile: false,
    };
  }
  if (typeof latest !== 'string' || !newer(latest, current) || typeof download !== 'string') {
    return undefined;
  }
  if (how !== 'desktop') {
    if (download !== '') return undefined;
    return { state: 'available', install: how, current, latest, download: '', macFile: false };
  }
  const mac = [
    `${RELEASES}/download/v${latest}/AgentLink-${latest}-mac-arm64.dmg`,
    `${RELEASES}/download/v${latest}/AgentLink-${latest}-mac-x64.dmg`,
  ];
  const macFile = mac.includes(download);
  if (!macFile && download !== `${RELEASES}/tag/v${latest}`) return undefined;
  return { state: 'available', install: how, current, latest, download, macFile };
}
