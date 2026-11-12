// Settings › Backup & Touch ID (W4-SETTINGS-ADVANCED; A9; WP-11, F-1 full, D-117 A). Two plain
// sections. The recovery kit is saved right here, behind Touch ID or the master code (export-kit.tsx);
// the reminder shows only when you put the kit off at setup (states/recovery-kit.ts). Restore stays
// in the terminal (D-117 A).
import { Surface } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import { recoveryKitPending } from '../../states/index.js';
import { ExportKit, type ExportKitProps } from './export-kit.js';
import { BACKUP_STRINGS as S } from './strings.js';
import './backup.css';

export type BackupPageProps = Pick<ExportKitProps, 'api' | 'passkey'>;

export function BackupPage(props: BackupPageProps): ReactElement {
  const pending = recoveryKitPending();
  return (
    <div className="bk-page">
      <h1 className="al-text-title-1">{S.title}</h1>
      <Surface as="section" level={1} className="bk-section" aria-labelledby="bk-kit">
        <h2 id="bk-kit" className="al-text-h3">
          {S.kitTitle}
        </h2>
        <p className="al-text-body">{S.kitBody}</p>
        {pending ? <p className="al-text-body al-muted">{S.kitPending}</p> : null}
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
