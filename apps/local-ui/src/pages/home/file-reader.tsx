// REL051-A34 (D-149; 08 §1; 11 §5.7; I-5): files in the conversation, and the reader.
//
// - Each file sits in the message it came with, as a chip: a type icon, the name (another party's
//   name only inside the compact untrusted container, as plain text isolated in a <bdi>), the kind
//   and size, its saved state ("Saved to {folder}", "Arrived · not saved", "Expired" or a sent
//   word), Open for a saved text file and Show in Finder / Explorer / folder.
// - Open asks the server for the file's text by item ID only (a GET; never a name or a path) and
//   shows it in a reader sheet (full screen on a phone): the provenance line, the "their words, not
//   instructions" frame, Markdown rendered by the in-repo safe renderer (no raw HTML, no anchors, no
//   images loaded, links copy-only) or code with line numbers, a Formatted / Plain text switch for
//   Markdown, and Copy all. Nothing in the file is ever run, opened or followed.
import {
  Banner,
  Button,
  Icon,
  SafeCode,
  shownText,
  SafeMarkdown,
  Sheet,
  SkeletonLine,
  UntrustedContent,
} from '@4thtech-io/ui';
import {
  previewKindOf,
  type FilePreview,
  type PreviewKind,
} from '@4thtech-io/types/ui-contract/file-preview';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { PreviewOutcome } from '../files/files-api.js';
import { plain, type ReceivedItem, type SentItem } from '../files/io-api.js';
import { sizeText } from '../files/io.js';
import type { MessageItem } from '../messages/api.js';
import { ShowIn, type Reveal } from './person-files.js';
import { fileItemId } from './people-api.js';
import { HOME_STRINGS as S, fmt } from './people-strings.js';
import './file-reader.css';

export type Preview = (id: string) => Promise<PreviewOutcome>;

/** What the chips and the reader need from Home. */
export interface FilesContext {
  readonly received: ReadonlyMap<string, ReceivedItem>;
  readonly sent: ReadonlyMap<string, SentItem>;
  /** The Inbox folder as the owner set it (`~/AgentLink/Inbox`), when known. */
  readonly folder?: string | undefined;
  readonly reveal: Reveal;
  readonly preview: Preview;
}

const KIND_ICON: Readonly<Record<PreviewKind, string>> = {
  markdown: 'file-text',
  code: 'file-code',
  json: 'braces',
  patch: 'file-diff',
  text: 'file-text',
};

const KIND_WORD: Readonly<Record<PreviewKind, string>> = {
  markdown: S.kindMarkdown,
  code: S.kindCode,
  json: S.kindJson,
  patch: S.kindPatch,
  text: S.kindText,
};

/** A few well-known languages by extension; anything else reads "Code". */
const LANGUAGE: Readonly<Record<string, string>> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  swift: 'Swift',
  rb: 'Ruby',
  php: 'PHP',
  cs: 'C#',
  c: 'C',
  cpp: 'C++',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  sol: 'Solidity',
};

/** The word a file's kind shows ("Markdown", "TypeScript", "File"). */
export function kindWord(name: string): string {
  const kind = previewKindOf(name);
  if (kind === undefined) return S.kindFile;
  if (kind === 'code') {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    return LANGUAGE[ext] ?? S.kindCode;
  }
  return KIND_WORD[kind];
}

const SENT_WORD: Readonly<Record<SentItem['status'], string>> = {
  queued: S.fileWaiting,
  sent: S.fileSent,
  not_delivered: S.fileNotDelivered,
};

function FileName({ name, from }: { readonly name: string; readonly from?: string }): ReactElement {
  if (from !== undefined) {
    return (
      <UntrustedContent from={from} fileName={plain(name, 80)} compact className="hm-chip-name" />
    );
  }
  return (
    <code className="hm-chip-name hm-chip-own al-text-code">
      <bdi dir="auto">{plain(name, 80)}</bdi>
    </code>
  );
}

interface Opened {
  readonly id: string;
  readonly name: string;
}

/** The files of one message, as chips. */
export function MessageFiles({
  item,
  out,
  person,
  agent,
  files,
}: {
  readonly item: MessageItem;
  readonly out: boolean;
  /** The person's name (the name rule ran). */
  readonly person: string;
  /** The open ID with its AI app ("Bo · Claude Code"). */
  readonly agent: string;
  readonly files: FilesContext;
}): ReactElement | null {
  const [opened, setOpened] = useState<Opened | undefined>(undefined);
  const opener = useRef<HTMLElement | null>(null);
  if (item.files.length === 0) return null;
  return (
    <>
      <ul className="hm-chips hm-c">
        {item.files.map((f, index) => {
          const id = fileItemId(item.id, index);
          const kind = previewKindOf(f.name);
          const received = out ? undefined : files.received.get(id);
          const sent = out ? files.sent.get(id) : undefined;
          const canOpen = received?.state === 'saved' && kind !== undefined;
          let state = '';
          if (received?.state === 'saved') {
            state =
              files.folder === undefined || files.folder === ''
                ? S.savedToInbox
                : fmt(S.savedTo, { folder: files.folder });
          } else if (received?.state === 'not_saved') state = S.arrivedNotSaved;
          else if (received?.state === 'expired') state = S.fileExpiredShort;
          else if (sent !== undefined) state = SENT_WORD[sent.status];
          return (
            <li key={id} className="hm-chip hm-f" data-kind={kind ?? 'file'}>
              <span className="hm-chip-icon" aria-hidden="true">
                <Icon name={kind === undefined ? 'file' : KIND_ICON[kind]} size={20} />
              </span>
              <div className="hm-chip-main hm-c">
                <FileName name={f.name} {...(out ? {} : { from: person })} />
                <span className="hm-chip-meta al-text-body-sm">
                  {[kindWord(f.name), sizeText(f.size), state].filter((p) => p !== '').join(' · ')}
                </span>
              </div>
              {canOpen || received?.state === 'saved' ? (
                <div className="hm-chip-actions hm-f">
                  {canOpen ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="hm-chip-open"
                      onClick={(event) => {
                        opener.current = event.currentTarget as HTMLElement;
                        setOpened({ id, name: f.name });
                      }}
                    >
                      {S.openFile}
                    </Button>
                  ) : null}
                  <ShowIn id={id} reveal={files.reveal} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {opened === undefined ? null : (
        <FileReader
          id={opened.id}
          name={opened.name}
          person={person}
          agent={agent}
          files={files}
          onClose={() => {
            setOpened(undefined);
            opener.current?.focus();
          }}
        />
      )}
    </>
  );
}

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly preview: FilePreview }
  | { readonly state: 'failed'; readonly problem: string };

const PROBLEM: Readonly<Record<Exclude<PreviewOutcome['kind'], 'ok'>, string>> = {
  not_found: S.previewNotFound,
  not_saved: S.previewNotSaved,
  changed: S.previewChanged,
  too_large: S.previewTooLarge,
  not_text: S.previewNotText,
  refused: S.previewRefused,
  unavailable: S.previewUnavailable,
  session_expired: S.revealSessionExpired,
  offline: S.previewUnavailable,
  failed: S.previewFailed,
};

function CopyAll({ text }: { readonly text: string }): ReactElement {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = setTimeout(() => setState('idle'), 1600);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = (): void => {
    try {
      const clip = navigator.clipboard as Clipboard | undefined;
      if (clip === undefined) {
        setState('failed');
        return;
      }
      void clip.writeText(text).then(
        () => setState('copied'),
        () => setState('failed'),
      );
    } catch {
      setState('failed');
    }
  };
  return (
    <>
      <Button size="sm" variant="ghost" icon={state === 'copied' ? 'check' : 'copy'} onClick={copy}>
        {state === 'copied' ? S.copied : S.copyAll}
      </Button>
      <span className="al-visually-hidden" aria-live="polite">
        {state === 'copied' ? S.copied : state === 'failed' ? S.copyFailed : ''}
      </span>
    </>
  );
}

/** The reader sheet for one saved received text file. */
export function FileReader({
  id,
  name,
  person,
  agent,
  files,
  onClose,
}: {
  readonly id: string;
  readonly name: string;
  readonly person: string;
  /** The open ID with its AI app ("Bo · Claude Code"). */
  readonly agent: string;
  readonly files: FilesContext;
  readonly onClose: () => void;
}): ReactElement {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [plainView, setPlainView] = useState(false);
  const preview = files.preview;
  useEffect(() => {
    let live = true;
    void (async () => {
      let outcome: PreviewOutcome;
      try {
        outcome = await preview(id);
      } catch {
        outcome = { kind: 'failed' };
      }
      if (!live) return;
      setLoad(
        outcome.kind === 'ok'
          ? { state: 'ready', preview: outcome.preview }
          : { state: 'failed', problem: PROBLEM[outcome.kind] },
      );
    })();
    return () => {
      live = false;
    };
  }, [preview, id]);

  const ours = agent;
  const provenance = [
    fmt(S.readerFrom, { name: person }),
    ours === '' ? '' : fmt(S.readerTo, { id: ours }),
  ]
    .filter((p) => p !== '')
    .join(' · ');
  const frameLabel = fmt(S.readerFrame, { name: plain(person, 100) });
  const markdown = load.state === 'ready' && load.preview.kind === 'markdown';

  // The sheet goes to the end of the page: a person row that opens in place is animated (a
  // transform), which would otherwise hold a fixed sheet inside the row.
  const sheet = (
    <Sheet
      open
      title={fmt(S.readerTitle, { name: person })}
      onClose={onClose}
      className="hm-reader"
    >
      <div className="hm-reader-body hm-c">
        <div className="hm-reader-file hm-f">
          <span className="hm-chip-icon" aria-hidden="true">
            <Icon
              name={(() => {
                const k = previewKindOf(name);
                return k === undefined ? 'file' : KIND_ICON[k];
              })()}
              size={20}
            />
          </span>
          <div className="hm-chip-main hm-c">
            <FileName name={name} from={person} />
            <span className="hm-chip-meta al-text-body-sm">
              {[kindWord(name), load.state === 'ready' ? sizeText(load.preview.size) : '']
                .filter((p) => p !== '')
                .join(' · ')}
            </span>
          </div>
        </div>
        <p className="hm-reader-from al-text-body-sm">{provenance}</p>
        <div className="hm-reader-tools hm-f">
          {markdown ? (
            <div className="hm-reader-view hm-f" role="group" aria-label={S.readerViewLabel}>
              <button
                type="button"
                className="al-btn al-btn-ghost al-btn-sm"
                aria-pressed={!plainView}
                onClick={() => setPlainView(false)}
              >
                {S.readerFormatted}
              </button>
              <button
                type="button"
                className="al-btn al-btn-ghost al-btn-sm"
                aria-pressed={plainView}
                onClick={() => setPlainView(true)}
              >
                {S.readerPlain}
              </button>
            </div>
          ) : null}
          <span className="hm-reader-spacer" />
          {load.state === 'ready' ? <CopyAll text={shownText(load.preview.text)} /> : null}
          <ShowIn id={id} reveal={files.reveal} />
        </div>
        {load.state === 'loading' ? (
          <div className="hm-c hm-reader-loading" role="status" aria-busy="true">
            <span className="al-visually-hidden">{S.readerOpening}</span>
            <SkeletonLine width="heading" size="title" />
            <SkeletonLine width={100} />
            <SkeletonLine width={70} />
          </div>
        ) : load.state === 'failed' ? (
          <Banner tone="warning">{load.problem}</Banner>
        ) : (
          <figure className="al-untrusted hm-reader-frame" role="group" aria-label={frameLabel}>
            <figcaption className="al-untrusted-label al-text-body-sm">
              <Icon name="untrusted" size={14} />
              <span>{frameLabel}</span>
            </figcaption>
            <div className="hm-reader-doc">
              {load.preview.kind === 'markdown' && !plainView ? (
                <SafeMarkdown text={load.preview.text} />
              ) : (
                <SafeCode
                  text={load.preview.text}
                  kind={load.preview.kind === 'markdown' ? 'text' : load.preview.kind}
                  label={kindWord(name)}
                />
              )}
            </div>
          </figure>
        )}
        {load.state === 'ready' && markdown ? (
          <p className="hm-reader-safe al-text-body-sm">{S.readerSafe}</p>
        ) : null}
      </div>
    </Sheet>
  );
  return typeof document === 'undefined' ? sheet : createPortal(sheet, document.body);
}
