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
// - U3-g-b: one exception. A successful first-run `finish` (POST, 200) that the server marks with
//   `X-AgentLink-Generation-Adopted: 1` opened the first agent in this same host: the page adopts its
//   generation (sent from then on) instead of reloading, so the one-time backup code stays on screen.
//   Other answers seen while that finish was in flight are checked against it once it settled.
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

/**
 * U3-g-b (IR-U3-g-b-1 H-1): the server's mark on the one answer whose new generation the page adopts
 * instead of reloading: a successful first-run `finish` (POST FINISH_PATH, 200) that opened the first
 * agent in the same host. On any other answer it is ignored (a mismatch still reloads).
 */
export const ADOPTED_HEADER = 'X-AgentLink-Generation-Adopted';
const FINISH_PATH = '/api/ui/first-run/owner/finish';

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
  const first = options.generation;
  if (first === undefined || !GENERATION.test(first)) return undefined;
  let known: string = first;
  let reloading = false;
  // U3-g-b: first-run finishes in flight, and the newest other generation seen meanwhile (checked
  // once they settled, so a read answered after the host opened the first agent does not reload).
  let finishing = 0;
  let seenWhileFinishing: string | undefined;
  const base = options.fetch;
  const reload = (): void => {
    if (reloading) return;
    reloading = true;
    options.reload();
  };
  const check = (current: string): void => {
    if (current === known) return;
    if (finishing > 0) seenWhileFinishing = current;
    else reload();
  };
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
    const isFinish = sameOrigin && method === 'POST' && url?.pathname === FINISH_PATH;
    if (isFinish) finishing += 1;
    let response: Response;
    try {
      response = await base(input, sent);
    } finally {
      if (isFinish) finishing -= 1;
    }
    if (sameOrigin && !reloading) {
      const current = response.headers.get(GENERATION_HEADER);
      const valid = current !== null && GENERATION.test(current);
      if (
        isFinish &&
        valid &&
        response.status === 200 &&
        response.headers.get(ADOPTED_HEADER) === '1'
      ) {
        // The first agent was opened by this very answer: adopt its generation.
        known = current;
      } else if (valid) check(current);
      if (finishing === 0 && seenWhileFinishing !== undefined) {
        const seen = seenWhileFinishing;
        seenWhileFinishing = undefined;
        if (seen !== known) reload();
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
