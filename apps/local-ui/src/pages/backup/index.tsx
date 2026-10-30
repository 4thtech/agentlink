// Settings › Backup & Touch ID (W4-SETTINGS-ADVANCED; A9). Two plain sections. The recovery kit
// export is its own card, so no button here that does nothing; the reminder shows only when you put
// the kit off at setup (states/recovery-kit.ts). Nothing secret is read or shown.
import { Surface } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import { recoveryKitPending } from '../../states/index.js';
import { BACKUP_STRINGS as S } from './strings.js';
import './backup.css';

export function BackupPage(): ReactElement {
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
