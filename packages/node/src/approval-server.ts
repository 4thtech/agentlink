// M1-8d: the local approval server (08 §1; 04 §2.5; 06 §2.5; I-4, I-7).
//
// What it is: an HTTP server inside the MCP/CLI process, at `http://localhost:<random port>`, that shows
// the agent's pending approval requests and lets the owner approve or deny one with owner presence.
// The M1b `ApprovalChannel` that returns its `/approve/<id>` link, the full local UI and the localhost
// passkey are later cards (M1-11a, M1-11c, M1-8e); this module is the server and its security rules.
//
// Rules (each has a test in approval-server.test.ts):
// - Served as `http://localhost:<port>` (M1-31, D-79: WebAuthn takes `localhost` as an RP ID, never an
//   IP address). Listens on 127.0.0.1 and ::1 (IPv6-only) with the same port, and on no other address
//   (never 0.0.0.0 or ::), so whichever address the browser resolves `localhost` to reaches this
//   server and no other program can answer there. If another program holds ::1 on the chosen port,
//   both listeners close and a new port is tried (at most 5 times). A machine with no IPv6 gets
//   127.0.0.1 only and a fixed `ipv6_unavailable` event. Requests from a non-loopback peer are refused.
// - A random 256-bit session token, in memory only, is put in the URL the process opens (`/?t=…`);
//   the first request exchanges it for an HttpOnly, SameSite=Lax session cookie scoped to this port's
//   name and redirects to the same path without the token. No token, cookie or CSRF value is written
//   to disk, logged, put in an event, an approval URL or an error body.
// - DNS rebinding: the `Host` header must be exactly `localhost:<port>` (so `127.0.0.1:<port>`,
//   `[::1]:<port>`, `LOCALHOST:<port>` and `localhost.:<port>` are refused); any `Origin` header present
//   must be exactly `http://localhost:<port>`; a POST must carry that Origin.
// - Cross-site requests: no CORS grant ever; API calls need a per-server CSRF token (in the page,
//   never in the URL) in `X-AgentLink-CSRF` and fetch metadata that is absent or `same-origin`; a
//   decision is a POST with `Content-Type: application/octet-stream` (not a simple request).
// - The token grants viewing only (08 §1). A decision needs owner presence: the owner code or owner
//   passphrase, sent as the raw request body, unlocks the owner key for exactly one owner operation
//   (04 §2.5, D-68: one `approval.decide`), and the buffer is wiped. The signed object goes to the
//   source (core's `ownerActions.apply`), which verifies it (I-4). No route decides without it.
// - M1-8e, the localhost passkey (owner-passkey.ts): with `X-AgentLink-Presence: passkey` the body is
//   the passkey assertion (credential ID, authenticator data, user handle, PRF output). The server
//   checks it against the stored `owner-passkey` item and the owner (credential ID, user handle,
//   rpIdHash = SHA-256("localhost"), UP and UV) before the PRF output unlocks the owner key for one
//   owner operation. `/api/owner/passkey` shows the public registration data (GET) and registers the
//   one passkey (POST: the owner code plus the assertion), its own owner operation that signs
//   nothing. The PRF output never leaves this process and is wiped after use.
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
import type { AddressInfo, ListenOptions } from 'node:net';
import type { OwnerActionOutcome } from '@4thtech-io/core';
import {
  KeyStoreError,
  canonicalizeToBytes,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  equalBytes,
  randomBytes,
  sha256,
  ownerPrfSalt,
  wipe,
  type JsonObject,
  type JsonValue,
  type OwnerPresence,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import { osBrowserOpener, osNotifier, type BrowserOpener, type OsNotifier } from './approval-os.js';
import { APP_JS, EXPIRED_HTML, pageHtml } from './approval-page.js';
import { NodeKeyStoreError } from './errors.js';
import { osKeychain, type KeychainBackend } from './keychain.js';
import { decideReviewedWith, type ApprovalContext } from './owner-approval.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import {
  PASSKEY_RP_ID,
  assertPasskeyAssertion,
  parsePasskeyAssertion,
  parsePasskeyRegistration,
  readOwnerPasskeyHeader,
  registerOwnerPasskey,
  type PasskeyAssertion,
} from './owner-passkey.js';
import type { PromptingOwnerKeyStore } from './owner-operation.js';
import type { OwnerTerminal } from './owner-terminal.js';

/** 08 §1 (M1-31, D-79): the local UI's host name; its origin is `http://localhost:<port>`. */
export const APPROVAL_SERVER_HOST = 'localhost';
/** The loopback addresses held on the one port: IPv4 first (it picks the port), then IPv6. */
const LISTEN_V4 = '127.0.0.1';
const LISTEN_V6 = '::1';
/** Ports tried when another program holds ::1 on the port 127.0.0.1 was given. */
const MAX_PORT_ATTEMPTS = 5;
/** ::1 listen errors that mean the machine has no IPv6 loopback (then 127.0.0.1 only). */
const NO_IPV6 = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);
/** Longest accepted owner secret in bytes (the same bound as the TTY prompt). */
const MAX_SECRET_BYTES = 1024;
/** Longest accepted passkey body (assertion, or owner code plus assertion), M1-8e. */
const MAX_PASSKEY_BYTES = 4096;
const PASSKEY_PATH = '/api/owner/passkey';
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
  /** The machine has no IPv6 loopback: the server listens on 127.0.0.1 only (M1-31). */
  | { readonly kind: 'ipv6_unavailable' }
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
  /** M1-8e: the outcome of a passkey registration. */
  | {
      readonly kind: 'passkey';
      readonly outcome:
        | 'registered'
        | 'presence_required'
        | 'presence_rejected'
        | 'passkey_exists'
        | 'passkey_unsupported'
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

/** One listen call: a loopback host, a port (0 = the OS picks), IPv6-only for ::1. */
export interface ApprovalListenOptions {
  readonly host: string;
  readonly port: number;
  readonly ipv6Only?: boolean;
}

/** Internal (tests): owner store, browser opener, notifier and listen seams. Not exported from index. */
export interface ApprovalServerInternals {
  /** Listens `server` as asked; rejects with the socket error (its `code`). Default: server.listen. */
  readonly listen?: (server: Server, options: ApprovalListenOptions) => Promise<void>;
  readonly openOwnerStore?: (owner: OwnerPublicKeys) => Promise<PromptingOwnerKeyStore>;
  /** The keychain holding the `owner` and `owner-passkey` items (M1-8e). Default: the OS keychain. */
  readonly keychain?: KeychainBackend;
  readonly opener?: BrowserOpener;
  readonly notifier?: OsNotifier;
}

export interface ApprovalServer {
  /** `http://localhost:<port>`. */
  readonly origin: string;
  readonly port: number;
  /** The host name, the port and the loopback addresses held (`127.0.0.1`, and `::1` when present). */
  address(): {
    readonly host: string;
    readonly port: number;
    readonly addresses: readonly string[];
  };
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
type PasskeyOutcome = Extract<ApprovalServerEvent, { kind: 'passkey' }>['outcome'];
type RejectReason = Extract<ApprovalServerEvent, { kind: 'rejected' }>['reason'];

/** The default listen: one `server.listen`, rejecting with the socket error. */
function listenOnce(server: Server, options: ApprovalListenOptions): Promise<void> {
  return new Promise<void>((resolve, rejectListen) => {
    const listenOptions: ListenOptions = {
      host: options.host,
      port: options.port,
      exclusive: true,
      ...(options.ipv6Only === undefined ? {} : { ipv6Only: options.ipv6Only }),
    };
    server.once('error', rejectListen);
    server.listen(listenOptions, () => {
      server.off('error', rejectListen);
      resolve();
    });
  });
}

const closeServer = (server: Server): Promise<void> =>
  new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });

const errorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

const invalidId = (): NodeKeyStoreError =>
  new NodeKeyStoreError('owner_operation_invalid', 'That is not a valid approval ID.');

/**
 * A terminal for one page decision: shows nothing, the click was the confirmation, one presence
 * proof (the owner code, or the passkey's PRF output, M1-8e), handed over once.
 */
function pageTerminal(presence: OwnerPresence): OwnerTerminal {
  let given = false;
  return {
    write: () => undefined,
    // The owner clicked Approve or Deny on the card for exactly this request and digest.
    confirm: () => Promise.resolve(true),
    readSecret: () => Promise.reject(new KeyStoreError('presence_rejected', 'presence')),
    readPresence: () => {
      if (given) return Promise.reject(new KeyStoreError('presence_rejected', 'presence'));
      given = true;
      return Promise.resolve(presence);
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
  let keychainInstance: KeychainBackend | undefined = internals.keychain;
  const keychainOf = (): KeychainBackend => (keychainInstance ??= osKeychain());
  const openOwnerStore =
    internals.openOwnerStore ??
    ((owner: OwnerPublicKeys) => KeychainOwnerKeyStore.open(keychainOf(), owner));
  const opener = internals.opener ?? osBrowserOpener;
  const notifier = internals.notifier ?? osNotifier;
  const listen = internals.listen ?? listenOnce;
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

  // One request handler and one session behind both loopback listeners. Until both are bound, a
  // request (only possible on 127.0.0.1, in that short window) gets 503 and nothing else.
  let dispatch = (_req: IncomingMessage, res: ServerResponse): void => {
    res.statusCode = 503;
    res.end();
  };
  const newServer = (): Server => {
    const created = createServer({
      requestTimeout: 30_000,
      headersTimeout: 10_000,
      maxHeaderSize: 16_384,
    });
    created.on('request', (req: IncomingMessage, res: ServerResponse) => dispatch(req, res));
    return created;
  };

  // 127.0.0.1 picks the port; ::1 must take the same one, or both close and a new port is tried.
  const listeners: Server[] = [];
  let ipv6Available = true;
  let port = 0;
  for (let attempt = 1; listeners.length === 0; attempt += 1) {
    const v4 = newServer();
    await listen(v4, { host: LISTEN_V4, port: 0 });
    const chosen = (v4.address() as AddressInfo).port;
    const v6 = newServer();
    // The socket error is reduced to its code; nothing of it reaches an error or event (I-7).
    const code = await listen(v6, { host: LISTEN_V6, port: chosen, ipv6Only: true }).then(
      () => undefined,
      (error: unknown) => errorCode(error) ?? 'unknown',
    );
    if (code === undefined) {
      listeners.push(v4, v6);
      port = chosen;
    } else if (typeof code === 'string' && NO_IPV6.has(code)) {
      ipv6Available = false;
      listeners.push(v4);
      port = chosen;
    } else {
      await closeServer(v6);
      await closeServer(v4);
      if (code !== 'EADDRINUSE' || attempt >= MAX_PORT_ATTEMPTS) {
        throw new Error('The local approval page could not start on a free local port.');
      }
    }
  }
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

  /** Reads a secret body into one bounded buffer; chunks are wiped after copying. */
  const readSecret = (
    req: IncomingMessage,
    limit: number = MAX_SECRET_BYTES,
  ): Promise<Uint8Array | 'too_large'> =>
    new Promise((resolve, rejectRead) => {
      const buffer = new Uint8Array(limit);
      let length = 0;
      let over = false;
      req.on('data', (chunk: Buffer) => {
        if (!over && length + chunk.length <= limit) {
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

  const finishPasskey = (res: ServerResponse, status: number, outcome: PasskeyOutcome): void => {
    emit({ kind: 'passkey', outcome });
    sendJson(res, status, { status: outcome });
  };

  /** Reads a bounded body after the declared length check; 'too_large' was answered already. */
  async function boundedBody(
    req: IncomingMessage,
    res: ServerResponse,
    limit: number,
  ): Promise<Uint8Array | undefined> {
    const declared = Number(header(req, 'content-length') ?? '0');
    if (Number.isFinite(declared) && declared > limit) {
      res.setHeader('Connection', 'close');
      reject(res, 413, 'too_large');
      req.resume();
      return undefined;
    }
    const body = await readSecret(req, limit);
    if (body === 'too_large') {
      reject(res, 413, 'too_large');
      return undefined;
    }
    return body;
  }

  async function decide(
    req: IncomingMessage,
    res: ServerResponse,
    approvalId: string,
    decision: 'approve' | 'deny',
  ): Promise<void> {
    const mode = header(req, 'x-agentlink-presence');
    const passkey = mode === 'passkey';
    if (mode !== undefined && !passkey) {
      finishDecision(res, 403, 'presence_required');
      req.resume();
      return;
    }
    const body = await boundedBody(req, res, passkey ? MAX_PASSKEY_BYTES : MAX_SECRET_BYTES);
    if (body === undefined) return;
    // Every secret byte this request carried; wiped whatever happens (unlock also wipes its copy).
    let assertion: PasskeyAssertion | undefined;
    let presence: OwnerPresence | undefined;
    try {
      if (body.length === 0) {
        finishDecision(res, 403, 'presence_required');
        return;
      }
      if (passkey) {
        try {
          assertion = parsePasskeyAssertion(body);
        } catch {
          finishDecision(res, 403, 'presence_required');
          return;
        }
        if (assertion.prfOutput.length === 0) {
          // A PRF-less authenticator: the owner code is the way (the page offers it).
          finishDecision(res, 403, 'presence_required');
          return;
        }
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
        if (assertion !== undefined) {
          // 04 §2.3.1: the assertion names the stored credential, the owner as user handle, RP ID
          // localhost and UP and UV, before its PRF output is used at all.
          try {
            const stored = await readOwnerPasskeyHeader(keychainOf());
            if (stored === null) throw new KeyStoreError('presence_rejected', 'presence');
            assertPasskeyAssertion(stored, context.owner, assertion);
          } catch {
            finishDecision(res, 403, 'presence_rejected');
            return;
          }
          presence = { kind: 'passkey-prf', prfOutput: assertion.prfOutput };
        } else {
          presence = { kind: 'passphrase', secret: body };
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
          // unlock wipes the presented bytes, whether or not they unlock.
          signed = await decideReviewedWith(store, pageTerminal(presence), context, [
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
      wipe(body, assertion?.prfOutput);
    }
  }

  /** GET /api/owner/passkey: the public data the page needs for the WebAuthn ceremony. */
  async function passkeyInfo(res: ServerResponse): Promise<void> {
    const context = await source.context();
    if (context === undefined) {
      sendJson(res, 503, { status: 'needs_setup' });
      return;
    }
    const stored = await readOwnerPasskeyHeader(keychainOf());
    const usable = stored !== null && equalBytes(stored.ownerNostr, context.owner.ownerNostr);
    sendJson(res, 200, {
      passkey: {
        registered: usable,
        rpId: PASSKEY_RP_ID,
        userId: encodeBase64url(context.owner.ownerNostr),
        prfSalt: encodeBase64url(ownerPrfSalt()),
        ...(usable ? { credentialId: encodeBase64url(stored.credentialId) } : {}),
      },
    });
  }

  /**
   * POST /api/owner/passkey: registers the one localhost passkey (M1-8e). Its own owner operation:
   * one entry of the owner code, no signature; the code, the PRF output and the seed are wiped.
   */
  async function passkeyRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await boundedBody(req, res, MAX_PASSKEY_BYTES);
    if (body === undefined) return;
    let parsed: ReturnType<typeof parsePasskeyRegistration> | undefined;
    try {
      try {
        parsed = parsePasskeyRegistration(body);
      } catch {
        finishPasskey(res, 403, 'presence_required');
        return;
      }
      if (busy) {
        finishPasskey(res, 409, 'busy');
        return;
      }
      busy = true;
      try {
        const context = await source.context();
        if (context === undefined) {
          finishPasskey(res, 503, 'needs_setup');
          return;
        }
        const { ownerSecret, assertion } = parsed;
        parsed = undefined; // registerOwnerPasskey wipes the code and the PRF output
        try {
          await registerOwnerPasskey(keychainOf(), context.owner, ownerSecret, assertion);
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code === 'owner_passkey_exists') finishPasskey(res, 409, 'passkey_exists');
          else if (code === 'passkey_unsupported') finishPasskey(res, 422, 'passkey_unsupported');
          else if (code === 'presence_rejected') finishPasskey(res, 403, 'presence_rejected');
          else if (code === 'presence_required') finishPasskey(res, 403, 'presence_required');
          else if (code === 'owner_missing') finishPasskey(res, 503, 'needs_setup');
          else finishPasskey(res, 500, 'failed');
          return;
        }
        finishPasskey(res, 200, 'registered');
      } finally {
        busy = false;
      }
    } finally {
      wipe(body, parsed?.ownerSecret, parsed?.assertion.prfOutput);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCommonHeaders(res);
    const peer = req.socket.remoteAddress;
    if (peer !== '127.0.0.1' && peer !== '::ffff:127.0.0.1' && peer !== '::1') {
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
    const passkeyRoute = path === PASSKEY_PATH;
    if (path !== '/api/approvals' && one === null && decideMatch === null && !passkeyRoute) {
      reject(res, 404, 'not_found');
      return;
    }
    const post = decideMatch !== null || (passkeyRoute && method === 'POST');
    if (method !== (post ? 'POST' : 'GET')) return reject(res, 405, 'method');
    if (!matches(cookieToken(req), tokenBytes)) return reject(res, 401, 'token');
    if (!fetchSiteOk(req)) return reject(res, 403, 'fetch_site');
    if (post && originHeader === undefined) return reject(res, 403, 'origin');
    if (!matches(header(req, 'x-agentlink-csrf'), csrfBytes)) return reject(res, 403, 'csrf');

    if (post) {
      const type = (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
      if (type !== 'application/octet-stream') return reject(res, 415, 'content_type');
      if (decideMatch === null) {
        await passkeyRegister(req, res);
        return;
      }
      await decide(req, res, decideMatch[1] as string, decideMatch[2] as 'approve' | 'deny');
      return;
    }
    if (passkeyRoute) {
      await passkeyInfo(res);
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

  dispatch = (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { status: 'failed' });
      else res.destroy();
    });
  };
  if (!ipv6Available) emit({ kind: 'ipv6_unavailable' });
  emit({ kind: 'listening' });
  const addresses = Object.freeze(ipv6Available ? [LISTEN_V4, LISTEN_V6] : [LISTEN_V4]);

  const approvalUrl = (approvalId: string): string => {
    if (typeof approvalId !== 'string' || !APPROVAL_ID.test(approvalId)) throw invalidId();
    return `${origin}/approve/${approvalId}`;
  };

  return Object.freeze<ApprovalServer>({
    origin,
    port,
    address: () => ({ host: APPROVAL_SERVER_HOST, port, addresses }),
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
    close: async () => {
      await Promise.all(listeners.map(closeServer));
      emit({ kind: 'closed' });
    },
  });
}

/**
 * The package entry (index.ts): starts the local approval server for one agent, with the OS keychain's
 * `owner` item for owner presence and the platform's browser opener and notifier.
 */
export function startApprovalServer(options: ApprovalServerOptions): Promise<ApprovalServer> {
  return startApprovalServerWith(options);
}
