// A small History-API router: the app has a handful of fixed routes, so no router dependency. Same-
// origin clicks on a link to a routed path change the page without a reload; everything else is left
// to the browser. M1-11b-2: Approvals (`/`) and one request (`/approve/<id>`, the deep link from
// the terminal, notifications and the MCP) are pages of this app.
// W4-SHELL (Decision 40): two destinations, the Inbox and Contacts. Approvals (`/`, where every
// approval link points) and one request mark the Inbox until the Inbox holds them (b11 §34.4). Another agent opened (here or in another tab) never reloads the page: the generation guard
// hands the change to the router, which swaps the whole shell and page for the agent that is open
// now (same route, same document) and only then lets changes carry the new generation.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
} from 'react';
import { onAgentChanged } from './api/generation.js';
import { Layout } from './layout/index.js';
import { withRouteTransition } from './layout/transition.js';
import { ApprovalsPage } from './pages/approvals/index.js';
import { ApprovePage, approvalIdOf } from './pages/approve/index.js';
import { FirstRunPage } from './pages/first-run/index.js';
import { lazyPart } from './lazy/index.js';
import { PAGE_PARTS, loadRoutePage } from './lazy/pages.js';
import { COMPACT_PATH } from './pages/compact/open.js';
import { announceAgentsChanged, useSwitchedNote } from './pages/agents/use-agents.js';
import { APPROVALS_PATH, INBOX_PATH, REDIRECTS } from './nav.js';
import { NotAvailablePage, NotFoundPage } from './states/index.js';
import { PAGE_TITLES } from './strings.js';

export interface RouteDef {
  readonly path: string;
  readonly page: ComponentType;
}

/** Notifications has no page yet: a plain stub, replaced when its card lands. */
function NotificationsPage(): ReactElement {
  return <NotAvailablePage title={PAGE_TITLES.notifications} />;
}

/** A Settings page fetched on first visit (UI-REFRESH-u); the first load of the app carries none. */
function lazyPage(path: string): ComponentType {
  return (PAGE_PARTS[path] as (typeof PAGE_PARTS)[string]).Part;
}

export const ROUTES: readonly RouteDef[] = [
  // W4-SHELL: the two destinations (b11 §34.1). Today's pages; their builders replace the bodies.
  { path: INBOX_PATH, page: lazyPage(INBOX_PATH) },
  { path: '/contacts', page: lazyPage('/contacts') },
  // Approvals fold into the Inbox (b11 §34.4); until then the waiting list is a page of its own.
  { path: APPROVALS_PATH, page: ApprovalsPage },
  { path: '/first-run', page: FirstRunPage },
  { path: '/settings/home', page: lazyPage('/settings/home') },
  { path: '/settings/agents', page: lazyPage('/settings/agents') },
  { path: '/settings/files', page: lazyPage('/settings/files') },
  // Settings (b11 §34.6).
  { path: '/settings/apps', page: lazyPage('/settings/apps') },
  { path: '/settings/backup', page: lazyPage('/settings/backup') },
  { path: '/settings/appearance', page: lazyPage('/settings/appearance') },
  { path: '/settings/proofs', page: lazyPage('/settings/proofs') },
  { path: '/settings/rules', page: lazyPage('/settings/rules') },
  { path: '/settings/notifications', page: NotificationsPage },
  // Advanced.
  { path: '/settings/activity', page: lazyPage('/settings/activity') },
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

function isRouted(path: string): boolean {
  return (
    path in REDIRECTS || ROUTES.some((r) => r.path === path) || approvalIdOf(path) !== undefined
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

/**
 * W4-SHELL: another agent was opened. Bumps the epoch that keys the shell, so every view (the
 * switcher, the badges, the page) mounts again for the agent that is open now, in the same document
 * and on the same route; then adopts the new generation, before any of the new views' requests.
 */
function useAgentEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  const adopt = useRef<(() => void) | undefined>(undefined);
  useEffect(
    () =>
      onAgentChanged((_next, adoptNext) => {
        adopt.current = adoptNext;
        setEpoch((e) => e + 1);
        announceAgentsChanged();
      }),
    [],
  );
  // A layout effect runs after the old views are gone and before the new ones' effects send anything.
  useLayoutEffect(() => {
    const run = adopt.current;
    adopt.current = undefined;
    run?.();
  }, [epoch]);
  return epoch;
}

/** The whole app below the root: layout plus the page for the current path. */
export function AppRoutes(): ReactElement {
  const path = usePath();
  const epoch = useAgentEpoch();
  const note = useSwitchedNote();
  useEffect(() => {
    document.addEventListener('click', onDocumentClick);
    return () => document.removeEventListener('click', onDocumentClick);
  }, []);
  useEffect(() => {
    if (path in REDIRECTS) navigate(REDIRECTS[path] as string, true);
  }, [path]);
  if (path === COMPACT_PATH) return <CompactPart.Part key={`${path}#${epoch}`} />;
  const shown = REDIRECTS[path] ?? path;
  // One request belongs to the Inbox (approvals fold into it): the same nav item is current.
  const oneRequest = approvalIdOf(shown) !== undefined;
  const route = ROUTES.find((r) => r.path === shown);
  const Page = oneRequest ? ApprovePage : (route?.page ?? NotFoundPage);
  return (
    <>
      <Layout key={epoch} path={oneRequest ? APPROVALS_PATH : shown}>
        <Page key={shown} />
      </Layout>
      {/* "Now showing {label}" after a switch (b11 §29.9), outside the views that remount. */}
      <p className="al-sr-only" role="status" aria-live="polite">
        {note}
      </p>
    </>
  );
}
