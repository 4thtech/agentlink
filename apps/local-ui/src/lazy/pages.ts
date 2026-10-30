// UI-REFRESH-u: the pages other than Approvals and first run, loaded on first visit (W4-SHELL-V2:
// the sections, Settings and Advanced). The first load of the app carries none of
// them. `loadRoutePage(path)` starts the load for a path (the router calls it before it changes page,
// so the new page usually arrives with the transition); `loadAllPages` is for tests.
import type { ComponentType } from 'react';
import { lazyPart, type LazyPart } from './index.js';

// The pages take optional props (tests pass their own); the router renders them with none.
const part = (importer: () => Promise<ComponentType<never>>): LazyPart<object> =>
  lazyPart(importer as () => Promise<ComponentType<object>>);

const activity = part(async () => (await import('../pages/activity/index.js')).ActivityPage);
const agents = part(async () => (await import('../pages/agents/index.js')).AgentsPage);
const rules = part(async () => (await import('../pages/rules/index.js')).RulesPage);
const proofs = part(async () => (await import('../pages/proofs/index.js')).ProofsPage);
const advanced = part(async () => (await import('../pages/advanced/index.js')).AdvancedPage);
const about = part(async () => (await import('../pages/about/index.js')).AboutPage);

/**
 * W4-SHELL-V2: every lazy page by path. Same routes in both layers; the section builders replace the
 * page bodies in their own folders (U3 Home, U5 Agents, U6 Activity, Settings and Advanced).
 */
export const PAGE_PARTS: Readonly<Record<string, LazyPart<object>>> = {
  '/agents': agents,
  '/activity': activity,
  // Interim: today's Messages and Contacts pages (U3, U4 fold them into Home).
  '/inbox': part(async () => (await import('../pages/messages/index.js')).MessagesPage),
  '/contacts': part(async () => (await import('../pages/contacts/index.js')).ContactsPage),
  // Settings (A9).
  '/settings/backup': part(async () => (await import('../pages/backup/index.js')).BackupPage),
  '/settings/apps': part(async () => (await import('../pages/apps/index.js')).AppsPage),
  '/settings/files': part(async () => (await import('../pages/files/index.js')).FilesPage),
  '/settings/appearance': part(
    async () => (await import('../pages/appearance/index.js')).AppearancePage,
  ),
  '/settings/rules': rules,
  '/settings/proofs': proofs,
  // Advanced (Under the hood).
  '/advanced/rules': rules,
  '/advanced/proofs': proofs,
  '/advanced/network': advanced,
  '/advanced/diagnostics': about,
  // U3-invite: "Accept {name}'s invite?" (b11 §33.2), in the focused shell.
  '/settings/join': part(async () => (await import('../pages/join/index.js')).JoinPage),
};

/** Start loading the page of a path, if that page is a lazy one. Never throws. */
export function loadRoutePage(path: string): Promise<void> {
  const p = PAGE_PARTS[path];
  return p === undefined ? Promise.resolve() : p.load().catch(() => undefined);
}

export async function loadAllPages(): Promise<void> {
  await Promise.all(Object.keys(PAGE_PARTS).map(loadRoutePage));
}

type Idle = (run: () => void) => void;

const whenIdle: Idle = (run) => {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 3000 });
  } else {
    window.setTimeout(run, 300);
  }
};

/**
 * After the first screen is up, fetch the other pages one at a time while the browser is idle, so a
 * later visit finds its page ready and the route change has nothing to parse. The first load never
 * includes them; a failed fetch is ignored here (a visit tries again and shows the retry message).
 */
export function prefetchPages(idle: Idle = whenIdle): void {
  // One fetch per page part (several paths share one).
  const seen = new Set<LazyPart<object>>();
  const queue = Object.keys(PAGE_PARTS).filter((path) => {
    const p = PAGE_PARTS[path] as LazyPart<object>;
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  const next = (): void => {
    const path = queue.shift();
    if (path === undefined) return;
    void loadRoutePage(path).then(() => idle(next));
  };
  idle(next);
}
