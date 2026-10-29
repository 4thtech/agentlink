// UI-REFRESH-u: the pages other than Approvals and first run (W4-SHELL: the Inbox, Contacts and everything under /settings), loaded on first visit. The first load of the app carries none of
// them. `loadRoutePage(path)` starts the load for a path (the router calls it before it changes page,
// so the new page usually arrives with the transition); `loadAllPages` is for tests.
import type { ComponentType } from 'react';
import { lazyPart, type LazyPart } from './index.js';

// The pages take optional props (tests pass their own); the router renders them with none.
const part = (importer: () => Promise<ComponentType<never>>): LazyPart<object> =>
  lazyPart(importer as () => Promise<ComponentType<object>>);

export const PAGE_PARTS: Readonly<Record<string, LazyPart<object>>> = {
  '/settings/home': part(async () => (await import('../pages/home/index.js')).HomePage),
  '/settings/activity': part(async () => (await import('../pages/activity/index.js')).ActivityPage),
  // W4-SHELL: the two destinations. Their builders replace the page bodies in their own folders.
  '/inbox': part(async () => (await import('../pages/messages/index.js')).MessagesPage),
  '/contacts': part(async () => (await import('../pages/contacts/index.js')).ContactsPage),
  '/settings/agents': part(async () => (await import('../pages/agents/index.js')).AgentsPage),
  '/settings/apps': part(async () => (await import('../pages/apps/index.js')).AppsPage),
  '/settings/files': part(async () => (await import('../pages/files/index.js')).FilesPage),
  '/settings/proofs': part(async () => (await import('../pages/proofs/index.js')).ProofsPage),
  '/settings/rules': part(async () => (await import('../pages/rules/index.js')).RulesPage),
  '/settings/backup': part(async () => (await import('../pages/backup/index.js')).BackupPage),
  '/settings/advanced': part(async () => (await import('../pages/advanced/index.js')).AdvancedPage),
  '/settings/appearance': part(
    async () => (await import('../pages/appearance/index.js')).AppearancePage,
  ),
  '/settings/about': part(async () => (await import('../pages/about/index.js')).AboutPage),
  // U3-invite: "Accept {name}'s invite?" (b11 §33.2), in the first-run shell.
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
  const queue = Object.keys(PAGE_PARTS);
  const next = (): void => {
    const path = queue.shift();
    if (path === undefined) return;
    void loadRoutePage(path).then(() => idle(next));
  };
  idle(next);
}
