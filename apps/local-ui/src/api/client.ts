// The only way the app talks to the server: same-origin `/api/...` with the page's session token
// (the `agentlink-csrf` meta tag the server fills in, sent as `X-AgentLink-CSRF`, as the approval
// page does). The browser never signs: owner actions are server calls (D-118). Statuses become typed
// results; bodies and the token are never logged.

export type ApiResult<T> =
  | { readonly kind: 'ok'; readonly status: number; readonly data: T }
  | { readonly kind: 'session_expired' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'presence_required' }
  | { readonly kind: 'not_available' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'error'; readonly status: number };

export interface ApiClientOptions {
  readonly fetch?: typeof fetch;
  /** The session token; by default read from the page's meta tag on each call. */
  readonly token?: string;
}

export interface ApiClient {
  get<T = unknown>(path: string): Promise<ApiResult<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>>;
}

const CSRF_HEADER = 'X-AgentLink-CSRF';

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

function checkPath(path: string): void {
  // Same-origin API only: a path from anywhere else is a bug, never a request.
  if (!path.startsWith('/api/') || path.startsWith('//') || /[\\\t\n\r]/.test(path)) {
    throw new Error('api path must start with /api/');
  }
  // IR-M1-11b-1-1 L-4: no `.` or `..` segment, plain or percent-encoded, in the path part.
  const pathPart = path.split(/[?#]/, 1)[0] ?? '';
  if (pathPart.split('/').some((seg) => /^(?:\.|%2e){1,2}$/i.test(seg))) {
    throw new Error('api path must not contain dot segments');
  }
}

async function readJson(res: Response): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await res.json() };
  } catch {
    return { ok: false };
  }
}

function isPresenceRequired(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { status?: unknown }).status === 'presence_required'
  );
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    checkPath(path);
    const headers = new Headers({ [CSRF_HEADER]: options.token ?? pageToken() });
    const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await doFetch(path, init);
    } catch {
      return { kind: 'offline' };
    }
    const parsed = await readJson(res);
    if (parsed.ok && isPresenceRequired(parsed.value)) return { kind: 'presence_required' };
    if (res.status === 401) return { kind: 'session_expired' };
    if (res.status === 501) return { kind: 'not_available' };
    if (res.status === 403) return { kind: 'forbidden' };
    if (!res.ok || !parsed.ok) return { kind: 'error', status: res.status };
    return { kind: 'ok', status: res.status, data: parsed.value as T };
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
  };
}
