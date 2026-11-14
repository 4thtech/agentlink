// APP-CONTINUITY (08 §1 "One AgentLink, browser or app"; 04 §2.5 Residuals): AgentLink set up in
// the browser first keeps its IDs and owner in the macOS keychain, saved there by the browser
// version's Node. The app's core reads them with its own bundled Node, so macOS asks once per item
// whether to allow it. That system dialog names "node" and asks for the Mac's login password. It
// looks alarming and must never be mistaken for the master code, so before the core's first start
// on such a Mac the app says what is coming, once (a marker in the app's own data folder).
//
// Shown only on macOS, only when `~/.agentlink` already holds something (made before the app), and
// only once per app profile. Fixed text (11 §5); nothing from a file or the environment is shown,
// and nothing is read from the keychain here.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageBoxOptions } from './electron-api.js';

/** The marker file in the app's user-data folder: the notice was shown on this profile. */
export const KEYCHAIN_NOTICE_FILE = 'keychain-notice.json';

export interface KeychainNoticeInput {
  readonly platform: string;
  readonly homeDir: string;
  /** The app's user-data folder ('' when unknown: then nothing is shown). */
  readonly stateDir: string;
  readonly exists: (path: string) => boolean;
  /** Entries of a folder (default readdirSync); any failure counts as empty. */
  readonly list?: (path: string) => readonly string[];
}

/** True when the notice should be shown before the core's first start. Never throws. */
export function needsKeychainNotice(input: KeychainNoticeInput): boolean {
  if (input.platform !== 'darwin' || input.stateDir === '') return false;
  if (input.exists(join(input.stateDir, KEYCHAIN_NOTICE_FILE))) return false;
  const data = join(input.homeDir, '.agentlink');
  if (!input.exists(data)) return false;
  let entries: readonly string[];
  try {
    entries = (input.list ?? ((path: string) => readdirSync(path)))(data);
  } catch {
    return false;
  }
  return entries.length > 0;
}

/** The notice: fixed words, one button. */
export function keychainNoticeDialog(): MessageBoxOptions {
  return {
    type: 'info',
    buttons: ['Continue'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'AgentLink',
    message: 'macOS will ask to let AgentLink use your saved IDs',
    detail:
      'You set up AgentLink in your browser first, so your IDs are saved in your Mac’s keychain. ' +
      'Next, macOS asks once for each of them. The window says “node”: that is AgentLink. ' +
      'Type your Mac login password (never your master code) and choose Always Allow.',
  };
}

/** Records that the notice was shown (best effort; a failed write shows it again next time). */
export function markKeychainNoticeShown(stateDir: string): void {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, KEYCHAIN_NOTICE_FILE), `${JSON.stringify({ v: 1 })}\n`, {
      mode: 0o600,
    });
  } catch {
    // Nothing to do: the notice is a courtesy, never a gate.
  }
}
