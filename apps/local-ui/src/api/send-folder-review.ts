// ATT-SENDFOLDER-FIX (IR-ATT-SENDFOLDER-1 M-1; 11 §5): the Send folder a begin answer names (first
// run, New ID), shown before the gesture. Its real path is local data, shown as text only; when it
// already holds files the owner reads that those can be sent too.
import { HOLDS_FILES_LINE, sendFromLine } from '../strings.js';

export interface SendFolderReview {
  readonly folder: string;
  readonly holdsFiles: boolean;
}

// Control, format (bidi, zero-width) and separator characters: never shown.
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** A begin answer's `sendFolderReview`, as fixed, checked fields only; undefined otherwise. */
export function parseSendFolderReview(value: unknown): SendFolderReview | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { folder, holdsFiles } = value as { folder?: unknown; holdsFiles?: unknown };
  if (typeof folder !== 'string' || folder.length === 0 || folder.length > 4096) return undefined;
  if (UNSHOWABLE.test(folder) || typeof holdsFiles !== 'boolean') return undefined;
  return { folder, holdsFiles };
}

/** The line shown before the gesture when the folder already holds files. */
export const holdsFilesNotice = (folder: string): string =>
  `${sendFromLine(folder)} ${HOLDS_FILES_LINE}`;
