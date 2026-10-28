// U3-c (D-138, 08 §1): the page side of the app host's generation check.
//
// In the app host (`agentlink ui`) the server puts the generation it built the page against in the
// `agentlink-generation` meta tag and stamps every answer with the current one in
// `X-AgentLink-Generation`. This guard wraps the page's `fetch` once, at start:
// - every same-origin request that is not a GET or HEAD carries the page's generation in
//   `X-AgentLink-Generation`, so the server refuses it with `agent_changed` when another agent was
//   opened since (the switch carries it in its body as well);
// - when any same-origin answer carries another generation (a switch here or in another tab, or an
//   `agent_changed` refusal), the page reloads once, so every page shows the agent that is open now,
//   with its own contacts and history.
// Without the meta tag (an approval page opened by an MCP process, bound to its agent) nothing is
// wrapped. The guard reads and sends only that number: never a body, a token or a header value of
// the answer other than the generation, and it logs nothing.

/** The page's generation: a decimal integer, 1 or more (the server's own form). */
const GENERATION = /^[1-9][0-9]{0,15}$/;
export const GENERATION_HEADER = 'X-AgentLink-Generation';

export interface GenerationGuardOptions {
  /** The page's generation from the meta tag; undefined: not the app host. */
  readonly generation: string | undefined;
  /** The page's own origin; only same-origin requests are touched. */
  readonly origin: string;
  readonly fetch: typeof fetch;
  /** Reloads the page (called at most once). */
  readonly reload: () => void;
}

/** The generation the server put in the page, or undefined. */
export function pageGeneration(doc: Pick<Document, 'querySelector'>): string | undefined {
  const value = doc.querySelector('meta[name="agentlink-generation"]')?.getAttribute('content');
  return typeof value === 'string' && GENERATION.test(value) ? value : undefined;
}

const urlOf = (input: RequestInfo | URL, origin: string): URL | undefined => {
  try {
    if (typeof input === 'string') return new URL(input, origin);
    if (input instanceof URL) return input;
    return new URL(input.url, origin);
  } catch {
    return undefined;
  }
};

const methodOf = (input: RequestInfo | URL, init: RequestInit | undefined): string =>
  (
    init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET')
  ).toUpperCase();

/** The wrapped fetch, or undefined outside the app host (nothing to wrap). */
export function generationGuard(options: GenerationGuardOptions): typeof fetch | undefined {
  const known = options.generation;
  if (known === undefined || !GENERATION.test(known)) return undefined;
  let reloading = false;
  const base = options.fetch;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input, options.origin);
    const sameOrigin = url !== undefined && url.origin === options.origin;
    let sent = init;
    const method = methodOf(input, init);
    if (sameOrigin && method !== 'GET' && method !== 'HEAD') {
      const headers = new Headers(
        init?.headers ??
          (typeof input !== 'string' && !(input instanceof URL) ? input.headers : undefined),
      );
      headers.set(GENERATION_HEADER, known);
      sent = { ...init, headers };
    }
    const response = await base(input, sent);
    if (sameOrigin && !reloading) {
      const current = response.headers.get(GENERATION_HEADER);
      if (current !== null && GENERATION.test(current) && current !== known) {
        reloading = true;
        options.reload();
      }
    }
    return response;
  };
}

/** Wraps `window.fetch` once, before the first request (main.tsx). */
export function installGenerationGuard(win: Window = window): void {
  const guarded = generationGuard({
    generation: pageGeneration(win.document),
    origin: win.location.origin,
    fetch: win.fetch.bind(win),
    reload: () => win.location.reload(),
  });
  if (guarded !== undefined) win.fetch = guarded;
}
