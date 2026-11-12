// WP-11 (F-1 full, D-117 A; 04 §2.3.3; 07 §9.4): "Save recovery kit", the one in-app way to back up.
// The page never signs and never sees a seed: it sends one POST to the presence route
// `/api/ui/backup/export` with Touch ID (or the master code) as the proof and `{}` as the input; the
// server's gate signs `backup.export`, core records it, and the kit is sealed into a new file in the
// Downloads folder. The answer carries the file name and the new recovery code, which is shown once,
// kept only in this component's state and dropped at "I saved it" (or when the page closes). It is
// never logged, stored or sent anywhere. Shared by Settings › Backup and the ID card's Back up panel.
import { Button } from '@4thtech-io/ui';
import { useEffect, useId, useState, type ReactElement } from 'react';
import { createApiClient, type ApiClient, type OwnerApiResult } from '../../api/client.js';
import { forgetRecoveryKitLater } from '../../states/index.js';
import { gateMessage, OwnerGate } from '../agents/owner-gate.js';
import { createOwnerClient, type PasskeyInfo, type PresenceProof } from '../contacts/owner.js';
import { SaveChecklist } from './save-checklist.js';
import { BACKUP_STRINGS as S } from './strings.js';
import { dayOf, joinNames } from './status.js';

export const BACKUP_READ_PATH = '/api/ui/backup';
export const BACKUP_EXPORT_PATH = '/api/ui/backup/export';

const FILE = /^agentlink-recovery-kit-\d{4}-\d{2}-\d{2}(?:-\d{1,2})?\.alkk$/;
const CODE = /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}$/;

export interface SavedKit {
  readonly file: string;
  readonly folder: 'Downloads' | 'Home';
  readonly code: string;
  /** The IDs the kit covers, by name (text only). */
  readonly covers: readonly string[];
  /** The one-use Check handle (WP-R2), when the server gave one. */
  readonly check?: string;
}

/** What the export answered, in the page's terms. */
export type ExportOutcome =
  | { readonly kind: 'saved'; readonly kit: SavedKit }
  | { readonly kind: 'retry'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

/** Reads the server's answer strictly: anything unexpected is an error, never shown as text. */
export function exportOutcomeOf(result: OwnerApiResult): ExportOutcome {
  switch (result.kind) {
    case 'ok': {
      const d = result.data as Record<string, unknown> | null;
      if (
        typeof d === 'object' &&
        d !== null &&
        d['status'] === 'saved' &&
        typeof d['file'] === 'string' &&
        FILE.test(d['file']) &&
        (d['folder'] === 'Downloads' || d['folder'] === 'Home') &&
        typeof d['code'] === 'string' &&
        CODE.test(d['code'])
      ) {
        const covers = Array.isArray(d['covers'])
          ? d['covers']
              .map((c) =>
                typeof c === 'object' && c !== null ? (c as { name?: unknown }).name : c,
              )
              .filter((n): n is string => typeof n === 'string' && n.length > 0 && n.length < 65)
              .slice(0, 12)
          : [];
        const check =
          typeof d['check'] === 'string' && /^[A-Za-z0-9_-]{22}$/.test(d['check'])
            ? d['check']
            : undefined;
        return {
          kind: 'saved',
          kit: {
            file: d['file'],
            folder: d['folder'],
            code: d['code'],
            covers,
            ...(check === undefined ? {} : { check }),
          },
        };
      }
      return { kind: 'error', message: S.failed };
    }
    case 'presence_rejected':
      return { kind: 'retry', message: gateMessage({ kind: 'rejected' }) ?? S.failed };
    case 'presence_required':
      return { kind: 'retry', message: gateMessage({ kind: 'required' }) ?? S.failed };
    case 'wait':
      return { kind: 'retry', message: gateMessage({ kind: 'wait' }) ?? S.failed };
    case 'busy':
      return { kind: 'retry', message: gateMessage({ kind: 'busy' }) ?? S.failed };
    case 'session_expired':
      return { kind: 'error', message: gateMessage({ kind: 'session' }) ?? S.failed };
    case 'offline':
      return { kind: 'error', message: S.cantCheck };
    case 'answer': {
      const d = result.data as Record<string, unknown> | null;
      const word = typeof d === 'object' && d !== null ? (d['error'] ?? d['status']) : undefined;
      if (result.status === 501 || word === 'not_available')
        return { kind: 'error', message: S.notHere };
      if (word === 'not_applied') return { kind: 'error', message: S.notApplied };
      return { kind: 'error', message: S.failed };
    }
    default:
      return { kind: 'error', message: S.failed };
  }
}

type Availability = 'loading' | 'available' | 'not_available' | 'unknown';

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'confirm'; readonly error?: string }
  | { readonly kind: 'working' }
  | { readonly kind: 'saved'; readonly kit: SavedKit }
  | { readonly kind: 'done'; readonly covers: readonly string[] };

export interface ExportKitProps {
  readonly api?: ApiClient;
  /** The stored passkey this browser can use (contacts/owner.ts); tests pass their own. */
  readonly passkey?: () => Promise<PasskeyInfo | undefined>;
  /** The ID's label for the confirmation line; "your IDs" when not known. */
  readonly label?: string;
  /** The page already read it (GET /api/ui/backup `export`): skip our own read. */
  readonly known?: 'available' | 'not_available' | undefined;
  /** The button reads "Save a new kit" when a kit is on record. */
  readonly hasKit?: boolean;
  /** Check my kit's route, when it is registered (default: save-checklist.ts). */
  readonly checkPath?: string | undefined;
  /** Called after Done, so the page can read the record again. */
  readonly onDone?: (() => void) | undefined;
  /** Tests inject the print window opener. */
  readonly openWindow?: Parameters<typeof import('./print-sheet.js').printSheet>[1] | undefined;
}

function useAvailability(api: ApiClient, known: Availability | undefined): Availability {
  const [state, setState] = useState<Availability>('loading');
  useEffect(() => {
    if (known !== undefined) return undefined;
    let live = true;
    void api.get<{ export?: unknown }>(BACKUP_READ_PATH).then(
      (r) => {
        if (!live) return;
        if (r.kind !== 'ok')
          return setState(r.kind === 'not_available' ? 'not_available' : 'unknown');
        setState(r.data?.export === 'available' ? 'available' : 'not_available');
      },
      () => live && setState('unknown'),
    );
    return () => {
      live = false;
    };
  }, [api, known]);
  return known ?? state;
}

function usePasskeyInfo(read: () => Promise<PasskeyInfo | undefined>): PasskeyInfo | undefined {
  const [info, setInfo] = useState<PasskeyInfo | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void read().then(
      (p) => live && setInfo(p),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [read]);
  return info;
}

const defaultApi = (): ApiClient => createApiClient();
const defaultPasskey = (): Promise<PasskeyInfo | undefined> => createOwnerClient().passkey();

export function ExportKit({
  api: given,
  passkey: readPasskey = defaultPasskey,
  label,
  known,
  hasKit = false,
  checkPath,
  onDone,
  openWindow,
}: ExportKitProps): ReactElement {
  const [api] = useState<ApiClient>(() => given ?? defaultApi());
  const availability = useAvailability(api, known);
  const passkey = usePasskeyInfo(readPasskey);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);
  const codeId = useId();

  const submit = (proof: PresenceProof): void => {
    setPhase({ kind: 'working' });
    setNote(undefined);
    const presence = proof.kind === 'code' ? proof.code : { passkey: proof.body };
    void api.owner(BACKUP_EXPORT_PATH, {}, presence).then(
      (result) => {
        const outcome = exportOutcomeOf(result);
        if (outcome.kind === 'saved') {
          setCopied(false);
          setPhase({ kind: 'saved', kit: outcome.kit });
        } else if (outcome.kind === 'retry') {
          setPhase({ kind: 'confirm', error: outcome.message });
        } else {
          setPhase({ kind: 'idle' });
          setNote(outcome.message);
        }
      },
      () => {
        setPhase({ kind: 'idle' });
        setNote(S.failed);
      },
    );
  };

  const copy = (code: string): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined) return;
    void clipboard.writeText(code).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  if (phase.kind === 'saved') {
    const { kit } = phase;
    return (
      <div className="bk-export" data-backup-export="saved">
        <p className="al-text-body" role="status">
          {S.savedIn(kit.folder)} <strong className="bk-file">{kit.file}</strong>
        </p>
        <section className="al-secret" aria-label={S.codeTitle}>
          <div className="al-secret-head">
            <span className="al-text-label">{S.codeTitle}</span>
            <span className="al-text-caption al-muted">{S.shownOnce}</span>
          </div>
          <div
            id={codeId}
            className="al-secret-val al-text-code-lg bk-code"
            data-recovery-code=""
            onCopy={(event) => {
              event.preventDefault();
              event.clipboardData.setData('text/plain', kit.code);
            }}
          >
            {kit.code.split('-').map((g, i) => (
              <span key={i}>{g}</span>
            ))}
          </div>
          <p className="al-text-body-sm">{S.codeBody}</p>
          <p className="al-text-body-sm al-muted">{S.privacy}</p>
          <p className="al-text-caption al-muted">{S.copyNote}</p>
        </section>
        <SaveChecklist
          api={api}
          facts={{ code: kit.code, file: kit.file, date: dayOf(Date.now()) }}
          check={kit.check}
          checkPath={checkPath}
          copied={copied}
          onCopy={() => copy(kit.code)}
          open={openWindow}
          onDone={() => {
            forgetRecoveryKitLater();
            setPhase({ kind: 'done', covers: kit.covers });
            onDone?.();
          }}
        />
      </div>
    );
  }

  if (availability === 'loading') return <div className="bk-export" aria-busy="true" />;
  if (availability === 'not_available') {
    return (
      <div className="bk-export">
        <p className="al-text-body-sm al-muted">{S.notHere}</p>
      </div>
    );
  }

  return (
    <div className="bk-export" data-backup-export={phase.kind}>
      {phase.kind === 'done' ? (
        <p className="al-text-body-sm" role="status">
          {S.done(joinNames(phase.covers))}
        </p>
      ) : null}
      {phase.kind === 'confirm' || phase.kind === 'working' ? (
        <OwnerGate
          summary={S.confirmSummary(label ?? S.thisId)}
          passkey={passkey}
          busy={phase.kind === 'working'}
          error={phase.kind === 'confirm' ? phase.error : undefined}
          onProof={submit}
          onCancel={() => setPhase({ kind: 'idle' })}
        />
      ) : (
        <div className="bk-actions">
          <Button
            variant={hasKit || phase.kind === 'done' ? 'secondary' : 'primary'}
            icon="download"
            onClick={() => {
              setNote(undefined);
              setPhase({ kind: 'confirm' });
            }}
          >
            {hasKit || phase.kind === 'done' ? S.saveNew : S.saveFirst}
          </Button>
          <p className="al-text-caption al-muted">{S.saveHint}</p>
        </div>
      )}
      {phase.kind === 'working' ? (
        <p className="al-text-body-sm al-muted" role="status">
          {S.saving}
        </p>
      ) : null}
      {note === undefined ? null : (
        <p className="al-text-body-sm bk-error" role="alert">
          {note}
        </p>
      )}
    </div>
  );
}
