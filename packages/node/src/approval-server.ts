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
// - M1-11a, the session link is one-shot (IR-M1-8d-1 L-3): each `open()` mints a new random 256-bit
//   link token, in memory only, put in the URL it opens (`/?t=…`). The first request with it
//   exchanges it for a new random session secret in an HttpOnly, SameSite=Strict cookie scoped to this
//   port's name and redirects to the same path without the token; the link token is then gone, so a
//   link left in browser history never opens the page again. An unused link dies after
//   SESSION_LINK_LIFETIME_MS. At most MAX_LINKS links and MAX_SESSIONS sessions are held (the oldest
//   is dropped). No token, cookie or CSRF value is written to disk, logged, put in an event, an
//   approval URL or an error body.
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
// - M1-11a, review together (D-68, 04 §2.5.2): `POST /api/approvals/review` carries 1 to 20 items the
//   page listed (`X-AgentLink-Items`: `<approvalId>:<actionDigest shown>:<a|d>`, comma separated)
//   and the same presence body as a single decision. The server re-reads every item and refuses the
//   whole request, before the owner store is opened, when one is malformed, a duplicate, no longer
//   pending, changed, or a commitment (D-31: terms are always decided alone, on their own card). One
//   presence entry then signs one `approval.decideBatch` over exactly those items (one
//   `approval.decide` for one item) and core applies it whole or not at all.
// - M1-11a, wrong-code backoff (IR-M1-8d-1 L-2): after FREE_PRESENCE_ATTEMPTS rejected presence
//   proofs in a row (owner code, owner passphrase or passkey), every owner operation of this server
//   answers 429 `wait` with Retry-After before its body is read or the owner store is opened; the
//   wait doubles with each further failure up to MAX_PRESENCE_BACKOFF_S, and a success resets it.
//   It lives in memory: a same-user process that restarts the server is the accepted G-1 residual,
//   and the KDF cost still bounds each guess. It is this server's counter only: `agentlink approve`
//   in the owner's own terminal is a separate process and is never held back by it (IR-M1-11a-1
//   L-3), so a process that keeps the page waiting cannot lock the owner out.
//
// - M1-11a-ux: `/app.css` is the approval page's fixed stylesheet (approval-page.ts), served
//   like `/app.js` under the same headers and CSP. The card view drops the AI argument `inviteUrl`
//   (the invite's capability link) and carries an optional plain `headline`, checked like every
//   other card field.
// - M1-11s-b, the local UI shell (D-118): the React app (apps/local-ui) is served from an in-memory
//   bundle the caller passes in (`localUi.assets`; the CLI embeds it), never from a file path.
//   Only `index.html` and `assets/<one file name>` with a known type are accepted, checked before the
//   server listens. `/assets/<name>` is an exact map lookup (no decoding, no path join), served with
//   its fixed content type, nosniff, the strict CSP (plus `font-src 'self'`) and immutable caching;
//   anything else is 404. The app's index.html, with this server's CSRF token filled in, is served
//   only for `/first-run` and `/settings[/...]`; `/` and `/approve/<id>` keep the approval page.
//   The session cookie gates the app pages, the assets and every /api/ui/ route.
// - M1-11s-b, the /api/ui/ routes (local-ui/routes.ts): each declares `presence`; a mutating route
//   must declare `presence: true`. Every route needs the session cookie, the CSRF header and
//   same-origin fetch metadata; a mutating one also the page's Origin and an octet-stream body. The
//   central presence gate then runs before the handler: the wrong-code backoff, the presence proof
//   (the owner code, or the passkey assertion checked as for a decision), one owner operation at a
//   time, the owner being set up, and the owner store unlocked with the proof. A wrong code is 403
//   `presence_rejected`, counts towards the backoff, and the handler never runs (IR-M1-11s-b-1 H-1).
//   The handler gets a read-only client view and a one-use `sign` bound to that session (the
//   allowlist and one gesture, D-68); the session closes and the store locks when it returns, and a
//   presence route that signed nothing is answered 409 `refused`.
// - M1-11s-c, owner setup on the first-run page (D-120 (1); proposed, owner confirms at merge): the
//   two `presence: 'setup'` routes (begin, finish) are run by `setupGate`, never by `ownerGate`
//   (which is unchanged). After the same session, CSRF, Origin, fetch-metadata and octet-stream
//   checks, the gate answers 429 while the wrong-code backoff is in force, and 409 `owner_exists`
//   unless no owner exists anywhere (no card names one; no `owner`, `owner-passkey` or `owner-next`
//   item). `begin` (empty body) creates the owner seed and holds it in memory for SETUP_HOLD_MS,
//   bound to that session; one setup at a time (a second begin is 409 `busy`). It returns only public
//   WebAuthn creation values: user.id = the owner's x-only Nostr key, a random challenge, the PRF
//   salt, RP ID `localhost`. `finish` takes the hold (single-use, the bound session only), checks the
//   creation response and completes the setup all or nothing (owner-setup.ts): the owner code, the
//   passkey and the agent's first card. The owner code goes to the page once and is never in an
//   event. The held seed is wiped on finish (whatever the outcome), on expiry, when its session is
//   dropped and when the server closes.
// - M1-UX-FIRSTRUN-V2 (D-130 (1), (2); 08 §1 first run v2; proposed, owner confirms at merge): when
//   the setup's `firstCard.firstPolicy` is wired, `begin` first prepares the folders (Send, Inbox,
//   Proofs; owner-setup.ts prepareSetupFolders) and answers 409 `folder_refused` (reason
//   `folder_not_empty` or `folder_unavailable`) before any seed exists when Send is a link at either
//   level, not a folder or not empty. `finish` signs the card and the first policy with the same
//   gesture and answers the fixed `sendFolder` outcome (`allowed`, `not_confirmed`, `not_allowed`;
//   never the path) and the computer's name for the backup-code save form. The folders this run
//   created are removed whenever the policy is not in force (failure, expiry, drop, close).
// - M1-11b-6: `openFirstRun()` opens the first-run page with a one-shot session link, as `open()`
//   does for `/`; the CLI's `init` calls it for a new owner (the CLI's first-run step). G-1: a
//   same-user process holding a session link can race the human to set up an owner it controls
//   (owner-setup.ts threat note).
// - M1-11b-9: `openActivity()` is the same for `/settings/activity`, for `agentlink ui`; a session
//   link grants viewing and the owner-presence-gated actions only, as for `open()`.
//
// Out of scope and accepted (G-1, D-67; 04 §2.5): a same-user process that reads memory, modifies the
// installed package, or serves a look-alike page on another localhost port. Cookies are not isolated
// by port, so another local server the owner's browser visits could receive the session cookie; it
// grants viewing only. The opener's argv briefly holds the session link (approval-os.ts).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname as osHostname } from 'node:os';
import type { AddressInfo, ListenOptions } from 'node:net';
import type { OwnerActionOutcome } from '@4thtech-io/core';
import {
  KeyStoreError,
  canonicalizeToBytes,
  decodeBase64url,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  equalBytes,
  randomBytes,
  sha256,
  OWNER_SESSION_DEFAULT_TTL_MS,
  ownerPrfSalt,
  parseJson,
  wipe,
  type Argon2idParams,
  type JsonObject,
  type JsonValue,
  type OwnerPresence,
  type OwnerPublicKeys,
  type OwnerSession,
} from '@4thtech-io/crypto';
import { osBrowserOpener, osNotifier, type BrowserOpener, type OsNotifier } from './approval-os.js';
import { APP_CSS, APP_JS, EXPIRED_HTML, pageHtml } from './approval-page.js';
import { NodeKeyStoreError } from './errors.js';
import { osKeychain, type KeychainBackend } from './keychain.js';
import { decideReviewedWith, type ApprovalContext } from './owner-approval.js';
import { grouped } from './owner-init.js';
import { KeychainOwnerKeyStore, newOwnerSeed, ownerFingerprintText } from './owner-keystore.js';
import {
  MAX_SETUP_REGISTRATION_BYTES,
  SETUP_HOLD_MS,
  checkSetupRegistration,
  completeOwnerSetup,
  computerNameOf,
  noOwnerAnywhere,
  parseSetupRegistration,
  prepareSetupFolders,
  removeSetupFolders,
  type SetupFolders,
  type SetupRegistration,
} from './owner-setup.js';
import { keepsFolder } from './owner-first-policy.js';
import {
  PASSKEY_RP_ID,
  assertPasskeyAssertion,
  parsePasskeyAssertion,
  parsePasskeyRegistration,
  readOwnerPasskeyHeader,
  registerOwnerPasskey,
  type PasskeyAssertion,
} from './owner-passkey.js';
import {
  creditsPort,
  readOnlyClient,
  type LocalUiAssets,
  type LocalUiContext,
  type LocalUiOptions,
  type LocalUiOwnerSetup as LocalUiOwnerSetupOption,
} from './local-ui/context.js';
import type {
  LocalUiOwnerOperation,
  LocalUiResult,
  LocalUiSetupStep,
} from './local-ui/route-types.js';
import {
  LOCAL_UI_API_PREFIX,
  LocalUiRouteRegistry,
  createLocalUiRoutes,
} from './local-ui/routes.js';
import { createHealthReader } from './local-ui/api/health.js';
import { checkGesture, signGesture, type PromptingOwnerKeyStore } from './owner-operation.js';
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
const REVIEW_PATH = '/api/approvals/review';

/** M1-11a: an unused session link dies after 10 minutes (one-shot either way). */
export const SESSION_LINK_LIFETIME_MS = 10 * 60 * 1000;
/** Outstanding session links and live sessions held at most; the oldest is dropped. */
const MAX_LINKS = 8;
const MAX_SESSIONS = 8;
/** M1-11a: rejected presence proofs in a row before the server makes the owner wait. */
export const FREE_PRESENCE_ATTEMPTS = 3;
/** The first wait, doubled for each further rejected proof, up to MAX_PRESENCE_BACKOFF_S. */
const FIRST_BACKOFF_S = 5;
export const MAX_PRESENCE_BACKOFF_S = 300;
/** 04 §2.5.2 (D-71 (3)): at most 20 items in one review. */
const MAX_REVIEW_ITEMS = 20;
/** Bounds on the card data a view may carry to the page (fail closed above them). */
const MAX_DETAIL_CHARS = 1024;
const MAX_VALUE_CHARS = 16_384;
const MAX_FIELDS = 64;
/** AI arguments the page never shows (M1-11a-ux): the invite link of an accept-invite. */
const HIDDEN_ARGS: ReadonlySet<string> = new Set(['inviteUrl']);

/** The wait in seconds after `failures` rejected presence proofs in a row (0 = no wait). */
export function presenceBackoffSeconds(failures: number): number {
  if (!Number.isSafeInteger(failures) || failures < FREE_PRESENCE_ATTEMPTS) return 0;
  const steps = failures - FREE_PRESENCE_ATTEMPTS;
  if (steps >= 16) return MAX_PRESENCE_BACKOFF_S;
  return Math.min(MAX_PRESENCE_BACKOFF_S, FIRST_BACKOFF_S * 2 ** steps);
}

const APPROVAL_ID = /^apr_[A-Za-z0-9_-]{22}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const APPROVE_PAGE = /^\/approve\/(apr_[A-Za-z0-9_-]{22})$/;
const API_ONE = /^\/api\/approvals\/(apr_[A-Za-z0-9_-]{22})$/;
const API_DECIDE = /^\/api\/approvals\/(apr_[A-Za-z0-9_-]{22})\/(approve|deny)$/;
const REVIEW_ITEM = /^(apr_[A-Za-z0-9_-]{22}):([0-9a-f]{64}):([ad])$/;

/** M1-11s-b: the local UI app's pages (D-118); everything else keeps its own route or is 404. */
const APP_PAGE = /^\/(?:first-run|settings(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){0,4})$/;
const ASSETS_PREFIX = '/assets/';
/** One file name: no separator, no leading dot, no escape. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The file types the app may ship, by extension, with the content type they are served as. */
const ASSET_TYPES: ReadonlyMap<string, string> = new Map([
  ['js', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['woff2', 'font/woff2'],
  ['woff', 'font/woff'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
  ['ico', 'image/x-icon'],
]);
const ASSET_CACHE = 'private, max-age=31536000, immutable';
/** The CSRF meta the app's index.html carries empty, filled per server (apps/local-ui). */
const CSRF_META = /<meta\s+name="agentlink-csrf"\s+content="([^"]*)"\s*\/?>/gi;
const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;
/** Longest `X-AgentLink-Input` (base64url JSON) a /api/ui/ owner route accepts. */
const MAX_INPUT_CHARS = 8192;
/** M1-11s-c: the setup routes report an expired hold themselves (no sweep before them). */
const SETUP_PATH_PREFIX = '/api/ui/first-run/';

interface ServedAsset {
  readonly body: Uint8Array;
  readonly type: string;
}

/** The app's index.html around the CSRF token: `${before}<meta …token…>${after}`. */
interface AppShell {
  readonly before: string;
  readonly after: string;
}

const badBundle = (why: string): Error => new Error(`The local UI bundle is not valid: ${why}.`);

/** Checks the caller's bundle (fail closed) into the served assets and the app shell. */
function loadLocalUi(assets: LocalUiAssets | undefined): {
  readonly table: ReadonlyMap<string, ServedAsset>;
  readonly shell: AppShell | undefined;
} {
  const table = new Map<string, ServedAsset>();
  let shell: AppShell | undefined;
  const files = assets?.files;
  if (files === undefined) return { table, shell };
  if (!(files instanceof Map)) throw badBundle('files must be a Map');
  for (const [key, body] of files as ReadonlyMap<unknown, unknown>) {
    if (typeof key !== 'string' || !(body instanceof Uint8Array)) throw badBundle('a bad entry');
    if (key === 'index.html') {
      let html: string;
      try {
        html = decodeUtf8(body);
      } catch {
        throw badBundle('index.html is not UTF-8');
      }
      const metas = [...html.matchAll(CSRF_META)];
      if (metas.length > 1) throw badBundle('index.html has more than one CSRF meta');
      // IR-M1-11s-b-1 L-2: any other mention (other attribute order or quotes) is refused, never
      // left beside an injected one.
      if (html.toLowerCase().split('agentlink-csrf').length - 1 !== metas.length) {
        throw badBundle('index.html has a CSRF meta in another form');
      }
      const meta = metas[0];
      if (meta !== undefined) {
        if (meta[1] !== '') throw badBundle('index.html already holds a CSRF token');
        shell = {
          before: html.slice(0, meta.index),
          after: html.slice(meta.index + meta[0].length),
        };
      } else {
        const head = HEAD_OPEN.exec(html);
        if (head === null) throw badBundle('index.html has no <head>');
        const at = head.index + head[0].length;
        shell = { before: html.slice(0, at), after: html.slice(at) };
      }
      continue;
    }
    const name = key.startsWith('assets/') ? key.slice('assets/'.length) : undefined;
    if (name === undefined || !ASSET_NAME.test(name)) throw badBundle('a file name is not allowed');
    const type = ASSET_TYPES.get(name.slice(name.lastIndexOf('.') + 1));
    if (!name.includes('.') || type === undefined) throw badBundle('a file type is not allowed');
    table.set(name, { body: body.slice(), type });
  }
  return { table, shell };
}

/**
 * What the approval card shows (11 §6.2.1, §8), built by the agent's runtime from the parsed stored
 * action (never from the row's stored summary or text the agent passed in, IR-M1-8c-1 F-4). Every
 * value is plain text: the page renders it with textContent only (I-5). `fromAi` are the arguments
 * the AI chose, shown in their own marked region; they may hold anything, including markup.
 */
export interface ApprovalDetails {
  /**
   * M1-11a-ux: the card's plain headline ("Connect with “Ana” (self-declared)"), fixed
   * text plus at most the contact name under the 06 §2.1 rule; without it the page shows `what`.
   */
  readonly headline?: string;
  /** The contact, under the 06 §2.1 name rule. */
  readonly who: string;
  readonly what: string;
  /** "$0.10", or "Free". */
  readonly cost: string;
  /** "12 Oct 2026 14:02 UTC". */
  readonly expires: string;
  /** The policy rule that asked for this approval, in plain words. */
  readonly rule: string;
  readonly fromAi: readonly { readonly name: string; readonly value: string }[];
  /** For terms: the terms card's lines (headline, the contact's terms, what changed). */
  readonly terms?: readonly string[];
}

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
  /** M1-11a: the card's facts; without them the page shows the summary only. */
  readonly details?: ApprovalDetails;
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
        /** M1-11a: the review list was malformed, a duplicate, empty or too long. */
        | 'invalid'
        /** M1-11a: a commitment was in a review list (decided alone, D-31). */
        | 'commitment'
        /** M1-11a: wrong-code backoff in force. */
        | 'wait'
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
        | 'wait'
        | 'failed';
    }
  /** M1-11s-b: the outcome of a /api/ui/ owner operation at the presence gate. */
  | {
      readonly kind: 'owner_operation';
      readonly outcome:
        | 'done'
        | 'wait'
        | 'invalid'
        | 'presence_required'
        | 'presence_rejected'
        | 'busy'
        | 'needs_setup'
        | 'refused'
        | 'failed';
    }
  /** M1-11s-c: the outcome of an owner setup step (never the owner code, a key or a value). */
  | {
      readonly kind: 'owner_setup';
      readonly outcome:
        | 'ready'
        | 'done'
        | 'invalid'
        | 'wait'
        | 'unavailable'
        | 'busy'
        | 'owner_exists'
        | 'not_pending'
        | 'expired'
        | 'presence_required'
        | 'presence_rejected'
        /** IR-M1-11s-c-1 M-1: the owner was kept and its code handed out, the card unconfirmed. */
        | 'done_unconfirmed'
        /** M1-UX-FIRSTRUN-V2: the Send folder can't be used; nothing began (reason says why). */
        | 'folder_refused'
        | 'failed';
      /** IR-M1-11s-c-1 L-4: with `failed`, which kind of failure (a fixed code). */
      readonly reason?: OwnerSetupFailure;
      /**
       * IR-M1-11s-c-1 L-2: with `done` and `done_unconfirmed`, the new owner's fingerprint (public,
       * 11 §5.2), so the CLI can show it outside the browser for comparing with `agentlink doctor`.
       */
      readonly fingerprint?: string;
      /** M1-UX-FIRSTRUN-V2: with `done`, the first policy's fixed outcome (never the path). */
      readonly sendFolder?: SetupSendFolder;
    }
  | { readonly kind: 'closed' };

/** M1-UX-FIRSTRUN-V2: what happened to the first policy's Send folder (fixed codes). */
export type SetupSendFolder = 'allowed' | 'not_confirmed' | 'not_allowed';

/**
 * IR-M1-11s-c-1 L-4: why an owner setup step failed. `rolled_back`: nothing of this setup was kept,
 * start again. `keychain`: the keychain refused, setup items may remain (`agentlink doctor`).
 * `check_failed`: whether an owner exists could not be checked (nothing was written). `internal`:
 * anything else (nothing is known to be kept).
 */
export type OwnerSetupFailure =
  | 'rolled_back'
  | 'keychain'
  | 'check_failed'
  | 'internal'
  /** M1-UX-FIRSTRUN-V2, with `folder_refused`: Send already holds something. */
  | 'folder_not_empty'
  /** M1-UX-FIRSTRUN-V2, with `folder_refused`: Send is a link (either level) or not a folder. */
  | 'folder_unavailable';

export interface ApprovalServerOptions {
  readonly source: ApprovalServerSource;
  /** Receives fixed-value events (for the redacting logger). Exceptions in it are ignored. */
  readonly onEvent?: (event: ApprovalServerEvent) => void;
  /** M1-11s-b: the local UI app's files and the agent's core client (D-118). */
  readonly localUi?: LocalUiOptions;
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
  /** The clock in milliseconds (link lifetime, backoff). Default: Date.now. */
  readonly now?: () => number;
  /** M1-11s-b: the /api/ui/ routes. Default: createLocalUiRoutes() (the page files). */
  readonly routes?: LocalUiRouteRegistry;
  /** M1-11s-c: Argon2id parameters for the new owner code's wrap. Default: the keystore defaults. */
  readonly ownerKdf?: Argon2idParams;
  /** M1-11s-c: the owner seed source for setup. Default: newOwnerSeed (@4thtech-io/crypto). */
  readonly newOwnerSeed?: () => { readonly seed: Uint8Array; readonly keys: OwnerPublicKeys };
  /** M1-UX-FIRSTRUN-V2: the computer's host name. Default: node:os hostname. */
  readonly hostname?: () => string;
  /** M1-UX-FIRSTRUN-V2-b: removes a setup's folders (tests: timing). Default: removeSetupFolders. */
  readonly removeSetupFolders?: (folders: SetupFolders | undefined) => Promise<void>;
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
   * Opens the owner's browser at a new one-shot session link (`/?t=…`), or at `/approve/<id>?t=…`.
   * The link is handed only to the OS opener, never returned. Resolves false when no browser could
   * be started.
   */
  open(approvalId?: string): Promise<boolean>;
  /**
   * M1-11b-6: opens the owner's browser at a new one-shot session link to the first-run page
   * (`/first-run?t=…`), the same link rules as `open()`: handed only to the OS opener, never
   * returned, logged or put in an event. Resolves false when no browser could be started.
   */
  openFirstRun(): Promise<boolean>;
  /**
   * M1-11b-9: the same for the settings pages, at `/settings/activity` (`agentlink ui`). A fixed
   * path; nothing from a caller reaches the link.
   */
  openActivity(): Promise<boolean>;
  /** Raises the fixed OS notification for a new request and returns its approvalUrl. */
  notifyNewApproval(approvalId: string): Promise<string>;
  close(): Promise<void>;
}

type DecisionOutcome = Extract<ApprovalServerEvent, { kind: 'decision' }>['outcome'];
type PasskeyOutcome = Extract<ApprovalServerEvent, { kind: 'passkey' }>['outcome'];
type RejectReason = Extract<ApprovalServerEvent, { kind: 'rejected' }>['reason'];
type OwnerOperationOutcome = Extract<ApprovalServerEvent, { kind: 'owner_operation' }>['outcome'];
type OwnerSetupOutcome = Extract<ApprovalServerEvent, { kind: 'owner_setup' }>['outcome'];

/** M1-11s-c: the owner seed `begin` holds for `finish`, in memory only. */
interface PendingSetup {
  readonly seed: Uint8Array;
  readonly keys: OwnerPublicKeys;
  readonly challenge: Uint8Array;
  /** The session (cookie value) it is bound to. */
  readonly session: Uint8Array;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
  /** M1-UX-FIRSTRUN-V2: the folders begin prepared (removed unless the first policy applies). */
  readonly folders?: SetupFolders;
}

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
      "font-src 'self'; " +
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

const isText = (value: unknown, max: number, empty = false): value is string =>
  typeof value === 'string' && value.length <= max && (empty || value.length > 0);

/** The card facts, checked field by field; undefined when anything is off (fail closed). */
function detailsOf(value: unknown): ApprovalDetails | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) return false;
  const { headline, who, what, cost, expires, rule, fromAi, terms } = value as Record<
    string,
    unknown
  >;
  for (const field of [who, what, cost, expires, rule]) {
    if (!isText(field, MAX_DETAIL_CHARS)) return false;
  }
  if (headline !== undefined && !isText(headline, MAX_DETAIL_CHARS)) return false;
  if (!Array.isArray(fromAi) || fromAi.length > MAX_FIELDS) return false;
  const fields: { name: string; value: string }[] = [];
  for (const entry of fromAi as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return false;
    const { name, value: text } = entry as Record<string, unknown>;
    if (!isText(name, MAX_DETAIL_CHARS) || !isText(text, MAX_VALUE_CHARS, true)) return false;
    // M1-11a-ux: an invite link never reaches the page (defence in depth; the CLI's
    // source leaves it out already).
    if (HIDDEN_ARGS.has(name)) continue;
    fields.push({ name, value: text });
  }
  let lines: string[] | undefined;
  if (terms !== undefined) {
    if (!Array.isArray(terms) || terms.length > MAX_FIELDS * 4) return false;
    lines = [];
    for (const line of terms as unknown[]) {
      if (!isText(line, MAX_VALUE_CHARS, true)) return false;
      lines.push(line);
    }
  }
  return {
    ...(headline === undefined ? {} : { headline: headline as string }),
    who: who as string,
    what: what as string,
    cost: cost as string,
    expires: expires as string,
    rule: rule as string,
    fromAi: fields,
    ...(lines === undefined ? {} : { terms: lines }),
  };
}

/** The view sent to the page: only checked, structured fields; never the action. */
function view(item: unknown): PendingApprovalView | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const { approvalId, summary, actionDigest, expiresAt, commitment, details } = item as Record<
    string,
    unknown
  >;
  if (typeof approvalId !== 'string' || !APPROVAL_ID.test(approvalId)) return undefined;
  if (typeof summary !== 'string' || summary.length === 0) return undefined;
  if (typeof actionDigest !== 'string' || !DIGEST.test(actionDigest)) return undefined;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) return undefined;
  if (typeof commitment !== 'boolean') return undefined;
  const facts = detailsOf(details);
  if (facts === false) return undefined;
  return {
    approvalId,
    summary,
    actionDigest,
    expiresAt,
    commitment,
    ...(facts === undefined ? {} : { details: facts }),
  };
}

/** One item of a decision as the page sent it: the ID, the digest it showed and the decision. */
interface Pick {
  readonly approvalId: string;
  readonly shown: string | undefined;
  readonly decision: 'approve' | 'deny';
}

/** Parses `X-AgentLink-Items` strictly: 1 to 20 well-formed, distinct items, or undefined. */
function parseReviewItems(raw: string | undefined): Pick[] | undefined {
  if (raw === undefined || raw.length === 0 || raw.length > MAX_REVIEW_ITEMS * 100) {
    return undefined;
  }
  const parts = raw.split(',');
  if (parts.length > MAX_REVIEW_ITEMS) return undefined;
  const picks: Pick[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const match = REVIEW_ITEM.exec(part);
    if (match === null) return undefined;
    const approvalId = match[1] as string;
    if (seen.has(approvalId)) return undefined;
    seen.add(approvalId);
    picks.push({
      approvalId,
      shown: match[2] as string,
      decision: match[3] === 'a' ? 'approve' : 'deny',
    });
  }
  return picks;
}

/** Starts the server with the test seams (internal; the package entry is startApprovalServer). */
export async function startApprovalServerWith(
  options: ApprovalServerOptions,
  internals: ApprovalServerInternals = {},
): Promise<ApprovalServer> {
  const { source } = options;
  // M1-11s-b: the bundle is checked before anything listens (fail closed).
  const localUi = loadLocalUi(options.localUi?.assets);
  const routes = internals.routes ?? createLocalUiRoutes();
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

  const now = internals.now ?? Date.now;
  /** One-shot session links (M1-11a): token bytes and the time each dies, oldest first. */
  const links: { readonly bytes: Uint8Array; readonly expiresAt: number }[] = [];
  /** Live session secrets (the cookie values), oldest first. */
  const sessions: Uint8Array[] = [];
  const csrf = encodeBase64url(randomBytes(32));
  const csrfBytes = encodeUtf8(csrf);
  const decided = new Set<string>();
  let busy = false;
  /** Rejected presence proofs in a row, and when the wait they caused ends (ms). */
  let failures = 0;
  let waitUntil = 0;
  /** M1-11s-c: the one owner setup in progress, if any. */
  let pendingSetup: PendingSetup | undefined;
  const uiContext: LocalUiContext = Object.freeze<LocalUiContext>({
    // IR-M1-11s-b-1 H-1: handlers read through a read-only view, never the client itself.
    client:
      options.localUi?.client === undefined ? undefined : readOnlyClient(options.localUi.client),
    // M1-11c-a4c: for the presence routes only; core re-verifies the owner signature (I-4).
    ...(options.localUi?.client === undefined
      ? {}
      : { credits: creditsPort(options.localUi.client) }),
    ownerContext: () => source.context(),
    applyOwnerAction: (signed) => source.apply(signed),
    now: () => now(),
    // M1-11s-a-d: the status bar's health read (fixed fields, cached, bounded).
    health: createHealthReader({
      ...(options.localUi?.health === undefined ? {} : { source: options.localUi.health }),
      hasClient: options.localUi?.client !== undefined,
      ...(options.localUi?.version === undefined ? {} : { version: options.localUi.version }),
      now: () => now(),
    }),
  });

  // One request handler and one session behind both loopback listeners. Until both are bound, a
  // request (only possible on 127.0.0.1, in that short window) gets 503 and nothing else.
  let dispatch = (_req: IncomingMessage, res: ServerResponse): void => {
    setCommonHeaders(res);
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

  const wellFormed = (candidate: string | undefined): candidate is string =>
    candidate !== undefined &&
    candidate.length > 0 &&
    candidate.length <= 128 &&
    BASE64URL.test(candidate);

  const matches = (candidate: string | undefined, expected: Uint8Array): boolean =>
    wellFormed(candidate) && equalBytes(encodeUtf8(candidate), expected);

  /** Compares against every held value (no early exit on a match). */
  const matchIndex = (candidate: string | undefined, held: readonly Uint8Array[]): number => {
    if (!wellFormed(candidate)) return -1;
    const bytes = encodeUtf8(candidate);
    let found = -1;
    held.forEach((value, i) => {
      if (equalBytes(bytes, value)) found = i;
    });
    return found;
  };

  /** Mints a one-shot session link token (M1-11a). */
  const mintLink = (): string => {
    const token = encodeBase64url(randomBytes(32));
    links.push({ bytes: encodeUtf8(token), expiresAt: now() + SESSION_LINK_LIFETIME_MS });
    while (links.length > MAX_LINKS) links.shift();
    return token;
  };

  /** Consumes a link token: true once for a live link, which is then gone. */
  const consumeLink = (candidate: string): boolean => {
    const at = matchIndex(
      candidate,
      links.map((l) => l.bytes),
    );
    if (at < 0) return false;
    const [link] = links.splice(at, 1);
    return link !== undefined && now() < link.expiresAt;
  };

  /** A new session secret for the cookie. */
  const newSession = (): string => {
    const secret = encodeBase64url(randomBytes(32));
    sessions.push(encodeUtf8(secret));
    while (sessions.length > MAX_SESSIONS) sessions.shift();
    return secret;
  };

  /** Seconds the owner must still wait after rejected presence proofs (0 = none). */
  const waitSeconds = (): number => {
    const left = waitUntil - now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  };
  const presenceFailed = (): void => {
    failures += 1;
    const wait = presenceBackoffSeconds(failures);
    if (wait > 0) waitUntil = now() + wait * 1000;
  };
  const presenceSucceeded = (): void => {
    failures = 0;
    waitUntil = 0;
  };

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

  /** 429 `wait` while the wrong-code backoff is in force (before the body is read). */
  function waiting(
    req: IncomingMessage,
    res: ServerResponse,
    kind: 'decision' | 'passkey',
  ): boolean {
    const wait = waitSeconds();
    if (wait === 0) return false;
    req.resume();
    res.setHeader('Retry-After', String(wait));
    if (kind === 'decision') finishDecision(res, 429, 'wait', { retryAfter: wait });
    else {
      emit({ kind: 'passkey', outcome: 'wait' });
      sendJson(res, 429, { status: 'wait', retryAfter: wait });
    }
    return true;
  }

  /**
   * One owner operation over `picks`: one item from `/api/approvals/<id>/<decision>`, or the 1 to
   * 20 items of a review (`review`). Every item is re-read and checked before presence is used; the
   * whole request is refused if one fails. Then one presence entry signs one object over exactly
   * these items, and core applies it.
   */
  async function decide(
    req: IncomingMessage,
    res: ServerResponse,
    picks: readonly Pick[],
    review: boolean,
  ): Promise<void> {
    if (waiting(req, res, 'decision')) return;
    const mode = header(req, 'x-agentlink-presence');
    const passkey = mode === 'passkey';
    if (mode !== undefined && !passkey) {
      finishDecision(res, 403, 'presence_required');
      req.resume();
      return;
    }
    const body = await boundedBody(req, res, passkey ? MAX_PASSKEY_BYTES : MAX_SECRET_BYTES);
    if (body === undefined) return;
    const ids = picks.map((p) => p.approvalId);
    const listed = (items: readonly string[]): Record<string, unknown> => (review ? { items } : {});
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
      const already = ids.filter((approvalId) => decided.has(approvalId));
      if (already.length > 0) {
        finishDecision(res, 409, 'not_pending', listed(already));
        return;
      }
      if (busy) {
        finishDecision(res, 409, 'busy');
        return;
      }
      busy = true;
      try {
        const entries: (ApprovalForDecision | undefined)[] = [];
        for (const pick of picks) entries.push(await source.get(pick.approvalId));
        const gone = picks
          .filter((p, i) => entries[i]?.approvalId !== p.approvalId || decided.has(p.approvalId))
          .map((p) => p.approvalId);
        if (gone.length > 0) {
          finishDecision(res, 409, 'not_pending', listed(gone));
          return;
        }
        const live = entries as ApprovalForDecision[];
        if (review) {
          // D-31, 04 §2.5.2: terms are never part of a review list; each is decided on its own card.
          const terms = live.filter((e) => e.commitment).map((e) => e.approvalId);
          if (terms.length > 0) {
            finishDecision(res, 409, 'commitment', { items: terms });
            return;
          }
        }
        const changed = picks
          .filter((pick, i) => {
            const entry = live[i] as ApprovalForDecision;
            let recomputed: string;
            try {
              recomputed = encodeHex(sha256(canonicalizeToBytes(entry.action)));
            } catch {
              return true;
            }
            // 04 §2.5.2 step 2: a request whose digest does not match is never offered.
            return (
              pick.shown === undefined ||
              !DIGEST.test(pick.shown) ||
              recomputed !== entry.storedDigest ||
              pick.shown !== entry.storedDigest
            );
          })
          .map((p) => p.approvalId);
        if (changed.length > 0) {
          finishDecision(res, 409, 'changed', listed(changed));
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
            presenceFailed();
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
          signed = await decideReviewedWith(
            store,
            pageTerminal(presence),
            context,
            picks.map((pick, i) => {
              const entry = live[i] as ApprovalForDecision;
              return {
                approvalId: pick.approvalId,
                action: entry.action,
                storedDigest: entry.storedDigest,
                decision: pick.decision,
                commitment: entry.commitment,
                summary: entry.summary,
                requestExpiresAt: entry.expiresAt,
              };
            }),
          );
        } catch (error) {
          if (error instanceof KeyStoreError && error.code === 'presence_rejected') {
            presenceFailed();
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
        presenceSucceeded();
        const outcome = await source.apply(signed);
        if (outcome.status === 'applied') {
          for (const approvalId of ids) decided.add(approvalId);
          if (review) {
            const items = [...picks]
              .sort((a, b) =>
                a.approvalId < b.approvalId ? -1 : a.approvalId > b.approvalId ? 1 : 0,
              )
              .map((p) => ({ approvalId: p.approvalId, decision: p.decision }));
            finishDecision(res, 200, 'applied', { items });
          } else {
            finishDecision(res, 200, 'applied', { decision: picks[0]?.decision });
          }
        } else {
          // 04 §2.5.2: core names the items that did not match; only IDs we sent are echoed.
          const named = (outcome.items ?? [])
            .map((i) => i.approvalId)
            .filter((approvalId) => ids.includes(approvalId));
          finishDecision(res, 409, 'refused', listed(named));
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
    if (waiting(req, res, 'passkey')) return;
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
          else if (code === 'presence_rejected') {
            presenceFailed();
            finishPasskey(res, 403, 'presence_rejected');
          } else if (code === 'presence_required') finishPasskey(res, 403, 'presence_required');
          else if (code === 'owner_missing') finishPasskey(res, 503, 'needs_setup');
          else finishPasskey(res, 500, 'failed');
          return;
        }
        presenceSucceeded();
        finishPasskey(res, 200, 'registered');
      } finally {
        busy = false;
      }
    } finally {
      wipe(body, parsed?.ownerSecret, parsed?.assertion.prfOutput);
    }
  }

  const finishOwner = (
    res: ServerResponse,
    status: number,
    outcome: OwnerOperationOutcome,
    extra: Record<string, unknown> = {},
  ): void => {
    emit({ kind: 'owner_operation', outcome });
    sendJson(res, status, { status: outcome, ...extra });
  };

  /** A handler's answer as JSON; anything malformed is 500 (fail closed). */
  const sendResult = (res: ServerResponse, result: LocalUiResult): void => {
    const ok =
      typeof result === 'object' &&
      result !== null &&
      Number.isSafeInteger(result.status) &&
      result.status >= 200 &&
      result.status <= 599;
    if (!ok) {
      sendJson(res, 500, { status: 'failed' });
      return;
    }
    sendJson(res, result.status, result.body);
  };

  /**
   * M1-11s-b, the central presence gate for a /api/ui/ owner route (04 §2.5, I-4; IR-M1-11s-b-1 H-1).
   * Owner presence is verified before `run` (the handler) is called: the wrong-code backoff, a
   * presence proof in the body (the owner code, or a passkey assertion verified against the stored
   * passkey and the owner), one owner operation at a time, the owner set up, and then the owner store
   * unlocked with that proof. A wrong code or gesture is 403 `presence_rejected`, counted towards the
   * backoff, and the handler never runs. `run` gets a one-use `sign` bound to that session (the
   * allowlist and one gesture, D-68); the session is closed and the store locked when `run` returns,
   * whatever happened. A presence route that returns without signing performed no owner operation
   * and is answered 409 `refused`, never its own result.
   */
  async function ownerGate(
    req: IncomingMessage,
    res: ServerResponse,
    run: (owner: LocalUiOwnerOperation) => Promise<LocalUiResult>,
  ): Promise<void> {
    const wait = waitSeconds();
    if (wait > 0) {
      req.resume();
      res.setHeader('Retry-After', String(wait));
      finishOwner(res, 429, 'wait', { retryAfter: wait });
      return;
    }
    const mode = header(req, 'x-agentlink-presence');
    const passkey = mode === 'passkey';
    if (mode !== undefined && !passkey) {
      req.resume();
      finishOwner(res, 403, 'presence_required');
      return;
    }
    const body = await boundedBody(req, res, passkey ? MAX_PASSKEY_BYTES : MAX_SECRET_BYTES);
    if (body === undefined) return;
    let assertion: PasskeyAssertion | undefined;
    try {
      if (body.length === 0) {
        finishOwner(res, 403, 'presence_required');
        return;
      }
      if (passkey) {
        try {
          assertion = parsePasskeyAssertion(body);
        } catch {
          finishOwner(res, 403, 'presence_required');
          return;
        }
        if (assertion.prfOutput.length === 0) {
          finishOwner(res, 403, 'presence_required');
          return;
        }
      }
      if (busy) {
        finishOwner(res, 409, 'busy');
        return;
      }
      busy = true;
      try {
        const context = await source.context();
        if (context === undefined) {
          finishOwner(res, 503, 'needs_setup');
          return;
        }
        let presence: OwnerPresence;
        if (assertion !== undefined) {
          try {
            const stored = await readOwnerPasskeyHeader(keychainOf());
            if (stored === null) throw new KeyStoreError('presence_rejected', 'presence');
            assertPasskeyAssertion(stored, context.owner, assertion);
          } catch {
            presenceFailed();
            finishOwner(res, 403, 'presence_rejected');
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
          finishOwner(res, 503, 'needs_setup');
          return;
        }
        try {
          let session: OwnerSession;
          try {
            // unlock wipes the presented bytes, whether or not they unlock.
            session = await store.unlock(presence, { ttlMs: OWNER_SESSION_DEFAULT_TTL_MS });
          } catch (error) {
            if (error instanceof KeyStoreError && error.code === 'presence_rejected') {
              presenceFailed();
              finishOwner(res, 403, 'presence_rejected');
            } else {
              finishOwner(res, 500, 'failed');
            }
            return;
          }
          presenceSucceeded();
          let used = false;
          let result: LocalUiResult;
          try {
            const owner: LocalUiOwnerOperation = Object.freeze<LocalUiOwnerOperation>({
              sign: async (review, requests) => {
                // One entry of the owner secret, one owner operation (D-68).
                if (used) {
                  throw new NodeKeyStoreError(
                    'owner_operation_invalid',
                    'One owner operation signs once.',
                  );
                }
                used = true;
                return signGesture(session, checkGesture(review, requests));
              },
            });
            result = await run(owner);
          } catch (error) {
            if (error instanceof NodeKeyStoreError) finishOwner(res, 409, 'refused');
            else finishOwner(res, 500, 'failed');
            return;
          } finally {
            await session.close().catch(() => undefined);
          }
          if (!used) {
            // A presence route that signed nothing did no owner operation (fail closed).
            finishOwner(res, 409, 'refused');
            return;
          }
          emit({ kind: 'owner_operation', outcome: 'done' });
          sendResult(res, result);
        } finally {
          await store.lock().catch(() => undefined);
          await store.close().catch(() => undefined);
        }
      } finally {
        busy = false;
      }
    } finally {
      wipe(body, assertion?.prfOutput);
    }
  }

  /** The operation input of an owner route: absent, a JSON value, or 'invalid'. */
  const operationInput = (req: IncomingMessage): JsonValue | undefined | 'invalid' => {
    const raw = header(req, 'x-agentlink-input');
    if (raw === undefined) return undefined;
    if (raw.length === 0 || raw.length > MAX_INPUT_CHARS || !BASE64URL.test(raw)) return 'invalid';
    try {
      return parseJson(decodeUtf8(decodeBase64url(raw)));
    } catch {
      return 'invalid';
    }
  };

  const finishSetup = (
    res: ServerResponse,
    status: number,
    outcome: OwnerSetupOutcome,
    extra: Record<string, unknown> = {},
    fixed: {
      readonly reason?: OwnerSetupFailure;
      readonly fingerprint?: string;
      readonly sendFolder?: SetupSendFolder;
    } = {},
  ): void => {
    // Fixed values only in the event: never the owner code or anything from the request.
    emit({ kind: 'owner_setup', outcome, ...fixed });
    sendJson(res, status, {
      status: outcome,
      ...(fixed.reason === undefined ? {} : { reason: fixed.reason }),
      ...extra,
    });
  };

  /** M1-UX-FIRSTRUN-V2-b: removes what prepareSetupFolders created (only while empty). */
  const removeFolders = async (folders: SetupFolders | undefined): Promise<void> => {
    try {
      await (internals.removeSetupFolders ?? removeSetupFolders)(folders);
    } catch {
      // Never fatal: only empty folders this run created are ever removed.
    }
  };

  /**
   * M1-UX-FIRSTRUN-V2-b (L-1, cross-process): the folders of a setup that never created an owner
   * here. Once an owner exists anywhere (a terminal `owner init` in another process may have
   * adopted this Send folder for its first policy), they are left alone; when that check fails,
   * too (an empty folder left behind is harmless, a removed one could break that policy).
   */
  const releaseFolders = async (folders: SetupFolders | undefined): Promise<void> => {
    if (folders === undefined) return;
    const setup = options.localUi?.ownerSetup;
    let ownerElsewhere: boolean;
    try {
      ownerElsewhere = setup === undefined || (await ownerExistsAnywhere(setup));
    } catch {
      ownerElsewhere = true;
    }
    if (!ownerElsewhere) await removeFolders(folders);
  };

  /**
   * M1-UX-FIRSTRUN-V2-b (L-1): the removal of dropped setups' folders, in order. `begin` waits for
   * it before preparing folders, so a new setup never loses its Send folder to an older removal.
   */
  let folderRemoval: Promise<void> = Promise.resolve();

  /** M1-11s-c: wipes and forgets the held setup, if it is still `which` (default: whatever is held). */
  const dropSetup = (which: PendingSetup | undefined = pendingSetup): void => {
    if (which === undefined || which !== pendingSetup) return;
    pendingSetup = undefined;
    clearTimeout(which.timer);
    wipe(which.seed, which.challenge, which.session);
    // M1-UX-FIRSTRUN-V2: no policy was signed, so the folders this begin created go again
    // (M1-UX-FIRSTRUN-V2-b: queued, and awaited by the next begin and by close).
    const folders = which.folders;
    folderRemoval = folderRemoval.then(() => releaseFolders(folders));
  };

  /** M1-11s-c: drops a hold that expired or whose session is gone. */
  const sweepSetup = (): void => {
    const held = pendingSetup;
    if (held === undefined) return;
    if (now() >= held.expiresAt || !sessions.some((s) => equalBytes(s, held.session))) {
      dropSetup(held);
    }
  };

  /** M1-UX-FIRSTRUN-V2: the host name for the save form; never throws. */
  const safeHostname = (): string => {
    try {
      return (internals.hostname ?? osHostname)();
    } catch {
      return '';
    }
  };

  /** M1-11s-c: true when an owner exists anywhere (card or any owner item). Rejects on errors. */
  const ownerExistsAnywhere = async (setup: LocalUiOwnerSetupOption): Promise<boolean> =>
    (await source.context()) !== undefined ||
    !(await noOwnerAnywhere(keychainOf(), setup.firstCard, undefined, setup.ownerFiles));

  /**
   * M1-11s-c: the setup gate for the two `presence: 'setup'` routes (never ownerGate). The caller
   * checked the session, CSRF, Origin, fetch metadata and the octet-stream type.
   */
  async function setupGate(
    req: IncomingMessage,
    res: ServerResponse,
    step: LocalUiSetupStep,
    cookie: string,
  ): Promise<void> {
    const wait = waitSeconds();
    if (wait > 0) {
      req.resume();
      res.setHeader('Retry-After', String(wait));
      finishSetup(res, 429, 'wait', { retryAfter: wait });
      return;
    }
    const setup = options.localUi?.ownerSetup;
    if (setup === undefined) {
      req.resume();
      finishSetup(res, 503, 'unavailable');
      return;
    }
    const body = await boundedBody(req, res, MAX_SETUP_REGISTRATION_BYTES);
    if (body === undefined) return;
    try {
      if (step === 'begin') await setupBegin(res, body, cookie, setup);
      else await setupFinish(res, body, cookie, setup);
    } finally {
      wipe(body);
    }
  }

  async function setupBegin(
    res: ServerResponse,
    body: Uint8Array,
    cookie: string,
    setup: LocalUiOwnerSetupOption,
  ): Promise<void> {
    if (body.length !== 0) {
      finishSetup(res, 400, 'invalid');
      return;
    }
    sweepSetup();
    // Fail closed: one setup at a time, from any session, and never during an owner operation.
    if (pendingSetup !== undefined || busy) {
      finishSetup(res, 409, 'busy');
      return;
    }
    busy = true;
    try {
      // M1-UX-FIRSTRUN-V2-b (L-1): a dropped setup's folders are gone before new ones are prepared.
      await folderRemoval;
      let exists: boolean;
      try {
        exists = await ownerExistsAnywhere(setup);
      } catch {
        finishSetup(res, 500, 'failed', {}, { reason: 'check_failed' });
        return;
      }
      if (exists) {
        finishSetup(res, 409, 'owner_exists');
        return;
      }
      const sessionAt = matchIndex(cookie, sessions);
      if (sessionAt < 0) {
        finishSetup(res, 409, 'not_pending');
        return;
      }
      // M1-UX-FIRSTRUN-V2: the folders, before the gesture and before any seed exists.
      const { firstPolicy } = setup.firstCard;
      let folders: SetupFolders | undefined;
      if (firstPolicy !== undefined) {
        folders = await prepareSetupFolders(firstPolicy.home);
        if (folders.send.status !== 'ready') {
          await removeFolders(folders);
          finishSetup(res, 409, 'folder_refused', {}, { reason: folders.send.reason });
          return;
        }
      }
      const { seed, keys } = (internals.newOwnerSeed ?? newOwnerSeed)();
      const challenge = randomBytes(32);
      const held: PendingSetup = {
        seed,
        keys,
        challenge,
        session: (sessions[sessionAt] as Uint8Array).slice(),
        expiresAt: now() + SETUP_HOLD_MS,
        timer: setTimeout(() => dropSetup(held), SETUP_HOLD_MS),
        ...(folders === undefined ? {} : { folders }),
      };
      held.timer.unref();
      pendingSetup = held;
      finishSetup(res, 200, 'ready', {
        expiresInMs: SETUP_HOLD_MS,
        fingerprint: ownerFingerprintText(keys),
        publicKey: {
          rpId: PASSKEY_RP_ID,
          rpName: 'AgentLink',
          userId: encodeBase64url(keys.ownerNostr),
          userName: 'AgentLink owner',
          challenge: encodeBase64url(challenge),
          prfSalt: encodeBase64url(ownerPrfSalt()),
        },
      });
    } finally {
      busy = false;
    }
  }

  async function setupFinish(
    res: ServerResponse,
    body: Uint8Array,
    cookie: string,
    setup: LocalUiOwnerSetupOption,
  ): Promise<void> {
    const held = pendingSetup;
    // Bound to its session: another session neither finishes nor consumes it.
    if (held === undefined || !matches(cookie, held.session)) {
      finishSetup(res, 409, 'not_pending');
      return;
    }
    if (now() >= held.expiresAt) {
      dropSetup(held);
      await folderRemoval;
      finishSetup(res, 409, 'expired');
      return;
    }
    if (busy) {
      finishSetup(res, 409, 'busy');
      return;
    }
    // Single-use: taken before any await; wiped whatever happens below.
    pendingSetup = undefined;
    clearTimeout(held.timer);
    busy = true;
    let registration: SetupRegistration | undefined;
    // M1-UX-FIRSTRUN-V2: the folders stay only when the first policy is (or may be) in force.
    let keepFolders = false;
    let released = false;
    // M1-UX-FIRSTRUN-V2-b: true once this run's owner exists (completeOwnerSetup returned).
    let ownerIsOurs = false;
    /**
     * Removes the folders this run created (unless kept): directly once the owner is this run's;
     * before that, only while no owner exists anywhere (releaseFolders, L-1 cross-process).
     */
    const release = async (): Promise<void> => {
      if (keepFolders || released) return;
      released = true;
      if (ownerIsOurs) await removeFolders(held.folders);
      else await releaseFolders(held.folders);
    };
    /** Answers after the folders this run created are gone (unless kept), so none outlives it. */
    const answer = async (...args: Parameters<typeof finishSetup>): Promise<void> => {
      await release();
      finishSetup(...args);
    };
    try {
      try {
        registration = parseSetupRegistration(body);
      } catch {
        await answer(res, 403, 'presence_required');
        return;
      }
      try {
        checkSetupRegistration(registration, { challenge: held.challenge, origin });
      } catch {
        await answer(res, 403, 'presence_rejected');
        return;
      }
      let exists: boolean;
      try {
        exists = await ownerExistsAnywhere(setup);
      } catch {
        await answer(res, 500, 'failed', {}, { reason: 'check_failed' });
        return;
      }
      if (exists) {
        await answer(res, 409, 'owner_exists');
        return;
      }
      let result: Awaited<ReturnType<typeof completeOwnerSetup>>;
      try {
        result = await completeOwnerSetup(
          keychainOf(),
          {
            seed: held.seed,
            keys: held.keys,
            credentialId: registration.credentialId,
            prfOutput: registration.prfOutput,
            firstCard: setup.firstCard,
            ...(held.folders?.send.status === 'ready' ? { sendFolder: held.folders.send } : {}),
          },
          {
            ...(internals.ownerKdf === undefined ? {} : { kdf: internals.ownerKdf }),
            ...(setup.ownerFiles === undefined ? {} : { ownerFiles: setup.ownerFiles }),
          },
        );
      } catch (error) {
        const code = error instanceof NodeKeyStoreError ? error.code : undefined;
        if (code === 'owner_exists') await answer(res, 409, 'owner_exists');
        else if (code === 'owner_card_failed') {
          await answer(res, 500, 'failed', {}, { reason: 'rolled_back' });
        } else if (code === 'keychain_failed') {
          await answer(res, 500, 'failed', {}, { reason: 'keychain' });
        } else if (code === 'owner_operation_refused') {
          await answer(res, 500, 'failed', {}, { reason: 'check_failed' });
        } else await answer(res, 500, 'failed', {}, { reason: 'internal' });
        return;
      }
      ownerIsOurs = true;
      keepFolders = keepsFolder(result.sendFolder);
      try {
        const fingerprint = ownerFingerprintText(held.keys);
        const sendFolder: SetupSendFolder | undefined = result.sendFolder?.status;
        // The owner code goes to the page once, for the backup-code step; never an event.
        // IR-M1-11s-c-1 M-1: also when the card is unconfirmed, since the owner was kept.
        await answer(
          res,
          200,
          result.confirmed ? 'done' : 'done_unconfirmed',
          {
            passkey: result.passkey,
            ownerCode: grouped(result.ownerCode),
            fingerprint,
            computerName: computerNameOf(safeHostname()),
            ...(sendFolder === undefined ? {} : { sendFolder }),
          },
          { fingerprint, ...(sendFolder === undefined ? {} : { sendFolder }) },
        );
      } finally {
        wipe(result.ownerCode);
      }
    } finally {
      busy = false;
      wipe(held.seed, held.challenge, held.session, registration?.prfOutput);
      await release();
    }
  }

  /** M1-11s-b: one /api/ui/ request (route registry, session, CSRF, presence gate). */
  async function handleUi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    originHeader: string | undefined,
  ): Promise<void> {
    const found = routes.match(method, url.pathname);
    if (found === undefined) {
      req.resume();
      return reject(res, 404, 'not_found');
    }
    if (found === 'method') {
      req.resume();
      return reject(res, 405, 'method');
    }
    const fail = (status: number, reason: RejectReason): void => {
      req.resume();
      reject(res, status, reason);
    };
    const cookie = cookieToken(req);
    if (matchIndex(cookie, sessions) < 0) return fail(401, 'token');
    if (!fetchSiteOk(req)) return fail(403, 'fetch_site');
    const { route, params } = found;
    if (route.presence && originHeader === undefined) return fail(403, 'origin');
    if (!matches(header(req, 'x-agentlink-csrf'), csrfBytes)) return fail(403, 'csrf');
    if (!route.presence) {
      req.resume();
      sendResult(res, await route.handler(uiContext, { params, query: url.searchParams }));
      return;
    }
    const type = (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/octet-stream') return fail(415, 'content_type');
    if (route.presence === 'setup') {
      // M1-11s-c: owner setup has its own gate; ownerGate never runs it.
      await setupGate(req, res, route.step, cookie as string);
      return;
    }
    const input = operationInput(req);
    if (input === 'invalid') {
      req.resume();
      finishOwner(res, 400, 'invalid');
      return;
    }
    await ownerGate(req, res, (owner) =>
      route.handler(
        uiContext,
        { params, query: url.searchParams, ...(input === undefined ? {} : { input }) },
        owner,
      ),
    );
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
    if (!path.startsWith(SETUP_PATH_PREFIX)) sweepSetup();

    if (path === '/app.js') {
      if (method !== 'GET') return reject(res, 405, 'method');
      sendText(res, 200, 'text/javascript; charset=utf-8', APP_JS);
      return;
    }
    if (path === '/app.css') {
      if (method !== 'GET') return reject(res, 405, 'method');
      sendText(res, 200, 'text/css; charset=utf-8', APP_CSS);
      return;
    }

    if (path.startsWith(ASSETS_PREFIX)) {
      if (method !== 'GET') return reject(res, 405, 'method');
      if (matchIndex(cookieToken(req), sessions) < 0) return reject(res, 401, 'token');
      const name = path.slice(ASSETS_PREFIX.length);
      // An exact lookup of one checked name: nothing is decoded, joined or read from disk.
      const asset = ASSET_NAME.test(name) ? localUi.table.get(name) : undefined;
      if (asset === undefined) return reject(res, 404, 'not_found');
      res.statusCode = 200;
      res.setHeader('Content-Type', asset.type);
      res.setHeader('Cache-Control', ASSET_CACHE);
      res.end(asset.body);
      return;
    }

    if (path.startsWith(LOCAL_UI_API_PREFIX)) {
      await handleUi(req, res, url, method, originHeader);
      return;
    }

    const appPage = APP_PAGE.test(path);
    const page = path === '/' || APPROVE_PAGE.test(path) || appPage;
    if (page) {
      if (method !== 'GET') return reject(res, 405, 'method');
      const t = url.searchParams.get('t');
      if (t !== null) {
        // One-shot (M1-11a): the link is consumed here and never opens the page again.
        if (!consumeLink(t)) return reject(res, 401, 'token');
        res.setHeader(
          'Set-Cookie',
          // SameSite=Strict (IR-M1-11a-1 L-2): the OS opens the link as a top-level navigation
          // with no initiator, which counts as same-site. No `Secure`: WebKit drops a Secure cookie
          // set over http://localhost (checked with Playwright WebKit), so the page would not open.
          `${cookieName}=${newSession()}; HttpOnly; SameSite=Strict; Path=/`,
        );
        res.setHeader('Location', path);
        sendText(res, 303, 'text/plain; charset=utf-8', '');
        return;
      }
      if (matchIndex(cookieToken(req), sessions) < 0) return reject(res, 401, 'token');
      if (appPage) {
        const shell = localUi.shell;
        if (shell === undefined) return reject(res, 404, 'not_found');
        // The token is base64url, so it needs no escaping.
        const meta = `<meta name="agentlink-csrf" content="${csrf}">`;
        sendText(res, 200, 'text/html; charset=utf-8', `${shell.before}${meta}${shell.after}`);
        return;
      }
      // M1-11b-2a: the app's sidebar on the approval page, only when the app is there to go to.
      // Navigation only: this page's session, CSRF and presence gates are unchanged.
      sendText(
        res,
        200,
        'text/html; charset=utf-8',
        pageHtml(csrf, { appNav: localUi.shell !== undefined }),
      );
      return;
    }

    const one = API_ONE.exec(path);
    const decideMatch = API_DECIDE.exec(path);
    const passkeyRoute = path === PASSKEY_PATH;
    const reviewRoute = path === REVIEW_PATH;
    if (
      path !== '/api/approvals' &&
      one === null &&
      decideMatch === null &&
      !passkeyRoute &&
      !reviewRoute
    ) {
      reject(res, 404, 'not_found');
      return;
    }
    const post = decideMatch !== null || reviewRoute || (passkeyRoute && method === 'POST');
    if (method !== (post ? 'POST' : 'GET')) return reject(res, 405, 'method');
    if (matchIndex(cookieToken(req), sessions) < 0) return reject(res, 401, 'token');
    if (!fetchSiteOk(req)) return reject(res, 403, 'fetch_site');
    if (post && originHeader === undefined) return reject(res, 403, 'origin');
    if (!matches(header(req, 'x-agentlink-csrf'), csrfBytes)) return reject(res, 403, 'csrf');

    if (post) {
      const type = (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
      if (type !== 'application/octet-stream') return reject(res, 415, 'content_type');
      if (reviewRoute) {
        const picks = parseReviewItems(header(req, 'x-agentlink-items'));
        if (picks === undefined) {
          req.resume();
          finishDecision(res, 400, 'invalid');
          return;
        }
        await decide(req, res, picks, true);
        return;
      }
      if (decideMatch === null) {
        await passkeyRegister(req, res);
        return;
      }
      await decide(
        req,
        res,
        [
          {
            approvalId: decideMatch[1] as string,
            shown: header(req, 'x-agentlink-digest'),
            decision: decideMatch[2] as 'approve' | 'deny',
          },
        ],
        false,
      );
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
      return opener(`${origin}${path}?t=${mintLink()}`).catch(() => false);
    },
    openFirstRun: async () => opener(`${origin}/first-run?t=${mintLink()}`).catch(() => false),
    openActivity: async () =>
      opener(`${origin}/settings/activity?t=${mintLink()}`).catch(() => false),
    notifyNewApproval: async (approvalId: string) => {
      const url = approvalUrl(approvalId);
      await notifier(NOTIFICATION).catch(() => false);
      return url;
    },
    close: async () => {
      dropSetup();
      await folderRemoval;
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
