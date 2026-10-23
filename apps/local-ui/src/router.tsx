// A small History-API router: the app has a handful of fixed routes, so no router dependency. Same-
// origin clicks on a link to a routed path change the page without a reload; everything else is left
// to the browser (the Approvals link, which is still the approval page at `/`).
import { useEffect, useSyncExternalStore, type ComponentType, type ReactElement } from 'react';
import { Layout } from './layout/index.js';
import { ActivityPage } from './pages/activity/index.js';
import { AdvancedPage } from './pages/advanced/index.js';
import { BackupPage } from './pages/backup/index.js';
import { ContactsPage } from './pages/contacts/index.js';
import { FilesPage } from './pages/files/index.js';
import { FirstRunPage } from './pages/first-run/index.js';
import { ProofsPage } from './pages/proofs/index.js';
import { RulesPage } from './pages/rules/index.js';
import { StoragePage } from './pages/storage/index.js';
import { NotFoundPage } from './states/index.js';

export interface RouteDef {
  readonly path: string;
  readonly page: ComponentType;
}

export const ROUTES: readonly RouteDef[] = [
  { path: '/first-run', page: FirstRunPage },
  { path: '/settings/activity', page: ActivityPage },
  { path: '/settings/contacts', page: ContactsPage },
  { path: '/settings/files', page: FilesPage },
  { path: '/settings/storage', page: StoragePage },
  { path: '/settings/proofs', page: ProofsPage },
  { path: '/settings/rules', page: RulesPage },
  { path: '/settings/backup', page: BackupPage },
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
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new Event(CHANGE));
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

function isRouted(path: string): boolean {
  return path === SETTINGS || ROUTES.some((r) => r.path === path);
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
  }, [path]);
  const route = ROUTES.find((r) => r.path === path);
  const Page = route?.page ?? NotFoundPage;
  return (
    <Layout path={path === SETTINGS ? SETTINGS_HOME : path}>
      <Page />
    </Layout>
  );
}
