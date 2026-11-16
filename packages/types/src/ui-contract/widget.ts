// TRAY-WIDGET-API (D-155; 08 §1 `GET /api/ui/widget` and the `activity` event; b11 §25.4; I-5,
// I-7; proposed, owner confirms at merge): the menu bar widget's one read, as types and constants
// shared by packages/node (local-ui/api/widget.ts, the route) and apps/local-ui (the widget page).
//
// `GET /api/ui/widget` (`presence: false`, the unchanged `/api/ui/` gate, no query) answers
// `{now, previews, unread, today, contacts}` with exact key sets. Status, approvals, the AI apps
// (Connected now), names and the Live entries come from the reads the widget reuses: health,
// notifications, agents and the events stream, contacts and activity.
//
// The only inbound text is `preview`, built by the server (plain text, one line, at most 80 code
// points) and only while the `widgetPreviews` UI setting is on. It is UNTRUSTED (I-5): render it as a
// text node only, never as markup, never linkified.

export const WIDGET_PATH = '/api/ui/widget';

/** At most this many contacts in `unread`, newest first. */
export const WIDGET_MAX_UNREAD = 20;
/** At most this many contacts in `contacts`, newest first. */
export const WIDGET_MAX_CONTACTS = 20;
/** A preview holds at most this many code points, the closing "…" included. */
export const WIDGET_PREVIEW_MAX = 80;
/** `today`: one bucket per hour since the local midnight. */
export const WIDGET_BUCKET_SECONDS = 3_600;
/** `today`: the length of every bucket array (a 25-hour local day folds its last hour in). */
export const WIDGET_BUCKETS = 24;

/** The exact keys of each object of the answer. */
export const WIDGET_KEYS = Object.freeze({
  answer: ['now', 'previews', 'unread', 'today', 'contacts'],
  unread: ['contactId', 'count', 'lastAt', 'preview'],
  today: ['start', 'bucketSeconds', 'in', 'out', 'proofs', 'files'],
  contact: ['contactId', 'lastAt', 'activity'],
} as const);

declare const untrustedText: unique symbol;
/**
 * Inbound text (I-5): plain, one line, at most WIDGET_PREVIEW_MAX code points. Render as a text node
 * only; never as HTML or markdown, never linkified, never in a title, tooltip or notification.
 */
export type UntrustedPreview = string & { readonly [untrustedText]: true };

export interface WidgetUnread {
  /** A contact's ID (lowercase EVM address); the page resolves the name with its contacts read. */
  readonly contactId: string;
  /** New messages and files from this contact (the notification items), at most 9 999. */
  readonly count: number;
  /** Unix seconds: the newest of them. */
  readonly lastAt: number;
  /** Only while `previews` is true and the newest received message has text. Untrusted (I-5). */
  readonly preview?: UntrustedPreview;
}

export interface WidgetToday {
  /** Unix seconds: the local midnight. */
  readonly start: number;
  readonly bucketSeconds: typeof WIDGET_BUCKET_SECONDS;
  /** WIDGET_BUCKETS counts each, oldest first: bucket i holds [start + i h, start + (i + 1) h). */
  readonly in: readonly number[];
  readonly out: readonly number[];
  readonly proofs: readonly number[];
  readonly files: readonly number[];
}

/** The last exchange only: the protocol has no presence, so never "online". */
export type WidgetContactActivity = 'active_now' | 'today';

export interface WidgetContact {
  readonly contactId: string;
  /** Unix seconds: the newest exchange. */
  readonly lastAt: number;
  /** `active_now`: within 5 minutes; `today`: since the local midnight. */
  readonly activity: WidgetContactActivity;
}

export interface WidgetAnswer {
  /** The server's clock, unix seconds. */
  readonly now: number;
  /** Whether "Show message previews" is on (then `preview` may be present). */
  readonly previews: boolean;
  readonly unread: readonly WidgetUnread[];
  readonly today: WidgetToday;
  readonly contacts: readonly WidgetContact[];
}

/** The fixed error codes of the read. */
export type WidgetError = 'bad_request' | 'not_set_up' | 'unavailable';

/**
 * `GET /api/ui/events` event `activity`: `{at}` only (unix seconds), when the open ID's notification
 * items, activity head or newest exchange changed. The page then reads `GET /api/ui/widget` and
 * `GET /api/ui/activity` again. Never text, a name, a ref or an ID.
 */
export const WIDGET_ACTIVITY_EVENT = 'activity';
export interface WidgetActivityEvent {
  readonly at: number;
}
