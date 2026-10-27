// A small History-API router: the app has a handful of fixed routes, so no router dependency. Same-
// origin clicks on a link to a routed path change the page without a reload; everything else is left
// to the browser. M1-11b-2: Approvals (`/`) and one request (`/approve/<id>`, the deep link from
// the terminal, notifications and the MCP) are pages of this app; the sidebar marks Approvals.
import { useEffect, useSyncExternalStore, type ComponentType, type ReactElement } from 'react';
import { Layout } from './layout/index.js';
import { withRouteTransition } from './layout/transition.js';
import { ActivityPage } from './pages/activity/index.js';
import { ApprovalsPage } from './pages/approvals/index.js';
import { ApprovePage, approvalIdOf } from './pages/approve/index.js';
import { AdvancedPage } from './pages/advanced/index.js';
import { AppearancePage } from './pages/appearance/index.js';
import { BackupPage } from './pages/backup/index.js';
import { ContactsPage } from './pages/contacts/index.js';
import { FilesPage } from './pages/files/index.js';
import { FirstRunPage } from './pages/first-run/index.js';
import { HomePage } from './pages/home/index.js';
import { MessagesPage } from './pages/messages/index.js';
import { ProofsPage } from './pages/proofs/index.js';
import { RulesPage } from './pages/rules/index.js';
import { PASSKEYS_LABEL, REDIRECTS } from './nav.js';
import { NotAvailablePage, NotFoundPage } from './states/index.js';

export interface RouteDef {
  readonly path: string;
  readonly page: ComponentType;
}

/** Passkeys has no page card yet: a plain stub, replaced when its card lands. */
function PasskeysPage(): ReactElement {
  return <NotAvailablePage title={PASSKEYS_LABEL} />;
}

export const ROUTES: readonly RouteDef[] = [
  { path: '/', page: ApprovalsPage },
  { path: '/settings/home', page: HomePage },
  { path: '/first-run', page: FirstRunPage },
  { path: '/settings/activity', page: ActivityPage },
  { path: '/settings/messages', page: MessagesPage },
  { path: '/settings/contacts', page: ContactsPage },
  { path: '/settings/files', page: FilesPage },
  { path: '/settings/proofs', page: ProofsPage },
  { path: '/settings/rules', page: RulesPage },
  { path: '/settings/backup', page: BackupPage },
  { path: '/settings/passkeys', page: PasskeysPage },
  { path: '/settings/appearance', page: AppearancePage },
  { path: '/settings/advanced', page: AdvancedPage },
];

const CHANGE = 'agentlink:navigate';
const SETTINGS = '/settings';
const SETTINGS_HOME = '/settings/activity';

function normalize(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/** Go to a path of this app without a reload. */
export function navigate(to: string, replace = false): void {
  const target = normalize(new URL(to, location.href).pathname);
  const changesPage = target !== normalize(location.pathname);
  // The address changes at once; only the re-render may sit inside a view transition.
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  const notify = (): void => {
    window.dispatchEvent(new Event(CHANGE));
  };
  if (replace || !changesPage) notify();
  else withRouteTransition(notify);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(CHANGE, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(CHANGE, onChange);
  };
}

function usePath(): string {
  return normalize(useSyncExternalStore(subscribe, () => location.pathname));
}

const APPROVALS = '/';

function isRouted(path: string): boolean {
  return (
    path === SETTINGS ||
    path in REDIRECTS ||
    ROUTES.some((r) => r.path === path) ||
    approvalIdOf(path) !== undefined
  );
}

/** Turn a plain left-click on a link to a routed path of this app into a navigation. */
function onDocumentClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as Element | null)?.closest('a');
  if (anchor === null || anchor === undefined) return;
  if (anchor.target !== '' && anchor.target !== '_self') return;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin || !isRouted(normalize(url.pathname))) return;
  event.preventDefault();
  navigate(url.pathname + url.search);
}

/** The whole app below the root: layout plus the page for the current path. */
export function AppRoutes(): ReactElement {
  const path = usePath();
  useEffect(() => {
    document.addEventListener('click', onDocumentClick);
    return () => document.removeEventListener('click', onDocumentClick);
  }, []);
  useEffect(() => {
    if (path === SETTINGS) navigate(SETTINGS_HOME, true);
    else if (path in REDIRECTS) navigate(REDIRECTS[path] as string, true);
  }, [path]);
  const shown = path === SETTINGS ? SETTINGS_HOME : (REDIRECTS[path] ?? path);
  // One request belongs to Approvals: the same sidebar item is current.
  const oneRequest = approvalIdOf(shown) !== undefined;
  const route = ROUTES.find((r) => r.path === shown);
  const Page = oneRequest ? ApprovePage : (route?.page ?? NotFoundPage);
  return (
    <Layout path={oneRequest ? APPROVALS : shown}>
      <Page key={shown} />
    </Layout>
  );
}
