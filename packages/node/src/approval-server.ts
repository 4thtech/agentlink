// M1-8d: the local approval server (08 §1; 04 §2.5; 06 §2.5; I-4, I-7).
//
// What it is: an HTTP server inside the MCP/CLI process, on 127.0.0.1 and a random port, that shows
// the agent's pending approval requests and lets the owner approve or deny one with owner presence.
// The M1b `ApprovalChannel` that returns its `/approve/<id>` link, the full local UI and the localhost
// passkey are later cards (M1-11a, M1-11c, M1-8e); this module is the server and its security rules.
//
// Rules (each has a test in approval-server.test.ts):
// - Listens on 127.0.0.1 only (never 0.0.0.0 or ::). Requests from a non-loopback peer are refused.
// - A random 256-bit session token, in memory only, is put in the URL the process opens (`/?t=…`);
//   the first request exchanges it for an HttpOnly, SameSite=Lax session cookie scoped to this port's
//   name and redirects to the same path without the token. No token, cookie or CSRF value is written
//   to disk, logged, put in an event, an approval URL or an error body.
// - DNS rebinding: the `Host` header must be exactly `127.0.0.1:<port>`; any `Origin` header present
//   must be exactly `http://127.0.0.1:<port>`; a POST must carry that Origin.
// - Cross-site requests: no CORS grant ever; API calls need a per-server CSRF token (in the page,
//   never in the URL) in `X-AgentLink-CSRF` and fetch metadata that is absent or `same-origin`; a
//   decision is a POST with `Content-Type: application/octet-stream` (not a simple request).
// - The token grants viewing only (08 §1). A decision needs owner presence: the owner code or owner
//   passphrase, sent as the raw request body, unlocks the owner key for exactly one owner operation
//   (04 §2.5, D-68: one `approval.decide`), and the buffer is wiped. The signed object goes to the
//   source (core's `ownerActions.apply`), which verifies it (I-4). No route decides without it; the
//   localhost passkey path (WebAuthn PRF) is M1-8e.
// - What is signed is what the page showed: the page sends back the action digest it displayed; the
//   server re-reads the request, recomputes the digest from the stored action and refuses any
//   difference before the owner store is opened.
// - One owner operation at a time; an approval ID decided through this server is never decided
//   again through it (the core's nonce and row state are the authority; this is defence in depth).
//
// Out of scope and accepted (G-1, D-67; 04 §2.5): a same-user process that reads memory, modifies the
// installed package, or serves a look-alike page on another localhost port. Cookies are not isolated
// by port, so another local server the owner's browser visits could receive the session cookie; it
// grants viewing only. The opener's argv briefly holds the session link (approval-os.ts).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OwnerActionOutcome } from '@agentlink/core';
import {
  KeyStoreError,
  canonicalizeToBytes,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  equalBytes,
  randomBytes,
  sha256,
  wipe,
  type JsonObject,
  type JsonValue,
  type OwnerPublicKeys,
} from '@agentlink/crypto';
import { osBrowserOpener, osNotifier, type BrowserOpener, type OsNotifier } from './approval-os.js';
import { APP_JS, EXPIRED_HTML, pageHtml } from './approval-page.js';
import { NodeKeyStoreError } from './errors.js';
import { osKeychain } from './keychain.js';
import { decideReviewedWith, type ApprovalContext } from './owner-approval.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import type { PromptingOwnerKeyStore } from './owner-operation.js';
import type { OwnerTerminal } from './owner-terminal.js';

/** 08 §1: the local UI is served on this address. The origin question is M1-31. */
export const APPROVAL_SERVER_HOST = '127.0.0.1';
/** Longest accepted owner secret in bytes (the same bound as the TTY prompt). */
const MAX_SECRET_BYTES = 1024;
const NOTIFICATION = ['AgentLink', 'An approval is waiting for you.'] as const;

const APPROVAL_ID = /^apr_[A-Za-z0-9_-]{22}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const APPROVE_PAGE = /^\/approve\/(apr_[A-Za-z0-9_-]{22})$/;
const API_ONE = /^\/api\/approvals\/(apr_[A-Za-z0-9_-]{22})$/;
const API_DECIDE = /^\/api\/approvals\/(apr_[A-Za-z0-9_-]{22})\/(approve|deny)$/;

/** One pending request as the page shows it. `summary` is fixed text built by core (I-5, 06 §2.1). */
export interface PendingApprovalView {
  readonly approvalId: string;
  readonly summary: string;
  /** sha256(JCS(action)) as stored with the request, 64 lowercase hex. */
  readonly actionDigest: string;
  /** Unix seconds. */
  readonly expiresAt: number;
  /** A commitment (D-31): decided alone. */
  readonly commitment: boolean;
}

/** One live pending request, re-read for a decision, with the stored action it covers. */
export interface ApprovalForDecision extends PendingApprovalView {
  /** The stored action, parsed strictly by core; the server recomputes its digest. */
  readonly action: JsonValue;
  /** The digest stored with the request (04 §3.4.1). */
  readonly storedDigest: string;
}

/**
 * What the server needs from the agent's core (wired by the CLI with M1-11a). Read methods only,
 * plus `apply`, which is core's `ownerActions.apply`: it verifies the owner signature and applies the
 * decision in one store transaction (M1-7d, M1-7e). The server never changes a row itself.
 */
export interface ApprovalServerSource {
  /** The agent and the owner its card names; undefined when no identity or owner is set up. */
  context(): Promise<ApprovalContext | undefined>;
  /** The live pending requests, as views. */
  list(): Promise<readonly PendingApprovalView[]>;
  /** Re-reads one live pending request; undefined when it is not pending (or does not parse). */
  get(approvalId: string): Promise<ApprovalForDecision | undefined>;
  /** core `ownerActions.apply`. */
  apply(signed: { readonly body: JsonObject; readonly sig: string }): Promise<OwnerActionOutcome>;
}

/** Structured events, fixed values only: never a token, URL, secret, ID or request text (I-7). */
export type ApprovalServerEvent =
  | { readonly kind: 'listening' }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'peer'
        | 'host'
        | 'origin'
        | 'fetch_site'
        | 'token'
        | 'csrf'
        | 'method'
        | 'content_type'
        | 'too_large'
        | 'not_found';
    }
  | {
      readonly kind: 'decision';
      readonly outcome:
        | 'applied'
        | 'refused'
        | 'presence_required'
        | 'presence_rejected'
        | 'not_pending'
        | 'changed'
        | 'busy'
        | 'needs_setup'
        | 'failed';
    }
  | { readonly kind: 'closed' };

export interface ApprovalServerOptions {
  readonly source: ApprovalServerSource;
  /** Receives fixed-value events (for the redacting logger). Exceptions in it are ignored. */
  readonly onEvent?: (event: ApprovalServerEvent) => void;
}

/** Internal (tests): the owner store, browser opener and notifier seams. Not exported from index. */
export interface ApprovalServerInternals {
  readonly openOwnerStore?: (owner: OwnerPublicKeys) => Promise<PromptingOwnerKeyStore>;
  readonly opener?: BrowserOpener;
  readonly notifier?: OsNotifier;
}

export interface ApprovalServer {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  readonly port: number;
  address(): { readonly address: string; readonly port: number };
  /**
   * The link for one request, as the agent's `pending_approval.url` (06 §2.5). It never holds the
   * session token: it works in a browser that already opened the session link.
   */
  approvalUrl(approvalId: string): string;
  /**
   * Opens the owner's browser at the session link (`/?t=…`), or at `/approve/<id>?t=…`. The link is
   * handed only to the OS opener, never returned. Resolves false when no browser could be started.
   */
  open(approvalId?: string): Promise<boolean>;
  /** Raises the fixed OS notification for a new request and returns its approvalUrl. */
  notifyNewApproval(approvalId: string): Promise<string>;
  close(): Promise<void>;
}

type DecisionOutcome = Extract<ApprovalServerEvent, { kind: 'decision' }>['outcome'];
type RejectReason = Extract<ApprovalServerEvent, { kind: 'rejected' }>['reason'];

const invalidId = (): NodeKeyStoreError =>
  new NodeKeyStoreError('owner_operation_invalid', 'That is not a valid approval ID.');

/** A terminal for one page decision: shows nothing, the click was the confirmation, one secret. */
function pageTerminal(secret: Uint8Array): OwnerTerminal {
  let given = false;
  return {
    write: () => undefined,
    // The owner clicked Approve or Deny on the card for exactly this request and digest.
    confirm: () => Promise.resolve(true),
    readSecret: () => {
      if (given) return Promise.reject(new KeyStoreError('presence_rejected', 'presence'));
      given = true;
      return Promise.resolve(secret);
    },
    clearScreen: () => undefined,
  };
}

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
}

function sendText(res: ServerResponse, status: number, type: string, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, value: unknown): void =>
  sendText(res, status, 'application/json; charset=utf-8', JSON.stringify(value));

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** The view sent to the page: only checked, structured fields; never the action. */
function view(item: unknown): PendingApprovalView | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const { approvalId, summary, actionDigest, expiresAt, commitment } = item as Record<
    string,
    unknown
  >;
  if (typeof approvalId !== 'string' || !APPROVAL_ID.test(approvalId)) return undefined;
  if (typeof summary !== 'string' || summary.length === 0) return undefined;
  if (typeof actionDigest !== 'string' || !DIGEST.test(actionDigest)) return undefined;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) return undefined;
  if (typeof commitment !== 'boolean') return undefined;
  return { approvalId, summary, actionDigest, expiresAt, commitment };
}

/** Starts the server with the test seams (internal; the package entry is startApprovalServer). */
export async function startApprovalServerWith(
  options: ApprovalServerOptions,
  internals: ApprovalServerInternals = {},
): Promise<ApprovalServer> {
  const { source } = options;
  const openOwnerStore =
    internals.openOwnerStore ??
    ((owner: OwnerPublicKeys) => KeychainOwnerKeyStore.open(osKeychain(), owner));
  const opener = internals.opener ?? osBrowserOpener;
  const notifier = internals.notifier ?? osNotifier;
  const emit = (event: ApprovalServerEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // A failing listener never changes an answer.
    }
  };

  const token = encodeBase64url(randomBytes(32));
  const tokenBytes = encodeUtf8(token);
  const csrf = encodeBase64url(randomBytes(32));
  const csrfBytes = encodeUtf8(csrf);
  const decided = new Set<string>();
  let busy = false;

  const server: Server = createServer({
    requestTimeout: 30_000,
    headersTimeout: 10_000,
    maxHeaderSize: 16_384,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: APPROVAL_SERVER_HOST, port: 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const hostValue = `${APPROVAL_SERVER_HOST}:${String(port)}`;
  const origin = `http://${hostValue}`;
  const cookieName = `agentlink_${String(port)}`;

  const matches = (candidate: string | undefined, expected: Uint8Array): boolean =>
    candidate !== undefined &&
    candidate.length > 0 &&
    candidate.length <= 128 &&
    BASE64URL.test(candidate) &&
    equalBytes(encodeUtf8(candidate), expected);

  const cookieToken = (req: IncomingMessage): string | undefined => {
    const raw = header(req, 'cookie');
    if (raw === undefined) return undefined;
    for (const part of raw.split(';')) {
      const at = part.indexOf('=');
      if (at > 0 && part.slice(0, at).trim() === cookieName) return part.slice(at + 1).trim();
    }
    return undefined;
  };

  const reject = (res: ServerResponse, status: number, reason: RejectReason): void => {
    emit({ kind: 'rejected', reason });
    if (status === 401) {
      sendText(res, 401, 'text/html; charset=utf-8', EXPIRED_HTML);
    } else {
      sendJson(res, status, { status: 'refused' });
    }
  };

  const fetchSiteOk = (req: IncomingMessage): boolean => {
    const site = header(req, 'sec-fetch-site');
    return site === undefined || site === 'same-origin';
  };

  /** Reads the owner secret body into one bounded buffer; chunks are wiped after copying. */
  const readSecret = (req: IncomingMessage): Promise<Uint8Array | 'too_large'> =>
    new Promise((resolve, rejectRead) => {
      const buffer = new Uint8Array(MAX_SECRET_BYTES);
      let length = 0;
      let over = false;
      req.on('data', (chunk: Buffer) => {
        if (!over && length + chunk.length <= MAX_SECRET_BYTES) {
          buffer.set(chunk, length);
          length += chunk.length;
        } else {
          over = true;
        }
        chunk.fill(0);
      });
      req.on('end', () => {
        if (over) {
          wipe(buffer);
          resolve('too_large');
          return;
        }
        const out = buffer.slice(0, length);
        wipe(buffer);
        resolve(out);
      });
      req.on('error', (error) => {
        wipe(buffer);
        rejectRead(error);
      });
    });

  const finishDecision = (
    res: ServerResponse,
    status: number,
    outcome: DecisionOutcome,
    extra: Record<string, unknown> = {},
  ): void => {
    emit({ kind: 'decision', outcome });
    sendJson(res, status, { status: outcome, ...extra });
  };

  async function decide(
    req: IncomingMessage,
    res: ServerResponse,
    approvalId: string,
    decision: 'approve' | 'deny',
  ): Promise<void> {
    const declared = Number(header(req, 'content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_SECRET_BYTES) {
      res.setHeader('Connection', 'close');
      reject(res, 413, 'too_large');
      req.resume();
      return;
    }
    const body = await readSecret(req);
    if (body === 'too_large') {
      reject(res, 413, 'too_large');
      return;
    }
    let secret: Uint8Array | undefined = body;
    try {
      if (secret.length === 0) {
        finishDecision(res, 403, 'presence_required');
        return;
      }
      // Check and claim with no await in between: one owner operation at a time.
      if (decided.has(approvalId)) {
        finishDecision(res, 409, 'not_pending');
        return;
      }
      if (busy) {
        finishDecision(res, 409, 'busy');
        return;
      }
      busy = true;
      try {
        const shown = header(req, 'x-agentlink-digest');
        const entry = await source.get(approvalId);
        if (entry?.approvalId !== approvalId || decided.has(approvalId)) {
          finishDecision(res, 409, 'not_pending');
          return;
        }
        let recomputed: string;
        try {
          recomputed = encodeHex(sha256(canonicalizeToBytes(entry.action)));
        } catch {
          finishDecision(res, 409, 'changed');
          return;
        }
        if (
          shown === undefined ||
          !DIGEST.test(shown) ||
          recomputed !== entry.storedDigest ||
          shown !== entry.storedDigest
        ) {
          // 04 §2.5.2 step 2: a request whose digest does not match is never offered.
          finishDecision(res, 409, 'changed');
          return;
        }
        const context = await source.context();
        if (context === undefined) {
          finishDecision(res, 503, 'needs_setup');
          return;
        }
        let store: PromptingOwnerKeyStore;
        try {
          store = await openOwnerStore(context.owner);
        } catch {
          finishDecision(res, 503, 'needs_setup');
          return;
        }
        let signed: { readonly body: JsonObject; readonly sig: string };
        try {
          const typed = secret;
          secret = undefined; // unlock wipes it, whether or not it unlocks
          signed = await decideReviewedWith(store, pageTerminal(typed), context, [
            {
              approvalId,
              action: entry.action,
              storedDigest: entry.storedDigest,
              decision,
              commitment: entry.commitment,
              summary: entry.summary,
              requestExpiresAt: entry.expiresAt,
            },
          ]);
        } catch (error) {
          if (error instanceof KeyStoreError && error.code === 'presence_rejected') {
            finishDecision(res, 403, 'presence_rejected');
          } else if (error instanceof NodeKeyStoreError) {
            finishDecision(res, 409, 'changed');
          } else {
            finishDecision(res, 500, 'failed');
          }
          return;
        } finally {
          await store.close().catch(() => undefined);
        }
        const outcome = await source.apply(signed);
        if (outcome.status === 'applied') {
          decided.add(approvalId);
          finishDecision(res, 200, 'applied', { decision });
        } else {
          finishDecision(res, 409, 'refused');
        }
      } finally {
        busy = false;
      }
    } finally {
      if (secret !== undefined) wipe(secret);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCommonHeaders(res);
    const peer = req.socket.remoteAddress;
    if (peer !== '127.0.0.1' && peer !== '::ffff:127.0.0.1') {
      reject(res, 403, 'peer');
      return;
    }
    if (header(req, 'host') !== hostValue) {
      reject(res, 403, 'host');
      return;
    }
    const originHeader = header(req, 'origin');
    if (originHeader !== undefined && originHeader !== origin) {
      reject(res, 403, 'origin');
      return;
    }
    const raw = req.url ?? '/';
    if (!raw.startsWith('/')) {
      reject(res, 404, 'not_found');
      return;
    }
    const url = new URL(raw, origin);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/app.js') {
      if (method !== 'GET') return reject(res, 405, 'method');
      sendText(res, 200, 'text/javascript; charset=utf-8', APP_JS);
      return;
    }

    const page = path === '/' || APPROVE_PAGE.test(path);
    if (page) {
      if (method !== 'GET') return reject(res, 405, 'method');
      const t = url.searchParams.get('t');
      if (t !== null) {
        if (!matches(t, tokenBytes)) return reject(res, 401, 'token');
        res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/`);
        res.setHeader('Location', path);
        sendText(res, 303, 'text/plain; charset=utf-8', '');
        return;
      }
      if (!matches(cookieToken(req), tokenBytes)) return reject(res, 401, 'token');
      sendText(res, 200, 'text/html; charset=utf-8', pageHtml(csrf));
      return;
    }

    const one = API_ONE.exec(path);
    const decideMatch = API_DECIDE.exec(path);
    if (path !== '/api/approvals' && one === null && decideMatch === null) {
      reject(res, 404, 'not_found');
      return;
    }
    const wanted = decideMatch === null ? 'GET' : 'POST';
    if (method !== wanted) return reject(res, 405, 'method');
    if (!matches(cookieToken(req), tokenBytes)) return reject(res, 401, 'token');
    if (!fetchSiteOk(req)) return reject(res, 403, 'fetch_site');
    if (decideMatch !== null && originHeader === undefined) return reject(res, 403, 'origin');
    if (!matches(header(req, 'x-agentlink-csrf'), csrfBytes)) return reject(res, 403, 'csrf');

    if (decideMatch !== null) {
      const type = (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
      if (type !== 'application/octet-stream') return reject(res, 415, 'content_type');
      await decide(req, res, decideMatch[1] as string, decideMatch[2] as 'approve' | 'deny');
      return;
    }
    if (one !== null) {
      const item = view(await source.get(one[1] as string));
      if (item === undefined || decided.has(item.approvalId)) {
        return reject(res, 404, 'not_found');
      }
      sendJson(res, 200, { approval: item });
      return;
    }
    const approvals = (await source.list())
      .map(view)
      .filter((i): i is PendingApprovalView => i !== undefined && !decided.has(i.approvalId));
    sendJson(res, 200, { approvals });
  }

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { status: 'failed' });
      else res.destroy();
    });
  });
  emit({ kind: 'listening' });

  const approvalUrl = (approvalId: string): string => {
    if (typeof approvalId !== 'string' || !APPROVAL_ID.test(approvalId)) throw invalidId();
    return `${origin}/approve/${approvalId}`;
  };

  return Object.freeze<ApprovalServer>({
    origin,
    port,
    address: () => ({ address: APPROVAL_SERVER_HOST, port }),
    approvalUrl,
    open: async (approvalId?: string) => {
      // A malformed ID rejects the returned promise (never a synchronous throw).
      const path = approvalId === undefined ? '/' : new URL(approvalUrl(approvalId)).pathname;
      return opener(`${origin}${path}?t=${token}`).catch(() => false);
    },
    notifyNewApproval: async (approvalId: string) => {
      const url = approvalUrl(approvalId);
      await notifier(NOTIFICATION).catch(() => false);
      return url;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          emit({ kind: 'closed' });
          resolve();
        });
        server.closeAllConnections();
      }),
  });
}

/**
 * The package entry (index.ts): starts the local approval server for one agent, with the OS keychain's
 * `owner` item for owner presence and the platform's browser opener and notifier.
 */
export function startApprovalServer(options: ApprovalServerOptions): Promise<ApprovalServer> {
  return startApprovalServerWith(options);
}
