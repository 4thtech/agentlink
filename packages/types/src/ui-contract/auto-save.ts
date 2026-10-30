// W4-AUTO-SAVE (D-142; 08 §1, 11 §5.7; proposed, owner confirms at merge): what the local app reads
// about files saved automatically. Data only: the Files, Home and Settings rows that show it belong
// to the UI cards (U3 rows, U6 Settings).
//
// - A received item (`GET /api/ui/files/received`) carries `savedBy: 'auto'` when the core saved it
//   automatically, and `reason` (one fixed code below) when it arrived and was not saved. Never error
//   text, a path or a link.
// - The page's top-level `autoSave` block (same read) carries the Inbox folder as the owner's own
//   setting with the home folder shown as `~` (never inbound text), and `notice` while the one-time
//   "Files you receive are now saved to {folder} automatically" notice is due.
// - `GET /api/ui/files/auto-save-notice/dismiss` dismisses the notice (OK, or Settings from it).
//   Display state only, like the former-name seen mark (D-141): no presence, nothing signed, nothing
//   decided from it; idempotent. It writes one display flag in the agent's store.

/** Why a received file was not saved automatically (08 §1). Fixed codes, never error text. */
export const AUTO_SAVE_REASONS = Object.freeze([
  'limit_contact',
  'limit_today',
  'ask_before_saving',
  'auto_save_off',
  'disk_full',
  'folder_unavailable',
  'folder_cannot_mark',
  'download_failed',
  'before_auto_save',
] as const);

export type AutoSaveReason = (typeof AUTO_SAVE_REASONS)[number];

/** The page block of the received list. */
export interface AutoSaveBlock {
  /** `files.autoSave.on` of the rules in force (false while the policy is not valid). */
  readonly on: boolean;
  /** The Inbox folder, home shown as `~` (for example `~/AgentLink/Inbox`); the owner's setting. */
  readonly folder: string;
  /** True while the one-time notice is due (08 §1, Decision 51: until dismissed). */
  readonly notice: boolean;
}

/** The dismiss route. */
export const AUTO_SAVE_NOTICE_PATH = '/api/ui/files/auto-save-notice/dismiss';

/** Its one answer. */
export const AUTO_SAVE_NOTICE_DISMISSED = Object.freeze({ status: 'dismissed' } as const);

/** A sample block for UI tests (apps/local-ui never imports packages/node). */
export const AUTO_SAVE_BLOCK_SAMPLE: AutoSaveBlock = Object.freeze({
  on: true,
  folder: '~/AgentLink/Inbox',
  notice: true,
});
