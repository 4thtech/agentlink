// M1-11s-b: the types of a local UI API route (08 §1; 04 §2.5; D-118; I-4).
//
// A route is a method, a path under /api/ui/ and `presence`. A read route (GET) has no presence and
// its handler gets the context and the request. A mutating route (POST, PUT, PATCH, DELETE) must
// declare `presence: true` (routes.ts refuses it otherwise): the approval server's central gate
// checks owner presence before its handler runs, and the handler gets a one-use owner operation that
// signs with the presence this request carried. No handler ever sees the owner code, the passkey
// assertion or the session values. M1-11s-c adds a third kind, `presence: 'setup'`, for owner setup
// on the first-run page: no handler, run by the server's own setup gate.
import type { JsonValue } from '@4thtech-io/crypto';
import type { LocalUiContext } from './context.js';
import type { OwnerReview, OwnerSignRequest, OwnerSignature } from '../owner-operation.js';

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

export type LocalUiRoute = LocalUiReadRoute | LocalUiOwnerRoute | LocalUiSetupRoute;

/** A page stub's answer until its card fills it. */
export const NOT_IMPLEMENTED: LocalUiResult = Object.freeze({
  status: 501,
  body: Object.freeze({ error: 'not_implemented' }),
});

/** A read stub for one page: `GET /api/ui/<page>` answering 501. */
export const pageStub = (page: string): LocalUiReadRoute =>
  Object.freeze<LocalUiReadRoute>({
    method: 'GET',
    path: `/api/ui/${page}`,
    presence: false,
    handler: () => Promise.resolve(NOT_IMPLEMENTED),
  });
