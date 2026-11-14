// FIRSTRUN-EXIT (owner, 14 Nov 2026: "You need to be able to come out of the wizard any time, not be
// locked within a wizard"; 08 §1 "A way out of first run", proposed). On the owner's Windows PC a
// broken first-run step left no way to Settings › Updates. So:
// - every first-run screen (Get started, restore, Start over; browser and desktop app alike) carries
//   SetupExitLinks: "Check for updates" (Settings › Updates) and "Help" (the user guide). Neither
//   needs an owner, and neither does anything but open a page.
// - before an owner exists, the shell's SetupGate shows pages that need an owner as one plain
//   "Set up AgentLink first" with "Continue setup" (back to Get started), so the way out never
//   dead-ends. The owner-free pages (Home, Settings, Settings › Updates, Appearance) show as they are,
//   with a quiet "Continue setup" notice on the Settings pages.
// This is wayfinding only: the server's gates (no agent open → 409 `no_agent`, owner presence on
// every owner route) are unchanged and still decide. An unanswered owner read gates nothing.
import { PageNotice } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { createApiClient } from '../../api/client.js';
import { GUIDE_URL } from '../../layout/top-bar.js';
import { START_PATH } from '../../nav.js';
import { STATUS_PATH } from '../first-run/setup-api.js';
import { SETUP_EXIT as S } from './strings.js';
import './setup-exit.css';

export { WINDOWS_SETUP_URL } from '../updates/data.js';

/** Settings › Updates. */
export const UPDATES_PATH = '/settings/updates';

/** The pages that work before an owner exists (after the router's redirects). */
export const OWNER_FREE_PATHS: readonly string[] = [
  '/',
  '/settings',
  UPDATES_PATH,
  '/settings/appearance',
];

/** Whether the shell page at `path` needs an owner (everything but the owner-free pages). */
export function needsOwner(path: string): boolean {
  return !OWNER_FREE_PATHS.includes(path);
}

/** The way out of a first-run screen: Check for updates and Help. Same words everywhere. */
export function SetupExitLinks(): ReactElement {
  return (
    <nav className="al-setup-exit" aria-label={S.label}>
      <a className="al-setup-exit-link al-text-body-sm" href={UPDATES_PATH}>
        {S.updates}
      </a>
      <a
        className="al-setup-exit-link al-text-body-sm"
        href={GUIDE_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        {S.help}
      </a>
    </nav>
  );
}

/** A page that needs an owner, before there is one: one plain line and the way back. */
export function SetUpFirstNotice(): ReactElement {
  return (
    <section className="al-setup-first" aria-labelledby="al-setup-first-h">
      <h1 id="al-setup-first-h" className="al-text-title-1">
        {S.firstTitle}
      </h1>
      <p className="al-text-body al-muted">{S.firstBody}</p>
      <div>
        <a className="al-btn al-btn-primary" href={START_PATH}>
          {S.continueSetup}
        </a>
      </div>
    </section>
  );
}

/** An owner-free Settings page before setup: the page, with a quiet way back to Get started. */
export function SetupPendingNotice(): ReactElement {
  return (
    <PageNotice
      tone="neutral"
      title={S.pendingTitle}
      actions={
        <a className="al-btn al-btn-secondary al-btn-sm" href={START_PATH}>
          {S.continueSetup}
        </a>
      }
    >
      <p>{S.pendingBody}</p>
    </PageNotice>
  );
}

export type OwnerWord = 'missing' | 'set_up' | undefined;

/** The first-run status read (`GET /api/ui/first-run`, answered with no agent open): its owner word. */
export async function readOwnerWord(): Promise<OwnerWord> {
  const result = await createApiClient().get<unknown>(STATUS_PATH);
  if (result.kind !== 'ok') return undefined;
  const data = result.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const word = (data as Readonly<Record<string, unknown>>)['owner'];
  return word === 'missing' || word === 'set_up' ? word : undefined;
}

/**
 * The owner word, read when the shell opens and again on each page change until an owner is seen
 * (an owner never goes away within a page's life: Start over ends with a full load).
 */
function useOwnerWord(read: () => Promise<OwnerWord>, path: string): OwnerWord {
  const [word, setWord] = useState<OwnerWord>(undefined);
  const known = word === 'set_up';
  useEffect(() => {
    if (known) return undefined;
    let live = true;
    read().then(
      (next) => {
        if (live) setWord(next);
      },
      () => {
        if (live) setWord(undefined);
      },
    );
    return () => {
      live = false;
    };
  }, [read, path, known]);
  return word;
}

export interface SetupGateProps {
  readonly path: string;
  readonly children?: ReactNode;
  /** Test seam: the owner read. Default: the first-run status. */
  readonly read?: () => Promise<OwnerWord>;
}

/** The shell's page slot before setup (see the file comment). Only a clear "missing" gates. */
export function SetupGate({ path, children, read = readOwnerWord }: SetupGateProps): ReactElement {
  const word = useOwnerWord(read, path);
  if (word !== 'missing') return <>{children}</>;
  if (needsOwner(path)) return <SetUpFirstNotice />;
  if (path === '/') return <>{children}</>;
  return (
    <>
      <SetupPendingNotice />
      {children}
    </>
  );
}
