// Runtime identity (M0-9 acceptance: "each runtime reports its identity, so a silent fallback to
// Node fails the run"). The answer comes from what the JavaScript engine itself exposes, never from
// the test configuration: the configuration only says which identity a project expects
// (`inject('vectorsRuntime')`), and vectors.test.ts fails when the two differ.

export type RuntimeId = 'node' | 'chromium' | 'firefox' | 'webkit' | 'workerd';

export interface RuntimeIdentity {
  /** The detected runtime, or 'unknown' when no rule matches. */
  readonly id: RuntimeId | 'unknown';
  /** Human-readable evidence for the report: the user agent and, in Node, the Node version. */
  readonly detail: string;
}

interface RuntimeGlobals {
  readonly navigator?: { readonly userAgent?: unknown };
  readonly process?: { readonly versions?: { readonly node?: unknown } };
  readonly WebSocketPair?: unknown;
  readonly window?: unknown;
  readonly document?: unknown;
}

export function observeRuntime(): RuntimeIdentity {
  const g = globalThis as RuntimeGlobals;
  const userAgent = typeof g.navigator?.userAgent === 'string' ? g.navigator.userAgent : '';
  const nodeVersion = g.process?.versions?.node;
  const isNode = typeof nodeVersion === 'string';

  // workerd: fixed user agent plus a Workers-only global. Checked first because nodejs_compat may
  // also define process.versions.node.
  if (userAgent === 'Cloudflare-Workers' && typeof g.WebSocketPair === 'function') {
    return { id: 'workerd', detail: userAgent };
  }
  if (isNode && userAgent.startsWith('Node.js/')) {
    return { id: 'node', detail: `${userAgent} (process.versions.node ${nodeVersion})` };
  }
  // A real browser: a DOM and no Node. A DOM emulation running in Node (jsdom, happy-dom) is not a
  // browser and falls through to 'unknown'.
  if (!isNode && typeof g.window === 'object' && typeof g.document === 'object') {
    if (/\bFirefox\/\d/.test(userAgent)) return { id: 'firefox', detail: userAgent };
    if (/\b(HeadlessChrome|Chrome|Chromium)\/\d/.test(userAgent)) {
      return { id: 'chromium', detail: userAgent };
    }
    if (/\bAppleWebKit\/\d/.test(userAgent) && /\bVersion\/\d/.test(userAgent)) {
      return { id: 'webkit', detail: userAgent };
    }
  }
  return { id: 'unknown', detail: userAgent || '(no navigator.userAgent)' };
}
