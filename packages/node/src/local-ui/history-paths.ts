// RET-4 (D-148; 08 §1): the fixed paths of Delete history and of Show in Finder for the Inbox folder.
// They live here so api/history.ts and routes.ts use them without importing each other.
export const HISTORY_BEGIN_PATH = '/api/ui/history/delete/begin';
export const HISTORY_FINISH_PATH = '/api/ui/history/delete/finish';
export const HISTORY_UNDO_PATH = '/api/ui/history/delete/undo';
export const HISTORY_STATUS_PATH = '/api/ui/history/delete/status';
export const INBOX_REVEAL_PATH = '/api/ui/storage/inbox/reveal';
// FILES-REVEAL (08 §1): Show in Finder for the ID's own Send folder; same kind, same checks, no input.
export const SEND_FOLDER_REVEAL_PATH = '/api/ui/files/send-folder/reveal';

/** The steps of the history route kind (no presence; the finish is an ordinary presence route). */
export type LocalUiHistoryStep = 'begin' | 'undo' | 'status';

export const HISTORY_STEP_PATHS: Readonly<Record<LocalUiHistoryStep, string>> = Object.freeze({
  begin: HISTORY_BEGIN_PATH,
  undo: HISTORY_UNDO_PATH,
  status: HISTORY_STATUS_PATH,
});

export const isHistoryStep = (step: unknown): step is LocalUiHistoryStep =>
  step === 'begin' || step === 'undo' || step === 'status';
