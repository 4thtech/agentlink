// A small History-API router: the app has a handful of fixed routes, so no router dependency. Same-
// origin clicks on a link to a routed path change the page without a reload; everything else is left
// to the browser. M1-11b-2: Approvals (`/`) and one request (`/approve/<id>`, the deep link from
// the terminal, notifications and the MCP) are pages of this app; the sidebar marks Approvals.
import { useEffect, useSyncExternalStore, type ComponentType, type ReactElement } from 'react';
import { Layout } from './layout/index.js';
import { withRouteTransition } from './layout/transition.js';
import { ApprovalsPage } from './pages/approvals/index.js';
import { ApprovePage, approvalIdOf } from './pages/approve/index.js';
import { FirstRunPage } from './pages/first-run/index.js';
import { lazyPart } from './lazy/index.js';
import { PAGE_PARTS, loadRoutePage } from './lazy/pages.js';
import { COMPACT_PATH } from './pages/compact/open.js';
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

/** A Settings page fetched on first visit (UI-REFRESH-u); the first load of the app carries none. */
function lazyPage(path: string): ComponentType {
  return (PAGE_PARTS[path] as (typeof PAGE_PARTS)[string]).Part;
}

export const ROUTES: readonly RouteDef[] = [
  { path: '/', page: ApprovalsPage },
  { path: '/settings/home', page: lazyPage('/settings/home') },
  { path: '/first-run', page: FirstRunPage },
  { path: '/settings/activity', page: lazyPage('/settings/activity') },
  { path: '/settings/messages', page: lazyPage('/settings/messages') },
  { path: '/settings/contacts', page: lazyPage('/settings/contacts') },
  { path: '/settings/agents', page: lazyPage('/settings/agents') },
  { path: '/settings/files', page: lazyPage('/settings/files') },
  { path: '/settings/proofs', page: lazyPage('/settings/proofs') },
  { path: '/settings/rules', page: lazyPage('/settings/rules') },
  { path: '/settings/backup', page: lazyPage('/settings/backup') },
  { path: '/settings/passkeys', page: PasskeysPage },
  { path: '/settings/appearance', page: lazyPage('/settings/appearance') },
  { path: '/settings/advanced', page: lazyPage('/settings/advanced') },
  { path: '/settings/about', page: lazyPage('/settings/about') },
  // U3-invite (b11 §33.2): the waiting invite, in the first-run shell (no sidebar).
  { path: '/settings/join', page: lazyPage('/settings/join') },
];

/**
 * UX2-h: the compact view (B-11 §25) is a small window of its own: no sidebar, no status bar, so it is
 * not one of the shell's routes or nav items. Fetched on first visit, like the Settings pages.
 */
const CompactPart = lazyPart(async () => (await import('./pages/compact/index.js')).CompactPage);

/** The longest a route change waits for a page that is still loading. */
const LAZY_WAIT_MS = 200;
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
  const go = (): void => {
    if (replace || !changesPage) notify();
    else withRouteTransition(notify);
  };
  const lazy = PAGE_PARTS[target];
  if (lazy === undefined || lazy.ready()) {
    go();
    return;
  }
  // A page that is not loaded yet: let the transition wait for it, but at most LAZY_WAIT_MS, so the
  // skeleton (and a retry on failure) appear instead of a page that seems stuck.
  let started = false;
  const once = (): void => {
    if (started) return;
    started = true;
    go();
  };
  void loadRoutePage(target).then(once);
  setTimeout(once, LAZY_WAIT_MS);
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
  if (path === COMPACT_PATH) return <CompactPart.Part key={path} />;
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
