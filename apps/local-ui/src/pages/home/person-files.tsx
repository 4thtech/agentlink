// W4-HOME: one person's files, under their conversation (prototype v23 A4; W4 UX v2 "Files";
// ux-inventory §9 item 3; 11 §5.7). Received and sent, newest first, from the same pages as the
// conversation:
//
// - received: one light row (W4-WIRE-3; 11 §5.7): "<name> · Saved to ~/AgentLink/Inbox" with Show in
//   Finder (macOS) / Show in Explorer (Windows) / Show in folder (Linux and others), plus "Saved as
//   <name>" only when the saved name differs; or "Arrived · not saved" with Save to Inbox (#714's
//   signed `file.save`, one presence step), or Expired;
// - sent: "To <name>" and its delivery word.
//
// Show in Finder and Save send only the item's ID (04 §4; files-api.ts reveal, inbox/save-api.ts):
// never a name, a folder or a path, and no answer carries one. The other party's file names are
// untrusted (I-5, D-133 (4)): only inside the untrusted container, in its compact inline form (the
// dashed edge and mark, not the message box), as plain React text cleaned of hidden and direction
// characters, capped and isolated in a `<bdi dir="auto">`. The folder ("Saved to …") is the owner's
// own setting, outside the container. `folderNote` is K3's slot.
import { Button, Icon, UntrustedContent } from '@4thtech-io/ui';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { detectOs } from '../../layout/os.js';
import type { RevealOutcome } from '../files/files-api.js';
import { plain, type ReceivedItem, type SentItem } from '../files/io-api.js';
import { sizeText } from '../files/io.js';
import type { MessageItem } from '../messages/api.js';
import type { SaveApi } from '../inbox/save-api.js';
import { SaveFile, type PasskeyReader } from '../inbox/save.js';
import { shortTime } from './conversation.js';
import { fileItemId } from './people-api.js';
import { HOME_STRINGS as S, fmt } from './people-strings.js';

/** The file manager's name by host OS (11 §5.7; W4 UX v2). */
export function showInLabel(): string {
  const os = detectOs();
  if (os === 'macos') return S.showInFinder;
  if (os === 'windows') return S.showInExplorer;
  return S.showInFolder;
}

const REVEAL_PROBLEM: Readonly<Record<Exclude<RevealOutcome, 'shown'>, string>> = {
  not_found: S.revealNotFound,
  refused: S.revealRefused,
  unavailable: S.revealUnavailable,
  not_opened: S.revealFailed,
  session_expired: S.revealSessionExpired,
  offline: S.revealUnavailable,
  failed: S.revealFailed,
};

export type Reveal = (id: string) => Promise<RevealOutcome>;

function ShowIn({ id, reveal }: { readonly id: string; readonly reveal: Reveal }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const click = async (): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    let outcome: RevealOutcome;
    try {
      outcome = await reveal(id);
    } catch {
      outcome = 'failed';
    }
    if (!alive.current) return;
    setBusy(false);
    setProblem(outcome === 'shown' ? undefined : REVEAL_PROBLEM[outcome]);
  };
  return (
    <span className="hm-file-actions hm-f">
      <Button size="sm" icon="folder" disabled={busy} onClick={() => void click()}>
        {showInLabel()}
      </Button>
      <span role="status" className="hm-file-problem al-text-body-sm">
        {problem ?? ''}
      </span>
    </span>
  );
}

/**
 * A file name. Another party's (`from`) sits only inside the compact untrusted container (D-133 (4),
 * I-5): plain text, at most 80 characters, isolated. Your own is plain mono text.
 */
function FileName({ name, from }: { readonly name: string; readonly from?: string }): ReactElement {
  if (from !== undefined) {
    return (
      <UntrustedContent from={from} fileName={plain(name, 80)} compact className="hm-file-own" />
    );
  }
  return (
    <code className="hm-file-own al-text-code">
      <bdi dir="auto">{plain(name, 80)}</bdi>
    </code>
  );
}

interface FileRow {
  readonly id: string;
  readonly out: boolean;
  readonly name: string;
  readonly size: number;
  readonly at: number;
}

/** Every file of the loaded pages, newest first. */
export function filesOf(
  inbox: readonly MessageItem[],
  sent: readonly MessageItem[],
): readonly FileRow[] {
  const rows: FileRow[] = [];
  const add = (m: MessageItem, out: boolean): void =>
    m.files.forEach((f, i) =>
      rows.push({ id: fileItemId(m.id, i), out, name: f.name, size: f.size, at: m.at }),
    );
  inbox.forEach((m) => add(m, false));
  sent.forEach((m) => add(m, true));
  return rows.sort((a, b) => b.at - a.at);
}

function ReceivedState({
  file,
  folder,
  save,
  passkey,
  reveal,
  onSaved,
}: {
  readonly file: ReceivedItem | undefined;
  readonly folder: string | undefined;
  readonly save: SaveApi;
  readonly passkey: PasskeyReader;
  readonly reveal: Reveal;
  readonly onSaved: () => void;
}): ReactElement | null {
  if (file === undefined) return null;
  if (file.state === 'saved') {
    return (
      <div className="hm-file-state hm-f">
        <span className="al-text-body-sm">
          {folder === undefined ? S.savedToInbox : fmt(S.savedTo, { folder })}
        </span>
        {file.savedName === null || file.savedName === file.name ? null : (
          <span className="al-text-body-sm">
            {S.savedAs} <FileName name={file.savedName} from={file.from} />
          </span>
        )}
        <ShowIn id={file.id} reveal={reveal} />
      </div>
    );
  }
  if (file.state === 'expired') {
    return <p className="hm-file-state hm-f al-text-body-sm al-muted">{S.expired}</p>;
  }
  if (file.state !== 'not_saved') return null;
  return (
    <div className="hm-file-state hm-f">
      <span className="al-text-body-sm al-muted">{S.arrivedNotSaved}</span>
      <SaveFile id={file.id} api={save} passkey={passkey} onSaved={onSaved} />
    </div>
  );
}

const SENT_WORD: Readonly<Record<SentItem['status'], string>> = {
  queued: S.fileWaiting,
  sent: S.fileSent,
  not_delivered: S.fileNotDelivered,
};

export function PersonFiles({
  name,
  rows,
  received,
  sent,
  save,
  passkey,
  reveal,
  onSaved,
  folder,
  folderNote,
}: {
  readonly name: string;
  readonly rows: readonly FileRow[];
  readonly received: ReadonlyMap<string, ReceivedItem>;
  readonly sent: ReadonlyMap<string, SentItem>;
  readonly save: SaveApi;
  readonly passkey: PasskeyReader;
  readonly reveal: Reveal;
  readonly onSaved: () => void;
  /** W4-WIRE-3: the Inbox folder (`~/AgentLink/Inbox`) a saved file's row names, when known. */
  readonly folder?: string;
  /** K3 (W4-AUTO-SAVE): "Saved to <folder>" and its Show in Finder, at the end of the title row. */
  readonly folderNote?: ReactNode;
}): ReactElement {
  return (
    <div className="hm-files hm-c">
      <div className="hm-files-head hm-f">
        <span className="hm-kicker al-text-label">{S.filesTitle}</span>
        {folderNote ?? null}
      </div>
      {rows.length === 0 ? (
        <p className="al-text-body-sm al-muted">{fmt(S.noFiles, { name })}</p>
      ) : (
        <ul className="hm-file-list">
          {rows.map((row) => {
            const meta = `${fmt(row.out ? S.toName : S.fromName, { name })} · ${shortTime(row.at)} · ${sizeText(row.size)}`;
            const sentItem = row.out ? sent.get(row.id) : undefined;
            return (
              <li key={`${row.out ? 'o' : 'i'}-${row.id}`} className="hm-file hm-f">
                <Icon name="file" size={18} />
                <div className="hm-file-main hm-c">
                  <FileName name={row.name} {...(row.out ? {} : { from: name })} />
                  <span className="hm-file-meta al-text-body-sm">{meta}</span>
                </div>
                {row.out ? (
                  sentItem === undefined ? null : (
                    <span className="hm-file-state hm-f al-text-body-sm">
                      {SENT_WORD[sentItem.status]}
                    </span>
                  )
                ) : (
                  <ReceivedState
                    file={received.get(row.id)}
                    folder={folder}
                    save={save}
                    passkey={passkey}
                    reveal={reveal}
                    onSaved={onSaved}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export type { FileRow };
