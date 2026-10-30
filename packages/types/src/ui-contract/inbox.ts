// The local app's Inbox wire contract (W4-INBOX, W4-FILES-SAVE; 08 §1 Inbox and "Save a received
// file"; b11 §34.4): the Save request the page sends and the answers the server gives, as typed
// samples. Shared test data, not runtime logic. Both sides test against it:
//
// - packages/node (src/local-ui/api/files-save.test.ts) runs the REAL route handler with each request
//   and asserts the real answer is the sample answer;
// - apps/local-ui (src/pages/inbox/save-api.test.ts) asserts its client builds exactly the request
//   and reads each answer as the outcome word next to it.
//
// The page sends only the received item's ID. Never a file name, a folder or a path, and no answer
// carries one (04 §4): the page re-reads the list for "Saved as".

/** `POST /api/ui/files/save`: an owner route (presence, octet-stream body, one signed `file.save`). */
export const FILE_SAVE_PATH = '/api/ui/files/save';

/** `X-AgentLink-Input`: exactly `{id}`, the received item's ID `<envelope ID>.<index>`. */
export interface FileSaveInput {
  readonly id: string;
}

/** The received item ID: a 16-byte envelope ID (base64url, 22 chars) and a two-digit index 00–15. */
export const FILE_SAVE_ITEM_ID = /^[A-Za-z0-9_-]{22}\.(?:0[0-9]|1[0-5])$/;

/** What the page makes of an answer (its strings say each one in plain words, 11 §5). */
export type FileSaveOutcome =
  | 'saved'
  | 'already_saved'
  | 'not_found'
  | 'too_large'
  | 'integrity_failed'
  | 'expired'
  | 'location_refused'
  | 'policy_denied'
  | 'inbox_unavailable'
  | 'download_failed'
  | 'refused'
  | 'bad_request'
  | 'not_set_up'
  | 'unavailable';

export interface FileSaveAnswer {
  readonly status: number;
  readonly body:
    { readonly status: 'saved' } | { readonly error: Exclude<FileSaveOutcome, 'saved'> };
}

/** Each outcome's one fixed answer (never a name, a folder, a path or an error's text). */
export const FILE_SAVE_ANSWERS: Readonly<Record<FileSaveOutcome, FileSaveAnswer>> = Object.freeze({
  saved: { status: 200, body: { status: 'saved' } },
  already_saved: { status: 409, body: { error: 'already_saved' } },
  not_found: { status: 404, body: { error: 'not_found' } },
  too_large: { status: 409, body: { error: 'too_large' } },
  integrity_failed: { status: 409, body: { error: 'integrity_failed' } },
  expired: { status: 409, body: { error: 'expired' } },
  location_refused: { status: 409, body: { error: 'location_refused' } },
  policy_denied: { status: 409, body: { error: 'policy_denied' } },
  inbox_unavailable: { status: 503, body: { error: 'inbox_unavailable' } },
  download_failed: { status: 502, body: { error: 'download_failed' } },
  refused: { status: 409, body: { error: 'refused' } },
  bad_request: { status: 400, body: { error: 'bad_request' } },
  not_set_up: { status: 409, body: { error: 'not_set_up' } },
  unavailable: { status: 503, body: { error: 'unavailable' } },
});

/** A valid item ID for the samples (filler). */
export const FILE_SAVE_SAMPLE_ID = 'AQEBAQEBAQEBAQEBAQEBAQ.00';
