// UX1113-QA-HOST: the local app's page paths, one strict list for both sides. The app host
// (packages/node approval-server.ts) serves the app for exactly these paths, so a reload or a
// pasted link on any page shows the page; the router (apps/local-ui router.tsx) has a drift test
// that every path it routes, redirects or links is on this list. Each segment is lower case
// letters, digits and single hyphens; nothing deeper than listed; `/approve/<id>` is the host's own.

const SEG = '[a-z0-9]+(?:-[a-z0-9]+)*';

/** Anchored patterns, one per section. */
export const APP_PAGE_PATTERNS: readonly RegExp[] = Object.freeze([
  /^\/$/,
  /^\/(?:first-run|inbox|contacts|people)$/,
  new RegExp(`^/(?:agents|ids)(?:/${SEG})?$`),
  new RegExp(`^/start(?:/${SEG})?$`),
  /^\/activity(?:\/live)?$/,
  new RegExp(`^/advanced(?:/${SEG})?$`),
  new RegExp(`^/settings(?:/${SEG}){0,4}$`),
  new RegExp(`^/restore(?:/${SEG}){0,2}$`),
]);

/** The longest page path the host serves the app for. */
export const MAX_APP_PAGE_PATH = 200;

/** True for a path (no query) the app shows as a page. */
export function isAppPagePath(path: string): boolean {
  return path.length <= MAX_APP_PAGE_PATH && APP_PAGE_PATTERNS.some((p) => p.test(path));
}
