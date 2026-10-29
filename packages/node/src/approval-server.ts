// M1-8d: the local approval server (08 §1; 04 §2.5; 06 §2.5; I-4, I-7).
//
// U3-c (D-138, 08 §1): with `options.host` the server is the app host of the `ui` process: one
// agent open at a time, switched in the same process, port and session (local-ui/app-host.ts).
// Every answer then carries the generation (`X-AgentLink-Generation`) and the open agent's label
// (`X-AgentLink-Agent`, percent-encoded plain text); every mutating request must carry the current
// generation in `X-AgentLink-Generation` (the switch carries it in its body) or it is refused with
// 409 `agent_changed`, when it arrives (after the session, CSRF, Origin, fetch-metadata and
// octet-stream checks, before any presence check) and again right before the server acts. Without
// `options.host` (an `agentlink mcp` process) the server is bound to its one agent as before.
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
// - M1-11a-ux: the card view drops the AI argument `inviteUrl` (the invite's capability link) and
//   carries an optional plain `headline`, checked like every other card field.
// - M1-11s-b, the local UI shell (D-118): the React app (apps/local-ui) is served from an in-memory
//   bundle the caller passes in (`localUi.assets`; the CLI embeds it), never from a file path.
//   Only `index.html` and `assets/<one file name>` with a known type are accepted, checked before the
//   server listens. `/assets/<name>` is an exact map lookup (no decoding, no path join), served with
//   its fixed content type, nosniff, the strict CSP (plus `font-src 'self'`) and immutable caching;
//   anything else is 404. The app's index.html, with this server's CSRF token filled in, is served
//   for `/first-run` and `/settings[/...]`, and (M1-11b-2) for `/` and `/approve/<id>`.
// - M1-11b-2c: the server-rendered approval page, its `/app.js` and `/app.css`, are gone (404).
//   Without a bundle, `/` and `/approve/<id>` answer the fixed NO_APP_HTML (approval-pages.ts):
//   no script, no form, no CSRF token, so nothing can be decided in the browser; it points to
//   `approve` in the owner's own terminal. Every gate is unchanged.
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
// - MSG-FILES-IO-h (D-134), Show in Finder: the one `presence: 'reveal'` route is run by
//   `revealGate`, never by `ownerGate`. After the same session, CSRF, Origin, fetch-metadata and
//   octet-stream checks, the body must be exactly `{"id":"<item ID>"}` (no query, input or presence
//   header); the handler gets only that ID and the checked reveal (local-ui/reveal-file.ts). No
//   owner presence, no owner store, nothing signed or written.
// - UX2-d1 (owner decision 1.1; proposed in 08 §1, owner confirms at merge), creating an invite and
//   checking a pasted one: the two `presence: 'invite'` routes are run by `inviteGate`, never by
//   `ownerGate`. After the same session, CSRF, Origin, fetch-metadata and octet-stream checks, no
//   query, operation input or presence header; the body is one strict JSON object (1 KiB for create,
//   22 KiB for check). Create is limited to INVITE_CREATE_LIMIT per INVITE_CREATE_WINDOW_MS
//   (429 `wait`). The handler gets only that object and the invite desk (local-ui/context.ts): no
//   owner presence, no owner store, nothing signed. The body (a pasted link holds the invite
//   secret) is wiped after the handler, and nothing here logs it. Accepting an invite is an ordinary
//   owner route behind `ownerGate`.
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
// - M1-11b-9, U3-a (D-138; 08 §1): `openHome()` is the same for Home (`/settings/home`), for
//   `agentlink ui`; it replaces `openActivity()`. A session link grants viewing and the
//   owner-presence-gated actions only, as for `open()`.
//
// Out of scope and accepted (G-1, D-67; 04 §2.5): a same-user process that reads memory, modifies the
// installed package, or serves a look-alike page on another localhost port. Cookies are not isolated
// by port, so another local server the owner's browser visits could receive the session cookie; it
// grants viewing only. The opener's argv briefly holds the session link (approval-os.ts).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname as osHostname } from 'node:os';
import type { AddressInfo, ListenOptions } from 'node:net';
import {
  PayConfirmError,
  buildPayConfirmFlow,
  isPaidPendingAction,
  policySetSpendingChanges,
  rememberContactRules,
  type OwnerActionOutcome,
  type PayConfirmFlow,
  type RevokeDeliveryOptions,
  verifyRevokedEntry,
} from '@4thtech-io/core';
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
  type EnvelopeKeys,
  type JsonObject,
  type JsonValue,
  type OwnerPresence,
  type OwnerPublicKeys,
  type OwnerSession,
} from '@4thtech-io/crypto';
import {
  osBrowserOpener,
  osFileRevealer,
  osNotifier,
  type BrowserOpener,
  type FileRevealer,
  type OsNotifier,
} from './approval-os.js';
import { revealSavedFile } from './local-ui/reveal-file.js';
import { EXPIRED_HTML, NO_APP_HTML } from './approval-pages.js';
import { NodeKeyStoreError } from './errors.js';
import { osKeychain, type KeychainBackend } from './keychain.js';
import {
  buildApprovalOperation,
  decideReviewedWith,
  type ApprovalContext,
} from './owner-approval.js';
import {
  MAX_PAY_CONFIRM_ASSERTION_BYTES,
  PAY_CONFIRM_TTL_MS,
  PayConfirmHolds,
  checkPayConfirmAssertion,
  parsePayConfirmAssertion,
  type PayConfirmAssertion,
  type PayConfirmHold,
  type PayConfirmTarget,
} from './pay-confirm.js';
import { takeReviewedRules } from './local-ui/api/rules.js';
import { grouped } from './owner-init.js';
import {
  KeychainOwnerKeyStore,
  newOwnerSeed,
  ownerFingerprintText,
  ownerItemPresent,
} from './owner-keystore.js';
import {
  MAX_SETUP_REGISTRATION_BYTES,
  SETUP_HOLD_MS,
  checkSetupRegistration,
  completeOwnerSetup,
  computerNameOf,
  noOwnerAndNoAgent,
  noOwnerAnywhere,
  parseSetupRegistration,
  prepareSetupFolders,
  removeSetupFolders,
  type SetupFolders,
  type SetupRegistration,
} from './owner-setup.js';
import {
  keepsFolder,
  prepareSendFolder,
  removeCreated,
  type SendFolderPlan,
} from './owner-first-policy.js';
import { labelActionsOf, type FirstAgentCard } from './owner-first-card.js';
import { signNewAgent } from './owner-add-agent.js';
import { isAgentLabelText } from './local-ui/api/agents-manage.js';
import {
  PASSKEY_RP_ID,
  assertPasskeyAssertion,
  parsePasskeyAssertion,
  parsePasskeyRegistration,
  readOwnerPasskeyHeader,
  readOwnerPasskeyKey,
  registerOwnerPasskey,
  type PasskeyAssertion,
} from './owner-passkey.js';
import {
  creditsPort,
  inviteAcceptPort,
  inviteDesk,
  readOnlyClient,
  type LocalUiAgentView,
  type LocalUiAgentsList,
  type LocalUiAgentsManage,
  type LocalUiAiApps,
  type LocalUiNewAgent,
  type LocalUiAssets,
  type LocalUiContext,
  type LocalUiOptions,
  type LocalUiOwnerSetup as LocalUiOwnerSetupOption,
} from './local-ui/context.js';
import { JoinDesk, type JoinCheck } from './local-ui/join-desk.js';
import { pairingFollower, type PairingFollower } from './local-ui/pairing-follow.js';
import { JOIN_PAGE_PATH } from './local-ui/invite-paths.js';
import type {
  LocalUiInviteRoute,
  LocalUiReadRoute,
  LocalUiRoute,
  LocalUiSwitchRoute,
  LocalUiOwnerOperation,
  LocalUiPayConfirmStep,
  LocalUiResult,
  LocalUiRevealRoute,
  LocalUiSetupStep,
} from './local-ui/route-types.js';
import { LOCAL_UI_MAX_INPUT_CHARS, NOT_AVAILABLE } from './local-ui/route-types.js';
import {
  AppHostSlot,
  FIRST_AGENT_LABEL,
  FIRST_AGENT_NAME,
  type AppHostAgent,
  type AppHostFirstRun,
  type AppHostHold,
  type AppHostOptions,
  type AppHostSwitchOutcome,
} from './local-ui/app-host.js';
import {
  REMOVE_STATUS,
  RemovalStepFailed,
  parseRemoveInput,
  runFinishSteps,
  runRemovalSteps,
  type RemovalStep,
  type RemoveOutcome,
} from './local-ui/api/agents-remove.js';
import { AgentFolderLockError } from './agent-folder-lock.js';
import { createKeyEraseControl } from './key-controls.js';
import {
  LOCAL_UI_API_PREFIX,
  LocalUiRouteRegistry,
  createLocalUiRoutes,
} from './local-ui/routes.js';
import { createHealthReader } from './local-ui/api/health.js';
import {
  assertPrintable,
  checkGesture,
  signGesture,
  type OwnerReview,
  type OwnerSignRequest,
  type PromptingOwnerKeyStore,
} from './owner-operation.js';
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
/**
 * Longest accepted passkey body (assertion, or owner code plus assertion), M1-8e; M1-PAY-CONFIRM-b
 * adds room for the create() authenticator data a registration may carry.
 */
const MAX_PASSKEY_BYTES = 6144;
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
/** MSG-FILES-IO-h: the largest Show in Finder body (`{"id":"<64 chars>.<2 digits>"}` fits easily). */
const MAX_REVEAL_BODY_BYTES = 256;
/** MSG-FILES-IO-h: an item ID, `<envelope ID>.<index>` (core ui-messages.ts). */
const REVEAL_ITEM_ID = /^[A-Za-z0-9_-]{1,64}\.[0-9]{2}$/;

/**
 * UX2-d1: the largest check body: `{"invite":"<link>"}` with the longest link (the canonical prefix
 * and 21 846 payload characters, 04 §3.6) fits.
 */
const MAX_INVITE_CHECK_BODY_BYTES = 22_528;
/** UX2-d1: the largest create body: `{"label":"<name>"}`, a name of at most 128 characters. */
const MAX_INVITE_CREATE_BODY_BYTES = 1_024;
/** UX2-d1: at most this many invites created per window, per server (a store and spam bound). */
const INVITE_CREATE_LIMIT = 10;
const INVITE_CREATE_WINDOW_MS = 10 * 60_000;
/** U3-invite (08 §4): at most one handoff per this many ms (then 429 `wait`). */
const HANDOFF_INTERVAL_MS = 5_000;
/** U3-invite (08 §4; M1-UX-OPEN-APP rules): at most one join-screen open per this many ms. */
const JOIN_OPEN_INTERVAL_MS = 30_000;
/** U3-invite: the handoff token header (`agentlink join` only; never the page). */
const HANDOFF_HEADER = 'x-agentlink-handoff';

/** Longest `X-AgentLink-Input` (base64url JSON) a /api/ui/ owner route accepts (route-types.ts). */
const MAX_INPUT_CHARS = LOCAL_UI_MAX_INPUT_CHARS;
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
  /**
   * M1-PAY-CONFIRM-b: the request carries a fee (core `isPaidPendingAction`): never a list item,
   * approved only through the confirmation sheet (04 §2.5.3 rule 7). A display flag only: the
   * server enforces the rule from the stored action whatever the page shows.
   */
  readonly paid?: boolean;
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
        | 'not_found'
        /** U3-c: a mutating request built against another generation (app host). */
        | 'agent_changed'
        /** U3-invite: a handoff the handoff gate refused (never which check, never the body). */
        | 'handoff'
        /** U3-g-b: an agent-scoped route while the app host has no agent open. */
        | 'no_agent';
    }
  | {
      readonly kind: 'decision';
      readonly outcome:
        | 'applied'
        /** M1-11a: the review list was malformed, a duplicate, empty or too long. */
        | 'invalid'
        /** M1-11a: a commitment was in a review list (decided alone, D-31). */
        | 'commitment'
        /** M1-PAY-CONFIRM-a (04 §2.5.3 rule 7): a paid item was in a review list. */
        | 'paid_item_in_batch'
        /** M1-PAY-CONFIRM-a: approving a paid item takes its own confirmation (begin, finish). */
        | 'confirm_required'
        /** M1-11a: wrong-code backoff in force. */
        | 'wait'
        | 'refused'
        | 'presence_required'
        | 'presence_rejected'
        | 'not_pending'
        | 'changed'
        | 'busy'
        | 'needs_setup'
        /** U3-c: the open agent changed since the page was built (app host). */
        | 'agent_changed'
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
        /** M1-PAY-CONFIRM-a: a spending change or a paid approval goes through the confirmation. */
        | 'confirm_required'
        | 'wait'
        | 'invalid'
        | 'presence_required'
        | 'presence_rejected'
        | 'busy'
        | 'needs_setup'
        | 'refused'
        /** U3-c: the open agent changed since the page was built (app host). */
        | 'agent_changed'
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
        /** U3-d: the label is not its own restricted form, or not the one `begin` was given. */
        | 'label_invalid'
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
  /**
   * M1-PAY-CONFIRM-a: the outcome of a paid-action confirmation step (fixed values only: never the
   * challenge, the statement, an amount, a name, the assertion or the backup code; I-7).
   */
  | {
      readonly kind: 'pay_confirm';
      readonly outcome:
        | 'ready'
        | 'applied'
        | 'invalid'
        | 'wait'
        | 'busy'
        | 'needs_setup'
        | 'not_pending'
        | 'not_paid'
        | 'unknown'
        | 'expired'
        | 'changed'
        | 'presence_required'
        | 'presence_rejected'
        | 'verification_required'
        /** Rule 5: the passkey has no stored credential key; use the backup code. */
        | 'passkey_update_needed'
        /** M1-PAY-CONFIRM-b: "Remember for this contact" is not offered for this request (06 §3). */
        | 'not_offered'
        | 'tries_exhausted'
        | 'refused'
        | 'failed';
    }
  /** U3-c: a switch of the open agent in the app host (fixed outcome only, never a name). */
  | { readonly kind: 'switch'; readonly outcome: AppHostSwitchOutcome }
  /** U3-e: removing an agent (fixed outcome and step only, never a name, label or ID; I-7). */
  | { readonly kind: 'remove'; readonly outcome: RemoveOutcome; readonly step?: RemovalStep }
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
  /**
   * U3-c: the app host (`agentlink ui` only). Present: the agent comes from `host.initial` and can be
   * switched; `source` and `localUi.client` are ignored (`localUi.assets` and `version` are used).
   */
  readonly host?: AppHostOptions;
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
  /** U3-e: the bounded wait of the revoke carriers (tests: a fake clock). */
  readonly removalDelivery?: RevokeDeliveryOptions;
  readonly opener?: BrowserOpener;
  readonly notifier?: OsNotifier;
  /** MSG-FILES-IO-h: the OS file revealer behind Show in Finder. Default: osFileRevealer. */
  readonly fileRevealer?: FileRevealer;
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
  /** U3-invite: Accept step 1 of the waiting invite. Default: core checkInviteLink. */
  readonly checkInvite?: JoinCheck;
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
   * M1-11b-9, U3-a (D-138): the same for Home, the landing page, at `/settings/home`
   * (`agentlink ui`). A fixed path; nothing from a caller reaches the link.
   */
  openHome(): Promise<boolean>;
  /**
   * U3-invite (08 §4): the same for the join screen (`/settings/join`), or for first run while no
   * owner exists, so first run ends on "Accept {name}'s invite?". A fixed path: the invite never
   * reaches the link.
   */
  openJoin(): Promise<boolean>;
  /** Raises the fixed OS notification for a new request and returns its approvalUrl. */
  notifyNewApproval(approvalId: string): Promise<string>;
  close(): Promise<void>;
}

type DecisionOutcome = Extract<ApprovalServerEvent, { kind: 'decision' }>['outcome'];
type PasskeyOutcome = Extract<ApprovalServerEvent, { kind: 'passkey' }>['outcome'];
type RejectReason = Extract<ApprovalServerEvent, { kind: 'rejected' }>['reason'];
type OwnerOperationOutcome = Extract<ApprovalServerEvent, { kind: 'owner_operation' }>['outcome'];
type OwnerSetupOutcome = Extract<ApprovalServerEvent, { kind: 'owner_setup' }>['outcome'];
type PayConfirmOutcome = Extract<ApprovalServerEvent, { kind: 'pay_confirm' }>['outcome'];

/** M1-PAY-CONFIRM-a: an ordinary owner route tried to sign what only the confirmation signs. */
class ConfirmRequired extends Error {
  constructor() {
    super('This needs the paid-action confirmation.');
    this.name = 'ConfirmRequired';
  }
}

/** U3-c: the open agent changed after the request arrived (the re-check before acting). */
class AgentChanged extends Error {
  constructor() {
    super('The open agent changed.');
    this.name = 'AgentChanged';
  }
}

/**
 * U3-e: the carrier keys of one removal gesture (route-types.ts `carrierKeys`): the owner session's
 * envelope signature, seal (Nostr kind 13 only) and NIP-44 encryption, while `open()` holds. Nothing
 * that decrypts: `nip44Decrypt` and `unwrapCek` always refuse.
 */
function carrierKeysOf(session: OwnerSession, open: () => boolean): EnvelopeKeys {
  const closed = (): Promise<never> =>
    Promise.reject(new KeyStoreError('owner_locked', 'The owner session has ended.'));
  const refused = (): Promise<never> =>
    Promise.reject(
      new KeyStoreError('operation_not_allowed', 'Removal keys only seal revoke carriers.'),
    );
  return Object.freeze<EnvelopeKeys>({
    signEnvelopeHash: (hash) => (open() ? session.signEnvelopeHash(hash) : closed()),
    signNostr: (event) => {
      if (!open()) return closed();
      if ((event as { kind?: unknown }).kind !== 13) return refused();
      return session.signNostr(event);
    },
    nip44Encrypt: (peer, plaintext) => (open() ? session.nip44Encrypt(peer, plaintext) : closed()),
    nip44Decrypt: () => refused(),
    unwrapCek: () => refused(),
  });
}

/** U3-c: the source while the app host has no agent open (a failed switch): nothing to show. */
const NO_AGENT_SOURCE: ApprovalServerSource = Object.freeze<ApprovalServerSource>({
  context: () => Promise.resolve(undefined),
  list: () => Promise.resolve([]),
  get: () => Promise.resolve(undefined),
  apply: () => Promise.reject(new Error('No agent is open.')),
});

/**
 * U3-g-b (08 §1 "with no agent yet, Welcome"): the only `/api/ui/` routes the app host answers while
 * no agent is open: the setup-time reads (owner state, AI apps, label check, the Agents list, health)
 * and first run's two setup steps. Every other route (and the approval API) is refused with 409
 * `no_agent` after every guard and before any handler, presence check or agent is reached. The switch
 * kind keeps its own gate (it opens only a listed agent).
 */
/** U3-g-b (IR-U3-g-b-1 H-1): marks the successful first-run finish that opened the first agent. */
const GENERATION_ADOPTED_HEADER = 'X-AgentLink-Generation-Adopted';

const NO_AGENT_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/ui/first-run',
  'GET /api/ui/apps',
  'GET /api/ui/agents/label-check',
  'GET /api/ui/agents',
  'GET /api/ui/health',
  'POST /api/ui/first-run/owner/begin',
  'POST /api/ui/first-run/owner/finish',
  // U3-e: removal leaves no agent open after `undeliverable` ("Remove anyway?") or when none is
  // left; the remove kind keeps its own gate (owner presence, typed label) and needs no open agent.
  'POST /api/ui/agents/remove',
  // U3-invite (08 §4): the waiting invite is the host's, not an agent's: its read and "Not now"
  // answer during first run on a computer with no agent yet. Accepting needs the agent.
  'GET /api/ui/join',
  'POST /api/ui/join/dismiss',
]);

/**
 * U3-g-c: a read-only desk over the host's AI apps reader: `list` only (bound once, so nothing else
 * of the caller's object is reachable); `plan` refuses and `agentIdOf` knows no agent.
 */
function listOnlyAiApps(
  reader: { readonly list: LocalUiAiApps['list'] } | undefined,
): LocalUiAiApps | undefined {
  if (reader === undefined) return undefined;
  const list = reader.list.bind(reader);
  return Object.freeze<LocalUiAiApps>({
    list: () => list(),
    plan: () => Promise.reject(new Error('No agent is open.')),
    agentIdOf: () => Promise.resolve(undefined),
  });
}

/** U3-c: the switch body is `{"name":"<32 chars>","generation":<16 digits>}`. */
const MAX_SWITCH_BODY_BYTES = 128;
/** U3-c: the most agents `GET /api/ui/agents` lists (b11 §29 shows search above 8). */
const MAX_LISTED_AGENTS = 200;

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
  /** U3-d: the label `begin` was given (06 §6 label rule); `finish` must carry the same. */
  readonly label?: string;
  /** U3-g-b: begun with no agent yet (first run creates the agent); `finish` must be the same. */
  readonly noAgent?: true;
}

/** U3-g-b: what a setup runs against: the open agent's setup, or first run with no agent yet. */
type SetupTarget =
  | { readonly kind: 'agent'; readonly setup: LocalUiOwnerSetupOption }
  | { readonly kind: 'first'; readonly firstRun: AppHostFirstRun };

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
  const { approvalId, summary, actionDigest, expiresAt, commitment, details, paid } =
    item as Record<string, unknown>;
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
    // M1-PAY-CONFIRM-b: from the stored action when the source gives it (one request), else the
    // source's flag (the list carries no action).
    paid:
      'action' in item ? isPaidPendingAction((item as { action: unknown }).action) : paid === true,
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
  // U3-c: the per-agent pieces; the app host rebinds them on a switch (bindAgent).
  let source: ApprovalServerSource = options.source;
  let agentUi: Omit<LocalUiOptions, 'assets'> | undefined = options.localUi;
  /** U3-g-c: the app host's list-only AI apps reader, for while no agent is open (read-only). */
  const noAgentAiApps: LocalUiAiApps | undefined = listOnlyAiApps(options.host?.aiAppsList);
  let agentLabel: string | undefined;
  /** U3-c: the app host, when this server is one (created once every gate below exists). */
  let host: AppHostSlot | undefined = undefined;
  /** U3-c: the host hold of each mutating request in flight, for the re-check before acting. */
  const requestHolds = new WeakMap<IncomingMessage, AppHostHold>();
  /** U3-d: the open agent's verified label is read once per bind; answers wait for it. */
  let labelReady: Promise<void> = Promise.resolve();
  /** U3-d: the agents this server created and has not settled, with their opened handles. */
  const newAgents = new WeakSet<LocalUiNewAgent>();
  const newAgentHandles = new WeakMap<LocalUiNewAgent, AppHostAgent>();
  // M1-11s-b: the bundle is checked before anything listens (fail closed).
  const localUi = loadLocalUi(options.localUi?.assets);
  const routes = internals.routes ?? createLocalUiRoutes();
  let keychainInstance: KeychainBackend | undefined = internals.keychain;
  const keychainOf = (): KeychainBackend => (keychainInstance ??= osKeychain());
  const openOwnerStore =
    internals.openOwnerStore ??
    ((owner: OwnerPublicKeys) => KeychainOwnerKeyStore.open(keychainOf(), owner));
  const opener = internals.opener ?? osBrowserOpener;
  // MSG-FILES-IO-h: the checked reveal handed to the reveal route's handler (never the bare opener).
  const fileRevealer = internals.fileRevealer ?? osFileRevealer;
  const revealFile = (inboxFolder: string, savedName: string) =>
    revealSavedFile(inboxFolder, savedName, { opener: fileRevealer });
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
  /** UX2-d1: the invite desk of the invite-kind routes (never reachable from another route). */
  let invitesDesk = agentUi?.client === undefined ? undefined : inviteDesk(agentUi.client);
  /** UX2-d1: when each recent invite was created (ms), oldest first, for the create limit. */
  const invitesCreated: number[] = [];
  /** M1-11s-c: the one owner setup in progress, if any. */
  let pendingSetup: PendingSetup | undefined;
  /** U3-invite (08 §4): the app host's waiting invite, in memory only; absent outside the host. */
  const joinDesk =
    options.host === undefined ? undefined : new JoinDesk(() => now(), internals.checkInvite);
  /**
   * U3-invite-b (06 §6, Decision 37; proposed): the open agent's pass follower, in the app host
   * only; a fresh one per bound agent, so a switch never reaches the previous agent's client.
   */
  const followerOf = (bound: typeof agentUi): PairingFollower | undefined =>
    options.host === undefined || bound?.client === undefined
      ? undefined
      : pairingFollower(bound.client, { nowMs: () => now() });
  let follower = followerOf(agentUi);
  /** U3-invite: the handoff token (32 random bytes), only with a handoff record to publish it in. */
  const handoffToken =
    options.host?.handoff === undefined ? undefined : encodeBase64url(randomBytes(32));
  const handoffBytes = handoffToken === undefined ? undefined : encodeUtf8(handoffToken);
  /** U3-invite: when the last handoff arrived and when the join screen was last opened (ms). */
  let lastHandoffAt = Number.NEGATIVE_INFINITY;
  let lastJoinOpenAt = Number.NEGATIVE_INFINITY;
  // U3-d (D-138; 08 §1; 04 §2.8 "From the local app"): create an agent and save a verified label.
  // Nothing here signs: the first parts are signed only by the owner gate's `addAgent`.
  const agentsManage: LocalUiAgentsManage = Object.freeze<LocalUiAgentsManage>({
    current: () => host?.current,
    create: async (label: string) => {
      const slot = host;
      const directory = slot?.directory;
      if (slot === undefined || directory?.create === undefined) return undefined;
      let name: string;
      try {
        name = await directory.create(label);
      } catch {
        return undefined;
      }
      const opened = await slot.openNew(name);
      const first = opened?.firstCard;
      const firstPolicy = first?.firstPolicy;
      const actions = labelActionsOf(firstPolicy?.actions);
      if (opened === undefined || first === undefined || actions === undefined) {
        await opened?.close().catch(() => undefined);
        await directory.discardNew?.(name).catch(() => undefined);
        return undefined;
      }
      // The Send folder for its first policy, checked (or created) now; removed again on failure.
      const plan = await prepareSendFolder(firstPolicy?.home).catch(
        () => ({ status: 'refused', reason: 'not_real' }) as const,
      );
      const agent: LocalUiNewAgent = Object.freeze<LocalUiNewAgent>({
        name,
        label,
        first: Object.freeze<FirstAgentCard>({ ...first, firstLabel: { label, actions } }),
        plan: plan as SendFolderPlan,
      });
      newAgents.add(agent);
      newAgentHandles.set(agent, opened);
      return agent;
    },
    settle: async (agent: LocalUiNewAgent, ok: boolean) => {
      const opened = newAgentHandles.get(agent);
      newAgentHandles.delete(agent);
      newAgents.delete(agent);
      await opened?.close().catch(() => undefined);
      const directory = host?.directory;
      if (opened === undefined || directory === undefined) return;
      if (ok) {
        // Display only (07 §9.1): the verified label is in the new agent's store.
        await directory.writeLabel(agent.name, agent.label).catch(() => undefined);
        return;
      }
      // All or nothing (04 §2.8): exactly what this request made goes again.
      await removeCreated(agent.plan).catch(() => undefined);
      await directory.discardNew?.(agent.name).catch(() => undefined);
    },
    labelSaved: async (name: string, label: string) => {
      const slot = host;
      if (slot === undefined) return;
      if (name === slot.current) agentLabel = label;
      await slot.directory.writeLabel(name, label);
    },
  });

  // U3-c (IR-U3-c-SEC-1 L-1): the source is captured when the context is built, so a handler that
  // outlives a switch's drain wait keeps the agent it started with and never reaches the next one.
  const buildUiContext = (bound: ApprovalServerSource = source): LocalUiContext =>
    Object.freeze<LocalUiContext>({
      // IR-M1-11s-b-1 H-1: handlers read through a read-only view, never the client itself.
      client: agentUi?.client === undefined ? undefined : readOnlyClient(agentUi.client),
      // M1-11c-a4c: for the presence routes only; core re-verifies the owner signature (I-4).
      ...(agentUi?.client === undefined ? {} : { credits: creditsPort(agentUi.client) }),
      // UX2-d1: accepting an invite, for the accept owner route; it pairs only after core used an
      // owner-signed, applied approval (I-4).
      ...(agentUi?.client === undefined ? {} : { invites: inviteAcceptPort(agentUi.client) }),
      ownerContext: () => bound.context(),
      applyOwnerAction: (signed) => bound.apply(signed),
      now: () => now(),
      // M1-11s-a-d: the status bar's health read (fixed fields, cached, bounded).
      health: createHealthReader({
        ...(agentUi?.health === undefined ? {} : { source: agentUi.health }),
        hasClient: agentUi?.client !== undefined,
        ...(options.localUi?.version === undefined ? {} : { version: options.localUi.version }),
        now: () => now(),
      }),
      // U3-c: the Agents list, in the app host only.
      ...(options.host === undefined ? {} : { agents: { list: () => listAgents() } }),
      // U3-d: create an agent and save a verified label, in the app host only.
      ...(options.host === undefined ? {} : { agentsManage }),
      // U3-invite: the waiting invite, in the app host only.
      ...(joinDesk === undefined ? {} : { join: joinDesk }),
      // U3-invite-b: the join screen's lease-gated pass, captured with this context's agent.
      ...(follower === undefined ? {} : { followPairing: follower.follow }),
      // U3-g-b (IR-U3-g-b-1 L): with no agent yet, the first-run page's owner state is the real one.
      ...(agentUi === undefined && options.host?.firstRun !== undefined
        ? { setupBlocked: () => setupBlockedNoAgent() }
        : {}),
      // U3-f: the CLI's harness desk (the one AI app config writer), when the caller wired it.
      // U3-g-c: with no agent open, the host's list-only reader (Welcome's "Pick your AI app").
      ...aiAppsPart(),
    });
  let uiContext: LocalUiContext = buildUiContext();

  /**
   * U3-g-c: the AI apps desk the routes see: the open agent's own (U3-f), else, while no agent is
   * open, the host's list-only reader. Only `GET /api/ui/apps` is reached then (NO_AGENT_ROUTES);
   * the reader's plan refuses anyway (defence in depth) and it knows no agent.
   */
  function aiAppsDesk(): LocalUiAiApps | undefined {
    if (agentUi !== undefined) return agentUi.aiApps;
    return noAgentAiApps;
  }

  /** U3-g-c: the context's `aiApps` field (absent when there is no desk). */
  function aiAppsPart(): { readonly aiApps?: LocalUiAiApps } {
    const desk = aiAppsDesk();
    return desk === undefined ? {} : { aiApps: desk };
  }

  /** U3-d: reads the open agent's verified label (core loadLabel); the folder name otherwise. */
  async function refreshLabel(): Promise<void> {
    const bound = agentUi;
    const client = bound?.client;
    if (client === undefined) return;
    try {
      const reading = await client.ownerActions.loadLabel();
      if (agentUi === bound && reading.status === 'verified') agentLabel = reading.label;
    } catch {
      // Not verified: the folder name is shown (fail closed).
    }
  }

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
        // M1-PAY-CONFIRM-a (04 §2.5.3 rule 7): a request that carries a fee is never part of a
        // review list, and approving one takes its own confirmation (POST /api/ui/pay-confirm/…).
        // Denying it costs nothing and keeps the ordinary prompt.
        const paid = picks.filter((_p, i) =>
          isPaidPendingAction((live[i] as ApprovalForDecision).action),
        );
        if (review && paid.length > 0) {
          finishDecision(res, 409, 'paid_item_in_batch', { items: paid.map((p) => p.approvalId) });
          return;
        }
        if (!review && paid.some((p) => p.decision === 'approve')) {
          finishDecision(res, 409, 'confirm_required');
          return;
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
        if (!stillCurrent(req)) {
          // U3-c: the open agent changed while this request was on its way.
          await store.close().catch(() => undefined);
          finishDecision(res, 409, 'agent_changed');
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

  /**
   * GET /api/owner/passkey: the public data the page needs for the WebAuthn ceremony.
   *
   * HOTFIX-045-TOUCHID: in the app host with no agent open, the owner store answers (the
   * `owner-passkey` item's public header), so a presence sheet still offers the passkey; the gate
   * verifies every assertion against the owner of the operation, as before. When the passkey can't
   * be used, `reason` says why in a fixed code: `not_set_up_here` (this computer has none: an owner
   * set up before 0.3.0, or one switched on another computer) or `other_owner` (the stored passkey
   * belongs to another owner than the open agent's card). Registering stays an open agent's
   * operation: `userId` (needed to switch) is given only with an owner to bind it to.
   */
  async function passkeyInfo(res: ServerResponse): Promise<void> {
    const context = noAgentOpen() ? undefined : await source.context();
    if (context === undefined && !noAgentOpen()) {
      sendJson(res, 503, { status: 'needs_setup' });
      return;
    }
    const stored = await readOwnerPasskeyHeader(keychainOf());
    const prfSalt = encodeBase64url(ownerPrfSalt());
    if (context === undefined) {
      if (stored !== null) {
        sendJson(res, 200, {
          passkey: {
            registered: true,
            rpId: PASSKEY_RP_ID,
            userId: encodeBase64url(stored.ownerNostr),
            prfSalt,
            credentialId: encodeBase64url(stored.credentialId),
          },
        });
      } else if (await ownerItemPresent(keychainOf())) {
        sendJson(res, 200, {
          passkey: { registered: false, rpId: PASSKEY_RP_ID, prfSalt, reason: 'not_set_up_here' },
        });
      } else {
        sendJson(res, 503, { status: 'needs_setup' });
      }
      return;
    }
    const usable = stored !== null && equalBytes(stored.ownerNostr, context.owner.ownerNostr);
    sendJson(res, 200, {
      passkey: {
        registered: usable,
        rpId: PASSKEY_RP_ID,
        userId: encodeBase64url(context.owner.ownerNostr),
        prfSalt,
        ...(usable
          ? { credentialId: encodeBase64url(stored.credentialId) }
          : { reason: stored === null ? 'not_set_up_here' : 'other_owner' }),
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
        const { ownerSecret, assertion, creationAuthenticatorData } = parsed;
        parsed = undefined; // registerOwnerPasskey wipes the code and the PRF output
        try {
          await registerOwnerPasskey(
            keychainOf(),
            context.owner,
            ownerSecret,
            assertion,
            creationAuthenticatorData === undefined ? {} : { creationAuthenticatorData },
          );
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
   *
   * U3-e (the remove gate only): `gate.context` checks presence against the owner the removed
   * agent's own card names instead of the open agent's, and `gate.carriers` gives `run` the carrier
   * keys of this session once it signed an `agent.revoke` (route-types.ts `carrierKeys`).
   */
  async function ownerGate(
    req: IncomingMessage,
    res: ServerResponse,
    run: (owner: LocalUiOwnerOperation) => Promise<LocalUiResult>,
    gate: {
      readonly context?: () => Promise<ApprovalContext | undefined>;
      readonly carriers?: true;
    } = {},
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
        const context = await (gate.context ?? (() => source.context()))();
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
          // U3-e: open only between this gesture's signed `agent.revoke` and the end of `run`.
          let carriersOpen = false;
          let result: LocalUiResult;
          try {
            const owner: LocalUiOwnerOperation = Object.freeze<LocalUiOwnerOperation>({
              ...(gate.carriers === true
                ? {
                    carrierKeys: () =>
                      carriersOpen ? carrierKeysOf(session, () => carriersOpen) : undefined,
                  }
                : {}),
              sign: async (review, requests) => {
                // U3-c: right before acting, the open agent is still the one the page showed.
                if (!stillCurrent(req)) throw new AgentChanged();
                // One entry of the owner secret, one owner operation (D-68).
                if (used) {
                  throw new NodeKeyStoreError(
                    'owner_operation_invalid',
                    'One owner operation signs once.',
                  );
                }
                used = true;
                const frozen = checkGesture(review, requests);
                // M1-PAY-CONFIRM-a (04 §2.5.3): a spending change or a paid approval is signed
                // only through the confirmation, never by an ordinary owner route.
                await refuseUnconfirmedPaid(frozen);
                const signatures = await signGesture(session, frozen);
                const only = frozen[0];
                if (
                  gate.carriers === true &&
                  frozen.length === 1 &&
                  only?.kind === 'owner-action' &&
                  only.action['op'] === 'agent.revoke'
                ) {
                  carriersOpen = true;
                }
                return signatures;
              },
              // U3-d (04 §2.8 "From the local app"): Add an agent, in the app host only. The same
              // one owner operation: exactly the new agent's first card, first policy and first
              // label, for that agent only (signNewAgent); never `sign` as well.
              ...(host === undefined
                ? {}
                : {
                    addAgent: async (review: OwnerReview, agent: LocalUiNewAgent) => {
                      if (used) {
                        throw new NodeKeyStoreError(
                          'owner_operation_invalid',
                          'One owner operation signs once.',
                        );
                      }
                      used = true;
                      if (!newAgents.has(agent)) {
                        throw new NodeKeyStoreError(
                          'owner_operation_invalid',
                          'Only an agent this app just created gets its first card here.',
                        );
                      }
                      if (!Array.isArray(review.lines) || review.lines.length === 0) {
                        throw new NodeKeyStoreError('owner_operation_invalid', 'Nothing to show.');
                      }
                      for (const line of review.lines) assertPrintable(line, 'A review line');
                      if (!stillCurrent(req)) throw new AgentChanged();
                      return signNewAgent(session, context.owner, agent.first, agent.plan);
                    },
                  }),
            });
            if (!stillCurrent(req)) throw new AgentChanged();
            result = await run(owner);
          } catch (error) {
            if (error instanceof AgentChanged) finishOwner(res, 409, 'agent_changed');
            else if (error instanceof ConfirmRequired) finishOwner(res, 409, 'confirm_required');
            else if (error instanceof NodeKeyStoreError) finishOwner(res, 409, 'refused');
            else finishOwner(res, 500, 'failed');
            return;
          } finally {
            carriersOpen = false;
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

  // --- M1-PAY-CONFIRM-a: confirming paid actions (04 §2.5.3; pay-confirm.ts) ---------------------

  const payHolds = new PayConfirmHolds(() => now());

  const finishPay = (
    res: ServerResponse,
    status: number,
    outcome: PayConfirmOutcome,
    extra: Record<string, unknown> = {},
  ): void => {
    // Fixed values only in the event: never the challenge, statement, assertion or code (I-7).
    emit({ kind: 'pay_confirm', outcome });
    sendJson(res, status, { status: outcome, ...extra });
  };

  /** The policy in force, or undefined when it fails closed or cannot be read (fail closed). */
  const policyInForce = async (): Promise<{ policy: unknown; version: number } | undefined> => {
    const client = agentUi?.client;
    if (client === undefined) return undefined;
    try {
      const effective = await client.ownerActions.loadPolicy();
      if (effective.mode === 'fail_closed') return undefined;
      return {
        policy: effective.policy,
        version: effective.mode === 'signed' ? effective.version : 0,
      };
    } catch {
      return undefined;
    }
  };

  /**
   * 04 §2.5.3: refuses, before anything is signed, an ordinary owner route's object that only the
   * confirmation may sign: a `policy.set` that changes a spending field (or cannot be compared with
   * the policy in force), and an approval of a request that carries a fee.
   */
  const refuseUnconfirmedPaid = async (frozen: readonly OwnerSignRequest[]): Promise<void> => {
    for (const request of frozen) {
      if (request.kind !== 'owner-action') continue;
      const op = request.action['op'];
      if (op === 'policy.set') {
        const current = await policyInForce();
        const changes =
          current === undefined
            ? 'invalid'
            : policySetSpendingChanges(current.policy, request.action);
        if (changes === 'invalid' || changes.length > 0) throw new ConfirmRequired();
      } else if (op === 'approval.decide' || op === 'approval.decideBatch') {
        const params = request.action['params'] as Record<string, unknown> | undefined;
        const items: unknown[] =
          op === 'approval.decide'
            ? [params]
            : Array.isArray(params?.['items'])
              ? (params['items'] as unknown[])
              : [];
        for (const item of items) {
          const fields = (item ?? {}) as Record<string, unknown>;
          if (op === 'approval.decide' && fields['decision'] !== 'approve') continue;
          const approvalId = fields['approvalId'];
          const entry = typeof approvalId === 'string' ? await source.get(approvalId) : undefined;
          if (entry === undefined || isPaidPendingAction(entry.action)) {
            throw new ConfirmRequired();
          }
        }
      }
    }
  };

  /** The flow a begin builds, or a fixed refusal. Every value comes from the store (I-5). */
  type BuiltFlow =
    | {
        readonly target: PayConfirmTarget;
        readonly flow: PayConfirmFlow;
        readonly requests: readonly OwnerSignRequest[];
      }
    | PayConfirmOutcome;

  /** A proof approval's flow from the live pending request (rule 2). */
  const proofFlow = async (
    approvalId: string,
    context: ApprovalContext,
    decideBody?: JsonObject,
  ): Promise<BuiltFlow> => {
    const entry = await source.get(approvalId);
    if (entry === undefined || entry.approvalId !== approvalId || decided.has(approvalId)) {
      return 'not_pending';
    }
    let recomputed: string;
    try {
      recomputed = encodeHex(sha256(canonicalizeToBytes(entry.action)));
    } catch {
      return 'changed';
    }
    if (recomputed !== entry.storedDigest) return 'changed';
    if (!isPaidPendingAction(entry.action)) return 'not_paid';
    const facts = (entry.action as Record<string, unknown> | null)?.['context'];
    const counterparty =
      typeof facts === 'object' && facts !== null
        ? (facts as Record<string, unknown>)['counterparty']
        : undefined;
    const hasCounterparty = typeof counterparty === 'object' && counterparty !== null;
    // The 11 §5.2 name the core built from the stored contact (never inbound text).
    const who = entry.details?.who;
    if (hasCounterparty && (who === undefined || who.length === 0)) return 'refused';
    let flow: PayConfirmFlow;
    try {
      flow = buildPayConfirmFlow({
        kind: 'proof',
        pendingAction: entry.action,
        counterpartyName: hasCounterparty ? (who as string) : null,
      });
    } catch (error) {
      return error instanceof PayConfirmError && error.reason === 'not_paid'
        ? 'not_paid'
        : 'refused';
    }
    let body = decideBody;
    if (body === undefined) {
      try {
        body = buildApprovalOperation(
          context,
          [
            {
              approvalId,
              action: entry.action,
              storedDigest: entry.storedDigest,
              decision: 'approve',
              commitment: entry.commitment,
              summary: entry.summary,
              requestExpiresAt: entry.expiresAt,
            },
          ],
          { nowSeconds: () => Math.floor(now() / 1000) },
        ).body;
      } catch {
        return 'changed';
      }
    }
    return {
      target: { kind: 'proof', approvalId, remember: false },
      flow,
      requests: [{ kind: 'owner-action', action: body }],
    };
  };

  /**
   * M1-PAY-CONFIRM-b: "Remember for this contact" (06 §3; 04 §2.5.3 rule 2): the proof approval
   * and the contact's proof rule in one gesture. The rule comes from core `rememberContactRules`
   * over the policy in force and the stored request, never from the page; core prepares the
   * complete unsigned `policy.set` and `buildPayConfirmFlow` checks it changes nothing else. At
   * finish (`signed`) the held bodies are checked against the policy and request as they are now.
   */
  const rememberFlow = async (
    approvalId: string,
    context: ApprovalContext,
    signed?: readonly OwnerSignRequest[],
  ): Promise<BuiltFlow> => {
    const decide = signed?.[0];
    const plain = await proofFlow(
      approvalId,
      context,
      decide?.kind === 'owner-action' ? decide.action : undefined,
    );
    if (typeof plain === 'string') return plain;
    const entry = await source.get(approvalId);
    const current = await policyInForce();
    if (entry === undefined) return 'not_pending';
    if (current === undefined) return 'refused';
    let rules: ReturnType<typeof rememberContactRules>;
    try {
      rules = rememberContactRules(current.policy as never, entry.action);
    } catch {
      return 'refused';
    }
    if (rules === null) return 'not_offered';
    let policySet: JsonObject;
    if (signed !== undefined) {
      const held = signed[1];
      if (held?.kind !== 'owner-action') return 'changed';
      policySet = held.action;
    } else {
      const client = agentUi?.client;
      if (client === undefined) return 'refused';
      let prepared: Awaited<ReturnType<typeof client.ownerActions.preparePolicyEdit>>;
      try {
        prepared = await client.ownerActions.preparePolicyEdit(
          { contactRules: rules },
          { baseVersion: current.version },
        );
      } catch {
        return 'refused';
      }
      if (prepared.status !== 'prepared') {
        return prepared.reason === 'stale_version' ? 'changed' : 'refused';
      }
      // D-109: receipts on from an older default are a question only the Rules page asks.
      if (prepared.askKeepDeliveryReceipts) return 'not_offered';
      policySet = prepared.body as unknown as JsonObject;
    }
    let flow: PayConfirmFlow;
    try {
      flow = buildPayConfirmFlow({
        kind: 'proof_remember',
        pendingAction: entry.action,
        counterpartyName: plain.flow.statement.counterparty,
        before: current.policy as never,
        policySet,
      });
    } catch (error) {
      if (signed !== undefined) return 'changed';
      return error instanceof PayConfirmError && error.reason === 'remember_not_offered'
        ? 'not_offered'
        : 'refused';
    }
    const decideRequest = plain.requests[0];
    if (decideRequest === undefined) return 'refused';
    return {
      target: { kind: 'proof', approvalId, remember: true },
      flow,
      requests: [decideRequest, { kind: 'owner-action', action: policySet }],
    };
  };

  /** M1-PAY-CONFIRM-b: whether the sheet may offer "Remember for this contact" for a request. */
  const rememberOffered = async (approvalId: string): Promise<boolean> => {
    try {
      const entry = await source.get(approvalId);
      const current = await policyInForce();
      if (entry === undefined || current === undefined) return false;
      return rememberContactRules(current.policy as never, entry.action) !== null;
    } catch {
      return false;
    }
  };

  /** A limits change's flow from the policy in force and the body the page reviewed. */
  const limitsFlow = async (
    policySet: JsonObject,
    keepDeliveryReceipts: boolean,
  ): Promise<BuiltFlow> => {
    const current = await policyInForce();
    if (current === undefined) return 'refused';
    let flow: PayConfirmFlow;
    try {
      flow = buildPayConfirmFlow({
        kind: 'limits',
        before: current.policy as never,
        policySet,
      });
    } catch (error) {
      return error instanceof PayConfirmError && error.reason === 'no_spending_change'
        ? 'not_paid'
        : 'refused';
    }
    const params = policySet['params'] as Record<string, unknown> | undefined;
    const version = typeof params?.['version'] === 'number' ? params['version'] : -1;
    return {
      target: { kind: 'limits', version, keepDeliveryReceipts },
      flow,
      requests: [{ kind: 'owner-action', action: policySet }],
    };
  };

  const onlyKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((k) => keys.includes(k));

  /** Begin: the input names the flow only; the statement is built here from stored data. */
  const buildBegin = async (
    input: JsonValue | undefined,
    context: ApprovalContext,
  ): Promise<BuiltFlow> => {
    if (onlyKeys(input, ['flow', 'approvalId', 'remember']) && input['flow'] === 'proof') {
      const approvalId = input['approvalId'];
      if (typeof approvalId !== 'string' || !APPROVAL_ID.test(approvalId)) return 'invalid';
      // M1-PAY-CONFIRM-b: "Remember for this contact" is asked for with exactly `true`.
      const remember = input['remember'];
      if (remember !== undefined && remember !== true) return 'invalid';
      return remember === true ? rememberFlow(approvalId, context) : proofFlow(approvalId, context);
    }
    if (onlyKeys(input, ['flow', 'review', 'acknowledged']) && input['flow'] === 'limits') {
      const reviewed = takeReviewedRules(uiContext, input['review'], input['acknowledged']);
      if (reviewed === undefined) return 'not_pending';
      return limitsFlow(reviewed.body, reviewed.keepDeliveryReceipts);
    }
    return 'invalid';
  };

  /** Rule 3: the flow rebuilt from the store now, for comparison with the hold. */
  const rebuild = async (hold: PayConfirmHold, context: ApprovalContext): Promise<BuiltFlow> => {
    const signed = hold.requests[0];
    if (signed?.kind !== 'owner-action') return 'changed';
    if (hold.target.kind === 'proof') {
      return hold.target.remember
        ? rememberFlow(hold.target.approvalId, context, hold.requests)
        : proofFlow(hold.target.approvalId, context, signed.action);
    }
    return limitsFlow(signed.action, hold.target.keepDeliveryReceipts);
  };

  async function payConfirmGate(
    req: IncomingMessage,
    res: ServerResponse,
    step: LocalUiPayConfirmStep,
    cookie: string,
  ): Promise<void> {
    const wait = waitSeconds();
    if (wait > 0) {
      req.resume();
      res.setHeader('Retry-After', String(wait));
      finishPay(res, 429, 'wait', { retryAfter: wait });
      return;
    }
    const input = operationInput(req);
    const mode = header(req, 'x-agentlink-presence');
    const passkey = mode === 'passkey';
    if (input === 'invalid' || (mode !== undefined && !passkey)) {
      req.resume();
      finishPay(res, 400, 'invalid');
      return;
    }
    const body = await boundedBody(
      req,
      res,
      passkey ? MAX_PAY_CONFIRM_ASSERTION_BYTES : MAX_SECRET_BYTES,
    );
    if (body === undefined) return;
    try {
      payHolds.sweep((held) => sessions.some((s) => equalBytes(s, held)));
      const sessionAt = matchIndex(cookie, sessions);
      if (sessionAt < 0) {
        finishPay(res, 409, 'unknown');
        return;
      }
      const session = sessions[sessionAt] as Uint8Array;
      if (!stillCurrent(req)) {
        agentChanged(res);
        return;
      }
      if (step === 'begin') await payBegin(res, input, body, session, passkey);
      else await payFinish(res, input, body, session, passkey);
    } finally {
      wipe(body);
    }
  }

  async function payBegin(
    res: ServerResponse,
    input: JsonValue | undefined,
    body: Uint8Array,
    session: Uint8Array,
    passkey: boolean,
  ): Promise<void> {
    if (body.length !== 0 || passkey) {
      finishPay(res, 400, 'invalid');
      return;
    }
    if (busy) {
      finishPay(res, 409, 'busy');
      return;
    }
    busy = true;
    try {
      const context = await source.context();
      if (context === undefined) {
        finishPay(res, 503, 'needs_setup');
        return;
      }
      const built = await buildBegin(input, context);
      if (typeof built === 'string') {
        finishPay(res, built === 'invalid' ? 400 : 409, built);
        return;
      }
      const hold = payHolds.begin(session, built.target, built.flow, built.requests);
      // Rule 5: the passkey is offered only when its credential key is kept; otherwise the page
      // offers the backup code (and setting the passkey up again).
      let credentialId: string | undefined;
      try {
        const stored = await readOwnerPasskeyHeader(keychainOf());
        if (
          stored !== null &&
          (await readOwnerPasskeyKey(keychainOf(), stored.credentialId)) !== null
        ) {
          credentialId = encodeBase64url(stored.credentialId);
        }
      } catch {
        credentialId = undefined;
      }
      finishPay(res, 200, 'ready', {
        ceremony: hold.id,
        statement: hold.statement as unknown as JsonValue,
        // M1-PAY-CONFIRM-b: the sheet offers "Remember for this contact" only when core would.
        ...(built.target.kind === 'proof'
          ? {
              rememberOffered:
                built.target.remember || (await rememberOffered(built.target.approvalId)),
            }
          : {}),
        expiresInMs: PAY_CONFIRM_TTL_MS,
        publicKey: {
          rpId: PASSKEY_RP_ID,
          challenge: encodeBase64url(hold.challenge),
          allowCredentials: credentialId === undefined ? [] : [credentialId],
          userVerification: 'required',
          timeoutMs: PAY_CONFIRM_TTL_MS,
          prfSalt: encodeBase64url(ownerPrfSalt()),
        },
      });
    } catch {
      finishPay(res, 500, 'failed');
    } finally {
      busy = false;
    }
  }

  async function payFinish(
    res: ServerResponse,
    input: JsonValue | undefined,
    body: Uint8Array,
    session: Uint8Array,
    passkey: boolean,
  ): Promise<void> {
    if (!onlyKeys(input, ['ceremony']) || typeof input['ceremony'] !== 'string') {
      finishPay(res, 400, 'invalid');
      return;
    }
    if (body.length === 0) {
      finishPay(res, 403, 'presence_required');
      return;
    }
    if (busy) {
      finishPay(res, 409, 'busy');
      return;
    }
    // A passkey finish takes the hold before any await: single use, whatever happens below.
    const found = payHolds.get(input['ceremony'], session, passkey);
    if (found === 'unknown' || found === 'expired') {
      finishPay(res, 409, found);
      return;
    }
    const hold = found;
    let assertion: PayConfirmAssertion | undefined;
    let consumed = passkey;
    busy = true;
    try {
      if (passkey) {
        assertion = parsePayConfirmAssertion(body);
        if (assertion === undefined) {
          finishPay(res, 403, 'presence_required');
          return;
        }
      }
      const context = await source.context();
      if (context === undefined) {
        finishPay(res, 503, 'needs_setup');
        return;
      }
      // Rule 3: anything changed since begin (fee, limit, contact, expiry) needs a new begin.
      const current = await rebuild(hold, context);
      if (typeof current === 'string' || !PayConfirmHolds.sameFlow(hold, current.flow)) {
        payHolds.drop(hold.id);
        consumed = true;
        finishPay(res, 409, 'changed');
        return;
      }
      let presence: OwnerPresence;
      if (assertion !== undefined) {
        let check: ReturnType<typeof checkPayConfirmAssertion> = 'presence_rejected';
        try {
          const stored = await readOwnerPasskeyHeader(keychainOf());
          if (stored !== null) {
            check = checkPayConfirmAssertion(assertion, {
              challenge: hold.challenge,
              origin,
              passkey: stored,
              publicKey: await readOwnerPasskeyKey(keychainOf(), stored.credentialId),
              owner: context.owner,
            });
          }
        } catch {
          check = 'presence_rejected';
        }
        if (check === 'verification_required') {
          finishPay(res, 403, 'verification_required');
          return;
        }
        if (check === 'key_missing') {
          // Rule 5: this passkey has no stored key; the backup code (or setting it up again) works.
          finishPay(res, 409, 'passkey_update_needed');
          return;
        }
        if (check !== 'ok') {
          presenceFailed();
          finishPay(res, 403, 'presence_rejected');
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
        finishPay(res, 503, 'needs_setup');
        return;
      }
      let signatures: Awaited<ReturnType<typeof signGesture>>;
      try {
        let ownerSession: OwnerSession;
        try {
          // unlock wipes the presented bytes, whether or not they unlock.
          ownerSession = await store.unlock(presence, { ttlMs: OWNER_SESSION_DEFAULT_TTL_MS });
        } catch (error) {
          if (error instanceof KeyStoreError && error.code === 'presence_rejected') {
            presenceFailed();
            if (!passkey && payHolds.backupFailed(hold)) {
              consumed = true;
              finishPay(res, 403, 'tries_exhausted');
            } else {
              finishPay(res, 403, 'presence_rejected');
            }
          } else {
            finishPay(res, 500, 'failed');
          }
          return;
        }
        presenceSucceeded();
        if (!passkey) {
          payHolds.get(hold.id, session, true);
          consumed = true;
        }
        try {
          // Rule 3: exactly the objects frozen at begin; nothing from this request.
          signatures = await signGesture(ownerSession, hold.requests);
        } finally {
          await ownerSession.close().catch(() => undefined);
        }
      } finally {
        await store.lock().catch(() => undefined);
        await store.close().catch(() => undefined);
      }
      let applied = true;
      for (const signature of signatures) {
        if (signature.kind !== 'owner-action') {
          applied = false;
          continue;
        }
        const outcome = await source.apply(signature.signed);
        if (outcome.status !== 'applied') applied = false;
      }
      if (!applied) {
        finishPay(res, 409, 'refused');
        return;
      }
      if (hold.target.kind === 'proof') decided.add(hold.target.approvalId);
      else if (hold.target.keepDeliveryReceipts) {
        await agentUi?.client?.ownerActions
          .recordReceiptsKept(hold.target.version)
          .catch(() => false);
      }
      emit({ kind: 'owner_operation', outcome: 'done' });
      finishPay(res, 200, 'applied');
    } catch {
      finishPay(res, 500, 'failed');
    } finally {
      busy = false;
      if (consumed) PayConfirmHolds.wipe(hold);
      if (assertion !== undefined) {
        wipe(
          assertion.prfOutput,
          assertion.clientDataJSON,
          assertion.signature,
          assertion.authenticatorData,
        );
      }
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
    // U3-g-b: the generation and label as they are now (first run may have opened the first agent).
    stamp(res);
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
    const setup = agentUi?.ownerSetup;
    const firstRun = setup === undefined ? noAgentFirstRun() : undefined;
    let ownerElsewhere: boolean;
    try {
      ownerElsewhere =
        setup !== undefined
          ? await ownerExistsAnywhere(setup)
          : firstRun === undefined || (await ownerExistsFor({ kind: 'first', firstRun }));
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
   * U3-g-b: true when setup must be refused for `target`: for the open agent, ownerExistsAnywhere;
   * with no agent yet, when any agent folder is listed (even one being removed) or any owner item,
   * owner file or agent folder exists (noOwnerAndNoAgent). Rejects on errors (callers fail closed).
   */
  const ownerExistsFor = async (target: SetupTarget): Promise<boolean> => {
    if (target.kind === 'agent') return ownerExistsAnywhere(target.setup);
    const slot = host;
    if (slot === undefined || slot.current !== undefined) return true;
    if ((await slot.directory.list()).length > 0) return true;
    return !(await noOwnerAndNoAgent(keychainOf(), target.firstRun.ownerFiles));
  };

  /**
   * U3-g-b: creates the first agent (AgentDirectory `create`, a keychain agent in the new folder
   * `default`, FIRST_AGENT_NAME) and opens it for its first parts only. Undefined, with nothing left behind,
   * when it cannot be created or opened or has no first card.
   */
  const createFirstAgent = async (label: string): Promise<AppHostAgent | undefined> => {
    const slot = host;
    const directory = slot?.directory;
    if (slot === undefined || directory?.create === undefined) return undefined;
    let name: string;
    try {
      name = await directory.create(label, { name: FIRST_AGENT_NAME });
    } catch {
      return undefined;
    }
    if (name !== FIRST_AGENT_NAME) {
      await directory.discardNew?.(name).catch(() => undefined);
      return undefined;
    }
    const opened = await slot.openNew(name);
    if (opened === undefined || opened.name !== name || opened.firstCard === undefined) {
      await opened?.close().catch(() => undefined);
      await directory.discardNew?.(name).catch(() => undefined);
      return undefined;
    }
    return opened;
  };

  /**
   * U3-g-b: with no agent open, true when first run cannot set up an owner here (an owner or any
   * agent folder exists): `GET /api/ui/first-run` then answers `set_up`. Rejects on errors.
   */
  const setupBlockedNoAgent = async (): Promise<boolean> => {
    const firstRun = noAgentFirstRun();
    return firstRun === undefined || (await ownerExistsFor({ kind: 'first', firstRun }));
  };

  /** U3-d: the setup's first card with its first label, when `begin` was given one. */
  const withFirstLabel = (first: FirstAgentCard, label: string | undefined): FirstAgentCard => {
    const actions = labelActionsOf(first.firstPolicy?.actions);
    if (label === undefined || actions === undefined) return first;
    return { ...first, firstLabel: { label, actions } };
  };

  /** U3-d: after a verified first label at setup, the open agent's config.json label (app host). */
  const labelSavedForOpen = async (label: string): Promise<void> => {
    const slot = host;
    const name = slot?.current;
    if (slot === undefined || name === undefined) return;
    agentLabel = label;
    await slot.directory.writeLabel(name, label).catch(() => undefined);
  };

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
    // U3-g-b: the open agent's setup, else first run with no agent yet (the host's firstRun).
    const setup = agentUi?.ownerSetup;
    const firstRun = setup === undefined ? noAgentFirstRun() : undefined;
    let target: SetupTarget;
    if (setup !== undefined) target = { kind: 'agent', setup };
    else if (firstRun !== undefined) target = { kind: 'first', firstRun };
    else {
      req.resume();
      finishSetup(res, 503, 'unavailable');
      return;
    }
    // U3-d (08 §1 first run v3): `begin` and `finish` may carry `{label}` as the operation input.
    const given = setupLabel(req);
    if (given === 'invalid' || given === 'label_invalid') {
      req.resume();
      finishSetup(res, 400, given);
      return;
    }
    // U3-g-b: the first agent always gets a label (b11 §28 prefills it; a page without one gets it).
    const label = given ?? (target.kind === 'first' ? FIRST_AGENT_LABEL : undefined);
    const body = await boundedBody(req, res, MAX_SETUP_REGISTRATION_BYTES);
    if (body === undefined) return;
    try {
      if (!stillCurrent(req)) {
        agentChanged(res);
        return;
      }
      if (step === 'begin') await setupBegin(res, body, cookie, target, label);
      else await setupFinish(req, res, body, cookie, target, label);
    } finally {
      wipe(body);
    }
  }

  /**
   * U3-d: the setup steps' label: absent (no input), exactly `{"label": <text>}` under the 06 §6
   * label rule, or a fixed refusal (`invalid` for any other input, `label_invalid` for a label core
   * would not sign). The label is never logged or echoed.
   */
  function setupLabel(req: IncomingMessage): string | undefined | 'invalid' | 'label_invalid' {
    const input = operationInput(req);
    if (input === undefined) return undefined;
    if (
      input === 'invalid' ||
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input)
    ) {
      return 'invalid';
    }
    const keys = Object.keys(input);
    if (keys.length !== 1 || keys[0] !== 'label') return 'invalid';
    const label = (input as { label?: unknown }).label;
    return isAgentLabelText(label) ? label : 'label_invalid';
  }

  async function setupBegin(
    res: ServerResponse,
    body: Uint8Array,
    cookie: string,
    target: SetupTarget,
    label: string | undefined,
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
        exists = await ownerExistsFor(target);
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
      // U3-g-b: the first agent always gets its first policy (newAgentFirstCard), so its folders too.
      const firstPolicy =
        target.kind === 'agent'
          ? target.setup.firstCard.firstPolicy
          : { home: target.firstRun.home };
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
        ...(label === undefined ? {} : { label }),
        ...(target.kind === 'first' ? { noAgent: true as const } : {}),
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
    req: IncomingMessage,
    res: ServerResponse,
    body: Uint8Array,
    cookie: string,
    target: SetupTarget,
    label: string | undefined,
  ): Promise<void> {
    const held = pendingSetup;
    // Bound to its session: another session neither finishes nor consumes it. U3-g-b: and to its
    // kind (begun with no agent yet, or for the open agent).
    if (
      held === undefined ||
      !matches(cookie, held.session) ||
      (held.noAgent === true) !== (target.kind === 'first')
    ) {
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
    // U3-g-b: the first agent this run created (no agent yet), until it is settled.
    let created: AppHostAgent | undefined;
    /**
     * Removes the folders this run created (unless kept): directly once the owner is this run's;
     * before that, only while no owner exists anywhere (releaseFolders, L-1 cross-process).
     * U3-g-b: a first agent this run created goes first when no owner was made (all or nothing).
     */
    const release = async (): Promise<void> => {
      const agent = created;
      created = undefined;
      if (agent !== undefined) {
        await agent.close().catch(() => undefined);
        if (!ownerIsOurs) await host?.directory.discardNew?.(agent.name).catch(() => undefined);
      }
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
      // U3-d: the label signed is the one `begin` was given and the page still shows.
      if (label !== held.label) {
        await answer(res, 400, 'label_invalid');
        return;
      }
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
      let setup: LocalUiOwnerSetupOption;
      if (target.kind === 'agent') setup = target.setup;
      else {
        // U3-g-b: with no agent yet, the agent is created only now, after the gesture was checked
        // and while still no owner and no agent exists; on any failure below it goes again.
        let none: boolean;
        try {
          none = !(await ownerExistsFor(target));
        } catch {
          await answer(res, 500, 'failed', {}, { reason: 'check_failed' });
          return;
        }
        if (!none) {
          await answer(res, 409, 'owner_exists');
          return;
        }
        created = await createFirstAgent(held.label ?? FIRST_AGENT_LABEL);
        const firstCard = created?.firstCard;
        if (created === undefined || firstCard === undefined) {
          await answer(res, 500, 'failed', {}, { reason: 'internal' });
          return;
        }
        setup = {
          firstCard,
          ...(target.firstRun.ownerFiles === undefined
            ? {}
            : { ownerFiles: target.firstRun.ownerFiles }),
        };
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
            authenticatorData: registration.authenticatorData,
            // U3-d-b: the first agent always gets its first label (the typed one, else the
            // prefilled FIRST_AGENT_LABEL its folder was created with), so its card is never
            // named after the folder `default`.
            firstCard: withFirstLabel(
              setup.firstCard,
              held.label ?? (created === undefined ? undefined : FIRST_AGENT_LABEL),
            ),
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
        // U3-d: config.json's label (display only, 07 §9.1) after core applied the signed one.
        const first = created;
        if (first !== undefined) {
          // U3-g-b: the first agent's label, then it is closed and opened as the host's agent.
          if (result.label === 'saved' && held.label !== undefined) {
            await host?.directory.writeLabel(first.name, held.label).catch(() => undefined);
          }
          created = undefined;
          await first.close().catch(() => undefined);
          const adopted = (await host?.adoptFirst(first.name, requestHolds.get(req))) === true;
          // The answer names the agent now open, with the new generation (stamped below).
          await labelReady;
          // IR-U3-g-b-1 H-1: the one answer whose new generation the page adopts instead of
          // reloading (apps/local-ui generation.ts accepts it only on a 200 finish), so the one-time
          // backup code stays on screen. Set nowhere else.
          if (adopted) res.setHeader(GENERATION_ADOPTED_HEADER, '1');
        } else if (result.label === 'saved' && held.label !== undefined) {
          await labelSavedForOpen(held.label);
        }
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
            ...(result.label === undefined ? {} : { label: result.label }),
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

  /**
   * MSG-FILES-IO-h (D-134): the gate of the one reveal route (Show in Finder). The caller checked the
   * session, CSRF, Origin, fetch metadata and the octet-stream type. The request carries only the
   * item ID: the body must be exactly `{"id":"<envelopeId>.<idx>"}` (strict JSON, no other member),
   * with no query, no operation input and no presence header; anything else is 400 `invalid` before
   * the store is read. No owner presence, no owner store, no signing. The handler gets the checked
   * ID and the checked reveal only; nothing here logs the ID, a name or a path.
   */
  async function revealGate(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    route: LocalUiRevealRoute,
  ): Promise<void> {
    const invalid = (): void => {
      sendJson(res, 400, { error: 'invalid' });
    };
    if (
      url.search !== '' ||
      header(req, 'x-agentlink-input') !== undefined ||
      header(req, 'x-agentlink-presence') !== undefined
    ) {
      req.resume();
      invalid();
      return;
    }
    const body = await boundedBody(req, res, MAX_REVEAL_BODY_BYTES);
    if (body === undefined) return;
    let id: unknown;
    try {
      const parsed = parseJson(decodeUtf8(body));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      const keys = Object.keys(parsed);
      if (keys.length !== 1 || keys[0] !== 'id') throw new Error();
      id = (parsed as { id?: unknown }).id;
    } catch {
      invalid();
      return;
    }
    if (typeof id !== 'string' || !REVEAL_ITEM_ID.test(id)) {
      invalid();
      return;
    }
    if (!stillCurrent(req)) {
      agentChanged(res);
      return;
    }
    let result: LocalUiResult;
    try {
      result = await route.handler(uiContext, id, revealFile);
    } catch {
      sendJson(res, 500, { status: 'failed' });
      return;
    }
    sendResult(res, result);
  }

  /**
   * UX2-d1 (owner decision 1.1): the gate of the two invite-kind routes (create, check). The caller
   * checked the session, CSRF, Origin, fetch metadata and the octet-stream type. No query, operation
   * input or presence header; create is rate-limited before the body is read; the body must be one
   * strict JSON object. No owner presence, no owner store, nothing signed. The handler gets that
   * object and the invite desk only. The body is wiped afterwards (a pasted link holds the invite
   * secret); nothing here logs it, and an error answers a fixed code (I-7).
   */
  async function inviteGate(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    route: LocalUiInviteRoute,
  ): Promise<void> {
    if (
      url.search !== '' ||
      header(req, 'x-agentlink-input') !== undefined ||
      header(req, 'x-agentlink-presence') !== undefined
    ) {
      req.resume();
      sendJson(res, 400, { error: 'invalid' });
      return;
    }
    if (route.step === 'create') {
      const at = now();
      while (
        invitesCreated.length > 0 &&
        (invitesCreated[0] as number) <= at - INVITE_CREATE_WINDOW_MS
      ) {
        invitesCreated.shift();
      }
      if (invitesCreated.length >= INVITE_CREATE_LIMIT) {
        const oldest = invitesCreated[0] as number;
        const retryAfter = Math.max(1, Math.ceil((oldest + INVITE_CREATE_WINDOW_MS - at) / 1000));
        req.resume();
        res.setHeader('Retry-After', String(retryAfter));
        sendJson(res, 429, { error: 'wait', retryAfter });
        return;
      }
    }
    const body = await boundedBody(
      req,
      res,
      // U3-invite: "Not now" carries `{}` only, as small as create.
      route.step === 'check' ? MAX_INVITE_CHECK_BODY_BYTES : MAX_INVITE_CREATE_BODY_BYTES,
    );
    if (body === undefined) return;
    try {
      let parsed: JsonValue;
      try {
        parsed = parseJson(decodeUtf8(body));
      } catch {
        sendJson(res, 400, { error: 'invalid' });
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        sendJson(res, 400, { error: 'invalid' });
        return;
      }
      if (!stillCurrent(req)) {
        agentChanged(res);
        return;
      }
      if (route.step === 'create') invitesCreated.push(now());
      let result: LocalUiResult;
      try {
        result = await route.handler(uiContext, parsed as JsonObject, invitesDesk);
      } catch {
        sendJson(res, 500, { status: 'failed' });
        return;
      }
      sendResult(res, result);
    } finally {
      wipe(body);
    }
  }

  /**
   * U3-invite (08 §4): opens the join screen through the OS opener, or first run while no owner
   * exists (it ends on the join screen). A fixed path and a one-shot session link; the invite is
   * never in it. At most one open per JOIN_OPEN_INTERVAL_MS for a handoff (`limited`).
   */
  async function openJoinPage(limited: boolean): Promise<boolean> {
    if (limited) {
      if (now() - lastJoinOpenAt < JOIN_OPEN_INTERVAL_MS) return false;
      lastJoinOpenAt = now();
    }
    const path = (await ownerExistsNow()) ? JOIN_PAGE_PATH : '/first-run';
    return opener(`${origin}${path}?t=${mintLink()}`).catch(() => false);
  }

  /**
   * U3-invite (IR-U3-invite-2): whether an owner EXISTS on this computer, for where the join screen
   * opens: with none yet, first run (Welcome) runs first and ends on the waiting invite. An open
   * agent with an owner setup to do, or no agent open with first run still possible, means no owner
   * yet; any error means the owner is assumed to exist (the join screen, which says what to do).
   */
  async function ownerExistsNow(): Promise<boolean> {
    try {
      const setup = agentUi?.ownerSetup;
      if (setup !== undefined) return await ownerExistsAnywhere(setup);
      if (host !== undefined && host.current === undefined && noAgentFirstRun() !== undefined) {
        return await setupBlockedNoAgent();
      }
      return true;
    } catch {
      return true;
    }
  }

  /**
   * U3-invite (08 §4 "An app host already running"): `POST /api/ui/join/handoff` from `agentlink
   * join`, the handoff kind. Run before the session gate: the caller is a local process with the
   * handoff token from the 0600 record, never the page. It refuses an Origin, any Sec-Fetch-*
   * header, a cookie, a CSRF value, an operation input, a presence header and a query; takes at most
   * one handoff per HANDOFF_INTERVAL_MS (counted before the token is checked, so the token cannot be
   * guessed quickly); compares the token in constant time; parses exactly `{"invite":"<link>"}`; and
   * hands the link to the join desk, which runs Accept step 1 and stores it in memory. Nothing is
   * signed, written or logged; the body is wiped. The token grants nothing else.
   */
  async function handoffGate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const refuse = (status: number, error: string): void => {
      req.resume();
      emit({ kind: 'rejected', reason: 'handoff' });
      sendJson(res, status, { error });
    };
    if (joinDesk === undefined || handoffBytes === undefined) return refuse(501, 'not_available');
    if (
      header(req, 'origin') !== undefined ||
      Object.keys(req.headers).some((name) => name.startsWith('sec-fetch-')) ||
      header(req, 'cookie') !== undefined ||
      header(req, 'x-agentlink-csrf') !== undefined ||
      header(req, 'x-agentlink-input') !== undefined ||
      header(req, 'x-agentlink-presence') !== undefined ||
      header(req, 'x-agentlink-generation') !== undefined
    ) {
      return refuse(403, 'refused');
    }
    if (url.search !== '') return refuse(400, 'invalid');
    const type = (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/octet-stream') return refuse(415, 'content_type');
    const at = now();
    if (at - lastHandoffAt < HANDOFF_INTERVAL_MS) {
      const retryAfter = Math.max(1, Math.ceil((lastHandoffAt + HANDOFF_INTERVAL_MS - at) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return refuse(429, 'wait');
    }
    lastHandoffAt = at;
    if (!matches(header(req, HANDOFF_HEADER), handoffBytes)) return refuse(401, 'refused');
    const body = await boundedBody(req, res, MAX_INVITE_CHECK_BODY_BYTES);
    if (body === undefined) return;
    let link: unknown;
    try {
      let parsed: JsonValue;
      try {
        parsed = parseJson(decodeUtf8(body));
      } catch {
        sendJson(res, 400, { error: 'invalid' });
        return;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 1 ||
        !('invite' in parsed)
      ) {
        sendJson(res, 400, { error: 'invalid' });
        return;
      }
      link = (parsed as JsonObject)['invite'];
    } finally {
      wipe(body);
    }
    const offered = await joinDesk.offer(link);
    if (offered === 'invite_waiting') return refuse(409, 'invite_waiting');
    if (offered === 'expired') return refuse(400, 'expired');
    if (offered !== 'stored') return refuse(400, 'invalid_invite');
    const opened = await openJoinPage(true);
    sendJson(res, 200, { status: 'waiting', opened });
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
    if (found.route.presence === 'handoff') {
      // U3-invite: a local process (`agentlink join`), never the page: its own gate, before the
      // session gate; it refuses a session, a cookie, an Origin and fetch metadata (08 §4).
      await handoffGate(req, res, url);
      return;
    }
    const cookie = cookieToken(req);
    if (matchIndex(cookie, sessions) < 0) return fail(401, 'token');
    if (!fetchSiteOk(req)) return fail(403, 'fetch_site');
    const { route, params } = found;
    if (route.presence && originHeader === undefined) return fail(403, 'origin');
    if (!matches(header(req, 'x-agentlink-csrf'), csrfBytes)) return fail(403, 'csrf');
    if (!route.presence) {
      req.resume();
      // U3-c: a read waits for a switch in progress and keeps the agent open while it runs.
      const hold = host === undefined ? undefined : await host.enter();
      try {
        // U3-g-b: with no agent open, only the setup-time reads answer.
        if (noAgentRefused(route)) {
          noAgent(res);
          return;
        }
        stamp(res);
        sendResult(res, await route.handler(uiContext, { params, query: url.searchParams }));
      } finally {
        hold?.leave();
      }
      // U3-invite-b (Decision 37): a page is visible and reading; maybe one host pass after it.
      hostTick();
      return;
    }
    const type = (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/octet-stream') return fail(415, 'content_type');
    if (route.presence === 'switch') {
      // U3-c: switching the open agent has its own gate; it carries the generation in its body.
      await switchGate(req, res, url);
      return;
    }
    // U3-c: the generation, before any presence check; held until the request is answered.
    const hold = mutatingHold(req, res);
    if (hold === false) return;
    try {
      // U3-g-b: with no agent open, only first run's setup steps run (after the generation check).
      if (noAgentRefused(route)) {
        req.resume();
        noAgent(res);
        return;
      }
      await ownerRoute(req, res, url, route, params, cookie as string);
    } finally {
      hold?.leave();
    }
  }

  /** The mutating /api/ui/ routes after the generation check (handleUi). */
  async function ownerRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    route: Exclude<LocalUiRoute, LocalUiReadRoute | LocalUiSwitchRoute>,
    params: Readonly<Record<string, string>>,
    cookie: string,
  ): Promise<void> {
    if (route.presence === 'handoff') {
      // Never reached (handleUi runs the handoff gate first); fail closed.
      req.resume();
      sendResult(res, NOT_AVAILABLE);
      return;
    }
    if (route.presence === true && route.stub === true) {
      // U3-c: a reserved U3 route: refused before the presence gate; its handler never runs.
      req.resume();
      sendResult(res, NOT_AVAILABLE);
      return;
    }
    if (route.presence === 'remove') {
      // U3-e: removing an agent has its own gate around ownerGate (the folder lock, its context).
      await removeGate(req, res, url);
      return;
    }
    if (route.presence === 'reveal') {
      // MSG-FILES-IO-h: Show in Finder has its own gate; ownerGate never runs it (D-134).
      await revealGate(req, res, url, route);
      return;
    }
    if (route.presence === 'invite') {
      // UX2-d1: creating and checking an invite have their own gate; ownerGate never runs them.
      await inviteGate(req, res, url, route);
      return;
    }
    if (route.presence === 'setup') {
      // M1-11s-c: owner setup has its own gate; ownerGate never runs it.
      await setupGate(req, res, route.step, cookie);
      return;
    }
    if (route.presence === 'pay-confirm') {
      // M1-PAY-CONFIRM-a: the paid-action confirmation has its own gate (04 §2.5.3).
      await payConfirmGate(req, res, route.step, cookie);
      return;
    }
    const input = operationInput(req);
    if (input === 'invalid') {
      req.resume();
      finishOwner(res, 400, 'invalid');
      return;
    }
    if (route.precheck !== undefined) {
      // U3-invite: a read-only refusal before the presence gate (nothing opened, nothing signed).
      let refusal: LocalUiResult | undefined;
      try {
        refusal = await route.precheck(uiContext, {
          params,
          query: url.searchParams,
          ...(input === undefined ? {} : { input }),
        });
      } catch {
        refusal = { status: 500, body: { status: 'failed' } };
      }
      if (refusal !== undefined) {
        req.resume();
        sendResult(res, refusal);
        return;
      }
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
    // U3-d: the open agent's verified label is known before anything is stamped with it.
    if (host !== undefined) await labelReady;
    stamp(res);
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
      // M1-11b-2: Approvals (`/`) and one request (`/approve/<id>`) render inside the app. Where
      // the UI renders only: the session gate above, and the CSRF, Origin, fetch-metadata and
      // presence gates of the approval API below, are unchanged.
      const shell = localUi.shell;
      if (shell === undefined) {
        if (appPage) return reject(res, 404, 'not_found');
        // M1-11b-2c: no app bundle, no approval page: fixed text that points to the terminal, with
        // no script and no CSRF token (approval-pages.ts).
        sendText(res, 503, 'text/html; charset=utf-8', NO_APP_HTML);
        return;
      }
      // The token is base64url, so it needs no escaping.
      const meta =
        `<meta name="agentlink-csrf" content="${csrf}">` +
        // U3-c: the generation the page is built against (a decimal number, no escaping needed).
        (host === undefined
          ? ''
          : `<meta name="agentlink-generation" content="${String(host.generation)}">`);
      sendText(res, 200, 'text/html; charset=utf-8', `${shell.before}${meta}${shell.after}`);
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
      // U3-c: the generation, before any presence check; held until the request is answered.
      const hold = mutatingHold(req, res);
      if (hold === false) return;
      try {
        // U3-g-b: no approvals while no agent is open.
        if (noAgentOpen()) {
          req.resume();
          noAgent(res);
          return;
        }
        await approvalsPost(req, res, reviewRoute, decideMatch);
      } finally {
        hold?.leave();
      }
      return;
    }
    const hold = host === undefined ? undefined : await host.enter();
    try {
      // HOTFIX-045-TOUCHID: the passkey's public data is the owner's, not an agent's: it answers
      // with no agent open too (after the same session, fetch-metadata and CSRF gates above).
      if (noAgentOpen() && !passkeyRoute) {
        noAgent(res);
        return;
      }
      stamp(res);
      await approvalsRead(res, passkeyRoute, one);
    } finally {
      hold?.leave();
    }
  }

  /** The approval API's POSTs (handle), after the generation check. */
  async function approvalsPost(
    req: IncomingMessage,
    res: ServerResponse,
    reviewRoute: boolean,
    decideMatch: RegExpExecArray | null,
  ): Promise<void> {
    {
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
  }

  /** The approval API's reads (handle). */
  async function approvalsRead(
    res: ServerResponse,
    passkeyRoute: boolean,
    one: RegExpExecArray | null,
  ): Promise<void> {
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

  // --- U3-c: the app host (D-138; 08 §1; 04 §2.5 "Several agents in one app") -----------------

  /** Rebinds every per-agent piece to `agent` (or to none); nothing of the previous one is kept. */
  function bindAgent(agent: AppHostAgent | undefined): void {
    source = agent?.source ?? NO_AGENT_SOURCE;
    agentUi = agent?.localUi;
    // U3-d (04 §2.5.1 "Labels and AI app connections"): the open agent is named only by its
    // verified label (core re-verifies the stored `agent.label`), else by its folder name; the label
    // in config.json (`agent.label`) is display text for listed agents only.
    agentLabel = undefined;
    labelReady = refreshLabel();
    invitesDesk = agentUi?.client === undefined ? undefined : inviteDesk(agentUi.client);
    follower = followerOf(agentUi);
    uiContext = buildUiContext();
    // Approvals, a held owner setup and held paid-action confirmations belong to the old agent.
    decided.clear();
    dropSetup();
    payHolds.clear();
  }

  /** Every answer of the app host carries the generation and the open agent's label (08 §1). */
  function stamp(res: ServerResponse): void {
    if (host === undefined || res.headersSent) return;
    res.setHeader('X-AgentLink-Generation', String(host.generation));
    const label = agentLabel ?? host.current;
    // The label is the owner's plain text from config.json: percent-encoded, never raw in a header.
    if (label === undefined) res.removeHeader('X-AgentLink-Agent');
    else res.setHeader('X-AgentLink-Agent', encodeURIComponent(label));
  }

  /** 409 `agent_changed`, with the current generation, so the page reloads (08 §1). */
  function agentChanged(res: ServerResponse): void {
    stamp(res);
    sendJson(res, 409, { status: 'agent_changed' });
  }

  /**
   * U3-invite-b (06 §6, Decision 37; proposed): after a page read, one host pass for the open agent
   * when one is due (every 5 s while a pairing is pending, else every 15 s) and no other process
   * holds the lease. Not awaited by the read, but it holds the agent open like a read, so a switch
   * or removal drains it first; a pass that lost its generation never starts. Never rejects.
   */
  function hostTick(): void {
    const slot = host;
    const bound = follower;
    if (slot === undefined || bound === undefined) return;
    void (async () => {
      const hold = await slot.enter();
      try {
        if (hold.valid() && follower === bound) await bound.tick();
      } finally {
        hold.leave();
      }
    })().catch(() => undefined);
  }

  /** U3-g-b: true while the app host has no agent open (no agent yet, or a failed switch). */
  function noAgentOpen(): boolean {
    return host !== undefined && host.current === undefined;
  }

  /** U3-g-b: true when `route` is refused because no agent is open (NO_AGENT_ROUTES). */
  function noAgentRefused(route: LocalUiRoute): boolean {
    return noAgentOpen() && !NO_AGENT_ROUTES.has(`${route.method} ${route.path}`);
  }

  /** U3-g-b: 409 `no_agent`, the one fixed answer of an agent route while no agent is open. */
  function noAgent(res: ServerResponse): void {
    emit({ kind: 'rejected', reason: 'no_agent' });
    stamp(res);
    sendJson(res, 409, { status: 'no_agent' });
  }

  /**
   * U3-g-b: first run with no agent yet: the host's `firstRun`, only while no agent is open and the
   * directory can create one. Undefined otherwise (the setup steps then need the open agent's setup).
   */
  function noAgentFirstRun(): AppHostFirstRun | undefined {
    const slot = host;
    const firstRun = options.host?.firstRun;
    if (slot === undefined || firstRun === undefined || slot.current !== undefined)
      return undefined;
    if (slot.directory.create === undefined) return undefined;
    return firstRun;
  }

  /** False when the request's hold says the open agent changed since it arrived (the re-check). */
  function stillCurrent(req: IncomingMessage): boolean {
    const hold = requestHolds.get(req);
    return hold === undefined || hold.valid();
  }

  /**
   * The generation check of a mutating request (08 §1): undefined outside the app host, the hold
   * when `X-AgentLink-Generation` is the current generation, or false once 409 `agent_changed` was
   * answered.
   */
  function mutatingHold(
    req: IncomingMessage,
    res: ServerResponse,
  ): AppHostHold | undefined | false {
    if (host === undefined) return undefined;
    const hold = host.enterMutating(header(req, 'x-agentlink-generation'));
    if (hold === undefined) {
      req.resume();
      emit({ kind: 'rejected', reason: 'agent_changed' });
      agentChanged(res);
      return false;
    }
    requestHolds.set(req, hold);
    return hold;
  }

  /** `GET /api/ui/agents` in the app host: names, labels and counts, never a path or an ID. */
  async function listAgents(): Promise<LocalUiAgentsList> {
    const slot = host;
    if (slot === undefined) throw new Error('not the app host');
    const entries = (await slot.directory.list()).slice(0, MAX_LISTED_AGENTS);
    const current = slot.current;
    // U3-f: the agent each AI app runs, from its `agentlink` entry only (the seam's entry-only view).
    const apps = await (aiAppsDesk()?.list() ?? Promise.resolve(undefined)).catch(() => undefined);
    const appsOf = (name: string): readonly string[] =>
      Object.freeze(
        (apps?.apps ?? []).flatMap((view) =>
          view.state.kind === 'agent' && view.state.agent === name ? [view.app] : [],
        ),
      );
    const agents: LocalUiAgentView[] = [];
    for (const entry of entries) {
      const stats = entry.available
        ? await slot.directory.stats(entry.name).catch(() => undefined)
        : undefined;
      agents.push(
        Object.freeze<LocalUiAgentView>({
          name: entry.name,
          // U3-d: the open agent shows its verified label, else its folder name.
          label: entry.name === current ? (agentLabel ?? entry.name) : entry.label,
          // True once an `agent.label` exists: the open agent's is verified by core, another's is
          // the one written to its config.json after core applied it (07 §9.1).
          labelled: entry.name === current ? agentLabel !== undefined : entry.labelled === true,
          current: entry.name === current,
          available: entry.available,
          removing: entry.removing,
          contacts: stats?.contacts ?? null,
          // U3-invite-b: during the host's own short pass the lease row is the app's, not an AI app's.
          running:
            (stats?.running ?? false) && !(entry.name === current && follower?.passing === true),
          // U3-f: from each AI app's `agentlink` entry only.
          apps: appsOf(entry.name),
        }),
      );
    }
    return Object.freeze<LocalUiAgentsList>({
      generation: slot.generation,
      current: current ?? null,
      label: current === undefined ? null : (agentLabel ?? current),
      agents: Object.freeze(agents),
    });
  }

  /**
   * U3-c: `POST /api/ui/agents/switch` `{name, generation}`, the switch kind. The caller checked the
   * session, CSRF, Origin, fetch metadata and the octet-stream type. No query, operation input or
   * presence header; the body is exactly `{"name": <agent name>, "generation": <number>}`. No owner
   * presence, nothing signed: the host closes the open agent and opens the named one, and writes only
   * `app.json`. Answers fixed codes; never echoes the name.
   */
  async function switchGate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const finishSwitch = (status: number, outcome: AppHostSwitchOutcome | 'invalid'): void => {
      if (outcome !== 'invalid') emit({ kind: 'switch', outcome });
      stamp(res);
      sendJson(
        res,
        status,
        outcome === 'done' && host !== undefined
          ? { status: 'done', generation: host.generation, current: host.current ?? null }
          : { status: outcome },
      );
    };
    if (host === undefined) {
      req.resume();
      sendResult(res, NOT_AVAILABLE);
      return;
    }
    if (
      url.search !== '' ||
      header(req, 'x-agentlink-input') !== undefined ||
      header(req, 'x-agentlink-presence') !== undefined
    ) {
      req.resume();
      finishSwitch(400, 'invalid');
      return;
    }
    const body = await boundedBody(req, res, MAX_SWITCH_BODY_BYTES);
    if (body === undefined) return;
    let name: unknown;
    let generation: unknown;
    try {
      const parsed = parseJson(decodeUtf8(body));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      const keys = Object.keys(parsed).sort();
      if (keys.length !== 2 || keys[0] !== 'generation' || keys[1] !== 'name') throw new Error();
      ({ name, generation } = parsed as { name?: unknown; generation?: unknown });
    } catch {
      finishSwitch(400, 'invalid');
      return;
    }
    if (
      typeof name !== 'string' ||
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      finishSwitch(400, 'invalid');
      return;
    }
    const outcome = await host.switchTo(name, String(generation));
    const status =
      outcome === 'done'
        ? 200
        : outcome === 'unknown_agent'
          ? 404
          : outcome === 'unavailable'
            ? 503
            : 409;
    finishSwitch(status, outcome);
  }

  /** U3-e: one removal at a time. */
  let removalBusy = false;

  /**
   * U3-e: `POST /api/ui/agents/remove` `{name, typedLabel, anyway?}` (08 §1; 04 §2.5 "Removing an
   * agent"), the remove kind. The caller checked the session, CSRF, Origin, fetch metadata, the
   * octet-stream type and the generation (the request's hold). No query. In order: the strict input;
   * the name must be a listed agent and the typed label its label exactly (`label_mismatch`); the app
   * closes the agent if it has it open (same generation: a refused removal opens it again); the
   * folder lock is taken EXCLUSIVE, or `in_use` before any presence is used; the agent is opened for
   * its removal under that lock; then ownerGate checks presence against the owner its own card names
   * and runs the steps (api/agents-remove.ts runRemovalSteps), which sign `agent.revoke` (and its
   * carriers) in the one gesture. The lock is held until the folder is gone. Then the app opens
   * another agent, or none ("Add an agent"); after `undeliverable` it opens none, so the page can
   * ask "Remove anyway?" (the agent is retired and listed as "Removal not finished").
   */
  async function removeGate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const finishRemove = (outcome: RemoveOutcome, step?: RemovalStep): void => {
      emit({ kind: 'remove', outcome, ...(step === undefined ? {} : { step }) });
      if (res.headersSent) return;
      req.resume();
      stamp(res);
      sendJson(res, REMOVE_STATUS[outcome], { status: outcome });
    };
    const slot = host;
    const removal = options.host?.removal;
    if (slot === undefined || removal === undefined) {
      req.resume();
      sendResult(res, NOT_AVAILABLE);
      return;
    }
    const raw = operationInput(req);
    const input = raw === 'invalid' || url.search !== '' ? undefined : parseRemoveInput(raw);
    if (input === undefined) {
      finishRemove('invalid');
      return;
    }
    if (removalBusy) {
      req.resume();
      finishOwner(res, 409, 'busy');
      return;
    }
    removalBusy = true;
    let reopen: (() => Promise<void>) | undefined;
    let settled: 'removed' | 'undeliverable' | 'retired' | undefined;
    let wasOpen = false;
    try {
      const entry = await slot.directory.read(input.name).catch(() => undefined);
      if (entry === undefined || entry.name !== input.name || !entry.available) {
        finishRemove('unknown_agent');
        return;
      }
      // The typed label is the confirmation (b11 §29): exactly the label shown, never normalised.
      if (input.typedLabel !== entry.label) {
        finishRemove('label_mismatch');
        return;
      }
      const keys = await removal.keys(input.name).catch(() => undefined);
      if (keys === undefined) {
        finishRemove('unknown_agent');
        return;
      }
      const erase = createKeyEraseControl(
        keys.backend === 'keychain'
          ? { backend: 'keychain', keychain: keychainOf() }
          : { backend: 'file', keystoreDir: keys.keystoreDir },
      );
      // GAP B: the owner context of the agent the app has open (the same owner), read before it may
      // be closed; used only to finish a retired agent whose store no longer opens.
      const openSource = source;
      const openContext = (): Promise<ApprovalContext | undefined> => openSource.context();
      // (1) The app's own shared lock goes first, then the lock is taken exclusive.
      const closed = await slot.closeForRemoval(input.name);
      wasOpen = closed.closed;
      reopen = closed.restore;
      await removal.exclusive(input.name, async () => {
        const agent = await removal.open(input.name);
        if (agent === undefined) {
          // GAP B: a retired agent whose keys are gone no longer opens; steps 6 and 7 finish it.
          const recorded = entry.removing
            ? await removal.readRevoked(keys.agentId).catch(() => undefined)
            : undefined;
          const checked =
            recorded?.kind === 'entry'
              ? verifyRevokedEntry(recorded.text, keys.agentId)
              : undefined;
          // The owner of the gesture: the agent that is open now (the same owner) signed that entry.
          const context = await openContext().catch(() => undefined);
          if (
            recorded?.kind !== 'entry' ||
            checked?.ok !== true ||
            context === undefined ||
            encodeHex(context.owner.ownerNostr) !== checked.owner
          ) {
            finishRemove('failed');
            return;
          }
          const text = recorded.text;
          const ownerNostr = checked.owner;
          await ownerGate(
            req,
            res,
            async (owner) => {
              try {
                await runFinishSteps({
                  name: input.name,
                  label: entry.label,
                  agentId: keys.agentId,
                  recorded: text,
                  ownerNostr,
                  removeFolder: (name) => slot.directory.removeFolder(name),
                  erase,
                  owner,
                  now: () => now(),
                });
                settled = 'removed';
                emit({ kind: 'remove', outcome: 'removed' });
                return { status: REMOVE_STATUS.removed, body: { status: 'removed' } };
              } catch (error) {
                if (error instanceof RemovalStepFailed) {
                  settled = 'retired';
                  emit({ kind: 'remove', outcome: 'failed', step: error.step });
                }
                throw error;
              }
            },
            { context: () => Promise.resolve(context) },
          );
          return;
        }
        try {
          await ownerGate(
            req,
            res,
            async (owner) => {
              try {
                const outcome = await runRemovalSteps({
                  name: input.name,
                  agentId: keys.agentId,
                  label: entry.label,
                  anyway: input.anyway,
                  agent,
                  port: removal,
                  markRemoving: (name) => slot.directory.markRemoving(name),
                  removeFolder: (name) => slot.directory.removeFolder(name),
                  erase,
                  owner,
                  ...(internals.removalDelivery === undefined
                    ? {}
                    : { delivery: internals.removalDelivery }),
                });
                settled = outcome;
                emit({ kind: 'remove', outcome });
                return { status: REMOVE_STATUS[outcome], body: { status: outcome } };
              } catch (error) {
                if (error instanceof RemovalStepFailed) {
                  // Recorded (any later step failed): the agent is retired either way.
                  if (error.step !== 'sign' && error.step !== 'record') settled = 'retired';
                  emit({ kind: 'remove', outcome: 'failed', step: error.step });
                }
                throw error;
              }
            },
            { context: () => agent.context(), carriers: true },
          );
        } finally {
          await agent.close().catch(() => undefined);
        }
      });
    } catch (error) {
      if (error instanceof AgentFolderLockError && error.code === 'in_use') {
        finishRemove('in_use');
      } else {
        finishRemove('failed');
      }
    } finally {
      try {
        if (settled === undefined) {
          // Nothing was signed: the agent the page showed is opened again, same generation.
          await reopen?.();
        } else if (settled !== 'undeliverable') {
          await slot.openAfterRemoval(wasOpen);
        }
      } finally {
        removalBusy = false;
      }
    }
  }

  // Created last: binding the first agent clears state the gates above own.
  host = options.host === undefined ? undefined : new AppHostSlot(options.host, bindAgent);
  // U3-invite (08 §4): the invite `agentlink join` started this host with, checked again (Accept
  // step 1) and held in memory only; a link that fails is simply not held.
  if (joinDesk !== undefined && options.host?.waitingInvite !== undefined) {
    await joinDesk.offer(options.host.waitingInvite);
  }
  // U3-invite: the handoff record (0600, the CLI's), so a later `agentlink join` hands over here.
  let handoffWritten = false;
  if (handoffToken !== undefined && options.host?.handoff !== undefined) {
    try {
      await options.host.handoff.write({ pid: process.pid, port, handoffToken });
      handoffWritten = true;
    } catch {
      // No record: `join` starts its own host instead (08 §4). Nothing is logged about it.
    }
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
    openHome: async () => opener(`${origin}/settings/home?t=${mintLink()}`).catch(() => false),
    openJoin: () => openJoinPage(false),
    notifyNewApproval: async (approvalId: string) => {
      const url = approvalUrl(approvalId);
      await notifier(NOTIFICATION).catch(() => false);
      return url;
    },
    close: async () => {
      dropSetup();
      payHolds.clear();
      await folderRemoval;
      // U3-invite: the handoff record goes first, so no `join` hands over to a closing host.
      if (handoffWritten) await options.host?.handoff?.remove().catch(() => undefined);
      joinDesk?.dismiss();
      await Promise.all(listeners.map(closeServer));
      // U3-c: the app host closes the agent it has open (whichever the owner switched to).
      await host?.close();
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
