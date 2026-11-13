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
//   link left in browser history never opens the page again. R1-SEC-05: the OS opener never puts
//   the link in a program's argv (approval-os.ts: a private launch file); a link that arrives as a
//   navigation that is not the OS's own (fetch metadata other than `none`) gets the cookie with a
//   same-origin continue page instead of the redirect, since browsers drop a SameSite=Strict cookie
//   on such a redirect. An unused link dies after
//   SESSION_LINK_LIFETIME_MS. At most MAX_LINKS links and MAX_SESSIONS sessions are held (the oldest
//   is dropped). No token, cookie or CSRF value is written to disk (except the one-shot link inside
//   the OS opener's private 0600 launch file, R1-SEC-05), logged, put in an event, an approval URL
//   or an error body.
// - DNS rebinding: the `Host` header must be exactly `localhost:<port>` (so `127.0.0.1:<port>`,
//   `[::1]:<port>`, `LOCALHOST:<port>` and `localhost.:<port>` are refused); any `Origin` header present
//   must be exactly `http://localhost:<port>`; a POST must carry that Origin.
// - Cross-site requests: no CORS grant ever; API calls need a per-server CSRF token (in the page,
//   never in the URL) in `X-AgentLink-CSRF` and fetch metadata that is absent or `same-origin`; a
//   decision is a POST with `Content-Type: application/octet-stream` (not a simple request).
// - The token grants viewing only (08 §1). A decision needs owner presence: the master code or owner
//   passphrase, sent as the raw request body, unlocks the owner key for exactly one owner operation
//   (04 §2.5, D-68: one `approval.decide`), and the buffer is wiped. The signed object goes to the
//   source (core's `ownerActions.apply`), which verifies it (I-4). No route decides without it.
// - M1-8e, the localhost passkey (owner-passkey.ts): with `X-AgentLink-Presence: passkey` the body is
//   the passkey assertion (credential ID, authenticator data, user handle, PRF output). The server
//   checks it against the stored `owner-passkey` item and the owner (credential ID, user handle,
//   rpIdHash = SHA-256("localhost"), UP and UV) before the PRF output unlocks the owner key for one
//   owner operation. `/api/owner/passkey` shows the public registration data (GET) and registers the
//   one passkey (POST: the master code plus the assertion), its own owner operation that signs
//   nothing. The PRF output never leaves this process and is wiped after use.
// - DESK-D12c, native presence in the desktop app (04 §2.3.4, §2.5 phase 2; owner-native.ts): with
//   `X-AgentLink-Presence: native` the body must be empty and the server runs this computer's presence
//   helper (ApprovalServerOptions.nativePresence; only the desktop app passes one) once, with a fixed
//   reason (`approve`, or `pay` for a paid action's confirmation), after every check of the request
//   and before the owner store is opened. The released secret opens the `owner-native` item for that
//   one owner operation and is wiped. A refused gesture answers a fixed state in `native` (cancelled,
//   failed, lockout, reregister, unavailable, retry_later, not_registered), never counted towards the
//   wrong-code backoff (the OS limits its own tries). `/api/owner/native` shows whether the helper is
//   there and registered for the owner (GET) and registers it (POST: the master code, or a passkey
//   assertion with `X-AgentLink-Presence: passkey` answering its ceremony), its own owner operation
//   that signs nothing. DESK051-C6 (04 §2.5): every native gesture answers a fresh, single-use
//   ceremony of kind `native` (`X-AgentLink-Presence: native-challenge` first, then `native` with
//   `X-AgentLink-Ceremony`), bound to the page session and exactly this request and spent before the
//   helper runs, so a replayed native request never starts a second OS sheet and never acts. A paid
//   action's native confirmation answers its own pay-confirm ceremony (single-use hold).
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
//   proofs in a row (master code, owner passphrase or passkey), every owner operation of this server
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
//   for `/first-run` and `/settings[/...]`, (M1-11b-2) for `/` and `/approve/<id>`, (W4-SHELL)
//   for `/inbox` and `/contacts`, and (W4-SHELL-V2) for `/agents[/<name>]`, `/activity[/live]`,
//   `/advanced/<page>` and `/start/<step>`.
// - M1-11b-2c: the server-rendered approval page, its `/app.js` and `/app.css`, are gone (404).
//   Without a bundle, `/` and `/approve/<id>` answer the fixed NO_APP_HTML (approval-pages.ts):
//   no script, no form, no CSRF token, so nothing can be decided in the browser; it points to
//   `approve` in the owner's own terminal. Every gate is unchanged.
//   The session cookie gates the app pages, the assets and every /api/ui/ route.
// - M1-11s-b, the /api/ui/ routes (local-ui/routes.ts): each declares `presence`; a mutating route
//   must declare `presence: true`. Every route needs the session cookie, the CSRF header and
//   same-origin fetch metadata; a mutating one also the page's Origin and an octet-stream body. The
//   central presence gate then runs before the handler: the wrong-code backoff, the presence proof
//   (the master code, or the passkey assertion checked as for a decision), one owner operation at a
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
// - W4-SHELL-V2 (Decisions 49–51; proposed in 08 §1, owner confirms at merge), the app's own UI
//   settings: the one `presence: 'ui-settings'` route (`PUT /api/ui/ui-settings`) is run by
//   `uiSettingsGate`, never by `ownerGate`. After the same session, CSRF, Origin, fetch-metadata and
//   octet-stream checks, no query, operation input or presence header; the body is one strict JSON
//   object of allowlisted booleans (`underTheHood`, `menuExpanded`), at most 128 bytes. No owner
//   presence, no owner store, nothing signed, no generation (it is the app's, not an agent's); the
//   app host writes only `~/.agentlink/ui-settings.json`. Its read answers with no agent open too.
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
//   creation response and completes the setup all or nothing (owner-setup.ts): the master code, the
//   passkey and the agent's first card. The master code goes to the page once and is never in an
//   event. The held seed is wiped on finish (whatever the outcome), on expiry, when its session is
//   dropped and when the server closes.
// - M1-UX-FIRSTRUN-V2 (D-130 (1), (2); 08 §1 first run v2; proposed, owner confirms at merge): when
//   the setup's `firstCard.firstPolicy` is wired, `begin` first prepares the folders (Send, Inbox,
//   Proofs; owner-setup.ts prepareSetupFolders) and answers 409 `folder_refused` (reason
//   `folder_unavailable`) before any seed exists when Send is a link at either level or not a
//   folder. ATT-SENDFOLDER-FIX: a Send that already holds files is used (`folder_not_empty` is no
//   longer answered; the code stays known to older pages). `finish` signs the card and the first policy with the same
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
import { homedir, hostname as osHostname } from 'node:os';
import type { AddressInfo, ListenOptions } from 'node:net';
import { join } from 'node:path';
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
  canonicalize,
  canonicalizeToBytes,
  decodeBase64url,
  decodeHex,
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
import { failedBody } from './local-ui/failure-reasons.js';
import { revealSavedFile } from './local-ui/reveal-file.js';
import { readSavedText, type PreviewReadLimits } from './local-ui/read-preview.js';
import {
  EXPIRED_APPROVAL_HTML,
  EXPIRED_HTML,
  NOT_FOUND_HTML,
  NO_APP_HTML,
} from './approval-pages.js';
import { isAppPagePath } from '@4thtech-io/types/ui-contract/app-pages';
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
import {
  PRESENCE_CEREMONY_HEADER,
  PRESENCE_CEREMONY_TTL_MS,
  PRESENCE_CHALLENGE_MODE,
  NATIVE_CHALLENGE_MODE,
  PresenceCeremonies,
  presenceBinding,
  type PresenceCeremonyKind,
} from './presence-ceremony.js';
import { takeReviewedRules } from './local-ui/api/rules.js';
import { grouped } from './owner-init.js';
import {
  KeychainOwnerKeyStore,
  exportSeedOf,
  newOwnerSeed,
  ownerFingerprintText,
  ownerItemPresent,
} from './owner-keystore.js';
// UX1113 WP-S2: Touch ID & master code (check, test, replace through ownerGate).
import { OwnerCodeChanges } from './local-ui/api/owner-presence.js';
import { ownerCodeProofAllowed, type LocalUiOwnerCodeStep } from './local-ui/owner-code-paths.js';
import {
  NativeHelperError,
  type NativeHelper,
  type NativeReason,
  type NativeUiState,
} from './owner-native-helper.js';
import {
  nativePresence,
  nativePresenceStatus,
  readOwnerNativeHeader,
  type NativePresenceStatus,
  registerOwnerNative,
  replaceOwnerNative,
  turnOffOwnerNative,
  type NativeStep,
} from './owner-native.js';
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
import { createRestoreEngine, type RestoreEngine } from './recovery-kit-restore.js';
import { removeStaleRestoreFiles } from './restore-quarantine.js';
import { MasterCodeHold } from './local-ui/master-code-hold.js';
import {
  readUnsavedMarker,
  removeUnsavedMarker,
  writeUnsavedMarker,
} from './master-code-unsaved.js';

/** REL051-CF3: how long a /api/ui/ request waits for the start-up settle at most. */
const SETTLE_WAIT_MS = 5_000;
import {
  keepsFolder,
  prepareSendFolder,
  removeCreated,
  type SendFolderPlan,
} from './owner-first-policy.js';
import {
  labelActionsOf,
  type FirstAgentCard,
  type FirstPolicyActions,
} from './owner-first-card.js';
import { signNewAgent } from './owner-add-agent.js';
import { signRename } from './owner-rename.js';
import {
  CREATE_CONNECT_HOLD_MS,
  CREATE_CONNECT_NONCE_BYTES,
  CREATE_CONNECT_TRIES,
  agentFingerprintOf,
  buildCreateConnectPlan,
  createConnectChallenge,
  type CreateConnectPlan,
  type PlanStatement,
  type PlanStatementApp,
} from './owner-add-agent-plan.js';
import { HeldAgentSeed } from './keychain-keystore.js';
import { isAgentLabelText } from './local-ui/api/agents-manage.js';
import { AI_APP_IDS, appChangeId } from './local-ui/api/apps.js';
import {
  PASSKEY_RP_ID,
  assertPasskeyAssertion,
  encodePasskeyAssertion,
  parsePasskeyRegistration,
  readOwnerPasskeyHeader,
  readOwnerPasskeyKey,
  registerOwnerPasskey,
  type PasskeyAssertion,
} from './owner-passkey.js';
import { attachDesk } from './local-ui/attach-desk.js';
import { ATTACH_MAX_BODY_BYTES } from './local-ui/api/attach.js';
import {
  creditsPort,
  fileSavePort,
  inviteAcceptPort,
  inviteDesk,
  pauseDesk,
  readOnlyClient,
  type LocalUiAgentView,
  type LocalUiAgentsList,
  type LocalUiAgentsManage,
  type LocalUiAiAppPlan,
  type LocalUiAiApps,
  type LocalUiAssets,
  type LocalUiContext,
  type LocalUiOptions,
  type LocalUiRecoveryKitSource,
  type LocalUiOwnerSetup as LocalUiOwnerSetupOption,
} from './local-ui/context.js';
import { JoinDesk, type JoinCheck } from './local-ui/join-desk.js';
import { pairingFollower, type PairingFollower } from './local-ui/pairing-follow.js';
import { JOIN_PAGE_PATH } from './local-ui/invite-paths.js';
import type {
  LocalUiInviteRoute,
  LocalUiAttachRoute,
  LocalUiReadRoute,
  LocalUiRoute,
  LocalUiSwitchRoute,
  LocalUiPauseRoute,
  LocalUiRestoreRoute,
  LocalUiCreateAgentStep,
  LocalUiOwnerOperation,
  LocalUiPayConfirmStep,
  LocalUiRenameRequest,
  LocalUiResult,
  LocalUiRevealRoute,
  LocalUiKitRevealRoute,
  LocalUiMarkRoute,
  LocalUiUiSettingsRoute,
  LocalUiSetupStep,
} from './local-ui/route-types.js';
import { LOCAL_UI_MAX_INPUT_CHARS, NOT_AVAILABLE } from './local-ui/route-types.js';
import {
  UI_SETTINGS_MAX_BODY_BYTES,
  readUiSettings,
  type UiSettings,
} from '@4thtech-io/types/ui-contract/ui-settings';
import { createUiSettingsDesk } from './local-ui/api/ui-settings.js';
import type { LocalUiNotificationsDesk } from './local-ui/api/notifications.js';
import {
  notifyPrefsInForce,
  type NotificationItem,
  type NotifyPrefKey,
} from '@4thtech-io/types/ui-contract/notifications';
import {
  createNotificationStore,
  memoryNotificationPersistence,
  type NotificationInbound,
  type NotificationPersistence,
  type NotificationSignals,
  type NotificationStore,
} from './notifications.js';
import { createPeopleAllDesk } from './local-ui/api/people-all.js';
import { createStorageDesk, inboxUsageOf } from './local-ui/api/storage.js';
import type { LocalUiAppUpdateDesk } from './local-ui/api/app-update.js';
import {
  AppHostSlot,
  FIRST_AGENT_LABEL,
  FIRST_AGENT_NAME,
  HOST_AGENT_NAME,
  VISIT_STEP_MS,
  type AgentDirectoryEntry,
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
  exportRecoveryKit,
  type RecoveryKitClient,
  type RecoveryKitNotIncluded,
  type RecoveryKitOthers,
} from './recovery-kit-export.js';
import { MAX_KIT_IDS, type KitTodayId, type LocalUiBackupDesk } from './kit-record.js';
import { ownerOperationRefused } from './owner-allowlist.js';
import {
  LOCAL_UI_API_PREFIX,
  LocalUiRouteRegistry,
  createLocalUiRoutes,
} from './local-ui/routes.js';
import { createHealthReader } from './local-ui/api/health.js';
import { networkHealthSource, type NetworkHealthClient } from './local-ui/network-health.js';
import { LiveEvents, type LiveEventSink } from './local-ui/api/events.js';
import { LiveStatusTracker, liveAgentRecord } from './local-ui/live-status.js';
import {
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
 * Longest accepted passkey body (assertion, or master code plus assertion), M1-8e; M1-PAY-CONFIRM-b
 * adds room for the create() authenticator data a registration may carry.
 */
const MAX_PASSKEY_BYTES = 6144;
const PASSKEY_PATH = '/api/owner/passkey';
/** DESK-D12c: the desktop app's native presence (GET status, POST register). */
const NATIVE_PATH = '/api/owner/native';
/** Fable review M1: turn native presence off, or on again (replace), each its own owner operation. */
const NATIVE_OFF_PATH = '/api/owner/native/off';
const NATIVE_REPLACE_PATH = '/api/owner/native/replace';
/**
 * DESK-TOUCHID-FIX review (Fable M-1): the page's Cancel while the presence helper waits. Stops the
 * helper of the native presence operation in progress (turn on, on again, or a native approval); that
 * request then answers with what really happened. Changes nothing else; no body.
 */
const NATIVE_CANCEL_PATH = '/api/owner/native/cancel';
/** DESK-D12c: the HTTP status of each fixed native presence state (never counted as a wrong code). */
type NativeAnswerState = NativeUiState | 'not_registered' | 'damaged' | 'keychain';
const NATIVE_HTTP: Readonly<Record<NativeAnswerState, number>> = Object.freeze({
  cancelled: 403,
  failed: 403,
  not_registered: 403,
  // Fable review L4: a blob that does not open after a real gesture (corrupted, or swapped by a
  // same-user process) is its own state, never a wrong code: no wrong-code wait.
  damaged: 409,
  // Fable review L5: the keychain could not be read; not the same as "not turned on".
  keychain: 503,
  lockout: 423,
  reregister: 409,
  unavailable: 409,
  retry_later: 503,
  // DESK-NATIVE-DEBUG: the OS prompt got no answer in time (never a wrong code).
  timeout: 403,
  error: 500,
});
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

/**
 * M1-11s-b: the local UI app's pages (D-118); everything else keeps its own route or is 404.
 * UX1113-QA-HOST: the page paths are one strict list shared with the router
 * (@4thtech-io/types ui-contract/app-pages.ts; the router's drift test), so a reload on any page
 * (People, My IDs, Restore, every Settings page, the old aliases) shows the page. An unknown GET
 * path that is not the API or an asset shows "Page not found" (the app's own with a session, else a
 * fixed page), never raw JSON; the API keeps its JSON answers.
 */
const APP_PAGE = { test: (path: string): boolean => path !== '/' && isAppPagePath(path) };

/**
 * R1-SEC-05: the same-origin continue page after a session link opened from the launch file. `path`
 * is a checked page path (`/`, APPROVE_PAGE or APP_PAGE); it is escaped anyway. No script, no token.
 */
function continuePage(path: string): string {
  const safe = path.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? '',
  );
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<meta http-equiv="refresh" content="0;url=${safe}">` +
    '<title>AgentLink</title></head>' +
    `<body><p><a href="${safe}">Open AgentLink</a></p></body></html>`
  );
}
const API_PREFIX = '/api/';
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
/** WP-R2b: the kit-reveal route takes no body; anything up to this is read and refused (400). */
const MAX_KIT_REVEAL_BODY_BYTES = 256;

/**
 * ATT-SENDFOLDER-FIX (IR-ATT-SENDFOLDER-1 M-1): the Send folder a begin answer names for the page
 * to show before the gesture: its real path (local data, shown as text) and whether it already
 * holds files (then the owner reads that those can be sent too). Nothing when no folder is ready.
 */
function sendFolderReview(send: SendFolderPlan | undefined): {
  sendFolderReview?: { folder: string; holdsFiles: boolean };
} {
  if (send?.status !== 'ready') return {};
  return { sendFolderReview: { folder: send.folder, holdsFiles: send.holdsFiles === true } };
}
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
/** ATT-APP-ATTACH: at most this many attached messages per window, per server (then 429 `wait`). */
const ATTACH_LIMIT = 20;
const ATTACH_WINDOW_MS = 60_000;
/** IR-ATTACH-1 F-1: at most this many attach requests read or sent at once (then 429 `wait`). */
const ATTACH_MAX_IN_FLIGHT = 2;
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

/** W4-LIVE-STATUS: the event hub reuses an AI apps list this long (config files, not sessions). */
const APPS_LIST_REUSE_MS = 10_000;

/** The AI apps seam's list answer. */
type AiAppsListing = Awaited<ReturnType<LocalUiAiApps['list']>>;

/** Structured events, fixed values only: never a token, URL, secret, ID or request text (I-7). */
export type ApprovalServerEvent =
  | { readonly kind: 'listening' }
  /** The machine has no IPv6 loopback: the server listens on 127.0.0.1 only (M1-31). */
  | { readonly kind: 'ipv6_unavailable' }
  /** W4-LIVE-STATUS: an event stream opened or was refused (`busy`); the open count only (I-7). */
  | { readonly kind: 'events'; readonly outcome: 'opened' | 'busy'; readonly open: number }
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
        /** REL051-SF1: the passkey has no kept credential key; the master code works. */
        | 'passkey_update_needed'
        /** REL051-SF1: the gesture was signed without user verification. */
        | 'verification_required'
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
        /** REL051-SF1: the passkey has no kept credential key; the master code works. */
        | 'passkey_update_needed'
        /** REL051-SF1: the gesture was signed without user verification. */
        | 'verification_required'
        | 'busy'
        | 'needs_setup'
        | 'refused'
        /** U3-c: the open agent changed since the page was built (app host). */
        | 'agent_changed'
        /** UX1113 WP-S2: no staged master-code change for this page session. */
        | 'not_pending'
        /** WP-S2: the staged master-code change was dropped (Cancel). */
        | 'cancelled'
        | 'failed';
    }
  /** M1-11s-c: the outcome of an owner setup step (never the master code, a key or a value). */
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
        /** W4-ONE-TOUCH (04 §2.8): owner and agent made, the AI app entry not written. */
        | 'created_not_connected'
        /** W4-ONE-TOUCH: the third rejected presence proof ended the plan. */
        | 'tries_exhausted'
        /** W4-ONE-TOUCH: the AI app's file changed since begin; nothing was signed. */
        | 'changed'
        /** W4-ONE-TOUCH: Claude Desktop runs ("Quit Claude Desktop first"). */
        | 'quit_first'
        /** W4-ONE-TOUCH: the picked AI app can't be connected from here. */
        | 'app_unavailable'
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
   * challenge, the statement, an amount, a name, the assertion or the master code; I-7).
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
        /** Rule 5: the passkey has no stored credential key; use the master code. */
        | 'passkey_update_needed'
        /** M1-PAY-CONFIRM-b: "Remember for this contact" is not offered for this request (06 §3). */
        | 'not_offered'
        | 'tries_exhausted'
        | 'refused'
        | 'failed';
    }
  /** U3-c: a switch of the open agent in the app host (fixed outcome only, never a name). */
  | { readonly kind: 'switch'; readonly outcome: AppHostSwitchOutcome }
  /** W4-PAUSE: a pause of the open agent (fixed outcome only, never a name; I-7). */
  | { readonly kind: 'pause'; readonly outcome: 'paused' | 'already' | 'failed' }
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
  /**
   * IR-NOTIFY-1 M-1 (N6): whether the OS approval alert (notifyNewApproval) may show, read on each
   * alert. Absent: the app host's UI settings (`notify.approvals`), else on (the D2 default).
   */
  readonly approvalAlerts?: () => Promise<boolean>;
  /** Receives fixed-value events (for the redacting logger). Exceptions in it are ignored. */
  readonly onEvent?: (event: ApprovalServerEvent) => void;
  /** M1-11s-b: the local UI app's files and the agent's core client (D-118). */
  readonly localUi?: LocalUiOptions;
  /**
   * U3-c: the app host (`agentlink ui` only). Present: the agent comes from `host.initial` and can be
   * switched; `source` and `localUi.client` are ignored (`localUi.assets` and `version` are used).
   */
  readonly host?: AppHostOptions;
  /**
   * DESK-D12c: this computer's presence helper, when core runs inside the desktop app
   * (owner-native-helper.ts desktopNativeHelper). Undefined everywhere else: the native presence kind
   * is then refused and nothing changes for the browser.
   */
  readonly nativePresence?: NativeHelper;
  /**
   * DESK051-UPD: Settings > Updates, when core runs inside the desktop app (its host relays the
   * shell's update state; local-ui/api/app-update.ts). Undefined everywhere else: the routes answer
   * 501 and the page is not offered.
   */
  readonly appUpdate?: LocalUiAppUpdateDesk;
  /**
   * DESK-NATIVE-DEBUG: receives ONE fixed diagnostic line per native presence operation outcome
   * (nativeDiagnostic: fixed words, step names and error codes only; never a secret, a path, a
   * handle, a record or a system message). The desktop host writes it to stderr, which the shell's
   * redacting core log keeps. Exceptions in it are ignored.
   */
  readonly diagnose?: (line: string) => void;
}

/**
 * DESK-NATIVE-DEBUG: the fixed reason of a native presence failure for the diagnostic line: the
 * helper's state, how its run ended and its own fixed diagnostic; or a keystore error's code (and
 * `timeout` / `refused` for the keychain); `unexpected` for anything else. Only fixed tokens.
 */
export function nativeFailureReason(error: unknown): string {
  if (error instanceof NativeHelperError) {
    return [
      `helper_${error.state}`,
      ...(error.detail === undefined ? [] : [error.detail]),
      ...(error.diag === undefined ? [] : [`[${error.diag}]`]),
    ].join(' ');
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[a-z_]{1,40}$/.test(code)) {
    const detail = (error as { detail?: unknown }).detail;
    return detail === 'timeout' || detail === 'refused' ? `${code} ${detail}` : code;
  }
  return 'unexpected';
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
  /**
   * REL051-A34: the home folder a `~/` Inbox folder resolves against for the in-app preview (tests
   * use a temporary HOME, as the agent's own runtime does). Default: the OS user's home.
   */
  readonly filesHome?: string;
  /** The clock in milliseconds (link lifetime, backoff). Default: Date.now. */
  readonly now?: () => number;
  /** M1-11s-b: the /api/ui/ routes. Default: createLocalUiRoutes() (the page files). */
  readonly routes?: LocalUiRouteRegistry;
  /** M1-11s-c: Argon2id parameters for the new master code's wrap. Default: the keystore defaults. */
  readonly ownerKdf?: Argon2idParams;
  /** M1-11s-c: the owner seed source for setup. Default: newOwnerSeed (@4thtech-io/crypto). */
  readonly newOwnerSeed?: () => { readonly seed: Uint8Array; readonly keys: OwnerPublicKeys };
  /** M1-UX-FIRSTRUN-V2: the computer's host name. Default: node:os hostname. */
  readonly hostname?: () => string;
  /** M1-UX-FIRSTRUN-V2-b: removes a setup's folders (tests: timing). Default: removeSetupFolders. */
  readonly removeSetupFolders?: (folders: SetupFolders | undefined) => Promise<void>;
  /** U3-invite: Accept step 1 of the waiting invite. Default: core checkInviteLink. */
  readonly checkInvite?: JoinCheck;
  /** W4-LIVE-STATUS: the live event hub's read interval (tests: shorter). Default 2 s. */
  readonly liveEvents?: { readonly readIntervalMs?: number };
  /**
   * UX1113-R1 (D-147): the restore engine's home folder and the new master code's KDF parameters
   * (tests use a temporary HOME and the floor). Default: the OS user's home and the kit defaults.
   */
  readonly restore?: {
    readonly home?: string;
    readonly kdf?: Argon2idParams;
    /** The restore engine's keychain read limit (tests). */
    readonly keychainTimeoutMs?: number;
  };
  /**
   * REL051-SF3 (T-7): remove the restore folder's stale uploads and quarantined stores when the
   * server starts. startApprovalServer sets it; a test server sweeps only its own `restore.home`.
   */
  readonly sweepRestoreAtStart?: boolean;
  /**
   * WP-R2b (IR M-1): the recovery-kit export walk's per-ID limit and the settle time of a late open
   * (tests: shorter). Default VISIT_STEP_MS and VISIT_SETTLE_MS (app-host.ts).
   */
  readonly backupWalk?: {
    readonly stepMs?: number;
    readonly settleMs?: number;
    readonly reopenMs?: number;
  };
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
  /**
   * N7: the same as `openHome` for Settings › Updates (`/settings/updates`), the page a click on the
   * desktop app's "Update ready" notification opens. A fixed path.
   */
  openUpdates(): Promise<boolean>;
  /**
   * N7 (desktop app): the open ID's notification items (brought up to date first; kind, ref, count
   * and times only) and the Settings › Notifications switches in force. Undefined while no ID with a
   * centre is open. In memory only; never leaves the process except as protocol `notify` codes.
   */
  desktopAlerts(): Promise<DesktopAlertState | undefined>;
  /**
   * N7: the names the OWNER gave these contacts of the open ID (nameSource 'owner'; a self-declared
   * name is never answered, I-5). Only the refs asked for; none when no client is open.
   */
  ownerNames(refs: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * F25: whether the app is in use, for the `ui` command's idle limit. `lastAt` is the time (ms) of
   * the last request to the page API (`/api/ui/`), `openStreams` the open live streams (open tabs).
   * Counts and a time only. F40: `linksUsed` counts the one-shot session links used so far (each
   * one opened a session), so the CLI can tell when a browser it asked for never loaded the page.
   */
  readonly activity: {
    lastAt(): number;
    openStreams(): number;
    linksUsed(): number;
  };
  close(): Promise<void>;
}

/** N7: what the desktop core alerts from (ApprovalServer.desktopAlerts). */
export interface DesktopAlertState {
  /** The open ID's folder name (a change starts a fresh first look); in memory only. */
  readonly scope: string;
  readonly items: readonly NotificationItem[];
  readonly prefs: Readonly<Record<NotifyPrefKey, boolean>>;
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

/**
 * WP-11: the open agent's recovery-kit source, only when it names the open client's agent (a kit is
 * never sealed for another agent than the one core prepared the `backup.export` for).
 */
function recoveryKitOf(
  ui: Omit<LocalUiOptions, 'assets'> | undefined,
): LocalUiRecoveryKitSource | undefined {
  const source = ui?.recoveryKit;
  if (source === undefined || ui?.client === undefined) return undefined;
  return source.agentId === ui.client.agentId ? source : undefined;
}

/** U3-c: the open agent changed after the request arrived (the re-check before acting). */
class AgentChanged extends Error {
  constructor() {
    super('The open ID changed.');
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
  apply: () => Promise.reject(new Error('No ID is open.')),
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
  // HOTFIX-NOID (04 §2.8 "No ID on this computer yet"): New ID with an owner and zero IDs. The
  // create-agent gate itself refuses (`no_agent`) unless no ID folder is listed and the owner item
  // exists; it needs no open agent (the owner is unlocked by the master code or Touch ID).
  'POST /api/ui/agents/begin',
  'POST /api/ui/agents',
  // U3-invite (08 §4): the waiting invite is the host's, not an agent's: its read and "Not now"
  // answer during first run on a computer with no agent yet. Accepting needs the agent.
  'GET /api/ui/join',
  'POST /api/ui/join/dismiss',
  // W4-SHELL-V2: the app's UI settings are the app's, not an agent's (the shell during first run).
  'GET /api/ui/ui-settings',
  'PUT /api/ui/ui-settings',
  // DESK051-UPD: the app's own version and updates are the app's, not an agent's.
  'GET /api/ui/app-update',
  'GET /api/ui/app-update/check',
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
    plan: () => Promise.reject(new Error('No ID is open.')),
    agentIdOf: () => Promise.resolve(undefined),
  });
}

/** U3-c: the switch body is `{"name":"<32 chars>","generation":<16 digits>}`. */
const MAX_SWITCH_BODY_BYTES = 128;
/** W4-PAUSE: the pause body is exactly `{"generation":<number>}`. */
const MAX_PAUSE_BODY_BYTES = 64;
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
  /** U3-d: the label `begin` was given (06 §6 label rule). */
  readonly label?: string;
  /** U3-g-b: begun with no agent yet (first run creates the agent); `finish` must be the same. */
  readonly noAgent?: true;
  /** W4-ONE-TOUCH (04 §2.8): the begin nonce; `finish` carries only this (and the response). */
  readonly nonce: Uint8Array;
  /** W4-ONE-TOUCH: the first agent's seed, held with the owner seed (no agent yet). */
  readonly agentSeed?: HeldAgentSeed;
  /** W4-ONE-TOUCH: the plan the challenge binds (absent: a random challenge, no plan). */
  readonly plan?: CreateConnectPlan;
  /** W4-ONE-TOUCH: the picked AI app's change as planned at begin. */
  readonly app?: PlannedApp;
  /** W4-ONE-TOUCH: rejected presence proofs so far (the third ends the hold). */
  tries: number;
}

/** W4-ONE-TOUCH (04 §2.8): the picked AI app as begin planned it, for the checks before writing. */
interface PlannedApp {
  readonly app: string;
  readonly name: string;
  readonly folder: string;
  readonly kind: 'connect' | 'move';
  readonly identity: string;
  readonly changeId: string;
  /** The desk that planned it (first run's or the open agent's), to plan again before writing. */
  readonly desk: { readonly plan: LocalUiAiApps['plan'] };
}

/** W4-ONE-TOUCH (04 §2.8): New agent's held plan, in memory only. */
interface PendingCreate {
  readonly session: Uint8Array;
  readonly nonce: Uint8Array;
  readonly challenge: Uint8Array;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly seed: HeldAgentSeed;
  /** The plan fixed at begin; absent with no ID on this computer (HOTFIX-NOID), see `planFor`. */
  readonly plan?: CreateConnectPlan;
  /**
   * HOTFIX-NOID: with no card naming the owner, the plan is built for the owner the presence
   * unlocked (04 §2.8 M1-9x), from exactly what begin fixed (agent keys, label, folder, Send folder,
   * the app's changeId). Absent when `plan` is set.
   */
  readonly planFor?: (owner: OwnerPublicKeys) => CreateConnectPlan;
  readonly statement: PlanStatement;
  readonly app?: PlannedApp;
  /** The Send folder for the first policy, prepared at begin (removed again unless used). */
  readonly send: SendFolderPlan;
  tries: number;
}

/** W4-ONE-TOUCH: the begin nonce as it travels: 32 bytes, base64url. */
const PLAN_NONCE = /^[A-Za-z0-9_-]{43}$/;

/** W4-ONE-TOUCH: a fresh change for `app` and `folder`, recomputed for `agentId` (04 §2.5.1). */
function changeOf(
  plan: LocalUiAiAppPlan,
  app: string,
  folder: string,
  agentId: string,
): { kind: 'connect' | 'move'; changeId: string; identity: string } | undefined {
  if (plan.status !== 'change' || plan.app !== app) return undefined;
  if (plan.kind !== 'connect' && plan.kind !== 'move') return undefined;
  if (plan.newAgent !== folder || plan.newEntry === null) return undefined;
  if (plan.kind === 'connect' && (plan.oldAgent !== null || plan.oldEntry !== null))
    return undefined;
  const copy = (e: JsonObject | null): JsonObject | null =>
    e === null ? null : (parseJson(canonicalize(e)) as JsonObject);
  return {
    kind: plan.kind,
    identity: plan.identity,
    changeId: appChangeId({
      app,
      path: plan.file,
      oldEntry: copy(plan.oldEntry),
      newEntry: copy(plan.newEntry),
      agent: agentId,
    }),
  };
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
 * proof (the master code, or the passkey's PRF output, M1-8e), handed over once.
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
  /** W4-ONE-TOUCH: the Send folder home of the open agent's first policy (tests: a temp home). */
  let boundHome: string | undefined = options.host?.initial?.firstCard?.firstPolicy?.home;
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
  // REL051-A34: the in-app preview's checked read (local-ui/read-preview.ts).
  const filesHome = internals.filesHome;
  const previewRead = (inboxFolder: string, savedName: string, limits: PreviewReadLimits) =>
    readSavedText(
      inboxFolder,
      savedName,
      limits,
      filesHome === undefined ? {} : { home: filesHome },
    );
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
  // REL051-B3b: the health read's uptime counts from here.
  const serverStartedAt = now();
  /** One-shot session links (M1-11a): token bytes and the time each dies, oldest first. */
  const links: { readonly bytes: Uint8Array; readonly expiresAt: number }[] = [];
  /** Live session secrets (the cookie values), oldest first. */
  const sessions: Uint8Array[] = [];
  /** W4-LIVE-STATUS: keeps each AI app's `since` while its state holds (live-status.ts). */
  const liveTracker = new LiveStatusTracker();
  /** W4-LIVE-STATUS: the last AI apps list, reused by the event hub's 2 s reads. */
  let appsCache:
    | {
        readonly desk: LocalUiAiApps | undefined;
        readonly at: number;
        readonly list: AiAppsListing | undefined;
      }
    | undefined;
  /**
   * W4-LIVE-STATUS (08 §1 `GET /api/ui/events`): the live event hub. It reads the host's agents list
   * (read-only peeks, no lock, never the lease) every 2 s while a stream is open.
   */
  const liveEvents = new LiveEvents({
    read: async () => {
      if (host === undefined) return undefined;
      const list = await listAgents(APPS_LIST_REUSE_MS);
      // W5-INVITE-FEEDBACK: the open agent's contacts mark (plain columns of its open store, read
      // only; it also sees a pairing the AI app's MCP server completed). Compared by the hub, never
      // sent; undefined when it cannot be read.
      const client = agentUi?.client;
      const contactsMark =
        client === undefined ? undefined : await client.pairing.changeMark().catch(() => undefined);
      return {
        generation: list.generation,
        current: list.current,
        agents: list.agents.map(liveAgentRecord),
        contactsMark,
      };
    },
    now,
    sessionLive: (session) => matchIndex(session, sessions) >= 0,
    ...(internals.liveEvents?.readIntervalMs === undefined
      ? {}
      : { readIntervalMs: internals.liveEvents.readIntervalMs }),
  });
  const csrf = encodeBase64url(randomBytes(32));
  const csrfBytes = encodeUtf8(csrf);
  const decided = new Set<string>();
  let busy = false;
  /** Rejected presence proofs in a row, and when the wait they caused ends (ms). */
  let failures = 0;
  let waitUntil = 0;
  /**
   * REL051-CF3: the master code first run or a restore just showed, for a reload of that step
   * (memory only, this page session, 10 minutes; master-code-hold.ts).
   */
  const codeHold = new MasterCodeHold({ now: () => now() });
  /** UX1113 WP-S2: the one staged master-code change, bound to its page session. */
  const ownerCodes = new OwnerCodeChanges({
    keychain: () => keychainOf(),
    now: () => now(),
    ...(internals.ownerKdf === undefined ? {} : { kdf: internals.ownerKdf }),
  });
  /** UX2-d1: the invite desk of the invite-kind routes (never reachable from another route). */
  let invitesDesk = agentUi?.client === undefined ? undefined : inviteDesk(agentUi.client);
  /** UX2-d1: when each recent invite was created (ms), oldest first, for the create limit. */
  const invitesCreated: number[] = [];
  /** ATT-APP-ATTACH: the attach desk of the attach route (never reachable from another route). */
  const attachDeskOf = (ui: typeof agentUi) =>
    ui?.client === undefined
      ? undefined
      : attachDesk(ui.client, filesHome === undefined ? {} : { home: filesHome });
  let attachSendDesk = attachDeskOf(agentUi);
  /** ATT-APP-ATTACH: when each recent attach request was taken (ms), oldest first. */
  const attachesSent: number[] = [];
  /** IR-ATTACH-1 F-1: attach requests being read or sent now. */
  let attachesInFlight = 0;
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
  /** R1-SEC-15: when the last handoff with a wrong token was refused (ms); throttled on its own. */
  let lastHandoffRefusedAt = Number.NEGATIVE_INFINITY;
  let lastJoinOpenAt = Number.NEGATIVE_INFINITY;
  // U3-d (D-138; 08 §1; 04 §2.8 "From the local app"): create an agent and save a verified label.
  // Nothing here signs. W4-ONE-TOUCH: creating an agent is the create-agent gate's (createAgentGate).
  const agentsManage: LocalUiAgentsManage = Object.freeze<LocalUiAgentsManage>({
    current: () => host?.current,
    labelSaved: async (name: string, label: string) => {
      const slot = host;
      if (slot === undefined) return;
      if (name === slot.current) agentLabel = label;
      await slot.directory.writeLabel(name, label);
    },
  });

  // U3-c (IR-U3-c-SEC-1 L-1): the source is captured when the context is built, so a handler that
  // outlives a switch's drain wait keeps the agent it started with and never reaches the next one.
  // W4-SHELL-V2: the app host's UI settings store (one queue of changes for the whole process).
  const uiSettingsDirectory = options.host?.directory;
  const uiSettingsDesk =
    uiSettingsDirectory?.readUiSettings === undefined ||
    uiSettingsDirectory.writeUiSettings === undefined
      ? undefined
      : createUiSettingsDesk({
          read: () =>
            (uiSettingsDirectory.readUiSettings as () => Promise<UiSettings | undefined>)(),
          write: (settings) =>
            (uiSettingsDirectory.writeUiSettings as (s: UiSettings) => Promise<void>)(settings),
        });
  // N4 (PLAN-NOTIFY §3.1): the notification centre's stores, one per ID (by folder name) for the
  // life of the process; the record is the ID folder's `notifications.json` in the app host, memory
  // otherwise. Signals are what the server already holds in clear: the approvals waiting (a count),
  // inbound message and file events (contact ID, kind, time), the update state and the relay check.
  // No text, name, file name or link is read for it (I-5, I-7); no MCP tool reaches it (I-4).
  const notificationStores = new Map<string, NotificationStore>();
  let notificationsName: string | undefined;
  const networkDownSince = new Map<string, number>();
  /** The network counts as a problem for the centre only after 10 minutes (PLAN-NOTIFY §3.2). */
  const NETWORK_DOWN_NOTIFY_MS = 10 * 60 * 1000;
  function notificationsPart(bound: ApprovalServerSource): {
    notifications?: LocalUiNotificationsDesk;
  } {
    // The bound ID's folder name (bindAgent sets it before the context is built); one store outside
    // the app host.
    const name = options.host === undefined ? '' : notificationsName;
    if (name === undefined || agentUi === undefined) return {};
    let store = notificationStores.get(name);
    if (store === undefined) {
      const dir = options.host?.directory;
      const readFile = dir?.readNotifications?.bind(dir);
      const writeFile = dir?.writeNotifications?.bind(dir);
      const persistence: NotificationPersistence =
        name !== '' && readFile !== undefined && writeFile !== undefined
          ? { read: () => readFile(name), write: (record) => writeFile(name, record) }
          : memoryNotificationPersistence();
      store = createNotificationStore(persistence, { now: () => now() / 1000 });
      notificationStores.set(name, store);
    }
    const kept = store;
    const client = agentUi.client;
    const signals = async (): Promise<NotificationSignals> => {
      const out: {
        approvals?: number;
        inbound?: readonly NotificationInbound[];
        scannedUntil?: number;
        update?: boolean;
        networkDown?: boolean;
      } = {};
      try {
        out.approvals = (await bound.list())
          .map(view)
          .filter((i) => i !== undefined && !decided.has(i.approvalId)).length;
      } catch {
        // Unknown: the approvals item stays as it was.
      }
      if (client !== undefined) {
        try {
          // IR-NOTIFY-1 M-2: the read starts before the last one ended (store: since), so a
          // message stored late with an older time is still seen; the store counts each once.
          const until = Math.floor(now() / 1000);
          const since = await kept.since();
          if (since <= until) {
            const flow = await client.messages.flowEvents(since, until);
            out.inbound = flow.events
              .filter((e) => e.direction === 'in')
              .map((e) => ({ contactId: e.contactId, kind: e.kind, at: e.at }));
            // A capped read keeps the cursor where it was (the next read covers the rest again).
            if (!flow.capped) out.scannedUntil = until;
          }
        } catch {
          // Nothing new is counted this time; the cursor stays.
        }
      }
      const update = options.appUpdate?.view();
      if (update !== undefined) out.update = update.state === 'available';
      try {
        const health = await uiContext.health?.();
        const relays = health?.relays;
        if (relays !== null && relays !== undefined && health?.agent === 'running') {
          const t = now();
          if (relays.total > 0 && relays.connected === 0) {
            const since = networkDownSince.get(name) ?? t;
            networkDownSince.set(name, since);
            out.networkDown = t - since >= NETWORK_DOWN_NOTIFY_MS;
          } else {
            networkDownSince.delete(name);
            out.networkDown = false;
          }
        }
      } catch {
        // Unknown: the network item stays as it was.
      }
      return out;
    };
    return {
      notifications: Object.freeze<LocalUiNotificationsDesk>({
        list: () => kept.list(),
        refresh: async () => {
          await kept.observe(await signals());
        },
        markRead: (id) => kept.markRead(id),
        markAllRead: () => kept.markAllRead(),
      }),
    };
  }
  /**
   * IR-NOTIFY-1 M-1 (N6): whether the OS approval alert is on. The caller's answer when it gave one
   * (agentlink mcp reads ui-settings.json), else the app host's UI settings, else the D2 default (on).
   * Unreadable settings count as the default.
   */
  /** N7: the switches in force (unreadable settings count as the D2 defaults). */
  async function notifyPrefsNow(): Promise<Record<NotifyPrefKey, boolean>> {
    try {
      if (uiSettingsDesk === undefined) return notifyPrefsInForce(undefined);
      return notifyPrefsInForce((await uiSettingsDesk.read()).notify);
    } catch {
      return notifyPrefsInForce(undefined);
    }
  }
  async function approvalAlertsOn(): Promise<boolean> {
    try {
      if (options.approvalAlerts !== undefined) return await options.approvalAlerts();
      if (uiSettingsDesk === undefined) return true;
      return notifyPrefsInForce((await uiSettingsDesk.read()).notify).approvals;
    } catch {
      return true;
    }
  }
  // WP-P2: every ID's people for the People page. Read only: the open ID through its own client
  // (captured with its name and the generation in one step), every other ID as a count from the
  // read-only store peek (directory.stats); no other KeyStore, client or store is opened (04 §2.5).
  const peopleAllDesk =
    options.host === undefined
      ? undefined
      : createPeopleAllDesk({
          entries: async () => (host === undefined ? [] : await host.directory.list()),
          open: () => {
            const slot = host;
            const name = slot?.current;
            const client = agentUi?.client;
            if (slot === undefined || name === undefined) return undefined;
            return {
              name,
              label: agentLabel ?? name,
              generation: slot.generation,
              contacts: () =>
                client === undefined
                  ? Promise.reject(new Error('no client'))
                  : client.contacts.list(),
            };
          },
          generation: () => host?.generation ?? 0,
          count: async (name) => (await host?.directory.stats(name))?.contacts,
        });
  // REL051-RET1: the read-only Storage view. The open ID through its own client; every other ID as
  // totals from the read-only store peek (directory.storage); no other store or KeyStore is opened.
  const storageDesk =
    options.host === undefined
      ? undefined
      : createStorageDesk({
          entries: async () => (host === undefined ? [] : await host.directory.list()),
          open: () => {
            const slot = host;
            const name = slot?.current;
            const client = agentUi?.client;
            if (slot === undefined || name === undefined) return undefined;
            return {
              name,
              label: agentLabel ?? name,
              generation: slot.generation,
              contacts: () =>
                client === undefined
                  ? Promise.reject(new Error('no client'))
                  : client.contacts.list(),
              dropUsage: async () => {
                const usage = await client?.files.dropUsage();
                return usage === undefined || !usage.available
                  ? undefined
                  : { usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes };
              },
            };
          },
          generation: () => host?.generation ?? 0,
          usage: async (name) => await host?.directory.storage?.(name),
          inbox: async () =>
            agentUi?.client === undefined
              ? undefined
              : await inboxUsageOf(readOnlyClient(agentUi.client)),
        });
  /**
   * WP-R2b (04 §2.3.3 "Kit record"): what `GET /api/ui/backup` and Show in Finder read. Reads only;
   * it signs nothing, opens no other ID's core and reads no keychain item. Built where an ID can
   * save a kit here, or in the app host.
   */
  const backupDeskOf = (
    bound: Omit<LocalUiOptions, 'assets'> | undefined,
  ): LocalUiBackupDesk | undefined => {
    const kit = recoveryKitOf(bound);
    if (kit === undefined && options.host === undefined) return undefined;
    const home = kit?.home ?? internals.restore?.home ?? homedir();
    return Object.freeze<LocalUiBackupDesk>({
      agentlinkDir: join(home, '.agentlink'),
      revealer: fileRevealer,
      ids: async () => {
        const openId = bound?.client?.agentId;
        const slot = host;
        if (slot === undefined) {
          if (kit === undefined) return [];
          return [
            Object.freeze<KitTodayId>({
              name: kit.name,
              label: agentLabel ?? kit.name,
              contacts: null,
              agentId: kit.agentId,
            }),
          ];
        }
        const current = slot.current;
        const entries = (await slot.directory.list()).slice(0, MAX_LISTED_AGENTS);
        const today: KitTodayId[] = [];
        for (const entry of entries) {
          const stats = entry.available
            ? await slot.directory.stats(entry.name).catch(() => undefined)
            : undefined;
          const isOpen = entry.name === current;
          today.push(
            Object.freeze<KitTodayId>({
              name: entry.name,
              label: isOpen ? (agentLabel ?? entry.name) : entry.label,
              contacts: stats?.contacts ?? null,
              ...(entry.removing ? { removing: true } : {}),
              ...(isOpen && openId !== undefined ? { agentId: openId } : {}),
            }),
          );
        }
        return today;
      },
      exportRecorded: async (agentId, signed, kitId) => {
        // Core's word, from the open ID's own core only (another ID's core is never opened here).
        const client = agentUi?.client as
          | {
              agentId?: string;
              ownerActions?: {
                backupExportRecorded?: (signed: unknown, kitId: string) => Promise<boolean>;
              };
            }
          | undefined;
        if (client?.agentId !== agentId) return undefined;
        const actions = client.ownerActions;
        if (typeof actions?.backupExportRecorded !== 'function') return undefined;
        return actions.backupExportRecorded(signed, kitId);
      },
    });
  };

  const buildUiContext = (bound: ApprovalServerSource = source): LocalUiContext =>
    Object.freeze<LocalUiContext>({
      // IR-M1-11s-b-1 H-1: handlers read through a read-only view, never the client itself.
      client: agentUi?.client === undefined ? undefined : readOnlyClient(agentUi.client),
      // M1-11c-a4c: for the presence routes only; core re-verifies the owner signature (I-4).
      ...(agentUi?.client === undefined ? {} : { credits: creditsPort(agentUi.client) }),
      // WP-11: whether the open agent can save a recovery kit here (the source stays here).
      recoveryKitAvailable: recoveryKitOf(agentUi) !== undefined,
      // WP-R2b: the kit record and Show in Finder for it (reads only; no path is ever answered).
      ...(() => {
        const backup = backupDeskOf(agentUi);
        return backup === undefined ? {} : { backup };
      })(),
      // W4-FILES-SAVE: for the save owner route only; core takes only a `file.save` and re-verifies
      // the owner signature before it saves (I-4).
      ...(agentUi?.client === undefined ? {} : { fileSave: fileSavePort(agentUi.client) }),
      // REL051-A34: the in-app preview's checked read (the route passes only store values).
      previewRead,
      // UX2-d1: accepting an invite, for the accept owner route; it pairs only after core used an
      // owner-signed, applied approval (I-4).
      ...(agentUi?.client === undefined ? {} : { invites: inviteAcceptPort(agentUi.client) }),
      ownerContext: () => bound.context(),
      applyOwnerAction: (signed) => bound.apply(signed),
      now: () => now(),
      // M1-11s-a-d: the status bar's health read (fixed fields, cached, bounded).
      health: createHealthReader({
        // REL051-CF2: with no source wired, the open agent's own relay check (network-health.ts),
        // so the app never says Connected while no relay can be reached.
        ...(() => {
          if (agentUi?.health !== undefined) return { source: agentUi.health };
          const client = agentUi?.client as Partial<NetworkHealthClient> | undefined;
          if (typeof client?.relayReachability !== 'function') return {};
          return {
            source: networkHealthSource(client as NetworkHealthClient, { now: () => now() }),
          };
        })(),
        hasClient: agentUi?.client !== undefined,
        // REL051-B3b: the app host's version when the page options carry none (the strip's Version).
        ...(() => {
          const version = options.localUi?.version ?? options.host?.version;
          return version === undefined ? {} : { version };
        })(),
        ...(options.localUi?.dataFolder === undefined
          ? {}
          : { dataFolder: options.localUi.dataFolder }),
        startedAt: serverStartedAt,
        now: () => now(),
      }),
      // U3-c: the Agents list, in the app host only.
      ...(options.host === undefined ? {} : { agents: { list: () => listAgents() } }),
      ...(peopleAllDesk === undefined ? {} : { peopleAll: peopleAllDesk }),
      ...(storageDesk === undefined ? {} : { storage: storageDesk }),
      // DESK051-UPD: the desktop host's update state (no agent needed).
      ...(options.appUpdate === undefined ? {} : { appUpdate: options.appUpdate }),
      // W4-SHELL-V2: the app's UI settings, in the app host only (one desk for every context).
      ...(uiSettingsDesk === undefined ? {} : { uiSettings: uiSettingsDesk }),
      // N4: the open ID's notification centre (kind, ref, count and times only).
      ...notificationsPart(bound),
      // U3-d: create an agent and save a verified label, in the app host only.
      ...(options.host === undefined ? {} : { agentsManage }),
      // U3-invite: the waiting invite, in the app host only.
      ...(joinDesk === undefined ? {} : { join: joinDesk }),
      // U3-invite-b: the join screen's lease-gated pass, captured with this context's agent.
      ...(follower === undefined ? {} : { followPairing: follower.follow }),
      // U3-g-b (IR-U3-g-b-1 L): with no agent yet, the first-run page's owner state is the real one.
      // F2: also when the host has no first-run port (started with an agent, then none open after a
      // failed switch): setupBlockedNoAgent is then true, so the page never offers a second owner.
      ...(agentUi === undefined && options.host !== undefined
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
  // UX1113-R1 (D-147; 04 §2.3.3 "Restore in the app"): the restore engine of the restore gate. Its
  // only caller is restoreGate below (and WP-R2's export route, through registerExportedKit).
  let restoreInstance: RestoreEngine | undefined;
  const restoreEngine = (): RestoreEngine =>
    (restoreInstance ??= createRestoreEngine({
      home: internals.restore?.home ?? homedir(),
      keychain: keychainOf,
      origin,
      now,
      ...(internals.restore?.kdf === undefined ? {} : { kdf: internals.restore.kdf }),
      ...(internals.restore?.keychainTimeoutMs === undefined
        ? {}
        : { keychainTimeoutMs: internals.restore.keychainTimeoutMs }),
      knownOwnerNostr: async () => {
        if (noAgentOpen()) return undefined;
        return (await source.context().catch(() => undefined))?.owner.ownerNostr;
      },
      onRestored: async (names) => {
        // First run with no agent open: the app opens the first restored ID.
        const first = names[0];
        if (host !== undefined && host.current === undefined && first !== undefined) {
          await host.adoptFirst(first).catch(() => false);
        }
      },
      // REL051-SF3 (04 §2.5): wrong proofs on restore presence count on the shared backoff.
      presenceBackoff: {
        waitSeconds: () => waitSeconds(),
        failed: () => {
          presenceFailed();
        },
        succeeded: () => {
          presenceSucceeded();
        },
      },
    }));
  // REL051-SF3 (T-7): stale uploads and quarantined stores of a crashed run go at start-up, not on
  // a first restore request. Files a live engine (this or another process) still uses are kept.
  if (internals.sweepRestoreAtStart === true || internals.restore?.home !== undefined) {
    const restoreHome = internals.restore?.home ?? homedir();
    void removeStaleRestoreFiles(join(restoreHome, '.agentlink', 'restore')).catch(() => undefined);
  }
  /**
   * REL051-CF3 (R1-CLASS-03/04; T-7): where the unsaved-master-code marker lives: the restore home
   * (a test's) or, in the shipped server, this user's home. Undefined: no marker is written or read
   * (a test server without a home never touches the real one).
   */
  const markerHome =
    internals.restore?.home ?? (internals.sweepRestoreAtStart === true ? homedir() : undefined);
  /**
   * REL051-CF3 (R1-CLASS-04): at start-up an owner item a restore wrote whose code never left a
   * server that is gone is rolled back to "Finish restoring" (recovery-kit-restore.ts settle). Every
   * /api/ui/ request waits for it, so no page reads the state before it is settled.
   */
  const settled: Promise<void> =
    markerHome === undefined
      ? Promise.resolve()
      : Promise.race([
          restoreEngine().settle(),
          // Never holds the app back for long: a keychain that does not answer leaves it as is.
          new Promise<void>((resolve) => setTimeout(resolve, SETTLE_WAIT_MS).unref()),
        ]);

  /**
   * WP-R2b (04 §2.3.3 "In the local app"; §2.5 "KeyStore isolation"): the recovery-kit export's walk
   * over this owner's other IDs in the app host, inside the one owner operation only (after the
   * gesture; nothing of another ID is opened before it). The listed IDs (not the open one, not one
   * being removed) are visited through the slot's visitOthers: one core open at any time, each
   * closed before the next, the open ID opened again at the end. A keychain ID of this home gives its
   * own core's prepare and apply; an ID that cannot be opened here or has no recovery-kit source
   * (a file-KeyStore ID) is named in `notIncluded`, as is any beyond the 16 IDs of one kit.
   */
  const otherIdsOf = (open: LocalUiRecoveryKitSource): RecoveryKitOthers =>
    Object.freeze<RecoveryKitOthers>({
      each: async (step, bounds) => {
        const slot = host;
        if (slot === undefined) return { ok: true, notIncluded: [] };
        let entries: readonly AgentDirectoryEntry[];
        try {
          entries = (await slot.directory.list()).slice(0, MAX_LISTED_AGENTS);
        } catch {
          return { ok: false, notIncluded: [] };
        }
        // IR L-1: each ID left out carries its reason; only a file-KeyStore ID can be backed up in
        // the terminal. A file-KeyStore ID is never opened here (it would need its passphrase).
        const notIncluded: RecoveryKitNotIncluded[] = [];
        const names: string[] = [];
        for (const entry of entries) {
          if (entry.name === open.name || entry.name === slot.current || entry.removing) continue;
          if (entry.keyStore === 'file') {
            notIncluded.push({ name: entry.name, reason: 'file_keystore' });
          } else if (!entry.available) {
            notIncluded.push({ name: entry.name, reason: 'could_not_open' });
          } else if (names.length >= MAX_KIT_IDS - 1) {
            notIncluded.push({ name: entry.name, reason: 'over_limit' });
          } else {
            names.push(entry.name);
          }
        }
        if (names.length === 0) return { ok: true, notIncluded };
        // IR M-1: each open and each step bounded by the per-ID limit and the export's budget.
        const stepMs = (): number =>
          Math.min(internals.backupWalk?.stepMs ?? VISIT_STEP_MS, bounds.deadlineAt - now());
        const walked = await slot.visitOthers(
          names,
          async (name, agent) => {
            const kit = agent === undefined ? undefined : recoveryKitOf(agent.localUi);
            const client = agent?.localUi.client as unknown as RecoveryKitClient | undefined;
            if (
              agent === undefined ||
              kit === undefined ||
              client === undefined ||
              kit.home !== open.home ||
              kit.name !== name
            ) {
              // Opened, but no recovery-kit source: the CLI gives one to keychain IDs only.
              const fileKeyStore = agent !== undefined && kit === undefined && client !== undefined;
              notIncluded.push({ name, reason: fileKeyStore ? 'file_keystore' : 'could_not_open' });
              return true;
            }
            const apply = (signed: { readonly body: JsonObject; readonly sig: string }) =>
              agent.source.apply(signed);
            return step({
              source: { agentId: kit.agentId, name: kit.name, storePath: kit.storePath },
              prepareBackupExport: (kitId, contents) =>
                client.ownerActions.prepareBackupExport(kitId, contents),
              apply,
            });
          },
          {
            stepMs,
            ...(internals.backupWalk?.settleMs === undefined
              ? {}
              : { settleMs: internals.backupWalk.settleMs }),
            ...(internals.backupWalk?.reopenMs === undefined
              ? {}
              : { reopenMs: internals.backupWalk.reopenMs }),
          },
        );
        return { ok: walked.ok, notIncluded };
      },
    });

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

  /** F40: how many one-shot links were used (a count only, for the CLI's "didn't open" check). */
  let linksUsed = 0;

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
    const live = link !== undefined && now() < link.expiresAt;
    if (live) linksUsed += 1;
    return live;
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

  // REL051-INTFIX: `expired` is the 401 page; an approval link gets the one that points to Approvals.
  const reject = (
    res: ServerResponse,
    status: number,
    reason: RejectReason,
    expired: string = EXPIRED_HTML,
  ): void => {
    emit({ kind: 'rejected', reason });
    if (status === 401) {
      sendText(res, 401, 'text/html; charset=utf-8', expired);
    } else {
      sendJson(res, status, { status: 'refused' });
    }
  };

  /** UX1113-QA-HOST: the fixed "Page not found · Go to Home" page (404; nothing from the request). */
  const notFoundPage = (res: ServerResponse): void => {
    emit({ kind: 'rejected', reason: 'not_found' });
    sendText(res, 404, 'text/html; charset=utf-8', NOT_FOUND_HTML);
  };

  /** The app's index.html with this server's CSRF token (and generation) filled in. */
  const sendShell = (res: ServerResponse, status: 200 | 404): void => {
    const shell = localUi.shell;
    if (shell === undefined) return notFoundPage(res);
    // The token is base64url, so it needs no escaping.
    const meta =
      `<meta name="agentlink-csrf" content="${csrf}">` +
      // U3-c: the generation the page is built against (a decimal number, no escaping needed).
      (host === undefined
        ? ''
        : `<meta name="agentlink-generation" content="${String(host.generation)}">`);
    sendText(res, status, 'text/html; charset=utf-8', `${shell.before}${meta}${shell.after}`);
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
    const native = mode === 'native';
    if (mode !== undefined && !passkey && !native) {
      finishDecision(res, 403, 'presence_required');
      req.resume();
      return;
    }
    if (native && nativeHelper === undefined) {
      finishDecision(res, 403, 'presence_required', NO_NATIVE);
      req.resume();
      return;
    }
    const body = await boundedBody(
      req,
      res,
      passkey ? MAX_PAY_CONFIRM_ASSERTION_BYTES : MAX_SECRET_BYTES,
    );
    if (body === undefined) return;
    const ids = picks.map((p) => p.approvalId);
    const listed = (items: readonly string[]): Record<string, unknown> => (review ? { items } : {});
    // Every secret byte this request carried; wiped whatever happens (unlock also wipes its copy).
    let proof: CeremonyProof | undefined;
    let assertion: PasskeyAssertion | undefined;
    let presence: OwnerPresence | undefined;
    try {
      // DESK-D12c: the native presence kind carries no bytes; every other kind needs some.
      if (native ? body.length !== 0 : body.length === 0) {
        finishDecision(res, 403, 'presence_required');
        return;
      }
      if (passkey) {
        // REL051-SF1: the ceremony this gesture answers (this approval, digest or list) is taken
        // (spent) before any await. A PRF-less authenticator never gets this far: the page offers
        // the master code.
        proof = takeCeremonyProof(req, body);
        if (proof === undefined) {
          finishDecision(res, 403, 'presence_required');
          return;
        }
        assertion = proof.assertion;
      }
      // DESK051-C6: a native gesture answers this request's native ceremony, spent here (before any
      // await and before the helper runs): a replayed native request is refused.
      if (native && !takeNativeCeremony(req)) {
        finishDecision(res, 403, 'presence_required');
        return;
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
        if (native) {
          // DESK-D12c: one helper gesture for this one decision (or review list), after every check.
          const got = await nativeFor(context.owner.ownerNostr, 'approve', req, res);
          if (!('presence' in got)) {
            finishDecision(res, got.http, 'presence_rejected', { native: got.state });
            return;
          }
          presence = got.presence;
        } else if (proof !== undefined) {
          // 04 §2.3.1: the assertion names the stored credential, the owner as user handle, RP ID
          // localhost and UP and UV, before its PRF output is used at all; REL051-SF1: it answers
          // this request's ceremony and is signed by the stored passkey.
          const check = await checkCeremonyProof(proof, context.owner.ownerNostr);
          if (check === 'passkey_update_needed' || check === 'verification_required') {
            finishDecision(res, check === 'passkey_update_needed' ? 409 : 403, check);
            return;
          }
          if (check !== 'ok') {
            presenceFailed();
            finishDecision(res, 403, 'presence_rejected');
            return;
          }
          presence = { kind: 'passkey-prf', prfOutput: proof.assertion.prfOutput };
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
          if (error instanceof KeyStoreError && error.code === 'presence_rejected' && native) {
            finishDecision(res, NATIVE_HTTP.damaged, 'presence_rejected', { native: 'damaged' });
          } else if (error instanceof KeyStoreError && error.code === 'presence_rejected') {
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
      wipeCeremonyProof(proof);
      wipeNative(presence);
    }
  }

  // --- DESK-D12c: native presence (04 §2.3.4, §2.5 phase 2) ------------------------------------
  const nativeHelper: NativeHelper | undefined = options.nativePresence;
  /** DESK-NATIVE-DEBUG: one fixed line (see ApprovalServerOptions.diagnose). */
  const nativeDiagnostic = (line: string): void => {
    try {
      options.diagnose?.(`native presence: ${line}`);
    } catch {
      // Diagnostics never change the outcome.
    }
  };
  /**
   * DESK-TOUCHID-FIX review (Fable M-1): the abort of the native presence operation in progress (one
   * at a time: `busy`), for POST /api/owner/native/cancel.
   */
  let nativeInProgress: AbortController | undefined;
  /** Aborts `stop` when the page goes away before the answer; returns the cleanup. */
  const abortOnClose = (
    req: IncomingMessage,
    res: ServerResponse,
    stop: AbortController,
  ): (() => void) => {
    const abandon = (): void => {
      if (!res.writableFinished) stop.abort();
    };
    req.once('close', abandon);
    res.once('close', abandon);
    nativeInProgress = stop;
    return () => {
      req.off('close', abandon);
      res.off('close', abandon);
      if (nativeInProgress === stop) nativeInProgress = undefined;
    };
  };
  /** The answer when the page asks for native presence where there is no helper (not the app). */
  const NO_NATIVE = Object.freeze({ native: 'unavailable' });

  /**
   * One native presence for one owner operation, for `ownerNostr`, after every check of the request:
   * the helper runs once with `reason`. A refusal is a fixed state with its HTTP status.
   */
  async function nativeFor(
    ownerNostr: Uint8Array,
    reason: NativeReason,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<
    | { readonly presence: OwnerPresence }
    | { readonly http: number; readonly state: NativeAnswerState }
  > {
    if (nativeHelper === undefined) return { http: NATIVE_HTTP.unavailable, state: 'unavailable' };
    // Fable review L1: when the page goes away (the client disconnects, the sheet is abandoned) the
    // helper is killed, its OS prompt closes, `busy` is released by the gate's own finally, and a
    // touch that still arrives approves nothing.
    const abandoned = new AbortController();
    const cleanup = abortOnClose(req, res, abandoned);
    try {
      return {
        presence: await nativePresence(keychainOf(), nativeHelper, ownerNostr, reason, {
          signal: abandoned.signal,
        }),
      };
    } catch (error) {
      const state: NativeAnswerState =
        error instanceof NativeHelperError
          ? error.state
          : error instanceof KeyStoreError && error.code === 'presence_rejected'
            ? 'not_registered'
            : 'keychain';
      nativeDiagnostic(`${reason} failed (${nativeFailureReason(error)})`);
      return { http: NATIVE_HTTP[state], state };
    } finally {
      cleanup();
    }
  }

  /**
   * HOTFIX-NOID (04 §2.8 "No ID on this computer yet"): true when New ID may run with no card naming
   * the owner: no ID is open, no ID folder is listed (an unreadable or half-removed one never leads
   * here, M1-9x), and the owner item exists. Rejects on errors (callers fail closed).
   */
  async function firstIdForOwner(): Promise<boolean> {
    const slot = host;
    if (slot === undefined || slot.current !== undefined) return false;
    if ((await slot.directory.list()).length > 0) return false;
    return ownerItemPresent(keychainOf());
  }

  /**
   * HOTFIX-NOID: the owner key the stored Touch ID (`owner-native` header) names, only while New ID
   * may run with no card (firstIdForOwner). Public data; the helper's secret must still open the
   * blob to a seed deriving exactly this key (unlockForOwnerNostr).
   */
  async function noCardOwnerNostr(): Promise<Uint8Array | undefined> {
    if (!(await firstIdForOwner())) return undefined;
    const header = await readOwnerNativeHeader(keychainOf());
    return header === null ? undefined : header.ownerNostr;
  }

  /**
   * HOTFIX-NOID: true unless a stored Touch ID (`owner-native`) or passkey (`owner-passkey`) header
   * names another owner key than `found` (public headers; a damaged one refuses). Fails closed.
   */
  async function sameStoredOwner(found: OwnerPublicKeys): Promise<boolean> {
    try {
      const native = await readOwnerNativeHeader(keychainOf());
      if (native !== null && !equalBytes(native.ownerNostr, found.ownerNostr)) return false;
      const passkeyHeader = await readOwnerPasskeyHeader(keychainOf());
      if (passkeyHeader !== null && !equalBytes(passkeyHeader.ownerNostr, found.ownerNostr)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** The native secret of a presence that was not handed to an unlock (unlock wipes its own). */
  const wipeNative = (presence: OwnerPresence | undefined): void => {
    if (presence?.kind === 'native') wipe(presence.secret);
  };

  /** GET /api/owner/native: whether this computer's helper is here and registered for the owner. */
  async function nativeInfo(res: ServerResponse): Promise<void> {
    if (nativeHelper === undefined) {
      sendJson(res, 200, { native: { available: false, registered: false } });
      return;
    }
    const context = noAgentOpen() ? undefined : await source.context().catch(() => undefined);
    // HOTFIX-NOID: with no ID on this computer no card names the owner, so the stored Touch ID is
    // the owner's own (the one owner item here; a gesture still has to open it to that owner).
    const ownerNostr =
      context?.owner.ownerNostr ?? (await noCardOwnerNostr().catch(() => undefined));
    const status = await nativePresenceStatus(keychainOf(), nativeHelper, ownerNostr).catch(
      (): NativePresenceStatus => ({ available: false, registered: false }),
    );
    sendJson(res, 200, {
      native: {
        available: status.available,
        registered: status.registered,
        ...(status.reason === undefined ? {} : { reason: status.reason }),
        platform: nativeHelper.kind === 1 ? 'mac' : 'windows',
      },
    });
  }

  /**
   * POST /api/owner/native: turns on native presence, its own owner operation (04 §2.3.4
   * "Registration"): the master code as the body, or a passkey assertion with
   * `X-AgentLink-Presence: passkey`; then the helper's one gesture. Signs nothing.
   */
  async function nativeRegister(
    req: IncomingMessage,
    res: ServerResponse,
    op: 'register' | 'off' | 'replace' = 'register',
  ): Promise<void> {
    const reply = (status: number, outcome: string, extra: Record<string, unknown> = {}): void => {
      emit({ kind: 'owner_operation', outcome: status === 200 ? 'done' : 'failed' });
      sendJson(res, status, { status: outcome, ...extra });
    };
    if (waiting(req, res, 'passkey')) return;
    const mode = header(req, 'x-agentlink-presence');
    const passkey = mode === 'passkey';
    if (mode !== undefined && !passkey) {
      req.resume();
      reply(403, 'presence_required');
      return;
    }
    const helper = nativeHelper;
    if (helper === undefined) {
      req.resume();
      reply(409, 'native_unavailable');
      return;
    }
    const body = await boundedBody(
      req,
      res,
      passkey ? MAX_PAY_CONFIRM_ASSERTION_BYTES : MAX_SECRET_BYTES,
    );
    if (body === undefined) return;
    let proof: CeremonyProof | undefined;
    try {
      if (body.length === 0) {
        reply(403, 'presence_required');
        return;
      }
      if (passkey) {
        // REL051-SF1 / DESK051-C6: the passkey answers a ceremony for exactly this request, taken
        // (spent) before any await.
        proof = takeCeremonyProof(req, body);
        if (proof === undefined) {
          reply(403, 'presence_required');
          return;
        }
      }
      if (busy) {
        reply(409, 'busy');
        return;
      }
      busy = true;
      try {
        const context = await source.context();
        if (context === undefined) {
          reply(503, 'needs_setup');
          return;
        }
        let presence: OwnerPresence;
        if (proof !== undefined) {
          const check = await checkCeremonyProof(proof, context.owner.ownerNostr);
          if (check === 'passkey_update_needed' || check === 'verification_required') {
            reply(check === 'passkey_update_needed' ? 409 : 403, check);
            return;
          }
          if (check !== 'ok') {
            presenceFailed();
            reply(403, 'presence_rejected');
            return;
          }
          presence = { kind: 'passkey-prf', prfOutput: proof.assertion.prfOutput };
        } else {
          presence = { kind: 'passphrase', secret: body };
        }
        // DESK-NATIVE-DEBUG: the step reached, for the one diagnostic line of this operation.
        const name = op === 'off' ? 'turn_off' : op;
        let step: NativeStep | 'presence' = 'presence';
        // DESK-TOUCHID-FIX review (Fable M-1): Cancel, or the page going away, stops the helper.
        const stop = new AbortController();
        const cleanup = abortOnClose(req, res, stop);
        const steps = {
          onStep: (next: NativeStep): void => {
            step = next;
          },
          signal: stop.signal,
        };
        nativeDiagnostic(`${name} started`);
        /**
         * DESK-TOUCHID-FIX review (Fable L-2): on again removes the old one first; a failure after
         * that leaves it off, and the answer says so (never "nothing was changed").
         */
        const nowOff = (): Record<string, unknown> =>
          op === 'replace' && step !== 'presence' && step !== 'master_code' && step !== 'remove_old'
            ? { nowOff: true }
            : {};
        try {
          // Each wipes the presented bytes, whether or not it succeeds. None takes native presence.
          if (op === 'off') {
            await turnOffOwnerNative(keychainOf(), helper, context.owner, presence, steps);
          } else if (op === 'replace') {
            await replaceOwnerNative(keychainOf(), helper, context.owner, presence, steps);
          } else await registerOwnerNative(keychainOf(), helper, context.owner, presence, steps);
        } catch (error) {
          nativeDiagnostic(`${name} failed at ${step} (${nativeFailureReason(error)})`);
          if (error instanceof NativeHelperError) {
            reply(NATIVE_HTTP[error.state], 'presence_rejected', {
              native: error.state,
              ...nowOff(),
            });
            return;
          }
          const code = (error as { code?: unknown } | null)?.code;
          if (code === 'owner_native_exists') reply(409, 'native_exists');
          else if (code === 'owner_native_missing') reply(409, 'native_missing');
          else if (code === 'presence_rejected') {
            presenceFailed();
            reply(403, 'presence_rejected');
          } else if (code === 'presence_required') reply(403, 'presence_required');
          else if (code === 'owner_missing') reply(503, 'needs_setup');
          // DESK-NATIVE-DEBUG: the keychain did not answer or refused: its own message, not "error".
          else if (code === 'keychain_failed') {
            // Fable review L-1: a write that may still have landed is its own answer.
            const unsure = (error as { detail?: unknown }).detail === 'unsure';
            reply(NATIVE_HTTP.keychain, 'failed', {
              native: unsure ? 'keychain_unsure' : 'keychain',
              ...nowOff(),
            });
          } else reply(500, 'failed', nowOff());
          return;
        } finally {
          cleanup();
        }
        nativeDiagnostic(`${name} done`);
        presenceSucceeded();
        reply(200, op === 'off' ? 'off' : 'registered');
      } finally {
        busy = false;
      }
    } finally {
      wipe(body);
      wipeCeremonyProof(proof);
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
    // Read once: a switch between two reads must not turn a no-agent answer into a 503.
    const none = noAgentOpen();
    const context = none ? undefined : await source.context();
    if (context === undefined && !none) {
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
   * one entry of the master code, no signature; the code, the PRF output and the seed are wiped.
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
      sendJson(res, 500, failedBody());
      return;
    }
    sendJson(res, result.status, result.body);
  };

  // --- REL051-SF1: the single-use, action-bound challenge of a passkey proof (presence-ceremony.ts) --

  const ceremonies = new PresenceCeremonies(() => now());

  /** The page session (its held bytes) a request carries, or undefined. */
  const sessionOf = (req: IncomingMessage): Uint8Array | undefined => {
    const at = matchIndex(cookieToken(req), sessions);
    return at < 0 ? undefined : sessions[at];
  };

  /** What a ceremony is bound to: the method, the target and the action headers, as sent. */
  const bindingOf = (req: IncomingMessage): Uint8Array =>
    presenceBinding({
      method: req.method ?? '',
      target: req.url ?? '',
      input: header(req, 'x-agentlink-input'),
      items: header(req, 'x-agentlink-items'),
      digest: header(req, 'x-agentlink-digest'),
      generation: header(req, 'x-agentlink-generation'),
    });

  /**
   * The kind of ceremony the request asks for (`X-AgentLink-Presence: challenge` for a passkey,
   * `native-challenge` for the desktop app's native gesture, DESK051-C6), or undefined.
   */
  const asksChallenge = (req: IncomingMessage): PresenceCeremonyKind | undefined => {
    const mode = header(req, 'x-agentlink-presence');
    return mode === PRESENCE_CHALLENGE_MODE
      ? 'passkey'
      : mode === NATIVE_CHALLENGE_MODE
        ? 'native'
        : undefined;
  };

  /**
   * Answers a ceremony request for the route this request names (it is never acted on): an empty
   * body, the wrong-code wait, a stored passkey with its credential key, then a new ceremony bound to
   * this page session and this request. Nothing is unlocked, counted or emitted; the answer carries
   * the WebAuthn request values and nothing else (I-7).
   */
  async function presenceChallenge(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (header(req, PRESENCE_CEREMONY_HEADER) !== undefined) {
      req.resume();
      sendJson(res, 400, { status: 'invalid' });
      return;
    }
    // At most one byte is read: anything but an empty body is refused.
    const body = await boundedBody(req, res, 1);
    if (body === undefined) return;
    if (body.length !== 0) {
      wipe(body);
      sendJson(res, 400, { status: 'invalid' });
      return;
    }
    const wait = waitSeconds();
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      sendJson(res, 429, { status: 'wait', retryAfter: wait });
      return;
    }
    const session = sessionOf(req);
    if (session === undefined) {
      sendJson(res, 401, { error: 'token' });
      return;
    }
    if (asksChallenge(req) === 'native') {
      // DESK051-C6: a ceremony for the desktop app's native gesture. Only where this computer has
      // the presence helper; the server runs the gesture itself, so only the ceremony ID goes back
      // (no challenge leaves the server). Whether native presence is turned on is checked when the
      // gesture is asked for, as before.
      if (nativeHelper === undefined) {
        sendJson(res, 403, { status: 'presence_required', ...NO_NATIVE });
        return;
      }
      ceremonies.sweep((held) => sessions.some((s) => equalBytes(s, held)));
      const ceremony = ceremonies.issue(session, bindingOf(req), 'native');
      sendJson(res, 200, {
        status: 'ready',
        ceremony: ceremony.id,
        expiresInMs: PRESENCE_CEREMONY_TTL_MS,
      });
      return;
    }
    let credentialId: Uint8Array | undefined;
    let keyKept = false;
    try {
      const stored = await readOwnerPasskeyHeader(keychainOf());
      if (stored !== null) {
        credentialId = stored.credentialId;
        keyKept = (await readOwnerPasskeyKey(keychainOf(), stored.credentialId)) !== null;
      }
    } catch {
      credentialId = undefined;
    }
    if (credentialId === undefined) {
      sendJson(res, 403, { status: 'presence_required' });
      return;
    }
    if (!keyKept) {
      // No kept credential key: a gesture could not be verified, so the passkey path is refused.
      sendJson(res, 409, { status: 'passkey_update_needed' });
      return;
    }
    ceremonies.sweep((held) => sessions.some((s) => equalBytes(s, held)));
    const ceremony = ceremonies.issue(session, bindingOf(req));
    sendJson(res, 200, {
      status: 'ready',
      ceremony: ceremony.id,
      expiresInMs: PRESENCE_CEREMONY_TTL_MS,
      publicKey: {
        rpId: PASSKEY_RP_ID,
        challenge: encodeBase64url(ceremony.challenge),
        allowCredentials: [encodeBase64url(credentialId)],
        userVerification: 'required',
        timeoutMs: PRESENCE_CEREMONY_TTL_MS,
        prfSalt: encodeBase64url(ownerPrfSalt()),
      },
    });
  }

  /** A passkey proof taken with its ceremony: the assertion and the challenge it must answer. */
  interface CeremonyProof {
    readonly assertion: PayConfirmAssertion;
    readonly challenge: Uint8Array;
  }

  /**
   * Parses a passkey body and takes the ceremony it names (single use, before any await). Undefined
   * (`presence_required`) when the body is malformed, no ceremony is named, or the ceremony is
   * unknown, another session's, expired or bound to another request.
   */
  const takeCeremonyProof = (req: IncomingMessage, body: Uint8Array): CeremonyProof | undefined => {
    const session = sessionOf(req);
    const id = header(req, PRESENCE_CEREMONY_HEADER);
    if (session === undefined || id === undefined) return undefined;
    const taken = ceremonies.take(id, session, bindingOf(req));
    if (typeof taken === 'string') return undefined;
    const challenge = taken.challenge.slice();
    PresenceCeremonies.wipeOf(taken);
    const assertion = parsePayConfirmAssertion(body);
    if (assertion === undefined) {
      wipe(challenge);
      return undefined;
    }
    return { assertion, challenge };
  };

  /**
   * DESK051-C6 (04 §2.5): takes the native ceremony a native request names (single use, before any
   * await, before the helper runs). False (`presence_required`) when no ceremony is named, or it is
   * unknown, another session's, expired, bound to another request or a passkey ceremony; it is spent
   * whatever the outcome, so a replayed native request never starts a second OS sheet.
   */
  const takeNativeCeremony = (req: IncomingMessage): boolean => {
    const session = sessionOf(req);
    const id = header(req, PRESENCE_CEREMONY_HEADER);
    if (session === undefined || id === undefined) return false;
    const taken = ceremonies.take(id, session, bindingOf(req), 'native');
    if (typeof taken === 'string') return false;
    PresenceCeremonies.wipeOf(taken);
    return true;
  };

  /**
   * The assertion of a taken ceremony against the stored passkey, its kept credential key and the
   * owner (pay-confirm.ts checkPayConfirmAssertion: type, challenge, origin, rpIdHash, UP, credential,
   * user handle, signature, UV). The challenge is wiped.
   */
  async function checkCeremonyProof(
    proof: CeremonyProof,
    ownerNostr: Uint8Array,
  ): Promise<'ok' | 'presence_rejected' | 'verification_required' | 'passkey_update_needed'> {
    try {
      const stored = await readOwnerPasskeyHeader(keychainOf());
      if (stored === null) return 'presence_rejected';
      const check = checkPayConfirmAssertion(proof.assertion, {
        challenge: proof.challenge,
        origin,
        passkey: stored,
        publicKey: await readOwnerPasskeyKey(keychainOf(), stored.credentialId),
        owner: { ownerNostr },
      });
      if (check === 'key_missing') return 'passkey_update_needed';
      if (check !== 'ok') return check;
      assertPasskeyAssertion(stored, { ownerNostr }, proof.assertion);
      return 'ok';
    } catch {
      return 'presence_rejected';
    } finally {
      wipe(proof.challenge);
    }
  }

  /** Wipes a ceremony proof's bytes (the challenge, the signature, the PRF output once used). */
  const wipeCeremonyProof = (proof: CeremonyProof | undefined): void => {
    if (proof === undefined) return;
    wipe(proof.challenge, proof.assertion.prfOutput, proof.assertion.signature);
  };

  /**
   * M1-11s-b, the central presence gate for a /api/ui/ owner route (04 §2.5, I-4; IR-M1-11s-b-1 H-1).
   * Owner presence is verified before `run` (the handler) is called: the wrong-code backoff, a
   * presence proof in the body (the master code, or a passkey assertion verified against the stored
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
      /**
       * HOTFIX-045-REMOVE (GAP B only): the owner is known only by this 32-byte Nostr key, from a
       * verified revoked-list entry, because no agent card can be read. No context is read; the
       * stored owner is unlocked by that key (KeychainOwnerKeyStore.unlockForOwnerNostr), with the
       * same presence, and its other keys come from the unlocked seed.
       */
      readonly ownerNostr?: Uint8Array;
      /**
       * WP-11: the recovery-kit export route (route-types.ts `recoveryKit`). The owner store is
       * unlocked for an export (unlockForExport), `sign` refuses everything and the operation
       * offers `exportRecoveryKit` for the open agent's recovery-kit source instead.
       */
      readonly recoveryKit?: true;
      /**
       * UX1113 WP-S2 (04 §2.5 "Touch ID & master code page"): an owner-code step. Each takes one
       * kind of proof (owner-code-paths.ts); `check` and `test` close the session before the handler
       * and sign nothing; `replace` stages a new code; `finish` opens the staged item with the code
       * typed back instead of the owner store; `cancel` takes no proof. `session` is the request's
       * page session cookie, which a staged change is bound to.
       */
      readonly ownerCode?: LocalUiOwnerCodeStep;
      readonly session?: string;
      /**
       * WP-R2b: the page session (its cookie value), for the recovery-kit export only: the restore
       * engine binds the export handle for Check to it (registerExportedKit).
       */
      readonly pageSession?: string;
    } = {},
  ): Promise<void> {
    if (gate.ownerCode === 'cancel') {
      // WP-S2 (IR L-1, L-4): Cancel takes no proof, so the wrong-code wait does not hold it back
      // (it only removes this session's own staged change); it runs inside `busy`, so it never
      // races a finish: one of them answers `busy`.
      req.resume();
      if (header(req, 'x-agentlink-presence') !== undefined) {
        finishOwner(res, 403, 'presence_required');
        return;
      }
      if (busy) {
        finishOwner(res, 409, 'busy');
        return;
      }
      busy = true;
      try {
        const session = gate.session === undefined ? undefined : encodeUtf8(gate.session);
        const dropped = session !== undefined && (await ownerCodes.cancel(session));
        finishOwner(res, dropped ? 200 : 409, dropped ? 'cancelled' : 'not_pending');
      } catch {
        finishOwner(res, 500, 'failed');
      } finally {
        busy = false;
      }
      return;
    }
    const wait = waitSeconds();
    if (wait > 0) {
      req.resume();
      res.setHeader('Retry-After', String(wait));
      finishOwner(res, 429, 'wait', { retryAfter: wait });
      return;
    }
    const mode = header(req, 'x-agentlink-presence');
    const passkey = mode === 'passkey';
    const native = mode === 'native';
    if (mode !== undefined && !passkey && !native) {
      req.resume();
      finishOwner(res, 403, 'presence_required');
      return;
    }
    if (native && nativeHelper === undefined) {
      req.resume();
      finishOwner(res, 403, 'presence_required', NO_NATIVE);
      return;
    }
    const codeStep = gate.ownerCode;
    if (codeStep !== undefined) {
      // WP-S2: the step's one kind of proof, before the body is read or anything is opened.
      // DESK051-C2: native presence carries no typed code and no passkey assertion, so of the
      // owner-code steps it is taken by Test Touch ID (the desktop app's own Touch ID) and Replace
      // (any presence) only; never by Check or finish (owner-code-paths.ts).
      const kind = native ? 'native' : passkey ? 'passkey' : 'code';
      if (!ownerCodeProofAllowed(codeStep, kind)) {
        req.resume();
        finishOwner(res, 403, 'presence_required');
        return;
      }
    }
    const body = await boundedBody(
      req,
      res,
      passkey ? MAX_PAY_CONFIRM_ASSERTION_BYTES : MAX_SECRET_BYTES,
    );
    if (body === undefined) return;
    let proof: CeremonyProof | undefined;
    let assertion: PasskeyAssertion | undefined;
    let nativeHeld: OwnerPresence | undefined;
    try {
      // DESK-D12c: the native presence kind carries no bytes; every other kind needs some.
      if (native ? body.length !== 0 : body.length === 0) {
        finishOwner(res, 403, 'presence_required');
        return;
      }
      if (passkey) {
        // REL051-SF1: the ceremony this gesture answers is taken (spent) before any await.
        proof = takeCeremonyProof(req, body);
        if (proof === undefined) {
          finishOwner(res, 403, 'presence_required');
          return;
        }
        assertion = proof.assertion;
      }
      // DESK051-C6: a native gesture answers this request's native ceremony, spent here (before any
      // await and before the helper runs): a replayed native request is refused.
      if (native && !takeNativeCeremony(req)) {
        finishOwner(res, 403, 'presence_required');
        return;
      }
      if (busy) {
        finishOwner(res, 409, 'busy');
        return;
      }
      busy = true;
      try {
        if (codeStep === 'finish') {
          // WP-S2: the code typed back opens this session's staged item, not the owner store.
          await ownerCodeFinish(res, body, gate.session, run);
          return;
        }
        const byNostr = gate.ownerNostr;
        const context =
          byNostr === undefined ? await (gate.context ?? (() => source.context()))() : undefined;
        const expectedNostr = byNostr ?? context?.owner.ownerNostr;
        if (expectedNostr === undefined) {
          finishOwner(res, 503, 'needs_setup');
          return;
        }
        let presence: OwnerPresence;
        if (native) {
          // DESK-D12c: one helper gesture for this one owner operation, after every check. D15-04:
          // Replace master code names itself on the OS sheet (reason `code`).
          const got = await nativeFor(
            expectedNostr,
            codeStep === 'replace' ? 'code' : 'approve',
            req,
            res,
          );
          if (!('presence' in got)) {
            finishOwner(res, got.http, 'presence_rejected', { native: got.state });
            return;
          }
          presence = got.presence;
          nativeHeld = presence;
        } else if (proof !== undefined) {
          // REL051-SF1: the gesture answers this ceremony, signed by the stored passkey.
          const check = await checkCeremonyProof(proof, expectedNostr);
          if (check === 'passkey_update_needed') {
            finishOwner(res, 409, 'passkey_update_needed');
            return;
          }
          if (check === 'verification_required') {
            finishOwner(res, 403, 'verification_required');
            return;
          }
          if (check !== 'ok') {
            presenceFailed();
            finishOwner(res, 403, 'presence_rejected');
            return;
          }
          presence = { kind: 'passkey-prf', prfOutput: proof.assertion.prfOutput };
        } else {
          presence = { kind: 'passphrase', secret: body };
        }
        let store: { lock(): Promise<void>; close(): Promise<void> };
        let session: OwnerSession;
        let ownerKeys: OwnerPublicKeys;
        if (context === undefined && gate.recoveryKit === true) {
          finishOwner(res, 409, 'refused');
          return;
        }
        if (context === undefined) {
          // HOTFIX-045-REMOVE (GAP B): no card; the stored owner must be the one `byNostr` names.
          try {
            // unlockForOwnerNostr wipes the presented bytes, whether or not they unlock.
            const unlocked = await KeychainOwnerKeyStore.unlockForOwnerNostr(
              keychainOf(),
              expectedNostr,
              presence,
              { ttlMs: OWNER_SESSION_DEFAULT_TTL_MS },
            );
            ({ store, session, owner: ownerKeys } = unlocked);
          } catch (error) {
            if (error instanceof KeyStoreError && error.code === 'presence_rejected' && native) {
              finishOwner(res, NATIVE_HTTP.damaged, 'presence_rejected', { native: 'damaged' });
            } else if (error instanceof KeyStoreError && error.code === 'presence_rejected') {
              presenceFailed();
              finishOwner(res, 403, 'presence_rejected');
            } else if (error instanceof NodeKeyStoreError && error.code === 'owner_missing') {
              finishOwner(res, 503, 'needs_setup');
            } else {
              finishOwner(res, 500, 'failed');
            }
            return;
          }
        } else {
          let opened: PromptingOwnerKeyStore;
          try {
            opened = await openOwnerStore(context.owner);
          } catch {
            finishOwner(res, 503, 'needs_setup');
            return;
          }
          // WP-11: an export needs the keychain owner store (the one its export control pairs with)
          // and the open agent's recovery-kit source; anything else is refused before the unlock.
          if (
            gate.recoveryKit === true &&
            (!(opened instanceof KeychainOwnerKeyStore) || recoveryKitOf(agentUi) === undefined)
          ) {
            await opened.close().catch(() => undefined);
            finishOwner(res, 409, 'refused');
            return;
          }
          // WP-S2: replacing the master code re-wraps the keychain owner item; nothing else can.
          if (codeStep === 'replace' && !(opened instanceof KeychainOwnerKeyStore)) {
            await opened.close().catch(() => undefined);
            finishOwner(res, 409, 'refused');
            return;
          }
          try {
            // unlock wipes the presented bytes, whether or not they unlock.
            // WP-S2: replace reads the seed for its re-wrap (exportSeedOf, inside this package only).
            session =
              (gate.recoveryKit === true || codeStep === 'replace') &&
              opened instanceof KeychainOwnerKeyStore
                ? await opened.unlockForExport(presence, { ttlMs: OWNER_SESSION_DEFAULT_TTL_MS })
                : await opened.unlock(presence, { ttlMs: OWNER_SESSION_DEFAULT_TTL_MS });
          } catch (error) {
            if (error instanceof KeyStoreError && error.code === 'presence_rejected' && native) {
              finishOwner(res, NATIVE_HTTP.damaged, 'presence_rejected', { native: 'damaged' });
            } else if (error instanceof KeyStoreError && error.code === 'presence_rejected') {
              presenceFailed();
              finishOwner(res, 403, 'presence_rejected');
            } else {
              finishOwner(res, 500, 'failed');
            }
            await opened.lock().catch(() => undefined);
            await opened.close().catch(() => undefined);
            return;
          }
          store = opened;
          ownerKeys = context.owner;
        }
        try {
          presenceSucceeded();
          if (codeStep !== undefined) {
            // WP-S2: check, test and replace have their own one-operation object (signs nothing).
            await ownerCodeRun(res, codeStep, session, store, ownerKeys, gate.session, run);
            return;
          }
          let used = false;
          // U3-e: open only between this gesture's signed `agent.revoke` and the end of `run`.
          let carriersOpen = false;
          // D-141: the agent this gesture renames is the one open now (stillCurrent fences a switch).
          const renameUi = agentUi;
          // WP-11: the open agent's recovery-kit source and client, bound once for this gesture.
          const exportSource = recoveryKitOf(agentUi);
          const exportUi =
            exportSource === undefined || agentUi?.client === undefined
              ? undefined
              : {
                  source: exportSource,
                  client: agentUi.client as unknown as RecoveryKitClient,
                };
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
                // WP-11: the export gate signs only through exportRecoveryKit.
                if (gate.recoveryKit === true) throw ownerOperationRefused();
                used = true;
                const frozen = checkGesture(review, requests);
                // WP-11 (04 §2.3.3): a `backup.export` is signed only by the export gesture, right
                // before its kit is sealed; never by an ordinary owner route.
                if (
                  frozen.some(
                    (r) => r.kind === 'owner-action' && r.action['op'] === 'backup.export',
                  )
                ) {
                  throw ownerOperationRefused();
                }
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
              // WP-11 (D-117 A; 04 §2.3.3): saving the open agent's recovery kit, on the export
              // route only, with the session unlocked for an export. One owner operation: exactly one
              // `backup.export` for the open agent, applied by core, then the kit sealed.
              ...(gate.recoveryKit !== true ||
              !(store instanceof KeychainOwnerKeyStore) ||
              exportUi === undefined
                ? {}
                : {
                    exportRecoveryKit: async (review: OwnerReview) => {
                      if (used) {
                        throw new NodeKeyStoreError(
                          'owner_operation_invalid',
                          'One owner operation signs once.',
                        );
                      }
                      used = true;
                      if (!stillCurrent(req)) throw new AgentChanged();
                      return exportRecoveryKit({
                        session,
                        ownerStore: store as KeychainOwnerKeyStore,
                        keychain: keychainOf(),
                        source: exportUi.source,
                        client: exportUi.client,
                        review,
                        sign: async (r, requests) => {
                          if (!stillCurrent(req)) throw new AgentChanged();
                          const frozen = checkGesture(r, requests);
                          const only = frozen[0];
                          if (
                            frozen.length !== 1 ||
                            only?.kind !== 'owner-action' ||
                            only.action['op'] !== 'backup.export'
                          ) {
                            throw ownerOperationRefused();
                          }
                          return signGesture(session, frozen);
                        },
                        apply: (signed) => source.apply(signed),
                        now: () => now(),
                        // WP-R2b (04 §2.3.3 "In the local app", §2.5 "KeyStore isolation"): every
                        // other keychain ID of this owner, one core open at a time (the host's slot).
                        ...(host === undefined ? {} : { others: otherIdsOf(exportUi.source) }),
                        // WP-R2b: Check's export handle, from the restore engine, bound to this page.
                        ...(gate.pageSession === undefined
                          ? {}
                          : {
                              registerCheck: (file: { path: string; kitId: string }) =>
                                restoreEngine().registerExportedKit(
                                  gate.pageSession as string,
                                  file,
                                ),
                            }),
                      });
                    },
                  }),
              // W4-ONE-TOUCH: Add an agent is no longer an ordinary owner route; its first parts
              // are signed only by the create-agent gate (createAgentGate, 04 §2.8).
              // W4-RENAME-REACHES-CONTACTS (D-141; 04 §2.5.1 `agent.label`, §2.6): a rename that
              // rotates, in the app host only and with the open agent's key items. The same one
              // owner operation: exactly the open agent's next card, then exactly the prepared
              // `agent.label` (signRename); never `sign` as well. Never on the HOTFIX-045-REMOVE path.
              ...(host === undefined ||
              byNostr !== undefined ||
              renameUi?.client === undefined ||
              renameUi.epochKeys === undefined
                ? {}
                : {
                    renameAgent: async (review: OwnerReview, request: LocalUiRenameRequest) => {
                      if (used) {
                        throw new NodeKeyStoreError(
                          'owner_operation_invalid',
                          'One owner operation signs once.',
                        );
                      }
                      used = true;
                      if (!stillCurrent(req)) throw new AgentChanged();
                      const client = renameUi.client;
                      const epochKeys = renameUi.epochKeys;
                      if (client === undefined || epochKeys === undefined) {
                        throw new NodeKeyStoreError('owner_operation_invalid', 'Not here.');
                      }
                      return signRename(session, ownerKeys, {
                        agent: client.agentId,
                        client: {
                          identity: client.identity,
                          sendCardUpdates: () => client.sendCardUpdates(),
                          contacts: client.contacts,
                        },
                        epochKeys,
                        review,
                        label: request.label,
                        labelBody: request.labelBody,
                      });
                    },
                  }),
            });
            if (!stillCurrent(req)) throw new AgentChanged();
            result = await run(owner);
          } catch (error) {
            if (error instanceof AgentChanged) finishOwner(res, 409, 'agent_changed');
            else if (error instanceof ConfirmRequired) finishOwner(res, 409, 'confirm_required');
            else if (error instanceof NodeKeyStoreError) finishOwner(res, 409, 'refused');
            else {
              // F23: a specific fixed reason (never the error text); `internal` stays unsaid.
              const reason = failedBody(error).reason;
              finishOwner(res, 500, 'failed', reason === 'internal' ? {} : { reason });
            }
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
      wipeNative(nativeHeld);
      wipeCeremonyProof(proof);
    }
  }

  // --- UX1113 WP-S2: Touch ID & master code (04 §2.5 "Touch ID & master code page") -----------

  /** Runs an owner-code step's handler with its one operation; the answers of every owner route. */
  async function ownerCodeOperation(
    res: ServerResponse,
    operation: (once: () => void) => LocalUiOwnerOperation,
    run: (owner: LocalUiOwnerOperation) => Promise<LocalUiResult>,
  ): Promise<void> {
    let used = false;
    const once = (): void => {
      if (used) {
        throw new NodeKeyStoreError('owner_operation_invalid', 'One owner operation signs once.');
      }
      used = true;
    };
    let result: LocalUiResult;
    try {
      result = await run(Object.freeze(operation(once)));
    } catch (error) {
      if (error instanceof NodeKeyStoreError) finishOwner(res, 409, 'refused');
      else {
        const reason = failedBody(error).reason;
        finishOwner(res, 500, 'failed', reason === 'internal' ? {} : { reason });
      }
      return;
    }
    if (!used) {
      finishOwner(res, 409, 'refused');
      return;
    }
    emit({ kind: 'owner_operation', outcome: 'done' });
    sendResult(res, result);
  }

  /**
   * WP-S2 check, test and replace, after the central gate verified presence and opened the owner
   * store. Nothing is signed. Check and test close the session before the handler runs (nothing stays
   * unlocked); replace copies the seed for its re-wrap only (exportSeedOf), wipes it at once, and
   * stages the new code for this page session (OwnerCodeChanges).
   */
  async function ownerCodeRun(
    res: ServerResponse,
    step: LocalUiOwnerCodeStep,
    session: OwnerSession,
    store: unknown,
    owner: OwnerPublicKeys,
    cookie: string | undefined,
    run: (owner: LocalUiOwnerOperation) => Promise<LocalUiResult>,
  ): Promise<void> {
    const refuse = (): Promise<never> => Promise.reject(ownerOperationRefused());
    try {
      if (step !== 'replace') {
        await session.close().catch(() => undefined);
        await ownerCodeOperation(
          res,
          (once) => ({ sign: refuse, presenceChecked: () => once() }),
          run,
        );
        return;
      }
      await ownerCodeOperation(
        res,
        (once) => ({
          sign: refuse,
          replaceOwnerCode: async () => {
            once();
            if (cookie === undefined || !(store instanceof KeychainOwnerKeyStore)) {
              throw ownerOperationRefused();
            }
            const copy = exportSeedOf(session, store);
            if (copy.status !== 'ok') throw ownerOperationRefused();
            try {
              return await ownerCodes.begin(encodeUtf8(cookie), copy.seed, owner);
            } finally {
              wipe(copy.seed);
            }
          },
        }),
        run,
      );
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  /**
   * WP-S2 finish: the new code typed back must open exactly the staged item this page session began.
   * A wrong code counts towards the shared backoff (and the third ends the change); then the staged
   * item replaces the `owner` item, all or nothing (owner-change-code.ts).
   */
  async function ownerCodeFinish(
    res: ServerResponse,
    body: Uint8Array,
    cookie: string | undefined,
    run: (owner: LocalUiOwnerOperation) => Promise<LocalUiResult>,
  ): Promise<void> {
    const held = cookie === undefined ? undefined : await ownerCodes.heldBy(encodeUtf8(cookie));
    if (held === undefined) {
      finishOwner(res, 409, 'not_pending');
      return;
    }
    let opened: boolean;
    try {
      // The copy is wiped by the open, whether or not it opens; `body` by ownerGate.
      opened = await ownerCodes.open(held, body.slice());
    } catch {
      finishOwner(res, 500, 'failed');
      return;
    }
    if (!opened) {
      presenceFailed();
      await ownerCodes.rejected(held);
      finishOwner(res, 403, 'presence_rejected');
      return;
    }
    presenceSucceeded();
    await ownerCodeOperation(
      res,
      (once) => ({
        sign: () => Promise.reject(ownerOperationRefused()),
        finishOwnerCode: async () => {
          once();
          const outcome = await ownerCodes.finish(held);
          // REL051-CF3: a new master code replaced the one that was never saved.
          codeHold.clear();
          if (markerHome !== undefined) {
            await restoreEngine()
              .masterCodeSaved()
              .catch(() => undefined);
          }
          return outcome;
        },
      }),
      run,
    );
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
    const native = mode === 'native';
    if (input === 'invalid' || (mode !== undefined && !passkey && !native)) {
      req.resume();
      finishPay(res, 400, 'invalid');
      return;
    }
    if (native && (nativeHelper === undefined || step === 'begin')) {
      req.resume();
      finishPay(res, 403, 'presence_required', NO_NATIVE);
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
      else await payFinish(res, input, body, session, passkey, native, req);
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
      // offers the master code (and setting the passkey up again).
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
      // DESK-D12c: the sheet offers Touch ID / Windows Hello when it is turned on for this owner.
      const nativeOn =
        nativeHelper !== undefined &&
        (
          await nativePresenceStatus(keychainOf(), nativeHelper, context.owner.ownerNostr).catch(
            () => ({ registered: false }),
          )
        ).registered;
      finishPay(res, 200, 'ready', {
        ceremony: hold.id,
        native: nativeOn,
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
    native = false,
    payReq?: IncomingMessage,
  ): Promise<void> {
    if (!onlyKeys(input, ['ceremony']) || typeof input['ceremony'] !== 'string') {
      finishPay(res, 400, 'invalid');
      return;
    }
    // DESK-D12c: the native presence kind carries no bytes; every other kind needs some.
    if (native ? body.length !== 0 : body.length === 0) {
      finishPay(res, 403, 'presence_required');
      return;
    }
    if (busy) {
      finishPay(res, 409, 'busy');
      return;
    }
    // A passkey or native finish takes the hold before any await: single use, whatever happens below.
    const found = payHolds.get(input['ceremony'], session, passkey || native);
    if (found === 'unknown' || found === 'expired') {
      finishPay(res, 409, found);
      return;
    }
    const hold = found;
    let assertion: PayConfirmAssertion | undefined;
    let consumed = passkey || native;
    let nativeHeld: OwnerPresence | undefined;
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
      if (native) {
        // DESK-D12c (04 §2.5.3, 04 §2.3.4 "The reason is display-only"): the statement of this hold
        // was shown at begin; the one unlock below signs exactly this hold's objects (rule 3) and
        // nothing else. The helper's `pay` text is display-only and binds nothing.
        const got = await nativeFor(context.owner.ownerNostr, 'pay', payReq ?? res.req, res);
        if (!('presence' in got)) {
          finishPay(res, got.http, 'presence_rejected', { native: got.state });
          return;
        }
        presence = got.presence;
        nativeHeld = presence;
      } else if (assertion !== undefined) {
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
          // Rule 5: this passkey has no stored key; the master code (or setting it up again) works.
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
          if (error instanceof KeyStoreError && error.code === 'presence_rejected' && native) {
            finishPay(res, NATIVE_HTTP.damaged, 'presence_rejected', { native: 'damaged' });
          } else if (error instanceof KeyStoreError && error.code === 'presence_rejected') {
            presenceFailed();
            if (!passkey && !native && payHolds.backupFailed(hold)) {
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
        if (!passkey && !native) {
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
      wipeNative(nativeHeld);
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
    // Fixed values only in the event: never the master code or anything from the request.
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
    wipe(which.seed, which.challenge, which.session, which.nonce);
    // W4-ONE-TOUCH: the first agent's held seed dies with the hold (its folder name is released).
    which.agentSeed?.wipe();
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
  const createFirstAgent = async (
    label: string,
    seed: HeldAgentSeed | undefined,
  ): Promise<AppHostAgent | undefined> => {
    const slot = host;
    const directory = slot?.directory;
    if (slot === undefined || directory?.create === undefined) return undefined;
    let name: string;
    try {
      // W4-ONE-TOUCH (04 §2.8 step 2): the keys held since begin, never new ones.
      name = await directory.create(label, {
        name: FIRST_AGENT_NAME,
        ...(seed === undefined ? {} : { createKeys: () => seed.store(keychainOf()) }),
      });
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
   * W4-ONE-TOUCH (04 §2.8 Begin): plans the picked AI app's change for `folder` and `agentId` with
   * `desk` (entry-only, the §2.5 "Writing AI app configs" rules are the desk's). A fixed refusal when
   * Claude Desktop runs or the app cannot be connected, including an entry that already names `folder`
   * (IR-W4-ONE-TOUCH L-2).
   */
  const planApp = async (
    desk: { readonly plan: LocalUiAiApps['plan'] },
    app: string,
    folder: string,
    agentId: string,
  ): Promise<
    | { readonly planned: PlannedApp; readonly shown: PlanStatementApp }
    | 'quit_first'
    | 'app_unavailable'
  > => {
    let planned: LocalUiAiAppPlan;
    try {
      planned = await desk.plan(app, folder);
    } catch {
      return 'app_unavailable';
    }
    if (planned.status === 'quit_first') return 'quit_first';
    if (planned.status !== 'change' || planned.app !== app) return 'app_unavailable';
    const copy = (e: JsonObject | null): JsonObject | null =>
      e === null ? null : (parseJson(canonicalize(e)) as JsonObject);
    const name = String(planned.name);
    // IR-W4-ONE-TOUCH L-2: an entry that already names the reserved folder (left over, while no such
    // agent exists) is never claimed as a connection without a signed app.connect: refused.
    if (planned.kind === 'disconnect') return 'app_unavailable';
    const change = changeOf(planned, app, folder, agentId);
    if (change === undefined) return 'app_unavailable';
    const old = await oldIdOf(change.kind === 'move' ? planned.oldAgent : null);
    return {
      planned: { app, name, folder, ...change, desk },
      shown: {
        app,
        name,
        kind: change.kind,
        path: String(planned.path),
        oldEntry: copy(planned.oldEntry),
        newEntry: copy(planned.newEntry),
        oldAgent: planned.oldAgent,
        oldLabel: old.oldLabel,
        oldGone: old.oldGone,
      },
    };
  };

  /**
   * W8-S5 (F7; 04 §2.8 Begin): the agent a move takes the AI app from, as the statement names it.
   * Server-side from the directory only: the open agent's verified label, another agent's
   * config.json label, else its folder name; `oldGone` when its folder is absent or its removal did
   * not finish. Without the directory (outside the app host, or a failed read) the folder name.
   */
  const oldIdOf = async (
    oldAgent: string | null,
  ): Promise<{ readonly oldLabel: string | null; readonly oldGone: boolean }> => {
    if (oldAgent === null) return { oldLabel: null, oldGone: false };
    const slot = host;
    const entries = await slot?.directory.list().catch(() => undefined);
    if (slot === undefined || entries === undefined) return { oldLabel: oldAgent, oldGone: false };
    const entry = entries.find((e) => e.name === oldAgent);
    if (entry === undefined) return { oldLabel: null, oldGone: true };
    const label = entry.name === slot.current ? (agentLabel ?? entry.name) : entry.label;
    return { oldLabel: label === '' ? entry.name : label, oldGone: entry.removing };
  };

  /**
   * W4-ONE-TOUCH (04 §2.8 Finish, step 8): the change recomputed from the file as it is now must be
   * the one begin planned (same file identity, kind and `changeId` for this agentId).
   */
  const recheckApp = async (
    planned: PlannedApp,
    agentId: string,
  ): Promise<
    { readonly status: 'ok'; readonly fresh: LocalUiAiAppPlan } | 'changed' | 'quit_first'
  > => {
    let fresh: LocalUiAiAppPlan;
    try {
      fresh = await planned.desk.plan(planned.app, planned.folder);
    } catch {
      return 'changed';
    }
    if (fresh.status === 'quit_first') return 'quit_first';
    const change = changeOf(fresh, planned.app, planned.folder, agentId);
    if (
      change === undefined ||
      change.identity !== planned.identity ||
      change.kind !== planned.kind ||
      change.changeId !== planned.changeId
    ) {
      return 'changed';
    }
    return { status: 'ok', fresh };
  };

  /**
   * W4-ONE-TOUCH (04 §2.8 steps 7 and 8): writes the AI app entry last, after the owner session is
   * closed and its secrets wiped. `connected` only when the file was written; otherwise the stored
   * `app.connect` is recorded as not applied (its nonce stays used)
   * and the agent stays as it is. Undefined when no app was picked.
   */
  const writeEntry = async (
    planned: PlannedApp | undefined,
    plan: CreateConnectPlan | undefined,
    stored: 'stored' | 'not_stored' | undefined,
    actions: FirstPolicyActions | undefined,
  ): Promise<'connected' | 'not_connected' | undefined> => {
    if (planned === undefined || plan === undefined) return undefined;
    const nonce = plan.connect?.['nonce'];
    if (stored !== 'stored' || typeof nonce !== 'string') return 'not_connected';
    let written = false;
    try {
      const again = await recheckApp(planned, plan.agentId);
      if (typeof again === 'object' && again.fresh.status === 'change') {
        written = (await again.fresh.commit(plan.agentId)) === 'written';
      }
    } catch {
      written = false;
    }
    if (written) return 'connected';
    // 04 §2.8 "Failure in the middle": never inferred as a connection later.
    await actions?.markAppNotApplied?.(planned.app, nonce).catch(() => false);
    return 'not_connected';
  };

  /**
   * W4-ONE-TOUCH: the agent's first parts as the plan fixed them: the label, the policy and the
   * app.connect bodies of the plan and the plan itself (the restricted session). Undefined when the
   * agent's core cannot sign a first label here.
   */
  const plannedFirst = (
    first: FirstAgentCard,
    plan: CreateConnectPlan,
  ): FirstAgentCard | undefined => {
    const firstPolicy = first.firstPolicy;
    const actions = labelActionsOf(firstPolicy?.actions);
    if (firstPolicy === undefined || actions === undefined || first.agent !== plan.agentId) {
      return undefined;
    }
    const policyActions = firstPolicy.actions;
    return Object.freeze<FirstAgentCard>({
      ...first,
      firstLabel: { label: plan.label, actions, body: plan.labelBody },
      firstPolicy: {
        ...firstPolicy,
        ...(plan.policy === undefined ? {} : { body: plan.policy }),
      },
      ...(plan.connect === undefined
        ? {}
        : {
            firstConnect: {
              body: plan.connect,
              apply: (input: object) => policyActions.apply(input),
            },
          }),
      plan: plan.entries,
    });
  };

  /** W4-ONE-TOUCH: setup's input: begin `{label, app?}` (or none), finish exactly `{nonce}`. */
  function setupInput(
    req: IncomingMessage,
    step: LocalUiSetupStep,
  ):
    | { readonly label?: string; readonly app?: string; readonly nonce?: string }
    | 'invalid'
    | 'label_invalid' {
    const input = operationInput(req);
    if (input === undefined) return step === 'begin' ? {} : 'invalid';
    if (
      input === 'invalid' ||
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input)
    ) {
      return 'invalid';
    }
    const keys = Object.keys(input);
    const value = input as Record<string, unknown>;
    if (step === 'finish') {
      // 04 §2.8: finish takes only the begin nonce (and the creation response as the body).
      if (keys.length !== 1 || keys[0] !== 'nonce') return 'invalid';
      const nonce = value['nonce'];
      return typeof nonce === 'string' && PLAN_NONCE.test(nonce) ? { nonce } : 'invalid';
    }
    if (!keys.includes('label') || !keys.every((k) => k === 'label' || k === 'app')) {
      return 'invalid';
    }
    const app = value['app'];
    if (app !== undefined && (typeof app !== 'string' || !AI_APP_IDS.includes(app))) {
      return 'invalid';
    }
    const label = value['label'];
    if (!isAgentLabelText(label)) return 'label_invalid';
    return { label, ...(typeof app === 'string' ? { app } : {}) };
  }

  /** W4-ONE-TOUCH: true when `text` is exactly the held nonce (constant time on the bytes). */
  const sameNonce = (text: string | undefined, nonce: Uint8Array): boolean => {
    if (text === undefined || !PLAN_NONCE.test(text)) return false;
    try {
      return equalBytes(decodeBase64url(text), nonce);
    } catch {
      return false;
    }
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
    // UX1113-R1 (04 §2.3.3, T-7): restored IDs wait for their owner (a crash between the agents and
    // the owner): first run never mints another owner over them; the page says "Finish restoring".
    // Fail closed: a keychain that does not answer holds first run too ("Try again").
    const hold = await restoreEngine()
      .firstRunHold()
      .catch(() => 'keychain_unavailable' as const);
    if (hold !== undefined) {
      // REL051-SF3: a finish refused here ends this session's hold (its seed is wiped now).
      const held = pendingSetup;
      if (step === 'finish' && !busy && held !== undefined && matches(cookie, held.session)) {
        dropSetup(held);
      }
      req.resume();
      sendJson(res, 409, { status: hold });
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
    // U3-d, W4-ONE-TOUCH (08 §1): begin may carry `{label, app?}`; finish carries only `{nonce}`.
    const given = setupInput(req, step);
    if (given === 'invalid' || given === 'label_invalid') {
      req.resume();
      finishSetup(res, 400, given);
      return;
    }
    const body = await boundedBody(req, res, MAX_SETUP_REGISTRATION_BYTES);
    if (body === undefined) return;
    try {
      if (!stillCurrent(req)) {
        agentChanged(res);
        return;
      }
      if (step === 'begin') {
        // U3-g-b: the first agent always gets a label (b11 §28 prefills it; a page without one gets it).
        const label = given.label ?? (target.kind === 'first' ? FIRST_AGENT_LABEL : undefined);
        await setupBegin(res, body, cookie, target, label, given.app);
      } else await setupFinish(req, res, body, cookie, target, given.nonce);
    } finally {
      wipe(body);
    }
  }

  async function setupBegin(
    res: ServerResponse,
    body: Uint8Array,
    cookie: string,
    target: SetupTarget,
    label: string | undefined,
    app: string | undefined,
  ): Promise<void> {
    if (body.length !== 0) {
      finishSetup(res, 400, 'invalid');
      return;
    }
    sweepSetup();
    // W4-ONE-TOUCH (04 §2.8, Decision 45): a new begin from the same page session (a dismissed
    // platform prompt) replaces the held plan; any other session is refused while one is held.
    // Never during an owner operation.
    const before = pendingSetup;
    if (busy || (before !== undefined && !matches(cookie, before.session))) {
      finishSetup(res, 409, 'busy');
      return;
    }
    if (before !== undefined) dropSetup(before);
    busy = true;
    let made: { readonly seed: Uint8Array; readonly keys: OwnerPublicKeys } | undefined;
    let agentSeed: HeldAgentSeed | undefined;
    let kept = false;
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
      made = (internals.newOwnerSeed ?? newOwnerSeed)();
      const { keys } = made;
      // W4-ONE-TOUCH (04 §2.3.1, §2.8): with no agent yet, the first agent's seed is made now, held
      // beside the owner seed, so its agentId is known before the gesture. For an agent that exists
      // (setup of the open agent), its own agentId, when a first label can be signed for it.
      let agentId: string | undefined;
      let folder: string | undefined;
      if (target.kind === 'first') {
        agentSeed = HeldAgentSeed.create();
        agentId = agentSeed.agentId;
        folder = FIRST_AGENT_NAME;
      } else if (
        label !== undefined &&
        labelActionsOf(target.setup.firstCard.firstPolicy?.actions) !== undefined
      ) {
        agentId = target.setup.firstCard.agent;
        folder = host?.current ?? target.setup.firstCard.name;
      }
      let planned: PlannedApp | undefined;
      let shown: PlanStatementApp | undefined;
      if (app !== undefined) {
        const desk = target.kind === 'first' ? target.firstRun.aiApps : agentUi?.aiApps;
        const found =
          desk === undefined || agentId === undefined || folder === undefined
            ? ('app_unavailable' as const)
            : await planApp(desk, app, folder, agentId);
        if (typeof found === 'string') {
          await removeFolders(folders);
          finishSetup(res, 409, found);
          return;
        }
        ({ planned, shown } = found);
      }
      const fingerprint = ownerFingerprintText(keys);
      const nonce = randomBytes(CREATE_CONNECT_NONCE_BYTES);
      let plan: CreateConnectPlan | undefined;
      let statement: PlanStatement | undefined;
      let challenge: Uint8Array;
      if (agentId !== undefined && folder !== undefined && label !== undefined) {
        const send =
          folders?.send.status === 'ready' && firstPolicy !== undefined
            ? folders.send.folder
            : undefined;
        plan = buildCreateConnectPlan({
          agentId,
          owner: keys,
          label,
          folder,
          // IR-W4-ONE-TOUCH L-1: the card keys held since begin (first run with no agent yet).
          ...(agentSeed === undefined
            ? {}
            : { agentKeys: { agentNostr: agentSeed.agentNostr, agentEnc: agentSeed.agentEnc } }),
          ...(send === undefined ? {} : { sendFolder: send }),
          ...(planned === undefined
            ? {}
            : { app: { app: planned.app, changeId: planned.changeId } }),
          nowSeconds: Math.floor(now() / 1000),
        });
        statement = {
          label,
          agentFingerprint: agentFingerprintOf(agentId),
          ownerFingerprint: fingerprint,
          folder,
          ...(shown === undefined ? {} : { app: shown }),
        };
        // 04 §2.8: the WebAuthn create() carries the plan-bound challenge.
        challenge = createConnectChallenge(nonce, statement, plan);
      } else challenge = randomBytes(32);
      const held: PendingSetup = {
        seed: made.seed,
        keys,
        challenge,
        session: (sessions[sessionAt] as Uint8Array).slice(),
        expiresAt: now() + SETUP_HOLD_MS,
        timer: setTimeout(() => dropSetup(held), SETUP_HOLD_MS),
        ...(folders === undefined ? {} : { folders }),
        ...(label === undefined ? {} : { label }),
        ...(target.kind === 'first' ? { noAgent: true as const } : {}),
        nonce,
        ...(agentSeed === undefined ? {} : { agentSeed }),
        ...(plan === undefined ? {} : { plan }),
        ...(planned === undefined ? {} : { app: planned }),
        tries: 0,
      };
      held.timer.unref();
      pendingSetup = held;
      kept = true;
      finishSetup(res, 200, 'ready', {
        expiresInMs: SETUP_HOLD_MS,
        fingerprint,
        // ATT-SENDFOLDER-FIX (IR-1 M-1): the Send folder the gesture allows, shown before it.
        ...sendFolderReview(folders?.send),
        nonce: encodeBase64url(nonce),
        ...(statement === undefined ? {} : { statement: statement as unknown as JsonValue }),
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
      if (!kept) {
        if (made !== undefined) wipe(made.seed);
        agentSeed?.wipe();
      }
    }
  }

  async function setupFinish(
    req: IncomingMessage,
    res: ServerResponse,
    body: Uint8Array,
    cookie: string,
    target: SetupTarget,
    nonceText: string | undefined,
  ): Promise<void> {
    const held = pendingSetup;
    // Bound to its session: another session neither finishes nor consumes it. U3-g-b: and to its
    // kind (begun with no agent yet, or for the open agent). W4-ONE-TOUCH: and to its nonce.
    if (
      held === undefined ||
      !matches(cookie, held.session) ||
      (held.noAgent === true) !== (target.kind === 'first') ||
      !sameNonce(nonceText, held.nonce)
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
    // W4-ONE-TOUCH (04 §2.8 Finish, Decision 45): a rejected presence proof signs nothing and does
    // not consume the plan; it counts towards the backoff, and the third ends the plan.
    let registration: SetupRegistration | undefined;
    try {
      registration = parseSetupRegistration(body);
    } catch {
      registration = undefined;
    }
    let accepted = false;
    // M1-11s-c-c: a get() assertion whose signature this build cannot verify gives no passkey.
    let codeOnly = false;
    if (registration !== undefined) {
      try {
        codeOnly =
          checkSetupRegistration(registration, { challenge: held.challenge, origin }) ===
          'code_only';
        accepted = true;
      } catch {
        accepted = false;
      }
    }
    if (!accepted) {
      wipe(registration?.prfOutput);
      presenceFailed();
      held.tries += 1;
      if (held.tries >= CREATE_CONNECT_TRIES) {
        dropSetup(held);
        await folderRemoval;
        finishSetup(res, 403, 'tries_exhausted');
        return;
      }
      finishSetup(res, 403, registration === undefined ? 'presence_required' : 'presence_rejected');
      return;
    }
    const proof = registration as SetupRegistration;
    // M1-11s-c-c: an unverifiable get() leaves the master code as the only way; its PRF output goes now.
    if (codeOnly) wipe(proof.prfOutput);
    const prfOutput = codeOnly ? new Uint8Array(0) : proof.prfOutput;
    // Single-use from here: taken before any await; wiped whatever happens below.
    pendingSetup = undefined;
    clearTimeout(held.timer);
    busy = true;
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
      // W4-ONE-TOUCH (04 §2.8 Finish): the AI app change is still the one begin planned (same file,
      // same old entry, same changeId for this agentId), and Claude Desktop is not running, before
      // anything is created or signed.
      if (held.app !== undefined && held.plan !== undefined) {
        const again = await recheckApp(held.app, held.plan.agentId);
        if (typeof again === 'string') {
          await answer(res, 409, again);
          return;
        }
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
        // W4-ONE-TOUCH (04 §2.8 step 2): the agent's keys are the ones held since begin.
        created = await createFirstAgent(held.label ?? FIRST_AGENT_LABEL, held.agentSeed);
        const firstCard = created?.firstCard;
        if (
          created === undefined ||
          firstCard === undefined ||
          (held.plan !== undefined && firstCard.agent !== held.plan.agentId)
        ) {
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
      // U3-d-b: the first agent always gets its first label (the typed one, else the prefilled
      // FIRST_AGENT_LABEL its folder was created with), so its card is never named after the folder
      // `default`. W4-ONE-TOUCH: with a plan, exactly the plan's bodies (the restricted session).
      const labelled = withFirstLabel(
        setup.firstCard,
        held.label ?? (created === undefined ? undefined : FIRST_AGENT_LABEL),
      );
      // IR-W4-ONE-TOUCH (Opus a): with a plan, only the restricted plan session signs; when the agent
      // cannot take the plan's parts, nothing is signed (fail closed, never a silent fallback).
      const planned =
        held.plan === undefined ? undefined : plannedFirst(setup.firstCard, held.plan);
      if (held.plan !== undefined && planned === undefined) {
        await answer(res, 500, 'failed', {}, { reason: 'internal' });
        return;
      }
      const firstCard = planned ?? labelled;
      let result: Awaited<ReturnType<typeof completeOwnerSetup>>;
      // REL051-CF3 (R1-CLASS-03): a new master code is about to be made; until the owner says "I
      // saved it", a later start tells the page it was never saved (never asks for it).
      // An earlier marker (another run's) is never overwritten here, and only this run's is removed.
      let markerOurs = false;
      if (markerHome !== undefined && (await readUnsavedMarker(markerHome)) === undefined) {
        markerOurs = await writeUnsavedMarker(markerHome, {
          kind: 'first_run',
          stage: 'writing',
          ownerNostr: held.keys.ownerNostr,
          pid: process.pid,
          at: now(),
        }).then(
          () => true,
          () => false,
        );
      }
      try {
        result = await completeOwnerSetup(
          keychainOf(),
          {
            seed: held.seed,
            keys: held.keys,
            credentialId: proof.credentialId,
            prfOutput,
            authenticatorData: proof.authenticatorData,
            firstCard,
            ...(held.folders?.send.status === 'ready' ? { sendFolder: held.folders.send } : {}),
          },
          {
            ...(internals.ownerKdf === undefined ? {} : { kdf: internals.ownerKdf }),
            ...(setup.ownerFiles === undefined ? {} : { ownerFiles: setup.ownerFiles }),
          },
        );
      } catch (error) {
        // REL051-CF3: rolled back (or another owner's): no code of this run exists.
        if (markerHome !== undefined && markerOurs) await removeUnsavedMarker(markerHome);
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
      // W4-ONE-TOUCH (04 §2.8 step 7): the owner session is closed (completeOwnerSetup); the owner
      // seed and the PRF output are wiped before the AI app's file is written. The generated owner
      // code stays only for the one answer below (the backup-code step), then it is wiped.
      wipe(held.seed, proof.prfOutput);
      try {
        // W4-ONE-TOUCH (step 8): the entry last; on any failure the agent is kept (Decision 45).
        const connected = result.confirmed
          ? await writeEntry(
              held.app,
              held.plan,
              result.connect,
              (created?.firstCard ?? setup.firstCard).firstPolicy?.actions,
            )
          : held.app === undefined
            ? undefined
            : ('not_connected' as const);
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
          // master code stays on screen. Set nowhere else.
          if (adopted) res.setHeader(GENERATION_ADOPTED_HEADER, '1');
        } else if (result.label === 'saved' && held.label !== undefined) {
          await labelSavedForOpen(held.label);
        }
        // The master code goes to the page once, for the backup-code step; never an event.
        // IR-M1-11s-c-1 M-1: also when the card is unconfirmed, since the owner was kept.
        // W4-ONE-TOUCH: `created_not_connected` (still with the master code) when the app picked
        // was not connected; the page offers Connect.
        const outcome = !result.confirmed
          ? 'done_unconfirmed'
          : connected === 'not_connected'
            ? 'created_not_connected'
            : 'done';
        const shownCode = grouped(result.ownerCode);
        // REL051-CF3 (R1-CLASS-03): a reload of "Your master code" shows this code and step again,
        // to this page session only, until "I saved it" (master-code-hold.ts).
        codeHold.hold(encodeUtf8(cookie), shownCode, 'first_run', {
          outcome,
          passkey: result.passkey,
          fingerprint,
          computerName: computerNameOf(safeHostname()),
          ...(sendFolder === undefined ? {} : { sendFolder }),
          ...(held.app === undefined ? {} : { app: held.app.app }),
          ...(connected === undefined ? {} : { connected: connected !== 'not_connected' }),
        });
        if (markerHome !== undefined) {
          await writeUnsavedMarker(markerHome, {
            kind: 'first_run',
            stage: 'shown',
            ownerNostr: held.keys.ownerNostr,
            pid: process.pid,
            at: now(),
          }).catch(() => undefined);
        }
        await answer(
          res,
          200,
          outcome,
          {
            passkey: result.passkey,
            ownerCode: shownCode,
            fingerprint,
            computerName: computerNameOf(safeHostname()),
            ...(sendFolder === undefined ? {} : { sendFolder }),
            ...(result.label === undefined ? {} : { label: result.label }),
            ...(held.app === undefined ? {} : { app: held.app.app }),
          },
          { fingerprint, ...(sendFolder === undefined ? {} : { sendFolder }) },
        );
      } finally {
        wipe(result.ownerCode);
      }
    } finally {
      busy = false;
      wipe(held.seed, held.challenge, held.session, held.nonce, proof.prfOutput);
      held.agentSeed?.wipe();
      await release();
    }
  }

  // --- W4-ONE-TOUCH: New agent with one gesture (D-140; 04 §2.8; 08 §1) ---------------------------

  /** The one held New agent plan, if any (one at a time, from one page session). */
  let pendingCreate: PendingCreate | undefined;

  const finishCreate = (
    res: ServerResponse,
    status: number,
    outcome: string,
    extra: Record<string, unknown> = {},
  ): void => {
    // Fixed values only: never the seed, the nonce, the challenge, the assertion or the code (I-7).
    stamp(res);
    sendJson(res, status, { status: outcome, ...extra });
  };

  /** Wipes and forgets the held plan (if it is still `which`); its Send folder goes unless used. */
  const dropCreate = (which: PendingCreate | undefined = pendingCreate): void => {
    if (which === undefined || which !== pendingCreate) return;
    pendingCreate = undefined;
    clearTimeout(which.timer);
    wipe(which.nonce, which.challenge, which.session);
    which.seed.wipe();
    void removeCreated(which.send).catch(() => undefined);
  };

  /**
   * Drops a held plan whose session is gone, and (`expired`) one past its 120 s. A finish sweeps by
   * session only, so its own expired plan still answers `expired`.
   */
  const sweepCreate = (expired: boolean): void => {
    const held = pendingCreate;
    if (held === undefined) return;
    if (
      (expired && now() >= held.expiresAt) ||
      !sessions.some((s) => equalBytes(s, held.session))
    ) {
      dropCreate(held);
    }
  };

  /**
   * W4-ONE-TOUCH: the gate of `POST /api/ui/agents/begin` and `POST /api/ui/agents` (the
   * create-agent kind, never ownerGate). The caller checked the session, CSRF, Origin, fetch
   * metadata, the octet-stream type and the generation.
   */
  async function createAgentGate(
    req: IncomingMessage,
    res: ServerResponse,
    step: LocalUiCreateAgentStep,
    cookie: string,
  ): Promise<void> {
    const wait = waitSeconds();
    if (wait > 0) {
      req.resume();
      res.setHeader('Retry-After', String(wait));
      finishCreate(res, 429, 'wait', { retryAfter: wait });
      return;
    }
    const input = operationInput(req);
    const mode = header(req, 'x-agentlink-presence');
    const passkey = mode === 'passkey';
    // HOTFIX-NOID: the desktop app's own Touch ID (native presence, DESK051-C6), finish only.
    const native = mode === 'native' && step === 'finish';
    if (input === 'invalid' || (mode !== undefined && !passkey && !native)) {
      req.resume();
      finishCreate(res, 400, 'invalid');
      return;
    }
    if (native && nativeHelper === undefined) {
      req.resume();
      finishCreate(res, 403, 'presence_required', NO_NATIVE);
      return;
    }
    const body = await boundedBody(
      req,
      res,
      passkey ? MAX_PAY_CONFIRM_ASSERTION_BYTES : MAX_SECRET_BYTES,
    );
    if (body === undefined) return;
    try {
      // The native kind carries no bytes and answers this request's ceremony, spent here (before
      // the helper runs): a replayed native request never starts a second OS prompt.
      if (native && (body.length !== 0 || !takeNativeCeremony(req))) {
        finishCreate(res, 403, 'presence_required');
        return;
      }
      sweepCreate(false);
      const sessionAt = matchIndex(cookie, sessions);
      if (sessionAt < 0) {
        finishCreate(res, 409, 'not_pending');
        return;
      }
      const session = sessions[sessionAt] as Uint8Array;
      if (!stillCurrent(req)) {
        agentChanged(res);
        return;
      }
      if (host === undefined || host.directory.create === undefined) {
        sendResult(res, NOT_AVAILABLE);
        return;
      }
      if (step === 'begin') await createBegin(res, input, body, session, passkey);
      else
        await createFinish(
          req,
          res,
          input,
          body,
          session,
          native ? 'native' : passkey ? 'passkey' : 'code',
        );
    } finally {
      wipe(body);
    }
  }

  async function createBegin(
    res: ServerResponse,
    input: JsonValue | undefined,
    body: Uint8Array,
    session: Uint8Array,
    passkey: boolean,
  ): Promise<void> {
    if (body.length !== 0 || passkey) {
      finishCreate(res, 400, 'invalid');
      return;
    }
    const value = typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {};
    const keys = Object.keys(value);
    if (
      input === undefined ||
      !keys.includes('label') ||
      !keys.every((k) => k === 'label' || k === 'app')
    ) {
      finishCreate(res, 400, 'invalid');
      return;
    }
    const label = (value as Record<string, unknown>)['label'];
    const app = (value as Record<string, unknown>)['app'];
    if (app !== undefined && (typeof app !== 'string' || !AI_APP_IDS.includes(app))) {
      finishCreate(res, 400, 'invalid');
      return;
    }
    if (!isAgentLabelText(label)) {
      finishCreate(res, 400, 'label_invalid');
      return;
    }
    sweepCreate(true);
    // Decision 45: a new begin from the same page session replaces the held plan; others wait.
    const before = pendingCreate;
    if (busy || (before !== undefined && !equalBytes(before.session, session))) {
      finishCreate(res, 409, 'busy');
      return;
    }
    if (before !== undefined) dropCreate(before);
    const slot = host;
    const directory = slot?.directory;
    if (slot === undefined || directory?.nameFor === undefined) {
      sendResult(res, NOT_AVAILABLE);
      return;
    }
    busy = true;
    let seed: HeldAgentSeed | undefined;
    let send: SendFolderPlan | undefined;
    let kept = false;
    try {
      const context = await source.context();
      // HOTFIX-NOID (04 §2.8 "No ID on this computer yet"): with no ID open, only an owner with no ID
      // folder at all gets a plan, for the owner its presence unlocks at finish.
      const firstId = context === undefined && noAgentOpen() && (await firstIdForOwner());
      if (context === undefined && !firstId) {
        if (noAgentOpen()) noAgent(res);
        else finishCreate(res, 503, 'needs_setup');
        return;
      }
      const owner = context?.owner;
      // The folder name is reserved for as long as the plan is held (one plan at a time).
      const folder = await directory.nameFor(label, []);
      if (!HOST_AGENT_NAME.test(folder) || (await directory.read(folder)) !== undefined) {
        finishCreate(res, 500, 'failed');
        return;
      }
      seed = HeldAgentSeed.create();
      let planned: PlannedApp | undefined;
      let shown: PlanStatementApp | undefined;
      if (typeof app === 'string') {
        // HOTFIX-NOID: with no ID open, the host's own desk (first run's, plan only, never a route).
        const desk = agentUi?.aiApps ?? (firstId ? options.host?.firstRun?.aiApps : undefined);
        const found =
          desk === undefined
            ? ('app_unavailable' as const)
            : await planApp(desk, app, folder, seed.agentId);
        if (typeof found === 'string') {
          finishCreate(res, 409, found);
          return;
        }
        ({ planned, shown } = found);
      }
      // The Send folder for its first policy, checked (or created) now; removed again unless used.
      // ATT-SENDFOLDER-FIX: an unusable Send falls back to a fresh Send-2 ... (never a link).
      send = await prepareSendFolder(
        boundHome ?? (firstId ? options.host?.firstRun?.home : undefined),
        { fallback: true },
      ).catch((): SendFolderPlan => ({
        status: 'unavailable',
        reason: 'folder_unavailable',
      }));
      const fixed = {
        agentId: seed.agentId,
        // IR-W4-ONE-TOUCH L-1: the card keys held since begin.
        agentKeys: { agentNostr: seed.agentNostr, agentEnc: seed.agentEnc },
        label,
        folder,
        ...(send.status === 'ready' ? { sendFolder: send.folder } : {}),
        ...(planned === undefined ? {} : { app: { app: planned.app, changeId: planned.changeId } }),
      };
      const planFor = (forOwner: OwnerPublicKeys): CreateConnectPlan =>
        buildCreateConnectPlan({
          ...fixed,
          owner: forOwner,
          nowSeconds: Math.floor(now() / 1000),
        });
      const plan = owner === undefined ? undefined : planFor(owner);
      const statement: PlanStatement = {
        label,
        agentFingerprint: agentFingerprintOf(seed.agentId),
        // HOTFIX-NOID: no owner fingerprint before the owner is unlocked (the ALKO blob holds no
        // public keys, 04 §2.8 M1-9x).
        ...(owner === undefined ? {} : { ownerFingerprint: ownerFingerprintText(owner) }),
        folder,
        ...(shown === undefined ? {} : { app: shown }),
      };
      const nonce = randomBytes(CREATE_CONNECT_NONCE_BYTES);
      // HOTFIX-NOID: without the owner no plan-bound passkey challenge exists, so no passkey is
      // offered (allowCredentials is empty); the master code's binding is the held plan, server-side,
      // and the native gesture's is its ceremony and this held plan (04 §2.8).
      const challenge =
        plan === undefined ? randomBytes(32) : createConnectChallenge(nonce, statement, plan);
      const held: PendingCreate = {
        session: session.slice(),
        nonce,
        challenge,
        expiresAt: now() + CREATE_CONNECT_HOLD_MS,
        timer: setTimeout(() => dropCreate(held), CREATE_CONNECT_HOLD_MS),
        seed,
        ...(plan === undefined ? { planFor } : { plan }),
        statement,
        ...(planned === undefined ? {} : { app: planned }),
        send,
        tries: 0,
      };
      held.timer.unref();
      pendingCreate = held;
      kept = true;
      // Rule 5 of 04 §2.5.3: the passkey is offered only when its credential key is kept.
      let credentialId: string | undefined;
      try {
        const stored = plan === undefined ? null : await readOwnerPasskeyHeader(keychainOf());
        if (
          stored !== null &&
          (await readOwnerPasskeyKey(keychainOf(), stored.credentialId)) !== null
        ) {
          credentialId = encodeBase64url(stored.credentialId);
        }
      } catch {
        credentialId = undefined;
      }
      finishCreate(res, 200, 'ready', {
        nonce: encodeBase64url(nonce),
        statement: statement as unknown as JsonValue,
        // ATT-SENDFOLDER-FIX (IR-1 M-1): the Send folder the gesture allows, shown before it.
        ...sendFolderReview(send),
        expiresInMs: CREATE_CONNECT_HOLD_MS,
        publicKey: {
          rpId: PASSKEY_RP_ID,
          challenge: encodeBase64url(challenge),
          allowCredentials: credentialId === undefined ? [] : [credentialId],
          userVerification: 'required',
          timeoutMs: CREATE_CONNECT_HOLD_MS,
          prfSalt: encodeBase64url(ownerPrfSalt()),
        },
      });
    } catch {
      finishCreate(res, 500, 'failed');
    } finally {
      busy = false;
      if (!kept) {
        seed?.wipe();
        if (send !== undefined) await removeCreated(send).catch(() => undefined);
      }
    }
  }

  async function createFinish(
    req: IncomingMessage,
    res: ServerResponse,
    input: JsonValue | undefined,
    body: Uint8Array,
    session: Uint8Array,
    mode: 'code' | 'passkey' | 'native',
  ): Promise<void> {
    // 04 §2.8: finish takes only the begin nonce and the presence proof.
    if (!onlyKeys(input, ['nonce']) || typeof input['nonce'] !== 'string') {
      finishCreate(res, 400, 'invalid');
      return;
    }
    const nonceText = input['nonce'];
    // The native kind carries no bytes (its ceremony was taken by the gate); every other needs some.
    if (mode !== 'native' && body.length === 0) {
      finishCreate(res, 403, 'presence_required');
      return;
    }
    if (busy) {
      finishCreate(res, 409, 'busy');
      return;
    }
    const held = pendingCreate;
    if (
      held === undefined ||
      !equalBytes(held.session, session) ||
      !sameNonce(nonceText, held.nonce)
    ) {
      finishCreate(res, 409, 'not_pending');
      return;
    }
    if (now() >= held.expiresAt) {
      dropCreate(held);
      finishCreate(res, 409, 'expired');
      return;
    }
    busy = true;
    let assertion: PayConfirmAssertion | undefined;
    let nativeHeld: OwnerPresence | undefined;
    let taken = false;
    let sendUsed = false;
    /** A rejected proof: counted (backoff and the plan's tries); the third ends the plan. */
    const rejected = (status: 'presence_rejected' | 'presence_required'): void => {
      presenceFailed();
      held.tries += 1;
      if (held.tries >= CREATE_CONNECT_TRIES) {
        dropCreate(held);
        finishCreate(res, 403, 'tries_exhausted');
      } else finishCreate(res, 403, status);
    };
    try {
      const context = await source.context();
      // HOTFIX-NOID: a plan begun with no card naming the owner (no ID on this computer) is finished
      // only while that is still so; a plan begun for a card needs that card.
      if (
        held.plan === undefined
          ? context !== undefined || !(await firstIdForOwner())
          : context === undefined
      ) {
        if (held.plan === undefined) finishCreate(res, 409, 'agent_changed');
        else finishCreate(res, 503, 'needs_setup');
        return;
      }
      const expectedNostr =
        context?.owner.ownerNostr ??
        (mode === 'native' ? await noCardOwnerNostr().catch(() => undefined) : undefined);
      let presence: OwnerPresence;
      if (mode === 'passkey') {
        // HOTFIX-NOID: no plan-bound passkey challenge exists without the owner (begin offered none).
        if (context === undefined) {
          finishCreate(res, 409, 'passkey_update_needed');
          return;
        }
        assertion = parsePayConfirmAssertion(body);
        if (assertion === undefined) {
          rejected('presence_required');
          return;
        }
        let check: ReturnType<typeof checkPayConfirmAssertion> = 'presence_rejected';
        try {
          const stored = await readOwnerPasskeyHeader(keychainOf());
          if (stored !== null) {
            check = checkPayConfirmAssertion(assertion, {
              challenge: held.challenge,
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
          finishCreate(res, 403, 'verification_required');
          return;
        }
        if (check === 'key_missing') {
          finishCreate(res, 409, 'passkey_update_needed');
          return;
        }
        if (check !== 'ok') {
          rejected('presence_rejected');
          return;
        }
        presence = { kind: 'passkey-prf', prfOutput: assertion.prfOutput };
      } else if (mode === 'native') {
        // HOTFIX-NOID (DESK051-C6): one helper gesture for this one owner operation, after every
        // check above; for the owner the open card names, or (no ID here) the stored Touch ID names.
        if (expectedNostr === undefined) {
          finishCreate(res, 403, 'presence_rejected', { native: 'not_registered' });
          return;
        }
        const got = await nativeFor(expectedNostr, 'approve', req, res);
        if (!('presence' in got)) {
          finishCreate(res, got.http, 'presence_rejected', { native: got.state });
          return;
        }
        presence = got.presence;
        nativeHeld = presence;
        // The page may have gone, or the plan expired, while the OS prompt was up.
        if (pendingCreate !== held || now() >= held.expiresAt) {
          finishCreate(res, 409, 'expired');
          return;
        }
      } else {
        presence = { kind: 'passphrase', secret: body };
      }
      let store: { lock(): Promise<void>; close(): Promise<void> };
      let ownerSession: OwnerSession;
      let owner: OwnerPublicKeys;
      try {
        // unlock wipes the presented bytes, whether or not they unlock.
        nativeHeld = undefined;
        if (context !== undefined) {
          let opened: PromptingOwnerKeyStore;
          try {
            opened = await openOwnerStore(context.owner);
          } catch {
            wipeNative(presence);
            finishCreate(res, 503, 'needs_setup');
            return;
          }
          store = opened;
          try {
            ownerSession = await opened.unlock(presence, { ttlMs: OWNER_SESSION_DEFAULT_TTL_MS });
          } catch (error) {
            await opened.close().catch(() => undefined);
            throw error;
          }
          owner = context.owner;
        } else {
          // HOTFIX-NOID (04 §2.8 M1-9x): no card names the owner: the master code opens the owner
          // item and the owner keys come from its seed; Touch ID opens it to the owner it names.
          // The terminal's "Is this your owner fingerprint?" can't be asked inside one owner
          // operation here (no unlock session, D-68), so the check is the computer's own: a stored
          // Touch ID or passkey names an owner key, and the unwrapped owner must be that one.
          const unlocked =
            expectedNostr === undefined
              ? await KeychainOwnerKeyStore.unlockWithoutCard(
                  keychainOf(),
                  presence,
                  (found) => sameStoredOwner(found),
                  { ttlMs: OWNER_SESSION_DEFAULT_TTL_MS },
                )
              : await KeychainOwnerKeyStore.unlockForOwnerNostr(
                  keychainOf(),
                  expectedNostr,
                  presence,
                  { ttlMs: OWNER_SESSION_DEFAULT_TTL_MS },
                );
          if (unlocked === null) {
            finishCreate(res, 409, 'refused');
            return;
          }
          // IR-HOTFIX-NOID-1 L2: the Touch ID path gets the same check (a passkey header naming
          // another owner refuses), before anything is signed.
          if (expectedNostr !== undefined && !(await sameStoredOwner(unlocked.owner))) {
            await unlocked.session.close().catch(() => undefined);
            await unlocked.store.close().catch(() => undefined);
            finishCreate(res, 409, 'refused');
            return;
          }
          ({ store, session: ownerSession, owner } = unlocked);
        }
      } catch (error) {
        if (error instanceof KeyStoreError && error.code === 'presence_rejected') {
          if (mode === 'native') finishCreate(res, 403, 'presence_rejected', { native: 'damaged' });
          else rejected('presence_rejected');
        } else if (error instanceof NodeKeyStoreError && error.code === 'owner_missing') {
          finishCreate(res, 503, 'needs_setup');
        } else finishCreate(res, 500, 'failed');
        return;
      }
      let created: AppHostAgent | undefined;
      let outcome: Awaited<ReturnType<typeof signNewAgent>> = { status: 'failed' };
      let refusal: { readonly status: number; readonly outcome: string } | undefined;
      const plan = held.plan ?? (held.planFor as (o: OwnerPublicKeys) => CreateConnectPlan)(owner);
      try {
        presenceSucceeded();
        // Single use from here: the plan is taken before the owner key signs anything.
        pendingCreate = undefined;
        clearTimeout(held.timer);
        taken = true;
        try {
          const now2 = await source.context();
          if (!stillCurrent(req)) refusal = { status: 409, outcome: 'agent_changed' };
          else if (
            held.plan === undefined
              ? now2 !== undefined
              : now2 === undefined ||
                !equalBytes(now2.owner.ownerNostr, plan.owner.ownerNostr) ||
                !equalBytes(now2.owner.ownerEvm, plan.owner.ownerEvm) ||
                !equalBytes(now2.owner.ownerEnc, plan.owner.ownerEnc)
          ) {
            refusal = { status: 409, outcome: 'refused' };
          } else if ((await host?.directory.read(plan.folder)) !== undefined) {
            refusal = { status: 409, outcome: 'name_taken' };
          } else if (held.app !== undefined) {
            const again = await recheckApp(held.app, plan.agentId);
            if (typeof again === 'string') refusal = { status: 409, outcome: again };
          }
          if (refusal === undefined) {
            // (2) The keys held since begin and the reserved folder, then the first parts.
            created = await createHeldAgent(held, plan);
            const first =
              created?.firstCard === undefined ? undefined : plannedFirst(created.firstCard, plan);
            if (created === undefined || first === undefined) {
              refusal = { status: 500, outcome: 'failed' };
            } else {
              if (!stillCurrent(req)) throw new AgentChanged();
              outcome = await signNewAgent(ownerSession, plan.owner, first, held.send);
            }
          }
        } finally {
          // (7) No owner key in memory during the file write.
          await ownerSession.close().catch(() => undefined);
        }
      } finally {
        await store.lock().catch(() => undefined);
        await store.close().catch(() => undefined);
      }
      if (refusal !== undefined || outcome.status !== 'done' || created === undefined) {
        // All or nothing (04 §2.8 "From the local app"): exactly what this request made goes.
        if (created !== undefined) {
          await created.close().catch(() => undefined);
          await host?.directory.discardNew?.(created.name).catch(() => undefined);
        }
        finishCreate(res, refusal?.status ?? 409, refusal?.outcome ?? 'not_applied');
        return;
      }
      sendUsed = keepsFolder(outcome.sendFolder);
      let connected: 'connected' | 'not_connected' | undefined;
      try {
        // Display only (07 §9.1): the verified label is in the new agent's store.
        await host?.directory.writeLabel(created.name, plan.label).catch(() => undefined);
        // (8) The entry last; on failure the agent is kept and Connect is offered (Decision 45).
        connected = await writeEntry(
          held.app,
          plan,
          outcome.connect,
          created.firstCard?.firstPolicy?.actions,
        );
      } finally {
        await created.close().catch(() => undefined);
      }
      if (held.plan === undefined) {
        // HOTFIX-NOID: the first ID here becomes the host's open ID, as first run's does (U3-g-b).
        await host?.adoptFirst(created.name, requestHolds.get(req)).catch(() => false);
        await labelReady;
      }
      emit({ kind: 'owner_operation', outcome: 'done' });
      finishCreate(res, 200, connected === 'not_connected' ? 'created_not_connected' : 'done', {
        name: created.name,
        label: plan.label,
        ...(held.app === undefined ? {} : { app: held.app.app }),
      });
    } catch (error) {
      if (error instanceof AgentChanged) finishCreate(res, 409, 'agent_changed');
      else finishCreate(res, 500, 'failed');
    } finally {
      busy = false;
      wipeNative(nativeHeld);
      if (taken) {
        wipe(held.nonce, held.challenge, held.session);
        held.seed.wipe();
        if (!sendUsed) await removeCreated(held.send).catch(() => undefined);
      }
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

  /**
   * W4-ONE-TOUCH (04 §2.8 step 2): stores the held keys as a keychain agent in the reserved folder
   * (exclusively, the directory's rules) and opens it for its first parts. Undefined, with nothing
   * left behind, when it cannot be created or opened, or is not the planned agent.
   */
  const createHeldAgent = async (
    held: PendingCreate,
    plan: CreateConnectPlan,
  ): Promise<AppHostAgent | undefined> => {
    const slot = host;
    const directory = slot?.directory;
    if (slot === undefined || directory?.create === undefined) return undefined;
    let name: string;
    try {
      name = await directory.create(plan.label, {
        name: plan.folder,
        createKeys: () => held.seed.store(keychainOf()),
      });
    } catch {
      return undefined;
    }
    if (name !== plan.folder) {
      await directory.discardNew?.(name).catch(() => undefined);
      return undefined;
    }
    const opened = await slot.openNew(name);
    if (
      opened === undefined ||
      opened.name !== name ||
      opened.firstCard === undefined ||
      opened.firstCard.agent !== plan.agentId
    ) {
      await opened?.close().catch(() => undefined);
      await directory.discardNew?.(name).catch(() => undefined);
      return undefined;
    }
    return opened;
  };

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
    } catch (error) {
      sendJson(res, 500, failedBody(error));
      return;
    }
    sendResult(res, result);
  }

  /**
   * WP-R2b (04 §2.3.3 "Kit record"): the kit-reveal gate. The caller checked the session, CSRF,
   * Origin, fetch metadata, the octet-stream type and the generation. No query, no operation input,
   * no presence header and no body byte: the handler gets the context only and reveals the kit
   * record's own file (kit-record.ts revealKitFile). Nothing is signed or written; fixed answers.
   */
  async function kitRevealGate(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    route: LocalUiKitRevealRoute,
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
    const body = await boundedBody(req, res, MAX_KIT_REVEAL_BODY_BYTES);
    if (body === undefined) return;
    if (body.length !== 0) {
      sendJson(res, 400, { error: 'invalid' });
      return;
    }
    if (!stillCurrent(req)) {
      agentChanged(res);
      return;
    }
    let result: LocalUiResult;
    try {
      result = await route.handler(uiContext);
    } catch (error) {
      sendJson(res, 500, failedBody(error));
      return;
    }
    sendResult(res, result);
  }

  /**
   * R1-SEC-16: the gate of the mark kind (a display mark). The caller checked the session, CSRF,
   * Origin, fetch metadata, the octet-stream type and the generation. No query, operation input or
   * presence header and no body byte; no owner presence, no owner store, nothing signed. The handler
   * gets the context and the checked route parameters only.
   */
  async function markGate(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    route: LocalUiMarkRoute,
    params: Readonly<Record<string, string>>,
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
    const body = await boundedBody(req, res, MAX_KIT_REVEAL_BODY_BYTES);
    if (body === undefined) return;
    if (body.length !== 0) {
      sendJson(res, 400, { error: 'invalid' });
      return;
    }
    if (!stillCurrent(req)) {
      agentChanged(res);
      return;
    }
    let result: LocalUiResult;
    try {
      result = await route.handler(uiContext, params);
    } catch (error) {
      sendJson(res, 500, failedBody(error));
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
  /**
   * UX1113-R1 (D-147; 04 §2.3.3 "Restore in the app"): the restore kind. After the session, CSRF,
   * Host and fetch-metadata checks of handleUi: no query; a POST needs Origin and an octet-stream
   * body; the engine gets only the page session, the parsed `X-AgentLink-Input` and the body bytes.
   * A presence header only on the presence step. Nothing here reads, logs or echoes a body.
   */
  async function restoreGate(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    route: LocalUiRestoreRoute,
    cookie: string,
    originHeader: string | undefined,
  ): Promise<void> {
    const engine = restoreEngine();
    const refuse = (status: number, error: string): void => {
      req.resume();
      sendJson(res, status, { error });
    };
    if (url.search !== '') return refuse(400, 'invalid');
    if (route.step === 'found') {
      req.resume();
      sendResult(res, await engine.found(cookie));
      return;
    }
    if (originHeader === undefined) return refuse(403, 'origin');
    const type = (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/octet-stream') return refuse(415, 'content_type');
    const mode = header(req, 'x-agentlink-presence');
    if (route.step === 'presence' && mode === PRESENCE_CHALLENGE_MODE) {
      // REL051-SF1: a ceremony for the restore's passkey gesture (this handle, this session).
      await presenceChallenge(req, res);
      return;
    }
    if (mode !== undefined && (route.step !== 'presence' || mode !== 'passkey')) {
      return refuse(400, 'invalid');
    }
    if (route.step === 'codeShow' || route.step === 'codeSaved') {
      // REL051-CF3: no input and no body; the answer is for this page session only.
      if (header(req, 'x-agentlink-input') !== undefined) return refuse(400, 'invalid');
      const empty = await boundedBody(req, res, 0);
      if (empty === undefined) return;
      try {
        await masterCodeStep(res, route.step, cookie);
      } catch {
        sendJson(res, 500, { error: 'failed' });
      }
      return;
    }
    if (route.step === 'upload') {
      if (header(req, 'x-agentlink-input') !== undefined) return refuse(400, 'invalid');
      const declaredText = header(req, 'content-length');
      const declared = declaredText === undefined ? undefined : Number(declaredText);
      const answer = await engine.upload(cookie, req, declared);
      if (answer.status !== 200) {
        res.setHeader('Connection', 'close');
        req.resume();
      }
      sendResult(res, answer);
      return;
    }
    const input = operationInput(req);
    if (input === 'invalid') return refuse(400, 'invalid');
    const limit =
      route.step === 'applyFinish'
        ? MAX_SETUP_REGISTRATION_BYTES
        : route.step === 'presence'
          ? MAX_PAY_CONFIRM_ASSERTION_BYTES
          : route.step === 'open' || route.step === 'check'
            ? MAX_SECRET_BYTES
            : 0;
    const body = await boundedBody(req, res, limit);
    if (body === undefined) return;
    let proof: CeremonyProof | undefined;
    try {
      let answer;
      switch (route.step) {
        case 'header':
          answer = await engine.header(cookie, input);
          break;
        case 'presence': {
          let presented: Uint8Array = body.slice();
          if (mode === 'passkey' && body.length > 0) {
            // REL051-SF1: the gesture answers this request's ceremony and is signed by the stored
            // passkey; the engine then checks it against the kit's owner as before.
            wipe(presented);
            proof = takeCeremonyProof(req, body);
            if (proof === undefined) {
              sendJson(res, 403, { error: 'presence_required' });
              return;
            }
            const stored = await readOwnerPasskeyHeader(keychainOf()).catch(() => null);
            const check =
              stored === null
                ? 'presence_rejected'
                : await checkCeremonyProof(proof, stored.ownerNostr);
            if (check !== 'ok') {
              if (check === 'presence_rejected') presenceFailed();
              sendJson(res, check === 'passkey_update_needed' ? 409 : 403, { error: check });
              return;
            }
            presented = encodePasskeyAssertion(proof.assertion);
          }
          answer = await engine.presence(
            cookie,
            input,
            presented,
            mode === 'passkey' ? 'passkey' : 'passphrase',
          );
          break;
        }
        case 'open':
          answer = await engine.open(cookie, input, body.slice());
          break;
        case 'check':
          answer = await engine.check(cookie, input, body.slice());
          break;
        case 'cancel':
          answer = await engine.cancel(cookie, input);
          break;
        case 'applyBegin':
          answer = await engine.applyBegin(cookie, input);
          break;
        case 'applyFinish':
          // REL051-R2C (R2-CLASS-02): a new master code is only answered to a page still there.
          answer = await engine.applyFinish(cookie, input, body.slice(), {
            open: () => !res.destroyed && !res.writableEnded && req.socket.destroyed !== true,
          });
          holdRestoredCode(answer, cookie);
          break;
        default:
          answer = { status: 400, body: { error: 'invalid' } };
      }
      if (answer.status === 429) {
        const retry = (answer.body as { retryAfter?: unknown }).retryAfter;
        if (typeof retry === 'number') res.setHeader('Retry-After', String(retry));
      }
      sendResult(res, answer);
    } catch {
      sendJson(res, 500, { error: 'failed' });
    } finally {
      wipe(body);
      wipeCeremonyProof(proof);
    }
  }

  /**
   * REL051-CF3: a restore that made a new master code: that code and the step-4 outcome are held for
   * this page session (a reload shows them again until "I saved it").
   */
  function holdRestoredCode(answer: { status: number; body: unknown }, cookie: string): void {
    if (answer.status !== 200 || typeof answer.body !== 'object' || answer.body === null) return;
    const done = answer.body as Record<string, JsonValue>;
    const code = done['masterCode'];
    if (done['status'] !== 'done' || typeof code !== 'string') return;
    codeHold.hold(encodeUtf8(cookie), code, 'restore', {
      ids: done['ids'] ?? [],
      touchId: done['touchId'] === true,
    });
  }

  /**
   * REL051-CF3 (R1-CLASS-03/04, R1-UI-02): `show` answers this session's held code with its step, or
   * what the page should say instead (`lost`: made and never saved, with whether Touch ID can make
   * a new one; `finish_restore`; `none`); never a code to another session. `saved` ends it.
   */
  async function masterCodeStep(
    res: ServerResponse,
    step: 'codeShow' | 'codeSaved',
    cookie: string,
  ): Promise<void> {
    const session = encodeUtf8(cookie);
    try {
      if (step === 'codeSaved') {
        // Only the session that holds it ends another session's display.
        const mine = codeHold.saved(session);
        if (mine && markerHome !== undefined) await restoreEngine().masterCodeSaved();
        sendJson(res, 200, { status: 'saved' });
        return;
      }
      const held = codeHold.shownTo(session);
      if (held.status === 'shown') {
        sendJson(res, 200, {
          status: 'shown',
          kind: held.kind,
          code: held.code,
          ...held.view,
        });
        return;
      }
      if (held.status === 'elsewhere' || markerHome === undefined) {
        sendJson(res, 200, { status: 'none' });
        return;
      }
      const state = await restoreEngine().masterCodeState();
      sendJson(res, 200, state as unknown as JsonValue);
    } finally {
      wipe(session);
    }
  }

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
      } catch (error) {
        sendJson(res, 500, failedBody(error));
        return;
      }
      sendResult(res, result);
    } finally {
      wipe(body);
    }
  }

  /**
   * ATT-APP-ATTACH (08 §1 "Attach a file"; proposed, owner confirms at merge): the attach kind, run
   * after the session, CSRF, Origin, fetch-metadata, octet-stream and generation checks of every
   * write. It refuses a query, an operation input and a presence header; refuses a body without a
   * declared length (411) or declared over ATTACH_MAX_BODY_BYTES (413) before anything is counted
   * or allocated; takes the slot BEFORE reading (at most ATTACH_LIMIT requests per ATTACH_WINDOW_MS
   * and ATTACH_MAX_IN_FLIGHT at once, else 429 `wait`; IR-ATTACH-1 F-1); parses
   * one strict JSON object and hands the handler only that object and the attach desk. No owner
   * presence, no owner store, nothing signed. The body (the file bytes) is wiped after the handler;
   * nothing here logs a name, a path or the content (I-7).
   */
  async function attachGate(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    route: LocalUiAttachRoute,
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
    // IR-ATTACH-1 F-1: a declared length over the cap is refused before anything is counted or
    // allocated; a body without a declared length is refused too (no chunked uploads here).
    const declaredText = header(req, 'content-length');
    const declared = declaredText === undefined ? Number.NaN : Number(declaredText);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      req.resume();
      res.setHeader('Connection', 'close');
      sendJson(res, 411, { error: 'length_required' });
      return;
    }
    if (declared > ATTACH_MAX_BODY_BYTES) {
      req.resume();
      res.setHeader('Connection', 'close');
      sendJson(res, 413, { error: 'too_large' });
      return;
    }
    const at = now();
    while (attachesSent.length > 0 && (attachesSent[0] as number) <= at - ATTACH_WINDOW_MS) {
      attachesSent.shift();
    }
    if (attachesSent.length >= ATTACH_LIMIT || attachesInFlight >= ATTACH_MAX_IN_FLIGHT) {
      const oldest = attachesSent[0] ?? at;
      const retryAfter =
        attachesSent.length >= ATTACH_LIMIT
          ? Math.max(1, Math.ceil((oldest + ATTACH_WINDOW_MS - at) / 1000))
          : 1;
      req.resume();
      res.setHeader('Retry-After', String(retryAfter));
      sendJson(res, 429, { error: 'wait', retryAfter });
      return;
    }
    // F-1: the slot is taken before the body is read, so parallel requests are counted too.
    attachesSent.push(at);
    attachesInFlight += 1;
    try {
      await attachBody(req, res, route);
    } finally {
      attachesInFlight -= 1;
    }
  }

  /** The attach gate after its slot is taken: the body, the parse and the handler. */
  async function attachBody(
    req: IncomingMessage,
    res: ServerResponse,
    route: LocalUiAttachRoute,
  ): Promise<void> {
    const body = await boundedBody(req, res, ATTACH_MAX_BODY_BYTES);
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
      let result: LocalUiResult;
      try {
        result = await route.handler(uiContext, parsed as JsonObject, attachSendDesk);
      } catch {
        // Never the error's text: it could name a path or a file (I-7).
        sendJson(res, 503, { error: 'unavailable' });
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
   * header, a cookie, a CSRF value, an operation input, a presence header and a query; compares the
   * token in constant time; takes at most one handoff per HANDOFF_INTERVAL_MS, and answers at most
   * one wrong token per HANDOFF_INTERVAL_MS (R1-SEC-15: counted apart, so a caller without the token
   * cannot hold the real handoff at 429); parses exactly `{"invite":"<link>"}`; and
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
    // R1-SEC-15: the token (32 random bytes, constant-time compare) is checked first, and accepted
    // and refused handoffs are throttled apart, so a caller without the token cannot hold the real
    // `join` at 429. Each kind: at most one per HANDOFF_INTERVAL_MS.
    const at = now();
    const valid = matches(header(req, HANDOFF_HEADER), handoffBytes);
    const last = valid ? lastHandoffAt : lastHandoffRefusedAt;
    if (at - last < HANDOFF_INTERVAL_MS) {
      const retryAfter = Math.max(1, Math.ceil((last + HANDOFF_INTERVAL_MS - at) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return refuse(429, 'wait');
    }
    if (!valid) {
      lastHandoffRefusedAt = at;
      return refuse(401, 'refused');
    }
    lastHandoffAt = at;
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
    await settled;
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
    if (route.presence === 'restore') {
      // UX1113-R1 (D-147): restore has its own gate. It works with no agent open and takes no
      // generation (it changes no open agent); Origin and the content type are checked there.
      if (!matches(header(req, 'x-agentlink-csrf'), csrfBytes)) return fail(403, 'csrf');
      await restoreGate(req, res, url, route, cookie as string, originHeader);
      return;
    }
    if (route.presence && originHeader === undefined) return fail(403, 'origin');
    if (!matches(header(req, 'x-agentlink-csrf'), csrfBytes)) return fail(403, 'csrf');
    if (!route.presence && route.stream === true) {
      // W4-LIVE-STATUS (08 §1): the event stream, after the same read gate; like every
      // agent-scoped read (U3-g-b), refused while no agent is open.
      if (noAgentRefused(route)) {
        req.resume();
        noAgent(res);
        return;
      }
      await eventsGate(req, res, url, cookie as string);
      return;
    }
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
      // W4-LIVE-STATUS (08 §1): the streams read at once after a switch.
      liveEvents.poke();
      return;
    }
    if (route.presence === 'pause') {
      // W4-PAUSE (D-143 (5)): pausing has its own gate; it carries the generation in its body.
      await pauseGate(req, res, url);
      // The streams show `paused` at once.
      liveEvents.poke();
      return;
    }
    if (route.presence === 'ui-settings') {
      // W4-SHELL-V2: the app's UI settings (no agent, no generation, no presence); its own gate.
      await uiSettingsGate(req, res, url, route);
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
      // W4-LIVE-STATUS: an owner operation may change what the streams show (a label, an entry).
      appsCache = undefined;
      liveEvents.poke();
    }
  }

  /** The mutating /api/ui/ routes after the generation check (handleUi). */
  async function ownerRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    route: Exclude<
      LocalUiRoute,
      | LocalUiReadRoute
      | LocalUiSwitchRoute
      | LocalUiPauseRoute
      | LocalUiUiSettingsRoute
      | LocalUiRestoreRoute
    >,
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
    const asked = asksChallenge(req);
    if (asked !== undefined) {
      // REL051-SF1: a ceremony for a passkey gesture on this route, before anything else runs. Only
      // routes the central gate takes a passkey on (an owner-code step only where its one kind of
      // proof is the passkey) and Remove (which runs the central gate); never acted on.
      // DESK051-C6: the same for a native gesture, where the step takes native presence.
      // HOTFIX-NOID: New ID's finish takes the desktop app's native gesture (its own ceremony); its
      // passkey keeps the plan-bound challenge begin answered (04 §2.8), never a ceremony.
      const takesProof =
        route.presence === 'remove' ||
        (route.presence === 'create-agent' && route.step === 'finish' && asked === 'native') ||
        (route.presence === true &&
          (route.ownerCode === undefined || ownerCodeProofAllowed(route.ownerCode, asked)));
      if (takesProof) await presenceChallenge(req, res);
      else {
        req.resume();
        sendJson(res, 400, { status: 'invalid' });
      }
      return;
    }
    if (route.presence === 'remove') {
      // U3-e: removing an agent has its own gate around ownerGate (the folder lock, its context).
      await removeGate(req, res, url);
      return;
    }
    if (route.presence === 'kit-reveal') {
      // WP-R2b: Show in Finder for the recovery kit has its own gate; no presence, no input.
      await kitRevealGate(req, res, url, route);
      return;
    }
    if (route.presence === 'mark') {
      // R1-SEC-16: a display mark has its own gate; no presence, no input.
      await markGate(req, res, url, route, params);
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
    if (route.presence === 'attach') {
      // ATT-APP-ATTACH: the owner's attached files have their own gate; ownerGate never runs it.
      await attachGate(req, res, url, route);
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
    if (route.presence === 'create-agent') {
      // W4-ONE-TOUCH (D-140, 04 §2.8): New agent with one gesture has its own gate.
      await createAgentGate(req, res, route.step, cookie);
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
      } catch (error) {
        refusal = { status: 500, body: failedBody(error) };
      }
      if (refusal !== undefined) {
        req.resume();
        sendResult(res, refusal);
        return;
      }
    }
    await ownerGate(
      req,
      res,
      (owner) =>
        route.handler(
          uiContext,
          { params, query: url.searchParams, ...(input === undefined ? {} : { input }) },
          owner,
        ),
      route.recoveryKit === true
        ? { recoveryKit: true, pageSession: cookie }
        : route.ownerCode !== undefined
          ? { ownerCode: route.ownerCode, session: cookie }
          : {},
    );
  }

  let lastActivityAt = Date.now();
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
    // F25: page API activity (a poll, a read, a write) keeps `ui` open; static files do not.
    // R1-SEC-15: only a request with a live session counts, so no other local caller keeps it open.
    if (path.startsWith('/api/ui/') && matchIndex(cookieToken(req), sessions) >= 0) {
      lastActivityAt = Date.now();
    }
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
    const approvePage = APPROVE_PAGE.test(path);
    const page = path === '/' || approvePage || appPage;
    if (page) {
      if (method !== 'GET') return reject(res, 405, 'method');
      const expired = approvePage ? EXPIRED_APPROVAL_HTML : EXPIRED_HTML;
      const t = url.searchParams.get('t');
      if (t !== null) {
        // One-shot (M1-11a): the link is consumed here and never opens the page again.
        if (!consumeLink(t)) return reject(res, 401, 'token', expired);
        res.setHeader(
          'Set-Cookie',
          // SameSite=Strict (IR-M1-11a-1 L-2): the OS opens the link as a top-level navigation
          // with no initiator, which counts as same-site. No `Secure`: WebKit drops a Secure cookie
          // set over http://localhost (checked with Playwright WebKit), so the page would not open.
          `${cookieName}=${newSession()}; HttpOnly; SameSite=Strict; Path=/`,
        );
        const site = header(req, 'sec-fetch-site');
        if (site !== undefined && site !== 'none') {
          // R1-SEC-05: opened from the private launch file (approval-os.ts), the navigation is not
          // same-site, and browsers drop a SameSite=Strict cookie on its redirect. A same-origin
          // continue page (no script, no token, the checked page path only) goes on with it.
          sendText(res, 200, 'text/html; charset=utf-8', continuePage(path));
          return;
        }
        res.setHeader('Location', path);
        sendText(res, 303, 'text/plain; charset=utf-8', '');
        return;
      }
      if (matchIndex(cookieToken(req), sessions) < 0) return reject(res, 401, 'token', expired);
      // M1-11b-2: Approvals (`/`) and one request (`/approve/<id>`) render inside the app. Where
      // the UI renders only: the session gate above, and the CSRF, Origin, fetch-metadata and
      // presence gates of the approval API below, are unchanged.
      if (localUi.shell === undefined) {
        if (appPage) return notFoundPage(res);
        // M1-11b-2c: no app bundle, no approval page: fixed text that points to the terminal, with
        // no script and no CSRF token (approval-pages.ts).
        sendText(res, 503, 'text/html; charset=utf-8', NO_APP_HTML);
        return;
      }
      sendShell(res, 200);
      return;
    }

    // UX1113-QA-HOST: any other GET outside the API is "Page not found": with a session and the
    // app, the app itself (its router shows Page not found · Go to Home); otherwise a fixed page
    // with no script, no token and nothing from the request. The API keeps its JSON answers.
    if (!path.startsWith(API_PREFIX) && (method === 'GET' || method === 'HEAD')) {
      if (localUi.shell !== undefined && matchIndex(cookieToken(req), sessions) >= 0) {
        emit({ kind: 'rejected', reason: 'not_found' });
        sendShell(res, 404);
        return;
      }
      notFoundPage(res);
      return;
    }

    const one = API_ONE.exec(path);
    const decideMatch = API_DECIDE.exec(path);
    const passkeyRoute = path === PASSKEY_PATH;
    const nativeOp: 'register' | 'off' | 'replace' | undefined =
      path === NATIVE_PATH
        ? 'register'
        : path === NATIVE_OFF_PATH
          ? 'off'
          : path === NATIVE_REPLACE_PATH
            ? 'replace'
            : undefined;
    const nativeRoute = nativeOp !== undefined;
    const cancelRoute = path === NATIVE_CANCEL_PATH;
    const reviewRoute = path === REVIEW_PATH;
    if (
      path !== '/api/approvals' &&
      !cancelRoute &&
      one === null &&
      decideMatch === null &&
      !passkeyRoute &&
      !nativeRoute &&
      !reviewRoute
    ) {
      reject(res, 404, 'not_found');
      return;
    }
    const post =
      decideMatch !== null ||
      reviewRoute ||
      cancelRoute ||
      ((passkeyRoute || nativeRoute) && method === 'POST') ||
      (nativeOp !== undefined && nativeOp !== 'register');
    if (method !== (post ? 'POST' : 'GET')) return reject(res, 405, 'method');
    if (matchIndex(cookieToken(req), sessions) < 0) return reject(res, 401, 'token');
    if (!fetchSiteOk(req)) return reject(res, 403, 'fetch_site');
    if (post && originHeader === undefined) return reject(res, 403, 'origin');
    if (!matches(header(req, 'x-agentlink-csrf'), csrfBytes)) return reject(res, 403, 'csrf');
    if (cancelRoute) {
      // DESK-TOUCHID-FIX review (Fable M-1): before the generation hold (the operation it stops
      // holds one), after the session, fetch-metadata, origin and CSRF gates. No body.
      req.resume();
      const running = nativeInProgress;
      running?.abort();
      sendJson(res, 200, { status: running === undefined ? 'none' : 'cancelling' });
      return;
    }

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
        await approvalsPost(req, res, reviewRoute, decideMatch, nativeOp);
      } finally {
        hold?.leave();
      }
      return;
    }
    const hold = host === undefined ? undefined : await host.enter();
    try {
      // HOTFIX-045-TOUCHID: the passkey's public data is the owner's, not an agent's: it answers
      // with no agent open too (after the same session, fetch-metadata and CSRF gates above).
      if (noAgentOpen() && !passkeyRoute && !nativeRoute) {
        noAgent(res);
        return;
      }
      stamp(res);
      if (nativeRoute) await nativeInfo(res);
      else await approvalsRead(res, passkeyRoute, one);
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
    nativeOp?: 'register' | 'off' | 'replace',
  ): Promise<void> {
    {
      const asked = asksChallenge(req);
      if (asked !== undefined) {
        // REL051-SF1: a ceremony for this decision (or review list), passkey or native (DESK051-C6).
        // DESK051-C6: and a passkey one for turning native presence on, off or on again; those never
        // take native presence.
        if (
          reviewRoute ||
          decideMatch !== null ||
          (nativeOp !== undefined && asked === 'passkey')
        ) {
          await presenceChallenge(req, res);
        } else {
          req.resume();
          sendJson(res, 400, { status: 'invalid' });
        }
        return;
      }
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
        if (nativeOp !== undefined) await nativeRegister(req, res, nativeOp);
        else await passkeyRegister(req, res);
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
    notificationsName = agent?.name;
    source = agent?.source ?? NO_AGENT_SOURCE;
    agentUi = agent?.localUi;
    // U3-d (04 §2.5.1 "Labels and AI app connections"): the open agent is named only by its
    // verified label (core re-verifies the stored `agent.label`), else by its folder name; the label
    // in config.json (`agent.label`) is display text for listed agents only.
    agentLabel = undefined;
    labelReady = refreshLabel();
    invitesDesk = agentUi?.client === undefined ? undefined : inviteDesk(agentUi.client);
    attachSendDesk = attachDeskOf(agentUi);
    follower = followerOf(agentUi);
    uiContext = buildUiContext();
    // Approvals, a held owner setup and held paid-action confirmations belong to the old agent.
    decided.clear();
    dropSetup();
    payHolds.clear();
    // W4-ONE-TOUCH: a held New agent plan names the old agent's owner and Send folder home.
    dropCreate();
    boundHome = agent?.firstCard?.firstPolicy?.home;
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
    // WP-R2b (IR round 2): the ID open before a recovery-kit save is being opened again.
    if (host?.restarting === true) {
      sendJson(res, 503, {
        status: 'restarting',
        message: 'AgentLink is restarting this ID. Try again in a moment.',
      });
      return;
    }
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

  /**
   * `GET /api/ui/agents` in the app host: names, labels and counts, never a path or an ID.
   * W4-LIVE-STATUS (D-143): Running and each AI app's state come from the live MCP session rows
   * (agent-peek.ts, read only); the AI app entries say only what is set up (live-status.ts).
   * `appsMaxAgeMs` lets the event hub reuse a recent AI apps list instead of reading every config
   * file every 2 s.
   */
  async function listAgents(appsMaxAgeMs = 0): Promise<LocalUiAgentsList> {
    const slot = host;
    if (slot === undefined) throw new Error('not the app host');
    const entries = (await slot.directory.list()).slice(0, MAX_LISTED_AGENTS);
    const current = slot.current;
    // U3-f: the agent each AI app runs, from its `agentlink` entry only (the seam's entry-only view).
    const apps = await aiAppsList(appsMaxAgeMs);
    const detected = (apps?.apps ?? []).map((view) => view.app);
    const appsOf = (name: string): readonly string[] =>
      Object.freeze(
        (apps?.apps ?? []).flatMap((view) =>
          view.state.kind === 'agent' && view.state.agent === name ? [view.app] : [],
        ),
      );
    const at = Math.floor(now() / 1000);
    const agents: LocalUiAgentView[] = [];
    for (const entry of entries) {
      const stats = entry.available
        ? await slot.directory.stats(entry.name).catch(() => undefined)
        : undefined;
      const live = liveTracker.status(
        entry.name,
        {
          sessions: stats?.sessions ?? [],
          lastSeen: stats?.lastSeen ?? [],
          configured: appsOf(entry.name),
          detected,
          // W4-PAUSE (08 §1 "Per agent state"): `paused` wins over every live state.
          paused: stats?.paused === true,
          // WP-13 (F45): a live session older than this app marks its AI app `outdated`.
          ...(options.host?.version === undefined ? {} : { currentVersion: options.host.version }),
        },
        at,
      );
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
          // W4-LIVE-STATUS: a live MCP session row, never the lease (so the host's own pairing
          // pass, which takes the lease, never shows as an AI app).
          running: (stats?.sessions ?? []).length > 0,
          ...live,
        }),
      );
    }
    liveTracker.forget(entries.map((entry) => entry.name));
    return Object.freeze<LocalUiAgentsList>({
      generation: slot.generation,
      current: current ?? null,
      label: current === undefined ? null : (agentLabel ?? current),
      agents: Object.freeze(agents),
    });
  }

  /** The AI apps list, reused for `maxAgeMs` (the event hub's reads); undefined when unreadable. */
  async function aiAppsList(maxAgeMs: number): Promise<AiAppsListing | undefined> {
    const desk = aiAppsDesk();
    const at = now();
    if (
      maxAgeMs > 0 &&
      appsCache !== undefined &&
      appsCache.desk === desk &&
      at - appsCache.at < maxAgeMs
    ) {
      return appsCache.list;
    }
    const list = await (desk?.list() ?? Promise.resolve(undefined)).catch(() => undefined);
    appsCache = { desk, at, list };
    return list;
  }

  /**
   * W4-LIVE-STATUS (08 §1 `GET /api/ui/events`): the stream, after the read gate of handleUi
   * (session, CSRF, Host, Origin when present, fetch metadata, loopback). Also requires
   * `Accept: text/event-stream` and no query; app host only. Records counts only (I-7).
   */
  async function eventsGate(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    cookie: string,
  ): Promise<void> {
    req.resume();
    const accept = (header(req, 'accept') ?? '').toLowerCase();
    if (
      url.search !== '' ||
      !accept.split(',').some((part) => part.split(';')[0]?.trim() === 'text/event-stream')
    ) {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    if (host === undefined) {
      sendResult(res, NOT_AVAILABLE);
      return;
    }
    // The stream headers go out only once the hub takes the stream; `busy` is a plain JSON answer.
    let started = false;
    const sink: LiveEventSink = {
      write: (chunk) => {
        if (!started) {
          started = true;
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
        }
        res.write(chunk);
      },
      end: () => {
        res.end();
      },
      get buffered() {
        return res.writableLength;
      },
      onClose: (fn) => {
        // The hub registers after its awaited read: a reader already gone frees its slot at once.
        // W4-WIRE-3: "gone" is the connection, never `req.destroyed`: Node destroys a request once
        // its (empty) GET body is read, which a slow first read always outlasts; counting that
        // dropped every such stream before its first byte, and the page kept its load-time status.
        if (res.destroyed || res.writableEnded || req.socket?.destroyed !== false) fn();
        else res.once('close', fn);
      },
    };
    const opened = await liveEvents.open(sink, cookie, header(req, 'last-event-id'));
    if (opened === 'busy') {
      emit({ kind: 'events', outcome: 'busy', open: liveEvents.size });
      sendJson(res, 429, { error: 'busy' });
      return;
    }
    emit({ kind: 'events', outcome: 'opened', open: liveEvents.size });
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

  /**
   * W4-PAUSE (D-143 (5); 08 §1 `POST /api/ui/agents/pause` `{generation}`; 04 §2.5 "Live status and
   * Pause"), the pause kind. The caller checked the session, CSRF, Origin, fetch metadata and the
   * octet-stream type. No query, operation input or presence header; the body is exactly
   * `{"generation": <number>}`, the open agent's generation (else 409 `agent_changed`). No owner
   * presence, nothing signed (Decision 50, Q-143-1: stopping never adds authority): the open
   * agent's core writes its one pause row. A second pause answers the same. Outside the app host it
   * answers `not_available`. Fixed codes only.
   */
  async function pauseGate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const finish = (status: number, body: Record<string, string>): void => {
      stamp(res);
      sendJson(res, status, body);
    };
    if (host === undefined) {
      req.resume();
      sendResult(res, NOT_AVAILABLE);
      return;
    }
    // U3-g-b: like every agent-scoped route, refused while no agent is open.
    if (noAgentOpen()) {
      req.resume();
      noAgent(res);
      return;
    }
    if (
      url.search !== '' ||
      header(req, 'x-agentlink-input') !== undefined ||
      header(req, 'x-agentlink-presence') !== undefined
    ) {
      req.resume();
      finish(400, { status: 'invalid' });
      return;
    }
    const body = await boundedBody(req, res, MAX_PAUSE_BODY_BYTES);
    if (body === undefined) return;
    let generation: unknown;
    try {
      const parsed = parseJson(decodeUtf8(body));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      const keys = Object.keys(parsed);
      if (keys.length !== 1 || keys[0] !== 'generation') throw new Error();
      ({ generation } = parsed as { generation?: unknown });
    } catch {
      finish(400, { status: 'invalid' });
      return;
    }
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) {
      finish(400, { status: 'invalid' });
      return;
    }
    // The page guard (08 §1): the agent the page shows must still be the open one.
    const hold = host.enterMutating(String(generation));
    if (hold === undefined) {
      emit({ kind: 'rejected', reason: 'agent_changed' });
      agentChanged(res);
      return;
    }
    try {
      const client = agentUi?.client;
      if (noAgentOpen() || client === undefined) {
        noAgent(res);
        return;
      }
      let outcome: 'paused' | 'already';
      try {
        outcome = await pauseDesk(client).pause();
      } catch {
        // The error could carry a store path (I-7): never logged or returned.
        emit({ kind: 'pause', outcome: 'failed' });
        finish(503, { status: 'unavailable' });
        return;
      }
      emit({ kind: 'pause', outcome });
      finish(200, { status: 'paused' });
    } finally {
      hold.leave();
    }
  }

  /**
   * W4-SHELL-V2: `PUT /api/ui/ui-settings`, the ui-settings kind. The caller checked the session,
   * CSRF, Origin, fetch metadata and the octet-stream type. No query, operation input or presence
   * header; the body is one strict JSON object of allowlisted booleans (readUiSettings, at least one
   * key). No owner presence, nothing signed. The handler gets only the checked change; nothing here
   * logs a value. Fixed answers.
   */
  async function uiSettingsGate(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    route: LocalUiUiSettingsRoute,
  ): Promise<void> {
    const invalid = (): void => {
      stamp(res);
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
    const body = await boundedBody(req, res, UI_SETTINGS_MAX_BODY_BYTES);
    if (body === undefined) return;
    let change: UiSettings | undefined;
    try {
      change = readUiSettings(parseJson(decodeUtf8(body)), 1);
    } catch {
      change = undefined;
    }
    if (change === undefined) {
      invalid();
      return;
    }
    let result: LocalUiResult;
    try {
      result = await route.handler(uiContext, change);
    } catch (error) {
      sendJson(res, 500, failedBody(error));
      return;
    }
    stamp(res);
    sendResult(res, result);
  }

  /** U3-e: one removal at a time. */
  let removalBusy = false;

  /**
   * U3-e: `POST /api/ui/agents/remove` `{name, typedLabel, anyway?}` (08 §1; 04 §2.5 "Removing an
   * agent"), the remove kind. The caller checked the session, CSRF, Origin, fetch metadata, the
   * octet-stream type and the generation (the request's hold). No query. In order: the strict input;
   * the name must be a listed agent and the typed label its label exactly (`label_mismatch`), or,
   * with no typed label, the agent must already be retired by this owner (W8-FINISH-REMOVE, else
   * `invalid`); the app
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
      if (input.typedLabel !== undefined && input.typedLabel !== entry.label) {
        finishRemove('label_mismatch');
        return;
      }
      const keys = await removal.keys(input.name).catch(() => undefined);
      if (keys === undefined) {
        finishRemove('unknown_agent');
        return;
      }
      // W8-FINISH-REMOVE (proposed, owner confirms at merge): without the typed label only an agent
      // already retired for good is finished: listed `removing`, with a revoked-list entry that
      // verifies for its own ID. Its owner is checked below against the owner of the gesture (the
      // agent's own card, or the stored owner unlocked for the entry's signer). Presence is the same.
      let retiredOwner: string | undefined;
      if (input.typedLabel === undefined) {
        const recorded = entry.removing
          ? await removal.readRevoked(keys.agentId).catch(() => undefined)
          : undefined;
        const checked =
          recorded?.kind === 'entry' ? verifyRevokedEntry(recorded.text, keys.agentId) : undefined;
        if (checked?.ok !== true) {
          finishRemove('invalid');
          return;
        }
        retiredOwner = checked.owner;
      }
      const erase = createKeyEraseControl(
        keys.backend === 'keychain'
          ? { backend: 'keychain', keychain: keychainOf() }
          : { backend: 'file', keystoreDir: keys.keystoreDir },
      );
      // (1) The app's own shared lock goes first, then the lock is taken exclusive.
      const closed = await slot.closeForRemoval(input.name);
      wasOpen = closed.closed;
      reopen = closed.restore;
      await removal.exclusive(input.name, async () => {
        const agent = await removal.open(input.name);
        if (agent === undefined) {
          // GAP B: a retired agent whose keys are gone no longer opens; steps 5 to 7 finish it.
          const recorded = entry.removing
            ? await removal.readRevoked(keys.agentId).catch(() => undefined)
            : undefined;
          const checked =
            recorded?.kind === 'entry'
              ? verifyRevokedEntry(recorded.text, keys.agentId)
              : undefined;
          if (recorded?.kind !== 'entry' || checked?.ok !== true) {
            finishRemove('failed');
            return;
          }
          const text = recorded.text;
          // HOTFIX-045-REMOVE (B2): the owner of the gesture is the owner who signed that entry,
          // checked against the owner stored on this computer when presence unlocks it
          // (KeychainOwnerKeyStore.unlockForOwnerNostr). It never depends on an agent being open:
          // after the first failure on a one-agent computer, none is.
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
                  port: removal,
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
            { ownerNostr: decodeHex(ownerNostr) },
          );
          return;
        }
        try {
          if (retiredOwner !== undefined) {
            // Without the typed label: the entry must be signed by the owner the agent's card names.
            const context = await agent.context().catch(() => undefined);
            if (context === undefined || encodeHex(context.owner.ownerNostr) !== retiredOwner) {
              finishRemove('invalid');
              return;
            }
          }
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
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, failedBody(error));
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
    activity: Object.freeze({
      lastAt: () => lastActivityAt,
      openStreams: () => liveEvents.size,
      linksUsed: () => linksUsed,
    }),
    open: async (approvalId?: string) => {
      // A malformed ID rejects the returned promise (never a synchronous throw).
      const path = approvalId === undefined ? '/' : new URL(approvalUrl(approvalId)).pathname;
      return opener(`${origin}${path}?t=${mintLink()}`).catch(() => false);
    },
    openFirstRun: async () => opener(`${origin}/first-run?t=${mintLink()}`).catch(() => false),
    openHome: async () => opener(`${origin}/settings/home?t=${mintLink()}`).catch(() => false),
    openUpdates: async () =>
      opener(`${origin}/settings/updates?t=${mintLink()}`).catch(() => false),
    openJoin: () => openJoinPage(false),
    desktopAlerts: async () => {
      const desk = notificationsPart(source).notifications;
      if (desk === undefined) return undefined;
      const scope = notificationsName ?? '';
      try {
        await desk.refresh();
      } catch {
        // The items stay as they were.
      }
      let items: readonly NotificationItem[];
      try {
        items = await desk.list();
      } catch {
        return undefined;
      }
      return Object.freeze({ scope, items, prefs: Object.freeze(await notifyPrefsNow()) });
    },
    ownerNames: async (refs: readonly string[]) => {
      const out = new Map<string, string>();
      const wanted = new Set(refs);
      const contacts = (
        agentUi?.client as { contacts?: { list?: () => Promise<unknown> } } | undefined
      )?.contacts;
      if (wanted.size === 0 || typeof contacts?.list !== 'function') return out;
      let views: unknown;
      try {
        views = await contacts.list();
      } catch {
        return out;
      }
      if (!Array.isArray(views)) return out;
      for (const v of views as unknown[]) {
        if (typeof v !== 'object' || v === null) continue;
        const { id, display } = v as { id?: unknown; display?: unknown };
        if (typeof id !== 'string' || !wanted.has(id)) continue;
        if (typeof display !== 'object' || display === null) continue;
        const { name, nameSource } = display as { name?: unknown; nameSource?: unknown };
        // I-5: only a name the owner gave; a contact's own (self-declared) name never.
        if (nameSource !== 'owner' || typeof name !== 'string' || name.trim() === '') continue;
        out.set(id, name.trim());
      }
      return out;
    },
    notifyNewApproval: async (approvalId: string) => {
      const url = approvalUrl(approvalId);
      // IR-NOTIFY-1 M-1 (N6): Settings › Notifications › Approvals waiting governs this alert.
      if (await approvalAlertsOn()) await notifier(NOTIFICATION).catch(() => false);
      return url;
    },
    close: async () => {
      await restoreInstance?.close();
      dropSetup();
      payHolds.clear();
      ceremonies.clear();
      dropCreate();
      // WP-S2: a staged master-code change this server began is removed (the old code keeps working).
      await ownerCodes.clear();
      // REL051-CF3: a held master code goes with the server (a restart never shows it again).
      codeHold.clear();
      await folderRemoval;
      // U3-invite: the handoff record goes first, so no `join` hands over to a closing host.
      if (handoffWritten) await options.host?.handoff?.remove().catch(() => undefined);
      joinDesk?.dismiss();
      // F25: open pages hear "closing" first; W4-LIVE-STATUS: every event stream ends when the host stops.
      liveEvents.closing();
      liveEvents.close();
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
  return startApprovalServerWith(options, { sweepRestoreAtStart: true });
}

/**
 * WP-D3 (desktop host; 08 §1, 04 §2.5 "opening a page adds no authority"): the same server as
 * startApprovalServer, except that every one-shot session link it would hand to the OS browser
 * opener (`open`, `openHome`, `openFirstRun`, `openJoin` and the join handoff's open) goes to
 * `linkSink` instead: the desktop app's core hands it to the app window over its private pipe only.
 * Nothing else changes: the same routes, session, CSRF, presence gate and owner signature. The sink
 * gets exactly what the opener would (a fixed path and a fresh one-shot token), resolves true when
 * it delivered the link, and must never log, print or store it.
 */
export function startApprovalServerWithLinkSink(
  options: ApprovalServerOptions,
  linkSink: (sessionUrl: string) => Promise<boolean>,
): Promise<ApprovalServer> {
  return startApprovalServerWith(options, { opener: linkSink });
}
