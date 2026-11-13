// REL051-INV: the invite page's fixed outside links and its release switches (08 §4). Every value
// here is a build constant: nothing is read from the invite, the page or the network.

/**
 * The step-by-step guides on 4thTech Docs (wiki.4thtech.io, generated from docs-site/guide at each
 * release; a page's URL is `products/agentlink/` plus its path under docs-site/guide, without `.md`).
 * The links are plain links in the HTML (new tab, no referrer); a test keeps the HTML equal to these.
 */
export const DOCS_BASE = 'https://wiki.4thtech.io/products/agentlink';
export const DOCS_LINKS = {
  /** "Start here" (docs-site/guide/start-here.md), on the wiki since the 0.5.1 release. */
  guide: `${DOCS_BASE}/start-here`,
  /** "Windows" (docs-site/guide/get-started/windows.md). */
  windows: `${DOCS_BASE}/get-started/windows`,
} as const;

/**
 * The Mac app (early build, not signed by Apple yet; planned for 0.5.1). OFF until that build is
 * released: while it is false the page never mentions the app and its link has no `href`. Turn it on
 * in the release PR, after checking that both `MAC_APP_URLS` download the released files.
 */
export const MAC_APP_AVAILABLE = true;

/**
 * The Mac app's downloads: the stable file names of the newest GitHub Release marked Latest
 * (`AgentLink-mac-<arch>.dmg`, Apple chip arm64 and Intel x64). The release workflow uploads these
 * copies and marks the Release Latest only after both are attached, so the links never go stale.
 */
const macAppUrl = (arch: 'arm64' | 'x64'): string =>
  `https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-mac-${arch}.dmg`;

export const MAC_APP_URLS = { arm64: macAppUrl('arm64'), x64: macAppUrl('x64') } as const;
