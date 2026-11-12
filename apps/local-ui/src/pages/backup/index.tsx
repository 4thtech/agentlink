// Settings › Backup & Touch ID (W4-SETTINGS-ADVANCED; A9; WP-11, F-1 full, D-117 A). Two plain
// sections. The recovery kit is saved right here, behind Touch ID or the master code (export-kit.tsx);
// the reminder shows only when you put the kit off at setup (states/recovery-kit.ts). Restore stays
// in the terminal (D-117 A).
import { Surface } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import { createApiClient, type ApiResult } from '../../api/client.js';
import { forgetRecoveryKitLater, recoveryKitPending } from '../../states/index.js';
import { BACKUP_READ, parseBackup, type BackupState } from '../settings/state.js';
import { ExportKit, type ExportKitProps } from './export-kit.js';
import { BACKUP_STRINGS as S } from './strings.js';
import './backup.css';

export type BackupPageProps = Pick<ExportKitProps, 'api' | 'passkey'> & {
  /** The kit record read (default: the production read); a test passes its own. */
  readonly read?: () => Promise<ApiResult<unknown>>;
};

const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const productionRead = (): Promise<ApiResult<unknown>> => createApiClient().get(BACKUP_READ);

export function BackupPage({ read = productionRead, ...props }: BackupPageProps): ReactElement {
  // The reminder and the saved line come from the real record, never from a flag alone.
  const [record, setRecord] = useState<BackupState | undefined>(undefined);
  useEffect(() => {
    let live = true;
    read().then(
      (r) => {
        if (live) setRecord(r.kind === 'ok' ? parseBackup(r.data) : undefined);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [read]);
  useEffect(() => {
    if (record?.kind === 'saved') forgetRecoveryKitLater();
  }, [record]);
  const pending = record?.kind === 'none' && recoveryKitPending();
  return (
    <div className="bk-page">
      <h1 className="al-text-title-1">{S.title}</h1>
      <Surface as="section" level={1} className="bk-section" aria-labelledby="bk-kit">
        <h2 id="bk-kit" className="al-text-h3">
          {S.kitTitle}
        </h2>
        <p className="al-text-body">{S.kitBody}</p>
        {pending ? <p className="al-text-body al-muted">{S.kitPending}</p> : null}
        {record?.kind === 'saved' ? (
          <p className="al-text-body al-muted">{S.lastKit(DAY.format(record.at))}</p>
        ) : null}
        <ExportKit {...props} />
      </Surface>
      <Surface as="section" level={1} className="bk-section" aria-labelledby="bk-touch">
        <h2 id="bk-touch" className="al-text-h3">
          {S.touchTitle}
        </h2>
        <p className="al-text-body">{S.touchBody}</p>
      </Surface>
    </div>
  );
}
