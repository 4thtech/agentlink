// WP-D9 build-time flag: "Open in the AgentLink app" and "Get the app" on the invite page.
//
// `__AGENTLINK_DESKTOP_APP_LINKS__` is a BUILD-TIME constant set by vite.config.ts (`define`). It is
// `false` until the desktop app is released: the page deployed on every main change to apps/invite
// then renders neither link (they stay hidden, with no address and no text), and the bundler drops
// the branch that fills them. The desktop release turns it on in vite.config.ts. In unit tests and
// an unbundled run the constant is undefined, which also means off.
declare const __AGENTLINK_DESKTOP_APP_LINKS__: boolean | undefined;

/** True only in a build made with the desktop app links turned on. */
export const DESKTOP_APP_LINKS: boolean =
  typeof __AGENTLINK_DESKTOP_APP_LINKS__ !== 'undefined' && __AGENTLINK_DESKTOP_APP_LINKS__;

/** "Get the app": the desktop app page of the public docs (used only when the flag is on). */
export const GET_APP_URL =
  'https://github.com/4thtech/agentlink/blob/main/docs-site/guide/apps/desktop-app.md';
