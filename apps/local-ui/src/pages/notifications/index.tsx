// Settings › Notifications (W4-SETTINGS-ADVANCED; A9: "not yet"). Honest about it: no switch that
// does nothing. Approvals keep reaching Home and the notification the app already sends.
import { EmptyState } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import { NOTIFICATIONS_STRINGS as S } from './strings.js';

export function NotificationsPage(): ReactElement {
  return (
    <>
      <h1 className="al-text-title-1">{S.title}</h1>
      <EmptyState icon="info" title={`${S.notYet}. ${S.body}`} />
    </>
  );
}
