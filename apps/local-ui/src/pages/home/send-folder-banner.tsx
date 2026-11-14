// ATT-SENDFOLDER-FIX (D-121 D6; 08 §1; 11 §5; I-4): the "Allow your Send folder" action, for an
// ID that allows no folder yet (made when ~/AgentLink/Send could not be used, or before the first
// rules carried it), so the owner's AI can send files without a terminal. FILES-HOME-PANEL: Home's Files panel (files-panel.tsx) now holds this action and replaced the banner on Home; the banner stays where an Attach answers no_folder, and its api is shared.
//
// - Reads `GET /api/ui/files` (a read; signs nothing). Shown only when it answers an empty list.
// - Its one button asks the local server to set up the Send folder (`POST /api/ui/files/send-folder`,
//   a mark-kind route: an empty octet-stream body, no input, no presence, nothing signed, no rule
//   changed), then opens Settings > Files with that folder filled in and checked (`check=1`, honoured
//   only with the one-time SEND_FOLDER_CHECK_KEY this banner sets in sessionStorage). There
//   the owner sees the real folder and every warning and confirms with Touch ID or the master code:
//   the existing review and presence-gated confirm (D-99, D-119). The browser never signs.
// - The folder path is local data shown as text only; nothing from another party is shown here.
import { Banner, Button } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import { navigate } from '../../router.js';
import { SEND_FOLDER_CHECK_KEY } from '../../strings.js';

export const SEND_FOLDER_PATH = '/api/ui/files/send-folder';
const LIST_PATH = '/api/ui/files';
const CSRF_HEADER = 'X-AgentLink-CSRF';

/** 11 §5: plain words, no wallet, gas, seed phrase or transaction. */
export const SEND_FOLDER_BANNER_TEXT = 'Allow your Send folder so your AI can send files.';
const S = {
  allow: 'Allow Send folder',
  working: 'Setting up…',
  failed:
    "AgentLink couldn't set up your Send folder. You can allow a folder in Settings, then Files.",
  openFiles: 'Open Files',
} as const;

export interface SendFolderApi {
  /** True when the open ID allows no folder; false otherwise or when it can't be read. */
  noFolder(): Promise<boolean>;
  /** The Send folder's real path, set up by the server; undefined when it couldn't be. */
  prepare(): Promise<string | undefined>;
}

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function createSendFolderApi(
  options: { readonly fetch?: typeof fetch; readonly token?: string } = {},
): SendFolderApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();
  const json = async (res: Response): Promise<unknown> => {
    try {
      return (await res.json()) as unknown;
    } catch {
      return undefined;
    }
  };
  return {
    async noFolder() {
      try {
        const res = await doFetch(LIST_PATH, {
          method: 'GET',
          headers: new Headers({ [CSRF_HEADER]: token() }),
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (res.status !== 200) return false;
        const body = await json(res);
        return isObject(body) && Array.isArray(body['folders']) && body['folders'].length === 0;
      } catch {
        return false;
      }
    },
    async prepare() {
      try {
        // The mark kind: an empty octet-stream body, no input header, no presence.
        const res = await doFetch(SEND_FOLDER_PATH, {
          method: 'POST',
          headers: new Headers({
            [CSRF_HEADER]: token(),
            'content-type': 'application/octet-stream',
          }),
          body: new Uint8Array(0),
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (res.status !== 200) return undefined;
        const body = await json(res);
        const folder = isObject(body) ? body['folder'] : undefined;
        return typeof folder === 'string' && folder.length > 0 && folder.length <= 4096
          ? folder
          : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** Settings > Files with the folder filled in and checked at once (files/index.tsx `check=1`). */
export const filesLinkFor = (folder: string): string =>
  `/settings/files?folder=${encodeURIComponent(folder)}&check=1`;

export interface SendFolderBannerProps {
  readonly api: SendFolderApi;
  /** Where the button goes; the app's own navigation by default. */
  readonly go?: (to: string) => void;
  /** Changes when the open ID changes, so the list is read again. */
  readonly agentKey?: string;
}

export function SendFolderBanner({
  api,
  go = navigate,
  agentKey,
}: SendFolderBannerProps): ReactElement | null {
  const [show, setShow] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'working' | 'failed'>('idle');
  useEffect(() => {
    let live = true;
    setShow(false);
    setPhase('idle');
    void api.noFolder().then((none) => {
      if (live) setShow(none);
    });
    return () => {
      live = false;
    };
  }, [api, agentKey]);

  if (!show) return null;
  const allow = async (): Promise<void> => {
    setPhase('working');
    const folder = await api.prepare();
    if (folder === undefined) {
      setPhase('failed');
      return;
    }
    // IR-1 L-2: Files checks at once only for the folder this banner set up (one time, this tab).
    try {
      sessionStorage.setItem(SEND_FOLDER_CHECK_KEY, folder);
    } catch {
      // Without it, Files only fills the field.
    }
    go(filesLinkFor(folder));
  };
  return (
    <section aria-label={S.allow} data-send-folder-banner>
      {phase === 'failed' ? (
        <Banner
          tone="warning"
          compact
          action={
            <a className="al-btn al-btn-secondary al-btn-sm" href="/settings/files">
              {S.openFiles}
            </a>
          }
        >
          {S.failed}
        </Banner>
      ) : (
        <Banner
          tone="info"
          icon="folder"
          compact
          action={
            <Button
              size="sm"
              variant="primary"
              disabled={phase === 'working'}
              onClick={() => void allow()}
            >
              {phase === 'working' ? S.working : S.allow}
            </Button>
          }
        >
          {SEND_FOLDER_BANNER_TEXT}
        </Banner>
      )}
    </section>
  );
}
