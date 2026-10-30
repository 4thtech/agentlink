// M1-11s-b: the types of a local UI API route (08 §1; 04 §2.5; D-118; I-4).
//
// A route is a method, a path under /api/ui/ and `presence`. A read route (GET) has no presence and
// its handler gets the context and the request. A mutating route (POST, PUT, PATCH, DELETE) must
// declare `presence: true` (routes.ts refuses it otherwise): the approval server's central gate
// checks owner presence before its handler runs, and the handler gets a one-use owner operation that
// signs with the presence this request carried. No handler ever sees the owner code, the passkey
// assertion or the session values. M1-11s-c adds a third kind, `presence: 'setup'`, for owner setup
// on the first-run page: no handler, run by the server's own setup gate. MSG-FILES-IO-h (D-134) adds
// a fourth, `presence: 'reveal'`, for Show in Finder only: one fixed POST, no presence, no signing,
// no store write; its handler gets only the checked item ID. UX2-d1 (owner decision 1.1) adds a
// fifth, `presence: 'invite'`, for creating an invite and checking a pasted one: two fixed POSTs, no
// presence, no signing; its handler gets only the parsed body and the invite desk. Accepting an
// invite is an ordinary `presence: true` route. U3-c (D-138, 08 §1) adds the sixth, `presence:
// 'switch'`, for switching the open agent in the app host: one fixed POST, no presence, no signing,
// no handler (the server's switch gate runs it); it writes only `app.json`. U3-c also adds route
// stubs (`stub: true`) for the U3 routes later cards fill: a stub answers 501 `not_available` before
// any presence check and never runs its handler.
import type { CreatedInvite, PendingContact } from '@4thtech-io/core';
import type { EnvelopeKeys, JsonObject, JsonValue } from '@4thtech-io/crypto';
import { UI_SETTINGS_PATH, type UiSettings } from '@4thtech-io/types/ui-contract/ui-settings';
import type { LocalUiContext } from './context.js';
import type { OwnerReview, OwnerSignRequest, OwnerSignature } from '../owner-operation.js';

/**
 * The longest `X-AgentLink-Input` (base64url JSON) an owner route accepts (approval-server.ts). The
 * invite routes derive their one link bound from it (api/invites.ts, IR UX2-d1 L).
 */
export const LOCAL_UI_MAX_INPUT_CHARS = 8192;

/** The methods a read route uses. */
export type LocalUiReadMethod = 'GET';
/** The methods of an owner operation: always behind the presence gate. */
export type LocalUiOwnerMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What a handler gets from the request: never a header, cookie, body byte or token. */
export interface LocalUiRequest {
  /** The `:name` path parameters, each `[A-Za-z0-9_-]{1,128}`. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /**
   * Owner routes only: the operation's input, the JSON sent base64url-encoded in
   * `X-AgentLink-Input` (the body carries the presence proof). Undefined when none was sent.
   * Untrusted: the handler validates it.
   */
  readonly input?: JsonValue;
}

/** A handler's answer, sent as JSON. */
export interface LocalUiResult {
  /** An HTTP status, 200 to 599. */
  readonly status: number;
  readonly body: JsonValue;
}

/**
 * One owner operation with the presence this request carried (04 §2.5, D-68): `sign` runs once,
 * shows nothing (the page was the confirmation), and signs exactly the given objects (one, or the
 * pairs runOwnerGesture allows). A second call throws. A wrong owner code throws KeyStoreError
 * `presence_rejected`, which the gate answers as 403 and counts towards the wrong-code backoff.
 */
export interface LocalUiOwnerOperation {
  sign(
    review: OwnerReview,
    requests: readonly OwnerSignRequest[],
  ): Promise<readonly OwnerSignature[]>;
  /**
   * U3-e, the remove gate only: after `sign` signed this gesture's `agent.revoke`, the keys that seal
   * its `revoke` carriers with the owner as sender (04 §3.4.1): the envelope signature, the seal
   * (Nostr kind 13 only) and NIP-44 encryption of this gesture's owner session. Nothing that
   * decrypts. Undefined on every other route, before `sign`, and once the gesture has ended.
   */
  carrierKeys?(): EnvelopeKeys | undefined;
}

export interface LocalUiReadRoute {
  readonly method: LocalUiReadMethod;
  readonly path: string;
  readonly presence: false;
  readonly handler: (context: LocalUiContext, request: LocalUiRequest) => Promise<LocalUiResult>;
}

export interface LocalUiOwnerRoute {
  readonly method: LocalUiOwnerMethod;
  readonly path: string;
  readonly presence: true;
  /**
   * U3-c: a reserved route whose card has not landed. The server answers 501 `not_available` after
   * the session, CSRF, Origin, fetch-metadata, content-type and generation checks, before the
   * presence gate; the handler never runs.
   */
  readonly stub?: true;
  /**
   * U3-invite: a read-only check run after the generation check and before the presence gate. A
   * result refuses the request with it (the owner store is never opened, nothing is signed); the
   * handler still checks again after presence. Undefined lets the request on.
   */
  readonly precheck?: (
    context: LocalUiContext,
    request: LocalUiRequest,
  ) => Promise<LocalUiResult | undefined>;
  readonly handler: (
    context: LocalUiContext,
    request: LocalUiRequest,
    owner: LocalUiOwnerOperation,
  ) => Promise<LocalUiResult>;
}

/** M1-11s-c: the two steps of owner setup on the first-run page. */
export type LocalUiSetupStep = 'begin' | 'finish';

/**
 * M1-11s-c: an owner setup route (D-120 (1)). It has no page handler: the approval server's own
 * setupGate runs the step (approval-server.ts, owner-setup.ts), so no page file ever touches the
 * owner seed, the PRF output or the owner code. Only POST, only under /api/ui/first-run/, one route
 * per step (routes.ts). Reached only while no owner exists anywhere.
 */
export interface LocalUiSetupRoute {
  readonly method: 'POST';
  readonly path: string;
  readonly presence: 'setup';
  readonly step: LocalUiSetupStep;
}

/** M1-PAY-CONFIRM-a: the two steps of a paid-action confirmation (04 §2.5.3). */
export type LocalUiPayConfirmStep = 'begin' | 'finish';

/**
 * M1-PAY-CONFIRM-a: a paid-action confirmation route (04 §2.5.3, D-132). Like a setup route it has
 * no page handler: the approval server's own payConfirmGate runs the step (approval-server.ts,
 * pay-confirm.ts), so no page file ever touches the challenge, the assertion, the backup code or
 * the owner key. Only POST, only under /api/ui/pay-confirm/, one route per step (routes.ts).
 */
export interface LocalUiPayConfirmRoute {
  readonly method: 'POST';
  readonly path: string;
  readonly presence: 'pay-confirm';
  readonly step: LocalUiPayConfirmStep;
}

/** W4-ONE-TOUCH: the two steps of "New agent" with one gesture (04 §2.8, D-140). */
export type LocalUiCreateAgentStep = 'begin' | 'finish';

/** W4-ONE-TOUCH (08 §1): the two fixed paths of New agent with one gesture. */
export const CREATE_AGENT_PATHS: Readonly<Record<LocalUiCreateAgentStep, string>> = Object.freeze({
  begin: '/api/ui/agents/begin',
  finish: '/api/ui/agents',
});

/**
 * W4-ONE-TOUCH (D-140; 08 §1 `POST /api/ui/agents/begin` and `POST /api/ui/agents`): creating an
 * agent (and connecting its AI app) with one gesture. Like a pay-confirm route it has no page
 * handler: the approval server's own createAgentGate runs the step, so no page file ever touches the
 * held seed, the challenge, the assertion, the backup code or the owner key. Only POST, only these
 * two paths, one route per step (routes.ts).
 */
export interface LocalUiCreateAgentRoute {
  readonly method: 'POST';
  readonly path: string;
  readonly presence: 'create-agent';
  readonly step: LocalUiCreateAgentStep;
}

/**
 * MSG-FILES-IO-h: the checked reveal a reveal handler may call (local-ui/reveal-file.ts, built by the
 * server): the Inbox folder from the rules in force and the saved name from the store. It resolves,
 * opens once without following a link, checks the handle, and only then runs the OS revealer.
 */
export type LocalUiRevealFile = (
  inboxFolder: string,
  savedName: string,
) => Promise<'shown' | 'not_found' | 'refused' | 'unavailable' | 'not_opened'>;

/**
 * MSG-FILES-IO-h (D-134): Show in Finder, the one route kind that changes nothing and needs no owner
 * presence but is not a read. Only `POST /api/ui/files/received/reveal`, registered once
 * (routes.ts). The server's reveal gate runs after the same session, CSRF, Origin, fetch-metadata
 * and octet-stream checks as every write, parses the body itself (exactly `{"id":"<item ID>"}`) and
 * hands the handler only that checked ID: never the request, a header, a query or a body byte. The
 * handler signs nothing and writes nothing; the reveal runs one fixed OS action on a file the store
 * recorded inside the Inbox folder (04 §4).
 */
export interface LocalUiRevealRoute {
  readonly method: 'POST';
  readonly path: string;
  readonly presence: 'reveal';
  readonly handler: (
    context: LocalUiContext,
    itemId: string,
    reveal: LocalUiRevealFile,
  ) => Promise<LocalUiResult>;
}

/** UX2-d1: the steps of the invite kind (U3-invite adds `dismiss`, "Not now" on the join screen). */
export type LocalUiInviteStep = 'create' | 'check' | 'dismiss' | 'cancel';

/** UX2-d1: a pasted invite after core's accept step 1 (04 §3.6): who it is and its expiry. */
export interface LocalUiCheckedInvite {
  readonly contact: PendingContact;
  /** Unix seconds, from the link (advisory on this side, 04 §3.6). */
  readonly expiresAt: number;
}

/**
 * UX2-d1: what an invite-kind handler may call (context.ts inviteDesk, built by the server over the
 * core client). `create` is core `createInvite`; `check` is core's accept step 1 only (the one D-69
 * codec, strict schema, expiry, both card signatures, name and relay URL rule) and stores nothing.
 * Neither signs, pairs or reaches the owner store. The link holds the invite secret: never log it.
 */
export interface LocalUiInviteDesk {
  /** W4-SHORT-INVITE: `long` (Advanced, D-139 (7)) asks for the format 1 link. */
  create(input: { readonly label?: string; readonly long?: true }): Promise<CreatedInvite>;
  check(link: string): Promise<LocalUiCheckedInvite>;
  /** W4-INVITES-LIST: core `cancelInvite` (04 §3.6.2: an owner action on the local page). */
  cancel(inviteId: string): Promise<'cancelled' | 'not_found'>;
}

/**
 * UX2-d1 (owner decision 1.1; 08 §1): creating an invite, and checking a pasted one before
 * connecting, need no owner presence, as the MCP tool does not (04 §3.6 sets no invite policy).
 * Only `POST /api/ui/invites` (step `create`) and `POST /api/ui/invites/check` (step `check`), each
 * registered once (routes.ts). The server's invite gate runs after the same session, CSRF, Origin,
 * fetch-metadata and octet-stream checks as every write, refuses a query, an operation input or a
 * presence header, rate-limits `create`, parses the body itself (one strict JSON object) and hands
 * the handler only that object and the desk: never the request, a header or the client.
 */
export interface LocalUiInviteRoute {
  readonly method: 'POST';
  readonly path: string;
  readonly presence: 'invite';
  readonly step: LocalUiInviteStep;
  readonly handler: (
    context: LocalUiContext,
    body: JsonObject,
    invites: LocalUiInviteDesk | undefined,
  ) => Promise<LocalUiResult>;
}

/** U3-c: the fixed path of the switch kind (08 §1). */
export const AGENTS_SWITCH_PATH = '/api/ui/agents/switch';

/**
 * U3-c (D-138; 08 §1; 04 §2.5 "Several agents in one app"): switching the open agent, the sixth named
 * route kind. Only `POST /api/ui/agents/switch`, registered once (routes.ts), with no handler: the
 * server's switch gate runs after the same session, CSRF, Origin, fetch-metadata and octet-stream
 * checks as every write, refuses a query, an operation input or a presence header, parses the body
 * itself (exactly `{"name","generation"}`) and asks the app host to switch. It takes no presence,
 * signs nothing and writes only `~/.agentlink/app.json`. Outside the app host it answers
 * `not_available`.
 */
export interface LocalUiSwitchRoute {
  readonly method: 'POST';
  readonly path: string;
  readonly presence: 'switch';
}

/** U3-e: the fixed path of the remove kind (08 §1). */
export const AGENTS_REMOVE_PATH = '/api/ui/agents/remove';

/**
 * U3-e (D-138; 08 §1; 04 §2.5 "Removing an agent"): removing an agent, the seventh named route kind.
 * Only `POST /api/ui/agents/remove`, registered once (routes.ts), with no handler: the server's
 * remove gate runs it after the same session, CSRF, Origin, fetch-metadata, octet-stream and
 * generation checks as every write. It needs owner presence, checked against the owner the removed
 * agent's own card names, and signs `agent.revoke` (and, with contacts, its `revoke` carriers) in
 * one gesture, inside the agent's exclusive folder lock (api/agents-remove.ts). Outside the app host
 * it answers `not_available`.
 */
export interface LocalUiRemoveRoute {
  readonly method: 'POST';
  readonly path: string;
  readonly presence: 'remove';
}

/**
 * U3-invite (08 §4 "One step from an invite link"): `agentlink join` handing an invite to an app
 * host that is already running, the eighth named route kind. Only `POST /api/ui/join/handoff`,
 * registered once (routes.ts), with no handler: the server's handoff gate runs it BEFORE the session
 * gate, because the caller is a local process, not the page. It accepts only the host's handoff
 * token (32 random bytes, in `X-AgentLink-Handoff`, compared in constant time; not the page's
 * session token), refuses any request with an `Origin`, any `Sec-Fetch-*` header, a cookie, a CSRF
 * value or a query, takes at most one handoff per 5 s, runs Accept step 1 again, stores the waiting
 * invite, signs nothing, and opens the join screen through the OS opener. The token grants nothing
 * else. Outside the app host it answers `not_available`.
 */
export interface LocalUiHandoffRoute {
  readonly method: 'POST';
  readonly path: string;
  readonly presence: 'handoff';
}

/** W4-SHELL-V2: the fixed path of the ui-settings kind (08 §1, proposed). */
export const UI_SETTINGS_WRITE_PATH = UI_SETTINGS_PATH;

/**
 * W4-SHELL-V2 (Decisions 49–51; 08 §1, proposed): saving the app's own UI settings (Under the hood,
 * the section menu), the ninth named route kind. Only `PUT /api/ui/ui-settings`, registered once
 * (routes.ts). The server's ui-settings gate runs after the same session, CSRF, Origin,
 * fetch-metadata and octet-stream checks as every write, refuses a query, an operation input or a
 * presence header, and parses the body itself (one strict JSON object of allowlisted booleans,
 * @4thtech-io/types ui-contract/ui-settings). No owner presence and nothing signed: it changes how
 * the app looks, never a policy, key or approval (I-4). The handler gets only the checked change.
 */
export interface LocalUiUiSettingsRoute {
  readonly method: 'PUT';
  readonly path: string;
  readonly presence: 'ui-settings';
  readonly handler: (context: LocalUiContext, change: UiSettings) => Promise<LocalUiResult>;
}

export type LocalUiRoute =
  | LocalUiUiSettingsRoute
  | LocalUiHandoffRoute
  | LocalUiRemoveRoute
  | LocalUiSwitchRoute
  | LocalUiReadRoute
  | LocalUiOwnerRoute
  | LocalUiSetupRoute
  | LocalUiPayConfirmRoute
  | LocalUiCreateAgentRoute
  | LocalUiRevealRoute
  | LocalUiInviteRoute;

/**
 * The shared fixed answers of the page read routes (M1-11c; the same codes as Activity, #417). A
 * page's success answer is 200 with its own body. Never an error's text in any of these.
 */
const answer = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });

/** 409: no agent on this computer yet (the page shows its not-set-up state). */
export const UI_NOT_SET_UP: LocalUiResult = answer(409, 'not_set_up');
/** 400: a query parameter is unknown, repeated or malformed; the input is never echoed. */
export const UI_INVALID_QUERY: LocalUiResult = answer(400, 'invalid_query');
/**
 * 503: the data could not be read just now (the store or a proof network did not answer); the page
 * says "try again in a minute". An unexpected failure stays 500 `failed`.
 */
export const UI_UNAVAILABLE: LocalUiResult = answer(503, 'unavailable');

/** A page stub's answer until its card fills it. */
export const NOT_IMPLEMENTED: LocalUiResult = Object.freeze({
  status: 501,
  body: Object.freeze({ error: 'not_implemented' }),
});

/** U3-c: the answer of a reserved U3 route until its card fills it (501). */
export const NOT_AVAILABLE: LocalUiResult = Object.freeze({
  status: 501,
  body: Object.freeze({ error: 'not_available' }),
});

/** U3-c: a reserved read route (`GET`), answering 501 `not_available`. */
export const readStub = (path: string): LocalUiReadRoute =>
  Object.freeze<LocalUiReadRoute>({
    method: 'GET',
    path,
    presence: false,
    handler: () => Promise.resolve(NOT_AVAILABLE),
  });

/**
 * U3-c: a reserved owner route (`POST`, presence), answering 501 `not_available` before the presence
 * gate; its handler is never run (approval-server.ts).
 */
export const ownerStub = (path: string): LocalUiOwnerRoute =>
  Object.freeze<LocalUiOwnerRoute>({
    method: 'POST',
    path,
    presence: true,
    stub: true,
    handler: () => Promise.resolve(NOT_AVAILABLE),
  });

/** A read stub for one page: `GET /api/ui/<page>` answering 501. */
export const pageStub = (page: string): LocalUiReadRoute =>
  Object.freeze<LocalUiReadRoute>({
    method: 'GET',
    path: `/api/ui/${page}`,
    presence: false,
    handler: () => Promise.resolve(NOT_IMPLEMENTED),
  });
