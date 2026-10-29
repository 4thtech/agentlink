// U3-i: the change panel (b11 §30.3) and the manual steps (§30.4). The panel shows the exact
// AgentLink entry first (the only part of an AI app's file the page ever receives), then asks for
// Touch ID (or the backup code) once. The page never signs and never writes: it hands the proof to
// one request and the server does the rest (04 §2.5). Files and entries are rendered as text only.
import { Button, Sheet, Skeleton } from '@4thtech-io/ui';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { CONTACTS_STRINGS as C, waitSeconds } from '../contacts/strings.js';
import type { OwnerClient, PresenceProof } from '../contacts/owner.js';
import { OwnerGate, usePasskey } from '../agents/owner-gate.js';
import type { AppsApi, ChangeKind } from './api.js';
import { entryText, genericEntry, type AppChange, type AppRow, type Entry } from './data.js';
import { APPS_STRINGS as S } from './strings.js';

/** How the person's agents are worded here: the open agent, and any other by label or folder. */
export interface Labels {
  readonly folder: string;
  readonly label: string;
  readonly labelOf: (folder: string) => string;
}

function gateMessage(kind: ChangeKind): string | undefined {
  switch (kind) {
    case 'rejected':
      return C.presenceRejected;
    case 'required':
      return C.presenceRequired;
    case 'busy':
      return C.busy;
    case 'wait':
      return waitSeconds(30);
    case 'session':
      return C.sessionExpired;
    case 'offline':
      return S.offline;
    default:
      return undefined;
  }
}
const RETRY_IN_PLACE: ReadonlySet<ChangeKind> = new Set([
  'rejected',
  'required',
  'wait',
  'busy',
  'offline',
]);

function EntryBlock({
  label,
  entry,
  removed,
}: {
  label: string;
  entry: Entry;
  removed?: boolean;
}): ReactElement {
  return (
    <div role="region" aria-label={label} tabIndex={0}>
      <pre className={removed === true ? 'ap-entry ap-entry-removed' : 'ap-entry'}>
        {entryText(entry)}
      </pre>
    </div>
  );
}

type Preview =
  | { readonly kind: 'loading' }
  | { readonly kind: 'change'; readonly change: AppChange }
  | { readonly kind: 'none'; readonly status: string }
  | { readonly kind: 'error' };

export function ChangePanel({
  app,
  labels,
  api,
  owner,
  onClose,
  onDone,
  onManual,
  onAgentChanged,
}: {
  app: AppRow;
  labels: Labels;
  api: AppsApi;
  owner: OwnerClient;
  onClose: () => void;
  onDone: (change: AppChange) => void;
  onManual: (entry: Entry | undefined) => void;
  onAgentChanged: () => void;
}): ReactElement {
  const passkey = usePasskey(owner);
  const [preview, setPreview] = useState<Preview>({ kind: 'loading' });
  const [step, setStep] = useState<'review' | 'presence'>('review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tried, setTried] = useState(false);

  const read = useCallback((): void => {
    setPreview({ kind: 'loading' });
    void api.preview(app.app, labels.folder).then((out) => {
      if (out.kind === 'change') setPreview({ kind: 'change', change: out.change });
      else if (out.kind === 'none') setPreview({ kind: 'none', status: out.status });
      else if (out.kind === 'agent_changed') onAgentChanged();
      else setPreview({ kind: 'error' });
    });
  }, [api, app.app, labels.folder, onAgentChanged]);
  useEffect(read, [read]);

  const change = preview.kind === 'change' ? preview.change : undefined;
  const title =
    change === undefined
      ? app.name
      : change.kind === 'connect'
        ? S.connectTitle(app.name, labels.label)
        : change.kind === 'move'
          ? S.moveTitle(app.name, labels.label)
          : S.disconnectTitle(app.name, labels.label);

  const send = (proof: PresenceProof): void => {
    if (busy || change === undefined) return;
    setBusy(true);
    setError(undefined);
    const run = change.kind === 'disconnect' ? api.disconnect : api.apply;
    void run(change.changeId, proof).then((outcome) => {
      setBusy(false);
      const kind = outcome.kind;
      if (kind === 'done') return onDone(change);
      const said = gateMessage(kind);
      if (said !== undefined) {
        setError(said);
        if (!RETRY_IN_PLACE.has(kind)) setStep('review');
        return;
      }
      setStep('review');
      if (kind === 'changed') {
        setError(S.changed);
        return read();
      }
      if (kind === 'quit_first') {
        setError(S.quitFirst(app.name));
        return read();
      }
      if (kind === 'agent_changed') {
        setError(S.agentChanged);
        return onAgentChanged();
      }
      setTried(true);
      setError(S.couldntChange(app.name));
    });
  };

  const statement =
    change === undefined
      ? ''
      : change.kind === 'connect'
        ? S.statementConnect(app.name, labels.label)
        : change.kind === 'move'
          ? S.statementMove(app.name, labels.label, labels.labelOf(change.oldAgent ?? ''))
          : S.statementDisconnect(app.name, labels.label);

  return (
    <Sheet open title={title} onClose={onClose} closeLabel={S.close} className="ap-sheet">
      {step === 'presence' && change !== undefined ? (
        <OwnerGate
          summary={statement}
          passkey={passkey}
          busy={busy}
          error={error}
          onProof={send}
          onCancel={() => {
            setStep('review');
            setError(S.notChangedYet);
          }}
        />
      ) : (
        <div className="ap-sheet-body">
          {preview.kind === 'loading' ? (
            <Skeleton loading lines={3}>
              <span />
            </Skeleton>
          ) : preview.kind === 'error' ? (
            <>
              <p className="al-text-body" role="alert">
                {S.loadError}
              </p>
              <div className="ap-card-actions">
                <Button variant="secondary" onClick={read}>
                  {S.tryAgain}
                </Button>
                <Button variant="ghost" onClick={() => onManual(undefined)}>
                  {S.showManual}
                </Button>
              </div>
            </>
          ) : preview.kind === 'none' ? (
            <NoChange app={app} status={preview.status} onCheck={read} onManual={onManual} />
          ) : (
            <>
              <p className="al-text-body">
                {change?.kind === 'move'
                  ? S.willUse(app.name, labels.label, labels.labelOf(change.oldAgent ?? ''))
                  : change?.kind === 'disconnect'
                    ? S.willStop(app.name, labels.label)
                    : S.addsOne(app.name)}
              </p>
              <dl className="ap-facts">
                <dt className="al-text-body-sm">{S.file}</dt>
                <dd className="al-text-body-sm">{change?.path}</dd>
              </dl>
              {change?.kind === 'move' && change.oldEntry !== null ? (
                <div className="ap-entries">
                  <EntryBlock label={S.removedRegion} entry={change.oldEntry} removed />
                  {change.newEntry === null ? null : (
                    <EntryBlock label={S.entryRegion} entry={change.newEntry} />
                  )}
                </div>
              ) : change?.kind === 'disconnect' && change.oldEntry !== null ? (
                <EntryBlock label={S.removedRegion} entry={change.oldEntry} removed />
              ) : change?.newEntry != null ? (
                <EntryBlock label={S.entryRegion} entry={change.newEntry} />
              ) : null}
              <p className="al-text-body-sm al-muted">
                {S.folder(change?.folder ?? labels.folder)} {S.backup}
              </p>
              {error === undefined ? null : (
                <p className="al-text-body-sm" role="alert">
                  {error}
                </p>
              )}
              <div className="ap-card-actions">
                <Button
                  variant="primary"
                  icon="approval"
                  onClick={() => {
                    setError(undefined);
                    setStep('presence');
                  }}
                  disabled={busy}
                >
                  {S.apply}
                </Button>
                {tried ? (
                  <Button variant="ghost" onClick={() => onManual(change?.newEntry ?? undefined)}>
                    {S.showManual}
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={onClose}>
                  {S.cancel}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

function NoChange({
  app,
  status,
  onCheck,
  onManual,
}: {
  app: AppRow;
  status: string;
  onCheck: () => void;
  onManual: (entry: Entry | undefined) => void;
}): ReactElement {
  if (status === 'quit_first') {
    return (
      <>
        <p className="al-text-body" role="status">
          {S.quitFirst(app.name)}
        </p>
        <div className="ap-card-actions">
          <Button variant="secondary" onClick={onCheck}>
            {S.checkAgain}
          </Button>
          <Button variant="primary" icon="approval" disabled>
            {S.apply}
          </Button>
        </div>
      </>
    );
  }
  if (status === 'conflict') {
    return (
      <>
        <p className="al-text-body" role="status">
          {S.notOurs}
        </p>
        <div className="ap-card-actions">
          <Button variant="secondary" onClick={() => onManual(undefined)}>
            {S.showManual}
          </Button>
        </div>
      </>
    );
  }
  return (
    <>
      <p className="al-text-body" role="status">
        {S.cantRead}
      </p>
      <div className="ap-card-actions">
        <Button variant="secondary" onClick={onCheck}>
          {S.tryAgain}
        </Button>
        <Button variant="ghost" onClick={() => onManual(undefined)}>
          {S.showManual}
        </Button>
      </div>
    </>
  );
}

export function ManualPanel({
  app,
  folder,
  entry,
  onClose,
}: {
  app: AppRow | undefined;
  folder: string;
  entry: Entry | undefined;
  onClose: () => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const text = entryText(entry ?? genericEntry(folder));
  const name = app?.name;
  const copy = (): void => {
    try {
      void navigator.clipboard.writeText(text).then(
        () => setCopied(true),
        () => undefined,
      );
    } catch {
      // No clipboard: the text is selectable.
    }
  };
  return (
    <Sheet
      open
      title={name === undefined ? S.manualTitleGeneric : S.manualTitle(name)}
      onClose={onClose}
      closeLabel={S.close}
      className="ap-sheet"
    >
      <div className="ap-sheet-body">
        <p className="al-text-body">{S.manualIntro}</p>
        {app === undefined ? null : (
          <dl className="ap-facts">
            <dt className="al-text-body-sm">{S.file}</dt>
            <dd className="al-text-body-sm">{app.path}</dd>
          </dl>
        )}
        <div role="region" aria-label={S.entryRegion} tabIndex={0}>
          <pre className="ap-entry">{text}</pre>
        </div>
        <div className="ap-card-actions">
          <Button variant="secondary" onClick={copy}>
            {copied ? S.copied : S.copy}
          </Button>
        </div>
        <ol className="ap-steps al-text-body">
          <li>{S.manualOpen}</li>
          <li>{S.manualAdd}</li>
          <li>{S.manualRestart(name ?? S.genericApp)}</li>
        </ol>
      </div>
    </Sheet>
  );
}
