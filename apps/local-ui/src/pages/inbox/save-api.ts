// W4-FILES-SAVE: the page's one call to save a received file (08 §1 "Save a received file"; 04 §2.5,
// §4; D-118). `POST /api/ui/files/save`, an owner route:
// - `X-AgentLink-Input`: base64url JSON of exactly `{"id":"<item ID>"}`. Never a file name, a folder
//   or a path: the server finds the file itself, and core saves it into the Inbox folder;
// - the body is the owner's presence, sent only after the owner clicked: the passkey assertion
//   (`X-AgentLink-Presence: passkey`, answering the ceremony for this request, REL051-SF1) or the
//   master code as UTF-8;
// - the session token travels as `X-AgentLink-CSRF`; the app host's fetch guard adds the generation.
// The browser never signs (D-118). The code and the assertion bytes are wiped after the request and
// never logged. Answers become one outcome word (types ui-contract/inbox.ts); no answer carries a
// name or a path.
import type { FileSaveOutcome } from '@4thtech-io/types/ui-contract/inbox';
import { sendWithPresence, type DecisionPasskey } from '../approvals/client.js';

/** The contract path (ui-contract FILE_SAVE_PATH; save-api.test.ts checks they are equal). */
export const FILE_SAVE_PATH = '/api/ui/files/save';
const CSRF_HEADER = 'X-AgentLink-CSRF';
/** A received item ID (ui-contract FILE_SAVE_ITEM_ID): only such an ID is ever sent. */
const ITEM_ID = /^[A-Za-z0-9_-]{22}\.(?:0[0-9]|1[0-5])$/;

export type SavePresence =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'passkey'; readonly passkey: DecisionPasskey }
  /** N3 / OWNERSTEP-LEFT: Touch ID / Windows Hello in the desktop app (the server's ceremony). */
  | { readonly kind: 'native' };

export type SaveAnswer =
  | { readonly kind: 'outcome'; readonly outcome: FileSaveOutcome }
  | { readonly kind: 'wait'; readonly seconds: number }
  | {
      readonly kind:
        | 'presence_rejected'
        | 'presence_required'
        | 'busy'
        | 'dismissed'
        | 'session_expired'
        | 'offline';
    };

export interface SaveApi {
  save(id: string, presence: SavePresence): Promise<SaveAnswer>;
}

export interface SaveApiOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
  readonly credentials?: CredentialsContainer;
}

const OUTCOMES: readonly FileSaveOutcome[] = [
  'already_saved',
  'not_found',
  'too_large',
  'integrity_failed',
  'expired',
  'location_refused',
  'policy_denied',
  'inbox_unavailable',
  'download_failed',
  'refused',
  'bad_request',
  'not_set_up',
  'unavailable',
];

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One answer as the page explains it. */
export function readSaveAnswer(status: number, json: unknown): SaveAnswer {
  if (status === 401) return { kind: 'session_expired' };
  const body = isObject(json) ? json : {};
  const gate = body['status'];
  if (status === 200 && gate === 'saved') return { kind: 'outcome', outcome: 'saved' };
  if (gate === 'wait') {
    const raw = body['retryAfter'];
    const seconds =
      typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= 86_400 ? raw : 1;
    return { kind: 'wait', seconds };
  }
  if (gate === 'presence_rejected' || gate === 'presence_required' || gate === 'busy') {
    return { kind: gate };
  }
  if (gate === 'needs_setup') return { kind: 'outcome', outcome: 'not_set_up' };
  // The gate's own 409 (the route signed nothing) reads as refused.
  if (gate === 'refused' || gate === 'agent_changed')
    return { kind: 'outcome', outcome: 'refused' };
  const error = body['error'];
  const known = OUTCOMES.find((o) => o === error);
  return { kind: 'outcome', outcome: known ?? 'unavailable' };
}

export function createSaveApi(options: SaveApiOptions = {}): SaveApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();
  const credentials = (): CredentialsContainer | undefined =>
    options.credentials ?? (typeof navigator === 'undefined' ? undefined : navigator.credentials);

  return {
    async save(id, presence) {
      // Only a received item ID is ever sent; anything else never leaves the page.
      if (!ITEM_ID.test(id)) return { kind: 'outcome', outcome: 'bad_request' };
      const headers = new Headers({
        [CSRF_HEADER]: token(),
        'content-type': 'application/octet-stream',
        'X-AgentLink-Input': base64url(JSON.stringify({ id })),
      });
      // REL051-SF1: the passkey answers the ceremony the server issued for exactly this request.
      const sent = await sendWithPresence(
        doFetch,
        credentials(),
        FILE_SAVE_PATH,
        headers,
        presence,
      );
      if (sent === 'dismissed') return { kind: 'dismissed' };
      if (sent === undefined) return { kind: 'offline' };
      let json: unknown;
      try {
        json = await sent.json();
      } catch {
        json = undefined;
      }
      return readSaveAnswer(sent.status, json);
    },
  };
}
