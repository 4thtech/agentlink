// ATT-APP-ATTACH (08 §1 "Attach a file"; 11 §5; D-116: styled from the conversation's own file
// chips, buttons, banner and text area; I-4, I-5): attach light text files in a conversation and
// send them to that person yourself.
//
// - Attach opens the file picker (.md, .markdown, .txt, .json; several at once). Dropping files
//   anywhere on the conversation does the same. Each file waits as a chip (the conversation's own
//   chip: type icon, name, kind and size) with Remove; nothing leaves before Send.
// - The page refuses another type, a file over 8 MB and more than 5 files with one plain line; the
//   server checks everything again (type, size, UTF-8, the Send folder).
// - Send posts once (attach-api.ts). Sent: the chips and the note clear, "Sent to {name}." and the
//   thread is read again. No Send folder: Home's Send folder banner, the files stay. Other refusals:
//   one plain line saying what to do. The browser signs nothing; there is no extra confirmation, as
//   for a message the owner's AI sends under the same rules.
// - The names shown are the owner's own files (local data), shown as text only.
import { Banner, Button, Icon, TextArea } from '@4thtech-io/ui';
import { useRef, useState, type DragEvent, type ReactElement, type ReactNode } from 'react';
import { sizeText } from '../files/io.js';
import {
  ATTACH_ACCEPT,
  ATTACH_MAX_FILES,
  ATTACH_MAX_TEXT_CHARS,
  attachFileProblem,
  type AttachApi,
  type AttachError,
} from './attach-api.js';
import { HOME_STRINGS as S, fmt } from './people-strings.js';
import './attach-composer.css';
import { SendFolderBanner, type SendFolderApi } from './send-folder-banner.js';

export interface AttachProps {
  /** The contact's agent ID (the route key, never shown). */
  readonly contactId: string;
  readonly api: AttachApi;
  readonly folderApi: SendFolderApi;
  /** After a send: read the thread again. */
  readonly onSent: () => void;
}

interface Pending {
  readonly key: number;
  readonly file: File;
}

type Notice =
  | { readonly tone: 'success' | 'info' | 'warning'; readonly text: string }
  | { readonly tone: 'folder' }
  | undefined;

const KIND: Readonly<Record<string, string>> = {
  md: 'Markdown',
  markdown: 'Markdown',
  txt: 'Text',
  json: 'JSON',
};

function kindOf(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return KIND[ext] ?? 'File';
}

function errorText(error: AttachError, name: string): string {
  switch (error) {
    case 'type':
      return S.attachType;
    case 'too_large':
      return S.attachTooLarge;
    case 'not_text':
      return S.attachNotText;
    case 'not_ready':
      return fmt(S.attachNotReady, { name });
    case 'policy':
      return S.attachPolicy;
    case 'storage':
      return S.attachStorage;
    case 'paused':
      return S.attachPaused;
    default:
      return S.attachFailed;
  }
}

const hasFiles = (event: DragEvent): boolean => {
  const types = event.dataTransfer?.types;
  return types === undefined || Array.from(types).includes('Files');
};

/**
 * The composer, wrapping `children` (the conversation) as the drop area. `name` is the person's
 * name as the name rule shows it.
 */
export function AttachComposer({
  contactId,
  name,
  api,
  folderApi,
  onSent,
  children,
}: AttachProps & { readonly name: string; readonly children?: ReactNode }): ReactElement {
  const [pending, setPending] = useState<readonly Pending[]>([]);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice>(undefined);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const nextKey = useRef(1);

  const add = (list: FileList | readonly File[] | null | undefined): void => {
    const files = list === null || list === undefined ? [] : Array.from(list);
    if (files.length === 0) return;
    let problem: Notice;
    const accepted: Pending[] = [];
    let room = ATTACH_MAX_FILES - pending.length;
    for (const file of files) {
      const why = attachFileProblem(file);
      if (why !== undefined) {
        problem = { tone: 'warning', text: errorText(why, name) };
        continue;
      }
      if (room <= 0) {
        problem = { tone: 'warning', text: S.attachTooMany };
        break;
      }
      accepted.push({ key: nextKey.current, file });
      nextKey.current += 1;
      room -= 1;
    }
    if (accepted.length > 0) setPending((prev) => [...prev, ...accepted]);
    setNotice(problem);
  };

  const remove = (key: number): void => {
    setPending((prev) => prev.filter((p) => p.key !== key));
    setNotice(undefined);
  };

  const send = async (): Promise<void> => {
    if (pending.length === 0 || sending) return;
    setSending(true);
    setNotice(undefined);
    const result = await api.send(
      contactId,
      note,
      pending.map((p) => p.file),
    );
    setSending(false);
    if (result.ok) {
      setPending([]);
      setNote('');
      setNotice(
        result.status === 'sent'
          ? { tone: 'success', text: fmt(S.attachSent, { name }) }
          : result.status === 'queued'
            ? { tone: 'info', text: fmt(S.attachQueued, { name }) }
            : { tone: 'warning', text: fmt(S.attachNotDelivered, { name }) },
      );
      onSent();
      return;
    }
    if (result.error === 'no_folder') {
      setNotice({ tone: 'folder' });
      return;
    }
    setNotice({ tone: 'warning', text: errorText(result.error, name) });
  };

  return (
    <div
      className={over ? 'hm-attach-zone hm-c is-over' : 'hm-attach-zone hm-c'}
      data-attach-zone=""
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setOver(false);
        add(event.dataTransfer?.files);
      }}
    >
      {children}
      <section className="hm-attach hm-c" aria-label={fmt(S.attachTitle, { name })}>
        {over ? (
          <p className="hm-attach-drop al-text-body-sm" aria-hidden="true">
            <Icon name="download" size={16} />
            <span>{S.attachDropActive}</span>
          </p>
        ) : null}
        {pending.length === 0 ? null : (
          <ul className="hm-chips hm-c" aria-label={fmt(S.attachTitle, { name })}>
            {pending.map(({ key, file }) => (
              <li
                key={key}
                className="hm-chip hm-f"
                data-kind={kindOf(file.name) === 'JSON' ? 'json' : 'markdown'}
                data-attach-chip=""
              >
                <span className="hm-chip-icon" aria-hidden="true">
                  <Icon name={kindOf(file.name) === 'JSON' ? 'braces' : 'file-text'} size={20} />
                </span>
                <div className="hm-chip-main hm-c">
                  <code className="hm-chip-name hm-chip-own al-text-code">
                    <bdi dir="auto">{file.name}</bdi>
                  </code>
                  <span className="hm-chip-meta al-text-body-sm">
                    {kindOf(file.name)} · {sizeText(file.size)}
                  </span>
                </div>
                <div className="hm-chip-actions hm-f">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="x"
                    aria-label={fmt(S.attachRemove, { file: file.name })}
                    disabled={sending}
                    onClick={() => remove(key)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        {pending.length === 0 ? null : (
          <TextArea
            label={S.attachNote}
            rows={2}
            maxLength={ATTACH_MAX_TEXT_CHARS}
            value={note}
            disabled={sending}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        )}
        <div className="hm-attach-actions hm-f">
          <input
            ref={input}
            type="file"
            multiple
            accept={ATTACH_ACCEPT}
            hidden
            tabIndex={-1}
            onChange={(event) => {
              add(event.currentTarget.files);
              // The same file can be picked again after Remove.
              event.currentTarget.value = '';
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            aria-label={S.attachLabel}
            disabled={sending}
            onClick={() => input.current?.click()}
          >
            {S.attach}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={pending.length === 0 || sending}
            onClick={() => void send()}
          >
            {sending ? S.attachSending : S.attachSend}
          </Button>
          {pending.length === 0 ? (
            <span className="hm-attach-hint al-text-body-sm al-muted">{S.attachDrop}</span>
          ) : null}
        </div>
        <div role="status" aria-live="polite" className="hm-attach-status">
          {notice === undefined ? null : notice.tone === 'folder' ? (
            <>
              <SendFolderBanner api={folderApi} agentKey={contactId} />
              <p className="hm-dl-hint">{S.attachNoFolder}</p>
            </>
          ) : (
            <Banner tone={notice.tone} compact>
              {notice.text}
            </Banner>
          )}
        </div>
      </section>
    </div>
  );
}
