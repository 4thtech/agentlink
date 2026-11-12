// REL051-INV: the invite page's fixed outside links and its release switches (08 §4). Every value
// here is a build constant: nothing is read from the invite, the page or the network.

/**
 * The step-by-step guides on 4thTech Docs (wiki.4thtech.io, generated from docs-site/guide at each
 * release; a page's URL is `products/agentlink/` plus its path under docs-site/guide, without `.md`).
 * The links are plain links in the HTML (new tab, no referrer); a test keeps the HTML equal to these.
 *
 * TODO(REL051-INV): when docs-site/guide/get-started/students.md ("Students: start here") is
 * published, point `guide` at `${DOCS_BASE}/get-started/students`.
 */
export const DOCS_BASE = 'https://wiki.4thtech.io/products/agentlink';
export const DOCS_LINKS = {
  /** "Install AgentLink" (docs-site/guide/get-started/start-fast.md). */
  guide: `${DOCS_BASE}/get-started/start-fast`,
  /** "Windows" (docs-site/guide/get-started/windows.md). */
  windows: `${DOCS_BASE}/get-started/windows`,
} as const;

/**
 * The Mac app (early build, not signed by Apple yet; planned for 0.5.1). OFF until that build is
 * released: while it is false the page never mentions the app and its link has no `href`. Turn it on
 * in the release PR, after checking that `MAC_APP_URL` downloads the released file.
 */
export const MAC_APP_AVAILABLE = false;

/** The release the Mac app link names (its GitHub Release tag is `v` plus this). */
export const MAC_APP_VERSION = '0.5.1';

/**
 * The Mac app's file name, as the desktop build writes it (apps/desktop/build/build-mac.mjs on
 * desktop/integration-051: `AgentLink-<version>-mac-<arch>.dmg`, arch arm64 or x64). The page links
 * the Apple silicon (arm64) build.
 */
export const macAppAsset = (version: string): string => `AgentLink-${version}-mac-arm64.dmg`;

/** The Mac app's download: that exact asset of that exact GitHub Release (never `latest`). */
export const MAC_APP_URL = `https://github.com/4thtech/agentlink/releases/download/v${MAC_APP_VERSION}/${macAppAsset(MAC_APP_VERSION)}`;
